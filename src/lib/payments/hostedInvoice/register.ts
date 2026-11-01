import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * D24 M2-A: server-only registration of a DanceFlow-issued, Stripe-hosted invoice in the trusted registry
 * (public.d24_register_invoice). Registration is the ONLY thing that makes an invoice attributable to a studio.
 *
 * Trust rules enforced here:
 *   - the studio id is supplied by the calling server code (a session / authorization decision made upstream), never parsed
 *     from a request body or Stripe metadata; the Stripe account is read from `studios.stripe_connected_account_id` here and
 *     is never an input, so a caller cannot register an invoice under an account the studio does not own;
 *   - the business object must be of a type with a registered resolver and that resolver must confirm the object belongs to
 *     THIS studio. There are intentionally NO production resolvers yet: nothing in the app creates Stripe-hosted invoices
 *     (see docs/billing/D24-M2A-REGISTRATION.md), so every production call fails closed with business_object_type_unsupported
 *     until the package that adds an invoice-creation workflow adds its resolver;
 *   - subscription invoices (membership subscriptions are charge_automatically) are refused, by type and by evidence;
 *   - Stripe metadata is never an input to this function.
 *
 * Idempotency, cross-owner refusal (SQLSTATE 23505 d24_registration_conflict) and adoption of facts that arrived before
 * registration live in the database function. This module maps outcomes to fixed codes; it never returns database or Stripe
 * text. Deadlock / serialization aborts (40P01 / 40001) are retried: the aborted transaction wrote nothing and registration is
 * idempotent.
 */

export type BusinessObjectResolver = (input: {
  supabase: Pick<SupabaseClient, "from">;
  studioId: string;
  businessObjectId: string;
}) => Promise<boolean>;

/** Closed allow-list. Empty on purpose; see the module comment. */
export const PRODUCTION_BUSINESS_OBJECT_RESOLVERS: Readonly<Record<string, BusinessObjectResolver>> = Object.freeze({});

export type RegisterHostedInvoiceCode =
  | "invalid_input"
  | "subscription_object_refused"
  | "business_object_type_unsupported"
  | "business_object_not_owned"
  | "stripe_account_unavailable"
  | "registration_conflict"
  | "registration_unavailable"
  | "registration_failed";

export type RegisterHostedInvoiceResult =
  | { ok: true; outcome: "registered" | "already_registered"; registryId: string; adoptedExistingFacts: boolean }
  | { ok: false; code: RegisterHostedInvoiceCode; retryable: boolean };

