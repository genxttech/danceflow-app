import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * D24 M3-B: server-only, INACTIVE orchestrator for creating a Stripe-hosted (send_invoice) DRAFT invoice for a studio client and
 * registering it in the trusted registry. Nothing in the app calls this module (pinned by createContract.d24.test.ts), the
 * production resolver list is EMPTY, the Stripe client is INJECTED (no real client is constructed or importable from here), and
 * everything is behind D24_HOSTED_INVOICE_CREATION (default OFF, fail closed).
 *
 * Flow (every step is durable through the creation-intent ledger, so any crash is recoverable without a second Stripe invoice):
 *   authorize (caller-verified staff + billing decision; studioId / createdBy come from it, never from the request)
 *   -> resolve the trusted business object spec (customer, lines, currency come from server-side records, not the request)
 *   -> resolve the Stripe account from studios.stripe_connected_account_id (fail closed, never caller supplied)
 *   -> d24_intent_begin (deterministic idempotency key; concurrent retries collapse onto one intent)
 *   -> create the DRAFT invoice in the connected account with the intent idempotency key (collection_method send_invoice,
 *      auto_advance false; no finalize / send / pay / collection, so no customer email can be triggered here)
 *   -> take invoice id AND livemode from the Stripe response; refuse a livemode that disagrees with the deployment key mode
 *   -> d24_intent_mark_provider_created -> d24_intent_register -> registered.
 * The caller must not finalize or send the invoice unless the result is `registered`.
 *
 * Trust rules: Stripe metadata is informational only and is never read back; no payment / settlement is inferred from anything
 * here (settlement facts arrive only through verified webhooks handled by M1); error text from Stripe or the database is never
 * returned, only fixed codes.
 */

export const HOSTED_INVOICE_CREATION_FLAG = "D24_HOSTED_INVOICE_CREATION";

/** Strict allow: only the exact string "on" enables creation. Anything else (unset, "true", "1", " on") is OFF. */
export function isHostedInvoiceCreationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[HOSTED_INVOICE_CREATION_FLAG] === "on";
}

/** Deployment key mode: live secret/restricted key => true, test key => false, anything else => null (refuse). */
export function livemodeFromSecretKey(key: string | null | undefined): boolean | null {
  const k = String(key ?? "");
  if (/^(sk|rk)_live_/.test(k)) return true;
  if (/^(sk|rk)_test_/.test(k)) return false;
  return null;
}

// ---------- injected collaborators ----------

export type AuthorizedBillingActor = {
  /** Set only by server code that has verified a studio staff session AND a billing permission for exactly this studio. */
  verified: true;
  studioId: string;
  userId: string;
  canManageBilling: true;
};

export type InvoiceSpec = {
  /** Stripe customer id in the studio's connected account, from trusted records. The resolver must prove it belongs to the studio. */
  stripeCustomerId?: string;
  /**
   * Alternative to stripeCustomerId: the studio client to materialize as a Stripe customer in the connected account
   * (ensureCustomer, same idempotency discipline). Exactly one of the two must be present. Comes from the DanceFlow client record
   * resolved by the trusted resolver, never from the request. clientRef is the DanceFlow client id (informational + fingerprint).
   */
  customerProfile?: { clientRef: string; name: string; email?: string | null };
  currency: string;
  daysUntilDue: number;
  description?: string;
  lines: Array<{ description: string; amountCents: number }>;
};

/** Resolves the invoice contents from trusted server records; returns null when the object does not exist or is not this studio's. */
export type InvoiceSpecResolver = (input: {
  supabase: Pick<SupabaseClient, "from">;
  studioId: string;
  businessObjectId: string;
}) => Promise<InvoiceSpec | null>;

/** Closed allow-list. Empty on purpose: the owning business object (decision D1) does not exist yet. */
export const PRODUCTION_INVOICE_SPEC_RESOLVERS: Readonly<Record<string, InvoiceSpecResolver>> = Object.freeze({});

export type StripeInvoiceSnapshot = {
  id: string;
  livemode: boolean;
  status: string | null;
  collection_method: string | null;
  /** A draft has no hosted URL; any non-null value is unexpected and refused (never reported as a payment link). */
  hosted_invoice_url?: unknown;
  auto_advance?: boolean | null;
  customer: string | null;
  currency: string | null;
  total?: number | null;
  subscription?: unknown;
  parent?: unknown;
};

/**
 * The only Stripe operations this module may perform. Deliberately has no finalize / send / pay / void. Implementations are
 * injected; this module never builds one.
 */
export interface HostedInvoiceStripeClient {
  /** Creates the Stripe customer for a studio client in the connected account. Idempotent per key; Stripe sends nothing to the customer. */
  ensureCustomer(args: {
    stripeAccount: string;
    idempotencyKey: string;
    params: { name: string; email?: string; metadata: Record<string, string> };
  }): Promise<{ id: string; livemode: boolean; deleted?: boolean | null }>;
  createDraftInvoice(args: {
    stripeAccount: string;
    idempotencyKey: string;
    params: {
      customer: string;
      collection_method: "send_invoice";
      days_until_due: number;
      currency: string;
      auto_advance: false;
      description?: string;
      metadata: Record<string, string>;
    };
  }): Promise<StripeInvoiceSnapshot>;
  addInvoiceLines(args: {
    stripeAccount: string;
    idempotencyKey: string;
    invoiceId: string;
    lines: Array<{ description: string; amount: number }>;
  }): Promise<StripeInvoiceSnapshot>;
}

