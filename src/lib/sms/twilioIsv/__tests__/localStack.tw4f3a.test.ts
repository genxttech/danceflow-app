/**
 * TW-4F-3a (D2: a Twilio subaccount per studio LEGAL BUSINESS) against a REAL schema: legal entities, owner-attested location links, the spend cap
 * and its reservations, subaccount provisioning and the ledger's account guard, using the real SQL functions (service role, through PostgREST),
 * the real runner and the FAKE Twilio adapters. LOCAL QA STACK ONLY (skipped unless the variables below point at a loopback Supabase stack that has
 * TW-4A .. TW-4F-1b and the TW-4F-3a migration applied). Synthetic fixtures with their own ids; no Twilio call is possible.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PRICE_FIXTURE_REQUESTER, seedPrice } from "./priceFixture";
import { pilotExceptionEvidenceFor, pilotSpendEvidenceFor, spendEvidenceApplied } from "./rflEvidenceHelper";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { saveOnboardingDraft, setPilotAccess, storeEinCiphertext, submitOnboarding } from "@/lib/sms/onboarding/client";
import { encryptEin } from "@/lib/sms/onboarding/ein";
import { validateDraftFields } from "@/lib/sms/onboarding/fields";
import type { IsvConfig } from "../config";
import { SupabaseCreditStore } from "../creditStore";
import { SupabaseEntityStore } from "../entityStore";
import { FakeIsvParent } from "../fake";
import { runBrandSubmission, type RunResult } from "../runner";
import { RunnerStoreError, SupabaseRunnerStore } from "../store";
import { provisionSubaccount } from "../subaccount";

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

const A = "a3a30000-0000-4000-8000-00000000000a"; // founding location of business 1
const B = "a3a30000-0000-4000-8000-00000000000b"; // another location of business 1
const C = "a3a30000-0000-4000-8000-00000000000c"; // a different business
const U = {
  owner_a: "a3a30000-0000-4000-8000-000000000101",
  owner_b: "a3a30000-0000-4000-8000-000000000201",
  owner_c: "a3a30000-0000-4000-8000-000000000301",
  fd_b: "a3a30000-0000-4000-8000-000000000202",
  padmin: "a3a30000-0000-4000-8000-000000000401",
};
const PRIMARY = `BU${"e".repeat(32)}`;
const PRIMARY_POLICY = `RN${"4".repeat(32)}`;
const config: IsvConfig = {
  accountSid: `AC${"1".repeat(32)}`, authToken: "t", primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY, secondaryProfilePolicySid: `RN${"2".repeat(32)}`,
  a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
};

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
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const count = (sql: string) => Number(psql(sql));

const FIELDS = (legalName: string, email: string): Record<string, string> => ({
  legal_name: legalName, entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: "",
  address_line1: "12 Harbor Way", address_line2: "", city: "Portland", region: "OR", postal_code: "97201",
  rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: email, rep_phone: "(503) 555-0123", preferred_area_code: "503",
});
const NAME_1 = "F3A Dance Group LLC";
const NAME_2 = "ConfiDance Unlimited, LLC"; // the verified pilot business (synthetic local copy)

const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_approval_refs where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}'); delete from public.studio_sms_spend_events where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}');
delete from public.studio_sms_credit_ledger where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}');
delete from public.studio_sms_credit_reservations where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}');
delete from public.studio_sms_credit_topups where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}');
delete from public.studio_sms_provider_charges where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}');
delete from public.studio_sms_credit_accounts where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}');
do $d41$ begin if to_regclass('public.studio_sms_price_change_requests') is not null then delete from public.studio_sms_price_change_requests where requested_by = '${PRICE_FIXTURE_REQUESTER}' or decided_by = '${U.padmin}'; end if; end $d41$;
delete from public.studio_sms_price_list where created_by = '${U.padmin}';
delete from public.studio_sms_subaccount_confirmations where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}');
delete from public.studio_sms_twilio_accounts where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}');
delete from public.studio_sms_entity_studios where studio_id in ('${A}', '${B}', '${C}');
delete from public.studio_sms_location_requests where studio_id in ('${A}', '${B}', '${C}');
delete from public.studio_sms_pilot_exceptions where legal_entity_id in (select id from public.studio_sms_legal_entities where created_by = '${U.padmin}');
delete from public.studio_sms_legal_entities where created_by = '${U.padmin}';
commit;
begin;
delete from public.studio_sms_registrations where studio_id in ('${A}', '${B}', '${C}');
delete from public.studios where id in ('${A}', '${B}', '${C}');
delete from auth.users where email like '%@tw4f3a-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('${U.owner_a}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_a@tw4f3a-e2e.test', now(), now()),
  ('${U.owner_b}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_b@tw4f3a-e2e.test', now(), now()),
  ('${U.owner_c}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_c@tw4f3a-e2e.test', now(), now()),
  ('${U.fd_b}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fd_b@tw4f3a-e2e.test', now(), now()),
  ('${U.padmin}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin@tw4f3a-e2e.test', now(), now());
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.owner_b}', null), ('${U.owner_c}', null), ('${U.fd_b}', null), ('${U.padmin}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  ('${A}', 'TW4F3A E2E Studio A', 'tw4f3a-e2e-a', 'F3A Harbor Dance'), ('${B}', 'TW4F3A E2E Studio B', 'tw4f3a-e2e-b', null), ('${C}', 'TW4F3A E2E Studio C', 'tw4f3a-e2e-c', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${A}', 'studio_owner', true), ('${U.owner_b}', '${B}', 'studio_owner', true), ('${U.owner_c}', '${C}', 'studio_owner', true), ('${U.fd_b}', '${B}', 'front_desk', true), ('${U.owner_a}', '${B}', 'studio_owner', true);
commit;`;

describe.skipIf(!enabled)("TW-4F-3a subaccounts, legal entities and spend against the local QA stack (real SQL functions, fake Twilio)", () => {
  let admin: SupabaseClient;
  let store: SupabaseRunnerStore;
  let entities: SupabaseEntityStore;
  let credits: SupabaseCreditStore;
  let parent: FakeIsvParent;
  let entityOne = "";
  let entityTwo = "";
  let requestB = "";
  let requestForeign = "";
  let requestC = "";

  async function prepare(studio: string, owner: "owner_a" | "owner_b" | "owner_c", legalName: string) {
    await setPilotAccess(as("padmin") as never, studio, true, "F3A local e2e");
    await store.setWindow(studio, U.padmin, 24, "F3A local e2e");
    await saveOnboardingDraft(as(owner) as never, studio, validateDraftFields(FIELDS(legalName, "pat@tw4f3a-e2e.test")).fields);
    const encrypted = encryptEin(studio, { digits: "987654321", last4: "4321" });
    await storeEinCiphertext(admin as never, { studioId: studio, actorUserId: U[owner], ciphertext: encrypted.ciphertext, keyId: encrypted.keyId, last4: encrypted.last4 });
    const submitted = await submitOnboarding(as(owner) as never, studio, { authorized: true, accurate: true, opt_in_only: true, fees_terms: true });
    expect(submitted.submitted).toBe(true);
  }
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof RunnerStoreError ? error.code : `other:${String(error)}`;
    }
  };
  const rpc = async (c: SupabaseClient, fn: string, args: Record<string, unknown>) => (await c.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const journey = async (studio: string, adapterAccount: string, confirmFee: boolean): Promise<RunResult> => {
    const adapter = parent.adapterFor(adapterAccount);
    let result!: RunResult;
    for (let pass = 0; pass < 6; pass++) {
      result = await runBrandSubmission({ store, adapter, primary: parent, config, studioId: studio, actorId: U.padmin, confirmFee, confirmSubmit: ["S11", "T6"] });
      if (result.outcome !== "waiting_submission_confirmation" || !String(result.detail).endsWith(":review")) break;
    }
    return result;
  };

  beforeAll(async () => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
    admin = client(null, serviceKey());
    store = new SupabaseRunnerStore(admin);
    entities = new SupabaseEntityStore(admin);
    credits = new SupabaseCreditStore(admin);
    parent = new FakeIsvParent(PRIMARY, { primaryPolicySid: PRIMARY_POLICY });
    psqlFile(FIXTURES);
    await prepare(A, "owner_a", NAME_1);
    await prepare(B, "owner_b", NAME_1);
    await prepare(C, "owner_c", NAME_2);
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
    } catch {
      /* best effort */
    }
    delete process.env.SMS_EIN_ENCRYPTION_KEY;
  });

  it("every new function is executable by the service role only (except the owner attestation), and the new tables have no API privileges", () => {
    // Asserted from the catalog on purpose: a permission-denied call by anon / authenticated crashes the supautils hint hook of this local image.
    const fns = [
      "tw4_entity_create_for_studio(uuid, uuid, text)", "tw4_entity_decide_link(uuid, uuid, uuid, boolean, text)", "tw4_entity_set_spend_cap(uuid, int, uuid)",
      (spendEvidenceApplied(psql) ? "tw4_spend_authorize(uuid, text, int, text, uuid, text, uuid, date, text, text, int, text, text, text)" : "tw4_spend_authorize(uuid, text, int, text, uuid, text, uuid)"), "tw4_spend_reserve(uuid, text, text)", "tw4_subaccount_confirm(uuid, uuid)",
      "tw4_subaccount_begin(uuid, uuid, text, text)", "tw4_subaccount_finish(uuid, uuid, text, text)", "tw4_runner_account(uuid, text)", "tw4_entity_for_studio(uuid, uuid)",
      "_tw4f3a_name_key(text)", "_tw4f3a_steps_account_guard()", "_tw4f3a_audit(uuid, uuid, text, text)", "_tw4f3a_committed(uuid)", "_tw4f3a_evidence_guard()",
    ];
    const checks: string[] = [];
    for (const fn of fns) {
      for (const role of ["anon", "authenticated"]) checks.push(`select case when has_function_privilege('${role}', 'public.${fn}', 'execute') then '${role} may execute ${fn}' end`);
      if (!fn.startsWith("_")) checks.push(`select case when not has_function_privilege('service_role', 'public.${fn}', 'execute') then 'service_role may not execute ${fn}' end`);
    }
    checks.push("select case when not has_function_privilege('authenticated', 'public.sms_location_attest(uuid, text, text, text)', 'execute') then 'owner attestation not executable' end");
    checks.push("select case when has_function_privilege('anon', 'public.sms_location_attest(uuid, text, text, text)', 'execute') then 'anon may attest' end");
    for (const table of ["studio_sms_legal_entities", "studio_sms_entity_studios", "studio_sms_location_requests", "studio_sms_twilio_accounts", "studio_sms_subaccount_confirmations", "studio_sms_spend_events"]) {
      for (const role of ["anon", "authenticated", "service_role"]) checks.push(`select case when has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete') then '${role} has privileges on ${table}' end`);
      checks.push(`select case when not (select relrowsecurity from pg_class where oid = 'public.${table}'::regclass) then 'RLS off on ${table}' end`);
    }
    expect(psql(checks.join(" union all ") + " order by 1")).toBe("");
  });

  it("the founding location: only a platform admin creates the entity, from the studio's own attested onboarding; a duplicate business is refused", async () => {
    expect(await code(entities.createEntityForStudio(A, U.owner_a, "verified against the state registry"))).toBe("42501");
    expect(await code(entities.createEntityForStudio(A, U.padmin, "short"))).not.toBe("ok"); // the verification note is required (>= 10 characters)
    entityOne = await entities.createEntityForStudio(A, U.padmin, "Verified against the state business registry on file");
    expect(entityOne).toMatch(/^[0-9a-f-]{36}$/);
    expect(psql(`select link_kind || ':' || verification_note from public.studio_sms_entity_studios where studio_id = '${A}'`)).toBe("founding:Verified against the state business registry on file");
    expect(await code(entities.createEntityForStudio(A, U.padmin, "second attempt for the same studio"))).toBe("23505");
    // studio B has the SAME legal name and EIN last four: a second entity would be a duplicate registration
    expect(await code(entities.createEntityForStudio(B, U.padmin, "would duplicate the first business"))).toBe("23505");
    expect(count(`select count(*) from public.studio_sms_legal_entities where legal_name like 'F3A %' and ein_last4 = '4321' and legal_name_key = lower('${NAME_1}')`)).toBe(1);
    entityTwo = await entities.createEntityForStudio(C, U.padmin, "Verified against the state business registry too");
    expect(entityTwo).not.toBe(entityOne);
    expect(count(`select count(*) from public.studio_sms_onboarding_audit where action = 'entity_created' and studio_id in ('${A}', '${C}')`)).toBe(2);
  });

  it("an additional location needs the OWNER's attestation: front desk, other tenants and anonymous callers cannot attest", async () => {
    const attest = (c: SupabaseClient, studio: string, name = NAME_1, last4 = "4321") =>
      rpc(c, "sms_location_attest", { p_studio_id: studio, p_claimed_legal_name: name, p_claimed_ein_last4: last4, p_attestation_version: "v1" });
    expect((await attest(as("fd_b"), B)).error?.code).toBe("42501"); // front desk of B
    expect((await attest(as("owner_c"), B)).error?.code).toBe("42501"); // another business's owner
    expect((await attest(as("owner_a"), A)).error?.code).toBe("23505"); // A already belongs to an entity
    // owner B owns studio B but NOT any studio of the legal entity: the request can be filed, but cannot be approved (next test)
    const foreign = await attest(as("owner_b"), B);
    expect(foreign.error).toBeNull();
    requestForeign = (foreign.data as { request_id: string }).request_id;
    expect((await attest(as("owner_b"), B)).error?.code).toBe("23505"); // one pending request per studio
    expect((await attest(as("owner_c"), C, NAME_1)).error?.code).toBe("23505"); // C already has its OWN entity
    expect(count(`select count(*) from public.studio_sms_location_requests where studio_id = '${C}'`)).toBe(0);
  });

  it("the platform admin verifies and decides; an attester who does not own a studio of the entity, mismatching checks, a missing note and non-admins are refused", async () => {
    expect(count(`select count(*) from public.studio_sms_entity_studios where studio_id = '${B}'`)).toBe(0);
    expect(await code(entities.decideLink(requestForeign, entityOne, U.padmin, true, "owner B is not an owner of the entity"))).toBe("22023"); // attester owns no studio of entity one
    await entities.decideLink(requestForeign, entityOne, U.padmin, false, "the attester is not an owner of this legal business");
    expect(psql(`select status from public.studio_sms_location_requests where id = '${requestForeign}'`)).toBe("rejected");
    // the entity's own owner (who also owns studio B) attests
    const ok = await rpc(as("owner_a"), "sms_location_attest", { p_studio_id: B, p_claimed_legal_name: "F3A Dance Group, L.L.C.", p_claimed_ein_last4: "4321", p_attestation_version: "v1" });
    expect(ok.error).toBeNull();
    requestB = (ok.data as { request_id: string }).request_id;
    expect(await code(entities.decideLink(requestB, entityOne, U.owner_b, true, "verified formation documents"))).toBe("42501");
    expect(await code(entities.decideLink(requestB, entityOne, U.padmin, true, "short"))).toBe("22023");
    expect(await code(entities.decideLink(requestB, entityTwo, U.padmin, true, "verified against the wrong business"))).toBe("22023"); // name does not match entity two
    expect(count(`select count(*) from public.studio_sms_entity_studios where studio_id = '${B}'`)).toBe(0);
    // punctuation and case differences in the claimed name do not matter ("F3A Dance Group, L.L.C." = "F3A Dance Group LLC")
    await entities.decideLink(requestB, entityOne, U.padmin, true, "Checked the formation certificate: studio B is a location of this LLC");
    expect(psql(`select link_kind || ':' || (attested_by = '${U.owner_a}')::text || ':' || (supporting_checks->>'name_matches') || ':' || (supporting_checks->>'ein_last4_matches') from public.studio_sms_entity_studios where studio_id = '${B}'`)).toBe("additional:true:true:true");
    expect(await code(entities.decideLink(requestB, entityOne, U.padmin, true, "second decision for the same request"))).toBe("22023");
  });

  it("legal-name variants cannot create a duplicate entity (punctuation, spacing and case are normalized)", () => {
    for (const variant of ["F3A Dance Group, L.L.C.", "f3a  dance group llc", "F3A DANCE GROUP LLC."]) {
      expect(psqlError(`insert into public.studio_sms_legal_entities (legal_name, ein_last4, created_by) values ('${variant}', '4321', '${U.padmin}')`), variant).toContain("no_duplicate");
    }
  });

  it("cross-tenant linking is prevented: a request cannot attach a studio to a business whose name or onboarding disagrees; a rejection links nothing", async () => {
    // a studio whose own onboarding names a different business cannot be attached to entity one, even with an admin note
    // Remove C's founding link the same way the cleanup does, to exercise the request path for C
    psqlFile(`begin; set local session_replication_role = replica; delete from public.studio_sms_entity_studios where studio_id = '${C}'; commit;`);
    const attested = await rpc(as("owner_c"), "sms_location_attest", { p_studio_id: C, p_claimed_legal_name: NAME_1, p_claimed_ein_last4: "4321", p_attestation_version: "v1" });
    expect(attested.error).toBeNull();
    requestC = (attested.data as { request_id: string }).request_id;
    expect(await code(entities.decideLink(requestC, entityOne, U.padmin, true, "owner claims it is a location of business one"))).toBe("22023"); // C's owner owns no studio of entity one, and C's own onboarding says business two
    expect(count(`select count(*) from public.studio_sms_entity_studios where studio_id = '${C}'`)).toBe(0);
    await entities.decideLink(requestC, entityOne, U.padmin, false, "evidence does not support the claim");
    expect(psql(`select status from public.studio_sms_location_requests where id = '${requestC}'`)).toBe("rejected");
    expect(count(`select count(*) from public.studio_sms_entity_studios where studio_id = '${C}'`)).toBe(0);
    // restore C as the founding location of its own business for the rest of the suite
    psqlFile(`begin; set local session_replication_role = replica; insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values ('${C}', '${entityTwo}', 'founding', '${U.padmin}', 'restored by the test fixture'); commit;`);
  });

  it("spend: no cap, no authorization; the cap bounds everything authorized and reserved; a cap cannot drop below what is committed", async () => {
    // TW-4F-3b-0: an authorization is always for the PUBLISHED price
    expect(await code(entities.authorizeSpend(entityOne, "brand", 1000, "owner email 2026-10-18", U.padmin))).toBe("TW008"); // no published price yet
    seedPrice(psql, { kind: "brand", customer: 1000, provider: 400, description: "Brand registration", approver: U.padmin });
    seedPrice(psql, { kind: "number", customer: 14_500, provider: 100, description: "Phone number (test price at the cap)", approver: U.padmin });
    expect(await code(entities.authorizeSpend(entityOne, "brand", 1000, "owner email 2026-10-18", U.padmin))).toBe("TW004"); // cap is 0
    expect(await code(entities.setSpendCap(entityOne, 15_000, U.owner_a))).toBe("42501");
    await entities.setSpendCap(entityOne, 15_000, U.padmin);
    expect(await code(entities.authorizeSpend(entityOne, "brand", 1000, "x", U.padmin))).not.toBe("ok"); // approval reference is required
    await entities.authorizeSpend(entityOne, "brand", 1000, "owner approval 2026-10-18", U.padmin);
    expect(await code(entities.authorizeSpend(entityOne, "brand", 999, "not the published price", U.padmin))).toBe("TW008");
    expect(await code(entities.authorizeSpend(entityOne, "number", 14_500, "too much for the cap", U.padmin))).toBe("TW004");
    expect(await code(entities.setSpendCap(entityOne, 500, U.padmin))).toBe("22023");
    expect(count(`select count(*) from public.studio_sms_spend_events where legal_entity_id = '${entityOne}'`)).toBe(1);
    expect(count(`select count(*) from public.studio_sms_onboarding_audit where action = 'spend_authorized'`)).toBeGreaterThanOrEqual(1);
  });

  it("a studio is stopped by the runner until its entity has an active subaccount, and the ledger refuses rows without one (TW005)", async () => {
    const adapter = parent.adapterFor(`AC${"d".repeat(32)}`);
    const stopped = await runBrandSubmission({ store, adapter, primary: parent, config, studioId: A, actorId: U.padmin, confirmFee: true, confirmSubmit: [] });
    expect(stopped.outcome).toBe("needs_subaccount");
    expect(stopped.detail).toBe("no_subaccount");
    expect(adapter.calls).toHaveLength(0);
    expect(count(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${A}'`)).toBe(0);
    const onboarding = psql(`select id from public.studio_sms_onboarding where studio_id = '${A}' and state <> 'cancelled'`);
    expect(psqlError(`insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq) values ('${onboarding}', '${A}', 'S1', 1)`)).toContain("no active Twilio subaccount");
  });

  it("provisioning needs the cap, a fresh typed confirmation and the right actor; it creates once, records the sid, and cannot be repeated", async () => {
    // entity two has no cap yet: the confirmation itself is refused
    expect(await code(entities.confirmSubaccount(entityTwo, U.padmin))).toBe("TW004");
    expect(await code(entities.confirmSubaccount(entityOne, U.owner_a))).toBe("42501");
    expect((await provisionSubaccount({ entities, parent, studioId: A, actorId: U.padmin, envName: "test" })).outcome).toBe("waiting_subaccount_confirmation");
    expect(parent.calls).toHaveLength(0);
    expect(count(`select count(*) from public.studio_sms_twilio_accounts where legal_entity_id = '${entityOne}'`)).toBe(0);
    await entities.confirmSubaccount(entityOne, U.padmin);
    const created = await provisionSubaccount({ entities, parent, studioId: A, actorId: U.padmin, envName: "test" });
    expect(created, JSON.stringify(created)).toMatchObject({ outcome: "subaccount_created" });
    expect(psql(`select status || ':' || (twilio_account_sid = '${created.accountSid}')::text from public.studio_sms_twilio_accounts where legal_entity_id = '${entityOne}'`)).toBe("active:true");
    expect(count(`select count(*) from public.studio_sms_subaccount_confirmations where legal_entity_id = '${entityOne}' and consumed_at is not null`)).toBe(1);
    // a second location of the same business gets the SAME subaccount, never a second one
    const again = await provisionSubaccount({ entities, parent, studioId: B, actorId: U.padmin, envName: "test" });
    expect(again).toEqual({ outcome: "subaccount_exists", accountSid: created.accountSid });
    expect(parent.count("createSubaccount")).toBe(1);
    // the sid is final and unique; the account row cannot be deleted
    expect(psqlError(`update public.studio_sms_twilio_accounts set twilio_account_sid = 'AC${"9".repeat(32)}' where legal_entity_id = '${entityOne}'`)).toContain("sid is final");
    expect(psqlError(`delete from public.studio_sms_twilio_accounts where legal_entity_id = '${entityOne}'`)).toContain("are not deleted");
    expect(await code(entities.finishSubaccount(entityOne, U.padmin, "failed", null))).toBe("22023"); // nothing is in progress any more
    expect(count(`select count(*) from public.studio_sms_onboarding_audit where action in ('subaccount_confirmed', 'runner_subaccount') and studio_id = '${A}'`)).toBeGreaterThanOrEqual(3);
  });

  it("a creation that is still running blocks a second one: no second subaccount, no confirmation burnt", async () => {
    await entities.setSpendCap(entityTwo, 15_000, U.padmin);
    await entities.confirmSubaccount(entityTwo, U.padmin);
    const begun = await entities.beginSubaccount(entityTwo, U.padmin, "df:test:race", "test");
    expect(begun.action).toBe("execute");
    await entities.confirmSubaccount(entityTwo, U.padmin);
    expect((await provisionSubaccount({ entities, parent, studioId: C, actorId: U.padmin, envName: "test" })).detail).toBe("creation_in_progress");
    expect(parent.count("createSubaccount")).toBe(1); // only the first test's account exists; nothing new was created
    expect(count(`select count(*) from public.studio_sms_subaccount_confirmations where legal_entity_id = '${entityTwo}' and consumed_at is null`)).toBe(1);
    // the first attempt ends unknown; the pending confirmation now reconciles by lookup
    await entities.finishSubaccount(entityTwo, U.padmin, "unknown", null);
    expect((await entities.beginSubaccount(entityTwo, U.padmin, "df:test:race", "test")).action).toBe("reconcile");
    await entities.finishSubaccount(entityTwo, U.padmin, "failed", null);
  });

  it("a lost response leaves the account 'unknown'; the next confirmed run finds it by name and never creates a second", async () => {
    await entities.setSpendCap(entityTwo, 15_000, U.padmin);
    parent.failNext("createSubaccount", { kind: "transient", lostResponse: true });
    await entities.confirmSubaccount(entityTwo, U.padmin);
    expect((await provisionSubaccount({ entities, parent, studioId: C, actorId: U.padmin, envName: "test" })).outcome).toBe("retry_later");
    expect(psql(`select status from public.studio_sms_twilio_accounts where legal_entity_id = '${entityTwo}'`)).toBe("unknown");
    expect((await provisionSubaccount({ entities, parent, studioId: C, actorId: U.padmin, envName: "test" })).outcome).toBe("waiting_subaccount_confirmation");
    await entities.confirmSubaccount(entityTwo, U.padmin);
    const second = await provisionSubaccount({ entities, parent, studioId: C, actorId: U.padmin, envName: "test" });
    expect(second.outcome).toBe("subaccount_exists");
    expect(parent.count("createSubaccount")).toBe(2); // one per business
    expect(psql(`select count(distinct twilio_account_sid) from public.studio_sms_twilio_accounts where legal_entity_id in ('${entityOne}', '${entityTwo}')`)).toBe("2");
  });

  it("the runner records the subaccount on every step, refuses another account's adapter, and the ledger refuses a wrong account sid", async () => {
    const sidOne = psql(`select twilio_account_sid from public.studio_sms_twilio_accounts where legal_entity_id = '${entityOne}'`);
    const sidTwo = psql(`select twilio_account_sid from public.studio_sms_twilio_accounts where legal_entity_id = '${entityTwo}'`);
    // business one's studio with business two's adapter: refused before any call
    const foreign = parent.adapterFor(sidTwo);
    const refused = await runBrandSubmission({ store, adapter: foreign, primary: parent, config, studioId: A, actorId: U.padmin, confirmFee: true, confirmSubmit: [] });
    expect(refused.outcome).toBe("account_mismatch");
    expect(foreign.calls).toHaveLength(0);
    // the right adapter: steps run and carry the account
    const stopped = await journey(A, sidOne, false);
    expect(stopped.outcome).toBe("waiting_fee_confirmation");
    expect(count(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${A}' and twilio_account_sid = '${sidOne}'`)).toBeGreaterThan(10);
    expect(count(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${A}' and twilio_account_sid is distinct from '${sidOne}'`)).toBe(0);
    // resources exist only in business one's account
    // (the Secondary profile only: the ISV Primary lives in the parent account and is assigned, not copied, Twilio ticket #29647095)
    expect(parent.adapterFor(sidOne).profiles.size).toBe(1);
    expect(parent.adapterFor(sidOne).profiles.has(PRIMARY)).toBe(false);
    expect(parent.adapterFor(sidTwo).count("createCustomerProfile")).toBe(0);
    const onboarding = psql(`select id from public.studio_sms_onboarding where studio_id = '${A}' and state <> 'cancelled'`);
    expect(psqlError(`update public.studio_sms_provisioning_steps set twilio_account_sid = '${sidTwo}' where onboarding_id = '${onboarding}' and step_key = 'S1'`)).toContain("subaccount of a step is fixed");
    expect(psqlError(`insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, twilio_account_sid) values ('${onboarding}', '${A}', 'S1', 9, '${sidTwo}')`)).toContain("does not match");
  });

  it("the paid brand step reserves the authorized spend exactly once and never exceeds the cap; without authorization it never reaches Twilio", async () => {
    const sidOne = psql(`select twilio_account_sid from public.studio_sms_twilio_accounts where legal_entity_id = '${entityOne}'`);
    const sidTwo = psql(`select twilio_account_sid from public.studio_sms_twilio_accounts where legal_entity_id = '${entityTwo}'`);
    // business two has a cap and a subaccount but NO authorized brand spend
    const blocked = await journey(C, sidTwo, true);
    expect(blocked.outcome).toBe("spend_blocked");
    expect(parent.adapterFor(sidTwo).count("createBrand")).toBe(0);
    expect(count(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${C}' and step_key = 'B1'`)).toBe(0);
    // business one has an authorization but the studio has not funded its credit yet: nothing is called or charged
    const unfunded = await journey(A, sidOne, true);
    expect(unfunded.outcome).toBe("insufficient_credit");
    expect(parent.adapterFor(sidOne).count("createBrand")).toBe(0);
    await credits.settleTopup(entityOne, A, "pi_test_f3a_a", 5_000, "evt_test_f3a_a");
    // concurrent and repeated reservations of ONE operation bind one authorization and hold the credit once; a release frees it and needs a fresh authorization
    const lease = "f3b-race";
    const claim = await store.claim(A, U.padmin, lease, 120, "run");
    try {
      const reserved = await Promise.all(Array.from({ length: 5 }, () => store.reserveSpend(claim.onboarding_id, lease, "brand")));
      expect(new Set(reserved.map((r) => r.spendEventId)).size).toBe(1);
      expect(psql(`select balance_cents || ':' || reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entityOne}'`)).toBe("5000:1000");
      await store.settleSpend(claim.onboarding_id, lease, "brand", "released", "test");
      await store.settleSpend(claim.onboarding_id, lease, "brand", "released", "test"); // idempotent
      expect(psql(`select balance_cents || ':' || reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entityOne}'`)).toBe("5000:0");
      expect(await code(store.reserveSpend(claim.onboarding_id, lease, "brand"))).toBe("TW004"); // the released authorization is gone: the owner must approve again
      const second = await entities.authorizeSpend(entityOne, "brand", 1000, "owner re-approval after release", U.padmin);
      // a reservation no run can settle any more (another generation, a crash) is resolved by a platform admin, with a written reason
      await store.reserveSpend(claim.onboarding_id, lease, "brand");
      const open = await credits.openReservations(entityOne, U.padmin);
      expect(open).toHaveLength(1);
      expect(await code(credits.resolveReservation(open[0].id, "released", "short", U.padmin))).toBe("22023");
      expect(await code(credits.resolveReservation(open[0].id, "released", "the setup was cancelled before Twilio was called", U.owner_a))).toBe("42501");
      expect(await credits.resolveReservation(open[0].id, "released", "the setup was cancelled before Twilio was called", U.padmin)).toEqual({ replayed: false });
      expect(await credits.resolveReservation(open[0].id, "released", "the setup was cancelled before Twilio was called", U.padmin)).toEqual({ replayed: true });
      expect(await code(credits.resolveReservation(open[0].id, "captured", "cannot capture what was released", U.padmin))).toBe("22023");
      expect(psql(`select balance_cents || ':' || reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entityOne}'`)).toBe("5000:0");
      expect(psql(`select status from public.studio_sms_spend_events where id = '${second}'`)).toBe("void"); // released = authorization voided, cap freed
      // an authorization that was never used can be withdrawn; a used one cannot
      const unused = await entities.authorizeSpend(entityOne, "brand", 1000, "owner approval to be withdrawn", U.padmin);
      expect(await code(credits.withdrawAuthorization(unused, "short", U.padmin))).toBe("22023");
      await credits.withdrawAuthorization(unused, "the owner changed their mind before any run", U.padmin);
      expect(count(`select count(*) from public.studio_sms_onboarding_audit where action = 'spend_withdrawn' and note like 'event=${unused};%'`)).toBe(1); // a withdrawal leaves a record
      expect(await code(credits.withdrawAuthorization(unused, "the owner changed their mind before any run", U.padmin))).toBe("22023");
      await entities.authorizeSpend(entityOne, "brand", 1000, "final owner approval for the real run", U.padmin);
    } finally {
      await store.release(claim.onboarding_id, lease);
    }
    const done = await journey(A, sidOne, true);
    expect(done.outcome).toBe("brand_submitted");
    expect(parent.adapterFor(sidOne).count("createBrand")).toBe(1);
    expect(psql(`select status || ':' || (reservation_key like '%:1:brand:3')::text from public.studio_sms_spend_events where legal_entity_id = '${entityOne}' and kind = 'brand' and status = 'reserved'`)).toBe("reserved:true");
    expect(count(`select count(*) from public.studio_sms_spend_events where legal_entity_id = '${entityOne}' and status = 'reserved'`)).toBe(1);
    await journey(A, sidOne, true); // repeating changes nothing
    expect(count(`select count(*) from public.studio_sms_spend_events where legal_entity_id = '${entityOne}' and status = 'reserved'`)).toBe(1);
    expect(parent.adapterFor(sidOne).count("createBrand")).toBe(1);
    // a reserved authorization is final
    expect(psqlError(`update public.studio_sms_spend_events set status = 'void', reservation_key = null, reserved_at = null where legal_entity_id = '${entityOne}'`)).toContain("final");
    expect(psql(`select balance_cents || ':' || reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entityOne}'`)).toBe("4000:0"); // 5000 funded, 1000 captured
    expect((await credits.verify(entityOne)).ok).toBe(true);
    expect(psqlError(`update public.studio_sms_spend_events set amount_cents = 1 where legal_entity_id = '${entityOne}'`)).toContain("cannot be edited");
  });

  it("a ledger row written before the studio was linked (parent-account era) can never be continued inside a subaccount", () => {
    const onboarding = psql(`select id from public.studio_sms_onboarding where studio_id = '${B}' and state <> 'cancelled'`);
    psqlFile(`begin; set local session_replication_role = replica; insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status) values ('${onboarding}', '${B}', 'S4', 1, 'in_flight'); commit;`);
    expect(psqlError(`update public.studio_sms_provisioning_steps set status = 'failed' where onboarding_id = '${onboarding}' and step_key = 'S4'`)).toContain("predates the studio");
    psqlFile(`begin; set local session_replication_role = replica; delete from public.studio_sms_provisioning_steps where onboarding_id = '${onboarding}' and step_key = 'S4'; commit;`);
  });

  it("the ConfiDance pilot exception is a non-spendable ceiling: no credit, per-operation authorization still required, cumulative ceiling over outstanding AND captured, never for messaging", async () => {
    const sidTwo = psql(`select twilio_account_sid from public.studio_sms_twilio_accounts where legal_entity_id = '${entityTwo}'`);
    const refText = "founder approved the ConfiDance pilot exception in writing";
    // only the verified ConfiDance business, only an admin, never above $150 / the entity cap
    expect(await code(credits.createPilotException(entityOne, 2_000, refText, U.padmin))).toBe("22023");
    expect(await code(credits.createPilotException(entityTwo, 2_000, refText, U.owner_c))).toBe("42501");
    expect(await code(credits.createPilotException(entityTwo, 15_001, refText, U.padmin))).toBe("22023");
    expect(await code(credits.createPilotException(entityTwo, 2_000, "short", U.padmin))).toBe("22023");
    expect(await credits.createPilotException(entityTwo, 2_000, refText, U.padmin, pilotExceptionEvidenceFor(entityTwo, 2_000))).toEqual({ replayed: false });
    expect(await credits.createPilotException(entityTwo, 2_000, refText, U.padmin, pilotExceptionEvidenceFor(entityTwo, 2_000))).toEqual({ replayed: true });
    expect(await code(credits.createPilotException(entityTwo, 3_000, refText, U.padmin, pilotExceptionEvidenceFor(entityTwo, 3_000)))).toBe("23505");
    // it is NOT credit: no ledger entry, no balance, no payment, and messaging can never be paid from it
    const balanceRows = () => count(`select count(*) from public.studio_sms_credit_accounts where legal_entity_id = '${entityTwo}' and (balance_cents <> 0 or reserved_cents <> 0)`);
    const ledgerRows = () => count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${entityTwo}'`);
    expect(balanceRows()).toBe(0);
    expect(ledgerRows()).toBe(0);
    expect(count(`select count(*) from public.studio_sms_credit_topups where legal_entity_id = '${entityTwo}'`)).toBe(0);
    expect(await code(credits.debitUsage(entityTwo, C, 1, "pilot-usage", "m"))).toBe("TW007");
    // no operation-specific authorization => no reservation, with or without the ceiling
    const noAuth = await journey(C, sidTwo, true);
    expect(noAuth.outcome).toBe("spend_blocked");
    expect(parent.adapterFor(sidTwo).count("createBrand")).toBe(0);
    // the approver chooses the funding source on the authorization: a CREDIT-funded one never falls back to the ceiling
    const creditOnly = await entities.authorizeSpend(entityTwo, "brand", 1000, "owner approved the brand registration, paid from prepaid credit", U.padmin);
    const noFallback = await journey(C, sidTwo, true);
    expect(noFallback.outcome).toBe("insufficient_credit");
    expect(parent.adapterFor(sidTwo).count("createBrand")).toBe(0);
    // (the unbound credit-funded authorization stays open on purpose: the location-bound pilot authorization must be the one this run uses)
    // a pilot-funded authorization needs the location, a written reference of 10+ characters, and a reference is used once
    expect(await code(entities.authorizeSpend(entityTwo, "brand", 1000, "short", U.padmin, "pilot", C))).toBe("22023");
    expect(await code(entities.authorizeSpend(entityTwo, "brand", 1000, "owner approved the real brand registration in writing", U.padmin, "pilot", null))).toBe("22023");
    expect(await code(entities.authorizeSpend(entityTwo, "brand", 1000, "owner approved the real brand registration in writing", U.padmin, "pilot", A))).not.toBe("ok"); // a location of another business
    expect(await code(entities.authorizeSpend(entityOne, "brand", 1000, "owner approved the real brand registration in writing", U.padmin, "pilot", A))).toBe("22023"); // no exception for that business
    await entities.authorizeSpend(entityTwo, "brand", 1000, "owner approved the real brand registration in writing", U.padmin, "pilot", C, pilotSpendEvidenceFor("brand", entityTwo, C, 1000));
    // the same approval twice: an identical resubmission returns the SAME unused authorization (20261202 replay), never a second one ...
    expect(await code(entities.authorizeSpend(entityTwo, "brand", 1000, "Owner approved the REAL brand registration in writing", U.padmin, "pilot", C, pilotSpendEvidenceFor("brand", entityTwo, C, 1000)))).toBe("ok");
    expect(count(`select count(*) from public.studio_sms_spend_events where legal_entity_id = '${entityTwo}' and lower(approval_ref) = 'owner approved the real brand registration in writing'`)).toBe(1);
    // ... and any other use of the reference (another location, amount or kind) is refused
    expect(await code(entities.authorizeSpend(entityTwo, "campaign_vetting", 1_500, "Owner approved the REAL brand registration in writing", U.padmin, "pilot", C, pilotSpendEvidenceFor("campaign_vetting", entityTwo, C, 1_500)))).toBe("TW019");
    // the pilot business spend cap can never be raised above the $150 maximum
    expect(await code(entities.setSpendCap(entityTwo, 20_000, U.padmin))).toBe("22023");
    const done = await journey(C, sidTwo, true);
    expect(done.outcome).toBe("brand_submitted");
    expect(parent.adapterFor(sidTwo).count("createBrand")).toBe(1);
    expect(psql(`select funding || ':' || status from public.studio_sms_credit_reservations where legal_entity_id = '${entityTwo}'`)).toBe("pilot:captured");
    expect(balanceRows()).toBe(0);
    expect(ledgerRows()).toBe(0);
    expect(psql(`select status from public.studio_sms_spend_events where id = '${creditOnly}'`)).toBe("authorized"); // not consumed by the pilot run
    await credits.withdrawAuthorization(creditOnly, "the owner chose the pilot ceiling instead of prepaid credit", U.padmin);
    expect(await credits.verify(entityTwo)).toMatchObject({ ok: true, pilot_used_cents: 1_000 });
    // cumulative: 1000 captured + 1500 requested > 2000 ceiling, however many concurrent attempts
    seedPrice(psql, { kind: "campaign_vetting", customer: 1_500, provider: 1_500, description: "Campaign vetting (test)", approver: U.padmin });
    await entities.authorizeSpend(entityTwo, "campaign_vetting", 1_500, "owner approved campaign vetting in writing", U.padmin, "pilot", C, pilotSpendEvidenceFor("campaign_vetting", entityTwo, C, 1_500));
    const claim = await store.claim(C, U.padmin, "f3b-pilot", 120, "run");
    try {
      const attempts = await Promise.all(Array.from({ length: 5 }, () => code(store.reserveSpend(claim.onboarding_id, "f3b-pilot", "campaign_vetting"))));
      expect(attempts.every((r) => r === "TW007")).toBe(true);
    } finally {
      await store.release(claim.onboarding_id, "f3b-pilot");
    }
    expect(await credits.verify(entityTwo)).toMatchObject({ ok: true, pilot_used_cents: 1_000 });
    expect(count(`select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${entityTwo}' and kind = 'campaign_vetting'`)).toBe(0);
    // the overview shows the owner the ceiling and what was used
    const overview = await as("owner_c").rpc("sms_credit_overview", { p_studio_id: C });
    expect(overview.data).toMatchObject({ pilot_ceiling_cents: 2_000, pilot_used_cents: 1_000, balance_cents: 0 });
  });

  it("evidence cannot be edited or deleted, and the rollback refuses while it exists", () => {
    expect(psqlError(`delete from public.studio_sms_subaccount_confirmations`)).toContain("are not deleted");
    expect(psqlError(`update public.studio_sms_subaccount_confirmations set consumed_at = null`)).toContain("only be consumed");
    expect(psqlError(`update public.studio_sms_entity_studios set verification_note = 'edited after the fact'`)).toContain("not edited");
    expect(psqlError(`delete from public.studio_sms_entity_studios where studio_id = '${A}'`)).toContain("are not deleted");
    const rollback = readFileSync(join(__dirname, "../../../supabase/migrations/rollback/20261121090000_twilio_tw4f3a_subaccounts_rollback.sql"), "utf8");
    const result = (() => {
      try {
        execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: rollback, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        return "";
      } catch (error) {
        return String((error as { stderr?: Buffer | string }).stderr ?? error);
      }
    })();
    expect(result).toContain("rollback refused");
    expect(count(`select count(*) from information_schema.tables where table_name = 'studio_sms_twilio_accounts'`)).toBe(1);
  });
});
