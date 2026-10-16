/**
 * TW-4A end-to-end checks of the REAL application code (server actions, RPC wrappers, EIN encryption) against a REAL database
 * schema through PostgREST with real JWTs. LOCAL QA STACK ONLY: skipped unless the variables below point at a loopback Supabase
 * stack that has the TW-4A migrations applied (20261119090000 + 20261119091000). Fixtures are synthetic (reserved test domain) and
 * are removed afterwards. It never touches DEV or PROD and never contacts Twilio.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 *   (anon / service-role keys are derived from the secret; nothing is read from or written to tracked files)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ctx: null as null | { supabase: unknown; user: { id: string }; studioId: string; studioRole: string | null; isPlatformAdmin: boolean },
  admin: null as unknown,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/serverRoleGuard", () => ({ getCurrentUserStudioContext: async () => state.ctx }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin }));

import { cancelSmsSetupAction, saveSmsSetupAction, submitSmsSetupAction } from "@/app/app/settings/sms/actions";
import { decryptEin } from "@/lib/sms/onboarding/ein";
import {
  getOnboardingDraft,
  getStudioSmsStatus,
  listOnboardings,
  OnboardingRpcError,
  setPilotAccess,
} from "@/lib/sms/onboarding/client";
import { ONBOARDING_STATES, STATE_DETAILS, STATE_LABELS, ownerCanCancel, trackerSteps } from "@/lib/sms/onboarding/stateMachine";

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

const A = "a5e20000-0000-4000-8000-00000000000a";
const B = "a5e20000-0000-4000-8000-00000000000b";
const D = "a5e20000-0000-4000-8000-00000000000d";
const U = {
  owner_a: "a5e20000-0000-4000-8000-000000000101",
  admin_a: "a5e20000-0000-4000-8000-000000000102",
  fd_a: "a5e20000-0000-4000-8000-000000000103",
  instr_a: "a5e20000-0000-4000-8000-000000000104",
  owner_b: "a5e20000-0000-4000-8000-000000000201",
  padmin: "a5e20000-0000-4000-8000-000000000401",
  outsider: "a5e20000-0000-4000-8000-000000000999",
};
const EIN_DIGITS = "987654321";
const EIN_TEXT = "98-7654321";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp: 1983812996 }) : "");
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const userToken = (sub: string) => sign({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
function client(token: string | null, key = anonKey()): SupabaseClient {
  return createClient(URL_, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  });
}
const as = (who: keyof typeof U) => client(userToken(U[who]));
function psql(sql: string): string {
  return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
}
function psqlFile(sql: string) {
  execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
}
function ctxFor(who: keyof typeof U, role: string | null, studioId = A) {
  state.ctx = { supabase: as(who), user: { id: U[who] }, studioId, studioRole: role, isPlatformAdmin: role === "platform_admin" };
}
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const FIELDS: Record<string, string> = {
  legal_name: "E2E Harbor Dance Studio LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: "",
  address_line1: "12 Harbor Way", address_line2: "", city: "Portland", region: "OR", postal_code: "97201",
  rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@tw4a-e2e.test",
  rep_phone: "(503) 555-0123", preferred_area_code: "503",
};
const ATTEST = { attest_authorized: "on", attest_accurate: "on", attest_opt_in_only: "on", attest_fees_terms: "on" };
const row = (sql: string) => psql(sql);

const captured: string[] = [];
const logSpies: ReturnType<typeof vi.spyOn>[] = [];
const track = (value: unknown) => {
  captured.push(JSON.stringify(value));
  return value;
};

describe.skipIf(!enabled)("TW-4A against the local QA stack (real schema, real JWTs)", () => {
  beforeAll(() => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
    state.admin = client(null, serviceKey());
    psqlFile(readFileSync(join(__dirname, "localStackFixtures.sql"), "utf8"));
    for (const level of ["log", "warn", "error", "info", "debug"] as const) logSpies.push(vi.spyOn(console, level).mockImplementation(() => {}));
  });
  afterAll(() => {
    logSpies.forEach((spy) => spy.mockRestore());
    try {
      psqlFile(readFileSync(join(__dirname, "localStackFixtures.sql"), "utf8").replace(/insert into[\s\S]*$/, "") + "\ncommit;\n");
    } catch {
      /* best effort */
    }
    delete process.env.SMS_EIN_ENCRYPTION_KEY;
  });

  it("the schema under test is the TW-4A one, the tables are not reachable through the API, and TW-1/2 code is untouched", async () => {
    expect(row("select count(*) from pg_proc where proname in ('get_studio_sms_status','get_sms_legal_context','submit_sms_onboarding')")).toBe("3");
    expect(row("select position('can_cancel' in prosrc) > 0 from pg_proc where proname = 'get_studio_sms_status'")).toBe("t");
    for (const who of [null, userToken(U.owner_a), userToken(U.padmin)]) {
      const response = await fetch(`${URL_}/rest/v1/studio_sms_onboarding?select=*`, { headers: { apikey: anonKey(), ...(who ? { Authorization: `Bearer ${who}` } : {}) } });
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toMatch(/ein_ciphertext|legal_name/);
    }
    // no pre-existing SMS consent/sending/inbound function was edited to depend on the onboarding tables
    expect(row("select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%sms%' and p.prosrc ilike '%studio_sms_onboarding%' and p.proname not in ('set_sms_onboarding_access','list_sms_onboardings','get_studio_sms_status','get_sms_onboarding_draft','save_sms_onboarding_draft','submit_sms_onboarding','cancel_sms_onboarding','store_sms_onboarding_ein','purge_sms_onboarding_ein','purge_due_sms_onboarding_eins','get_sms_legal_context') and p.proname not like '\\_sms\\_onb\\_%'")).toBe("0");
  });

  it("the pilot is OFF by default: the owner sees nothing, cannot start, and nothing is written", async () => {
    const status = await getStudioSmsStatus(as("owner_a") as never, A);
    expect(status).toEqual({ available: false, textingOn: false });
    ctxFor("owner_a", "studio_owner");
    const result = track(await saveSmsSetupAction({}, form({ ...FIELDS, ein: EIN_TEXT })));
    expect(result).toMatchObject({ ok: false, error: "You do not have access to this setup." });
    expect(row(`select count(*) from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("0");
    // anonymous callers cannot even call the RPC
    const anon = await client(null).rpc("get_studio_sms_status", { p_studio_id: A });
    expect(anon.error?.code).toBe("42501");
  });

  it("only a platform admin can switch the pilot on, with a reason", async () => {
    await expect(setPilotAccess(as("owner_a") as never, A, true, "self service")).rejects.toMatchObject({ code: "42501" });
    await expect(setPilotAccess(as("padmin") as never, A, true, "x")).rejects.toBeInstanceOf(OnboardingRpcError);
    await setPilotAccess(as("padmin") as never, A, true, "ConfiDance pilot (local e2e)");
    expect(await getStudioSmsStatus(as("owner_a") as never, A)).toMatchObject({ available: true, paused: false, state: "not_started", canEdit: true, canCancel: false });
    expect(await getStudioSmsStatus(as("owner_b") as never, B).catch(() => null)).toEqual({ available: false, textingOn: false });
    expect(row(`select note from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'access_enabled'`)).toBe("ConfiDance pilot (local e2e)");
  });

  it("owner vs admin vs front desk vs instructor vs outsider vs another studio's owner", async () => {
    const statusFor = async (who: keyof typeof U) => getStudioSmsStatus(as(who) as never, A).catch((error: OnboardingRpcError) => error.code);
    expect(await statusFor("owner_a")).toMatchObject({ role: "studio_owner", canEdit: true });
    expect(await statusFor("admin_a")).toMatchObject({ role: "studio_admin", canEdit: false, canCancel: false });
    expect(await statusFor("fd_a")).toEqual({ available: false, textingOn: false }); // front desk: only whether texting is on
    expect(await statusFor("instr_a")).toBe("42501");
    expect(await statusFor("outsider")).toBe("42501");
    expect(await statusFor("owner_b")).toBe("42501");
    expect(await statusFor("padmin")).toMatchObject({ role: "platform_admin", canEdit: false, canCancel: false });

    // every non-owner is refused by the action before the database, and by the database when a context is forged
    for (const [who, role] of [["admin_a", "studio_admin"], ["fd_a", "front_desk"], ["instr_a", "instructor"], ["padmin", "platform_admin"]] as const) {
      ctxFor(who, role);
      expect(track(await saveSmsSetupAction({}, form(FIELDS)))).toMatchObject({ ok: false });
      expect(track(await submitSmsSetupAction({}, form(ATTEST)))).toMatchObject({ ok: false });
      expect(track(await cancelSmsSetupAction())).toMatchObject({ ok: false });
    }
    ctxFor("owner_b", "studio_owner", A); // forged: another studio's owner claiming studio A
    expect(track(await saveSmsSetupAction({}, form(FIELDS)))).toMatchObject({ ok: false, error: "You do not have access to this setup." });
    ctxFor("admin_a", "studio_owner"); // forged role: the database still refuses an admin
    expect(track(await saveSmsSetupAction({}, form(FIELDS)))).toMatchObject({ ok: false, error: "You do not have access to this setup." });
    expect(row(`select count(*) from public.studio_sms_onboarding where studio_id in ('${A}','${B}')`)).toBe("0");
    for (const who of ["fd_a", "instr_a", "outsider", "owner_b"] as const) {
      await expect(getOnboardingDraft(as(who) as never, A)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("drafts save, merge and resume; invalid input is rejected with the typed values echoed and nothing changed", async () => {
    ctxFor("owner_a", "studio_owner");
    const partial = track(await saveSmsSetupAction({}, form({ legal_name: FIELDS.legal_name, city: "Portland" })));
    expect(partial).toMatchObject({ ok: true });
    expect((partial as { missing: string[] }).missing).toEqual(expect.arrayContaining(["ein", "rep_email"]));
    expect(await saveSmsSetupAction({}, form({ rep_email: "pat@tw4a-e2e.test" }))).toMatchObject({ ok: true });
    const resumed = await getOnboardingDraft(as("owner_a") as never, A);
    expect(resumed?.fields).toMatchObject({ legal_name: FIELDS.legal_name, city: "Portland", rep_email: "pat@tw4a-e2e.test" });
    const adminView = await getOnboardingDraft(as("admin_a") as never, A);
    expect(adminView?.fields.legal_name).toBe(FIELDS.legal_name);

    const bad = track(await saveSmsSetupAction({}, form({ ...FIELDS, region: "Oregon", rep_phone: "12" }))) as { ok: boolean; fieldErrors: object; values: Record<string, string> };
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.fieldErrors).sort()).toEqual(["region", "rep_phone"]);
    expect(bad.values.legal_name).toBe(FIELDS.legal_name);
    expect(row(`select legal_name || '|' || coalesce(region, '-') from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe(`${FIELDS.legal_name}|-`);
  });

  it("the EIN is encrypted before storage, never returned, never logged; the last four is the only thing shown", async () => {
    ctxFor("owner_a", "studio_owner");
    const saved = track(await saveSmsSetupAction({}, form({ ...FIELDS, ein: EIN_TEXT })));
    expect(saved).toMatchObject({ ok: true, missing: [] });
    const stored = row(`select ein_ciphertext || '|' || ein_key_id || '|' || ein_last4 from public.studio_sms_onboarding where studio_id = '${A}'`).split("|");
    expect(stored[0]).not.toContain(EIN_DIGITS);
    expect(stored[1]).toBe("v1");
    expect(stored[2]).toBe("4321");
    expect(decryptEin(A, stored[0])).toBe(EIN_DIGITS); // bound to the studio: another studio id cannot decrypt it
    expect(() => decryptEin(B, stored[0])).toThrow();
    const ownerDraft = track(await getOnboardingDraft(as("owner_a") as never, A));
    const adminDraft = track(await getOnboardingDraft(as("admin_a") as never, A));
    expect(ownerDraft).toMatchObject({ einOnFile: true, einLast4: "4321" });
    expect(adminDraft).toMatchObject({ einOnFile: true, einLast4: "4321" });
    const list = track(await listOnboardings(as("padmin") as never));
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ studioId: A, einStored: true })]));
    expect(row(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'ein_stored' and note is null`)).toBe("1");
  });

  it("a database rejection never leaks row text or the ciphertext, directly or through the action", async () => {
    const direct = await as("owner_a").rpc("save_sms_onboarding_draft", { p_studio_id: A, p_fields: { rep_email: "not-an-email" } });
    expect(direct.error?.code).toBe("23514");
    expect(JSON.stringify(direct.error)).not.toMatch(/Failing row|v1\.|ciphertext|4321|pat@/i);
    expect(direct.error?.details ?? "").toBe("");
    ctxFor("owner_a", "studio_owner");
    const viaAction = track(await saveSmsSetupAction({}, form({ ...FIELDS, rep_email: "not-an-email" })));
    expect(viaAction).toMatchObject({ ok: false });
    expect(JSON.stringify(viaAction)).not.toMatch(/Failing row|v1\.|ciphertext|violates/i);
    expect(row(`select rep_email from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("pat@tw4a-e2e.test");
  });

  it("submission needs every statement and a complete form, locks the setup, and only the owner can submit", async () => {
    ctxFor("owner_a", "studio_owner");
    expect(track(await submitSmsSetupAction({}, form({ attest_authorized: "on" })))).toMatchObject({ ok: false });
    expect(row(`select state from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("draft");
    // direct RPC with a boolean-looking string is refused (strict JSON true)
    const sneaky = await as("owner_a").rpc("submit_sms_onboarding", { p_studio_id: A, p_attestation: { version: "tw4a-v1", authorized: "true", accurate: true, opt_in_only: true, fees_terms: true } });
    expect(sneaky.error?.code).toBe("22023");
    ctxFor("admin_a", "studio_admin");
    expect(track(await submitSmsSetupAction({}, form(ATTEST)))).toMatchObject({ ok: false });

    ctxFor("owner_a", "studio_owner");
    const submitted = track(await submitSmsSetupAction({}, form(ATTEST)));
    expect(submitted).toMatchObject({ ok: true });
    expect(row(`select state || '|' || submission_seq || '|' || (attested_by = '${U.owner_a}') from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("submitted_for_checks|1|true");
    expect(track(await saveSmsSetupAction({}, form(FIELDS)))).toMatchObject({ ok: false, error: "This setup has been submitted and can no longer be edited." });
    expect(track(await submitSmsSetupAction({}, form(ATTEST)))).toMatchObject({ ok: false });
    expect(await getStudioSmsStatus(as("owner_a") as never, A)).toMatchObject({ state: "submitted_for_checks", canEdit: false, canCancel: true, paused: false });
  });

  it("legal pages: served for a submitted setup, for an existing registration, and not for a studio with neither", async () => {
    const svc = state.admin as SupabaseClient;
    const a = await svc.rpc("get_sms_legal_context", { p_studio_slug: "tw4a-e2e-a" });
    expect(a.data).toEqual({ display_name: "E2E Harbor Dance", legal_name: FIELDS.legal_name });
    const c = await svc.rpc("get_sms_legal_context", { p_studio_slug: "tw4a-e2e-c" }); // in_review registration, pilot never enabled
    expect(c.data).toEqual({ display_name: "TW4A E2E Studio C", legal_name: null });
    expect((await svc.rpc("get_sms_legal_context", { p_studio_slug: "tw4a-e2e-d" })).data).toBeNull();
    expect((await svc.rpc("get_sms_legal_context", { p_studio_slug: "no-such-studio" })).data).toBeNull();
    for (const token of [null, userToken(U.owner_a)]) {
      const denied = await client(token).rpc("get_sms_legal_context", { p_studio_slug: "tw4a-e2e-a" });
      expect(denied.error?.code).toBe("42501");
    }
  });

  it("every registration state is represented with plain-language copy, the right cancel window and a five-step tracker", async () => {
    const walk = ["needs_info", "submitted_for_checks", "profile_review", "brand_pending", "service_setup", "campaign_pending", "ready_for_activation", "active", "suspended", "exception", "blocked"] as const;
    const seen = new Set<string>(["submitted_for_checks"]);
    for (const next of walk) {
      psql(`update public.studio_sms_onboarding set state = '${next}' where studio_id = '${A}' and state <> 'cancelled'`);
      seen.add(next);
      const status = track(await getStudioSmsStatus(as("owner_a") as never, A)) as { available: true; state: string; canCancel: boolean; canEdit: boolean };
      expect(status.state).toBe(next);
      expect(status.canCancel).toBe(ownerCanCancel(next));
      expect(status.canEdit).toBe(next === "needs_info");
      expect(STATE_LABELS[next]).toBeTruthy();
      expect(STATE_DETAILS[next]).toBeTruthy();
      expect(trackerSteps(next)).toHaveLength(5);
      expect(`${STATE_LABELS[next]} ${STATE_DETAILS[next]}`).not.toMatch(/twilio|trust ?hub|\bSID\b|\bTCR\b/i);
    }
    for (const name of ONBOARDING_STATES) if (name !== "draft" && name !== "cancelled") expect(seen.has(name)).toBe(true);
    // "texting is on" follows an approved registration, not the onboarding state
    expect(await getStudioSmsStatus(as("owner_a") as never, A)).toMatchObject({ textingOn: false });
    psql(`insert into public.studio_sms_registrations (studio_id, registration_status, customer_profile_sid, brand_sid, brand_status, messaging_service_sid, campaign_sid, campaign_use_case, campaign_status, phone_number_sid, sender_e164) values ('${A}', 'approved', 'BU' || repeat('a', 32), 'BN' || repeat('b', 32), 'approved', 'MG' || repeat('c', 32), 'QE' || repeat('d', 32), 'mixed', 'approved', 'PN' || repeat('e', 32), '+15035550199')`);
    expect(await getStudioSmsStatus(as("owner_a") as never, A)).toMatchObject({ textingOn: true });
    expect(await getStudioSmsStatus(as("fd_a") as never, A)).toEqual({ available: false, textingOn: true });
    psql(`delete from public.studio_sms_registrations where studio_id = '${A}'`);
    // back to a cancellable state for the next scenario (the graph allows exception -> submitted_for_checks)
    psql(`update public.studio_sms_onboarding set state = 'exception' where studio_id = '${A}' and state = 'blocked'`);
    psql(`update public.studio_sms_onboarding set state = 'submitted_for_checks' where studio_id = '${A}' and state = 'exception'`);
  });

  it("the switch turned off AFTER submission: the setup stays visible and read-only, the legal pages stay up, and the owner can cancel; cancelling erases the EIN at once", async () => {
    await setPilotAccess(as("padmin") as never, A, false, "pause for review (local e2e)");
    const paused = await getStudioSmsStatus(as("owner_a") as never, A);
    expect(paused).toMatchObject({ available: true, paused: true, state: "submitted_for_checks", canEdit: false, canCancel: true });
    expect(await getStudioSmsStatus(as("admin_a") as never, A)).toMatchObject({ paused: true, canCancel: false });
    ctxFor("owner_a", "studio_owner");
    expect(track(await saveSmsSetupAction({}, form(FIELDS)))).toMatchObject({ ok: false });
    expect((await (state.admin as SupabaseClient).rpc("get_sms_legal_context", { p_studio_slug: "tw4a-e2e-a" })).data).toMatchObject({ legal_name: FIELDS.legal_name });
    expect(row(`select count(*) from public.studio_sms_onboarding where studio_id = '${A}' and ein_ciphertext is not null`)).toBe("1");

    const cancelled = track(await cancelSmsSetupAction());
    expect(cancelled).toMatchObject({ ok: true });
    expect(row(`select state || '|' || coalesce(ein_ciphertext, 'NULL') || '|' || coalesce(ein_key_id, 'NULL') || '|' || ein_last4 || '|' || (ein_purged_at is not null) from public.studio_sms_onboarding where studio_id = '${A}' and state = 'cancelled'`)).toBe("cancelled|NULL|NULL|4321|true");
    expect(row(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'ein_purged' and note = 'reason=owner_cancel'`)).toBe("1");
    expect(await getStudioSmsStatus(as("owner_a") as never, A)).toEqual({ available: false, textingOn: false });
    expect(row(`select count(*) from public.studio_sms_onboarding where studio_id = '${A}' and state <> 'cancelled'`)).toBe("0");
    expect((await (state.admin as SupabaseClient).rpc("get_sms_legal_context", { p_studio_slug: "tw4a-e2e-a" })).data).toBeNull();
  });

  it("recovery: the pilot comes back, the owner starts a fresh setup, and the cancelled one stays as history without its EIN", async () => {
    await setPilotAccess(as("padmin") as never, A, true, "resume (local e2e)");
    expect(await getStudioSmsStatus(as("owner_a") as never, A)).toMatchObject({ available: true, state: "not_started", canEdit: true, canCancel: false });
    ctxFor("owner_a", "studio_owner");
    expect(track(await saveSmsSetupAction({}, form({ ...FIELDS, ein: EIN_TEXT })))).toMatchObject({ ok: true, missing: [] });
    expect(row(`select count(*) from public.studio_sms_onboarding where studio_id = '${A}'`)).toBe("2");
    expect(row(`select count(*) from public.studio_sms_onboarding where studio_id = '${A}' and state = 'cancelled' and ein_ciphertext is null`)).toBe("1");
    // cancelling a plain draft also erases its EIN
    expect(track(await cancelSmsSetupAction())).toMatchObject({ ok: true });
    expect(row(`select count(*) from public.studio_sms_onboarding where studio_id = '${A}' and ein_ciphertext is not null`)).toBe("0");
  });

  it("platform oversight lists studios without personal fields; other roles cannot list", async () => {
    const rows = await listOnboardings(as("padmin") as never);
    const a = rows.find((r) => r.studioId === A);
    expect(a).toBeTruthy();
    expect(JSON.stringify(rows)).not.toMatch(/ciphertext|rep_|legal_name|@|4321/);
    for (const who of ["owner_a", "admin_a", "fd_a", "outsider"] as const) {
      await expect(listOnboardings(as(who) as never)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("nothing in any response, error or log carried the EIN or its ciphertext", () => {
    const everything = [...captured, ...logSpies.flatMap((spy) => spy.mock.calls.map((call: unknown[]) => JSON.stringify(call)))].join("\n");
    expect(everything).not.toMatch(/987654321|98-7654321|v1\.[A-Za-z0-9_-]{10,}/);
    expect(D).toBeTruthy();
  });
});