export type IntentState = "pending" | "provider_created" | "registered" | "failed" | "abandoned" | "needs_review";

export type IntentRow = {
  id: string;
  studioId: string;
  state: IntentState;
  idempotencyKey: string;
  requestFingerprint: string;
  stripeAccountId: string;
  businessObjectType: string;
  businessObjectId: string;
  stripeInvoiceId: string | null;
  livemode: boolean | null;
  /** Sticky: a provider call ended ambiguously. Stripe may have created the invoice; only the DB recovery claim may replay. */
  outcomeUnknown: boolean;
  createdAtMs: number;
};

export type BeginOutcome = "created" | "existing" | "existing_terminal" | "needs_review" | "register_only";
export type ClaimOutcome = "replay_permitted" | "lease_held" | "register_only" | "needs_review" | "terminal";

/** Port over the M3-A SQL functions. The Supabase implementation below is the only place their signatures appear. */
export interface IntentStore {
  begin(input: {
    studioId: string;
    createdBy: string;
    idempotencyKey: string;
    requestFingerprint: string;
    businessObjectType: string;
    businessObjectId: string;
  }): Promise<
    | { ok: true; outcome: BeginOutcome; intent: IntentRow }
    | { ok: false; code: "intent_payload_conflict" | "request_fingerprint_mismatch" | "intent_unavailable"; retryable: boolean }
  >;
  /** Direct service-role read of the ledger row; null when missing. Studio scoping is enforced by the caller. */
  get(intentId: string): Promise<IntentRow | null>;
  /** "recorded" = provider_created (or already); "review" = ledger recorded the id but the intent is/became needs_review; "error" = nothing recorded. */
  markProviderCreated(input: { intentId: string; studioId: string; stripeInvoiceId: string; livemode: boolean; keyLivemode: boolean; stripeAccountId: string }): Promise<"recorded" | "review" | "error">;
  register(input: { intentId: string; studioId: string }): Promise<
    { ok: true; registryId: string; adoptedExistingFacts: boolean } | { ok: false; code: string; retryable: boolean }
  >;
  /** Permanent or recorded failure. Returns false when the ledger refused it (e.g. outcome unknown, or already registered). */
  fail(input: { intentId: string; studioId: string; code: string; permanent: boolean }): Promise<boolean>;
  /** Records an ambiguous provider end (sticky outcome_unknown). After this nothing may call Stripe except a granted recovery claim. */
  recordOutcome(input: { intentId: string; studioId: string; code: string; unknown: boolean }): Promise<boolean>;
  /** The ONLY gate for replaying a creation after a crash/ambiguity: the DB decides window, fingerprint match, account and lease. */
  claimRecovery(input: { intentId: string; studioId: string; requestFingerprint: string }): Promise<{ ok: true; outcome: ClaimOutcome; intent: IntentRow } | { ok: false }>;
  /** True only when the ledger confirmed the intent is (now) needs_review. */
  flagReview(input: { intentId: string; studioId: string; reasonCode: string }): Promise<boolean>;
  listRecoverable(input: { limit: number; olderThanMinutes: number }): Promise<IntentRow[]>;
}

export type CreateDeps = {
  supabase: Pick<SupabaseClient, "from" | "rpc">;
  stripe: HostedInvoiceStripeClient;
  store: IntentStore;
  /** Deployment key mode, from livemodeFromSecretKey(). null => refuse everything. */
  expectedLivemode: boolean | null;
  resolvers?: Readonly<Record<string, InvoiceSpecResolver>>;
  env?: Record<string, string | undefined>;
};

export type CreateCode =
  | "creation_disabled"
  | "invalid_input"
  | "not_authorized"
  | "subscription_object_refused"
  | "business_object_type_unsupported"
  | "business_object_not_owned"
  | "invalid_invoice_spec"
  | "stripe_account_unavailable"
  | "deployment_key_mode_unknown"
  | "intent_payload_conflict"
  | "intent_unavailable"
  | "intent_failed"
  | "intent_not_found"
  | "idempotency_window_expired"
  | "payload_changed"
  | "stripe_unavailable"
  | "stripe_rejected"
  | "stripe_response_invalid"
  | "livemode_mismatch"
  | "registration_unavailable"
  | "registration_failed"
  | "spec_unavailable"
  | "outcome_unknown"
  | "needs_review"
  | "recovery_in_progress"
  | "request_fingerprint_mismatch";

export type CreateResult =
  | { ok: true; state: "registered"; intentId: string; stripeInvoiceId: string; livemode: boolean; registryId: string; adoptedExistingFacts: boolean }
  | { ok: false; code: CreateCode; retryable: boolean; intentId?: string };

