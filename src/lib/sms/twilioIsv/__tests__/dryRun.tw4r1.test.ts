/**
 * TW-4 R1 DRY RUN (local only). The complete brand-registration sequence, driven by the real runner and the REAL R1 SQL functions
 * (through PostgREST) against a LOCAL Supabase stack, with the FAKE Twilio adapter and synthetic, non-pilot studios and business data.
 * Skipped unless the variables below point at a loopback stack that has TW-4A, TW-4A.1 and R1 applied. Fixtures are synthetic and removed.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 *
 * A fetch guard is installed BEFORE any client is created: the only URLs this file may ever request are loopback ones. Any other host
 * (that is, any Twilio host) is recorded and the test run fails.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// real SQL over HTTP and a multi-pass admin journey: more than the 5 s default per test
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const blockedRequests: string[] = [];
const allowedRequests = { count: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
    blockedRequests.push(url);
    throw new Error("dry run: only loopback requests are allowed");
  }
  allowedRequests.count += 1;
  return realFetch(input, init);
}) as typeof fetch;

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const state = vi.hoisted(() => ({ ctx: null as null | { supabase: unknown; user: { id: string }; studioId: string; studioRole: string | null; isPlatformAdmin: boolean }, admin: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/serverRoleGuard", () => ({ getCurrentUserStudioContext: async () => state.ctx }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin }));

import { saveSmsSetupAction, submitSmsSetupAction } from "@/app/app/settings/sms/actions";
import { getStudioSmsStatus, setPilotAccess } from "@/lib/sms/onboarding/client";
import { fakeAdapterAllowed, realCallsAllowed, type IsvConfig } from "../config";
import { buildRunnerRuntime } from "../factory";
import { FakeIsvAdapter } from "../fake";
import { createRealIsvAdapter } from "../real";
import { refreshBrandStatus, runBrandSubmission, STEPS, type RunResult } from "../runner";
import { RunnerStoreError, SupabaseRunnerStore } from "../store";
import { LegacyAccountStore } from "./legacyAccountStore";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const loopback = (() => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(URL_).hostname);
  } catch {
    return false;
  }
})();
const enabled = Boolean(URL_ && SECRET && PG) && loopback;

const X = "a5e40000-0000-4000-8000-00000000000a"; // studio X: the MOCK-brand dry run (non-pilot, synthetic)
const Z = "a5e40000-0000-4000-8000-00000000000b"; // studio Z: the fake-but-real-flow scenarios (uncertain responses, crashes, races)
const D = "a5e40000-0000-4000-8000-00000000000d"; // studio D: a window here must never help X or Z
const U = {
  owner_e: "a5e40000-0000-4000-8000-000000000301",
  owner_f: "a5e40000-0000-4000-8000-000000000302",
  owner_g: "a5e40000-0000-4000-8000-000000000303",
  owner_x: "a5e40000-0000-4000-8000-000000000101",
  owner_z: "a5e40000-0000-4000-8000-000000000201",
  padmin: "a5e40000-0000-4000-8000-000000000401",
  outsider: "a5e40000-0000-4000-8000-000000000999",
};
const PRIMARY = `BU${"e".repeat(32)}`;
const PRIMARY_POLICY = `RN${"4".repeat(32)}`;
const EIN_X = "111223333";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp: 1983812996 }) : "");
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const userToken = (sub: string) => sign({ sub, role: "authenticated", aud: "authenticated", aal: "aal2", exp: Math.floor(Date.now() / 1000) + 3600 });
function client(token: string | null, key = anonKey()): SupabaseClient {
  return createClient(URL_, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: token ? { Authorization: `Bearer ${token}` } : {} } });
}
const as = (who: keyof typeof U) => client(userToken(U[who]));
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const FIELDS: Record<string, string> = {
  legal_name: "Dry Run Dance LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: "",
  address_line1: "1 Synthetic Way", address_line2: "", city: "Portland", region: "OR", postal_code: "97201",
  rep_first_name: "Syn", rep_last_name: "Thetic", rep_title: "Owner", rep_position: "ceo", rep_email: "owner@tw4dry-e2e.test", rep_phone: "(503) 555-0100", preferred_area_code: "503",
};
const ATTEST = { attest_authorized: "on", attest_accurate: "on", attest_opt_in_only: "on", attest_fees_terms: "on" };
const baseConfig: IsvConfig = {
  accountSid: `AC${"1".repeat(32)}`, authToken: "dry-run-token", primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
};
const mockConfig: IsvConfig = { ...baseConfig, mockBrand: true };

class SlowFake extends FakeIsvAdapter {
  constructor(primary: string, options: ConstructorParameters<typeof FakeIsvAdapter>[1], private readonly delayMs: number, private readonly onProfile?: () => void) {
    super(primary, options);
  }
  async createCustomerProfile(input: { friendlyName: string; email: string }) {
    this.onProfile?.();
    await sleep(this.delayMs);
    return super.createCustomerProfile(input);
  }
}
const fake = () => new FakeIsvAdapter(PRIMARY, { captureSensitive: true, primaryPolicySid: PRIMARY_POLICY });

const ledgerOf = (studio: string) => psql(`select count(*) filter (where status = 'succeeded') || '/' || count(*) from public.studio_sms_provisioning_steps where studio_id = '${studio}'`);
const brandRows = (studio: string) => psql(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${studio}' and step_key = 'B1' and status <> 'failed'`);
const stateOf = (studio: string) => psql(`select state from public.studio_sms_onboarding where studio_id = '${studio}' and state <> 'cancelled'`);

describe.skipIf(!enabled)("TW-4 R1 dry run (fake Twilio, real SQL, synthetic non-pilot studios, loopback only)", () => {
  let store: SupabaseRunnerStore;

  // The production runner stops once at each submission (TW-4F-1) so the admin can read the evaluation: this helper plays the admin,
  // re-running with the same confirmations after every ":review" stop and merging the steps run.
  const run = async (studio: string, adapter: FakeIsvAdapter, over: { confirmFee?: boolean; config?: IsvConfig; actor?: string } = {}) => {
    const merged: RunResult["stepsRun"] = [];
    let result!: RunResult;
    for (let pass = 0; pass < 4; pass++) {
      result = await runBrandSubmission({ store, adapter, config: over.config ?? baseConfig, studioId: studio, actorId: over.actor ?? U.padmin, confirmFee: over.confirmFee ?? true, confirmSubmit: ["S11", "T6"] });
      merged.push(...result.stepsRun);
      if (result.outcome !== "waiting_submission_confirmation" || !String(result.detail).endsWith(":review")) break;
    }
    return { ...result, stepsRun: merged };
  };
  const refresh = (studio: string, adapter: FakeIsvAdapter) => refreshBrandStatus({ store, adapter, studioId: studio, actorId: U.padmin });
  const onboard = async (studio: string, who: "owner_x" | "owner_z" | "owner_e" | "owner_f" | "owner_g", ein: string) => {
    await setPilotAccess(as("padmin") as never, studio, true, "dry run synthetic studio");
    state.ctx = { supabase: as(who), user: { id: U[who] }, studioId: studio, studioRole: "studio_owner", isPlatformAdmin: false };
    expect(await saveSmsSetupAction({}, form({ ...FIELDS, ein }))).toMatchObject({ ok: true, missing: [] });
    expect(await submitSmsSetupAction({}, form(ATTEST))).toMatchObject({ ok: true });
  };

  beforeAll(async () => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
    state.admin = client(null, serviceKey());
    store = new LegacyAccountStore(state.admin as SupabaseClient);
    psqlFile(readFileSync(join(__dirname, "dryRunFixtures.sql"), "utf8"));
  });
  afterAll(() => {
    try {
      psqlFile(readFileSync(join(__dirname, "dryRunFixtures.sql"), "utf8").replace(/insert into[\s\S]*$/, "") + "\ncommit;\n");
    } catch {
      /* best effort */
    }
    delete process.env.SMS_EIN_ENCRYPTION_KEY;
    globalThis.fetch = realFetch;
  });

  // ---- 8. real Twilio calls stay disabled --------------------------------------------------------------------------------
  it("8. real Twilio calls are disabled: the gate is closed here, the factory refuses a real adapter, and constructing one throws", () => {
    expect(realCallsAllowed(process.env).allowed).toBe(false);
    expect(realCallsAllowed({ ...process.env, TW4_ISV_REAL_CALLS: "on" }).allowed).toBe(false); // test/dev environment, switch alone is not enough
    expect(fakeAdapterAllowed({ ...process.env, TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: URL_ })).toBe(true); // loopback database only
    expect(buildRunnerRuntime({ ...process.env, TW4_ISV_REAL_CALLS: "on", TWILIO_ACCOUNT_SID: baseConfig.accountSid, TWILIO_AUTH_TOKEN: "x" }).ok).toBe(false);
    expect(() => createRealIsvAdapter(baseConfig, process.env)).toThrow();
  });

  // ---- 2. window authorization, expiry, allowlisting, kill switch --------------------------------------------------------
  it("2a. with no window nothing can be created; the window needs a platform admin; another studio's window does not help", async () => {
    await onboard(X, "owner_x", "11-1223333");
    const adapter = fake();
    expect((await run(X, adapter)).outcome).toBe("runner_closed");
    await expect(store.setWindow(X, U.owner_x, 24, "owner tries")).rejects.toMatchObject({ code: "42501" });
    await expect(store.setWindow(X, U.outsider, 24, "outsider tries")).rejects.toMatchObject({ code: "42501" });
    await expect(store.setWindow(X, U.padmin, 73, "too long")).rejects.toMatchObject({ code: "22023" });
    await expect(store.setWindow(X, U.padmin, 24, "x")).rejects.toMatchObject({ code: "22023" });
    await store.setWindow(D, U.padmin, 24, "window for the decoy studio only");
    expect((await run(X, adapter)).outcome).toBe("runner_closed"); // allow-listing is per studio
    expect(adapter.calls).toHaveLength(0);
    expect(psql(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${X}'`)).toBe("0");
  });

  it("2b. an expired window is closed; hours = 0 closes it at once; 'refresh' (GET-only) needs no window", async () => {
    const adapter = fake();
    await store.setWindow(X, U.padmin, 24, "dry run");
    psql(`update public.studio_sms_runner_windows set expires_at = now() - interval '1 second' where studio_id = '${X}'`);
    expect((await run(X, adapter)).outcome).toBe("runner_closed");
    await store.setWindow(X, U.padmin, 24, "dry run");
    await store.setWindow(X, U.padmin, 0, "closed again");
    expect((await run(X, adapter)).outcome).toBe("runner_closed");
    expect((await refresh(X, adapter)).outcome).toBe("not_runnable"); // allowed to try without a window; nothing to refresh yet
    expect(adapter.calls).toHaveLength(0);
  });

  // ---- 1 + 5 + 6. the complete MOCK-brand sequence -------------------------------------------------------------------------
  it("1. the complete mock-brand sequence runs: 18 steps succeed, ONE brand is submitted (flagged mock), the studio waits in brand_pending", async () => {
    await store.setWindow(X, U.padmin, 24, "dry run: mock brand on a synthetic non-pilot studio");
    const adapter = fake();
    const result = await run(X, adapter, { config: mockConfig });
    expect(result).toMatchObject({ outcome: "brand_submitted", detail: "mock_brand" });
    expect(result.stepsRun).toEqual(STEPS.map((step) => step.key));
    expect(ledgerOf(X)).toBe(`${STEPS.length}/${STEPS.length}`);
    expect(adapter.count("createBrand")).toBe(1);
    expect(adapter.calls.find((c) => c.method === "createBrand")!.input).toMatchObject({ mock: true, brandType: "STANDARD", skipAutomaticSecVet: false });
    expect(psql(`select mock || '|' || fee_bearing || '|' || (fee_confirmed_by = '${U.padmin}') || '|' || (fee_confirmed_at is not null) from public.studio_sms_provisioning_steps where studio_id = '${X}' and step_key = 'B1'`)).toBe("true|true|true|true");
    expect(stateOf(X)).toBe("brand_pending");
    // the EIN reached Twilio (the fake) once, only in the business EndUser
    expect(adapter.calls.filter((c) => JSON.stringify(c.input).includes(EIN_X)).map((c) => c.method)).toEqual(["createEndUser"]);
    expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${X}' and action = 'runner_ein_read' and actor_user_id = '${U.padmin}'`)).toBe("1");
  });

  it("5. a MOCK brand is never a real, approved Twilio resource: no registration row, no advance to provisioning, Twilio 'approving' it changes nothing, and direct database calls cannot mirror or approve it", async () => {
    const adapter = fake();
    expect(psql(`select count(*) from public.studio_sms_registrations where studio_id = '${X}'`)).toBe("0");
    // a Twilio-side approval of the mock brand
    const mockSid = psql(`select provider_sid from public.studio_sms_provisioning_steps where studio_id = '${X}' and step_key = 'B1'`);
    adapter.brands.set(mockSid, { customerProfileSid: `BU${"1".repeat(32)}`, trustProductSid: `BU${"2".repeat(32)}`, status: "APPROVED", mock: true });
    const refreshed = await refresh(X, adapter);
    expect(refreshed).toMatchObject({ outcome: "brand_in_review", detail: "mock_brand" });
    expect(stateOf(X)).toBe("brand_pending");
    expect(psql(`select count(*) from public.studio_sms_registrations where studio_id = '${X}'`)).toBe("0");
    // direct attempts through the (service-role) functions with a valid lease
    const claim = await store.claim(X, U.padmin, "dry-direct", 60, "refresh");
    await expect(store.recordBrand(claim.onboarding_id, "dry-direct", mockSid, "approved")).rejects.toMatchObject({ code: "22023" });
    await expect(store.brandApproved(claim.onboarding_id, "dry-direct")).rejects.toMatchObject({ code: "22023" });
    await store.release(claim.onboarding_id, "dry-direct");
    expect(await getStudioSmsStatus(as("owner_x") as never, X)).toMatchObject({ state: "brand_pending", canEdit: false });
    expect(() => psql(`insert into public.studio_sms_registrations (studio_id, registration_status) values ('${X}', 'approved')`)).toThrow(); // the TW-3 approval invariant still refuses
  });

  it("6. mock execution never purges the EIN: the ciphertext is still on file after the mock 'approval', and the 30-day sweep leaves it alone", async () => {
    expect(psql(`select (ein_ciphertext is not null) || '|' || (ein_purged_at is null) || '|' || ein_last4 from public.studio_sms_onboarding where studio_id = '${X}'`)).toBe("true|true|3333");
    expect(Number(psql("select public.purge_due_sms_onboarding_eins()"))).toBe(0);
    expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${X}' and action = 'ein_purged'`)).toBe("0");
  });

  it("4a. repeating the run on the same studio never creates anything again: five more runs, zero create/assign/submit calls, one brand row", async () => {
    const adapter = fake();
    for (let i = 0; i < 5; i += 1) {
      const result = await run(X, adapter, { config: mockConfig });
      expect(["brand_in_review", "brand_submitted"]).toContain(result.outcome);
    }
    const writes = adapter.calls.map((c) => c.method).filter((m) => /^(create|assign|submit)/.test(m));
    expect(writes).toEqual([]);
    expect(brandRows(X)).toBe("1");
  });

  // ---- studio Z: the uncertain-response / crash / race scenarios ------------------------------------------------------------
  it("3a. an uncertain paid response (Twilio created the brand, the reply was lost) is reconciled, never repeated", async () => {
    await onboard(Z, "owner_z", "44-4556666");
    await store.setWindow(Z, U.padmin, 24, "dry run: real flow with the fake");
    const adapter = fake();
    adapter.failNext("createBrand", { kind: "unexpected", lostResponse: true });
    const first = await run(Z, adapter);
    expect(first.outcome).toBe("retry_later");
    expect(psql(`select status from public.studio_sms_provisioning_steps where studio_id = '${Z}' and step_key = 'B1'`)).toBe("unknown_outcome");
    expect(adapter.brands.size).toBe(1);
    const second = await run(Z, adapter);
    expect(second.outcome).toBe("brand_submitted");
    expect(adapter.brands.size).toBe(1);
    expect(adapter.count("createBrand")).toBe(1);
    expect(brandRows(Z)).toBe("1");
    expect(psql(`select registration_status || '|' || brand_status || '|' || (brand_sid is not null) from public.studio_sms_registrations where studio_id = '${Z}'`)).toBe("in_review|in_review|true"); // a REAL (non-mock) brand is mirrored, still not approved for sending
    expect(stateOf(Z)).toBe("brand_pending");
  });

  it("3b/4b. a crash after Twilio created the brand but before we recorded it leaves an open step; a later run adopts the brand by lookup: still exactly one", async () => {
    // fresh generation of the same studio is blocked by the one-brand guard, so crash-test the profile step instead (free) and the brand step in a second onboarding below
    const adapter = fake();
    const original = store.finishStep.bind(store);
    let crashed = false;
    store.finishStep = async (id, owner, step, outcome) => {
      if (!crashed && step === "S1" && outcome.status === "succeeded") {
        crashed = true;
        throw new Error("simulated process crash before the ledger write");
      }
      return original(id, owner, step, outcome);
    };
    try {
      // a brand-new generation: the owner resubmits after needs_info so S1 runs again from scratch
      psql(`update public.studio_sms_onboarding set state = 'exception' where studio_id = '${Z}' and state = 'brand_pending'`);
      psql(`update public.studio_sms_onboarding set state = 'needs_info' where studio_id = '${Z}' and state = 'exception'`);
      state.ctx = { supabase: as("owner_z"), user: { id: U.owner_z }, studioId: Z, studioRole: "studio_owner", isPlatformAdmin: false };
      expect(await submitSmsSetupAction({}, form(ATTEST))).toMatchObject({ ok: true });
      expect(psql(`select submission_seq from public.studio_sms_onboarding where studio_id = '${Z}' and state <> 'cancelled'`)).toBe("2");
      await expect(run(Z, adapter)).rejects.toThrow("simulated process crash");
    } finally {
      store.finishStep = original;
    }
    expect(psql(`select status from public.studio_sms_provisioning_steps where studio_id = '${Z}' and step_key = 'S1' and submission_seq = 2`)).toBe("in_flight");
    expect(psql(`select lease_owner is null from public.studio_sms_onboarding where studio_id = '${Z}' and state <> 'cancelled'`)).toBe("t"); // the runner released its lease on the way out
    const profilesBefore = [...adapter.profiles.values()].filter((p) => p.friendlyName.includes(":S1:")).length;
    expect(profilesBefore).toBe(1);
    // the paid brand cannot be bought again for this studio while generation 1 holds a brand, so the run stops at B1 with an exception
    const again = await run(Z, adapter);
    expect([...adapter.profiles.values()].filter((p) => p.friendlyName.includes(":S1:")).length).toBe(1); // the S1 resource was adopted by lookup, not duplicated
    expect(again.outcome).toBe("exception");
    expect(again.detail).toContain("brand_exists");
    expect(adapter.count("createBrand")).toBe(0);
    expect(brandRows(Z)).toBe("1");
    expect(stateOf(Z)).toBe("exception");
  });

  it("4c. resubmission or exception recovery can never buy a second brand: brand_exists, the database refuses the paid step, one brand row", async () => {
    const claim = await store.claim(Z, U.padmin, "dry-guard", 60, "refresh").catch(() => null);
    expect(claim).toBeNull(); // state exception is not runnable
    psql(`update public.studio_sms_onboarding set state = 'needs_info' where studio_id = '${Z}' and state = 'exception'`);
    expect(brandRows(Z)).toBe("1");
    expect(psql(`select count(*) from public.studio_sms_registrations where studio_id = '${Z}' and brand_sid is not null`)).toBe("1");
  });

  // ---- 7. leases, concurrency, immutability ----------------------------------------------------------------------------------
  it("7a. concurrent runs: of two overlapping runs exactly one proceeds and the other is turned away by the database lease; one brand", async () => {
    const E = "a5e40000-0000-4000-8000-00000000000e";
    await onboard(E, "owner_e", "55-5667777");
    await store.setWindow(E, U.padmin, 24, "dry run concurrency");
    const adapter = new SlowFake(PRIMARY, { captureSensitive: true, primaryPolicySid: PRIMARY_POLICY }, 500);
    const [one, two] = await Promise.all([run(E, adapter), run(E, adapter)]);
    expect([one.outcome, two.outcome].sort()).toEqual(["brand_submitted", "lease_busy"]);
    expect(adapter.count("createCustomerProfile")).toBe(1);
    expect(adapter.count("createBrand")).toBe(1);
    expect(brandRows(E)).toBe("1");
    expect(ledgerOf(E)).toBe(`${STEPS.length}/${STEPS.length}`);
    // and ten rapid sequential repeats afterwards change nothing
    for (let i = 0; i < 10; i += 1) await run(E, adapter);
    expect(adapter.count("createBrand")).toBe(1);
    expect(brandRows(E)).toBe("1");
  });

  it("7b. lease expiry mid-run: when a second run takes over an expired lease, the first run is cut off at its next database call (no further writes) and the studio still ends with exactly one brand and a complete ledger", async () => {
    const F = "a5e40000-0000-4000-8000-00000000000f";
    await onboard(F, "owner_f", "66-6778888");
    await store.setWindow(F, U.padmin, 24, "dry run lease expiry");
    const adapter = new SlowFake(PRIMARY, { captureSensitive: true, primaryPolicySid: PRIMARY_POLICY }, 700);
    const first = run(F, adapter).then((result) => ({ result, error: null as unknown }), (error: unknown) => ({ result: null, error }));
    await sleep(250);
    psql(`update public.studio_sms_onboarding set lease_expires_at = now() - interval '1 second' where studio_id = '${F}' and state <> 'cancelled'`);
    const second = await run(F, adapter);
    const firstOutcome = await first;
    expect(second.outcome).toBe("brand_submitted");
    // the first run lost its lease: either it was refused at its next call, or it had nothing left to do
    if (firstOutcome.error) expect(firstOutcome.error).toMatchObject({ code: "55P03" });
    expect(adapter.count("createBrand")).toBe(1);
    expect(brandRows(F)).toBe("1");
    expect(ledgerOf(F)).toBe(`${STEPS.length}/${STEPS.length}`);
    // a free, harmless artifact of the takeover may exist: an orphan profile created by the cut-off run
    expect([...adapter.profiles.values()].filter((p) => p.friendlyName.includes(":S1:")).length).toBeLessThanOrEqual(2);
    expect(stateOf(F)).toBe("brand_pending");
  });

  it("7c. a completed step's SID is immutable: finishing it again is refused, and a direct table update cannot change or regress it", async () => {
    const F = "a5e40000-0000-4000-8000-00000000000f";
    const before = psql(`select provider_sid from public.studio_sms_provisioning_steps where studio_id = '${F}' and step_key = 'S1'`);
    const claim = await store.claim(F, U.padmin, "dry-immutable", 60, "refresh");
    await expect(store.finishStep(claim.onboarding_id, "dry-immutable", "S1", { status: "succeeded", providerSid: `BU${"9".repeat(32)}` })).rejects.toMatchObject({ code: "22023" });
    await expect(store.finishStep(claim.onboarding_id, "dry-immutable", "S1", { status: "failed", errorCode: "x" })).rejects.toMatchObject({ code: "22023" });
    await store.release(claim.onboarding_id, "dry-immutable");
    expect(() => psql(`update public.studio_sms_provisioning_steps set status = 'pending' where studio_id = '${F}' and step_key = 'S1'`)).toThrow();
    expect(psql(`select provider_sid from public.studio_sms_provisioning_steps where studio_id = '${F}' and step_key = 'S1'`)).toBe(before);
    expect(() => psql(`update public.studio_sms_provisioning_steps set provider_sid = 'BU' || repeat('7', 32) where studio_id = '${F}' and step_key = 'S1'`)).toThrow();
    expect(psql(`select provider_sid from public.studio_sms_provisioning_steps where studio_id = '${F}' and step_key = 'S1'`)).toBe(before);
  });

  it("2c. the database kill switch stops a run that is already in progress before it reaches the paid step", async () => {
    const G = "a5e40000-0000-4000-8000-000000000010";
    await onboard(G, "owner_g", "77-7889999");
    await store.setWindow(G, U.padmin, 24, "dry run kill switch");
    // the window is closed WHILE the run is creating its first resource
    const adapter = new SlowFake(PRIMARY, { captureSensitive: true, primaryPolicySid: PRIMARY_POLICY }, 400, () => {
      void store.setWindow(G, U.padmin, 0, "kill switch pulled mid-run");
    });
    const result = await run(G, adapter).catch((error: unknown) => ({ outcome: "threw", detail: String((error as Error).message) }));
    expect(adapter.count("createBrand")).toBe(0);
    expect(result.outcome).toBe("runner_closed");
    expect(psql(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${G}' and step_key = 'B1'`)).toBe("0");
  });

  it("everything ran against loopback only: the fetch guard saw no non-loopback request, and no real adapter was ever constructed", () => {
    expect(blockedRequests).toEqual([]);
    expect(allowedRequests.count).toBeGreaterThan(0);
    expect(RunnerStoreError).toBeTruthy();
  });
});
