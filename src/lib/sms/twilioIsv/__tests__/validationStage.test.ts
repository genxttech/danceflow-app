import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptEin } from "@/lib/sms/onboarding/ein";
import type { IsvConfig } from "../config";
import { FakeIsvAdapter } from "../fake";
import type { RunnerInputs } from "../payloads";
import { RunnerStoreError } from "../store";
import { runBrandSubmission, STEPS } from "../runner";
import { stepFriendlyName } from "../payloads";
import {
  checkStageGuards, issueStageBAuthorization, issueStageCAuthorization, stageBToken, verifyStageBAuthorization, loopbackUrl, recordingAdapter, runValidationStage, STAGE_B_LAST_STEP, stageCToken, verifyStageCAuthorization,
  type LedgerRow, type StageCAuthorization, type StageGuardInput,
} from "../validation/stage";
import { MemoryRunnerStore } from "./memoryStore";

const STUDIO = "a5700000-0000-4000-8000-0000000000aa";
const CONFIDANCE = "a5700000-0000-4000-8000-0000000000cc";
const ADMIN = "a5700000-0000-4000-8000-000000000401";
const PRIMARY = `BU${"e".repeat(32)}`;
const PRIMARY_POLICY = `RN${"4".repeat(32)}`;
const EIN = "987654321";