export type CreateInvoiceRequest = {
  actor: AuthorizedBillingActor;
  businessObjectType: string;
  businessObjectId: string;
  /** Operation id for idempotent retries of THIS invoice (e.g. generated once per form render). Not a tenant or amount input. */
  requestKey: string;
};

// ---------- validation ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_ID = /^in_[A-Za-z0-9]{1,250}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const CLIENT_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}$/;
const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const SUBSCRIPTION_TYPE = /subscription|membership_billing|recurring/i;
const CURRENCY = /^[a-z]{3}$/;
const MAX_LINES = 25;
const MAX_TOTAL_CENTS = 10_000_000;

const fail = (code: CreateCode, retryable = false, intentId?: string): CreateResult => ({
  ok: false,
  code,
  retryable,
  ...(intentId ? { intentId } : {}),
});

function validateSpec(spec: InvoiceSpec | null): spec is InvoiceSpec {
  if (!spec || typeof spec !== "object") return false;
  const hasId = spec.stripeCustomerId !== undefined;
  const p = spec.customerProfile;
  if (hasId === (p !== undefined)) return false; // exactly one
  if (hasId && (typeof spec.stripeCustomerId !== "string" || !CUSTOMER_ID.test(spec.stripeCustomerId))) return false;
  if (p !== undefined) {
    if (!p || typeof p.clientRef !== "string" || !CLIENT_REF.test(p.clientRef)) return false;
    if (typeof p.name !== "string" || p.name.trim().length < 1 || p.name.length > 200) return false;
    if (p.email != null && (typeof p.email !== "string" || !EMAIL.test(p.email))) return false;
  }
  if (typeof spec.currency !== "string" || !CURRENCY.test(spec.currency)) return false;
  if (!Number.isInteger(spec.daysUntilDue) || spec.daysUntilDue < 1 || spec.daysUntilDue > 90) return false;
  if (spec.description != null && (typeof spec.description !== "string" || spec.description.length > 500)) return false;
  if (!Array.isArray(spec.lines) || spec.lines.length < 1 || spec.lines.length > MAX_LINES) return false;
  let total = 0;
  for (const l of spec.lines) {
    if (!l || typeof l.description !== "string" || l.description.length < 1 || l.description.length > 500) return false;
    if (!Number.isInteger(l.amountCents) || l.amountCents < 1 || l.amountCents > MAX_TOTAL_CENTS) return false;
    total += l.amountCents;
  }
  return total <= MAX_TOTAL_CENTS;
}

const specTotal = (s: InvoiceSpec) => s.lines.reduce((n, l) => n + l.amountCents, 0);

function validActor(a: unknown): a is AuthorizedBillingActor {
  const x = a as Partial<AuthorizedBillingActor> | null;
  return !!x && x.verified === true && x.canManageBilling === true &&
    typeof x.studioId === "string" && UUID.test(x.studioId) && typeof x.userId === "string" && UUID.test(x.userId);
}

/**
 * Deterministic: same studio + object + requestKey => same key; a different studio can never collide with it. The key is independent
 * of the invoice content: a changed spec under the same requestKey carries a different request fingerprint, which the ledger refuses
 * (23505 d24_request_fingerprint_mismatch) instead of creating a new intent or replaying with new parameters.
 */
export function deriveIdempotencyKey(studioId: string, businessObjectType: string, businessObjectId: string, requestKey: string): string {
  const scope = createHash("sha256").update(["d24", "v2", studioId, businessObjectType, businessObjectId, requestKey].join("\u0000")).digest("hex").slice(0, 32);
  return `d24inv_${scope}`;
}

/** Canonical sha256 (64 lowercase hex) of everything that determines the Stripe request; computed before the first provider call. */
export function deriveRequestFingerprint(studioId: string, businessObjectType: string, businessObjectId: string, spec: InvoiceSpec, account: string, livemode: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify({ s: studioId, a: account, m: livemode, t: businessObjectType, o: businessObjectId, c: spec.stripeCustomerId ?? null, p: spec.customerProfile ? [spec.customerProfile.clientRef, spec.customerProfile.name.trim(), spec.customerProfile.email || null] : null, cur: spec.currency, d: spec.daysUntilDue, desc: spec.description || null, l: spec.lines.map((l) => [l.description, l.amountCents]) }))
    .digest("hex");
}

// ---------- account ----------

async function resolveAccount(supabase: Pick<SupabaseClient, "from">, studioId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("studios")
    .select("stripe_connected_account_id, stripe_connect_charges_enabled")
    .eq("id", studioId)
    .maybeSingle<{ stripe_connected_account_id: string | null; stripe_connect_charges_enabled: boolean | null }>();
  if (error || !data) return null;
  const account = String(data.stripe_connected_account_id ?? "").trim();
  if (!ACCOUNT_ID.test(account) || data.stripe_connect_charges_enabled !== true) return null;
  return account;
}

// ---------- Stripe error classification (never returns provider text) ----------

