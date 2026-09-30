/**
 * PAY-DC-3 merchant identity (owner decision D3).
 *
 * Payment-bearing client emails may say who took the payment, but only from trusted persisted payment
 * facts: a paid status, a positive total and exactly one stored Stripe owner account
 * (`event_payments.stripe_account_id` / `payments.stripe_account_id`, which only trusted server code can
 * write since PAY-DC-2D). Branding preference, caller-supplied flags, organizer Stripe columns and
 * tenant-writable order metadata are never inputs.
 *
 * Every event charge is a direct charge on the owning studio's connected account; an organizer is a brand of
 * that studio, so organizer emails say the transaction was processed *for* the organizer, never that the
 * payment was made *to* it. Free, zero-total, pending, manual and legacy / unproven payments get no line.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { EMAIL_CONTROL_CHAR_CLASS } from "@/lib/email/brand";
import { selectStoredStripeAccount } from "@/lib/payments/paymentStripeAccount";

export type EmailMerchantFacts = {
  /** Persisted payment status of the registration / order / purchase. */
  paymentStatus: string | null | undefined;
  /** Persisted total charged. */
  totalAmount: number | string | null | undefined;
  /** Every persisted Stripe owner account for the charge (trusted, server-written columns only). */
  storedOwnerAccountIds: ReadonlyArray<string | null | undefined>;
  /** The owning studio's display name (public_name → name). */
  studioName: string | null | undefined;
  /** Organizer display name, only for organizer events. */
  organizerName?: string | null;
};

export type EmailMerchantIdentity = {
  kind: "studio" | "organizer";
  sentence: string;
};

// Stripe object id prefixes and the legal entity must never reach the merchant sentence.
const FORBIDDEN_IN_SENTENCE = /\b(acct|pi|ch|cs|py|src|tok|seti|sub|in)_[A-Za-z0-9]+|GenX/i;

const CONTROL_CHARS = new RegExp(`[${EMAIL_CONTROL_CHAR_CLASS}]`, "g");

function cleanName(value: string | null | undefined) {
  return String(value ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toAmount(value: number | string | null | undefined) {
  const amount = typeof value === "number" ? value : Number(value ?? NaN);
  return Number.isFinite(amount) ? amount : 0;
}

function isPaid(status: string | null | undefined) {
  return String(status ?? "").trim().toLowerCase() === "paid";
}

export function buildMerchantSentence(kind: "studio" | "organizer", name: string) {
  return kind === "organizer"
    ? `This transaction was processed for ${name} through DanceFlow.`
    : `Your payment was made to ${name}. DanceFlow provides the software used to manage this transaction.`;
}

export function resolveEmailMerchantIdentity(
  facts: EmailMerchantFacts,
): EmailMerchantIdentity | null {
  if (!isPaid(facts.paymentStatus)) return null;
  if (toAmount(facts.totalAmount) <= 0) return null;

  const owner = selectStoredStripeAccount(facts.storedOwnerAccountIds);
  if (owner.kind !== "stored") return null;

  const organizerName = cleanName(facts.organizerName);
  const studioName = cleanName(facts.studioName);
  const kind = organizerName ? "organizer" : "studio";
  const name = organizerName || studioName;
  if (!name) return null;

  const sentence = buildMerchantSentence(kind, name);
  if (FORBIDDEN_IN_SENTENCE.test(sentence)) return null;

  return { kind, sentence };
}

/**
 * Stored Stripe owners (`event_payments.stripe_account_id`) for the given registrations. Any lookup failure
 * yields no owners, so the merchant line is omitted rather than guessed.
 */
export async function loadEventPaymentOwnerAccounts(
  supabase: SupabaseClient,
  registrationIds: ReadonlyArray<string | null | undefined>,
) {
  const ids = [...new Set(registrationIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [] as string[];

  const { data, error } = await supabase
    .from("event_payments")
    .select("stripe_account_id")
    .in("registration_id", ids);

  if (error || !Array.isArray(data)) return [] as string[];
  return (data as Array<{ stripe_account_id: string | null }>)
    .map((row) => row.stripe_account_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** The merchant sentence for an event email, or null. Names come from `resolveEventEmailBranding`. */
export async function resolveEventMerchantLine(params: {
  supabase: SupabaseClient;
  registrationIds: ReadonlyArray<string | null | undefined>;
  paymentStatus: string | null | undefined;
  totalAmount: number | string | null | undefined;
  branding: { studioName: string; organizerName: string | null };
}) {
  if (!isPaid(params.paymentStatus) || toAmount(params.totalAmount) <= 0) return null;
  const storedOwnerAccountIds = await loadEventPaymentOwnerAccounts(
    params.supabase,
    params.registrationIds,
  );
  return (
    resolveEmailMerchantIdentity({
      paymentStatus: params.paymentStatus,
      totalAmount: params.totalAmount,
      storedOwnerAccountIds,
      studioName: params.branding.studioName,
      organizerName: params.branding.organizerName,
    })?.sentence ?? null
  );
}