const config: IsvConfig = {
  accountSid: `AC${"1".repeat(32)}`, authToken: "t".repeat(32), primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: true,
};
const inputs = (): RunnerInputs => ({
  studio_id: STUDIO, submission_seq: 1, state: "submitted_for_checks", studio_name: "Validation Studio", studio_slug: "tw4-validation", studio_public_name: null,
  legal_name: "Validation Test LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: null,
  address_line1: "12 Harbor Way", address_line2: null, city: "Portland", region: "OR", postal_code: "97201", country: "US",
  rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@validation.example", rep_phone: "+15035550123",
  preferred_area_code: "503", ein_last4: "4321", missing: [],
});
const fakeEnv = { NODE_ENV: "test", TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const guard = (over: Partial<StageGuardInput> = {}): StageGuardInput => ({
  stage: "B", studioId: STUDIO, confirmStudioId: STUDIO, forbiddenStudioIds: [CONFIDANCE], supabaseUrl: "http://127.0.0.1:55321", adapterKind: "fake", config, windowHours: 1, env: fakeEnv, ...over,
});

let adapter: FakeIsvAdapter;
let store: MemoryRunnerStore;
beforeEach(() => {
  process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
  adapter = new FakeIsvAdapter(PRIMARY, { captureSensitive: true, primaryPolicySid: PRIMARY_POLICY });
  store = new MemoryRunnerStore(inputs(), encryptEin(STUDIO, { digits: EIN, last4: "4321" }).ciphertext);
  store.platformAdmins.add(ADMIN);
  store.windowOpen = false; // the harness must open it itself
});
const SECRET = "local-throwaway-secret";
const ledgerOf = (): LedgerRow[] => store.ledger.map((row) => ({ step_key: row.step_key, status: row.status, provider_sid: row.provider_sid, seq: row.seq }));
const go = (over: Partial<StageGuardInput> = {}, authorization?: StageCAuthorization) =>
  runValidationStage({ guard: guard(over), store, adapter, actorId: ADMIN, readLedger: async () => ledgerOf(), stageC: over.stage === "C" ? { secret: SECRET, authorization } : undefined });
const authorizeC = (minutes = 60) => {
  const issued = issueStageCAuthorization({ secret: SECRET, studioId: STUDIO, ledger: ledgerOf(), config, minutes });
  if (!issued.ok) throw new Error(issued.reason);
  return issued.authorization;
};
const goC = () => go({ stage: "C" }, authorizeC());

describe("stage guards", () => {
  it("accepts a correct local fake run and refuses each way of getting it wrong", () => {
    expect(checkStageGuards(guard())).toEqual({ ok: true });
    expect(checkStageGuards(guard({ confirmStudioId: "a5700000-0000-4000-8000-0000000000ab" }))).toMatchObject({ ok: false });
    expect(checkStageGuards(guard({ studioId: CONFIDANCE, confirmStudioId: CONFIDANCE }))).toMatchObject({ ok: false, reason: expect.stringContaining("forbidden") });
    expect(checkStageGuards(guard({ studioId: CONFIDANCE.toUpperCase(), confirmStudioId: CONFIDANCE }))).toMatchObject({ ok: false });
    expect(checkStageGuards(guard({ studioId: "not-a-uuid", confirmStudioId: "not-a-uuid" }))).toMatchObject({ ok: false });
    for (const supabaseUrl of ["https://epdrtzcydvnoidwrepqz.supabase.co", "https://hvsujyfbftfffxpfmlpb.supabase.co", "", "http://10.0.0.5:55321"]) {
      expect(checkStageGuards(guard({ supabaseUrl }))).toMatchObject({ ok: false, reason: expect.stringContaining("loopback") });
    }
    for (const windowHours of [0, 3, 1.5, -1, Number.NaN]) expect(checkStageGuards(guard({ windowHours }))).toMatchObject({ ok: false });
    expect(checkStageGuards(guard({ stage: "X" as never }))).toMatchObject({ ok: false });
  });
  it("stage C and the real adapter require the mock-brand switch; no stage can be an un-flagged paid run", () => {
    expect(checkStageGuards(guard({ stage: "C", config: { ...config, mockBrand: false } }))).toMatchObject({ ok: false, reason: expect.stringContaining("MOCK") });
    expect(checkStageGuards(guard({ stage: "C" }))).toEqual({ ok: true });
    const production = { NODE_ENV: "production", VERCEL_ENV: "production", TW4_ISV_REAL_CALLS: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
    expect(checkStageGuards(guard({ adapterKind: "real", env: production, config: { ...config, mockBrand: false } }))).toMatchObject({ ok: false, reason: expect.stringContaining("MOCK") });
    const withKey = { ...config, authToken: "", apiKeySid: `SK${"3".repeat(32)}`, apiKeySecret: "k".repeat(32) };
    expect(checkStageGuards(guard({ adapterKind: "real", env: production, config: withKey }))).toEqual({ ok: true });
  });
  it("the real adapter is refused unless the runner's own production gate is open; the fake is refused in production or off-loopback", () => {
    expect(checkStageGuards(guard({ adapterKind: "real", env: fakeEnv }))).toMatchObject({ ok: false });
    expect(checkStageGuards(guard({ adapterKind: "real", env: { NODE_ENV: "production", VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" } }))).toMatchObject({ ok: false, reason: expect.stringContaining("switched off") });
    expect(checkStageGuards(guard({ env: { ...fakeEnv, TW4_ISV_FAKE: "" } }))).toMatchObject({ ok: false });
    expect(checkStageGuards(guard({ env: { ...fakeEnv, VERCEL_ENV: "production" } }))).toMatchObject({ ok: false });
    expect(checkStageGuards(guard({ env: { ...fakeEnv, NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" } }))).toMatchObject({ ok: false });
  });
  it("loopbackUrl", () => {
    expect(["http://127.0.0.1:1", "http://localhost:2", "http://[::1]:3"].every(loopbackUrl)).toBe(true);
    expect(["https://localhost.evil.example", "http://127.0.0.1.evil.example", "nope", ""].some(loopbackUrl)).toBe(false);
  });
});

describe("stage B", () => {
  it("runs S1-S10 only: a draft profile and its evaluation; nothing is submitted for review, no trust product, no brand; the window is closed again", async () => {
    const out = await go();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.result.stepsRun).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]);
    expect(STAGE_B_LAST_STEP).toBe("S10");
    expect(adapter.count("submitCustomerProfile")).toBe(0);
    expect(adapter.count("createTrustProduct")).toBe(0);
    expect(adapter.count("createBrand")).toBe(0);
    expect(store.ledger.some((row) => row.fee_bearing)).toBe(false);
    expect(out.report.windowClosed).toBe(true);
    expect(store.windowOpen).toBe(false);
    expect(out.report.adapterKind).toBe("fake");
  });
  it("a refused guard performs no store or adapter call at all", async () => {
    const out = await go({ confirmStudioId: "wrong" });
    expect(out.ok).toBe(false);
    expect(adapter.calls).toHaveLength(0);
    expect(store.ledger).toHaveLength(0);
    expect(store.claimModes).toHaveLength(0);
  });
});

describe("stage C", () => {
  it("after stage B, finishes S11, T1-T6 and creates exactly ONE brand, flagged mock, confirmed by the operator", async () => {
    expect((await go()).ok).toBe(true);
    const out = await goC();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.result).toMatchObject({ outcome: "brand_submitted", detail: "mock_brand" });
    expect(adapter.count("createBrand")).toBe(1);
    expect(adapter.count("createCustomerProfile")).toBe(1); // stage B's profile is reused, not recreated
    expect((adapter.calls.find((c) => c.method === "createBrand")!.input as { mock: boolean }).mock).toBe(true);
    const brand = store.ledger.find((row) => row.step_key === "B1")!;
    expect(brand).toMatchObject({ mock: true, fee_bearing: true, fee_confirmed_by: ADMIN });
    expect(store.registration).toBeNull(); // a mock brand is never mirrored into a registration
    expect(store.einPurged).toBe(false);
    expect(store.windowOpen).toBe(false);
  });
  it("the window is closed again even when the run throws", async () => {
    adapter.createCustomerProfile = async () => {
      throw new RunnerStoreError("XX000");
    };
    const outcome = await go().catch((e: unknown) => e);
    expect(store.windowOpen).toBe(false);
    expect(outcome).toBeDefined();
  });
});

describe("recording adapter", () => {
  it("records method names and outcomes only, never arguments or results", async () => {
    adapter.getCustomerProfile = async () => {
      throw Object.assign(new Error("boom"), { kind: "transient" });
    };
    const recorded = recordingAdapter(adapter);
    const sid = await recorded.adapter.createCustomerProfile({ friendlyName: "df:test:secret-name", email: "secret@example.com" });
    await expect(recorded.adapter.getCustomerProfile(`BU${"0".repeat(32)}`)).rejects.toBeDefined();
    expect(recorded.calls.map((c) => `${c.method}:${c.ok}`)).toEqual(["createCustomerProfile:true", "getCustomerProfile:false"]);
    expect(recorded.calls[1].errorKind).toBe("transient");
    const text = JSON.stringify(recorded.calls);
    expect(text).not.toContain("secret");
    expect(text).not.toContain(sid);
  });
});

describe("stage B never goes past S10 (review P1: the limit is positional, not a count of steps run)", () => {
  it("re-running stage B after it completed runs nothing: S11 is never started", async () => {
    expect((await go()).ok).toBe(true);
    const again = await go();
    expect(again.ok).toBe(true);
    expect(adapter.count("submitCustomerProfile")).toBe(0);
    expect(store.ledger.some((row) => row.step_key === "S11")).toBe(false);
    expect(again.ok && again.report.result).toMatchObject({ outcome: "retry_later", detail: "step_limit" });
  });
  it("an interrupted stage B resumes up to S10 and stops there", async () => {
    const original = adapter.createAddress.bind(adapter);
    adapter.createAddress = async () => {
      throw Object.assign(new Error("net"), { kind: "transient" });
    };
    expect((await go()).ok).toBe(true);
    adapter.createAddress = original;
    for (let i = 0; i < 4; i += 1) await go();
    expect(adapter.count("submitCustomerProfile")).toBe(0);
    expect(store.ledger.some((row) => ["S11", "T1", "B1"].includes(row.step_key))).toBe(false);
  });
  it("the forbidden list matches whatever format the operator typed", () => {
    for (const forbidden of [CONFIDANCE.toUpperCase(), `{${CONFIDANCE}}`, `urn:uuid:${CONFIDANCE}`, CONFIDANCE.replace(/-/g, "")]) {
      expect(checkStageGuards(guard({ studioId: CONFIDANCE, confirmStudioId: CONFIDANCE, forbiddenStudioIds: [forbidden] }))).toMatchObject({ ok: false, reason: expect.stringContaining("forbidden") });
    }
  });
});

describe("stage C is an executable gate, not a label (review P1)", () => {
  const untouched = () => {
    expect(adapter.calls).toHaveLength(0);
    expect(store.claimModes).toHaveLength(0);
    expect(store.windowOpen).toBe(false);
  };
  it("stage C without an authorization is refused before any window, claim or adapter call, even on a completed stage B", async () => {
    expect((await go()).ok).toBe(true);
    const before = adapter.calls.length;
    store.claimModes.length = 0;
    const out = await go({ stage: "C" });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("own authorization") });
    expect(adapter.calls).toHaveLength(before);
    expect(store.claimModes).toHaveLength(0);
    expect(store.windowOpen).toBe(false);
  });
  it("stage C alone on an empty ledger cannot be authorized or run (stage B must have completed)", async () => {
    expect(issueStageCAuthorization({ secret: SECRET, studioId: STUDIO, ledger: [], config, minutes: 60 })).toMatchObject({ ok: false, reason: expect.stringContaining("stage B") });
    const forged: StageCAuthorization = { expiresAt: new Date(Date.now() + 600_000).toISOString(), token: stageCToken(SECRET, { studioId: STUDIO, expiresAt: new Date(Date.now() + 600_000).toISOString(), mock: true, sids: Array(10).fill(""), config }) };
    expect(await go({ stage: "C" }, forged)).toMatchObject({ ok: false, reason: expect.stringContaining("stage B") });
    untouched();
  });
  it("stage C called without the authorization input at all is refused (no crash, nothing touched)", async () => {
    const out = await runValidationStage({ guard: guard({ stage: "C" }), store, adapter, actorId: ADMIN, readLedger: async () => ledgerOf() });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("own authorization") });
    untouched();
  });
  it("a valid authorization is accepted exactly once per set of stage B resources and carries the studio, expiry and SIDs", async () => {
    expect((await go()).ok).toBe(true);
    const authorization = authorizeC();
    expect(verifyStageCAuthorization({ secret: SECRET, studioId: STUDIO, ledger: ledgerOf(), config, authorization })).toEqual({ ok: true });
    const out = await go({ stage: "C" }, authorization);
    expect(out.ok).toBe(true);
    expect(adapter.count("createBrand")).toBe(1);
  });
  it("rejects a token for another studio, another expiry, other stage B resources, a different secret, an expired or over-long lifetime, a malformed value, or a non-mock request", async () => {
    expect((await go()).ok).toBe(true);
    const good = authorizeC();
    const check = (over: Partial<Parameters<typeof verifyStageCAuthorization>[0]>) =>
      verifyStageCAuthorization({ secret: SECRET, studioId: STUDIO, ledger: ledgerOf(), config, authorization: good, ...over });
    expect(check({})).toEqual({ ok: true });
    expect(check({ studioId: "a5700000-0000-4000-8000-0000000000ab" })).toMatchObject({ ok: false });
    expect(check({ secret: "another-secret" })).toMatchObject({ ok: false });
    expect(check({ authorization: { ...good, expiresAt: new Date(Date.parse(good.expiresAt) + 1000).toISOString() } })).toMatchObject({ ok: false });
    expect(check({ authorization: { ...good, token: "zz" } })).toMatchObject({ ok: false });
    expect(check({ authorization: { ...good, token: "" } })).toMatchObject({ ok: false });
    expect(check({ authorization: undefined })).toMatchObject({ ok: false });
    expect(check({ config: { ...config, mockBrand: false } })).toMatchObject({ ok: false });
    expect(check({ now: new Date(Date.parse(good.expiresAt) + 1) })).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    const far = new Date(Date.now() + 5 * 3600_000).toISOString();
    expect(check({ authorization: { expiresAt: far, token: stageCToken(SECRET, { studioId: STUDIO, expiresAt: far, mock: true, sids: ledgerOf().filter((r) => r.status === "succeeded").map((r) => r.provider_sid ?? ""), config }) } })).toMatchObject({ ok: false });
    // other stage B resources (a different S2 sid): the same token no longer matches
    const changed = ledgerOf().map((row) => (row.step_key === "S2" ? { ...row, provider_sid: `IT${"9".repeat(32)}` } : row));
    expect(check({ ledger: changed })).toMatchObject({ ok: false });
    expect(issueStageCAuthorization({ secret: SECRET, studioId: STUDIO, ledger: ledgerOf(), config: { ...config, mockBrand: false }, minutes: 60 })).toMatchObject({ ok: false });
    for (const minutes of [0, 241, 1.5, Number.NaN]) expect(issueStageCAuthorization({ secret: SECRET, studioId: STUDIO, ledger: ledgerOf(), config, minutes })).toMatchObject({ ok: false });
  });
  it("a stage C authorization cannot be used after stage B was redone for a new submission generation", async () => {
    expect((await go()).ok).toBe(true);
    const authorization = authorizeC();
    store.seq = 2;
    store.state = "submitted_for_checks";
    expect((await go()).ok).toBe(true); // new generation, new stage B resources
    expect(await go({ stage: "C" }, authorization)).toMatchObject({ ok: false });
  });
});

describe("stage B refuses to run once later steps exist, and the runner fails closed on a bad stop point", () => {
  it("stage B after stage C makes no adapter call and opens no window", async () => {
    expect((await go()).ok).toBe(true);
    expect((await goC()).ok).toBe(true);
    const calls = adapter.calls.length;
    store.claimModes.length = 0;
    expect(await go()).toMatchObject({ ok: false, reason: expect.stringContaining("after S10") });
    expect(adapter.calls).toHaveLength(calls);
    expect(store.claimModes).toHaveLength(0);
  });
  it("an S11 row left in flight by an earlier attempt blocks stage B instead of being reconciled", async () => {
    expect((await go()).ok).toBe(true);
    store.ledger.push({ ...store.ledger[0], step_key: "S11", status: "in_flight", provider_sid: null });
    const calls = adapter.calls.length;
    expect(await go()).toMatchObject({ ok: false });
    expect(adapter.calls).toHaveLength(calls);
  });
  it("an unknown or empty stopAfter is refused before anything is claimed or called (it must never mean 'no limit')", async () => {
    for (const stopAfter of ["S1O", "", "s10", "B2"]) {
      const result = await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, stopAfter: stopAfter as never });
      expect(result).toMatchObject({ outcome: "not_runnable", detail: "unknown_stop_after" });
    }
    expect(adapter.calls).toHaveLength(0);
    expect(store.claimModes).toHaveLength(0);
    expect(store.ledger).toHaveLength(0);
  });
  it("the interrupted resume really reaches S10: S10 succeeded and S4 was retried (not just 'S11 absent')", async () => {
    let attempts = 0;
    const original = adapter.createAddress.bind(adapter);
    adapter.createAddress = async (input) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("net"), { kind: "transient" });
      return original(input);
    };
    expect((await go()).ok).toBe(true);
    expect(store.ledger.find((row) => row.step_key === "S4")?.status).not.toBe("succeeded");
    for (let i = 0; i < 3; i += 1) await go();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(store.ledger.find((row) => row.step_key === "S10")?.status).toBe("succeeded");
    expect(store.ledger.some((row) => ["S11", "T1", "B1"].includes(row.step_key))).toBe(false);
    expect(adapter.count("submitCustomerProfile")).toBe(0);
  });
});