type Classified =
  | { kind: "unknown" } // ambiguous: the invoice may exist. Record outcome_unknown and STOP.
  | { kind: "review" } // the key was already used: an earlier request reached Stripe and may have created an invoice
  | { kind: "retry"; code: "stripe_unavailable" } // definitively not processed (rate limit / key currently in use)
  | { kind: "permanent"; code: "stripe_rejected" };

function classifyStripeError(e: unknown): Classified {
  const err = e as { type?: unknown; statusCode?: unknown; code?: unknown } | null;
  const type = String(err?.type ?? "");
  const status = Number(err?.statusCode ?? 0);
  if (err?.code === "idempotency_key_in_use") return { kind: "retry", code: "stripe_unavailable" };
  if (type === "StripeIdempotencyError") return { kind: "review" };
  if (type === "StripeRateLimitError" || status === 429) return { kind: "retry", code: "stripe_unavailable" };
  if (status >= 400 && status < 500 && type !== "StripeConnectionError" && type !== "StripeAPIError") return { kind: "permanent", code: "stripe_rejected" };
  return { kind: "unknown" };
}

// ---------- core ----------

/**
 * Flag the intent for human review FIRST (so it can never be registered), then keep any provider invoice id on it (the ledger stores
 * the id on a needs_review intent without allowing register). If the flag cannot be confirmed the id is NOT recorded: recording would
 * move the intent to provider_created and make it registerable.
 */
async function escalate(store: IntentStore, intent: IntentRow, reason: string, code: CreateCode, keep?: { id: string; livemode: boolean; account: string; keyLivemode: boolean }): Promise<CreateResult> {
  const flagged = await store.flagReview({ intentId: intent.id, studioId: intent.studioId, reasonCode: reason });
  if (flagged && keep) {
    await store.markProviderCreated({ intentId: intent.id, studioId: intent.studioId, stripeInvoiceId: keep.id, livemode: keep.livemode, keyLivemode: keep.keyLivemode, stripeAccountId: keep.account });
  }
  return fail(code, false, intent.id);
}

/** Terminal failure for a definitively-not-created intent; if the ledger refuses (outcome unknown / invoice recorded), escalate to review instead. */
async function terminate(store: IntentStore, intent: IntentRow, code: string): Promise<void> {
  const ok = await store.fail({ intentId: intent.id, studioId: intent.studioId, code, permanent: true });
  if (!ok) await store.flagReview({ intentId: intent.id, studioId: intent.studioId, reasonCode: code });
}

