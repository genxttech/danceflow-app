import { createHash } from "node:crypto";
import type { HostedInvoiceStripeClient, IntentRow, IntentStore, InvoiceSpec, InvoiceSpecResolver, StripeInvoiceSnapshot } from "../create";

export const STUDIO_A = "00000000-0000-0000-0000-00000000005a";
export const STUDIO_B = "00000000-0000-0000-0000-00000000005b";
export const USER_A = "00000000-0000-0000-0000-0000000000a1";
export const ACCT_A = "acct_AAA111";
export const ACCT_B = "acct_BBB222";

export const SPEC: InvoiceSpec = {
  stripeCustomerId: "cus_A1",
  currency: "usd",
  daysUntilDue: 14,
  description: "Fee",
  lines: [{ description: "Entry", amountCents: 5000 }, { description: "Late", amountCents: 500 }],
};

/** Offline Stripe fake with real idempotency semantics: same key + same payload => same invoice; same key + different payload => error. */
export class FakeStripe implements HostedInvoiceStripeClient {
  invoices = new Map<string, StripeInvoiceSnapshot & { account: string }>();
  keys = new Map<string, { hash: string; id: string }>();
  calls: Array<{ op: string; account: string; key: string; params: unknown }> = [];
  livemode = false;
  failNext: unknown = null;
  failAfterCreate: unknown = null;
  seq = 0;
  prefix = "";
  forbidden = ["finalize", "send", "pay", "auto_advance_true"];
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
    const prior = this.keys.get(k);
    if (prior) {
      if (prior.hash !== hash) throw Object.assign(new Error("idem"), { type: "StripeIdempotencyError", statusCode: 400 });
      return { ...this.invoices.get(prior.id)! };
    }
    const id = `in_fake${this.prefix}${++this.seq}`;
    const inv = { id, livemode: this.livemode, status: "draft", collection_method: "send_invoice", auto_advance: false, customer: a.params.customer, currency: a.params.currency, total: 0, account: a.stripeAccount };
    this.invoices.set(id, inv);
    this.keys.set(k, { hash, id });
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

export class FakeStore implements IntentStore {
  rows = new Map<string, IntentRow>();
  registered = new Map<string, string>(); // invoice id -> intent id
  log: string[] = [];
  registerFail: { code: string; retryable: boolean } | null = null;
  markFail = false;
  adopted = false;
  accounts: Record<string, string> = { [STUDIO_A]: ACCT_A, [STUDIO_B]: ACCT_B };
  clock = () => 1_000_000;
  async begin(i: Parameters<IntentStore["begin"]>[0]) {
    this.log.push("begin");
    for (const r of this.rows.values()) {
      if (r.studioId === i.studioId && r.idempotencyKey === i.idempotencyKey) return { ok: true as const, intent: { ...r } };
    }
    // ledger rule: one live intent per (studio, type, object)
    for (const r of this.rows.values()) {
      if (r.studioId === i.studioId && r.businessObjectType === i.businessObjectType && r.businessObjectId === i.businessObjectId && r.state !== "failed" && r.state !== "abandoned") {
        return { ok: false as const, code: "intent_payload_conflict" as const, retryable: false };
      }
    }
    const row: IntentRow = { id: `00000000-0000-0000-0000-${String(this.rows.size + 1).padStart(12, "0")}`, studioId: i.studioId, state: "pending", idempotencyKey: i.idempotencyKey, stripeAccountId: this.accounts[i.studioId], businessObjectType: i.businessObjectType, businessObjectId: i.businessObjectId, stripeInvoiceId: null, livemode: null, createdAtMs: this.clock() };
    this.rows.set(row.id, row);
    return { ok: true as const, intent: { ...row } };
  }
  async get(id: string) { const r = this.rows.get(id); return r ? { ...r } : null; }
  async markProviderCreated(i: Parameters<IntentStore["markProviderCreated"]>[0]) {
    this.log.push("mark");
    if (this.markFail) return false;
    const r = this.rows.get(i.intentId)!;
    if (i.livemode !== i.keyLivemode || i.stripeAccountId !== r.stripeAccountId || i.studioId !== r.studioId) return false;
    if (r.state === "pending") { r.state = "provider_created"; r.stripeInvoiceId = i.stripeInvoiceId; r.livemode = i.livemode; }
    return r.stripeInvoiceId === i.stripeInvoiceId;
  }
  async register(i: { intentId: string; studioId: string }) {
    this.log.push("register");
    if (this.registerFail) return { ok: false as const, ...this.registerFail };
    const r = this.rows.get(i.intentId)!;
    if (!r.stripeInvoiceId || r.studioId !== i.studioId) return { ok: false as const, code: "registration_failed", retryable: false };
    const owner = this.registered.get(r.stripeInvoiceId);
    if (owner && owner !== r.id) return { ok: false as const, code: "registration_failed", retryable: false };
    this.registered.set(r.stripeInvoiceId, r.id);
    r.state = "registered";
    return { ok: true as const, registryId: `reg_${r.id}`, adoptedExistingFacts: this.adopted };
  }
  async fail(i: { intentId: string; code: string; permanent: boolean }) { this.log.push(`fail:${i.code}`); const r = this.rows.get(i.intentId); if (r && i.permanent && r.state !== "registered") r.state = "failed"; }
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