describe("real-adapter stages: Standard API key only, and stage B has its own executable authorization (decisions D1, D4)", () => {
  const keyed = { ...config, authToken: "", apiKeySid: `SK${"3".repeat(32)}`, apiKeySecret: "k".repeat(32) };
  const prod = { NODE_ENV: "production", VERCEL_ENV: "production", TW4_ISV_REAL_CALLS: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
  const realGuard = (over: Partial<StageGuardInput> = {}) => guard({ adapterKind: "real", env: prod, config: keyed, ...over });
  const authB = (cfg = keyed, studio = STUDIO, minutes = 30) => {
    const issued = issueStageBAuthorization({ secret: SECRET, studioId: studio, config: cfg, minutes });
    if (!issued.ok) throw new Error(issued.reason);
    return issued.authorization;
  };
  const goReal = (over: Partial<StageGuardInput> = {}, authorization?: Parameters<typeof runValidationStage>[0]["stageB"] extends infer T ? (T extends { authorization: infer A } ? A : never) : never, stage: "B" | "C" = "B") =>
    runValidationStage({
      guard: realGuard({ stage, ...over }), store, adapter, actorId: ADMIN, readLedger: async () => ledgerOf(),
      stageB: { secret: SECRET, authorization }, stageC: stage === "C" ? { secret: SECRET, authorization: undefined } : undefined,
    });

  it("the real adapter is refused without a key, or when the configuration also carries an auth token (no token anywhere in the harness)", () => {
    expect(checkStageGuards(realGuard({ config: { ...config, authToken: "t".repeat(32) } }))).toMatchObject({ ok: false, reason: expect.stringContaining("Standard API key") });
    expect(checkStageGuards(realGuard({ config: { ...keyed, authToken: "t".repeat(32) } }))).toMatchObject({ ok: false, reason: expect.stringContaining("auth token") });
    expect(checkStageGuards(realGuard({ config: { ...keyed, apiKeySecret: undefined } }))).toMatchObject({ ok: false });
    expect(checkStageGuards(realGuard())).toEqual({ ok: true });
  });
  it("stage B with the real adapter and NO authorization is refused before a window, claim or adapter call", async () => {
    const out = await goReal({}, undefined);
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("own authorization") });
    expect(adapter.calls).toHaveLength(0);
    expect(store.claimModes).toHaveLength(0);
    expect(store.windowOpen).toBe(false);
  });
  it("stage B with the real adapter and NO authorization input at all (not even an empty one) is refused, not crashed", async () => {
    const out = await runValidationStage({ guard: realGuard({ stage: "B" }), store, adapter, actorId: ADMIN, readLedger: async () => ledgerOf() });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("own authorization") });
    expect(adapter.calls).toHaveLength(0);
    expect(store.claimModes).toHaveLength(0);
  });
  it("stage B with a valid authorization runs S1-S10 and stops there; a re-run runs nothing and never reaches S11", async () => {
    const authorization = authB();
    const first = await goReal({}, authorization);
    expect(first.ok && first.report.result.stepsRun).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]);
    const again = await goReal({}, authorization);
    expect(again.ok && again.report.result).toMatchObject({ outcome: "retry_later", detail: "step_limit", stepsRun: [] });
    expect(adapter.count("submitCustomerProfile")).toBe(0);
    expect(adapter.count("createTrustProduct")).toBe(0);
    expect(adapter.count("createBrand")).toBe(0);
    expect(store.ledger.some((row) => row.fee_bearing)).toBe(false);
  });
  it("the authorization is bound to studio, expiry, mailbox, key SID, Primary profile and the mock switch; expired or over-long ones fail", () => {
    const good = authB();
    const check = (over: Partial<Parameters<typeof verifyStageBAuthorization>[0]> = {}) =>
      verifyStageBAuthorization({ secret: SECRET, studioId: STUDIO, config: keyed, authorization: good, ...over });
    expect(check()).toEqual({ ok: true });
    expect(check({ studioId: "a5700000-0000-4000-8000-0000000000ab" })).toMatchObject({ ok: false });
    expect(check({ config: { ...keyed, complianceEmail: "other@example.test" } })).toMatchObject({ ok: false });
    expect(check({ config: { ...keyed, apiKeySid: `SK${"4".repeat(32)}` } })).toMatchObject({ ok: false });
    expect(check({ config: { ...keyed, primaryProfileSid: `BU${"d".repeat(32)}` } })).toMatchObject({ ok: false });
    expect(check({ config: { ...keyed, mockBrand: false } })).toMatchObject({ ok: false });
    expect(check({ secret: "another-secret" })).toMatchObject({ ok: false });
    expect(check({ authorization: { ...good, token: "zz" } })).toMatchObject({ ok: false });
    expect(check({ authorization: undefined })).toMatchObject({ ok: false });
    expect(check({ now: new Date(Date.parse(good.expiresAt) + 1) })).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    const far = new Date(Date.now() + 3 * 3600_000).toISOString();
    expect(check({ authorization: { expiresAt: far, token: stageBToken(SECRET, keyed, STUDIO, far) } })).toMatchObject({ ok: false });
    expect(issueStageBAuthorization({ secret: SECRET, studioId: STUDIO, config: { ...keyed, mockBrand: false }, minutes: 30 })).toMatchObject({ ok: false });
    expect(issueStageBAuthorization({ secret: SECRET, studioId: STUDIO, config: { ...keyed, apiKeySid: undefined }, minutes: 30 })).toMatchObject({ ok: false });
    for (const minutes of [0, 121, 1.5, Number.NaN]) expect(issueStageBAuthorization({ secret: SECRET, studioId: STUDIO, config: keyed, minutes })).toMatchObject({ ok: false });
  });
  it("a stage B authorization does not authorize stage C: stage C still needs its own authorize-c token", async () => {
    expect((await goReal({}, authB())).ok).toBe(true);
    const out = await goReal({}, authB(), "C");
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("own authorization") });
    expect(adapter.count("createBrand")).toBe(0);
    expect(adapter.count("submitCustomerProfile")).toBe(0);
  });
  it("DUPLICATE RESOURCE: a profile that already exists under the S1 name (for example after a crash before the ledger write) is adopted, not created twice", async () => {
    const existing = await adapter.createCustomerProfile({ friendlyName: stepFriendlyName("test", STUDIO, "S1", 1), email: "x@example.test" });
    const out = await goReal({}, authB());
    expect(out.ok).toBe(true);
    expect(adapter.count("createCustomerProfile")).toBe(1); // only the seed
    expect(store.ledger.find((row) => row.step_key === "S1")).toMatchObject({ status: "succeeded", provider_sid: existing });
  });
  it("RETRY / RESUME with the real-adapter path: a transient failure at S4 resumes to S10 under a fresh authorization of the same binding, still stopping at S10", async () => {
    let attempts = 0;
    const original = adapter.createAddress.bind(adapter);
    adapter.createAddress = async (input) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("net"), { kind: "transient" });
      return original(input);
    };
    const authorization = authB();
    expect((await goReal({}, authorization)).ok).toBe(true);
    for (let i = 0; i < 3; i += 1) await goReal({}, authorization);
    expect(store.ledger.find((row) => row.step_key === "S10")?.status).toBe("succeeded");
    expect(store.ledger.some((row) => ["S11", "T1", "B1"].includes(row.step_key))).toBe(false);
    expect(adapter.count("submitCustomerProfile")).toBe(0);
  });
});