async function runFrom(intent: IntentRow, spec: InvoiceSpec | null, account: string | null, deps: CreateDeps, isReplay: boolean): Promise<CreateResult> {
  const { store } = deps;
  let invoiceId = intent.stripeInvoiceId;
  let livemode = intent.livemode;

  if (intent.state === "pending") {
    // spec and account are required to talk to Stripe; resumeIntent re-derives them from trusted records.
    if (!spec || !account) return fail("invalid_invoice_spec", false, intent.id);
    let snap: StripeInvoiceSnapshot;
    let createdSnap: StripeInvoiceSnapshot | null = null;
    try {
      let customerId = spec.stripeCustomerId;
      if (customerId === undefined) {
        const p = spec.customerProfile!;
        const cust = await deps.stripe.ensureCustomer({
          stripeAccount: account,
          idempotencyKey: intent.idempotencyKey + ":customer",
          params: { name: p.name.trim(), ...(p.email ? { email: p.email } : {}), metadata: { d24_intent_id: intent.id, d24_client_ref: p.clientRef } },
        });
        if (!cust || typeof cust.id !== "string" || !CUSTOMER_ID.test(cust.id) || cust.livemode !== deps.expectedLivemode || cust.deleted === true) throw new SnapshotError();
        customerId = cust.id;
      }
      const created = await deps.stripe.createDraftInvoice({
        stripeAccount: account,
        idempotencyKey: intent.idempotencyKey,
        params: {
          customer: customerId,
          collection_method: "send_invoice",
          days_until_due: spec.daysUntilDue,
          currency: spec.currency,
          auto_advance: false,
          ...(spec.description ? { description: spec.description } : {}),
          metadata: { d24_intent_id: intent.id },
        },
      });
      createdSnap = created;
      validateSnapshot(created, customerId, spec);
      snap = await deps.stripe.addInvoiceLines({
        stripeAccount: account,
        idempotencyKey: intent.idempotencyKey + ":lines",
        invoiceId: created.id,
        lines: spec.lines.map((l) => ({ description: l.description, amount: l.amountCents })),
      });
      validateSnapshot(snap, customerId, spec);
      if (snap.id !== created.id || snap.livemode !== created.livemode) throw new SnapshotError();
      if (typeof snap.total !== "number" || snap.total !== specTotal(spec)) throw new SnapshotError();
    } catch (e) {
      // A valid in-mode draft id that we hold must never be dropped: any run that does not complete escalates to review WITH the id.
      const keep = createdSnap && typeof createdSnap.id === "string" && INVOICE_ID.test(createdSnap.id) && createdSnap.livemode === deps.expectedLivemode
        ? { id: createdSnap.id, livemode: createdSnap.livemode, account, keyLivemode: deps.expectedLivemode as boolean }
        : undefined;
      if (e instanceof SnapshotError) {
        // The provider returned something that does not match the trusted record: never register it, a human reconciles.
        return escalate(store, intent, "stripe_response_invalid", "stripe_response_invalid", keep);
      }
      const c = classifyStripeError(e);
      if (c.kind === "unknown") {
        // Ambiguous end (timeout / connection / 5xx): the invoice may exist. Record it and stop; no blind retry, no new key.
        const recorded = await store.recordOutcome({ intentId: intent.id, studioId: intent.studioId, code: "provider_outcome_unknown", unknown: true });
        if (keep || !recorded) return escalate(store, intent, "provider_outcome_unknown", "outcome_unknown", keep);
        return fail("outcome_unknown", false, intent.id);
      }
      if (c.kind === "review") return escalate(store, intent, "idempotency_key_reused", "stripe_rejected", keep);
      if (keep) return escalate(store, intent, c.kind === "retry" ? "provider_incomplete" : "provider_rejected_after_create", c.kind === "retry" ? "stripe_unavailable" : "stripe_rejected", keep);
      if (c.kind === "permanent") {
        // A replay's "permanent" answer (401/403/400 ...) is not proof that the ORIGINAL request created nothing: never free the object on a replay.
        if (isReplay) return escalate(store, intent, "replay_rejected", "stripe_rejected");
        await terminate(store, intent, c.code);
        return fail(c.code, false, intent.id);
      }
      return fail(c.code, true, intent.id);
    }

    // The Stripe response is the only source of the id and livemode. A mismatch with the deployment key mode is refused.
    if (snap.livemode !== deps.expectedLivemode) return escalate(store, intent, "livemode_mismatch", "livemode_mismatch");
    const keepAll = { id: snap.id, livemode: snap.livemode, account, keyLivemode: deps.expectedLivemode };
    const marked = await store.markProviderCreated({ intentId: intent.id, studioId: intent.studioId, stripeInvoiceId: snap.id, livemode: snap.livemode, keyLivemode: deps.expectedLivemode, stripeAccountId: account });
    if (marked === "review") return fail("needs_review", false, intent.id);
    // The id is in hand but the ledger did not take it: hold the intent for review WITH the id rather than losing it.
    if (marked === "error") return escalate(store, intent, "provider_id_not_recorded", "registration_unavailable", keepAll);
    invoiceId = snap.id;
    livemode = snap.livemode;
  }

  if ((intent.state === "provider_created" || intent.state === "registered") && livemode !== deps.expectedLivemode) {
    if (intent.state === "provider_created") return escalate(store, intent, "livemode_mismatch", "livemode_mismatch");
    return fail("livemode_mismatch", false, intent.id);
  }
  if (!invoiceId || livemode == null || !INVOICE_ID.test(invoiceId)) return fail("registration_failed", false, intent.id);

  const reg = await store.register({ intentId: intent.id, studioId: intent.studioId });
  if (!reg.ok) {
    if (reg.code === "needs_review") return fail("needs_review", false, intent.id);
    if (!reg.retryable) return escalate(store, intent, "registration_failed", "registration_failed");
    return fail(reg.code === "registration_unavailable" ? "registration_unavailable" : "registration_failed", true, intent.id);
  }
  return { ok: true, state: "registered", intentId: intent.id, stripeInvoiceId: invoiceId, livemode, registryId: reg.registryId, adoptedExistingFacts: reg.adoptedExistingFacts };
}

class SnapshotError extends Error {}

function validateSnapshot(s: StripeInvoiceSnapshot, customerId: string, spec: InvoiceSpec) {
  if (
    !s || typeof s.id !== "string" || !INVOICE_ID.test(s.id) || typeof s.livemode !== "boolean" ||
    s.status !== "draft" || s.collection_method !== "send_invoice" || s.auto_advance !== false ||
    s.customer !== customerId || (s.hosted_invoice_url != null && s.hosted_invoice_url !== "") || s.currency !== spec.currency ||
    (s.subscription != null && s.subscription !== false) ||
    (s.parent != null && typeof s.parent === "object" && (s.parent as { subscription_details?: unknown }).subscription_details != null)
  ) {
    throw new SnapshotError();
  }
}

