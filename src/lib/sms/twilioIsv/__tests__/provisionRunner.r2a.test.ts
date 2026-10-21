import { describe, expect, it } from "vitest";
import type { RunnerInputs } from "../payloads";
import { FakeProvisioningAdapter } from "../fakeProvisioning";
import { rotatingSubaccountAdapter } from "../rotation";
import { refreshProvisioning, runProvisioning, serviceFriendlyName, type ProvisionInput } from "../provisionRunner";
import type { BeginArgs, BeginResult, FinishOutcome, ObserveResult, ProvisionContext, ProvisionStore } from "../provisionStore";
import { RunnerStoreError } from "../store";
import { IsvApiError, type IsvErrorKind } from "../types";
import type { IsvProvisioningAdapter } from "../provisioningTypes";

/**
 * TW-4F R2a: the runner's DECISIONS (what it calls, in what order, and what it refuses to call) against a scripted store. The database semantics (fee gate,
 * uniqueness, atomicity, evidence verdicts) are pinned against a real schema in localStack.r2a.test.ts.
 */

const ACC = `AC${"1".repeat(32)}`;
const OTHER = `AC${"2".repeat(32)}`;
const STUDIO = "s1111111-1111-4111-8111-111111111111";
const INBOUND = "https://app.example.test/api/sms/twilio/inbound";
const BRAND = `BN${"b".repeat(32)}`;

class ScriptedStore implements ProvisionStore {
  readonly log: string[] = [];
  account: { legalEntityId: string | null; accountSid: string | null; status: string | null } = { legalEntityId: "le-1", accountSid: ACC, status: "active" };
  claimError: RunnerStoreError | null = null;
  beginQueue: Record<string, (BeginResult | RunnerStoreError)[]> = {};
  finishError: RunnerStoreError | null = null;
  observeResults: (ObserveResult | RunnerStoreError)[] = [];
  finishes: { id: string; outcome: FinishOutcome }[] = [];
  begins: BeginArgs[] = [];
  transitions: string[] = [];
  ctx: ProvisionContext = {
    state: "service_setup", submission_seq: 1, studio_id: STUDIO, legal_entity_id: "le-1", brand_sid: BRAND,
    requirements: { path: "standard", use_case: "MIXED", pilot: false, blocker: null, components: [] }, operations: [], entity_live_elsewhere: [],
  };
  inputs: Partial<RunnerInputs> = { studio_name: "Harbor Dance", studio_public_name: null, studio_slug: "harbor-dance" };

  async claim() {
    this.log.push("claim");
    if (this.claimError) throw this.claimError;
    return { onboarding_id: "ob-1", studio_id: STUDIO, state: this.ctx.state, submission_seq: 1 };
  }
  async release() { this.log.push("release"); }
  async getAccount() { this.log.push("account"); return this.account; }
  async getInputs() { return this.inputs as RunnerInputs; }
  async getFeeKinds(): Promise<never> { throw new Error("not used"); }
  async context() { this.log.push("context"); return this.ctx; }
  async begin(_o: string, _l: string, args: BeginArgs): Promise<BeginResult> {
    this.log.push(`begin:${args.kind}`);
    this.begins.push(args);
    const next = (this.beginQueue[args.kind] ?? []).shift();
    if (next instanceof RunnerStoreError) throw next;
    return next ?? { action: "execute", operation_id: `op-${args.kind}`, attempt: 1, fee_kinds: args.kind === "campaign" ? ["campaign_vetting"] : [], account_sid: ACC };
  }
  async finish(_o: string, _l: string, id: string, outcome: FinishOutcome) {
    this.log.push(`finish:${id}:${outcome.status}`);
    this.finishes.push({ id, outcome });
    if (this.finishError) throw this.finishError;
    return { state: "service_setup" };
  }
  async observe(_o: string, _l: string, id: string) {
    this.log.push(`observe:${id}`);
    const next = this.observeResults.shift();
    if (next instanceof RunnerStoreError) throw next;
    return next ?? { status: /^op-c/.test(id) ? ("pending" as const) : ("ready" as const), code: null, state: "service_setup" };
  }
  async transition(_o: string, _l: string, to: string, _s: string, errorCode: string | null) {
    this.log.push(`transition:${to}:${errorCode}`);
    this.transitions.push(`${to}:${errorCode}`);
    return to;
  }
}

