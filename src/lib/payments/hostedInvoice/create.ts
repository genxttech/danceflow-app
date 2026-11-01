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

/** Stripe refuses to honor an idempotency key after ~24h and would create a second invoice; stay well inside that. */
export const STRIPE_IDEMPOTENCY_SAFE_WINDOW_MS = 20 * 60 * 60 * 1000;

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
  stripeCustomerId: string;
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

export type IntentState = "pending" | "provider_created" | "registered" | "failed" | "abandoned";

export type IntentRow = {
  id: string;
  studioId: string;
  state: IntentState;
  idempotencyKey: string;
  stripeAccountId: string;
  businessObjectType: string;
  businessObjectId: string;
  createdBy: string | null;
  stripeInvoiceId: string | null;
  livemode: boolean | null;
  createdAtMs: number;
};

/** Port over the M3-A SQL functions. The Supabase implementation below is the only place their signatures appear. */
export interface IntentStore {
  begin(input: {
    studioId: string;
    createdBy: string;
    idempotencyKey: string;
    businessObjectType: string;
    businessObjectId: string;
  }): Promise<{ ok: true; intent: IntentRow } | { ok: false; code: "intent_payload_conflict" | "intent_unavailable"; retryable: boolean }>;
  /** Direct service-role read of the ledger row; null when missing. Studio scoping is enforced by the caller. */
  get(intentId: string): Promise<IntentRow | null>;
  markProviderCreated(input: { intentId: string; studioId: string; stripeInvoiceId: string; livemode: boolean; keyLivemode: boolean; stripeAccountId: string }): Promise<boolean>;
  register(input: { intentId: string; studioId: string }): Promise<
    { ok: true; registryId: string; adoptedExistingFacts: boolean } | { ok: false; code: string; retryable: boolean }
  >;
  fail(input: { intentId: string; studioId: string; code: string; permanent: boolean }): Promise<void>;
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
  now?: () => number;
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
  | "registration_failed";

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
  if (typeof spec.stripeCustomerId !== "string" || !CUSTOMER_ID.test(spec.stripeCustomerId)) return false;
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
 * Deterministic: same studio + object + requestKey + invoice content => same key; a different studio can never collide with it.
 * The ledger has no payload column, so the content fingerprint is the key's suffix: a changed spec under the same requestKey is a
 * different key (and the ledger's one-live-intent-per-object rule then refuses it), and resume can detect a changed spec by
 * comparing the suffix without calling Stripe. Layout: d24inv_<32 hex scope>_<16 hex content> (56 chars; ledger allows 8..200).
 */
export function deriveIdempotencyKey(studioId: string, businessObjectType: string, businessObjectId: string, requestKey: string, spec: InvoiceSpec): string {
  const scope = createHash("sha256").update(["d24", "v1", studioId, businessObjectType, businessObjectId, requestKey].join("\u0000")).digest("hex").slice(0, 32);
  return `d24inv_${scope}_${deriveSpecFingerprint(businessObjectType, businessObjectId, spec)}`;
}

export function deriveSpecFingerprint(businessObjectType: string, businessObjectId: string, spec: InvoiceSpec): string {
  return createHash("sha256")
    .update(JSON.stringify({ t: businessObjectType, o: businessObjectId, c: spec.stripeCustomerId, cur: spec.currency, d: spec.daysUntilDue, desc: spec.description ?? null, l: spec.lines.map((l) => [l.description, l.amountCents]) }))
    .digest("hex")
    .slice(0, 16);
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

function classifyStripeError(e: unknown): { code: "stripe_unavailable" | "stripe_rejected"; retryable: boolean } {
  const err = e as { type?: unknown; statusCode?: unknown; code?: unknown } | null;
  const type = String(err?.type ?? "");
  const status = Number(err?.statusCode ?? 0);
  if (type === "StripeIdempotencyError" || err?.code === "idempotency_key_in_use") {
    // concurrent request holding the key => retry later; payload mismatch under the same key => permanent
    return err?.code === "idempotency_key_in_use" ? { code: "stripe_unavailable", retryable: true } : { code: "stripe_rejected", retryable: false };
  }
  if (type === "StripeConnectionError" || type === "StripeAPIError" || type === "StripeRateLimitError" || status >= 500 || status === 429 || status === 0) {
    return { code: "stripe_unavailable", retryable: true };
  }
  return { code: "stripe_rejected", retryable: false };
}

// ---------- core ----------

async function runFrom(intent: IntentRow, spec: InvoiceSpec | null, account: string | null, deps: CreateDeps): Promise<CreateResult> {
  const { store } = deps;
  let invoiceId = intent.stripeInvoiceId;
  let livemode = intent.livemode;

  if (intent.state === "pending") {
    // spec and account are required to talk to Stripe; resumeIntent re-derives them from trusted records.
    if (!spec || !account) return fail("invalid_invoice_spec", false, intent.id);
    let snap: StripeInvoiceSnapshot;
    try {
      const created = await deps.stripe.createDraftInvoice({
        stripeAccount: account,
        idempotencyKey: intent.idempotencyKey,
        params: {
          customer: spec.stripeCustomerId,
          collection_method: "send_invoice",
          days_until_due: spec.daysUntilDue,
          currency: spec.currency,
          auto_advance: false,
          ...(spec.description ? { description: spec.description } : {}),
          metadata: { d24_intent_id: intent.id },
        },
      });
      validateSnapshot(created, spec);
      snap = await deps.stripe.addInvoiceLines({
        stripeAccount: account,
        idempotencyKey: intent.idempotencyKey + ":lines",
        invoiceId: created.id,
        lines: spec.lines.map((l) => ({ description: l.description, amount: l.amountCents })),
      });
      validateSnapshot(snap, spec);
      if (snap.id !== created.id || snap.livemode !== created.livemode) throw new SnapshotError();
      if (typeof snap.total !== "number" || snap.total !== specTotal(spec)) throw new SnapshotError();
    } catch (e) {
      if (e instanceof SnapshotError) {
        await store.fail({ intentId: intent.id, studioId: intent.studioId, code: "stripe_response_invalid", permanent: true });
        return fail("stripe_response_invalid", false, intent.id);
      }
      const c = classifyStripeError(e);
      if (!c.retryable) await store.fail({ intentId: intent.id, studioId: intent.studioId, code: c.code, permanent: true });
      return fail(c.code, c.retryable, intent.id);
    }

    // The Stripe response is the only source of the id and livemode. A mismatch with the deployment key mode is refused.
    if (snap.livemode !== deps.expectedLivemode) {
      await store.fail({ intentId: intent.id, studioId: intent.studioId, code: "livemode_mismatch", permanent: true });
      return fail("livemode_mismatch", false, intent.id);
    }
    const marked = await store.markProviderCreated({ intentId: intent.id, studioId: intent.studioId, stripeInvoiceId: snap.id, livemode: snap.livemode, keyLivemode: deps.expectedLivemode, stripeAccountId: account });
    if (!marked) return fail("registration_unavailable", true, intent.id);
    invoiceId = snap.id;
    livemode = snap.livemode;
  }

  if (intent.state === "provider_created" && livemode !== deps.expectedLivemode) {
    await store.fail({ intentId: intent.id, studioId: intent.studioId, code: "livemode_mismatch", permanent: true });
    return fail("livemode_mismatch", false, intent.id);
  }
  if (!invoiceId || livemode == null || !INVOICE_ID.test(invoiceId)) return fail("registration_failed", false, intent.id);

  const reg = await store.register({ intentId: intent.id, studioId: intent.studioId });
  if (!reg.ok) return fail(reg.code === "registration_unavailable" ? "registration_unavailable" : "registration_failed", reg.retryable, intent.id);
  return { ok: true, state: "registered", intentId: intent.id, stripeInvoiceId: invoiceId, livemode, registryId: reg.registryId, adoptedExistingFacts: reg.adoptedExistingFacts };
}

class SnapshotError extends Error {}

function validateSnapshot(s: StripeInvoiceSnapshot, spec: InvoiceSpec) {
  if (
    !s || typeof s.id !== "string" || !INVOICE_ID.test(s.id) || typeof s.livemode !== "boolean" ||
    s.status !== "draft" || s.collection_method !== "send_invoice" ||
    s.customer !== spec.stripeCustomerId || s.currency !== spec.currency ||
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
    return fail("registration_failed", true);
  }
  if (spec === null) return fail("business_object_not_owned");
  if (!validateSpec(spec)) return fail("invalid_invoice_spec");

  const begun = await deps.store.begin({
    studioId: actor.studioId,
    createdBy: actor.userId,
    idempotencyKey: deriveIdempotencyKey(actor.studioId, type, objectId, request.requestKey, spec),
    businessObjectType: type,
    businessObjectId: objectId,
  });
  if (!begun.ok) return fail(begun.code, begun.retryable);
  const intent = begun.intent;
  // Defense in depth: the ledger row must be this studio's.
  if (intent.studioId !== actor.studioId) return fail("intent_unavailable", false);
  // The ledger resolved the account itself; it must agree with ours or nothing is sent to Stripe.
  if (intent.stripeAccountId !== account) return fail("stripe_account_unavailable", false, intent.id);
  if (intent.state === "failed" || intent.state === "abandoned") return fail("intent_failed", false, intent.id);
  if (intent.state === "pending" && (deps.now ?? Date.now)() - intent.createdAtMs > STRIPE_IDEMPOTENCY_SAFE_WINDOW_MS) {
    await deps.store.fail({ intentId: intent.id, studioId: intent.studioId, code: "idempotency_window_expired", permanent: true });
    return fail("idempotency_window_expired", false, intent.id);
  }
  return runFrom(intent, spec, account, deps);
}

export type ResumeActor = AuthorizedBillingActor | { system: "d24_recovery" };

/**
 * Continues an existing intent. provider_created => register only (never a Stripe call). begun => re-derives the spec from
 * trusted records, refuses if it changed or if Stripe's idempotency window may have lapsed, then re-issues the create with the
 * SAME key (Stripe returns the original invoice). A studio actor can only resume its own studio's intents; a foreign or
 * unknown id looks identical (intent_not_found).
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

  if (intent.state !== "pending") return runFrom(intent, null, null, deps);

  const now = (deps.now ?? Date.now)();
  if (now - intent.createdAtMs > STRIPE_IDEMPOTENCY_SAFE_WINDOW_MS) {
    await deps.store.fail({ intentId: intent.id, studioId: intent.studioId, code: "idempotency_window_expired", permanent: true });
    return fail("idempotency_window_expired", false, intent.id);
  }
  const resolvers = deps.resolvers ?? PRODUCTION_INVOICE_SPEC_RESOLVERS;
  const resolver = Object.prototype.hasOwnProperty.call(resolvers, intent.businessObjectType) ? resolvers[intent.businessObjectType] : undefined;
  if (!resolver) return fail("business_object_type_unsupported", false, intent.id);
  const account = await resolveAccount(deps.supabase, intent.studioId);
  if (!account || account !== intent.stripeAccountId) return fail("stripe_account_unavailable", false, intent.id);
  let spec: InvoiceSpec | null;
  try {
    spec = await resolver({ supabase: deps.supabase, studioId: intent.studioId, businessObjectId: intent.businessObjectId });
  } catch {
    return fail("registration_failed", true, intent.id);
  }
  if (spec === null) return fail("business_object_not_owned", false, intent.id);
  if (!validateSpec(spec)) return fail("invalid_invoice_spec", false, intent.id);
  if (!intent.idempotencyKey.endsWith("_" + deriveSpecFingerprint(intent.businessObjectType, intent.businessObjectId, spec))) {
    await deps.store.fail({ intentId: intent.id, studioId: intent.studioId, code: "payload_changed", permanent: true });
    return fail("payload_changed", false, intent.id);
  }
  return runFrom(intent, spec, account, deps);
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
  intent_id?: unknown; id?: unknown; studio_id?: unknown; status?: unknown; idempotency_key?: unknown; stripe_account_id?: unknown;
  business_object_type?: unknown; business_object_id?: unknown; stripe_invoice_id?: unknown; livemode?: unknown; created_at?: unknown;
};

function toIntent(raw: unknown): IntentRow | null {
  const r = raw as RawIntent | null;
  const id = r?.intent_id ?? r?.id;
  if (!r || typeof id !== "string" || typeof r.studio_id !== "string") return null;
  const st = r.status;
  if (st !== "pending" && st !== "provider_created" && st !== "registered" && st !== "failed" && st !== "abandoned") return null;
  const created = Date.parse(String(r.created_at ?? ""));
  if (Number.isNaN(created) || typeof r.stripe_account_id !== "string") return null;
  return {
    id, studioId: r.studio_id, state: st, idempotencyKey: String(r.idempotency_key ?? ""), stripeAccountId: r.stripe_account_id,
    businessObjectType: String(r.business_object_type ?? ""), businessObjectId: String(r.business_object_id ?? ""),
    stripeInvoiceId: typeof r.stripe_invoice_id === "string" ? r.stripe_invoice_id : null,
    livemode: typeof r.livemode === "boolean" ? r.livemode : null,
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
        p_idempotency_key: i.idempotencyKey, p_created_by: i.createdBy,
      });
      if (error) {
        const c = errCode(error);
        if (c === "23505") return { ok: false, code: "intent_payload_conflict", retryable: false };
        return { ok: false, code: "intent_unavailable", retryable: TRANSIENT.has(c) || MISSING_FN(c) };
      }
      const intent = toIntent(data);
      return intent ? { ok: true, intent } : { ok: false, code: "intent_unavailable", retryable: true };
    },
    async get(intentId) {
      const { data, error } = await supabase
        .from("hosted_invoice_creation_intents")
        .select("id, studio_id, status, idempotency_key, stripe_account_id, business_object_type, business_object_id, stripe_invoice_id, livemode, created_at")
        .eq("id", intentId)
        .maybeSingle();
      return error ? null : toIntent(data);
    },
    async markProviderCreated(i) {
      const { error } = await supabase.rpc("d24_intent_mark_provider_created", {
        p_intent_id: i.intentId, p_studio_id: i.studioId, p_stripe_invoice_id: i.stripeInvoiceId, p_livemode: i.livemode,
        p_key_livemode: i.keyLivemode, p_stripe_account_id: i.stripeAccountId,
      });
      return !error;
    },
    async register(i) {
      const { data, error } = await supabase.rpc("d24_intent_register", { p_intent_id: i.intentId, p_studio_id: i.studioId });
      if (error) {
        const c = errCode(error);
        if (MISSING_FN(c)) return { ok: false, code: "registration_unavailable", retryable: true };
        if (/^23/.test(c) || c === "42501" || c === "22023" || c === "55000" || c === "PGRST301") return { ok: false, code: "registration_failed", retryable: false };
        return { ok: false, code: "registration_failed", retryable: true };
      }
      const row = data as { registry_id?: unknown; adopted_existing_facts?: unknown } | null;
      if (!row || typeof row.registry_id !== "string") return { ok: false, code: "registration_failed", retryable: true };
      return { ok: true, registryId: row.registry_id, adoptedExistingFacts: row.adopted_existing_facts === true };
    },
    async fail(i) {
      await supabase.rpc("d24_intent_fail", { p_intent_id: i.intentId, p_studio_id: i.studioId, p_error_code: i.code, p_permanent: i.permanent });
    },
    async listRecoverable(i) {
      const { data, error } = await supabase.rpc("d24_intent_list_recoverable", { p_older_than_minutes: i.olderThanMinutes, p_limit: i.limit });
      if (error || !Array.isArray(data)) return [];
      return data.map(toIntent).filter((x): x is IntentRow => x !== null);
    },
  };
}