export async function createHostedInvoice(request: CreateInvoiceRequest, deps: CreateDeps): Promise<CreateResult> {
  if (!isHostedInvoiceCreationEnabled(deps.env)) return fail("creation_disabled");
  if (deps.expectedLivemode !== true && deps.expectedLivemode !== false) return fail("deployment_key_mode_unknown");
  if (!validActor(request?.actor)) return fail("not_authorized");
  const { actor } = request;
  const type = typeof request.businessObjectType === "string" ? request.businessObjectType : "";
  const objectId = typeof request.businessObjectId === "string" ? request.businessObjectId.trim() : "";
  if (!TYPE.test(type) || !OBJECT_ID.test(objectId) || typeof request.requestKey !== "string" || !REQUEST_KEY.test(request.requestKey)) {
    return fail("invalid_input");
  }
  if (SUBSCRIPTION_TYPE.test(type)) return fail("subscription_object_refused");

  const resolvers = deps.resolvers ?? PRODUCTION_INVOICE_SPEC_RESOLVERS;
  const resolver = Object.prototype.hasOwnProperty.call(resolvers, type) ? resolvers[type] : undefined;
  if (!resolver) return fail("business_object_type_unsupported");

  const account = await resolveAccount(deps.supabase, actor.studioId);
  if (!account) return fail("stripe_account_unavailable");

  let spec: InvoiceSpec | null;
  try {
    spec = await resolver({ supabase: deps.supabase, studioId: actor.studioId, businessObjectId: objectId });
  } catch {
    return fail("spec_unavailable", true);
  }
  if (spec === null) return fail("business_object_not_owned");
  if (!validateSpec(spec)) return fail("invalid_invoice_spec");

  // The fingerprint is computed before the first provider call and pinned by the ledger: same key + different fingerprint is refused.
  const begun = await deps.store.begin({
    studioId: actor.studioId,
    createdBy: actor.userId,
    idempotencyKey: deriveIdempotencyKey(actor.studioId, type, objectId, request.requestKey),
    requestFingerprint: deriveRequestFingerprint(actor.studioId, type, objectId, spec, account, deps.expectedLivemode),
    businessObjectType: type,
    businessObjectId: objectId,
  });
  if (!begun.ok) return fail(begun.code, begun.retryable);
  const { intent, outcome } = begun;
  // Defense in depth: the ledger row must be this studio's.
  if (intent.studioId !== actor.studioId) return fail("intent_unavailable", false);
  if (outcome === "needs_review" || intent.state === "needs_review") return fail("needs_review", false, intent.id);
  // provider_created: the invoice already exists and was recorded; finish registration without any Stripe call.
  if (outcome === "register_only" || intent.state === "provider_created") return runFrom(intent, null, null, deps, false);
  // The ledger resolved the account itself; it must agree with ours or nothing is sent to Stripe.
  if (intent.stripeAccountId !== account) return fail("stripe_account_unavailable", false, intent.id);
  if (intent.state === "failed" || intent.state === "abandoned") return fail("intent_failed", false, intent.id);
  // An ambiguous earlier attempt is never retried from here; only resumeIntent (DB recovery claim) may replay it.
  if (intent.state === "pending" && intent.outcomeUnknown) return fail("outcome_unknown", false, intent.id);
  // begin 'existing' on a pending intent is a replay of a possibly-sent request (inside the ledger's window, same key and account).
  return runFrom(intent, spec, account, deps, outcome === "existing");
}

export type ResumeActor = AuthorizedBillingActor | { system: "d24_recovery" };

/**
 * Continues an existing intent. provider_created => register only (never a Stripe call). pending => re-derive the spec from trusted
 * records, then ask the DATABASE (claim_recovery) whether replaying is permitted: only inside the safe window, with a matching
 * fingerprint, for the original account, and under an exclusive lease. A replay always uses the ORIGINAL key; if the DB says no, the
 * intent is needs_review and nothing else happens (no new key, no finalize/send/collect ever). A studio actor can only resume its
 * own studio's intents; a foreign or unknown id looks identical (intent_not_found).
 */
export async function resumeIntent(intentId: string, actor: ResumeActor, deps: CreateDeps): Promise<CreateResult> {
  if (!isHostedInvoiceCreationEnabled(deps.env)) return fail("creation_disabled");
  if (deps.expectedLivemode !== true && deps.expectedLivemode !== false) return fail("deployment_key_mode_unknown");
  if (typeof intentId !== "string" || !UUID.test(intentId)) return fail("invalid_input");
  const isSystem = (actor as { system?: unknown })?.system === "d24_recovery" && Object.keys(actor).length === 1;
  if (!isSystem && !validActor(actor)) return fail("not_authorized");

  const intent = await deps.store.get(intentId);
  if (!intent || (!isSystem && intent.studioId !== (actor as AuthorizedBillingActor).studioId)) return fail("intent_not_found");
  if (intent.state === "failed" || intent.state === "abandoned") return fail("intent_failed", false, intent.id);
  if (intent.state === "needs_review") return fail("needs_review", false, intent.id);

  if (intent.state !== "pending") return runFrom(intent, null, null, deps, false);

  const resolvers = deps.resolvers ?? PRODUCTION_INVOICE_SPEC_RESOLVERS;
  const resolver = Object.prototype.hasOwnProperty.call(resolvers, intent.businessObjectType) ? resolvers[intent.businessObjectType] : undefined;
  if (!resolver) return escalate(deps.store, intent, "resolver_unavailable", "business_object_type_unsupported");
  const account = await resolveAccount(deps.supabase, intent.studioId);
  if (!account || account !== intent.stripeAccountId) return escalate(deps.store, intent, "account_unavailable_or_changed", "stripe_account_unavailable");
  let spec: InvoiceSpec | null;
  try {
    spec = await resolver({ supabase: deps.supabase, studioId: intent.studioId, businessObjectId: intent.businessObjectId });
  } catch {
    return fail("spec_unavailable", true, intent.id);
  }
  if (spec === null) return escalate(deps.store, intent, "object_not_owned", "business_object_not_owned");
  if (!validateSpec(spec)) return escalate(deps.store, intent, "spec_invalid", "invalid_invoice_spec");

  const claim = await deps.store.claimRecovery({
    intentId: intent.id,
    studioId: intent.studioId,
    requestFingerprint: deriveRequestFingerprint(intent.studioId, intent.businessObjectType, intent.businessObjectId, spec, account, deps.expectedLivemode),
  });
  if (!claim.ok) return fail("intent_unavailable", true, intent.id);
  switch (claim.outcome) {
    case "replay_permitted":
      // Replay with the ORIGINAL key / account from the ledger row the DB just granted; anything else is a ledger/trust mismatch.
      if (claim.intent.id !== intent.id || claim.intent.stripeAccountId !== account || claim.intent.idempotencyKey !== intent.idempotencyKey || claim.intent.state !== "pending") {
        return escalate(deps.store, intent, "claim_mismatch", "needs_review");
      }
      return runFrom(claim.intent, spec, account, deps, true);
    case "register_only":
      return runFrom(claim.intent, null, null, deps, false);
    case "lease_held":
      return fail("recovery_in_progress", true, intent.id);
    case "needs_review":
      return fail("needs_review", false, intent.id);
    default: {
      const again = await deps.store.get(intent.id);
      if (again?.state === "registered") return runFrom(again, null, null, deps, false);
      return fail("intent_failed", false, intent.id);
    }
  }
}

