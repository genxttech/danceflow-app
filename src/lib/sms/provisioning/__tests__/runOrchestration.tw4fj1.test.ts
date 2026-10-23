import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: { code: "XX000" } }) }) }));

import { buildNumberRuntime, buildProvisioningRuntime, type NumberRuntime, type ProvisioningRuntime } from "@/lib/sms/twilioIsv/factory";
import { FakeNumberAdapter } from "@/lib/sms/twilioIsv/fakeNumbers";
import { FakeProvisioningAdapter } from "@/lib/sms/twilioIsv/fakeProvisioning";
import type { NumBeginArgs, NumBeginResult, NumContext, NumFinishOutcome, NumOperationView, NumberStore, OfferRecorded } from "@/lib/sms/twilioIsv/numberStore";
import type { BeginArgs, BeginResult, FinishOutcome, ProvOperationView, ProvisionContext, ProvisionStore } from "@/lib/sms/twilioIsv/provisionStore";
import { RunnerStoreError } from "@/lib/sms/twilioIsv/store";
import { numberCommand, provisioningCommand, type RunDeps } from "../runOrchestration";

/**
 * TW-4F J1: the orchestration DECISIONS: what the admin actions refuse before anything is built or called, that the account comes from the database, that
 * fee-bearing intents need their confirmation on the run, and that a replay never repeats a provider operation. The ledger here is a small stateful stand-in;
 * the database semantics are pinned on a real schema in src/lib/sms/twilioIsv/__tests__/localStack.tw4fj1.test.ts.
 */

const STUDIO = "a1a1a1a1-0000-4000-8000-00000000000a";
const OTHER_STUDIO = "b1b1b1b1-0000-4000-8000-00000000000b";
const SUB = `AC${"7".repeat(32)}`;
const ADMIN = "admin-1";
const BRAND = `BN${"b".repeat(32)}`;
const E164 = "+12025550140";
const INBOUND = "https://app.example.test/api/sms/twilio/inbound";

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

type Entity = { legal_entity_id: string | null; account_status: string | null; account_sid: string | null };
const entitiesFor = (map: Record<string, Entity>, calls: string[]) => ({
  entityForStudio: async (studioId: string, actor: string) => {
    calls.push(`${studioId}:${actor}`);
    return map[studioId] ?? { legal_entity_id: null, account_status: null, account_sid: null };
  },
});

/** A stateful provisioning ledger: one live operation per kind, a succeeded one is skipped on replay. */
class LedgerProvisionStore implements ProvisionStore {
  ops: (ProvOperationView & { kind: "messaging_service" | "campaign" })[] = [];
  state = "service_setup";
  campaignBlocked: string | null = null;
  claims = 0;
  async claim() { this.claims += 1; return { onboarding_id: "ob-1", studio_id: STUDIO, state: this.state, submission_seq: 1 }; }
  async release() {}
  async getAccount() { return { legalEntityId: "le-1", accountSid: SUB, status: "active" }; }
  async getInputs() { return { studio_name: "Harbor Dance", studio_public_name: null, studio_slug: "harbor-dance" } as never; }
  async getFeeKinds(): Promise<never> { throw new Error("not used"); }
  async context(): Promise<ProvisionContext> {
    return {
      state: this.state, submission_seq: 1, studio_id: STUDIO, legal_entity_id: "le-1", brand_sid: BRAND,
      requirements: { path: "standard", use_case: "MIXED", pilot: false, blocker: null, components: [] }, operations: this.ops.map((o) => ({ ...o })), entity_live_elsewhere: [],
    };
  }
  async begin(_o: string, _l: string, args: BeginArgs): Promise<BeginResult> {
    const live = this.ops.find((o) => o.kind === args.kind && o.status === "succeeded");
    if (live) return { action: "skip", operation_id: live.id, provider_sid: String(live.provider_sid), status: "succeeded" };
    if (args.kind === "campaign" && this.campaignBlocked) throw new RunnerStoreError(this.campaignBlocked);
    const id = `op-${args.kind}-${this.ops.length + 1}`;
    this.ops.push({ id, kind: args.kind, attempt: 1, status: "in_flight", provider_sid: null, fee_bearing: args.kind === "campaign", age_seconds: 0, superseded: false, resource_status: null, resource_brand: null, resource_parent: null });
    return { action: "execute", operation_id: id, attempt: 1, fee_kinds: args.kind === "campaign" ? ["campaign_vetting"] : [], account_sid: SUB };
  }
  async finish(_o: string, _l: string, id: string, outcome: FinishOutcome) {
    const op = this.ops.find((o) => o.id === id)!;
    op.status = outcome.status;
    op.provider_sid = outcome.providerSid ?? null;
    return { state: this.state };
  }
  async observe(_o: string, _l: string, id: string) {
    const op = this.ops.find((o) => o.id === id)!;
    op.resource_status = op.kind === "messaging_service" ? "ready" : "pending";
    if (op.kind === "campaign") this.state = "campaign_pending";
    return { status: op.resource_status, code: null, state: this.state };
  }
  async transition(_o: string, _l: string, to: string) { this.state = to; return to; }
}

