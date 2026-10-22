import { describe, expect, it } from "vitest";
import { FakeNumberAdapter } from "../fakeNumbers";
import { numberFriendlyName, observeCreationHistory, observeNumberIdentity, offerNumbers, reconcileInventories, refreshInventory, refreshNumber, runNumberAcquisition, type NumberInput } from "../numberRunner";
import type { NumBeginArgs, NumBeginResult, NumContext, NumFinishOutcome, NumObserveResult, NumberStore, OfferRecorded } from "../numberStore";
import { RunnerStoreError } from "../store";
import { IsvApiError } from "../types";
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
    requirements: { blocker: null, funding_mode: "credit_recurring", price_cents: 200, selection_id: "sel-1", selection_e164: E164, ceiling_remaining_cents: null }, operations: [], known_numbers: [],
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
  readonly observedFacts: Record<string, unknown>[] = [];
  async observe(_o: string, _l: string, id: string, facts: Record<string, unknown> = {}): Promise<NumObserveResult> {
    this.log.push(`observe:${id}`);
    this.observedFacts.push(facts);
    const next = this.observeResults.shift();
    if (next instanceof RunnerStoreError) throw next;
    return next ?? { status: /purchase/.test(id) ? "owned" : "attached", code: null, state: "campaign_pending" };
  }
  async transition(_o: string, _l: string, to: string, _s: string, errorCode: string | null) {
    this.log.push(`transition:${to}:${errorCode}`);
    this.transitions.push(`${to}:${errorCode}`);
    return to;
  }
  inventories: string[][] = [];
  histories: { facts: Record<string, unknown>; source: string; digest: string }[] = [];
  async historyObserve(_o: string, _l: string, facts: Record<string, unknown>, source: string, digest: string) {
    this.log.push("history");
    this.histories.push({ facts, source, digest });
    return { created: 0, complete: facts.complete === true };
  }
  identities: { facts: Record<string, unknown>; source: string; digest: string }[] = [];
  async identityObserve(_o: string, _l: string, facts: Record<string, unknown>, source: string, digest: string) {
    this.log.push("identity");
    this.identities.push({ facts, source, digest });
    return { sid: String(facts.sid ?? ""), e164: String(facts.phone_number ?? "") };
  }
  missing = 0;
  async inventoryObserve(_o: string, _l: string, numbers: { sid: string; phone_number: string | null }[], _source?: string, _listedAt?: string) {
    const sids = numbers.map((n) => n.sid);
    this.log.push("inventory");
    this.inventories.push(sids);
    return { listed: sids.length, unknown: sids.filter((sid) => !this.ctx.known_numbers.includes(sid)).length, missing: this.missing, mismatch: 0, duplicate: 0 };
  }
  async claimRecon(_studioId?: string, _leaseOwner?: string) {
    return this.claim();
  }
  targets: { studio_id: string; legal_entity_id: string; twilio_account_sid: string; last_checked_at: string | null; reason: string }[] = [];
  async reconTargets() {
    return this.targets;
  }
  marked: string[] = [];
  async reconMark(entity: string) {
    this.marked.push(entity);
  }
  async escalateOrphans() {
    this.log.push("escalate");
    return { outbox: true, raised: 0 };
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
    expect(adapter.calls.map((c) => c.method)).toEqual(["listIncomingNumbers", "findOwnedNumbers", "purchaseNumber", "getNumber", "listServiceNumbers", "attachNumber", "getServiceNumbers"]);
    expect(store.log).toEqual([
      "claim", "account", "context", "inventory", "begin:number_purchase", "finish:op-number_purchase:succeeded", "observe:op-number_purchase",
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
    expect(result.detail).toContain("inventory_unrecorded");
    expect(adapter.count("purchaseNumber")).toBe(0);
    expect(store.begins).toHaveLength(0);
    expect(store.transitions).toContain("exception:num_inventory_unknown");
  });

  it("two matching numbers are ambiguous: nothing is bought", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    adapter.seedOwned(E164);
    adapter.seedOwned(E164);
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.detail).toContain("inventory_unrecorded:2");
    expect(store.begins).toHaveLength(0);
    expect(store.transitions).toContain("exception:num_inventory_unknown");
  });

  it("a number the system accounts for (ledger, sender registry, acknowledgement) does not block; a foreign one in the inventory does, and the inventory is read BEFORE anything is recorded or bought", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    const foreign = adapter.seedOwned("+12025550199");
    store.ctx = { ...store.ctx, known_numbers: [foreign] };
    const ok = await runNumberAcquisition(base(store, adapter));
    expect(ok.outcome).toBe("number_ready");
    expect(adapter.calls[0].method).toBe("listIncomingNumbers");
    const store2 = new ScriptedStore();
    const adapter2 = world();
    adapter2.seedOwned("+12025550198");
    const blocked = await runNumberAcquisition(base(store2, adapter2));
    expect(blocked.outcome).toBe("exception");
    expect(adapter2.count("purchaseNumber")).toBe(0);
    expect(store2.begins).toHaveLength(0);
    // an inventory that cannot be read proves nothing: nothing is bought
    const store3 = new ScriptedStore();
    const adapter3 = world();
    adapter3.failNext("listIncomingNumbers", { kind: "transient" });
    expect((await runNumberAcquisition(base(store3, adapter3))).outcome).toBe("retry_later");
    expect(adapter3.count("purchaseNumber")).toBe(0);
    expect(store3.begins).toHaveLength(0);
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
    const result = await runNumberAcquisition(base(store, adapter));
    expect(result.outcome).toBe("exception");
    expect(store.observedFacts[0]).toMatchObject({ not_found: true, sid: null });
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
      ["TW022", "release_current_number_first"], ["TW030", "not_runnable"], ["TW032", "prerequisite_missing"], ["TW033", "recurring_missing"], ["TW040", "no_selection"], ["23505", "number_taken"], ["TW047", "prerequisite_missing"],
    ];
    for (const [code, outcome] of cases) {
      const store = new ScriptedStore();
      store.beginQueue.number_purchase = [sc(code)];
      const adapter = world();
      expect((await runNumberAcquisition(base(store, adapter))).outcome, code).toBe(outcome);
      expect(adapter.count("purchaseNumber"), code).toBe(0);
    }
    // an unreconciled provider resource is reported as what it is: a block with its own reason, never a failed operation
    {
      const blocked = new ScriptedStore();
      blocked.beginQueue.number_purchase = [sc("TW047")];
      const result = await runNumberAcquisition(base(blocked, world()));
      expect(result).toMatchObject({ outcome: "prerequisite_missing", detail: "number_purchase:unreconciled_provider_resource" });
      expect(blocked.transitions.filter((t) => t.startsWith("exception"))).toEqual([]);
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

  it("R2b-P2: the scheduled pass skips and reports what it could not list, counts what it listed, and escalates once", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    store.targets = [
      { studio_id: STUDIO, legal_entity_id: "le-1", twilio_account_sid: ACC, last_checked_at: null, reason: "never_checked" },
      { studio_id: "studio-2", legal_entity_id: "le-2", twilio_account_sid: `AC${"7".repeat(32)}`, last_checked_at: null, reason: "due" },
    ];
    const summary = await reconcileInventories({ store, adapterFor: (account) => (account === ACC ? adapter : null) });
    expect(summary.checked).toBe(1);
    expect(summary.clean).toBe(1);
    expect(summary.skipped).toEqual([{ studioId: "studio-2", reason: "adapter_unavailable" }]);
    expect(store.marked).toEqual(["le-2"]);   // the business that could not be attempted still rotates
    expect(store.log.filter((entry) => entry === "escalate")).toHaveLength(1);
    // an unclean listing is counted as a finding, never as clean
    const unclean = new ScriptedStore();
    unclean.targets = [store.targets[0]];
    unclean.missing = 1;
    const second = await reconcileInventories({ store: unclean, adapterFor: () => adapter });
    expect(second).toMatchObject({ checked: 1, clean: 0, findings: 1 });
    // a failing worklist is reported, nothing is assumed clean
    const broken = new ScriptedStore();
    broken.reconTargets = async () => {
      throw new RunnerStoreError("XX000");
    };
    expect((await reconcileInventories({ store: broken, adapterFor: () => adapter })).escalation).toEqual({ error: "targets:XX000" });
  });

  it("R2b-P2: a listing of more than 1000 numbers is never recorded as clean: manual reconciliation is explicit", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    adapter.listIncomingNumbers = async () => Array.from({ length: 1001 }, (_, i) => ({ sid: `PN${i.toString(16).padStart(32, "0")}`, phone_number: "+12025550300" }));
    const result = await refreshInventory({ store, adapter, studioId: STUDIO, actorId: "a" });
    expect(result).toMatchObject({ outcome: "manual_required", detail: "inventory_over_1000" });
    expect(store.inventories).toHaveLength(0);
    store.targets = [{ studio_id: STUDIO, legal_entity_id: "le-1", twilio_account_sid: ACC, last_checked_at: null, reason: "due" }];
    const summary = await reconcileInventories({ store, adapterFor: () => adapter });
    expect(summary.manual).toEqual([STUDIO]);
    expect(summary.checked).toBe(0);
  });

  it("R2b-P2: the real adapter's 'too many pages' condition is mapped to manual reconciliation, not to an endless retry", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    adapter.listIncomingNumbers = async () => {
      throw new IsvApiError("transient", null, "inventory_too_large", "list too long to search safely");
    };
    expect(await refreshInventory({ store, adapter, studioId: STUDIO, actorId: "a" })).toMatchObject({ outcome: "manual_required" });
    expect(store.inventories).toHaveLength(0);
    // any other listing failure is still a retry
    adapter.listIncomingNumbers = async () => {
      throw new IsvApiError("transient", 503, null, "boom");
    };
    expect(await refreshInventory({ store: new ScriptedStore(), adapter, studioId: STUDIO, actorId: "a" })).toMatchObject({ outcome: "retry_later" });
  });

  it("R2b-P1: the creation history is read through the adapter when it can guarantee one, and an adapter that cannot (the real one) records nothing", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    adapter.universe.createdLog.push({ account_sid: ACC, e164: "+12025550142", at: Date.now() - 60_000 });
    const ok = await observeCreationHistory({ store, adapter, studioId: STUDIO, actorId: "a", since: new Date(Date.now() - 3_600_000) });
    expect(ok.outcome).toBe("history_recorded");
    expect(store.histories[0]).toMatchObject({ source: adapter.evidenceSource, facts: { account_sid: ACC, complete: true, created_e164: ["+12025550142"] } });
    expect(store.histories[0].digest).toMatch(/^[0-9a-f]{64}$/);
    // an adapter without the method (the real adapter is not verified against the provider): nothing is read, nothing recorded
    const bare = world() as unknown as { readCreationHistory?: unknown };
    bare.readCreationHistory = undefined;
    const refused = new ScriptedStore();
    expect((await observeCreationHistory({ store: refused, adapter: bare as never, studioId: STUDIO, actorId: "a", since: new Date() })).outcome).toBe("history_unavailable");
    expect(refused.histories).toHaveLength(0);
  });

  it("R2b-P1: an identity read records the PROVIDER's facts under the adapter's evidence source, and never reads a number for another account", async () => {
    const store = new ScriptedStore();
    const adapter = world();
    const sid = adapter.seedOwned(E164);
    const ok = await observeNumberIdentity({ store, adapter, studioId: STUDIO, actorId: "a", phoneNumberSid: sid });
    expect(ok.outcome).toBe("identity_recorded");
    expect(store.identities).toHaveLength(1);
    expect(store.identities[0]).toMatchObject({ source: adapter.evidenceSource, facts: { sid, phone_number: E164, account_sid: ACC } });
    expect(store.identities[0].digest).toMatch(/^[0-9a-f]{64}$/);
    // the adapter is bound to another account than the studio's: nothing is read
    const other = new ScriptedStore();
    other.account = { legalEntityId: "le-1", accountSid: `AC${"9".repeat(32)}`, status: "active" };
    const reads = adapter.count("getNumber");
    expect((await observeNumberIdentity({ store: other, adapter, studioId: STUDIO, actorId: "a", phoneNumberSid: sid })).outcome).toBe("account_mismatch");
    expect(adapter.count("getNumber")).toBe(reads);
    expect(other.identities).toHaveLength(0);
    // a provider failure records nothing and is retried later
    adapter.failNext("getNumber", { kind: "transient" });
    const failing = new ScriptedStore();
    expect((await observeNumberIdentity({ store: failing, adapter, studioId: STUDIO, actorId: "a", phoneNumberSid: sid })).outcome).toBe("retry_later");
    expect(failing.identities).toHaveLength(0);
  });
});
