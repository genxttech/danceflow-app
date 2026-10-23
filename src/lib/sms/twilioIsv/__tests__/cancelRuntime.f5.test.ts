import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
let rpcState = "authorized";
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let beginReply: Record<string, unknown> = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      // a minimal tw4_rfl_cancel_begin / _finish for the fake-mode end-to-end test; everything else is "not installed"
      if (fn === "tw4_rfl_cancel_begin" && rpcState === "authorized") return (rpcState = "in_flight"), { data: beginReply, error: null };
      if (fn === "tw4_rfl_cancel_finish" && rpcState === "in_flight") return (rpcState = String(args.p_outcome)), { data: { status: rpcState, replayed: false }, error: null };
      return { data: null, error: { code: "42883" } };
    },
  }),
}));

import { asReleaseAdapters, cancelReleaseAvailable, cancelReleaseRuntime, installedCancelTargets, parseCancelTarget, SupabaseCancelTargetSource, type CancelRuntimeOptions } from "../cancelRuntime";
import { buildSubaccountAdaptersFor, fakeProvisioningHub } from "../factory";
import { FakeNumberAdapter } from "../fakeNumbers";
import { FakeProvisioningAdapter } from "../fakeProvisioning";
import { rotatingSubaccountAdapter } from "../rotation";
import type { CancelTargetSource } from "../cancelRunner";

const OP = "e0000001-0000-4000-8000-000000000001";

/** TW-4F F5: when may the panel offer provider release? Every switch must hold; production stays manual in this slice. */

const targets: CancelTargetSource = { target: async () => null };
const LOCAL = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", TW4_ISV_FAKE: "on", TW4_CANCEL_RELEASE: "on" };
const PROD = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on", TW4_CANCEL_RELEASE: "on" };

describe("F5 cancel release runtime", () => {
  it("is off by default; production stays manual (no real adapters are wired by this slice)", () => {
    expect(installedCancelTargets()).not.toBeNull();
    expect(cancelReleaseAvailable({})).toBe(false);
    expect(cancelReleaseAvailable({ ...LOCAL, TW4_CANCEL_RELEASE: undefined })).toBe(false);
    expect(cancelReleaseAvailable(PROD)).toBe(false);
    expect(cancelReleaseRuntime(LOCAL, { targets: null })).toMatchObject({ ok: false, reason: expect.stringContaining("not installed") });
    expect(cancelReleaseRuntime(LOCAL)).toMatchObject({ ok: true, mode: "fake" });
  });

  it("the database target source fails closed: a missing function, a refusal or an unexpected shape is no target", async () => {
    const source = (reply: { data: unknown; error: unknown }) => new SupabaseCancelTargetSource({ rpc: async () => reply });
    expect(await source({ data: null, error: { code: "PGRST202" } }).target(OP, OP)).toBeNull();
    expect(await source({ data: null, error: { code: "42501" } }).target(OP, OP)).toBeNull();
    expect(await source({ data: null, error: null }).target(OP, OP)).toBeNull();
    const good = {
      operation_id: OP, resource_id: OP, operation_status: "authorized", kind: "number", provider_state: "active", provider_sid: `PN${"1".repeat(32)}`, account_sid: `AC${"2".repeat(32)}`,
      messaging_service_sid: null, live_dependents: 0, dual_control: { request_id: OP, resource_id: OP, requested_by: OP, decided_by: OP, status: "consumed" },
    };
    expect(await source({ data: good, error: null }).target(OP, OP)).toMatchObject({ kind: "number", dualControl: { status: "consumed", resourceId: OP } });
    expect(parseCancelTarget({ ...good, kind: "other" })).toBeNull();
    expect(parseCancelTarget({ ...good, provider_state: "cancelled" })).toBeNull();
    expect(parseCancelTarget({ ...good, live_dependents: "0" })).toBeNull();
    expect(parseCancelTarget({ ...good, dual_control: { request_id: OP } })).toBeNull();
    expect(parseCancelTarget([good])).toBeNull();
  });

  it("a number is released through supplied real adapters only where the number gate is on too", async () => {
    // a stand-in for a real number adapter (the real path accepts only provider_read evidence)
    const realLike = Object.defineProperty(new FakeNumberAdapter(`AC${"6".repeat(32)}`), "evidenceSource", { value: "provider_read" });
    const numbersOnly = { numbers: realLike, provisioning: null };
    const noNumberGate = cancelReleaseRuntime({ ...PROD, TW4_NUMBER_REAL_CALLS: undefined }, { targets, realAdaptersFor: async () => numbersOnly });
    expect(noNumberGate.ok).toBe(true);
    // the runner sees no number adapter: a number target is refused before any claim
    const runner = noNumberGate.ok ? noNumberGate.runner : null;
    const deps = (runner as unknown as { deps: { adaptersFor(a: string): Promise<{ numbers: unknown }> } }).deps;
    expect((await deps.adaptersFor("AC")).numbers).toBeNull();
    const withGate = cancelReleaseRuntime(PROD, { targets, realAdaptersFor: async () => numbersOnly });
    const deps2 = (withGate.ok ? withGate.runner : null) as unknown as { deps: { adaptersFor(a: string): Promise<{ numbers: unknown }> } };
    expect((await deps2.deps.adaptersFor("AC")).numbers).not.toBeNull();
  });

  it("needs its own explicit switch, whatever else is configured", () => {
    expect(cancelReleaseRuntime({ ...LOCAL, TW4_CANCEL_RELEASE: undefined }, { targets })).toMatchObject({ ok: false, reason: expect.stringContaining("switched off") });
    expect(cancelReleaseRuntime({ ...LOCAL, TW4_CANCEL_RELEASE: "true" }, { targets }).ok).toBe(false);
  });

  it("uses the local fakes only on a local QA database with TW4_ISV_FAKE=on", () => {
    expect(cancelReleaseRuntime(LOCAL, { targets })).toMatchObject({ ok: true, mode: "fake" });
    expect(cancelReleaseRuntime({ ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }, { targets }).ok).toBe(false);
    expect(cancelReleaseRuntime({ ...LOCAL, TW4_ISV_FAKE: undefined }, { targets }).ok).toBe(false);
  });

  it("never builds a real adapter itself: production is available only with adapters the platform runtime supplies", () => {
    expect(cancelReleaseRuntime(PROD, { targets })).toMatchObject({ ok: false, reason: expect.stringContaining("No provider release adapter") });
    const supplied = vi.fn(async () => ({ numbers: null, provisioning: null }));
    expect(cancelReleaseRuntime(PROD, { targets, realAdaptersFor: supplied })).toMatchObject({ ok: true, mode: "real" });
    expect(supplied).not.toHaveBeenCalled();
    expect(cancelReleaseRuntime({ ...PROD, TW4_PROVISIONING_REAL_CALLS: undefined }, { targets, realAdaptersFor: supplied }).ok).toBe(false);
    expect(cancelReleaseRuntime({ ...PROD, VERCEL_ENV: "preview" }, { targets, realAdaptersFor: supplied }).ok).toBe(false);
  });
});

