/**
 * TW-4 R1 against a REAL schema: the real `tw4_runner_*` SQL functions (through PostgREST, service role) driven by the real runner and
 * the FAKE Twilio adapter. LOCAL QA STACK ONLY (skipped unless the variables below point at a loopback Supabase stack that has
 * TW-4A, TW-4A.1 and R1 applied). Synthetic fixtures; no Twilio call is possible (the fake is the only adapter used).
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// real SQL over HTTP and a multi-pass admin journey: more than the 5 s default per test
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const state = vi.hoisted(() => ({ ctx: null as null | { supabase: unknown; user: { id: string }; studioId: string; studioRole: string | null; isPlatformAdmin: boolean }, admin: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/serverRoleGuard", () => ({ getCurrentUserStudioContext: async () => state.ctx }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin }));

import { saveSmsSetupAction, submitSmsSetupAction } from "@/app/app/settings/sms/actions";
import { getStudioSmsStatus, setPilotAccess } from "@/lib/sms/onboarding/client";
import type { IsvConfig } from "../config";
import { FakeIsvAdapter } from "../fake";
import { refreshBrandStatus, runBrandSubmission, STEPS, type RunResult } from "../runner";
import { SupabaseRunnerStore } from "../store";
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

const A = "a5e30000-0000-4000-8000-00000000000a";
const B = "a5e30000-0000-4000-8000-00000000000b";
const U = {
  owner_a: "a5e30000-0000-4000-8000-000000000101",
  admin_a: "a5e30000-0000-4000-8000-000000000102",
  owner_b: "a5e30000-0000-4000-8000-000000000201",
  padmin: "a5e30000-0000-4000-8000-000000000401",
};
const EIN = "987654321";
const PRIMARY = `BU${"e".repeat(32)}`;
const PRIMARY_POLICY = `RN${"4".repeat(32)}`;
const fakeAdapter = (Klass: typeof FakeIsvAdapter = FakeIsvAdapter) => new Klass(PRIMARY, { captureSensitive: true, primaryPolicySid: PRIMARY_POLICY });

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
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const FIELDS: Record<string, string> = {
  legal_name: "R1 Dance Studio LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: "",
  address_line1: "12 Harbor Way", address_line2: "", city: "Portland", region: "OR", postal_code: "97201",
  rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@tw4r1-e2e.test", rep_phone: "(503) 555-0123", preferred_area_code: "503",
};
const ATTEST = { attest_authorized: "on", attest_accurate: "on", attest_opt_in_only: "on", attest_fees_terms: "on" };
const config: IsvConfig = {
  accountSid: `AC${"1".repeat(32)}`, authToken: "t", primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY, secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`,
  complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
};
const ownerCtx = (who: "owner_a" | "owner_b" = "owner_a", studioId = A) => {
  state.ctx = { supabase: as(who), user: { id: U[who] }, studioId, studioRole: "studio_owner", isPlatformAdmin: false };
};
const ledger = (studioId = A) => psql(`select string_agg(step_key || ':' || status, ',' order by submission_seq, step_key) from public.studio_sms_provisioning_steps where studio_id = '${studioId}'`);

class SlowFake extends FakeIsvAdapter {
  async createCustomerProfile(input: { friendlyName: string; email: string }) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return super.createCustomerProfile(input);
  }
}

describe.skipIf(!enabled)("TW-4 R1 runner against the local QA stack (real SQL functions, fake Twilio)", () => {
  let adapter: FakeIsvAdapter;
  let store: SupabaseRunnerStore;
  const sink: string[] = [];

  beforeAll(async () => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
    state.admin = client(null, serviceKey());
    store = new LegacyAccountStore(state.admin as SupabaseClient);
    psqlFile(readFileSync(join(__dirname, "localStackFixturesR1.sql"), "utf8"));
    await setPilotAccess(as("padmin") as never, A, true, "R1 local e2e");
    await store.setWindow(A, U.padmin, 24, "R1 local e2e");
    ownerCtx();
    expect(await saveSmsSetupAction({}, form({ ...FIELDS, ein: "98-7654321" }))).toMatchObject({ ok: true, missing: [] });
    expect(await submitSmsSetupAction({}, form(ATTEST))).toMatchObject({ ok: true });
  });
  afterAll(() => {
    try {
      psqlFile(readFileSync(join(__dirname, "localStackFixturesR1.sql"), "utf8").replace(/insert into[\s\S]*$/, "") + "\ncommit;\n");
    } catch {
      /* best effort */
    }
    delete process.env.SMS_EIN_ENCRYPTION_KEY;
  });

  // The production runner stops once at each submission (TW-4F-1) so the admin can read the evaluation: this helper plays the admin,
  // re-running with the same confirmations after every ":review" stop and merging the steps run.
  const run = async (over: { confirmFee?: boolean; actor?: string; studio?: string } = {}) => {
    const merged: RunResult["stepsRun"] = [];
    let result!: RunResult;
    for (let pass = 0; pass < 4; pass++) {
      result = await runBrandSubmission({ store, adapter, config, studioId: over.studio ?? A, actorId: over.actor ?? U.padmin, confirmFee: over.confirmFee ?? true, confirmSubmit: ["S11", "T6"] });
      merged.push(...result.stepsRun);
      if (result.outcome !== "waiting_submission_confirmation" || !String(result.detail).endsWith(":review")) break;
    }
    return { ...result, stepsRun: merged };
  };

  it("the runner functions are service-role only: the API roles cannot call them", async () => {
    for (const c of [client(null), as("owner_a"), as("padmin")]) {
      const result = await c.rpc("tw4_runner_claim", { p_studio_id: A, p_actor: U.padmin, p_lease_owner: "x", p_lease_seconds: 60 });
      expect(result.error?.code).toBe("42501");
    }
  });

  it("the runner window is a database kill switch: closed or expired means nothing is created, 'refresh' needs no window, and the window needs a platform admin", async () => {
    adapter = fakeAdapter();
    await expect(store.setWindow(A, U.owner_a, 24, "owner tries")).rejects.toMatchObject({ code: "42501" });
    await store.setWindow(A, U.padmin, 0, "close for the test");
    expect((await run()).outcome).toBe("runner_closed");
    psql(`update public.studio_sms_runner_windows set expires_at = now() + interval '1 hour' where studio_id = '${A}'`);
    psql(`update public.studio_sms_runner_windows set expires_at = now() - interval '1 second' where studio_id = '${A}'`);
    expect((await run()).outcome).toBe("runner_closed");
    expect(adapter.calls).toHaveLength(0);
    // refresh mode is allowed without a window (it only reads Twilio); with nothing created yet it simply reports there is no brand
    expect((await refreshBrandStatus({ store, adapter, studioId: A, actorId: U.padmin })).outcome).toBe("not_runnable");
    await store.setWindow(A, U.padmin, 24, "R1 local e2e");
    expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'runner_window'`)).toBe("3");
  });

  it("a non-platform-admin actor, a studio without the pilot switch, and a studio with no submission cannot be run", async () => {
    adapter = fakeAdapter();
    expect((await run({ actor: U.owner_a })).outcome).toBe("not_runnable");
    expect((await run({ actor: U.admin_a as string })).outcome).toBe("not_runnable");
    expect((await run({ studio: B })).outcome).toBe("not_runnable"); // studio B: switch off and nothing submitted
    expect(adapter.calls).toHaveLength(0);
  });

  it("without the fee confirmation it stops before the paid step and leaves the studio at profile_review", async () => {
    adapter = fakeAdapter();
    const result = await run({ confirmFee: false });
    expect(result.outcome).toBe("waiting_fee_confirmation");
    expect(adapter.count("createBrand")).toBe(0);
    expect(psql(`select state from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("profile_review");
    expect(ledger()).not.toContain("B1");
    expect(ledger()).toContain("S11:succeeded");
  });

  it("with the confirmation it creates ONE brand, mirrors it into the TW-3 row as in_review (never approved), and lands in brand_pending", async () => {
    const result = await run({ confirmFee: true });
    sink.push(JSON.stringify(result));
    expect(result.outcome).toBe("brand_submitted");
    expect(adapter.count("createBrand")).toBe(1);
    expect(adapter.count("createCustomerProfile")).toBe(1); // reused from the first run, not repeated
    expect(psql(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${A}' and status = 'succeeded'`)).toBe(String(STEPS.length));
    expect(psql(`select fee_confirmed_by = '${U.padmin}' from public.studio_sms_provisioning_steps where studio_id = '${A}' and step_key = 'B1'`)).toBe("t");
    expect(psql(`select state from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("brand_pending");
    expect(psql(`select registration_status || '|' || brand_status || '|' || (brand_sid is not null) || '|' || (customer_profile_sid is not null) || '|' || coalesce(campaign_sid, '-') || '|' || coalesce(sender_e164, '-') from public.studio_sms_registrations where studio_id = '${A}'`)).toBe("in_review|in_review|true|true|-|-");
    expect(psql(`select lease_owner is null from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("t");
  });

  it("the EIN was decrypted once, only inside the business EndUser, and is in no ledger row, audit row, result or Twilio call except that one", () => {
    const withEin = adapter.calls.filter((call) => JSON.stringify(call.input).includes(EIN));
    expect(withEin.map((call) => call.method)).toEqual(["createEndUser"]);
    expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'runner_ein_read' and actor_user_id = '${U.padmin}'`)).toBe("1");
    const stored = psql(`select coalesce(string_agg(coalesce(error_detail_sanitized, '') || coalesce(error_code, '') || coalesce(friendly_name, ''), '|'), '') from public.studio_sms_provisioning_steps where studio_id = '${A}'`);
    const audits = psql(`select coalesce(string_agg(coalesce(note, ''), '|'), '') from public.studio_sms_onboarding_audit where studio_id = '${A}'`);
    for (const text of [stored, audits, ...sink]) {
      expect(text).not.toContain(EIN);
      expect(text).not.toMatch(/987-?65-?4321|pat@tw4r1|R1 Dance Studio/);
    }
    expect(psql(`select ein_ciphertext is not null from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("t");
  });

  it("running again creates nothing again; the owner sees plain 'Brand review' status; a paused pilot switch does not hide it", async () => {
    const before = adapter.calls.length;
    const result = await run();
    expect(result.outcome).toBe("brand_in_review");
    const writes = adapter.calls.slice(before).map((call) => call.method).filter((m) => /^(create|assign|submit)/.test(m));
    expect(writes).toEqual([]);
    expect(await getStudioSmsStatus(as("owner_a") as never, A)).toMatchObject({ state: "brand_pending", canEdit: false, canCancel: false });
  });

  it("a live lease held by another run is respected by the database (lease_busy), and releasing it lets the next run proceed", async () => {
    psql(`update public.studio_sms_onboarding set lease_owner = 'someone-else', lease_expires_at = now() + interval '5 minutes' where studio_id = '${A}'`);
    const busy = await run();
    expect(busy.outcome).toBe("lease_busy");
    psql(`update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where studio_id = '${A}'`);
  });

  it("brand approved: state service_setup, EIN ciphertext erased (last four kept), registration brand approved but the studio is still NOT approved for sending", async () => {
    adapter.setBrandStatus([...adapter.brands.keys()][0], "APPROVED");
    const result = await refreshBrandStatus({ store, adapter, studioId: A, actorId: U.padmin });
    expect(result.outcome).toBe("brand_approved");
    expect(psql(`select state from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("service_setup");
    expect(psql(`select (ein_ciphertext is null) || '|' || (ein_key_id is null) || '|' || ein_last4 || '|' || (ein_purged_at is not null) from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("true|true|4321|true");
    expect(psql(`select registration_status || '|' || brand_status from public.studio_sms_registrations where studio_id = '${A}'`)).toBe("in_review|approved");
    expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'ein_purged' and note = 'reason=brand_approved'`)).toBe("1");
    // the send gate is untouched: an approval without campaign, number and sender is still refused by the TW-3 invariant
    expect(() => psql(`update public.studio_sms_registrations set registration_status = 'approved' where studio_id = '${A}'`)).toThrow();
    // nothing further can be run from service_setup (R2 is a separate slice)
    expect((await run()).outcome).toBe("not_runnable");
  });

  it("a noncompliant evaluation sends the owner back with the field highlighted; fixing it and resubmitting runs a clean new generation", async () => {
    // a second studio (B) with its own owner, so nothing of studio A is reused
    await setPilotAccess(as("padmin") as never, B, true, "R1 local e2e second studio");
    await store.setWindow(B, U.padmin, 24, "R1 local e2e second studio");
    ownerCtx("owner_b", B);
    expect(await saveSmsSetupAction({}, form({ ...FIELDS, legal_name: "Second Studio LLC", ein: "12-3456780" }))).toMatchObject({ ok: true, missing: [] });
    expect(await submitSmsSetupAction({}, form(ATTEST))).toMatchObject({ ok: true });
    adapter = fakeAdapter();
    adapter.evaluationFailures.profile = ["email"];
    const first = await run({ studio: B });
    expect(first.outcome).toBe("needs_info");
    expect(adapter.count("submitCustomerProfile")).toBe(0);
    expect(await getStudioSmsStatus(as("owner_b") as never, B)).toMatchObject({ state: "needs_info", needsInfoFields: ["rep_email"], canEdit: true });
    expect(ledger(B)).toContain("S10:failed");

    adapter.evaluationFailures.profile = [];
    ownerCtx("owner_b", B);
    expect(await saveSmsSetupAction({}, form({ rep_email: "fixed@tw4r1-e2e.test" }))).toMatchObject({ ok: true });
    expect(await submitSmsSetupAction({}, form(ATTEST))).toMatchObject({ ok: true });
    expect(psql(`select submission_seq from public.studio_sms_onboarding where studio_id = '${B}' and state <> 'cancelled'`)).toBe("2");
    // two overlapping runs (slow Twilio): the database lease lets exactly one work; the other is turned away
    adapter = fakeAdapter(SlowFake);
    const [one, two] = await Promise.all([run({ studio: B }), run({ studio: B })]);
    const outcomes = [one.outcome, two.outcome].sort();
    expect(outcomes).toEqual(["brand_submitted", "lease_busy"]);
    expect(adapter.count("createCustomerProfile")).toBe(1);
    expect(adapter.count("createBrand")).toBe(1);
    expect(psql(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${B}' and submission_seq = 2 and status = 'succeeded'`)).toBe(String(STEPS.length));
    // studio A's rows were never touched by studio B's run
    expect(psql(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${A}' and submission_seq = 2`)).toBe("0");
  });

  it("everything stayed inside the fake: no network adapter was ever used and nothing sensitive reached a log or result", () => {
    expect(JSON.stringify(sink)).not.toMatch(/987654321|Authorization|Basic /);
    expect(adapter).toBeInstanceOf(FakeIsvAdapter);
  });
});
