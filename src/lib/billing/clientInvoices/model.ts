/**
 * D24 M3-C: shared model for the studio-owned one-off client invoice (DRAFT creation/editing only).
 *
 * Everything here is UX-side validation and presentation. The database (studio_client_invoice_save_draft) is authoritative for
 * authorization, arithmetic, limits and same-studio checks; nothing in this file is trusted by the database.
 * Draft invoices have NO payment URL: this module deliberately has no notion of one.
 */

/** Business object type registered with the M3-A ownership registry. Must never contain "subscription". */
export const CLIENT_INVOICE_BUSINESS_OBJECT_TYPE = "studio_client_invoice";

/** Same switch as the M3-B orchestrator. Only the exact string "on" enables provider-draft creation. */
export const CLIENT_INVOICE_CREATION_FLAG = "D24_HOSTED_INVOICE_CREATION";

export function isClientInvoiceCreationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CLIENT_INVOICE_CREATION_FLAG] === "on";
}

export type ClientInvoiceStatus = "draft" | "provider_draft_created";

/** Closed list of statuses the UI knows. Finalized/sent/paid/void are designed (docs/billing/D24-M3C-CLIENT-INVOICE.md) but not modeled yet. */
export const CLIENT_INVOICE_STATUS_LABEL: Record<ClientInvoiceStatus, { label: string; detail: string }> = {
  draft: {
    label: "Draft",
    detail: "Saved in DanceFlow only. Nothing has been created at Stripe and there is no payment link.",
  },
  provider_draft_created: {
    label: "Draft created at Stripe",
    detail: "A draft exists on your connected Stripe account. It has not been finalized or sent, and there is no payment link yet.",
  },
};