export type SweepSummary = { examined: number; registered: number; retryable: number; failed: number; disabled: boolean };

/** Bounded, unscheduled helper. A future job (separately authorized) would call it; nothing does today. */
export async function sweepRecoverableIntents(deps: CreateDeps, opts: { limit?: number; olderThanMs?: number } = {}): Promise<SweepSummary> {
  if (!isHostedInvoiceCreationEnabled(deps.env)) return { examined: 0, registered: 0, retryable: 0, failed: 0, disabled: true };
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), 25);
  const olderThanMs = Math.max(Math.trunc(opts.olderThanMs ?? 60_000), 0);
  const rows = await deps.store.listRecoverable({ limit, olderThanMinutes: Math.max(Math.ceil(olderThanMs / 60_000), 1) });
  const summary: SweepSummary = { examined: 0, registered: 0, retryable: 0, failed: 0, disabled: false };
  for (const row of rows.slice(0, limit)) {
    summary.examined += 1;
    const r = await resumeIntent(row.id, { system: "d24_recovery" }, deps);
    if (r.ok) summary.registered += 1;
    else if (r.retryable) summary.retryable += 1;
    else summary.failed += 1;
  }
  return summary;
}

// ---------- Supabase-backed store (signatures per docs/billing/D24-M3A-FOUNDATION.md; service role only) ----------

type RawIntent = {
  intent_id?: unknown; id?: unknown; studio_id?: unknown; status?: unknown; idempotency_key?: unknown; request_fingerprint?: unknown;
  stripe_account_id?: unknown; business_object_type?: unknown; business_object_id?: unknown; stripe_invoice_id?: unknown;
  livemode?: unknown; outcome_unknown?: unknown; created_at?: unknown;
};

const STATES = new Set(["pending", "provider_created", "registered", "failed", "abandoned", "needs_review"]);

function toIntent(raw: unknown): IntentRow | null {
  const r = raw as RawIntent | null;
  const id = r?.intent_id ?? r?.id;
  if (!r || typeof id !== "string" || typeof r.studio_id !== "string") return null;
  if (typeof r.status !== "string" || !STATES.has(r.status)) return null;
  const created = Date.parse(String(r.created_at ?? ""));
  if (Number.isNaN(created) || typeof r.stripe_account_id !== "string") return null;
  return {
    id, studioId: r.studio_id, state: r.status as IntentState, idempotencyKey: String(r.idempotency_key ?? ""),
    requestFingerprint: String(r.request_fingerprint ?? ""), stripeAccountId: r.stripe_account_id,
    businessObjectType: String(r.business_object_type ?? ""), businessObjectId: String(r.business_object_id ?? ""),
    stripeInvoiceId: typeof r.stripe_invoice_id === "string" ? r.stripe_invoice_id : null,
    livemode: typeof r.livemode === "boolean" ? r.livemode : null,
    outcomeUnknown: r.outcome_unknown === true,
    createdAtMs: created,
  };
}

const TRANSIENT = new Set(["40P01", "40001", "55P03"]);
const errCode = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? "");
const MISSING_FN = (c: string) => c === "42883" || c === "42P01" || c === "PGRST202";