export type RegisterHostedInvoiceInput = {
  supabase: Pick<SupabaseClient, "rpc" | "from">;
  /** Resolved by the caller's server-side authorization; never from client input or Stripe metadata. */
  studioId: string;
  stripeInvoiceId: string;
  /** From the Stripe API response of the invoice creation call, not from a request. */
  livemode: boolean;
  businessObjectType: string;
  businessObjectId: string;
  createdBy?: string | null;
  /** True when the Stripe invoice carries subscription markers (parent.subscription_details / subscription). Refused. */
  subscriptionEvidence?: boolean;
  resolvers?: Readonly<Record<string, BusinessObjectResolver>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_ID = /^in_[A-Za-z0-9]{1,250}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;
const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;
const TYPE =/^[a-z][a-z0-9_]{0,63}$/;
const SUBSCRIPTION_TYPE = /subscription|membership_billing|recurring/i;
const TRANSIENT = new Set(["40P01", "40001", "55P03"]);
const MAX_ATTEMPTS = 3;

const fail = (code: RegisterHostedInvoiceCode, retryable = false): RegisterHostedInvoiceResult => ({ ok: false, code, retryable });

export async function registerHostedInvoice(input: RegisterHostedInvoiceInput): Promise<RegisterHostedInvoiceResult> {
  const { supabase } = input;
  const objectType = typeof input.businessObjectType === "string" ? input.businessObjectType : "";
  const objectId = typeof input.businessObjectId === "string" ? input.businessObjectId.trim() : "";
  if (
    typeof input.studioId !== "string" || !UUID.test(input.studioId) ||
    typeof input.stripeInvoiceId !== "string" || !INVOICE_ID.test(input.stripeInvoiceId) ||
    typeof input.livemode !== "boolean" ||
    !TYPE.test(objectType) || !OBJECT_ID.test(objectId) ||
    (input.createdBy != null && (typeof input.createdBy !== "string" || !UUID.test(input.createdBy)))
  ) {
    return fail("invalid_input");
  }

  if (input.subscriptionEvidence === true || SUBSCRIPTION_TYPE.test(objectType)) return fail("subscription_object_refused");

  const resolvers = input.resolvers ?? PRODUCTION_BUSINESS_OBJECT_RESOLVERS;
  const resolver = Object.prototype.hasOwnProperty.call(resolvers, objectType) ? resolvers[objectType] : undefined;
  if (!resolver) return fail("business_object_type_unsupported");

  // The Stripe account is the studio's own connected account, read here. Platform-account (null) invoices are not studio invoices.
  const studio = await supabase
    .from("studios")
    .select("stripe_connected_account_id")
    .eq("id", input.studioId)
    .maybeSingle<{ stripe_connected_account_id: string | null }>();
  if (studio.error) return fail("registration_failed", true);
  const account = String(studio.data?.stripe_connected_account_id ?? "").trim();
  if (!studio.data || !ACCOUNT_ID.test(account)) return fail("stripe_account_unavailable");

  // Defense in depth: the registry is keyed by (account scope, invoice id), so a second studio's own account could otherwise create
  // a parallel row for an invoice id that already belongs to someone else. Stripe invoice ids are globally unique and the id here
  // comes from this studio's own creation call, so this should never fire. It is a best-effort read, not a lock; the SQL-side
  // guard is listed as a follow-up in docs/billing/D24-M2A-REGISTRATION.md.
  const existing = await supabase
    .from("hosted_invoice_registry")
    .select("studio_id, account_key")
    .eq("stripe_invoice_id", input.stripeInvoiceId);
  if (existing.error) return fail("registration_failed", true);
  const rows = (existing.data ?? []) as Array<{ studio_id: string; account_key: string }>;
  if (rows.some((r) => r.studio_id !== input.studioId || r.account_key !== account)) return fail("registration_conflict");

  let owned: boolean;
  try {
    owned = (await resolver({ supabase, studioId: input.studioId, businessObjectId: objectId })) === true;
  } catch {
    return fail("registration_failed", true);
  }
  if (!owned) return fail("business_object_not_owned");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { data, error } = await supabase.rpc("d24_register_invoice", {
      p_studio_id: input.studioId,
      p_stripe_account_id: account,
      p_stripe_invoice_id: input.stripeInvoiceId,
      p_livemode: input.livemode,
      p_business_object_type: objectType,
      p_business_object_id: objectId,
      p_created_by: input.createdBy ?? null,
    });
    if (error) {
      const code = String((error as { code?: unknown }).code ?? "");
      if (code === "23505") return fail("registration_conflict");
      if (code === "22023") return fail("invalid_input");
      if (TRANSIENT.has(code)) {
        if (attempt < MAX_ATTEMPTS) continue;
        return fail("registration_failed", true);
      }
      // 42883 / 42P01: migration not applied. Nothing was written; safe to retry after the release.
      if (code === "42883" || code === "42P01" || code === "PGRST202") return fail("registration_unavailable", true);
      // other integrity violations (FK / check / not-null) are permanent: retrying can never succeed
      if (/^23/.test(code)) return fail("registration_failed", false);
      return fail("registration_failed", true);
    }
    const row = data as { outcome?: unknown; registry_id?: unknown; adopted_existing_facts?: unknown } | null;
    if ((row?.outcome !== "registered" && row?.outcome !== "already_registered") || typeof row.registry_id !== "string") {
      return fail("registration_failed", true);
    }
    return { ok: true, outcome: row.outcome, registryId: row.registry_id, adoptedExistingFacts: row.adopted_existing_facts === true };
  }
  return fail("registration_failed", true);
}