describe("F5 x J1: the release bridge over the platform runtime's subaccount adapters", () => {
  const ACCOUNT = `AC${"7".repeat(32)}`;

  it("type-checks: J1's buildSubaccountAdaptersFor is accepted as realAdaptersFor as it is", () => {
    const supplied: CancelRuntimeOptions["realAdaptersFor"] = buildSubaccountAdaptersFor({});
    expect(typeof supplied).toBe("function");
  });

  it("keeps adapters that carry the release methods (fakes, and the rotation Proxy, which answers `in` with false) and drops anything else", async () => {
    const fakes = asReleaseAdapters({ numbers: new FakeNumberAdapter(ACCOUNT), provisioning: new FakeProvisioningAdapter(ACCOUNT) });
    expect(fakes.numbers).not.toBeNull();
    expect(fakes.provisioning).not.toBeNull();
    const tokens = { tokenFor: async () => ({ reveal: () => "t" }), refresh: async () => ({ secret: { reveal: () => "t" }, changed: false }) } as never;
    const proxied = await rotatingSubaccountAdapter(ACCOUNT, tokens, () => new FakeNumberAdapter(ACCOUNT));
    expect("releaseNumber" in (proxied as object)).toBe(false);
    expect(asReleaseAdapters({ numbers: proxied, provisioning: null }).numbers).toBe(proxied);
    // provisioning-only shapes, missing evidence source, or nothing at all: fail closed
    expect(asReleaseAdapters({ numbers: { accountSid: ACCOUNT, evidenceSource: "fake", releaseNumber: async () => "released" }, provisioning: { accountSid: ACCOUNT } })).toEqual({ numbers: null, provisioning: null });
    const noSource = Object.assign(new FakeNumberAdapter(ACCOUNT), {});
    Object.defineProperty(noSource, "evidenceSource", { value: "other" });
    expect(asReleaseAdapters({ numbers: noSource, provisioning: undefined }).numbers).toBeNull();
    expect(asReleaseAdapters({ numbers: null, provisioning: 42 })).toEqual({ numbers: null, provisioning: null });
  });

  it("fake mode releases through the platform runtime's process-wide fakes", () => {
    expect(cancelReleaseRuntime(LOCAL, { targets })).toMatchObject({ ok: true, mode: "fake" });
  });
});