export function createSupabaseIntentStore(supabase: Pick<SupabaseClient, "rpc" | "from">): IntentStore {
  return {
    async begin(i) {
      const { data, error } = await supabase.rpc("d24_intent_begin", {
        p_studio_id: i.studioId, p_business_object_type: i.businessObjectType, p_business_object_id: i.businessObjectId,
        p_idempotency_key: i.idempotencyKey, p_request_fingerprint: i.requestFingerprint, p_created_by: i.createdBy,
      });
      if (error) {
        const c = errCode(error);
        // The message is only inspected here to pick a fixed code; it is never returned.
        if (c === "23505") return { ok: false, code: /fingerprint/i.test(String((error as { message?: unknown }).message ?? "")) ? "request_fingerprint_mismatch" : "intent_payload_conflict", retryable: false };
        return { ok: false, code: "intent_unavailable", retryable: TRANSIENT.has(c) || MISSING_FN(c) };
      }
      const intent = toIntent(data);
      const outcome = (data as { outcome?: unknown } | null)?.outcome;
      if (!intent || (outcome !== "created" && outcome !== "existing" && outcome !== "existing_terminal" && outcome !== "needs_review" && outcome !== "register_only")) {
        return { ok: false, code: "intent_unavailable", retryable: true };
      }
      return { ok: true, outcome, intent };
    },
    async get(intentId) {
      const { data, error } = await supabase
        .from("hosted_invoice_creation_intents")
        .select("id, studio_id, status, idempotency_key, request_fingerprint, stripe_account_id, business_object_type, business_object_id, stripe_invoice_id, livemode, outcome_unknown, created_at")
        .eq("id", intentId)
        .maybeSingle();
      return error ? null : toIntent(data);
    },
    async markProviderCreated(i) {
      const { data, error } = await supabase.rpc("d24_intent_mark_provider_created", {
        p_intent_id: i.intentId, p_studio_id: i.studioId, p_stripe_invoice_id: i.stripeInvoiceId, p_livemode: i.livemode,
        p_key_livemode: i.keyLivemode, p_stripe_account_id: i.stripeAccountId,
      });
      if (error) return "error";
      const o = (data as { outcome?: unknown; status?: unknown } | null);
      if (o?.status === "needs_review" || o?.outcome === "recorded_in_review" || o?.outcome === "needs_review") return "review";
      return o?.outcome === "provider_created" || o?.outcome === "already_recorded" ? "recorded" : "error";
    },
    async register(i) {
      const { data, error } = await supabase.rpc("d24_intent_register", { p_intent_id: i.intentId, p_studio_id: i.studioId });
      if (error) {
        const c = errCode(error);
        if (MISSING_FN(c)) return { ok: false, code: "registration_unavailable", retryable: true };
        if (/^23/.test(c) || c === "42501" || c === "22023" || c === "55000" || c === "PGRST301") return { ok: false, code: "registration_failed", retryable: false };
        return { ok: false, code: "registration_failed", retryable: true };
      }
      const row = data as { outcome?: unknown; registry_id?: unknown; adopted_existing_facts?: unknown } | null;
      if (row?.outcome === "needs_review") return { ok: false, code: "needs_review", retryable: false };
      if (!row || typeof row.registry_id !== "string") return { ok: false, code: "registration_failed", retryable: true };
      return { ok: true, registryId: row.registry_id, adoptedExistingFacts: row.adopted_existing_facts === true };
    },
    async fail(i) {
      const { error } = await supabase.rpc("d24_intent_fail", { p_intent_id: i.intentId, p_studio_id: i.studioId, p_error_code: i.code, p_permanent: i.permanent });
      return !error;
    },
    async recordOutcome(i) {
      const { error } = await supabase.rpc("d24_intent_record_outcome", { p_intent_id: i.intentId, p_studio_id: i.studioId, p_outcome_code: i.code, p_outcome_unknown: i.unknown });
      return !error;
    },
    async claimRecovery(i) {
      const { data, error } = await supabase.rpc("d24_intent_claim_recovery", {
        p_intent_id: i.intentId, p_studio_id: i.studioId, p_request_fingerprint: i.requestFingerprint,
      });
      const outcome = (data as { outcome?: unknown } | null)?.outcome;
      const intent = toIntent(data);
      if (error || !intent || (outcome !== "replay_permitted" && outcome !== "lease_held" && outcome !== "register_only" && outcome !== "needs_review" && outcome !== "terminal")) return { ok: false };
      // replay_permitted must say so explicitly; anything ambiguous is treated as not permitted.
      if (outcome === "replay_permitted" && (data as { replay_permitted?: unknown }).replay_permitted !== true) return { ok: true, outcome: "needs_review", intent };
      return { ok: true, outcome, intent };
    },
    async flagReview(i) {
      const { data, error } = await supabase.rpc("d24_intent_flag_review", { p_intent_id: i.intentId, p_studio_id: i.studioId, p_reason_code: i.reasonCode });
      return !error && (data as { status?: unknown } | null)?.status === "needs_review";
    },
    async listRecoverable(i) {
      const { data, error } = await supabase.rpc("d24_intent_list_recoverable", { p_older_than_minutes: i.olderThanMinutes, p_limit: i.limit });
      if (error || !Array.isArray(data)) return [];
      return data.map(toIntent).filter((x): x is IntentRow => x !== null);
    },
  };
}