/** A stateful number ledger with an owner selection the test controls. */
class LedgerNumberStore implements NumberStore {
  ops: NumOperationView[] = [];
  selection: string | null = E164;
  blocker: NumContext["requirements"]["blocker"] = null;
  offers: unknown[][] = [];
  async claim() { return { onboarding_id: "ob-1", studio_id: STUDIO, state: "campaign_pending", submission_seq: 1 }; }
  async claimRecon(): Promise<never> { throw new Error("not used"); }
  async reconTargets() { return []; }
  async reconMark() {}
  async escalateOrphans() { return { outbox: true, raised: 0 }; }
  async release() {}
  async getAccount() { return { legalEntityId: "le-1", accountSid: SUB, status: "active" }; }
  async context(): Promise<NumContext> {
    return {
      state: "campaign_pending", submission_seq: 1, studio_id: STUDIO, messaging_service_sid: `MG${"1".repeat(32)}`, campaign_sid: `QE${"1".repeat(32)}`,
      requirements: { blocker: this.selection ? this.blocker : "no_selection", funding_mode: "pilot", price_cents: 200, selection_id: this.selection ? "sel-1" : null, selection_e164: this.selection, ceiling_remaining_cents: 15000 },
      operations: this.ops.map((o) => ({ ...o })), known_numbers: this.ops.filter((o) => o.provider_sid && o.kind === "number_purchase").map((o) => String(o.provider_sid)),
    };
  }
  async begin(_o: string, _l: string, args: NumBeginArgs): Promise<NumBeginResult> {
    const live = this.ops.find((o) => o.kind === args.kind && o.status === "succeeded");
    if (live) return { action: "skip", operation_id: live.id, provider_sid: String(live.provider_sid), status: "succeeded" };
    const id = `op-${args.kind}-${this.ops.length + 1}`;
    this.ops.push({ id, kind: args.kind, attempt: 1, status: "in_flight", provider_sid: null, e164: String(args.params.e164 ?? ""), fee_bearing: args.kind === "number_purchase", age_seconds: 0, superseded: false, resource_status: null });
    return { action: "execute", operation_id: id, attempt: 1, fee_kinds: args.kind === "number_purchase" ? ["number"] : [], account_sid: SUB, e164: String(args.params.e164 ?? "") };
  }
  async finish(_o: string, _l: string, id: string, outcome: NumFinishOutcome) {
    const op = this.ops.find((o) => o.id === id)!;
    op.status = outcome.status;
    op.provider_sid = outcome.providerSid ?? null;
    return { state: "campaign_pending" };
  }
  async observe(_o: string, _l: string, id: string) {
    const op = this.ops.find((o) => o.id === id)!;
    op.resource_status = op.kind === "number_purchase" ? "owned" : "attached";
    return { status: op.resource_status, code: null, state: op.kind === "number_attach" ? "ready_for_activation" : "campaign_pending" };
  }
  async transition(_o: string, _l: string, to: string) { return to; }
  async inventoryObserve(_o: string, _l: string, numbers: { sid: string }[]) {
    const known = new Set(this.ops.map((o) => o.provider_sid));
    return { listed: numbers.length, unknown: numbers.filter((n) => !known.has(n.sid)).length, missing: 0, mismatch: 0, duplicate: 0 };
  }
  async identityObserve(): Promise<never> { throw new Error("not used"); }
  async historyObserve(): Promise<never> { throw new Error("not used"); }
  async recordOffer(_s: string, _a: string, _acc: string, _search: Record<string, unknown>, candidates: unknown[]): Promise<OfferRecorded> {
    this.offers.push(candidates);
    return { offer_id: "offer-1", count: candidates.length, expires_at: "2099-01-01T00:00:00Z", candidates: candidates.map((c) => ({ e164: (c as { e164: string }).e164, locality: null, region: null, mms_capable: false })) };
  }
}

