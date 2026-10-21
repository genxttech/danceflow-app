import { describe, expect, it } from "vitest";
import { FakeNumberAdapter } from "../fakeNumbers";
import { numberFriendlyName, offerNumbers, refreshNumber, runNumberAcquisition, type NumberInput } from "../numberRunner";
import type { NumBeginArgs, NumBeginResult, NumContext, NumFinishOutcome, NumObserveResult, NumberStore, OfferRecorded } from "../numberStore";
import { RunnerStoreError } from "../store";
import type { IsvNumberAdapter } from "../numberTypes";

/**
 * TW-4F R2b: the number runner's DECISIONS (what it calls, in what order, and what it refuses to call) against a scripted store. The database semantics
 * (fee gate, uniqueness, atomicity, evidence verdicts, tenant isolation) are pinned against a real schema in localStack.r2b.test.ts.
 */

const ACC = `AC${"1".repeat(32)}`;
const OTHER = `AC${"2".repeat(32)}`;
const STUDIO = "s1111111-1111-4111-8111-111111111111";
const MG = `MG${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;
const E164 = "+12025550101";

class ScriptedStore implements NumberStore {
  readonly log: string[] = [];
  account: { legalEntityId: string | null; accountSid: string | null; status: string | null } = { legalEntityId: "le-1", accountSid: ACC, status: "active" };
  claimError: RunnerStoreError | null = null;
  beginQueue: Record<string, (NumBeginResult | RunnerStoreError)[]> = {};
  observeResults: (NumObserveResult | RunnerStoreError)[] = [];
  finishes: { id: string; outcome: NumFinishOutcome }[] = [];
  begins: NumBeginArgs[] = [];
  transitions: string[] = [];
  offers: unknown[][] = [];
  offerError: RunnerStoreError | null = null;
  ctx: NumContext = {
    state: "campaign_pending", submission_seq: 1, studio_id: STUDIO, messaging_service_sid: MG, campaign_sid: QE,
    requirements: { blocker: null, funding_mode: "credit_recurring", price_cents: 200, selection_id: "sel-1", selection_e164: E164, ceiling_remaining_cents: null }, operations: [],
  };

  async claim() {
    this.log.push("claim");
    if (this.claimError) throw this.claimError;
    return { onboarding_id: "ob-1", studio_id: STUDIO, state: this.ctx.state, submission_seq: 1 };
  }
  async release() { this.log.push("release"); }
  async getAccount() { this.log.push("account"); return this.account; }
  async context() { this.log.push("context"); return this.ctx; }
  async begin(_o: string, _l: string, args: NumBeginArgs): Promise<NumBeginResult> {
    this.log.push(`begin:${args.kind}`);
    this.begins.push(args);
    const next = (this.beginQueue[args.kind] ?? []).shift();
    if (next instanceof RunnerStoreError) throw next;
    return next ?? { action: "execute", operation_id: `op-${args.kind}`, attempt: 1, fee_kinds: args.kind === "number_purchase" ? ["number"] : [], account_sid: ACC, e164: E164 };
  }
  async finish(_o: string, _l: string, id: string, outcome: NumFinishOutcome) {
    this.log.push(`finish:${id}:${outcome.status}`);
    this.finishes.push({ id, outcome });
    return { state: "campaign_pending" };
  }
  async observe(_o: string, _l: string, id: string): Promise<NumObserveResult> {
    this.log.push(`observe:${id}`);
    const next = this.observeResults.shift();
    if (next instanceof RunnerStoreError) throw next;
    return next ?? { status: /purchase/.test(id) ? "owned" : "attached", code: null, state: "campaign_pending" };
  }
  async transition(_o: string, _l: string, to: string, _s: string, errorCode: string | null) {
    this.log.push(`transition:${to}:${errorCode}`);
    this.transitions.push(`${to}:${errorCode}`);
    return to;
  }
  async recordOffer(_s: string, _a: string, accountSid: string, _search: Record<string, unknown>, candidates: unknown[]): Promise<OfferRecorded> {
    this.log.push(`offer:${accountSid}`);
    this.offers.push(candidates);
    if (this.offerError) throw this.offerError;
    return { offer_id: "offer-1", count: candidates.length, expires_at: "2099-01-01T00:00:00Z", candidates: candidates.map((c) => ({ e164: (c as { e164: string }).e164, locality: null, region: null, mms_capable: false })) };
  }
}

const base = (store: ScriptedStore, adapter: IsvNumberAdapter, over: Partial<NumberInput> = {}): NumberInput => ({ store, adapter, studioId: STUDIO, actorId: "admin-1", envName: "test", confirmFee: true, ...over });
const sc = (code: string) => new RunnerStoreError(code);
const world = () => {
  const adapter = new FakeNumberAdapter(ACC);
  adapter.seedAvailable(E164);
  adapter.registerService(MG);
  return adapter;
};

describe("number runner decisions", () => {
  it("calls nothing when the adapter belongs to another account, also when no subaccount is recorded (cross-tenant)", async () => {
    const store = new ScriptedStore();
    const wrong = new FakeNumberAdapter(OTHER);
    expect((await runNumberAcquisition(base(store, wrong))).outcome).toBe("account_mismatch");
    store.account = { legalEntityId: "le-1", accountSid: null, status: null };
    expect((await runNumberAcquisition(base(store, world()))).outcome).toBe("needs_subaccount");
    store.account = { legalEntityId: null, accountSid: null, status: null };
    expect((await runNumberAcquisition(base(store, world()))).outcome).toBe("needs_subaccount");
    expect(wrong.calls).toHaveLength(0);
    expect(store.begins).toHaveLength(0);
  });

  it("every database blocker stops the run BEFORE any provider call or ledger write", async () => {
    const cases: [NonNullable<NumContext["requirements"]["blocker"]>, string][] = [
      ["suspended", "suspended"], ["campaign_not_verified", "prerequisite_missing"], ["unpriced", "price_unavailable"], ["price_changed", "price_unavailable"],
      ["release_current_number_first", "release_current_number_first"], ["no_selection", "no_selection"], ["selection_expired", "no_selection"], ["selection_stale", "no_selection"],
      ["number_taken", "number_taken"], ["pilot_recurring", "pilot_conflict"], ["awaiting_recurring", "recurring_missing"], ["awaiting_authorization", "spend_blocked"],
      ["awaiting_funding", "insufficient_credit"], ["on_hold", "insufficient_credit"], ["pilot_ceiling", "insufficient_credit"],
    ];
    for (const [blocker, outcome] of cases) {
      const store = new ScriptedStore();
      store.ctx = { ...store.ctx, requirements: { ...store.ctx.requirements, blocker } };
      const adapter = world();
      expect((await runNumberAcquisition(base(store, adapter))).outcome, blocker).toBe(outcome);
      expect(adapter.calls, blocker).toHaveLength(0);
      expect(store.begins, blocker).toHaveLength(0);
    }
  });

  it("without the admin's confirmation for THIS run nothing is looked up, reserved or bought", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    const result = await runNumberAcquisition(base(store, adapter, { confirmFee: false }));
    expect(result.outcome).toBe("waiting_fee_confirmation");
    expect(adapter.calls).toHaveLength(0);
    expect(store.begins).toHaveLength(0);
  });

  it("an unverified campaign (no service or campaign SID in the ledger) is a prerequisite, never a purchase", async () => {
    const store = new ScriptedStore();
    store.ctx = { ...store.ctx, campaign_sid: null };
    const adapter = world();
    expect((await runNumberAcquisition(base(store, adapter))).outcome).toBe("prerequisite_missing");
    expect(adapter.calls).toHaveLength(0);
  });

  it("records the attempt BEFORE the purchase and closes it after, then confirms ownership and attachment with provider reads", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.outcome).toBe("number_ready");
    expect(adapter.calls.map((c) => c.method)).toEqual(["findOwnedNumbers", "purchaseNumber", "getNumber", "listServiceNumbers", "attachNumber", "getServiceNumbers"]);
    expect(store.log).toEqual([
      "claim", "account", "context", "begin:number_purchase", "finish:op-number_purchase:succeeded", "observe:op-number_purchase",
      "begin:number_attach", "finish:op-number_attach:succeeded", "observe:op-number_attach", "release",
    ]);
    expect(store.begins[0]).toMatchObject({ kind: "number_purchase", friendlyName: numberFriendlyName("test", STUDIO, 1), params: { selection_id: "sel-1", e164: E164 } });
    expect(store.begins[1].params).toMatchObject({ messaging_service_sid: MG });
  });

  it("a number the account already owns that the ledger never recorded is NOT adopted: nothing is reserved or bought and a human decides", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    adapter.seedOwned(E164);
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.outcome).toBe("exception");
    expect(result.detail).toContain("exists_unrecorded");
    expect(adapter.count("purchaseNumber")).toBe(0);
    expect(store.begins).toHaveLength(0);
    expect(store.transitions).toContain("exception:num_unrecorded");
  });

  it("two matching numbers are ambiguous: nothing is bought", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    adapter.seedOwned(E164);
    adapter.seedOwned(E164);
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.detail).toContain("ambiguous_match");
    expect(store.begins).toHaveLength(0);
    expect(store.transitions).toContain("exception:num_ambiguous");
  });

  it("a definite refusal closes the attempt as failed (api) and sends the onboarding to a human; the approval is not retried", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    adapter.failNext("purchaseNumber", { kind: "validation", code: "21452" });
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.outcome).toBe("exception");
    expect(store.finishes[0].outcome).toMatchObject({ status: "failed", errorCode: "api" });
    expect(store.transitions).toContain("exception:num_refused");
    expect(adapter.count("purchaseNumber")).toBe(1);
  });

  it("a 4xx WITHOUT Twilio's own error code, or a proxy-style 408/409/499, on the paid call is an unknown outcome, never a definite refusal", async () => {
    for (const failure of [{ kind: "validation" as const }, { kind: "validation" as const, code: undefined }]) {
      const store = new ScriptedStore();
      const adapter = world();
      adapter.failNext("purchaseNumber", failure);
      const result = await runNumberAcquisition(base(store, adapter));
      expect(result.outcome).toBe("retry_later");
      expect(store.finishes[0].outcome).toMatchObject({ status: "unknown_outcome" });
      expect(store.transitions).toEqual([]);
    }
  });

  it("a number the provider no longer has (404) is judged as evidence by the database, not retried forever", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    adapter.failNext("getNumber", { kind: "validation", code: "20404", status: 404 });
    store.observeResults = [{ status: "mismatch", code: "sid_mismatch", state: "exception" }];
    const seen: Record<string, unknown>[] = [];
    const original = store.observe.bind(store);
    store.observe = async (o, l, id, facts, source, digest) => { seen.push(facts); return original(o, l, id, facts, source, digest); };
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.outcome).toBe("exception");
    expect(seen[0]).toMatchObject({ not_found: true, sid: null });
  });

  it("a network error, a timeout, a 5xx or a lost response is an UNKNOWN outcome: recorded as such, never closed as failed, never repeated by the same run", async () => {
    for (const failure of [{ kind: "transient" as const }, { kind: "transient" as const, lostResponse: true }, { kind: "unexpected" as const }]) {
      const store = new ScriptedStore();
      const adapter = world();
      adapter.failNext("purchaseNumber", failure);
      const result = await runNumberAcquisition(base(store, adapter));
      expect(result.outcome, JSON.stringify(failure)).toBe("retry_later");
      expect(store.finishes[0].outcome).toMatchObject({ status: "unknown_outcome", errorCode: "unclear_outcome" });
      expect(adapter.count("purchaseNumber")).toBe(1);
      expect(store.transitions).toEqual([]);
    }
  });

  it("an open attempt from an earlier run is reconciled by lookup: exactly one match is adopted without buying again", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    const sid = adapter.seedOwned(E164);
    store.ctx = { ...store.ctx, operations: [{ id: "op-purchase-old", kind: "number_purchase", attempt: 1, status: "unknown_outcome", provider_sid: null, e164: E164, fee_bearing: true, age_seconds: 600, superseded: false, resource_status: null }] };
    store.beginQueue.number_purchase = [{ action: "reconcile", operation_id: "op-purchase-old", provider_sid: null, status: "unknown_outcome", fee_bearing: true, e164: E164, age_seconds: 600 }];
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.outcome).toBe("number_ready");
    expect(adapter.count("purchaseNumber")).toBe(0);
    expect(store.finishes[0]).toEqual({ id: "op-purchase-old", outcome: { status: "succeeded", providerSid: sid } });
  });

  it("an unknown FEE outcome that the lookup cannot find stays unknown: it is never repeated, whatever its age; only an admin settles it", async () => {
    for (const age of [10, 600, 86_400]) {
      const store = new ScriptedStore();
      const adapter = world();
      store.ctx = { ...store.ctx, operations: [{ id: "op-purchase-old", kind: "number_purchase", attempt: 1, status: "unknown_outcome", provider_sid: null, e164: E164, fee_bearing: true, age_seconds: age, superseded: false, resource_status: null }] };
      store.beginQueue.number_purchase = [{ action: "reconcile", operation_id: "op-purchase-old", provider_sid: null, status: "unknown_outcome", fee_bearing: true, e164: E164, age_seconds: age }];
      const result = await runNumberAcquisition(base(store, adapter));
      expect(result.outcome, String(age)).toBe("unknown_outcome");
      expect(adapter.count("purchaseNumber"), String(age)).toBe(0);
      expect(store.finishes[0].outcome).toMatchObject({ status: "unknown_outcome", errorCode: "fee_outcome_unknown" });
      expect(store.finishes.some((f) => f.outcome.status === "failed")).toBe(false);
    }
  });

  it("a lookup that fails during reconciliation leaves the operation open and buys nothing", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    store.beginQueue.number_purchase = [{ action: "reconcile", operation_id: "op-purchase-old", provider_sid: null, status: "unknown_outcome", fee_bearing: true, e164: E164, age_seconds: 600 }];
    store.ctx = { ...store.ctx, operations: [{ id: "op-purchase-old", kind: "number_purchase", attempt: 1, status: "unknown_outcome", provider_sid: null, e164: E164, fee_bearing: true, age_seconds: 600, superseded: false, resource_status: null }] };
    adapter.failNext("findOwnedNumbers", { kind: "transient" });
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.outcome).toBe("retry_later");
    expect(adapter.count("purchaseNumber")).toBe(0);
    expect(store.finishes[0].outcome).toMatchObject({ status: "unknown_outcome", errorCode: "reconcile_failed" });
  });

  it("each begin() refusal is reported as what it is, with nothing called", async () => {
    const cases: [string, string][] = [
      ["55P03", "lease_lost"], ["TW001", "runner_closed"], ["TW004", "spend_blocked"], ["TW005", "suspended"], ["TW007", "insufficient_credit"], ["TW008", "price_unavailable"], ["TW011", "pilot_conflict"],
      ["TW022", "release_current_number_first"], ["TW030", "not_runnable"], ["TW032", "prerequisite_missing"], ["TW033", "recurring_missing"], ["TW040", "no_selection"], ["23505", "number_taken"],
    ];
    for (const [code, outcome] of cases) {
      const store = new ScriptedStore();
      store.beginQueue.number_purchase = [sc(code)];
      const adapter = world();
      expect((await runNumberAcquisition(base(store, adapter))).outcome, code).toBe(outcome);
      expect(adapter.count("purchaseNumber"), code).toBe(0);
    }
    const store = new ScriptedStore();
    store.beginQueue.number_purchase = [sc("XX000")];
    expect((await runNumberAcquisition(base(store, world()))).outcome).toBe("exception");
  });

  it("a purchase the provider read does NOT confirm (wrong account, wrong number, not SMS capable) stops before the attachment", async () => {
    const store = new ScriptedStore();
    store.observeResults = [{ status: "mismatch", code: "number_mismatch", state: "exception" }];
    const adapter = world();
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.outcome).toBe("exception");
    expect(result.detail).toContain("number_mismatch");
    expect(adapter.count("attachNumber")).toBe(0);
    expect(store.begins.map((b) => b.kind)).toEqual(["number_purchase"]);
  });

  it("an attachment the provider read does not show is not a ready number; a failed attach is an unknown outcome only when the request may have been applied", async () => {
    const store = new ScriptedStore();
    store.observeResults = [{ status: "owned", code: null, state: "campaign_pending" }, { status: "mismatch", code: "number_not_in_service", state: "exception" }];
    const result = await runNumberAcquisition(base(store, world()));
    expect(result.outcome).toBe("exception");
    expect(result.detail).toContain("number_not_in_service");
    const store2 = new ScriptedStore();
    const adapter2 = world();
    adapter2.failNext("attachNumber", { kind: "transient" });
    expect((await runNumberAcquisition(base(store2, adapter2))).outcome).toBe("retry_later");
    expect(store2.finishes.at(-1)?.outcome).toMatchObject({ status: "unknown_outcome" });
  });

  it("an attach whose number is already in the service is adopted without a second attach (free operation)", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.outcome).toBe("number_ready");
    const sid = [...adapter.universe.owned.keys()][0];
    const store2 = new ScriptedStore();
    const adapter2 = new FakeNumberAdapter(ACC, adapter.universe);
    adapter2.registerService(MG);
    adapter2.services.get(MG)!.numbers.add(sid);
    store2.ctx = { ...store2.ctx, operations: [{ id: "op-purchase", kind: "number_purchase", attempt: 1, status: "succeeded", provider_sid: sid, e164: E164, fee_bearing: true, age_seconds: 10, superseded: false, resource_status: "owned" }] };
    store2.beginQueue.number_purchase = [{ action: "skip", operation_id: "op-purchase", provider_sid: sid, status: "succeeded" }];
    const again = await runNumberAcquisition(base(store2, adapter2));
    expect(again.outcome).toBe("number_ready");
    expect(adapter2.count("purchaseNumber")).toBe(0);
    expect(adapter2.count("attachNumber")).toBe(0);
  });

  it("a busy or closed runner is reported without any call", async () => {
    const store = new ScriptedStore();
    store.claimError = sc("55P03");
    const adapter = world();
    expect((await runNumberAcquisition(base(store, adapter))).outcome).toBe("lease_busy");
    store.claimError = sc("TW001");
    expect((await runNumberAcquisition(base(store, adapter))).outcome).toBe("runner_closed");
    store.claimError = sc("TW030");
    expect((await runNumberAcquisition(base(store, adapter))).outcome).toBe("not_runnable");
    expect(adapter.calls).toHaveLength(0);
    expect(store.log).not.toContain("account");
  });

  it("always releases the lease, also when something throws", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    adapter.failNext("purchaseNumber", { kind: "unexpected" });
    await runNumberAcquisition(base(store, adapter));
    expect(store.log.at(-1)).toBe("release");
  });
});

describe("number search and status check", () => {
  it("a search is read-only: it records an offer and never calls a purchase or an attachment", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    const result = await offerNumbers({ store, adapter, studioId: STUDIO, actorId: "admin-1", areaCode: "202" });
    expect(result.outcome).toBe("offered");
    expect(result.offer?.candidates.map((c) => c.e164)).toEqual([E164]);
    expect(adapter.calls.map((c) => c.method)).toEqual(["searchAvailableNumbers"]);
    expect(store.log).toEqual([`offer:${ACC}`]);
  });

  it("an empty search, a provider failure and the database's refusals are each reported plainly", async () => {
    const empty = new FakeNumberAdapter(ACC);
    expect((await offerNumbers({ store: new ScriptedStore(), adapter: empty, studioId: STUDIO, actorId: "a" })).outcome).toBe("no_numbers");
    const broken = world();
    broken.failNext("searchAvailableNumbers", { kind: "transient" });
    expect((await offerNumbers({ store: new ScriptedStore(), adapter: broken, studioId: STUDIO, actorId: "a" })).outcome).toBe("search_refused");
    for (const [code, outcome] of [["TW005", "account_mismatch"], ["TW043", "no_numbers"], ["TW032", "prerequisite_missing"], ["TW030", "not_runnable"], ["54000", "exception"]] as const) {
      const store = new ScriptedStore();
      store.offerError = sc(code);
      expect((await offerNumbers({ store, adapter: world(), studioId: STUDIO, actorId: "a" })).outcome, code).toBe(outcome);
    }
  });

  it("the status check is GET-only: it re-reads ownership and attachment and buys and attaches nothing", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    const bought = await runNumberAcquisition(base(store, adapter));
    expect(bought.outcome).toBe("number_ready");
    const sid = [...adapter.universe.owned.keys()][0];
    const store2 = new ScriptedStore();
    store2.ctx = {
      ...store2.ctx,
      operations: [
        { id: "op-purchase", kind: "number_purchase", attempt: 1, status: "succeeded", provider_sid: sid, e164: E164, fee_bearing: true, age_seconds: 10, superseded: false, resource_status: "owned" },
        { id: "op-attach", kind: "number_attach", attempt: 1, status: "succeeded", provider_sid: sid, e164: E164, fee_bearing: false, age_seconds: 10, superseded: false, resource_status: "attached" },
      ],
    };
    const before = { purchase: adapter.count("purchaseNumber"), attach: adapter.count("attachNumber") };
    const result = await refreshNumber({ store: store2, adapter, studioId: STUDIO, actorId: "a", envName: "test" });
    expect(result.outcome).toBe("number_ready");
    expect(adapter.count("purchaseNumber")).toBe(before.purchase);
    expect(adapter.count("attachNumber")).toBe(before.attach);
    expect(store2.log).not.toContain("begin:number_purchase");
    const none = await refreshNumber({ store: new ScriptedStore(), adapter, studioId: STUDIO, actorId: "a", envName: "test" });
    expect(none.outcome).toBe("nothing_to_check");
  });
});