export const MAX_FORM_LINES = 25;
export const DESCRIPTION_MAX = 200;
export const REFERENCE_NOTE_MAX = 200;
export const REFERENCE_TYPES = ["appointment", "event", "payment", "other"] as const;
export type ClientInvoiceReferenceType = (typeof REFERENCE_TYPES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** "12", "12.5", "12.50", "$1,200.00" -> cents. No floating point. Returns null for anything else (negative, 3 decimals, exponent, empty). */
export function parseDollarsToCents(input: string): number | null {
  const s = input.replace(/[$,\s]/g, "");
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(cents) ? cents : null;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${(abs % 100).toString().padStart(2, "0")}`;
}

export type DraftLine = { description: string; quantity: number; unit_price_cents: number };

export type ParsedDraftForm = {
  invoiceId: string | null;
  requestKey: string;
  expectedVersion: number | null;
  clientId: string;
  referenceType: ClientInvoiceReferenceType | null;
  referenceId: string | null;
  referenceNote: string | null;
  lines: DraftLine[];
};

const CONTROL = /[\u0000-\u001F\u007F-\u009F​-‍﻿]/g;
const clean = (v: FormDataEntryValue | null, max: number) => (typeof v === "string" ? v.replace(CONTROL, "").trim().slice(0, max) : "");

/**
 * Parses the editor form. studio id, actor and totals are NOT read from the form: the server action derives the studio/actor itself and the
 * database computes every total. A `total`/`studioId`/`stripe_*` field in the form is ignored.
 */
export function parseDraftForm(formData: FormData): { ok: true; value: ParsedDraftForm } | { ok: false; error: string } {
  const invoiceIdRaw = clean(formData.get("invoiceId"), 40);
  if (invoiceIdRaw && !isUuid(invoiceIdRaw)) return { ok: false, error: "Invalid invoice reference." };
  const requestKey = clean(formData.get("requestKey"), 40);
  if (!isUuid(requestKey)) return { ok: false, error: "This form expired. Reload the page and try again." };
  const clientId = clean(formData.get("clientId"), 40);
  if (!isUuid(clientId)) return { ok: false, error: "Choose a client." };

  let expectedVersion: number | null = null;
  if (invoiceIdRaw) {
    const v = Number(clean(formData.get("expectedVersion"), 10));
    if (!Number.isInteger(v) || v < 1) return { ok: false, error: "This invoice changed. Reload and try again." };
    expectedVersion = v;
  }

  const refTypeRaw = clean(formData.get("referenceType"), 20);
  let referenceType: ClientInvoiceReferenceType | null = null;
  let referenceId: string | null = null;
  let referenceNote: string | null = null;
  if (refTypeRaw) {
    if (!(REFERENCE_TYPES as readonly string[]).includes(refTypeRaw)) return { ok: false, error: "Unknown reference type." };
    referenceType = refTypeRaw as ClientInvoiceReferenceType;
    if (referenceType === "other") {
      referenceNote = clean(formData.get("referenceNote"), REFERENCE_NOTE_MAX);
      if (!referenceNote) return { ok: false, error: "Describe what this invoice is for." };
    } else {
      referenceId = clean(formData.get("referenceId"), 40);
      if (!isUuid(referenceId)) return { ok: false, error: "The linked record id is not valid." };
    }
  }

  const lines: DraftLine[] = [];
  for (let i = 0; i < MAX_FORM_LINES * 2; i += 1) {
    const d = clean(formData.get(`line_description_${i}`), DESCRIPTION_MAX + 1);
    const q = clean(formData.get(`line_quantity_${i}`), 12);
    const p = clean(formData.get(`line_price_${i}`), 16);
    if (!d && !q && !p) continue;
    if (lines.length >= MAX_FORM_LINES) return { ok: false, error: `An invoice can have at most ${MAX_FORM_LINES} lines.` };
    if (!d || d.length > DESCRIPTION_MAX) return { ok: false, error: `Line ${lines.length + 1}: add a description (up to ${DESCRIPTION_MAX} characters).` };
    if (!/^\d{1,6}$/.test(q) || Number(q) < 1) return { ok: false, error: `Line ${lines.length + 1}: quantity must be a whole number of 1 or more.` };
    const cents = parseDollarsToCents(p);
    if (cents === null || cents < 1) return { ok: false, error: `Line ${lines.length + 1}: enter a price like 75.00.` };
    lines.push({ description: d, quantity: Number(q), unit_price_cents: cents });
  }
  if (lines.length === 0) return { ok: false, error: "Add at least one line." };

  return {
    ok: true,
    value: { invoiceId: invoiceIdRaw || null, requestKey, expectedVersion, clientId, referenceType, referenceId, referenceNote, lines },
  };
}

/** Maps database refusal codes to plain staff-facing messages. Unknown messages are never echoed. */
export function clientInvoiceErrorMessage(raw: string | null | undefined, code?: string | null): string {
  const m = String(raw ?? "");
  const table: Array<[string, string]> = [
    ["client_invoice_limits_not_configured", "Client invoices are not turned on for DanceFlow yet. Invoice amount limits have not been set."],
    ["client_invoice_forbidden", "Only the studio owner or an admin can create or edit client invoices."],
    ["client_invoice_authentication_required", "Please sign in again."],
    ["client_invoice_session_expired", "Your session expired. Please sign in again."],
    ["client_invoice_version_conflict", "Someone else changed this draft. Reload to see the latest version."],
    ["client_invoice_not_editable", "This invoice can no longer be edited."],
    ["client_invoice_not_found", "That invoice was not found."],
    ["client_invoice_client_not_in_studio", "Choose one of your studio's clients."],
    ["client_invoice_reference_not_in_studio", "The linked record does not belong to your studio."],
    ["client_invoice_total_out_of_range", "The invoice total is outside the allowed range."],
    ["client_invoice_amount_invalid", "A line amount is outside the allowed range."],
    ["client_invoice_quantity_invalid", "A line quantity is outside the allowed range."],
    ["client_invoice_line_count_invalid", "The number of lines is outside the allowed range."],
    ["client_invoice_description_invalid", "A line description is not valid."],
    ["client_invoice_lines_invalid", "The invoice lines are not valid."],
    ["client_invoice_input_invalid", "Some details are not valid."],
  ];
  for (const [needle, message] of table) if (m.includes(needle)) return message;
  if (code === "40001") return "Someone else changed this draft. Reload to see the latest version.";
  return "The draft could not be saved. Nothing was changed.";
}