const base = (store: ScriptedStore, adapter: IsvProvisioningAdapter, over: Partial<ProvisionInput> = {}): ProvisionInput => ({
  store, adapter, studioId: STUDIO, actorId: "admin-1", envName: "test", confirmFee: true, inboundUrl: INBOUND, origin: "https://www.idanceflow.com", source: "fake", ...over,
});
const sc = (code: string) => new RunnerStoreError(code);

describe("provisioning runner decisions", () => {
  it("calls nothing when the inbound route is not configured (no provider call, no begin)", async () => {
    const store = new ScriptedStore();
    const adapter = new FakeProvisioningAdapter(ACC);
    const result = await runProvisioning(base(store, adapter, { inboundUrl: null }));
    expect(result.outcome).toBe("config_missing");
    expect(adapter.calls).toHaveLength(0);
    expect(store.begins).toHaveLength(0);
  });

  it("refuses an adapter that belongs to another account before any call (cross-tenant), also when no subaccount is recorded", async () => {
    const store = new ScriptedStore();
    const wrong = new FakeProvisioningAdapter(OTHER);
    expect((await runProvisioning(base(store, wrong))).outcome).toBe("account_mismatch");
    store.account = { legalEntityId: "le-1", accountSid: null, status: null };
    expect((await runProvisioning(base(store, new FakeProvisioningAdapter(ACC)))).outcome).toBe("needs_subaccount");
    store.account = { legalEntityId: null, accountSid: null, status: null };
    expect((await runProvisioning(base(store, new FakeProvisioningAdapter(ACC)))).outcome).toBe("needs_subaccount");
    expect(wrong.calls).toHaveLength(0);
    expect(store.begins).toHaveLength(0);
  });

  it("records the attempt BEFORE the provider call and closes it after: begin, create, finish, then reads", async () => {
    const store = new ScriptedStore();
    const adapter = new FakeProvisioningAdapter(ACC);
    const result = await runProvisioning(base(store, adapter, { stopAfterService: true }));
    expect(result.outcome).toBe("service_ready");
    expect(adapter.calls.map((c) => c.method)).toEqual(["findMessagingServices", "createMessagingService", "getMessagingService"]);
    expect(store.log).toEqual(["claim", "account", "context", "begin:messaging_service", "finish:op-messaging_service:succeeded", "observe:op-messaging_service", "release"]);
    expect(store.begins[0]).toMatchObject({ kind: "messaging_service", friendlyName: serviceFriendlyName("test", STUDIO, 1) });
  });

  it("a Messaging Service that already exists at the provider is ADOPTED, never created again; two matches stop for a human", async () => {
    const store = new ScriptedStore();
    const adapter = new FakeProvisioningAdapter(ACC);
    const prefix = `df:test:${STUDIO}:ms:`;
    const sid = adapter.seedService(`${prefix}1`, { inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
    const result = await runProvisioning(base(store, adapter, { stopAfterService: true }));
    expect(result.outcome).toBe("service_ready");
    expect(adapter.count("createMessagingService")).toBe(0);
    expect(store.finishes[0].outcome).toMatchObject({ status: "succeeded", providerSid: sid });
    // two candidates: ambiguous
    const store2 = new ScriptedStore();
    const adapter2 = new FakeProvisioningAdapter(ACC);
    adapter2.seedService(`${prefix}1`);
    adapter2.seedService(`${prefix}2`);
    const ambiguous = await runProvisioning(base(store2, adapter2, { stopAfterService: true }));
    expect(ambiguous.outcome).toBe("exception");
    expect(ambiguous.detail).toContain("ambiguous_match");
    expect(adapter2.count("createMessagingService")).toBe(0);
    expect(store2.begins).toHaveLength(0);
    expect(store2.transitions).toContain("exception:prov_ambiguous");
  });

  it("a lookup that fails changes nothing: no attempt is recorded and nothing is created", async () => {
    const store = new ScriptedStore();
    const adapter = new FakeProvisioningAdapter(ACC);
    adapter.failNext("findMessagingServices", { kind: "transient" });
    const result = await runProvisioning(base(store, adapter, { stopAfterService: true }));
    expect(result.outcome).toBe("retry_later");
    expect(store.begins).toHaveLength(0);
    expect(adapter.count("createMessagingService")).toBe(0);
  });

  it("a definite refusal closes the attempt as failed and sends the onboarding to a human; an unclear outcome is recorded as unknown and NOT retried", async () => {
    for (const [kind, status, outcome] of [["validation", "failed", "exception"], ["account", "failed", "exception"], ["transient", "unknown_outcome", "retry_later"]] as const) {
      const store = new ScriptedStore();
      const adapter = new FakeProvisioningAdapter(ACC);
      adapter.failNext("createMessagingService", { kind });
      const result = await runProvisioning(base(store, adapter, { stopAfterService: true }));
      expect(result.outcome, kind).toBe(outcome);
      expect(store.finishes.map((f) => f.outcome.status), kind).toEqual([status]);
      expect(adapter.count("createMessagingService"), kind).toBe(1);
    }
  });

  it("a created resource whose record cannot be written is reported plainly and never created again", async () => {
    const store = new ScriptedStore();
    store.finishError = sc("08006");
    const adapter = new FakeProvisioningAdapter(ACC);
    const result = await runProvisioning(base(store, adapter, { stopAfterService: true }));
    expect(result.outcome).toBe("record_failed");
    expect(adapter.services.size).toBe(1);
    expect(adapter.count("createMessagingService")).toBe(1);
  });

  it("reconcile: an open attempt finds its resource by lookup and adopts it without creating", async () => {
    const store = new ScriptedStore();
    store.ctx.operations = [{ id: "op-messaging_service", kind: "messaging_service", attempt: 1, status: "unknown_outcome", provider_sid: null, fee_bearing: false, age_seconds: 5, superseded: false, resource_status: null, resource_brand: null, resource_parent: null }];
    store.beginQueue.messaging_service = [{ action: "reconcile", operation_id: "op-messaging_service", provider_sid: null, status: "unknown_outcome", fee_bearing: false, age_seconds: 5 }];
    const adapter = new FakeProvisioningAdapter(ACC);
    const sid = adapter.seedService(`df:test:${STUDIO}:ms:1`, { inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
    const result = await runProvisioning(base(store, adapter, { stopAfterService: true }));
    expect(result.outcome).toBe("service_ready");
    expect(adapter.count("createMessagingService")).toBe(0);
    expect(store.finishes[0].outcome).toMatchObject({ status: "succeeded", providerSid: sid });
  });

  it("reconcile of a FREE resource that cannot be found: wait out the quiet period, then close the attempt and begin a fresh one", async () => {
    const young = new ScriptedStore();
    young.ctx.operations = [{ id: "op-messaging_service", kind: "messaging_service", attempt: 1, status: "unknown_outcome", provider_sid: null, fee_bearing: false, age_seconds: 5, superseded: false, resource_status: null, resource_brand: null, resource_parent: null }];
    young.beginQueue.messaging_service = [{ action: "reconcile", operation_id: "op-messaging_service", provider_sid: null, status: "unknown_outcome", fee_bearing: false, age_seconds: 5 }];
    const a1 = new FakeProvisioningAdapter(ACC);
    expect((await runProvisioning(base(young, a1, { stopAfterService: true }))).detail).toContain("reconcile_wait");
    expect(a1.count("createMessagingService")).toBe(0);

    const old = new ScriptedStore();
    old.ctx.operations = young.ctx.operations;
    old.beginQueue.messaging_service = [
      { action: "reconcile", operation_id: "op-messaging_service", provider_sid: null, status: "unknown_outcome", fee_bearing: false, age_seconds: 600 },
      { action: "execute", operation_id: "op-2", attempt: 2, fee_kinds: [], account_sid: ACC },
    ];
    const a2 = new FakeProvisioningAdapter(ACC);
    const result = await runProvisioning(base(old, a2, { stopAfterService: true }));
    expect(result.outcome).toBe("service_ready");
    expect(old.finishes.map((f) => `${f.id}:${f.outcome.status}:${f.outcome.errorCode ?? ""}`)).toEqual(["op-messaging_service:failed:reconciled_absent", "op-2:succeeded:"]);
    expect(a2.count("createMessagingService")).toBe(1);
  });

  describe("campaign", () => {
    const serviceOp = (sid: string) => ({ id: "op-ms", kind: "messaging_service" as const, attempt: 1, status: "succeeded" as const, provider_sid: sid, fee_bearing: false, age_seconds: 9, superseded: false, resource_status: "ready" as const, resource_brand: null, resource_parent: null });
    const withService = () => {
      const adapter = new FakeProvisioningAdapter(ACC);
      const sid = adapter.seedService(`df:test:${STUDIO}:ms:1`, { inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
      const store = new ScriptedStore();
      store.ctx.operations = [serviceOp(sid)];
      store.beginQueue.messaging_service = [{ action: "skip", operation_id: "op-ms", provider_sid: sid, status: "succeeded" }];
      store.observeResults = [{ status: "ready", code: null, state: "service_setup" }];
      return { adapter, store, sid };
    };

    it("without the admin's fee confirmation nothing is begun, reserved or called", async () => {
      const { adapter, store } = withService();
      const result = await runProvisioning(base(store, adapter, { confirmFee: false }));
      expect(result.outcome).toBe("waiting_fee_confirmation");
      expect(store.begins.filter((b) => b.kind === "campaign")).toHaveLength(0);
      expect(adapter.count("createCampaign")).toBe(0);
    });

    it("a package that fails review is never submitted and reserves nothing", async () => {
      const { adapter, store } = withService();
      store.inputs = { studio_name: "Harbor Dance", studio_public_name: null, studio_slug: "" };
      const result = await runProvisioning(base(store, adapter));
      expect(result.outcome).toBe("package_invalid");
      expect(result.detail).toContain("studio_slug");
      expect(store.begins.filter((b) => b.kind === "campaign")).toHaveLength(0);
    });

    it("refuses without an approved brand, without a verified path, and when another location already holds the campaign", async () => {
      const a = withService();
      a.store.ctx.brand_sid = null;
      expect((await runProvisioning(base(a.store, a.adapter))).outcome).toBe("prerequisite_missing");
      const b = withService();
      b.store.ctx.requirements = { ...b.store.ctx.requirements, use_case: null, path: "low_volume_unverified", blocker: "tier_ineligible" };
      expect((await runProvisioning(base(b.store, b.adapter))).outcome).toBe("tier_ineligible");
      const c = withService();
      c.store.ctx.entity_live_elsewhere = ["campaign"];
      expect((await runProvisioning(base(c.store, c.adapter))).outcome).toBe("entity_resource_exists");
      for (const x of [a, b, c]) expect(x.adapter.count("createCampaign")).toBe(0);
    });

    it("every database refusal maps to its own outcome and nothing is created", async () => {
      const table: [string, string][] = [["TW004", "spend_blocked"], ["TW007", "insufficient_credit"], ["TW008", "tier_unpriced"], ["TW020", "tier_ineligible"], ["TW033", "recurring_missing"],
        ["TW032", "prerequisite_missing"], ["TW031", "entity_resource_exists"], ["TW005", "needs_subaccount"], ["55P03", "lease_lost"], ["TW030", "not_runnable"], ["XX000", "exception"]];
      for (const [code, outcome] of table) {
        const { adapter, store } = withService();
        store.beginQueue.campaign = [sc(code)];
        const result = await runProvisioning(base(store, adapter));
        expect(result.outcome, code).toBe(outcome);
        expect(adapter.count("createCampaign"), code).toBe(0);
      }
    });

    it("a fee resource that exists at the provider but is not in the ledger is never paid for: nothing is begun, a human decides", async () => {
      const { adapter, store, sid } = withService();
      const unknownCampaign = `QE${"9".repeat(32)}`;
      adapter.campaigns.set(unknownCampaign, { sid: unknownCampaign, account_sid: ACC, messaging_service_sid: sid, brand_registration_sid: BRAND, us_app_to_person_usecase: "MIXED", campaign_status: "IN_PROGRESS", mock: false, errors: "", input: {} as never });
      const result = await runProvisioning(base(store, adapter));
      expect(result.outcome).toBe("exception");
      expect(result.detail).toContain("exists_unrecorded");
      expect(store.begins.filter((b) => b.kind === "campaign")).toHaveLength(0);
      expect(adapter.count("createCampaign")).toBe(0);
    });

    it("a rejected earlier campaign (known to the ledger) is not an 'unrecorded' one", async () => {
      const { adapter, store, sid } = withService();
      const old = `QE${"8".repeat(32)}`;
      adapter.campaigns.set(old, { sid: old, account_sid: ACC, messaging_service_sid: sid, brand_registration_sid: BRAND, us_app_to_person_usecase: "MIXED", campaign_status: "FAILED", mock: false, errors: "x", input: {} as never });
      store.ctx.operations.push({ id: "op-c1", kind: "campaign", attempt: 1, status: "succeeded", provider_sid: old, fee_bearing: true, age_seconds: 99, superseded: true, resource_status: "failed", resource_brand: BRAND, resource_parent: sid });
      adapter.removeCampaign(old);
      const result = await runProvisioning(base(store, adapter));
      expect(result.outcome).toBe("campaign_submitted");
      expect(adapter.count("createCampaign")).toBe(1);
    });

    it("the submission is recorded as succeeded, then judged by the provider read: pending is not approval", async () => {
      const { adapter, store } = withService();
      const result = await runProvisioning(base(store, adapter));
      expect(result.outcome).toBe("campaign_submitted");
      expect(store.finishes.at(-1)?.outcome.status).toBe("succeeded");
      expect(adapter.calls.at(-1)?.method).toBe("getCampaign");
      const request = adapter.calls.find((c) => c.method === "createCampaign")?.input as { useCase: string; brandSid: string; hasEmbeddedLinks: boolean };
      expect(request).toMatchObject({ useCase: "MIXED", brandSid: BRAND, hasEmbeddedLinks: false });
    });

    it("a lost response on the campaign create is an UNKNOWN outcome, recorded and reported; the campaign is not created again in the same run", async () => {
      const { adapter, store } = withService();
      adapter.failNext("createCampaign", { kind: "transient", lostResponse: true });
      const result = await runProvisioning(base(store, adapter));
      expect(result.outcome).toBe("retry_later");
      expect(store.finishes.at(-1)?.outcome).toMatchObject({ status: "unknown_outcome", errorCode: "unclear_outcome" });
      expect(adapter.count("createCampaign")).toBe(1);
      expect(adapter.campaigns.size).toBe(1);
    });

    it("reconcile of a FEE operation: one match is adopted; none found waits for an admin and NEVER creates; two matches stop", async () => {
      const op = { id: "op-c", kind: "campaign" as const, attempt: 1, status: "unknown_outcome" as const, provider_sid: null, fee_bearing: true, age_seconds: 400, superseded: false, resource_status: null, resource_brand: null, resource_parent: null };
      const reconcile: BeginResult = { action: "reconcile", operation_id: "op-c", provider_sid: null, status: "unknown_outcome", fee_bearing: true, age_seconds: 400 };
      // none found
      const none = withService();
      none.store.ctx.operations.push(op);
      none.store.beginQueue.campaign = [reconcile];
      const noneResult = await runProvisioning(base(none.store, none.adapter));
      expect(noneResult.outcome).toBe("unknown_outcome");
      expect(none.adapter.count("createCampaign")).toBe(0);
      expect(none.store.transitions).toContain("exception:prov_unknown_fee");
      // one found
      const one = withService();
      one.store.ctx.operations.push(op);
      one.store.beginQueue.campaign = [reconcile];
      const qe = `QE${"7".repeat(32)}`;
      one.adapter.campaigns.set(qe, { sid: qe, account_sid: ACC, messaging_service_sid: one.sid, brand_registration_sid: BRAND, us_app_to_person_usecase: "MIXED", campaign_status: "IN_PROGRESS", mock: false, errors: "", input: {} as never });
      const oneResult = await runProvisioning(base(one.store, one.adapter));
      expect(oneResult.outcome).toBe("campaign_pending");
      expect(one.adapter.count("createCampaign")).toBe(0);
      expect(one.store.finishes.at(-1)?.outcome).toMatchObject({ status: "succeeded", providerSid: qe });
      // two found
      const two = withService();
      two.store.ctx.operations.push(op);
      two.store.beginQueue.campaign = [reconcile];
      for (const q of ["6", "5"]) two.adapter.campaigns.set(`QE${q.repeat(32)}`, { sid: `QE${q.repeat(32)}`, account_sid: ACC, messaging_service_sid: two.sid, brand_registration_sid: BRAND, us_app_to_person_usecase: "MIXED", campaign_status: "IN_PROGRESS", mock: false, errors: "", input: {} as never });
      const twoResult = await runProvisioning(base(two.store, two.adapter));
      expect(twoResult.outcome).toBe("exception");
      expect(two.adapter.count("createCampaign")).toBe(0);
    });

    it("a definite provider refusal of the campaign releases the attempt (failed) and goes to a human; resubmission needs a new authorization", async () => {
      const { adapter, store } = withService();
      adapter.failNext("createCampaign", { kind: "validation", code: "21715" });
      const result = await runProvisioning(base(store, adapter));
      expect(result.outcome).toBe("exception");
      expect(store.finishes.at(-1)?.outcome).toMatchObject({ status: "failed", errorCode: "api" });
      expect(store.transitions).toContain("exception:prov_refused");
    });

    it("provider verdicts map to outcomes: mismatch -> exception, failed -> rejected, verified -> verified", async () => {
      for (const [status, expected] of [["mismatch", "exception"], ["failed", "campaign_rejected"], ["verified", "campaign_verified"]] as const) {
        const { adapter, store } = withService();
        store.observeResults = [{ status: "ready", code: null, state: "service_setup" }, { status, code: status === "mismatch" ? "brand_mismatch" : null, state: "campaign_pending" }];
        const result = await runProvisioning(base(store, adapter));
        expect(result.outcome, status).toBe(expected);
      }
    });
  });

  it("two runners: the loser of the lease does nothing", async () => {
    const store = new ScriptedStore();
    store.claimError = sc("55P03");
    const adapter = new FakeProvisioningAdapter(ACC);
    const result = await runProvisioning(base(store, adapter));
    expect(result.outcome).toBe("lease_busy");
    expect(adapter.calls).toHaveLength(0);
    store.claimError = sc("TW001");
    expect((await runProvisioning(base(store, adapter))).outcome).toBe("runner_closed");
    store.claimError = sc("TW030");
    expect((await runProvisioning(base(store, adapter))).outcome).toBe("not_runnable");
  });

  it("refresh is read-only: it never begins, creates or pays for anything", async () => {
    const store = new ScriptedStore();
    const adapter = new FakeProvisioningAdapter(ACC);
    const sid = adapter.seedService(`df:test:${STUDIO}:ms:1`, { inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
    store.ctx.operations = [{ id: "op-ms", kind: "messaging_service", attempt: 1, status: "succeeded", provider_sid: sid, fee_bearing: false, age_seconds: 9, superseded: false, resource_status: "ready", resource_brand: null, resource_parent: null }];
    const result = await refreshProvisioning({ store, adapter, studioId: STUDIO, actorId: "admin-1", envName: "test", inboundUrl: INBOUND, origin: "https://www.idanceflow.com", source: "fake" });
    expect(result.outcome).toBe("service_ready");
    expect(store.begins).toHaveLength(0);
    expect(adapter.calls.map((c) => c.method)).toEqual(["getMessagingService"]);
    store.ctx.operations = [];
    expect((await refreshProvisioning({ store, adapter, studioId: STUDIO, actorId: "admin-1", envName: "test", inboundUrl: INBOUND, origin: "https://www.idanceflow.com", source: "fake" })).outcome).toBe("nothing_to_check");
  });
});

describe("token rotation for a provisioning adapter", () => {
  class Secret {
    constructor(private readonly v: string) {}
    reveal() { return this.v; }
    toString() { return "[redacted]"; }
  }
  function tokens(first: string, second: string | null) {
    let current = first;
    return {
      refreshes: 0,
      async tokenFor() { return new Secret(current) as never; },
      async refresh() {
        this.refreshes += 1;
        if (second === null || second === current) return { secret: new Secret(current) as never, changed: false };
        current = second;
        return { secret: new Secret(current) as never, changed: true };
      },
    };
  }
  const build = (log: string[]) => (accountSid: string, token: { reveal(): string }) => {
    const adapter = new FakeProvisioningAdapter(accountSid);
    const original = adapter.createMessagingService.bind(adapter);
    adapter.createMessagingService = async (input) => {
      log.push(`create:${token.reveal()}`);
      if (token.reveal() === "old") throw new IsvApiError("account" satisfies IsvErrorKind, 401, "20003", "authenticate");
      return original(input);
    };
    return adapter;
  };

  it("a 401 after a rotation re-reads the token ONCE and repeats the request with the new token", async () => {
    const log: string[] = [];
    const t = tokens("old", "new");
    const adapter = await rotatingSubaccountAdapter(ACC, t, build(log));
    const sid = await adapter.createMessagingService({ friendlyName: "x", inboundRequestUrl: INBOUND });
    expect(sid).toMatch(/^MG/);
    expect(log).toEqual(["create:old", "create:new"]);
    expect(t.refreshes).toBe(1);
    expect(adapter.accountSid).toBe(ACC);
  });

  it("an unchanged token after the 401 stops with the credential error (no loop, no fallback)", async () => {
    const log: string[] = [];
    const t = tokens("old", null);
    const adapter = await rotatingSubaccountAdapter(ACC, t, build(log));
    await expect(adapter.createMessagingService({ friendlyName: "x", inboundRequestUrl: INBOUND })).rejects.toMatchObject({ kind: "account", httpStatus: 401 });
    expect(log).toEqual(["create:old"]);
    expect(t.refreshes).toBe(1);
  });
});