let fetchCalls = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("network must not be reached"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function fakeDeps(over: { entity?: Entity } = {}) {
  const provAdapter = new FakeProvisioningAdapter(SUB);
  const numAdapter = new FakeNumberAdapter(SUB);
  numAdapter.seedAvailable(E164).seedAvailable("+12025550141");
  const provStore = new LedgerProvisionStore();
  const numStore = new LedgerNumberStore();
  const lookups: string[] = [];
  const adapterRequests: string[] = [];
  const entities = entitiesFor({ [STUDIO]: over.entity ?? { legal_entity_id: "le-1", account_status: "active", account_sid: SUB } }, lookups);
  const provisioning: ProvisioningRuntime = { ok: true, mode: "fake", envName: "test", entities: entities as never, store: provStore as never, inboundUrl: INBOUND, origin: "https://app.example.test", adapterFor: async (sid) => { adapterRequests.push(sid); return provAdapter; } };
  const numbers: NumberRuntime = { ok: true, mode: "fake", envName: "test", entities: entities as never, store: numStore as never, adapterFor: async (sid) => { adapterRequests.push(sid); numAdapter.registerService(`MG${"1".repeat(32)}`); return numAdapter; } };
  let built = 0;
  const deps: RunDeps = { provisioning: () => { built += 1; return provisioning; }, numbers: () => { built += 1; return numbers; } };
  return { deps, provAdapter, numAdapter, provStore, numStore, lookups, adapterRequests, built: () => built };
}

describe("refusals before anything is built or called", () => {
  it("a missing or forged studio id is refused before a runtime is built", async () => {
    const f = fakeDeps();
    for (const studioId of ["", "not-a-uuid", `${STUDIO}' or 1=1`, "../../etc"]) {
      expect((await provisioningCommand(f.deps, ADMIN, form({ studioId, intent: "service" }))).ok).toBe(false);
      expect((await numberCommand(f.deps, ADMIN, form({ studioId, intent: "offer" }))).ok).toBe(false);
    }
    expect(f.built()).toBe(0);
  });

  it("an unknown intent is refused before a runtime is built", async () => {
    const f = fakeDeps();
    expect((await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "delete" }))).message).toMatch(/Unknown provisioning action/);
    expect((await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "select" }))).message).toMatch(/Unknown number action/);
    expect(f.built()).toBe(0);
  });

  it("the fee-bearing campaign needs the fee box AND the typed phrase on this run", async () => {
    const f = fakeDeps();
    const attempts: Record<string, string>[] = [{}, { confirmFee: "on" }, { confirmPhrase: "SUBMIT" }, { confirmFee: "on", confirmPhrase: "submit" }, { confirmFee: "yes", confirmPhrase: "SUBMIT" }];
    for (const values of attempts) {
      const result = await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "campaign", ...values }));
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Nothing was run/);
    }
    expect(f.built()).toBe(0);
    expect(f.provAdapter.calls).toHaveLength(0);
  });

  it("the purchase needs the fee box AND a well-formed typed number; an area code must be valid", async () => {
    const f = fakeDeps();
    const attempts: Record<string, string>[] = [{}, { confirmFee: "on" }, { approvedE164: E164 }, { confirmFee: "on", approvedE164: "2025550140" }, { confirmFee: "on", approvedE164: "+10255501400" }];
    for (const values of attempts) {
      expect((await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "acquire", ...values }))).ok).toBe(false);
    }
    expect((await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "offer", areaCode: "012" }))).ok).toBe(false);
    expect(f.built()).toBe(0);
    expect(f.numAdapter.calls).toHaveLength(0);
  });

  it("with the real-call switches off and no fake, every action refuses with the gate's reason and nothing reaches the network", async () => {
    const offEnvs = [
      { NODE_ENV: "development" },
      { NODE_ENV: "development", TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: "https://shared-dev.supabase.co" }, // fake never against a shared database
      { VERCEL_ENV: "preview", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on" },
      { VERCEL_ENV: "production", NODE_ENV: "production" },
      { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" }, // registration on, provisioning off
      { VERCEL_ENV: "production", NODE_ENV: "development", TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on" }, // pulled prod variables, dev build
    ];
    for (const env of offEnvs) {
      const deps: RunDeps = { provisioning: () => buildProvisioningRuntime(env), numbers: () => buildNumberRuntime(env) };
      for (const intent of ["service", "refresh"]) {
        const result = await provisioningCommand(deps, ADMIN, form({ studioId: STUDIO, intent }));
        expect(result.ok, JSON.stringify(env)).toBe(false);
        expect(result.message).toMatch(/(disabled outside|switched off).*Nothing was run\.$/);
      }
      expect((await provisioningCommand(deps, ADMIN, form({ studioId: STUDIO, intent: "campaign", confirmFee: "on", confirmPhrase: "SUBMIT" }))).message).toMatch(/Nothing was run/);
      for (const intent of ["offer", "refresh"]) expect((await numberCommand(deps, ADMIN, form({ studioId: STUDIO, intent }))).message).toMatch(/(disabled outside|switched off).*Nothing was run\.$/);
      expect((await numberCommand(deps, ADMIN, form({ studioId: STUDIO, intent: "acquire", confirmFee: "on", approvedE164: E164 }))).message).toMatch(/Nothing was run/);
    }
    // provisioning on but number purchases off: the number actions still refuse, naming the number switch
    const provOnly = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on" };
    expect((await numberCommand({ provisioning: () => buildProvisioningRuntime(provOnly), numbers: () => buildNumberRuntime(provOnly) }, ADMIN, form({ studioId: STUDIO, intent: "offer" }))).message).toMatch(/number purchase calls are switched off/);
    expect(fetchCalls).toBe(0);
  });

  it("a studio without an active subaccount is refused after the database lookup and before any adapter exists", async () => {
    for (const entity of [{ legal_entity_id: null, account_status: null, account_sid: null }, { legal_entity_id: "le-1", account_status: "suspended", account_sid: SUB }, { legal_entity_id: "le-1", account_status: "creating", account_sid: null }]) {
      const f = fakeDeps({ entity });
      const result = await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "service" }));
      expect(result.outcome).toBe("needs_subaccount");
      expect(f.adapterRequests).toHaveLength(0);
    }
  });

  it("the account comes from the database for THAT studio: a forged studio gets its own (absent) account, never another studio's", async () => {
    const f = fakeDeps();
    const result = await provisioningCommand(f.deps, ADMIN, form({ studioId: OTHER_STUDIO, intent: "service", accountSid: SUB }));
    expect(result.outcome).toBe("needs_subaccount");
    expect(f.lookups).toEqual([`${OTHER_STUDIO}:${ADMIN}`]);
    expect(f.adapterRequests).toHaveLength(0);
    expect(f.provAdapter.calls).toHaveLength(0);
  });
});

