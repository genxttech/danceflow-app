/**
 * TW-4F J2 (20261222090000) against a REAL schema: `get_studio_sms_texting_status`, called through PostgREST with real signed user JWTs (the same path the app
 * uses), for the studio owner, an inactive owner, a studio admin, front desk, another studio's owner, an unrelated user and a platform admin; the anonymous and
 * service roles are proven refused by privilege (never by a call: see below). Every number, sender, compliance and coverage mapping; the full payload key set;
 * no identifier, number, cost or internal text; orphans as a neutral boolean only; tenant isolation. Synthetic fixtures, removed afterwards. No provider.
 * LOCAL QA STACK ONLY, on a DEDICATED Postgres with 20261120..20261217 (main) + 20261222 applied (skipped unless the variables point at a loopback stack).
 * NEVER call the function as anon/service_role here: on this local Postgres build a permission-denied call of a revoked function can segfault the whole server.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:<postgrest port>  TW4A_LOCAL_JWT_SECRET=<its JWT secret>  TW4A_LOCAL_DB_CONTAINER=<dedicated db container>
 *   npx vitest run --no-file-parallelism src/lib/sms/provisioning/__tests__/localStack.j2owner.test.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

import { getOwnerTextingStatus } from "../ownerRead";

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

const S1 = "e2220000-0000-4000-8000-00000000000a"; // pilot on, business one
const S2 = "e2220000-0000-4000-8000-00000000000b"; // pilot on, business two
const S3 = "e2220000-0000-4000-8000-00000000000c"; // pilot OFF
const E1 = "e2220000-0000-4000-8000-0000000000e1";
const E2 = "e2220000-0000-4000-8000-0000000000e2";
const O1 = "e2220000-0000-4000-8000-0000000000f1";
const O2 = "e2220000-0000-4000-8000-0000000000f2";
const U = {
  owner1: "e2220000-0000-4000-8000-000000000101",
  admin1: "e2220000-0000-4000-8000-000000000102",
  front1: "e2220000-0000-4000-8000-000000000103",
  exowner1: "e2220000-0000-4000-8000-000000000104",
  owner2: "e2220000-0000-4000-8000-000000000201",
  owner3: "e2220000-0000-4000-8000-000000000301",
  padmin: "e2220000-0000-4000-8000-000000000401",
  plain: "e2220000-0000-4000-8000-000000000501",
};
const hex = (n: number) => n.toString(16).padStart(32, "0");
const ACC = { 1: `AC${"e1".repeat(16)}`, 2: `AC${"e2".repeat(16)}` };
const MG = { 1: `MG${hex(0xe1)}`, 2: `MG${hex(0xe2)}` };
const QE = { 1: `QE${hex(0xe1)}`, 2: `QE${hex(0xe2)}` };
const PN = { 1: `PN${hex(0xe1)}`, 2: `PN${hex(0xe2)}` };
const E164 = { 1: "+15035550141", 2: "+15035550142" };
const DIGEST = "cd".repeat(32);
const STUDIOS = `'${S1}', '${S2}', '${S3}'`;
const ENTITIES = `'${E1}', '${E2}'`;
const USERS = Object.values(U).map((u) => `'${u}'`).join(", ");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const exp = 1983812996;
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp }) : "");
const userKey = (id: string) => sign({ iss: "supabase-demo", sub: id, role: "authenticated", aud: "authenticated", exp });
const asUser = (id: string): SupabaseClient => createClient(URL_, anonKey(), { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${userKey(id)}` } } });
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });

// every table a scenario writes, cleared for the fixture studios/businesses (replica role: history guards and foreign keys are fixtures' business only)
const SCENARIO_TABLES = [
  "studio_sms_provider_cancel_ops", "studio_sms_provider_exposure", "studio_sms_recurring_charges", "studio_sms_prov_orphans", "studio_sms_provider_resources",
  "studio_sms_compliance_checks", "studio_sms_optout_attestations", "studio_sms_sender_verifications", "studio_sms_billed_senders",
  "studio_sms_num_resources", "studio_sms_num_operations", "studio_sms_number_selections", "studio_sms_number_offers", "studio_sms_prov_resources", "studio_sms_prov_operations",
];
const CLEAR_SCENARIO = `
${SCENARIO_TABLES.map((t) => `delete from public.${t} where studio_id in (${STUDIOS});`).join("\n")}
delete from public.studio_sms_num_orphans where legal_entity_id in (${ENTITIES});`;

const CLEANUP = `
begin;
set local session_replication_role = replica;
${CLEAR_SCENARIO}
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_access where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding where studio_id in (${STUDIOS});
delete from public.studio_sms_twilio_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_studios where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_legal_entities where id in (${ENTITIES});
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in (${USERS});
delete from auth.users where email like '%@tw4j2-e2e.test';
commit;`;

const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4j2-e2e.test', now(), now(), now()
    from (values ${Object.entries(U).map(([n, id]) => `('${id}', '${n}')`).join(", ")}) u(id, n);
insert into public.profiles (id, platform_role) values ${Object.entries(U).map(([n, id]) => `('${id}', ${n === "padmin" ? "'platform_admin'" : "null"})`).join(", ")}
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values ('${S1}', 'J2 One', 'j2-one', null, 'UTC'), ('${S2}', 'J2 Two', 'j2-two', null, 'UTC'), ('${S3}', 'J2 Three', 'j2-three', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner1}', '${S1}', 'studio_owner', true), ('${U.admin1}', '${S1}', 'studio_admin', true), ('${U.front1}', '${S1}', 'front_desk', true),
  ('${U.exowner1}', '${S1}', 'studio_owner', false), ('${U.owner2}', '${S2}', 'studio_owner', true), ('${U.owner3}', '${S3}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${E1}', 'J2 One LLC', '7771', 50000, '${U.padmin}'), ('${E2}', 'J2 Two LLC', '7772', 50000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${S1}', '${E1}', 'founding', '${U.padmin}', 'fixture: business one', now()), ('${S2}', '${E2}', 'founding', '${U.padmin}', 'fixture: business two', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${E1}', '${ACC[1]}', 'df:test:${E1}', 'test', 'active', '${U.padmin}'), ('${E2}', '${ACC[2]}', 'df:test:${E2}', 'test', 'active', '${U.padmin}');
insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) values ('${S1}', true, 'fixture', '${U.padmin}'), ('${S2}', true, 'fixture', '${U.padmin}');
commit;
begin;
set local session_replication_role = replica;
insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at) values
  ('${O1}', '${S1}', 'campaign_pending', 'J2 One LLC', 'llc', '7771', 1, now()), ('${O2}', '${S2}', 'campaign_pending', 'J2 Two LLC', 'llc', '7772', 1, now());
commit;`;

const scenario = (sql: string, state = "campaign_pending") =>
  psqlFile(`begin; set local session_replication_role = replica; ${CLEAR_SCENARIO} update public.studio_sms_onboarding set state = '${state}' where studio_id in ('${S1}', '${S2}'); ${sql} commit;`);

// fixture builders (business n = studio Sn, entity En, onboarding On)
const S = { 1: S1, 2: S2 } as const;
const E = { 1: E1, 2: E2 } as const;
const O = { 1: O1, 2: O2 } as const;
type N = 1 | 2;
let seq = 0;
const id = () => `e222${(++seq).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;
const offer = (n: N, live = true) => `insert into public.studio_sms_number_offers (id, studio_id, legal_entity_id, twilio_account_sid, candidates, source, evidence_digest, requested_by, expires_at)
  values ('${id()}', '${S[n]}', '${E[n]}', '${ACC[n]}', '[{"e164": "${E164[n]}"}]', 'fake', '${DIGEST}', '${U.padmin}', now() ${live ? "+" : "-"} interval '1 hour');`;
function selection(n: N, status: "approved" | "consumed" | "withdrawn", live = true) {
  const sid = id();
  const offerId = id();
  return {
    id: sid,
    sql: `insert into public.studio_sms_number_offers (id, studio_id, legal_entity_id, twilio_account_sid, candidates, source, evidence_digest, requested_by, expires_at)
            values ('${offerId}', '${S[n]}', '${E[n]}', '${ACC[n]}', '[{"e164": "${E164[n]}"}]', 'fake', '${DIGEST}', '${U.padmin}', now() - interval '1 hour');
          insert into public.studio_sms_number_selections (id, offer_id, studio_id, legal_entity_id, twilio_account_sid, e164, price_cents, funding_mode, approver_user, approver_role, approval_ref, statement, expires_at, status, consumed_at, consumed_by_operation, withdrawn_at)
            values ('${sid}', '${offerId}', '${S[n]}', '${E[n]}', '${ACC[n]}', '${E164[n]}', 115, 'credit_recurring', '${U.owner1}', 'studio_owner', 'fixture-approval-${sid}', '${"I approve this texting number and its monthly fee. ".repeat(2)}',
                    now() ${live ? "+" : "-"} interval '1 hour', '${status}', ${status === "consumed" ? "now()" : "null"}, ${status === "consumed" ? `'${id()}'` : "null"}, ${status === "withdrawn" ? "now()" : "null"});`,
  };
}
function purchase(n: N, status: string, resource?: "owned" | "mismatch") {
  const op = id();
  const sel = selection(n, "consumed");
  const sid = status === "succeeded" ? `'${PN[n]}'` : "null";
  return `${sel.sql}
    insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, selection_id, e164, friendly_name, request_digest, provider_sid, fee_bearing, fee_kinds, started_by, error_code, error_detail_sanitized)
      values ('${op}', '${O[n]}', '${S[n]}', '${E[n]}', '${ACC[n]}', 'number_purchase', 1, 1, '${status}', '${sel.id}', '${E164[n]}', 'df:fixture:num', '${DIGEST}', ${sid}, true, array['number'], '${U.padmin}', 'internal-code-21452', 'internal-detail-must-not-leak');
    ${resource ? `insert into public.studio_sms_num_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, status, mismatch_code, source, evidence_digest)
      values ('${op}', '${E[n]}', '${S[n]}', '${ACC[n]}', 'number', '${PN[n]}', '${E164[n]}', '${resource}', ${resource === "mismatch" ? "'internal-mismatch-code'" : "null"}, 'fake', '${DIGEST}');` : ""}`;
}
const sender = (n: N, status: "pending" | "approved" | "revoked", verificationId: string | null = null) =>
  `insert into public.studio_sms_billed_senders (id, legal_entity_id, studio_id, account_sid, messaging_service_sid, sender_e164, status, set_by, reason, campaign_sid, phone_number_sid, verification_id, created_at)
     values ('${id()}', '${E[n]}', '${S[n]}', '${ACC[n]}', '${MG[n]}', '${E164[n]}', '${status}', '${U.padmin}', 'fixture sender row', '${QE[n]}', '${PN[n]}', ${verificationId ? `'${verificationId}'` : "null"}, now() - interval '10 minutes');`;
const verification = (n: N, vid: string, outcome: "verified" | "failed" | "inconclusive", at = "now()") =>
  `insert into public.studio_sms_sender_verifications (id, legal_entity_id, studio_id, account_sid, messaging_service_sid, campaign_sid, phone_number_sid, sender_e164, source, outcome, failure_code, evidence, created_at)
     values ('${vid}', '${E[n]}', '${S[n]}', '${ACC[n]}', '${MG[n]}', '${QE[n]}', '${PN[n]}', '${E164[n]}', 'provider_read', '${outcome}', ${outcome === "failed" ? "'internal-failure-30034'" : "null"}, '{"campaign": {"us_app_to_person_usecase": "MIXED"}}', ${at});`;
const compliance = (n: N, outcome: "passed" | "failed") =>
  `insert into public.studio_sms_compliance_checks (studio_id, legal_entity_id, twilio_account_sid, messaging_service_sid, campaign_sid, outcome, failure_codes, facts, source, evidence_digest, expected_inbound, actor)
     values ('${S[n]}', '${E[n]}', '${ACC[n]}', '${MG[n]}', '${QE[n]}', '${outcome}', ${outcome === "failed" ? "'internal-compliance-code'" : "null"}, '{}', 'fake', '${DIGEST}', 'https://x.test/api/sms/twilio/inbound', '${U.padmin}');`;
const attestation = (n: N) =>
  `insert into public.studio_sms_optout_attestations (studio_id, legal_entity_id, twilio_account_sid, messaging_service_sid, campaign_sid, attested_by, checklist, evidence_ref)
     values ('${S[n]}', '${E[n]}', '${ACC[n]}', '${MG[n]}', '${QE[n]}', '${U.padmin}', '{}', 'fixture-evidence-ref');`;
function resource(n: N, kind: "campaign" | "number" | "messaging_service", rid = id()) {
  const sid = kind === "campaign" ? QE[n] : kind === "number" ? PN[n] : MG[n];
  const fee = kind === "campaign" ? "'monthly'" : kind === "number" ? "'number'" : "null";
  return { id: rid, sql: `insert into public.studio_sms_provider_resources (id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, fee_kind, source, registered_by, registered_at)
      values ('${rid}', '${E[n]}', '${S[n]}', '${ACC[n]}', '${kind}', '${sid}', ${kind === "number" ? `'${E164[n]}'` : "null"}, ${fee}, 'r2b', '${U.padmin}', now() - interval '1 day');` };
}
// R2a's provider-confirmed Messaging Service and campaign on the active subaccount (what _tw4num_service / _tw4num_campaign accept)
function r2a(n: N) {
  const ms = id();
  const qe = id();
  const op = (oid: string, kind: string, sid: string) => `('${oid}', '${O[n]}', '${S[n]}', '${E[n]}', '${ACC[n]}', '${kind}', 1, 1, 'succeeded', 'df:fixture:${kind}', '${DIGEST}', ${kind === "campaign"}, ${kind === "campaign" ? "array['campaign_vetting']" : "'{}'::text[]"}, '${U.padmin}', '${sid}')`;
  return `insert into public.studio_sms_prov_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, fee_bearing, fee_kinds, started_by, provider_sid)
      values ${op(ms, "messaging_service", MG[n])}, ${op(qe, "campaign", QE[n])};
    insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, use_case, status, source, evidence_digest)
      values ('${ms}', '${E[n]}', '${S[n]}', '${ACC[n]}', 'messaging_service', '${MG[n]}', null, null, 'ready', 'provider_read', '${DIGEST}'),
             ('${qe}', '${E[n]}', '${S[n]}', '${ACC[n]}', 'campaign', '${QE[n]}', '${MG[n]}', 'MIXED', 'verified', 'provider_read', '${DIGEST}');`;
}
const periodKey = (n: N, offset = 0) => psql(`select public._tw4ml_key_add(public._tw4ml_month_key('${E[n]}'::uuid, now()), ${offset})`);

describe.skipIf(!enabled)("TW-4F J2: get_studio_sms_texting_status (real schema, real JWTs)", () => {
  type Answer = { data: Record<string, unknown> | null; error: { code?: string } | null };
  const call = async (who: string, studio = S1) => (await asUser(who).rpc("get_studio_sms_texting_status", { p_studio_id: studio })) as Answer;
  const read = async (studio = S1, who = U.owner1) => {
    const r = await call(who, studio);
    expect(r.error).toBeNull();
    return r.data as {
      available: boolean; version: number; number: { status: string; display: string | null; selection: string }; sender: { status: string }; compliance: { status: string };
      activation: { ready: boolean; checklist: { area: string; ok: boolean }[] } | null;
      fees: { texting_paused: boolean; cancellation_in_progress: boolean; items: { kind: string; current_period: string; next_period: string; attention: string }[] };
      unexpected_resource_review: boolean;
    };
  };

  beforeAll(() => {
    expect(psql(`select to_regprocedure('public.get_studio_sms_texting_status(uuid)') is not null`)).toBe("t");
    psqlFile(FIXTURES);
  });
  beforeEach(() => scenario(""));
  afterAll(() => {
    if (enabled) psqlFile(CLEANUP);
  });

  it("privileges: authenticated only; anon, service_role and PUBLIC cannot execute; security definer with a pinned search_path", () => {
    expect(psql(`select has_function_privilege('authenticated', 'public.get_studio_sms_texting_status(uuid)', 'EXECUTE'), has_function_privilege('anon', 'public.get_studio_sms_texting_status(uuid)', 'EXECUTE'),
                        has_function_privilege('service_role', 'public.get_studio_sms_texting_status(uuid)', 'EXECUTE'), has_function_privilege('public', 'public.get_studio_sms_texting_status(uuid)', 'EXECUTE')`)).toBe("t|f|f|f");
    expect(psql(`select p.prosecdef, p.provolatile, array_to_string(p.proconfig, ';') from pg_proc p where p.oid = 'public.get_studio_sms_texting_status(uuid)'::regprocedure`)).toBe("t|s|search_path=pg_catalog, public, pg_temp");
  });

  it("authorization matrix: only an ACTIVE owner of THIS studio reads it", async () => {
    expect((await call(U.owner1)).error).toBeNull();
    for (const who of [U.admin1, U.front1, U.exowner1, U.owner2, U.owner3, U.padmin, U.plain]) {
      const r = await call(who);
      expect(r.error?.code, who).toBe("42501");
      expect(r.data, who).toBeNull();
    }
    // a token with no identity (authenticated role, no subject) is refused too
    const noSub = createClient(URL_, anonKey(), { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${sign({ iss: "supabase-demo", role: "authenticated", aud: "authenticated", exp })}` } } });
    expect(((await noSub.rpc("get_studio_sms_texting_status", { p_studio_id: S1 })) as Answer).error?.code).toBe("42501");
    // the pilot switch off: the owner learns only that it is unavailable
    expect((await call(U.owner3, S3)).data).toEqual({ available: false });
    // an unknown studio id is a refusal, not an empty answer
    expect((await call(U.owner1, "e2220000-0000-4000-8000-00000000ffff")).error?.code).toBe("42501");
  });

  it("the app wrapper reads it through the owner's own session", async () => {
    expect(await getOwnerTextingStatus(asUser(U.owner1), S1)).toMatchObject({ number: { status: "not_started" }, sender: { status: "not_ready" }, compliance: { status: "pending" } });
    expect(await getOwnerTextingStatus(asUser(U.admin1), S1)).toBeNull();
  });

  it("baseline: nothing provisioned", async () => {
    const r = await read();
    expect(r).toMatchObject({ available: true, version: 1, number: { status: "not_started", display: null, selection: "none" }, sender: { status: "not_ready" }, compliance: { status: "pending" },
      fees: { texting_paused: false, cancellation_in_progress: false, items: [] }, unexpected_resource_review: false });
    expect(r.activation, "the checklist is evaluated only once the location reaches activation").toBeNull();
  });

  it("number: offers, selection, purchase and ownership, each mapped; the number only masked and only once ownership is confirmed", async () => {
    scenario(offer(1, false));
    expect((await read()).number).toEqual({ status: "not_started", display: null, selection: "none" });
    scenario(offer(1));
    expect((await read()).number).toEqual({ status: "options_available", display: null, selection: "none" });
    scenario(offer(1) + selection(1, "approved").sql);
    expect((await read()).number).toEqual({ status: "selected", display: null, selection: "open" });
    scenario(offer(1) + selection(1, "approved", false).sql);
    expect((await read()).number).toEqual({ status: "options_available", display: null, selection: "expired" });
    scenario(selection(1, "withdrawn").sql);
    expect((await read()).number).toEqual({ status: "not_started", display: null, selection: "withdrawn" });
    for (const [status, res, expected] of [["in_flight", undefined, "purchasing"], ["unknown_outcome", undefined, "purchasing"], ["succeeded", undefined, "purchasing"], ["succeeded", "mismatch", "attention"], ["failed", undefined, "failed"], ["abandoned", undefined, "failed"]] as const) {
      scenario(purchase(1, status, res));
      expect((await read()).number, `${status}/${res}`).toEqual({ status: expected, display: null, selection: "used" });
    }
    scenario(purchase(1, "succeeded", "owned"));
    expect((await read()).number).toEqual({ status: "secured", display: "***-***-0141", selection: "used" });
    // a purchase on a subaccount that is no longer the business's active one is history, not this location's number
    scenario(purchase(1, "succeeded", "owned").replaceAll(`'${ACC[1]}'`, `'AC${"ee".repeat(16)}'`));
    expect((await read()).number.status).toBe("not_started");
    // a retired (superseded) purchase: an older failed attempt does not resurface as "could not be secured"
    scenario(purchase(1, "failed").replaceAll(E164[1], "+15035550177") + purchase(1, "succeeded", "owned").replace("'number_purchase', 1, 1,", "'number_purchase', 2, 1,")
      + `update public.studio_sms_num_operations set superseded_at = now() where studio_id = '${S1}' and attempt = 2;`);
    expect((await read()).number.status).toBe("not_started");
    // a selection from before this onboarding started is not the owner's current choice
    scenario(selection(1, "approved").sql + `update public.studio_sms_number_selections set approved_at = now() - interval '10 days' where studio_id = '${S1}';
      update public.studio_sms_onboarding set created_at = now() - interval '1 day' where id = '${O1}';`);
    expect((await read()).number).toEqual({ status: "not_started", display: null, selection: "none" });
  });

  it("sender: not ready, verifying, failed verification and ready (verified, current, matching the active subaccount)", async () => {
    scenario(sender(1, "revoked"));
    expect((await read()).sender.status).toBe("not_ready");
    scenario(sender(1, "pending"));
    expect((await read()).sender.status).toBe("verifying");
    const v1 = id();
    scenario(sender(1, "pending") + verification(1, v1, "failed"));
    expect((await read()).sender.status).toBe("failed_verification");
    const v0 = id();
    scenario(verification(1, v0, "failed", "now() - interval '1 hour'") + sender(1, "pending"));
    expect((await read()).sender.status, "a failure from before the current sender row is not its verdict").toBe("verifying");
    const v2 = id();
    scenario(verification(1, v2, "verified") + sender(1, "approved", v2));
    expect((await read()).sender.status).toBe("ready");
    const v3 = id();
    scenario(verification(1, v3, "verified", "now() - interval '25 hours'") + sender(1, "approved", v3));
    expect((await read()).sender.status, "a stale verification is not ready").toBe("verifying");
  });

  it("compliance: pending, attention, complete, and only for the CURRENT account, service and campaign", async () => {
    scenario(r2a(1) + compliance(1, "passed"));
    expect((await read()).compliance.status, "passed without DanceFlow's opt-out attestation").toBe("pending");
    scenario(r2a(1) + compliance(1, "passed") + attestation(1));
    expect((await read()).compliance.status).toBe("complete");
    scenario(r2a(1) + attestation(1) + compliance(1, "failed"));
    expect((await read()).compliance.status).toBe("attention");
    scenario(compliance(1, "passed") + attestation(1));
    expect((await read()).compliance.status, "no provider-confirmed service and campaign: the validation is not of the current setup").toBe("pending");
    scenario(r2a(1) + compliance(1, "passed").replace(`'${QE[1]}'`, `'QE${hex(0xfff)}'`) + attestation(1));
    expect((await read()).compliance.status, "a validation of another campaign is history").toBe("pending");
  });

  it("activation checklist: owner areas only, ok reflecting the underlying checks", async () => {
    const v = id();
    scenario(purchase(1, "succeeded", "owned") + verification(1, v, "verified") + sender(1, "approved", v) + compliance(1, "passed") + attestation(1), "ready_for_activation");
    const r = await read();
    expect(r.activation?.ready).toBe(false);
    expect(r.activation!.checklist.map((i) => i.area)).toEqual(["provider", "number", "sender", "compliance", "billing", "monitoring", "review"]);
    expect(r.activation!.checklist.find((i) => i.area === "number")?.ok, "owned but not attached").toBe(false);
    for (const i of r.activation!.checklist) expect(Object.keys(i).sort()).toEqual(["area", "ok"]);
    expect(r.activation!.checklist.find((i) => i.area === "billing")?.ok).toBe(false);
  });

  it("service coverage: this location's live fee resources only, in owner categories; DanceFlow-settled periods are covered; registered orphans are left out", async () => {
    const camp = resource(1, "campaign");
    const num = resource(1, "number");
    const svc = resource(1, "messaging_service");
    const cur = periodKey(1);
    const authId = id();
    scenario(`${camp.sql} ${num.sql} ${svc.sql}
      insert into public.studio_sms_recurring_charges (id, authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reservation_id, attempts, charged_at)
        values ('${id()}', '${authId}', '${E1}', '${S1}', 'monthly', '${cur}', 1000, 'charged', '${id()}', 1, now());`);
    let r = await read();
    expect(r.fees.items).toEqual([
      { kind: "texting_service", current_period: "covered", next_period: "not_covered", attention: "authorization_needed" },
      { kind: "phone_number", current_period: "not_covered", next_period: "not_covered", attention: "authorization_needed" },
    ]);
    // an administrator absorbed this month for the number: not the owner's to cover
    scenario(`${num.sql} insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, state, reason, expected_provider_cents, closed_at, disposition, disposed_by, disposition_note)
      values ('${num.id}', '${E1}', '${S1}', '${cur}', 'closed', 'no_authorization', 115, now(), 'absorbed', '${U.padmin}', 'fixture: DanceFlow absorbed this period');`);
    r = await read();
    expect(r.fees.items).toEqual([{ kind: "phone_number", current_period: "covered", next_period: "not_covered", attention: "authorization_needed" }]);
    // a campaign orphan an administrator registered in the lifecycle: never a coverage row (the owner is never asked to authorize or pay for it), only the neutral flag
    const orphanRes = resource(1, "campaign");
    scenario(`${orphanRes.sql} insert into public.studio_sms_prov_orphans (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, scope_sid, first_listing_id, source_operation_id, status, rfl_resource_id, registered_by, registered_at)
      values ('${E1}', '${S1}', '${ACC[1]}', 'campaign', '${QE[1]}', '${MG[1]}', '${id()}', '${id()}', 'registered', '${orphanRes.id}', '${U.padmin}', now());`);
    r = await read();
    expect(r.fees.items).toEqual([]);
    expect(r.unexpected_resource_review).toBe(true);
    // the same orphan registered by hand (no rfl_resource_id link) is still left out, by its SID
    const byHand = resource(1, "campaign");
    scenario(`${byHand.sql} insert into public.studio_sms_prov_orphans (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, scope_sid, first_listing_id, source_operation_id, status)
      values ('${E1}', '${S1}', '${ACC[1]}', 'campaign', '${QE[1]}', '${MG[1]}', '${id()}', '${id()}', 'open');`);
    expect((await read()).fees.items).toEqual([]);
    // a number that is a number orphan of the business (open, acknowledged or adopted by DanceFlow) is never a coverage row
    for (const status of ["open", "acknowledged", "adopted"]) {
      const orphanNum = resource(1, "number");
      scenario(`${orphanNum.sql} insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind, status, cost_bearer, resolved_by, resolved_at, resolution_note) values ('${E1}', '${ACC[1]}', '${PN[1]}', '${E164[1]}', 'unknown', '${status}', ${status === "adopted" ? `'danceflow', '${U.padmin}', now(), 'fixture: adopted by DanceFlow'` : "null, null, null, null"});`);
      expect((await read()).fees.items, status).toEqual([]);
    }
    // a resource an administrator registered by hand is DanceFlow's to review, never presented as the owner's to authorize or fund
    const admin = resource(1, "number");
    scenario(admin.sql.replace("'r2b', ", "'admin', "));
    expect((await read()).fees.items).toEqual([{ kind: "phone_number", current_period: "not_covered", next_period: "not_covered", attention: "danceflow_review" }]);
    // an open cancellation: the gate holds sending, both flags set, no detail (the gate is evaluated only where texting can be on)
    const cancelOp = `${num.sql} insert into public.studio_sms_provider_cancel_ops (resource_id, legal_entity_id, studio_id, status, decided_by, approval_ref, ref_norm, reason, irreversible_ack, authorized_by)
      values ('${num.id}', '${E1}', '${S1}', 'authorized', 'owner_written', 'fixture-cancel-ref-1', 'fixture-cancel-ref-1', 'fixture: cancelling the number', true, '${U.padmin}');`;
    scenario(cancelOp, "active");
    r = await read();
    expect(r.fees.texting_paused).toBe(true);
    expect(r.fees.cancellation_in_progress).toBe(true);
    scenario(cancelOp);
    r = await read();
    expect(r.fees.texting_paused, "before activation texting is not on, so it is not 'paused'").toBe(false);
    expect(r.fees.cancellation_in_progress).toBe(true);
  });

  it("unexpected resources: a neutral boolean from this business's number orphans and this location's campaign orphans; another business's never counts", async () => {
    const numOrphan = (entity: string, account: string, status = "open") => `insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind, status) values ('${entity}', '${account}', 'PN${hex(0xabc)}', '+15035550199', 'unknown', '${status}');`;
    scenario(numOrphan(E1, ACC[1]));
    expect((await read()).unexpected_resource_review).toBe(true);
    expect((await read(S2, U.owner2)).unexpected_resource_review).toBe(false);
    scenario(numOrphan(E2, ACC[2]));
    expect((await read()).unexpected_resource_review).toBe(false);
    expect((await read(S2, U.owner2)).unexpected_resource_review).toBe(true);
    scenario(`insert into public.studio_sms_prov_orphans (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, scope_sid, first_listing_id, source_operation_id, status)
      values ('${E1}', '${S1}', '${ACC[1]}', 'campaign', 'QE${hex(0xabd)}', '${MG[1]}', '${id()}', '${id()}', 'open');`);
    expect((await read()).unexpected_resource_review).toBe(true);
    scenario(`insert into public.studio_sms_prov_orphans (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, scope_sid, first_listing_id, source_operation_id, status, closed_by, closed_at, close_note)
      values ('${E1}', '${S1}', '${ACC[1]}', 'campaign', 'QE${hex(0xabd)}', '${MG[1]}', '${id()}', '${id()}', 'closed', '${U.padmin}', now(), 'fixture: closed orphan note');`);
    expect((await read()).unexpected_resource_review).toBe(false);
  });

  it("payload: exactly the contract keys, and no identifier, phone number, cost, EIN, digest or internal text anywhere, with everything provisioned", async () => {
    const v = id();
    const camp = resource(1, "campaign");
    const num = resource(1, "number");
    scenario(`${r2a(1)} ${purchase(1, "succeeded", "owned")} ${verification(1, v, "verified")} ${sender(1, "approved", v)} ${compliance(1, "passed")} ${attestation(1)} ${camp.sql} ${num.sql}
      insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind, status) values ('${E1}', '${ACC[1]}', 'PN${hex(0xabc)}', '+15035550199', 'unknown', 'open');
      insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, state, reason, expected_provider_cents, provider_billed_cents) values ('${num.id}', '${E1}', '${S1}', '${periodKey(1)}', 'open', 'no_authorization', 115, 115);`, "ready_for_activation");
    const r = await read();
    const keys = (v: unknown, path = ""): string[] =>
      Array.isArray(v) ? v.flatMap((x) => keys(x, `${path.replace(/\.$/, "")}[].`)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [`${path}${k}`, ...keys(x, `${path}${k}.`)]) : [];
    expect([...new Set(keys(r))].sort()).toEqual([
      "activation", "activation.checklist", "activation.checklist[].area", "activation.checklist[].ok", "activation.ready",
      "available",
      "compliance", "compliance.status",
      "fees", "fees.cancellation_in_progress", "fees.items", "fees.items[].attention", "fees.items[].current_period", "fees.items[].kind", "fees.items[].next_period", "fees.texting_paused",
      "number", "number.display", "number.selection", "number.status",
      "sender", "sender.status",
      "unexpected_resource_review",
      "version",
    ].sort());
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/(AC|MG|QE|PN)[0-9a-fA-F]{32}/);
    expect(text).not.toMatch(/\+1\d{10}|503555|0199/);
    expect(text).not.toMatch(/e2220000|(cd){8}|7771|115|1000|internal|fixture|cents|ein|digest|sid|error|https?:/i);
    expect(r.number.display).toBe("***-***-0141");
  });

  it("tenant isolation: one owner never sees or reaches another studio's facts", async () => {
    const v = id();
    scenario(`${r2a(2)} ${purchase(2, "succeeded", "owned")} ${verification(2, v, "verified")} ${sender(2, "approved", v)} ${compliance(2, "passed")} ${attestation(2)} ${resource(2, "number").sql}`);
    expect((await call(U.owner1, S2)).error?.code).toBe("42501");
    const mine = await read();
    expect(mine).toMatchObject({ number: { status: "not_started", display: null }, sender: { status: "not_ready" }, compliance: { status: "pending" }, fees: { items: [] } });
    const theirs = await read(S2, U.owner2);
    expect(theirs).toMatchObject({ number: { status: "secured", display: "***-***-0142" }, sender: { status: "ready" }, compliance: { status: "complete" } });
    expect(theirs.fees.items).toHaveLength(1);
  });
});
