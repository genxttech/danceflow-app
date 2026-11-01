import { createHash } from "node:crypto";
import type { HostedInvoiceStripeClient, IntentRow, IntentStore, InvoiceSpec, InvoiceSpecResolver, StripeInvoiceSnapshot } from "../create";

export const STUDIO_A = "00000000-0000-0000-0000-00000000005a";
export const STUDIO_B = "00000000-0000-0000-0000-00000000005b";
export const USER_A = "00000000-0000-0000-0000-0000000000a1";
export const ACCT_A = "acct_AAA111";
export const ACCT_B = "acct_BBB222";
export const HOUR = 60 * 60 * 1000;

export const SPEC: InvoiceSpec = {
  stripeCustomerId: "cus_A1",
  currency: "usd",
  daysUntilDue: 14,
  description: "Fee",
  lines: [{ description: "Entry", amountCents: 5000 }, { description: "Late", amountCents: 500 }],
};

/** Shared fake time so Stripe's key retention and the ledger's safe window move together. */
export class Clock {
  t = 1_000_000_000;
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

/**
 * Offline Stripe fake with real idempotency semantics: same key + same payload => same invoice; same key + different payload => error;
 * and PRUNING: a key older than `retentionMs` is forgotten, so replaying it creates a SECOND invoice (what the window logic must prevent).
 */
export class FakeStripe implements HostedInvoiceStripeClient {
  invoices = new Map<string, StripeInvoiceSnapshot & { account: string }>();
  keys = new Map<string, { hash: string; id: string; at: number }>();
  calls: Array<{ op: string; account: string; key: string; params: unknown }> = [];
  livemode = false;
  failNext: unknown = null;
  failAfterCreate: unknown = null;
  /** Throw AFTER the invoice has been created (the response is "lost"): models timeout with unknown result. */
  loseResponseAfterCreate: unknown = null;
  seq = 0;
  prefix = "";
  retentionMs = 24 * HOUR;
  constructor(public clock: Clock = new Clock()) {}
  customers = new Map<string, { id: string; livemode: boolean; hash: string }>();
  failCustomer: unknown = null;
  async ensureCustomer(a: Parameters<HostedInvoiceStripeClient["ensureCustomer"]>[0]) {
    this.calls.push({ op: "customer", account: a.stripeAccount, key: a.idempotencyKey, params: a.params });
    if (this.failCustomer) { const e = this.failCustomer; this.failCustomer = null; throw e; }
    const hash = JSON.stringify(a.params);
    const k = `${a.stripeAccount}|${a.idempotencyKey}`;
    const prior = this.customers.get(k);
    if (prior) {
      if (prior.hash !== hash) throw Object.assign(new Error("idem"), { type: "StripeIdempotencyError", statusCode: 400 });
      return { id: prior.id, livemode: prior.livemode };
    }
    const c = { id: `cus_fake${this.prefix}${this.customers.size + 1}`, livemode: this.livemode, hash };
    this.customers.set(k, c);
    return { id: c.id, livemode: c.livemode };
  }
  async createDraftInvoice(a: Parameters<HostedInvoiceStripeClient["createDraftInvoice"]>[0]) {
    this.calls.push({ op: "create", account: a.stripeAccount, key: a.idempotencyKey, params: a.params });
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    const allowed = ["customer", "collection_method", "days_until_due", "currency", "auto_advance", "description", "metadata"];
    for (const k of Object.keys(a.params)) if (!allowed.includes(k)) throw Object.assign(new Error("param"), { type: "StripeInvalidRequestError", statusCode: 400 });
    if (a.params.collection_method !== "send_invoice" || a.params.auto_advance !== false) throw Object.assign(new Error("bad"), { type: "StripeInvalidRequestError", statusCode: 400 });
    const hash = createHash("sha256").update(JSON.stringify(a.params)).digest("hex");
    const k = `${a.stripeAccount}|${a.idempotencyKey}`;
    let prior = this.keys.get(k);
    if (prior && this.clock.now() - prior.at > this.retentionMs) { this.keys.delete(k); prior = undefined; } // pruned
    if (prior) {
      if (prior.hash !== hash) throw Object.assign(new Error("idem"), { type: "StripeIdempotencyError", statusCode: 400 });
      return { ...this.invoices.get(prior.id)! };
    }
    const id = `in_fake${this.prefix}${++this.seq}`;
    const inv = { id, livemode: this.livemode, status: "draft", collection_method: "send_invoice", auto_advance: false, customer: a.params.customer, currency: a.params.currency, total: 0, account: a.stripeAccount };
    this.invoices.set(id, inv);
    this.keys.set(k, { hash, id, at: this.clock.now() });
    if (this.loseResponseAfterCreate) { const e = this.loseResponseAfterCreate; this.loseResponseAfterCreate = null; throw e; }
    return { ...inv };
  }
  async addInvoiceLines(a: Parameters<HostedInvoiceStripeClient["addInvoiceLines"]>[0]) {
    this.calls.push({ op: "lines", account: a.stripeAccount, key: a.idempotencyKey, params: a.lines });
    const inv = this.invoices.get(a.invoiceId);
    if (!inv || inv.account !== a.stripeAccount) throw Object.assign(new Error("nf"), { type: "StripeInvalidRequestError", statusCode: 404 });
    if (this.failAfterCreate) { const e = this.failAfterCreate; this.failAfterCreate = null; throw e; }
    inv.total = a.lines.reduce((n, l) => n + l.amount, 0);
    return { ...inv };
  }
  get createCount() { return this.invoices.size; }
}

/** In-memory model of the M3-A ledger contract (fingerprint pinning, safe window, outcome_unknown, recovery lease, needs_review). */
export class FakeStore implements IntentStore {
  rows = new Map<string, IntentRow & { reviewReason?: string; leaseUntil?: number }>();
  registered = new Map<string, string>(); // invoice id -> intent id
  log: string[] = [];
  registerFail: { code: string; retryable: boolean } | null = null;
  markFail = false;
  adopted = false;
  windowMs = 12 * HOUR;
  leaseMs = 120_000;
  claims = { granted: 0, held: 0, denied: 0 };
  accounts: Record<string, string> = { [STUDIO_A]: ACCT_A, [STUDIO_B]: ACCT_B };
  constructor(public clock: Clock = new Clock()) {}
  private get now() { return this.clock.now(); }
  async begin(i: Parameters<IntentStore["begin"]>[0]) {
    this.log.push("begin");
    for (const r of this.rows.values()) {
      if (r.studioId === i.studioId && r.idempotencyKey === i.idempotencyKey) {
        if (r.requestFingerprint !== i.requestFingerprint) return { ok: false as const, code: "request_fingerprint_mismatch" as const, retryable: false };
        if (r.state === "registered" || r.state === "failed" || r.state === "abandoned") return { ok: true as const, outcome: "existing_terminal" as const, intent: { ...r } };
        if (r.state === "provider_created") return { ok: true as const, outcome: "register_only" as const, intent: { ...r } };
        if (r.state === "needs_review") return { ok: true as const, outcome: "needs_review" as const, intent: { ...r } };
        if (r.state === "pending" && this.now - r.createdAtMs > this.windowMs) { r.state = "needs_review"; r.reviewReason = "window_expired"; return { ok: true as const, outcome: "needs_review" as const, intent: { ...r } }; }
        return { ok: true as const, outcome: "existing" as const, intent: { ...r } };
      }
    }
    // ledger rule: one live intent per (studio, type, object)
    for (const r of this.rows.values()) {
      if (r.studioId === i.studioId && r.businessObjectType === i.businessObjectType && r.businessObjectId === i.businessObjectId && r.state !== "failed" && r.state !== "abandoned") {
        return { ok: false as const, code: "intent_payload_conflict" as const, retryable: false };
      }
    }
    const row = { id: `00000000-0000-0000-0000-${String(this.rows.size + 1).padStart(12, "0")}`, studioId: i.studioId, state: "pending" as const, idempotencyKey: i.idempotencyKey, requestFingerprint: i.requestFingerprint, stripeAccountId: this.accounts[i.studioId], businessObjectType: i.businessObjectType, businessObjectId: i.businessObjectId, stripeInvoiceId: null, livemode: null, outcomeUnknown: false, createdAtMs: this.now };
    this.rows.set(row.id, row);
    return { ok: true as const, outcome: "created" as const, intent: { ...row } };
  }
  async get(id: string) { const r = this.rows.get(id); return r ? { ...r } : null; }
  async markProviderCreated(i: Parameters<IntentStore["markProviderCreated"]>[0]): Promise<"recorded" | "review" | "error"> {
    this.log.push("mark");
    if (this.markCrash) throw new Error("process died");
    if (this.markFail) return "error";
    const r = this.rows.get(i.intentId)!;
    if (i.livemode !== i.keyLivemode || i.stripeAccountId !== r.stripeAccountId || i.studioId !== r.studioId) return "error";
    if (r.state === "needs_review") { r.stripeInvoiceId = r.stripeInvoiceId ?? i.stripeInvoiceId; r.livemode = r.livemode ?? i.livemode; return "review"; }
    if (r.state === "pending") { r.state = "provider_created"; r.stripeInvoiceId = i.stripeInvoiceId; r.livemode = i.livemode; r.outcomeUnknown = false; r.leaseUntil = undefined; }
    return r.stripeInvoiceId === i.stripeInvoiceId ? "recorded" : "error";
  }
  markCrash = false;
  needsReviewOnRegister = false;
  async register(i: { intentId: string; studioId: string }) {
    this.log.push("register");
    if (this.registerFail) return { ok: false as const, ...this.registerFail };
    const r = this.rows.get(i.intentId)!;
    if (this.needsReviewOnRegister) { r.state = "needs_review"; return { ok: false as const, code: "needs_review", retryable: false }; }
    if (!r.stripeInvoiceId || r.studioId !== i.studioId) return { ok: false as const, code: "registration_failed", retryable: false };
    const owner = this.registered.get(r.stripeInvoiceId);
    if (owner && owner !== r.id) return { ok: false as const, code: "registration_failed", retryable: false };
    this.registered.set(r.stripeInvoiceId, r.id);
    r.state = "registered";
    return { ok: true as const, registryId: `reg_${r.id}`, adoptedExistingFacts: this.adopted };
  }
  async fail(i: { intentId: string; code: string; permanent: boolean }) {
    this.log.push(`fail:${i.code}`);
    const r = this.rows.get(i.intentId);
    if (!r) return false;
    if (i.permanent && (r.outcomeUnknown || r.state === "registered")) return false;
    if (i.permanent && r.state !== "needs_review") r.state = "failed";
    return true;
  }
  async recordOutcome(i: { intentId: string; code: string; unknown: boolean }) {
    this.log.push(`outcome:${i.code}:${i.unknown}`);
    const r = this.rows.get(i.intentId);
    if (this.recordFail) return false;
    if (r && i.unknown) { r.outcomeUnknown = true; r.leaseUntil = undefined; }
    return true;
  }
  recordFail = false;
  flagFail = false;
  async claimRecovery(i: { intentId: string; studioId: string; requestFingerprint: string }) {
    this.log.push("claim");
    const r = this.rows.get(i.intentId);
    if (!r || r.studioId !== i.studioId) return { ok: false as const };
    const out = (outcome: "replay_permitted" | "lease_held" | "register_only" | "needs_review" | "terminal") => ({ ok: true as const, outcome, intent: { ...r } });
    if (r.state === "registered" || r.state === "failed" || r.state === "abandoned") return out("terminal");
    if (r.state === "needs_review") { this.claims.denied++; return out("needs_review"); }
    if (r.state === "provider_created") return out("register_only");
    if (r.requestFingerprint !== i.requestFingerprint) { r.state = "needs_review"; r.reviewReason = "fingerprint_mismatch"; this.claims.denied++; return out("needs_review"); }
    if (this.now - r.createdAtMs > this.windowMs) { r.state = "needs_review"; r.reviewReason = "window_expired"; this.claims.denied++; return out("needs_review"); }
    if (this.accounts[r.studioId] !== r.stripeAccountId) { r.state = "needs_review"; r.reviewReason = "account_changed"; this.claims.denied++; return out("needs_review"); }
    if (r.leaseUntil && r.leaseUntil > this.now) { this.claims.held++; return out("lease_held"); }
    r.leaseUntil = this.now + this.leaseMs;
    this.claims.granted++;
    return out("replay_permitted");
  }
  async flagReview(i: { intentId: string; reasonCode: string }) {
    this.log.push(`review:${i.reasonCode}`);
    if (this.flagFail) return false;
    const r = this.rows.get(i.intentId);
    if (r && r.state !== "registered" && r.state !== "failed" && r.state !== "abandoned") { r.state = "needs_review"; r.reviewReason = i.reasonCode; }
    return r?.state === "needs_review";
  }
  async listRecoverable(i: { limit: number }) { return [...this.rows.values()].filter((r) => r.state === "pending" || r.state === "provider_created").slice(0, i.limit).map((r) => ({ ...r })); }
}

export function fakeSupabase(accounts: Record<string, { acct: string | null; charges?: boolean }> = { [STUDIO_A]: { acct: ACCT_A }, [STUDIO_B]: { acct: ACCT_B } }) {
  return {
    rpc: async () => ({ data: null, error: null }),
    from: (_t: string) => {
      let id = "";
      const q = { select: () => q, eq: (_c: string, v: string) => ((id = v), q), maybeSingle: async () => {
        const a = accounts[id];
        return { data: a ? { stripe_connected_account_id: a.acct, stripe_connect_charges_enabled: a.charges ?? true } : null, error: null };
      } };
      return q;
    },
  } as never;
}

/** Resolver that proves ownership: only objects of the same studio resolve; everything else is null. */
export const ownedResolver = (owned: Record<string, string>, spec: InvoiceSpec = SPEC): InvoiceSpecResolver =>
  async ({ studioId, businessObjectId }) => (owned[businessObjectId] === studioId ? spec : null);