describe("review round 2: token encoding, stage C binding, empty secret, freeze", () => {
  const keyed = { ...config, authToken: "", apiKeySid: `SK${"3".repeat(32)}`, apiKeySecret: "k".repeat(32) };
  it("a token must be exactly 64 hex characters: trailing garbage, odd length and non-hex are malformed, not silently truncated (stage B and C)", () => {
    const b = issueStageBAuthorization({ secret: SECRET, studioId: STUDIO, config: keyed, minutes: 30 });
    if (!b.ok) throw new Error(b.reason);
    const checkB = (token: string) => verifyStageBAuthorization({ secret: SECRET, studioId: STUDIO, config: keyed, authorization: { ...b.authorization, token } });
    expect(checkB(b.authorization.token)).toEqual({ ok: true });
    for (const bad of [b.authorization.token + "zz", b.authorization.token + "00", b.authorization.token.slice(0, 63), "g".repeat(64), "", b.authorization.token.toUpperCase().slice(0, 63) + "!"]) {
      expect(checkB(bad)).toMatchObject({ ok: false, reason: expect.stringContaining("malformed") });
    }
    expect(checkB(b.authorization.token.toUpperCase())).toEqual({ ok: true }); // case of the hex digits is irrelevant
  });
  it("an empty or short local secret mints and accepts nothing (stage B and C)", async () => {
    expect(issueStageBAuthorization({ secret: "", studioId: STUDIO, config: keyed, minutes: 30 })).toMatchObject({ ok: false, reason: expect.stringContaining("secret") });
    expect((await go()).ok).toBe(true); // stage B done, so the ONLY thing wrong below is the secret
    expect(issueStageCAuthorization({ secret: "short", studioId: STUDIO, ledger: ledgerOf(), config, minutes: 30 })).toMatchObject({ ok: false, reason: expect.stringContaining("secret") });
    expect(issueStageCAuthorization({ secret: SECRET, studioId: STUDIO, ledger: ledgerOf(), config, minutes: 30 }).ok).toBe(true);
    const forgedWithEmptySecret = { expiresAt: new Date(Date.now() + 600_000).toISOString(), token: stageBToken("", keyed, STUDIO, new Date(Date.now() + 600_000).toISOString()) };
    expect(verifyStageBAuthorization({ secret: "", studioId: STUDIO, config: keyed, authorization: forgedWithEmptySecret })).toMatchObject({ ok: false, reason: expect.stringContaining("secret") });
  });
  it("the stage C authorization is bound to the compliance mailbox, the API key SID and the Primary profile like stage B (a mailbox change between B and C invalidates it)", async () => {
    expect((await go()).ok).toBe(true);
    const good = authorizeC();
    const check = (cfg: typeof config) => verifyStageCAuthorization({ secret: SECRET, studioId: STUDIO, ledger: ledgerOf(), config: cfg, authorization: good });
    expect(check(config)).toEqual({ ok: true });
    expect(check({ ...config, complianceEmail: "someone-else@example.test" })).toMatchObject({ ok: false });
    expect(check({ ...config, apiKeySid: `SK${"5".repeat(32)}` })).toMatchObject({ ok: false });
    expect(check({ ...config, primaryProfileSid: `BU${"d".repeat(32)}` })).toMatchObject({ ok: false });
  });
  it("the step table is deeply frozen: neither the list nor a step can be altered at runtime", () => {
    expect(Object.isFrozen(STEPS)).toBe(true);
    expect(STEPS.every((step) => Object.isFrozen(step))).toBe(true);
    expect(() => {
      (STEPS[0] as { run: unknown }).run = () => undefined;
    }).toThrow();
  });
});