describe("fake adapter: the happy path and replays", () => {
  it("service then campaign: the Messaging Service is created once, the campaign once; a replay of either repeats nothing", async () => {
    const f = fakeDeps();
    const audit: Record<string, unknown>[] = [];
    const service = await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "service" }), (e) => audit.push(e));
    expect(service).toMatchObject({ ok: true, outcome: "service_ready" });
    expect(f.adapterRequests).toEqual([SUB]);
    expect(f.provAdapter.count("createMessagingService")).toBe(1);
    expect(f.provAdapter.count("createCampaign")).toBe(0);
    expect(audit).toHaveLength(0); // the free step leaves no fee trail
    expect((await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "service" }))).outcome).toBe("service_ready");
    expect(f.provAdapter.count("createMessagingService")).toBe(1);

    const campaign = await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "campaign", confirmFee: "on", confirmPhrase: " SUBMIT " }), (e) => audit.push(e));
    expect(campaign).toMatchObject({ ok: true, outcome: "campaign_submitted" });
    expect(f.provAdapter.count("createCampaign")).toBe(1);
    expect(audit).toEqual([expect.objectContaining({ event: "sms_provisioning_campaign_run", studioId: STUDIO, actorId: ADMIN, outcome: "campaign_submitted" })]);
    // the same confirmed form posted again (a double click, a replayed request): the ledger skips the succeeded campaign, nothing is created or charged again
    const replay = await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "campaign", confirmFee: "on", confirmPhrase: "SUBMIT" }));
    expect(replay.outcome).toBe("campaign_pending");
    expect(f.provAdapter.count("createCampaign")).toBe(1);
    expect(f.provAdapter.count("createMessagingService")).toBe(1);
    // a status check is GET-only
    const before = f.provAdapter.calls.length;
    expect((await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "refresh" }))).outcome).toBe("campaign_pending");
    expect(f.provAdapter.calls.slice(before).every((c) => c.method.startsWith("get"))).toBe(true);
  });

  it("a fee gate refusal from the database is reported plainly and calls nothing", async () => {
    const f = fakeDeps();
    await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "service" }));
    f.provStore.campaignBlocked = "TW007";
    const result = await provisioningCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "campaign", confirmFee: "on", confirmPhrase: "SUBMIT" }));
    expect(result).toMatchObject({ ok: false, outcome: "insufficient_credit" });
    expect(result.message).toMatch(/cumulative ceiling/);
    expect(f.provAdapter.count("createCampaign")).toBe(0);
  });

  it("number offers are produced from a free search and recorded for the owner; nothing is bought", async () => {
    const f = fakeDeps();
    const result = await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "offer", areaCode: "202" }));
    expect(result).toMatchObject({ ok: true, outcome: "offered" });
    expect(result.message).toContain(E164);
    expect(f.numStore.offers).toHaveLength(1);
    expect(f.numAdapter.count("purchaseNumber")).toBe(0);
  });

  it("acquisition refuses when the owner has not approved a number, even with the fee confirmed", async () => {
    const f = fakeDeps();
    f.numStore.selection = null;
    const result = await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "acquire", confirmFee: "on", approvedE164: E164 }));
    expect(result).toMatchObject({ ok: false, outcome: "no_selection" });
    expect(f.numAdapter.count("purchaseNumber")).toBe(0);
    expect(f.numStore.ops).toHaveLength(0);
  });

  it("acquisition refuses when the typed number is not the owner's approved number (nothing reserved, recorded or bought)", async () => {
    const f = fakeDeps();
    const result = await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "acquire", confirmFee: "on", approvedE164: "+12025550141" }));
    expect(result).toMatchObject({ ok: false, outcome: "selection_mismatch" });
    expect(f.numAdapter.count("purchaseNumber")).toBe(0);
    expect(f.numAdapter.count("listIncomingNumbers")).toBe(0);
    expect(f.numStore.ops).toHaveLength(0);
  });

  it("resuming a purchase already in the ledger needs the typed number to be THAT purchase's number (review P2)", async () => {
    const f = fakeDeps();
    f.numStore.ops.push({ id: "op-live", kind: "number_purchase", attempt: 1, status: "unknown_outcome", provider_sid: null, e164: E164, fee_bearing: true, age_seconds: 600, superseded: false, resource_status: null });
    f.numStore.selection = "+12025550141"; // even a selection that matches the typed number does not override the purchase in flight
    const result = await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "acquire", confirmFee: "on", approvedE164: "+12025550141" }));
    expect(result).toMatchObject({ ok: false, outcome: "selection_mismatch" });
    expect(f.numAdapter.calls).toHaveLength(0);
    expect(f.numStore.ops.map((o) => o.status)).toEqual(["unknown_outcome"]);
  });

  it("a database blocker (pilot ceiling) wins over a matching typed number", async () => {
    const f = fakeDeps();
    f.numStore.blocker = "pilot_ceiling";
    const result = await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "acquire", confirmFee: "on", approvedE164: E164 }));
    expect(result).toMatchObject({ ok: false, outcome: "insufficient_credit" });
    expect(f.numAdapter.count("purchaseNumber")).toBe(0);
  });

  it("the approved number is bought once and attached; a replayed purchase buys nothing again", async () => {
    const f = fakeDeps();
    const audit: Record<string, unknown>[] = [];
    const result = await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "acquire", confirmFee: "on", approvedE164: "+1 (202) 555-0140" }), (e) => audit.push(e));
    expect(result).toMatchObject({ ok: true, outcome: "number_ready" });
    expect(f.numAdapter.count("purchaseNumber")).toBe(1);
    expect(f.numAdapter.calls.find((c) => c.method === "purchaseNumber")?.input).toMatchObject({ e164: E164 });
    expect(audit).toEqual([expect.objectContaining({ event: "sms_number_purchase_run", outcome: "number_ready", typedLast4: "0140" })]);
    expect(JSON.stringify(audit)).not.toContain(E164); // the trail keeps the last four digits only
    const replay = await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "acquire", confirmFee: "on", approvedE164: E164 }));
    expect(replay.outcome).toBe("number_ready");
    expect(f.numAdapter.count("purchaseNumber")).toBe(1);
    expect((await numberCommand(f.deps, ADMIN, form({ studioId: STUDIO, intent: "refresh" }))).outcome).toBe("number_ready");
    expect(f.numAdapter.count("purchaseNumber")).toBe(1);
  });

  it("an unexpected runner error is reported without detail and without a retry", async () => {
    const f = fakeDeps();
    f.provStore.claim = async () => { throw new Error("boom with secret detail"); };
    // a claim error that is not a store error is mapped by the runner; force an adapter-construction failure instead
    const deps: RunDeps = { ...f.deps, provisioning: () => ({ ...(f.deps.provisioning() as Extract<ProvisioningRuntime, { ok: true }>), adapterFor: async () => { throw new Error("boom with secret detail"); } }) };
    const result = await provisioningCommand(deps, ADMIN, form({ studioId: STUDIO, intent: "service" }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/failed unexpectedly/);
    expect(result.message).not.toMatch(/secret/);
  });
});