describe("F5 hardening (post-merge review P3s)", () => {
  const ACCOUNT = `AC${"8".repeat(32)}`;
  const ACTOR = "e0000009-0000-4000-8000-000000000009";
  const RES = "e000000a-0000-4000-8000-00000000000a";

  it("P3-1: an adapter whose evidenceSource getter throws reads as null, and the runner refuses without claiming", async () => {
    const hostile = new FakeNumberAdapter(ACCOUNT);
    Object.defineProperty(hostile, "evidenceSource", { get() { throw new Error("boom"); } });
    expect(asReleaseAdapters({ numbers: hostile, provisioning: null }).numbers).toBeNull();
    rpcCalls.length = 0;
    const numberTarget: CancelTargetSource = {
      target: async () => ({
        operationId: OP, resourceId: RES, operationStatus: "authorized", kind: "number", providerSid: `PN${"1".repeat(32)}`, accountSid: ACCOUNT, messagingServiceSid: null, liveDependents: 0,
        dualControl: { requestId: OP, resourceId: RES, requestedBy: ACTOR, decidedBy: "e000000b-0000-4000-8000-00000000000b", status: "consumed" },
      }),
    };
    const runtime = cancelReleaseRuntime(PROD, { targets: numberTarget, realAdaptersFor: async () => ({ numbers: hostile, provisioning: null }) });
    expect(runtime.ok).toBe(true);
    const out = runtime.ok ? await runtime.runner.run(OP, ACTOR) : null;
    expect(out).toMatchObject({ result: "precondition_refused" });
    expect(rpcCalls.filter((c) => c.fn === "tw4_rfl_cancel_begin")).toHaveLength(0);
  });

  it("P3-3: the real path accepts only provider_read adapters; fake mode accepts only fakes", async () => {
    const fake = new FakeNumberAdapter(ACCOUNT);
    expect(asReleaseAdapters({ numbers: fake, provisioning: null }, ["provider_read"]).numbers).toBeNull();
    expect(asReleaseAdapters({ numbers: fake, provisioning: null }, ["fake"]).numbers).toBe(fake);
    const pretendReal = Object.assign(new FakeNumberAdapter(ACCOUNT), {});
    Object.defineProperty(pretendReal, "evidenceSource", { value: "provider_read" });
    expect(asReleaseAdapters({ numbers: pretendReal, provisioning: null }, ["fake"]).numbers).toBeNull();
    // through the runtime: a fake handed to the REAL path is dropped before the runner sees it
    const runtime = cancelReleaseRuntime(PROD, { targets, realAdaptersFor: async () => ({ numbers: fake, provisioning: new FakeProvisioningAdapter(ACCOUNT) }) });
    const deps = (runtime.ok ? runtime.runner : null) as unknown as { deps: { adaptersFor(a: string): Promise<{ numbers: unknown; provisioning: unknown }> } };
    expect(await deps.deps.adaptersFor(ACCOUNT)).toEqual({ numbers: null, provisioning: null });
  });

  it("P3-2: in fake mode the runner releases exactly the campaign the platform runtime's (J1's) fake hub provisioned", async () => {
    const hub = fakeProvisioningHub(LOCAL)!;
    const provisioned = hub.adapterFor(ACCOUNT);
    const ms = provisioned.seedService("df:development:f5-hardening:ms:1");
    const qe = await provisioned.createCampaign({
      messagingServiceSid: ms, brandSid: `BN${"1".repeat(32)}`, useCase: "LOW_VOLUME", description: "d", messageFlow: "f", messageSamples: ["a", "b"], hasEmbeddedLinks: false,
      hasEmbeddedPhone: false, subscriberOptIn: true, ageGated: false, directLending: false, optInMessage: "i", optOutMessage: "o", helpMessage: "h", optInKeywords: ["START"],
      optOutKeywords: ["STOP"], helpKeywords: ["HELP"],
    });
    const other = provisioned.seedService("df:development:f5-hardening:ms:other");
    rpcState = "authorized";
    rpcCalls.length = 0;
    beginReply = { action: "execute", provider_sid: qe, resource_kind: "campaign" };
    const campaignTarget: CancelTargetSource = {
      target: async () => ({
        operationId: OP, resourceId: RES, operationStatus: rpcState, kind: "campaign", providerSid: qe, accountSid: ACCOUNT, messagingServiceSid: ms, liveDependents: 0, dualControl: null,
      }),
    };
    const runtime = cancelReleaseRuntime(LOCAL, { targets: campaignTarget });
    expect(runtime).toMatchObject({ ok: true, mode: "fake" });
    const out = runtime.ok ? await runtime.runner.run(OP, ACTOR) : null;
    expect(out).toMatchObject({ result: "confirmed" });
    // the same hub object J1 hands out: the campaign is gone there, its service and the other service are untouched
    expect(fakeProvisioningHub(LOCAL)).toBe(hub);
    expect(hub.adapterFor(ACCOUNT).campaigns.has(qe)).toBe(false);
    expect(hub.adapterFor(ACCOUNT).services.has(ms)).toBe(true);
    expect(hub.adapterFor(ACCOUNT).services.has(other)).toBe(true);
    expect(provisioned.count("deleteCampaign")).toBe(1);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["tw4_rfl_cancel_begin", "tw4_rfl_cancel_finish"]);
    expect(rpcCalls[1].args).toMatchObject({ p_outcome: "confirmed", p_evidence_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