describe("sanitized evaluation evidence: the stage report records the real evaluation status", () => {
  it("a compliant S10 is recorded as compliant with the evaluation SID and no field names", async () => {
    const out = await go();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.evaluations).toHaveLength(1);
    expect(out.report.evaluations[0]).toMatchObject({ method: "evaluateCustomerProfile", status: "compliant", failedFields: [] });
    expect(out.report.evaluations[0].evaluationSid).toMatch(/^EL[0-9a-f]{32}$/i);
  });
  it("noncompliant (even with no named field) is recorded as noncompliant and the stage does not end cleanly", async () => {
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: [] };
    const out = await go();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.evaluations[0]).toMatchObject({ status: "noncompliant", failedFields: [] });
    expect(out.report.result.outcome).not.toBe("retry_later");
    expect(out.report.result.stepsRun).not.toContain("S10");
  });
  it("an unrecognized reply is recorded as unrecognized, and only plain Twilio field NAMES are kept (never values)", async () => {
    adapter.evaluationRaw.profile = { status: "weird", failedFields: ["email", "bad value with spaces and @sign", "a".repeat(200)] } as never;
    const out = await go();
    if (!out.ok) throw new Error(out.reason);
    expect(out.report.evaluations[0].status).toBe("unrecognized");
    expect(out.report.evaluations[0].failedFields).toEqual(["email"]);
  });
  it("the report holds no EIN, email or business value", async () => {
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: ["business_name"] };
    const out = await go();
    if (!out.ok) throw new Error(out.reason);
    const text = JSON.stringify(out.report);
    for (const secret of [EIN, "pat@validation.example", "Validation Test LLC", "12 Harbor Way"]) expect(text).not.toContain(secret);
  });
  it("recordingAdapter captures evaluations from both profile and trust product calls", async () => {
    const recorded = recordingAdapter(adapter);
    await recorded.adapter.evaluateCustomerProfile(`BU${"1".repeat(32)}`);
    await recorded.adapter.evaluateTrustProduct(`BU${"2".repeat(32)}`);
    expect(recorded.evaluations.map((e) => `${e.method}:${e.status}`)).toEqual(["evaluateCustomerProfile:compliant", "evaluateTrustProduct:compliant"]);
  });
});

describe("evaluation evidence never carries an EIN-shaped or value-shaped field name (Opus review P3)", () => {
  it("drops all-digit, hyphenated-digit, spaced and email-like names from the report", async () => {
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: ["business_name", "123456789", "12-3456789", "Validation Test LLC", "pat@validation.example"] };
    const out = await go();
    if (!out.ok) throw new Error(out.reason);
    expect(out.report.evaluations[0].failedFields).toEqual(["business_name"]);
    const text = JSON.stringify(out.report);
    for (const secret of ["123456789", "3456789", "Validation Test LLC", "pat@validation.example"]) expect(text).not.toContain(secret);
  });
});
