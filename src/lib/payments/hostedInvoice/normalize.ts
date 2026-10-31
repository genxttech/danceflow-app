import type Stripe from "stripe";

/**
 * D24 M1: turn a verified Stripe event object into the small, sanitized shape the database function stores.
 * Only whitelisted ids, amounts, currency and status are kept: no customer, email, address, description or payment
 * method detail ever reaches the evidence tables. Metadata is read only for the two DanceFlow reference keys and is
 * never authoritative (the database validates it against the trusted registry).
 */

export const D24_EVENT_TYPES = [
  "invoice.voided",
  "invoice.marked_uncollectible",
  "invoice_payment.paid",
  "credit_note.created",
  "credit_note.updated",
  "credit_note.voided",
] as const;

export type D24EventType = (typeof D24_EVENT_TYPES)[number];
export type D24Kind = "invoice" | "invoice_payment" | "credit_note";

export const isD24EventType = (type: string): type is D24EventType => (D24_EVENT_TYPES as readonly string[]).includes(type);

export const D24_METADATA_REGISTRY_KEY = "df_registry_id";
export const D24_METADATA_STUDIO_KEY = "df_studio_id";

export type NormalizedD24Event = {
  kind: D24Kind;
  object: Record<string, string | number | null>;
};

export type NormalizeResult = { ok: true; value: NormalizedD24Event } | { ok: false; reason: string };

const ID = { in: /^in_[A-Za-z0-9]+$/, inpay: /^inpay_[A-Za-z0-9]+$/, cn: /^cn_[A-Za-z0-9]+$/ };
const CURRENCY = /^[a-z]{3}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : isRecord(v) && typeof v.id === "string" ? v.id : null);
const signed = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null); // an invoice total can be negative
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidRef = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);
const cents = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

const fail = (reason: string): NormalizeResult => ({ ok: false, reason });

export function kindOf(type: D24EventType): D24Kind {
  if (type === "invoice.voided" || type === "invoice.marked_uncollectible") return "invoice";
  if (type === "invoice_payment.paid") return "invoice_payment";
  return "credit_note";
}

export function normalizeD24Object(type: D24EventType, raw: unknown): NormalizeResult {
  if (!isRecord(raw)) return fail("object_not_an_object");
  const kind = kindOf(type);

  if (kind === "invoice") {
    const invoiceId = typeof raw.id === "string" ? raw.id : null;
    if (!invoiceId || !ID.in.test(invoiceId)) return fail("invoice_id_invalid");
    const status = raw.status;
    // The database stores Stripe's actual status. An event type that contradicts the object is refused, not guessed.
    const expected = type === "invoice.voided" ? "void" : "uncollectible";
    if (status !== expected) return fail("invoice_status_contradicts_event");
    // Subscription billing invoices are handled by the existing subscription handlers; they are not hosted invoices.
    if (raw.subscription || (typeof raw.billing_reason === "string" && raw.billing_reason.startsWith("subscription"))) return fail("subscription_invoice");
    const total = signed(raw.total);
    const due = cents(raw.amount_due);
    const paid = cents(raw.amount_paid);
    const remaining = cents(raw.amount_remaining);
    const currency = typeof raw.currency === "string" ? raw.currency.toLowerCase() : "";
    if (total === null || due === null || paid === null || remaining === null) return fail("invoice_amounts_invalid");
    if (!CURRENCY.test(currency)) return fail("currency_invalid");
    const metadata = isRecord(raw.metadata) ? raw.metadata : {};
    return {
      ok: true,
      value: {
        kind,
        object: {
          invoice_id: invoiceId,
          status: expected,
          total,
          amount_due: due,
          amount_paid: paid,
          amount_remaining: remaining,
          currency,
          metadata_ref: uuidRef(metadata[D24_METADATA_REGISTRY_KEY]),
          metadata_studio: uuidRef(metadata[D24_METADATA_STUDIO_KEY]),
        },
      },
    };
  }

  if (kind === "invoice_payment") {
    const paymentId = typeof raw.id === "string" ? raw.id : null;
    const invoiceId = idOf(raw.invoice);
    if (!paymentId || !ID.inpay.test(paymentId)) return fail("invoice_payment_id_invalid");
    if (!invoiceId || !ID.in.test(invoiceId)) return fail("invoice_id_invalid");
    const status = raw.status;
    if (status !== "paid" && status !== "open" && status !== "canceled") return fail("invoice_payment_status_invalid");
    const requested = cents(raw.amount_requested);
    // Stripe reports null until the payment is paid
    const paidAmount = raw.amount_paid === null || raw.amount_paid === undefined ? 0 : cents(raw.amount_paid);
    const currency = typeof raw.currency === "string" ? raw.currency.toLowerCase() : "";
    if (requested === null || paidAmount === null) return fail("invoice_payment_amounts_invalid");
    if (!CURRENCY.test(currency)) return fail("currency_invalid");
    return {
      ok: true,
      value: { kind, object: { invoice_id: invoiceId, object_id: paymentId, status, amount_requested: requested, amount_paid: paidAmount, currency } },
    };
  }

  const noteId = typeof raw.id === "string" ? raw.id : null;
  const invoiceId = idOf(raw.invoice);
  if (!noteId || !ID.cn.test(noteId)) return fail("credit_note_id_invalid");
  if (!invoiceId || !ID.in.test(invoiceId)) return fail("invoice_id_invalid");
  const status = raw.status;
  if (status !== "issued" && status !== "void") return fail("credit_note_status_invalid");
  if (type === "credit_note.voided" && status !== "void") return fail("credit_note_status_contradicts_event");
  const amount = cents(raw.total ?? raw.amount);
  const currency = typeof raw.currency === "string" ? raw.currency.toLowerCase() : "";
  if (amount === null) return fail("credit_note_amount_invalid");
  if (!CURRENCY.test(currency)) return fail("currency_invalid");
  const noteType = raw.type === "pre_payment" || raw.type === "post_payment" ? raw.type : null;
  return {
    ok: true,
    value: { kind, object: { invoice_id: invoiceId, object_id: noteId, status, credit_note_type: noteType, amount, currency } },
  };
}

export const d24Enabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.D24_HOSTED_INVOICE_EVENTS ?? "").trim().toLowerCase() === "on";

export type D24EventInput = Pick<Stripe.Event, "id" | "type" | "created" | "livemode" | "account"> & { data: { object: unknown } };
