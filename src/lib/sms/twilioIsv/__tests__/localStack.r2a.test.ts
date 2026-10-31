/**
 * TW-4F R2a (20261207090000) against a REAL schema: the provisioning ledger, the fee gate, provider-evidence verdicts, unknown-outcome handling and
 * resolution, resubmission authorization, the ConfiDance pilot ceiling, tenant isolation and rollback refusal, driven through the real runner with the
 * FAKE provider (no Twilio, no SMS, no Stripe). Synthetic fixtures with their own id block; every row written is removed afterwards. Rollback is only
 * ever executed inside a transaction that is rolled back.
 * LOCAL QA STACK ONLY (skipped unless the variables point at a loopback stack with the migrations through 20261207090000 applied):
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.r2a.test.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PRICE_FIXTURE_REQUESTER, ownerReactivate, seedPrice } from "./priceFixture";
import { spendEvidenceRpc, exceptionEvidenceRpc } from "./rflEvidenceHelper";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

import { SupabaseCreditStore } from "../creditStore";
import { FakeProvisioningAdapter, FakeProvisioningHub } from "../fakeProvisioning";
import { SupabaseProvisionStore } from "../provisionStore";
import { refreshProvisioning, runProvisioning, type ProvisionInput } from "../provisionRunner";
import { ProvisionEvidenceStore, checkCampaignAbsence } from "../provisionEvidence";

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

const SA1 = "a2a00000-0000-4000-8000-00000000000a"; // business A (credit funded, Standard), location 1
const SA2 = "a2a00000-0000-4000-8000-00000000000b"; // business A, location 2
const SB1 = "a2a00000-0000-4000-8000-00000000000c"; // business B (credit funded, verified Low-Volume Standard)
const SC1 = "a2a00000-0000-4000-8000-00000000000d"; // business C (the ConfiDance pilot business)
const SD1 = "a2a00000-0000-4000-8000-00000000000e"; // business D (credit funded, Standard)
const EA = "e2a00000-0000-4000-8000-0000000000a1";
const EB = "e2a00000-0000-4000-8000-0000000000b1";
const EC = "e2a00000-0000-4000-8000-0000000000c1";
const ED = "e2a00000-0000-4000-8000-0000000000d1";
const OA1 = "02a00000-0000-4000-8000-0000000000a1";
const OA2 = "02a00000-0000-4000-8000-0000000000a2";
const OB1 = "02a00000-0000-4000-8000-0000000000b1";
const OC1 = "02a00000-0000-4000-8000-0000000000c1";
const OD1 = "02a00000-0000-4000-8000-0000000000d1";
const U = { owner_a: "a2a00000-0000-4000-8000-000000000101", owner_b: "a2a00000-0000-4000-8000-000000000201", padmin: "a2a00000-0000-4000-8000-000000000401" };
const ACC = { A: `AC${"a2".repeat(16)}`, B: `AC${"b2".repeat(16)}`, C: `AC${"c2".repeat(16)}`, D: `AC${"d2".repeat(16)}` };
const BRAND = { A1: `BN${"a1".repeat(16)}`, A2: `BN${"a2".repeat(16)}`, B1: `BN${"b1".repeat(16)}`, C1: `BN${"c1".repeat(16)}`, D1: `BN${"d1".repeat(16)}` };
const RUN = randomBytes(3).toString("hex");
const CHECKLIST = { ein_registered: true, not_sole_proprietor: true, low_volume_expected: true, owner_informed_limits: true, owner_informed_review: true };
const INBOUND = "https://app.example.test/api/sms/twilio/inbound";
const PRICE = { vetting: 1900, monthly: 1250, monthlyLvs: 250 };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};

const ENTITIES = `'${EA}', '${EB}', '${EC}', '${ED}'`;
const STUDIOS = `'${SA1}', '${SA2}', '${SB1}', '${SC1}', '${SD1}'`;
const CLEANUP = `
begin;
set local session_replication_role = replica;
-- the fee-resolution evidence tables (20261212) exist only on a stack that carries that layer; an R2a-only stack must clean up too
do $$ begin if to_regclass('public.studio_sms_prov_listings') is not null then
  delete from public.studio_sms_prov_orphans where studio_id in (${STUDIOS});
  delete from public.studio_sms_prov_dispositions where studio_id in (${STUDIOS});
  delete from public.studio_sms_prov_listings where studio_id in (${STUDIOS});
end if; end $$;
delete from public.studio_sms_prov_resources where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_operations where studio_id in (${STUDIOS});
delete from public.studio_sms_pilot_exceptions where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_approval_refs where legal_entity_id in (${ENTITIES});
update public.studio_sms_recurring_charges set run_id = null where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_charges where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_authorizations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_monthly_limits where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_timezones where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_limit_ceilings where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_spend_events where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_ledger where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_reservations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES}));
delete from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_price_change_requests where requested_by = '${PRICE_FIXTURE_REQUESTER}' or decided_by = '${U.padmin}';
delete from public.studio_sms_price_list where created_by = '${U.padmin}';
delete from public.studio_sms_provisioning_steps where studio_id in (${STUDIOS});
delete from public.studio_sms_registrations where studio_id in (${STUDIOS});
delete from public.studio_sms_tier_decisions where studio_id in (${STUDIOS});
delete from public.studio_sms_runner_windows where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_access where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding where studio_id in (${STUDIOS});
delete from public.studio_sms_twilio_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_studios where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_legal_entities where id in (${ENTITIES});
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in (${Object.values(U).map((u) => `'${u}'`).join(", ")});
delete from auth.users where email like '%@tw4r2a-e2e.test';
commit;`;

const onboardingRow = (id: string, studio: string, last4: string, name: string) =>
  `('${id}', '${studio}', 'service_setup', '${name}', 'llc', '${last4}', 1, now())`;
const brandSql = (onboarding: string, studio: string, account: string, brand: string) => `
  insert into public.studio_sms_registrations (studio_id, registration_status, brand_sid, brand_status) values ('${studio}', 'in_review', '${brand}', 'approved')
    on conflict (studio_id) do update set brand_sid = excluded.brand_sid, brand_status = excluded.brand_status;
  insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status, provider_sid, mock, twilio_account_sid)
    values ('${onboarding}', '${studio}', 'B1', 1, 'succeeded', '${brand}', false, '${account}');`;

const FIXTURES = `${CLEANUP}
create table if not exists public.tw4_local_qa_only (note text); revoke all on public.tw4_local_qa_only from public, anon, authenticated, service_role;
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4r2a-e2e.test', now(), now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.owner_b}', 'owner_b'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.owner_b}', null), ('${U.padmin}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values
  ('${SA1}', 'R2A Location A1', 'r2a-a1', null, 'UTC'), ('${SA2}', 'R2A Location A2', 'r2a-a2', null, 'UTC'), ('${SB1}', 'R2A Location B1', 'r2a-b1', null, 'UTC'),
  ('${SC1}', 'R2A Location C1', 'r2a-c1', null, 'UTC'), ('${SD1}', 'R2A Location D1', 'r2a-d1', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${SA1}', 'studio_owner', true), ('${U.owner_a}', '${SA2}', 'studio_owner', true), ('${U.owner_a}', '${SD1}', 'studio_owner', true), ('${U.owner_a}', '${SC1}', 'studio_owner', true), ('${U.owner_b}', '${SB1}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'R2A Alpha LLC', '8881', 50000, '${U.padmin}'), ('${EB}', 'R2A Beta LLC', '8882', 50000, '${U.padmin}'),
  ('${EC}', 'ConfiDance Unlimited, LLC', '8883', 15000, '${U.padmin}'), ('${ED}', 'R2A Delta LLC', '8884', 50000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${SA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 1', now()),
  ('${SA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 2', now()),
  ('${SB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B', now()),
  ('${SC1}', '${EC}', 'founding', '${U.padmin}', 'fixture: verified business C', now()),
  ('${SD1}', '${ED}', 'founding', '${U.padmin}', 'fixture: verified business D', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${EA}', '${ACC.A}', 'df:test:${EA}', 'test', 'active', '${U.padmin}'), ('${EB}', '${ACC.B}', 'df:test:${EB}', 'test', 'active', '${U.padmin}'),
  ('${EC}', '${ACC.C}', 'df:test:${EC}', 'test', 'active', '${U.padmin}'), ('${ED}', '${ACC.D}', 'df:test:${ED}', 'test', 'active', '${U.padmin}');
insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) select s, true, 'fixture: provisioning tests', '${U.padmin}' from unnest(array[${STUDIOS}]::uuid[]) s;
commit;
begin;
set local session_replication_role = replica;
insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at) values
  ${onboardingRow(OA1, SA1, "8881", "R2A Alpha LLC")}, ${onboardingRow(OA2, SA2, "8881", "R2A Alpha LLC")}, ${onboardingRow(OB1, SB1, "8882", "R2A Beta LLC")},
  ${onboardingRow(OC1, SC1, "8883", "ConfiDance Unlimited, LLC")}, ${onboardingRow(OD1, SD1, "8884", "R2A Delta LLC")};
${brandSql(OA1, SA1, ACC.A, BRAND.A1)}
${brandSql(OA2, SA2, ACC.A, BRAND.A2)}
${brandSql(OC1, SC1, ACC.C, BRAND.C1)}
${brandSql(OD1, SD1, ACC.D, BRAND.D1)}
commit;`;

describe.skipIf(!enabled)("TW-4F R2a: Messaging Service and campaign provisioning (real schema, fake provider)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let store: SupabaseProvisionStore;
  let snapshotActivePrices: string[] = [];
  let pilotUsable = true;
  const hub = new FakeProvisioningHub();
  let n = 0;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const ref = (label: string) => `Owner email ${RUN} ${label} approving one fee`;
  const authorize = (entity: string, studio: string, kind: string, cents: number, approvalRef: string, funding: "credit" | "pilot" = "credit") =>
    rpc("tw4_spend_authorize", { p_entity_id: entity, p_kind: kind, p_amount_cents: cents, p_approval_ref: approvalRef, p_actor: U.padmin, p_funding: funding, p_studio_id: studio, ...spendEvidenceRpc(funding, kind, entity, studio, cents, approvalRef) });
  const fund = async (entity: string, studio: string, pack: number, settle = true) => {
    n += 1;
    const pref = `cs_r2a_${RUN}_${n}`;
    await credits.topupPending(entity, studio, pref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    if (settle) await credits.settleTopup(entity, studio, pref, pack, `evt_r2a_${RUN}_${n}`, `pi_r2a_${RUN}_${n}`, true);
  };
  const recurring = (studio: string, user: string, kind: string, price: number) =>
    rpc("tw4_recurring_authorize", { p_studio_id: studio, p_user_id: user, p_kind: kind, p_acknowledged_price_cents: price, p_term_months: 3, p_total_limit_cents: null });
  const window = async (studio: string) => expect((await rpc("tw4_runner_set_window", { p_studio_id: studio, p_actor: U.padmin, p_hours: 2, p_reason: "fixture: provisioning window" })).error).toBeNull();
  const input = (studio: string, adapter: FakeProvisioningAdapter, over: Partial<ProvisionInput> = {}): ProvisionInput => ({
    store, adapter, studioId: studio, actorId: U.padmin, envName: "test", confirmFee: true, inboundUrl: INBOUND, origin: "https://www.idanceflow.com", ...over,
  });
  const run = async (studio: string, adapter: FakeProvisioningAdapter, over: Partial<ProvisionInput> = {}) => {
    const result = await runProvisioning(input(studio, adapter, over));
    if (process.env.R2A_DEBUG) console.log("run", studio.slice(-2), JSON.stringify(result));
    return result;
  };
  const refresh = async (studio: string, adapter: FakeProvisioningAdapter) => {
    const result = await refreshProvisioning({ ...input(studio, adapter), confirmFee: undefined } as never);
    if (process.env.R2A_DEBUG) console.log("refresh", studio.slice(-2), JSON.stringify(result));
    return result;
  };
  const state = (studio: string) => psql(`select state from public.studio_sms_onboarding where studio_id = '${studio}'`);
  const code = (studio: string) => psql(`select coalesce(last_error_code, '') from public.studio_sms_onboarding where studio_id = '${studio}'`);
  const ops = (studio: string, kind: string) => psql(`select string_agg(attempt || ':' || status || ':' || (superseded_at is not null), ',' order by attempt) from public.studio_sms_prov_operations where studio_id = '${studio}' and op_kind = '${kind}'`);
  const opId = (studio: string, kind: string, attempt = 1) => psql(`select id from public.studio_sms_prov_operations where studio_id = '${studio}' and op_kind = '${kind}' and attempt = ${attempt}`);
  const reserved = (entity: string) => Number(psql(`select coalesce((select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 0)`));
  const spendStatus = (approvalRef: string) => psql(`select status from public.studio_sms_spend_events where approval_ref = $q$${approvalRef}$q$`);
  const reservations = (entity: string, kind: string) => psql(`select string_agg(status || ':' || amount_cents || ':' || funding, ',' order by created_at) from public.studio_sms_credit_reservations where legal_entity_id = '${entity}' and kind = '${kind}'`);

  beforeAll(async () => {
    expect(psql(`select to_regclass('public.studio_sms_prov_operations') is not null`)).toBe("t");
    psqlFile(FIXTURES);
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    store = new SupabaseProvisionStore(admin);
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    expect((await rpc("tw4_onboarding_decide_tier", { p_studio_id: SB1, p_actor: U.padmin, p_tier: "low_volume_standard", p_reason: "fixture: EIN business, low volume", p_eligibility: CHECKLIST })).error).toBeNull();
    aged(brandSql(OB1, SB1, ACC.B, BRAND.B1)); // the tier is frozen once a brand attempt exists, so business B's brand is recorded only after its tier decision
    for (const [kind, customer, provider] of [["campaign_vetting", PRICE.vetting, 1500], ["monthly", PRICE.monthly, 1000], ["monthly_low_volume", PRICE.monthlyLvs, 150]] as const) {
      seedPrice(psql, { kind: kind, customer: customer, provider: provider, description: `fixture ${kind}`, approver: U.padmin });
    }
    for (const s of [SA1, SA2, SB1, SC1, SD1]) await window(s);
    pilotUsable = psql(`select count(*) from public.studio_sms_pilot_exceptions`) === "0";
  });

  afterAll(() => {
    if (!enabled) return;
    try {
      psqlFile(CLEANUP);
      ownerReactivate(psql, `id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
  });

  it("privileges: the ledger tables are unreachable by API roles; actions are service-role only; helpers are callable by no API role", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of ["studio_sms_prov_operations", "studio_sms_prov_resources"]) {
        expect(psql(`select has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete')`), `${role} ${table}`).toBe("f");
      }
    }
    for (const fn of ["tw4_prov_claim(uuid, uuid, text, integer, text)", "tw4_prov_context(uuid, text)", "tw4_prov_begin(uuid, text, text, text, text, jsonb, uuid)", "tw4_prov_finish(uuid, text, uuid, text, text, text, text)",
      "tw4_prov_observe(uuid, text, uuid, jsonb, text, text, text)", "tw4_prov_resolve(uuid, uuid, text, text, text)", "tw4_prov_reopen(uuid, uuid, text)", "tw4_prov_status(uuid, uuid)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    for (const fn of ["_tw4prov_brand(uuid)", "_tw4prov_use_case(text)", "_tw4prov_campaign_requirements(uuid)", "_tw4prov_guard()"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("f");
    }
  });

  it("the Messaging Service is created once, in the right business's subaccount, and judged ready from provider reads; a replay never creates another", async () => {
    const a = hub.adapterFor(ACC.A);
    const first = await run(SA1, a, { stopAfterService: true });
    expect(first.outcome).toBe("service_ready");
    expect(a.count("createMessagingService")).toBe(1);
    expect(psql(`select twilio_account_sid || '|' || status || '|' || fee_bearing from public.studio_sms_prov_operations where id = '${opId(SA1, "messaging_service")}'`)).toBe(`${ACC.A}|succeeded|false`);
    expect(psql(`select r.status || '|' || r.source || '|' || r.twilio_account_sid from public.studio_sms_prov_resources r where r.operation_id = '${opId(SA1, "messaging_service")}'`)).toBe(`ready|fake|${ACC.A}`);
    const second = await run(SA1, a, { stopAfterService: true });
    expect(second.outcome).toBe("service_ready");
    expect(a.count("createMessagingService")).toBe(1);
    expect(hub.adapterFor(ACC.B).count("createMessagingService")).toBe(0);
  });

  it("an adapter that belongs to another business's subaccount is refused before any call (cross-tenant)", async () => {
    const wrong = hub.adapterFor(ACC.B);
    const before = wrong.calls.length;
    expect((await run(SA1, wrong)).outcome).toBe("account_mismatch");
    expect(wrong.calls.length).toBe(before);
    const parentLike = new FakeProvisioningAdapter(`AC${"9".repeat(32)}`);
    expect((await run(SA1, parentLike)).outcome).toBe("account_mismatch");
    expect(parentLike.calls).toHaveLength(0);
  });

  it("a lost response on the Messaging Service create is reconciled by lookup: the service is adopted, never duplicated", async () => {
    const d = hub.adapterFor(ACC.D);
    d.failNext("createMessagingService", { kind: "transient", lostResponse: true });
    const first = await run(SD1, d, { stopAfterService: true });
    expect(first.outcome).toBe("retry_later");
    expect(ops(SD1, "messaging_service")).toBe("1:unknown_outcome:false");
    const second = await run(SD1, d, { stopAfterService: true });
    expect(second.outcome).toBe("service_ready");
    expect(d.count("createMessagingService")).toBe(1);
    expect(d.services.size).toBe(1);
    expect(ops(SD1, "messaging_service")).toBe("1:succeeded:false");
  });

  it("a service whose route is not DanceFlow's is not ready: nothing proceeds and the onboarding goes to a human", async () => {
    const b = hub.adapterFor(ACC.B);
    expect((await run(SB1, b, { stopAfterService: true })).outcome).toBe("service_ready");
    const sid = [...b.services.keys()][0];
    b.tamperService(sid, { inbound_request_url: "https://elsewhere.example/hook" });
    const bad = await refresh(SB1, b);
    expect(bad.outcome).toBe("exception");
    expect(bad.detail).toContain("inbound_route");
    expect(psql(`select r.status || '|' || r.mismatch_code from public.studio_sms_prov_resources r where r.operation_id = '${opId(SB1, "messaging_service")}'`)).toBe("mismatch|inbound_route");
    b.tamperService(sid, { inbound_request_url: INBOUND });
    expect((await refresh(SB1, b)).outcome).toBe("service_ready");
  });

  it("two runners at once create exactly one Messaging Service (the lease and the one-live-operation index)", async () => {
    const c = hub.adapterFor(ACC.C);
    const results = await Promise.all([run(SC1, c, { stopAfterService: true }), run(SC1, c, { stopAfterService: true })]);
    expect(c.count("createMessagingService")).toBe(1);
    expect(results.map((r) => r.outcome).filter((o) => o === "service_ready").length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.outcome === "service_ready" || r.outcome === "lease_busy")).toBe(true);
    expect(ops(SC1, "messaging_service")).toBe("1:succeeded:false");
  });

  it("another location of the same legal business does not create or silently share a second service (no duplicate fee, no silent reuse)", async () => {
    const a = hub.adapterFor(ACC.A);
    const before = a.count("createMessagingService");
    const result = await run(SA2, a, { stopAfterService: true });
    expect(result.outcome).toBe("entity_resource_exists");
    expect(a.count("createMessagingService")).toBe(before);
  });

  describe("campaign fee gate (business A, Standard path, credit funded)", () => {
    it("without the admin's fee confirmation nothing is reserved or called", async () => {
      const a = hub.adapterFor(ACC.A);
      const result = await run(SA1, a, { confirmFee: false });
      expect(result.outcome).toBe("waiting_fee_confirmation");
      expect(a.count("createCampaign")).toBe(0);
      expect(ops(SA1, "campaign")).toBeFalsy();
    });

    it("a missing published price refuses before anything is reserved", async () => {
      aged(`update public.studio_sms_price_list set active = false where kind = 'campaign_vetting' and created_by = '${U.padmin}'`);
      const a = hub.adapterFor(ACC.A);
      const result = await run(SA1, a);
      ownerReactivate(psql, `kind = 'campaign_vetting' and created_by = '${U.padmin}'`);
      expect(result.outcome).toBe("tier_unpriced");
      expect(a.count("createCampaign")).toBe(0);
      expect(reserved(EA)).toBe(0);
    });

    it("no owner-approved campaign fee refuses; and the reference of an approval can never be reused (permanent references)", async () => {
      const a = hub.adapterFor(ACC.A);
      expect((await run(SA1, a)).outcome).toBe("spend_blocked");
      expect(a.count("createCampaign")).toBe(0);
      const r1 = ref("vetting-a1");
      expect((await authorize(EA, SA1, "campaign_vetting", PRICE.vetting, r1)).error).toBeNull();
      expect((await authorize(EA, SA1, "campaign_vetting", PRICE.vetting, r1.toUpperCase(), "credit")).error).toBeNull(); // an identical retry replays it
      expect((await authorize(EB, SB1, "campaign_vetting", PRICE.vetting, r1)).error?.code).toBe("TW019"); // another business: refused
      expect(spendStatus(r1)).toBe("authorized");
    });

    it("a credit business needs an ACTIVE recurring authorization for the monthly fee; with the vetting approval alone nothing is reserved (all or none)", async () => {
      const a = hub.adapterFor(ACC.A);
      const result = await run(SA1, a);
      expect(result.outcome).toBe("recurring_missing");
      expect(a.count("createCampaign")).toBe(0);
      expect(spendStatus(ref("vetting-a1"))).toBe("authorized");
      expect(reserved(EA)).toBe(0);
    });

    it("unsettled funding does not count: an unpaid or pending top-up cannot set aside the first month nor fund the fee", async () => {
      expect((await recurring(SA1, U.owner_a, "monthly", PRICE.monthly)).error?.code).toBe("TW012"); // a monthly spending limit must exist first
      expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: EA, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly limit" })).error).toBeNull();
      expect((await recurring(SA1, U.owner_a, "monthly", PRICE.monthly)).error?.code).toBe("TW007"); // no credit at all
      await fund(EA, SA1, 5_000, false); // checkout opened, never settled
      expect((await recurring(SA1, U.owner_a, "monthly", PRICE.monthly)).error?.code).toBe("TW007");
      await fund(EA, SA1, 5_000, true);
      await fund(EA, SA1, 5_000, true);
      expect((await recurring(SA1, U.owner_a, "monthly", PRICE.monthly)).error).toBeNull();
    });

    it("a hold on the credit account stops the campaign before any provider call", async () => {
      const a = hub.adapterFor(ACC.A);
      expect((await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: hold for the gate test", p_actor: U.padmin })).error).toBeNull();
      const result = await run(SA1, a);
      expect((await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: false, p_reason: "fixture: hold released", p_actor: U.padmin })).error).toBeNull();
      expect(result.outcome).toBe("insufficient_credit");
      expect(a.count("createCampaign")).toBe(0);
    });

    it("with approval, recurring authorization and settled funds the campaign is submitted ONCE; the fee is captured; a submission is not an approval", async () => {
      const a = hub.adapterFor(ACC.A);
      const result = await run(SA1, a);
      expect(result.outcome).toBe("campaign_submitted");
      expect(a.count("createCampaign")).toBe(1);
      const created = (a.calls.find((c) => c.method === "createCampaign")?.input ?? {}) as { useCase: string; brandSid: string; messagingServiceSid: string };
      expect(created).toMatchObject({ useCase: "MIXED", brandSid: BRAND.A1, messagingServiceSid: [...a.services.keys()][0] });
      expect(state(SA1)).toBe("campaign_pending");
      expect(ops(SA1, "campaign")).toBe("1:succeeded:false");
      expect(spendStatus(ref("vetting-a1"))).toBe("reserved");
      expect(reservations(EA, "campaign_vetting")).toBe(`captured:${PRICE.vetting}:credit`);
      expect(reserved(EA)).toBe(PRICE.monthly); // only the first month set aside by the recurring authorization is held: the vetting reservation is closed (captured)
      expect(psql(`select r.status || '|' || coalesce(r.provider_status, '') from public.studio_sms_prov_resources r where r.operation_id = '${opId(SA1, "campaign")}'`)).toBe("pending|IN_PROGRESS");
      expect(psql(`select state from public.studio_sms_onboarding where studio_id = '${SA1}'`)).not.toBe("ready_for_activation");
      // a replay creates nothing more and charges nothing more
      const again = await run(SA1, a);
      expect(again.outcome).toBe("campaign_pending");
      expect(a.count("createCampaign")).toBe(1);
      expect(reservations(EA, "campaign_vetting")).toBe(`captured:${PRICE.vetting}:credit`);
    });

    it("provider evidence decides: pending stays pending, VERIFIED verifies, and a tampered campaign (use case, brand, mock) is a mismatch, never an approval", async () => {
      const a = hub.adapterFor(ACC.A);
      const qe = [...a.campaigns.keys()][0];
      expect((await refresh(SA1, a)).outcome).toBe("campaign_pending");
      a.tamperCampaign(qe, { us_app_to_person_usecase: "LOW_VOLUME" });
      const wrongUse = await refresh(SA1, a);
      expect(wrongUse.outcome).toBe("exception");
      expect(wrongUse.detail).toContain("use_case_mismatch");
      a.tamperCampaign(qe, { us_app_to_person_usecase: "MIXED", brand_registration_sid: BRAND.B1 });
      expect((await refresh(SA1, a)).detail).toContain("brand_mismatch");
      a.tamperCampaign(qe, { brand_registration_sid: BRAND.A1, mock: true, campaign_status: "VERIFIED" });
      expect((await refresh(SA1, a)).detail).toContain("mock_or_unknown");
      a.tamperCampaign(qe, { mock: false, campaign_status: "SOMETHING_NEW" });
      const unknown = await refresh(SA1, a);
      expect(unknown.outcome).toBe("campaign_pending");
      expect(psql(`select status || '|' || coalesce(mismatch_code, '') from public.studio_sms_prov_resources where operation_id = '${opId(SA1, "campaign")}'`)).toBe("pending|status_unrecognized");
      a.setCampaignStatus(qe, "VERIFIED");
      const verified = await refresh(SA1, a);
      expect(verified.outcome).toBe("campaign_verified");
      expect(psql(`select status from public.studio_sms_prov_resources where operation_id = '${opId(SA1, "campaign")}'`)).toBe("verified");
      expect(psql(`select step from public.studio_sms_onboarding where studio_id = '${SA1}'`)).toBe("N1");
      expect(state(SA1)).toBe("campaign_pending"); // verified is not activation: the number, sender readiness and opt-out checks are R2b
    });

    it("a rejected campaign is recorded with its reasons; a resubmission needs a NEW explicit authorization and is refused without one", async () => {
      const a = hub.adapterFor(ACC.A);
      const qe = [...a.campaigns.keys()][0];
      a.setCampaignStatus(qe, "FAILED", "Opt-in flow could not be verified; sample 2 mismatch");
      const rejected = await refresh(SA1, a);
      expect(rejected.outcome).toBe("campaign_rejected");
      expect(state(SA1)).toBe("exception");
      expect(code(SA1)).toBe("campaign_rejected");
      expect(psql(`select failure_reasons from public.studio_sms_prov_resources where operation_id = '${opId(SA1, "campaign")}'`)).toContain("Opt-in flow");
      // reopening only moves the state; it authorizes and charges nothing
      expect((await rpc("tw4_prov_reopen", { p_studio_id: SA1, p_actor: U.owner_a, p_reason: "fixture: corrected the package" })).error?.code).toBe("42501");
      expect((await rpc("tw4_prov_reopen", { p_studio_id: SA1, p_actor: U.padmin, p_reason: "fixture: corrected the package" })).data).toEqual({ state: "service_setup" });
      // Twilio allows one campaign per service: while the rejected one is still there, nothing is reserved and no approval is burned
      const blocked = await run(SA1, a);
      expect(blocked.outcome).toBe("prerequisite_missing");
      expect(blocked.detail).toContain("provider_campaign_exists_remove_first");
      expect(a.count("createCampaign")).toBe(1);
      a.removeCampaign(qe); // the failed campaign is removed at the provider console first
      const refused = await run(SA1, a);
      expect(refused.outcome).toBe("spend_blocked");
      expect(a.count("createCampaign")).toBe(1);
      expect((await authorize(EA, SA1, "campaign_vetting", PRICE.vetting, ref("vetting-a1"))).error?.code).toBe("TW019"); // the spent reference stays spent
      expect((await authorize(EA, SA1, "campaign_vetting", PRICE.vetting, ref("vetting-a1-resubmit"))).error).toBeNull();
      const second = await run(SA1, a);
      expect(second.outcome).toBe("campaign_submitted");
      expect(a.count("createCampaign")).toBe(2);
      expect(ops(SA1, "campaign")).toBe("1:succeeded:true,2:succeeded:false");
      expect(reservations(EA, "campaign_vetting")).toBe(`captured:${PRICE.vetting}:credit,captured:${PRICE.vetting}:credit`);
      expect(state(SA1)).toBe("campaign_pending");
    });
  });

  describe("unknown outcomes of a fee operation", () => {
    it("a lost response on the campaign create: the reservation stays held, the next run adopts the campaign and captures once (Low-Volume Standard path)", async () => {
      const b = hub.adapterFor(ACC.B);
      await fund(EB, SB1, 5_000, true);
      expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: EB, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly limit" })).error).toBeNull();
      expect((await recurring(SB1, U.owner_b, "monthly_low_volume", PRICE.monthlyLvs)).error).toBeNull();
      expect((await authorize(EB, SB1, "campaign_vetting", PRICE.vetting, ref("vetting-b1"))).error).toBeNull();
      b.failNext("createCampaign", { kind: "transient", lostResponse: true });
      const first = await run(SB1, b);
      expect(first.outcome).toBe("retry_later");
      expect(ops(SB1, "campaign")).toBe("1:unknown_outcome:false");
      expect(reservations(EB, "campaign_vetting")).toBe(`reserved:${PRICE.vetting}:credit`);
      const second = await run(SB1, b);
      expect(second.outcome).toBe("campaign_pending"); // adopted: it was submitted by the earlier attempt, nothing was created now
      expect(b.count("createCampaign")).toBe(1);
      expect(ops(SB1, "campaign")).toBe("1:succeeded:false");
      expect(reservations(EB, "campaign_vetting")).toBe(`captured:${PRICE.vetting}:credit`);
      const created = (b.calls.find((c) => c.method === "createCampaign")?.input ?? {}) as { useCase: string };
      expect(created.useCase).toBe("LOW_VOLUME");
    });

    it("a timeout with no campaign found is NEVER repeated: it waits for a platform admin, who resolves it; nothing is charged until then", async () => {
      const d = hub.adapterFor(ACC.D);
      await fund(ED, SD1, 5_000, true);
      expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: ED, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly limit" })).error).toBeNull();
      expect((await recurring(SD1, U.owner_a, "monthly", PRICE.monthly)).error).toBeNull();
      expect((await authorize(ED, SD1, "campaign_vetting", PRICE.vetting, ref("vetting-d1"))).error).toBeNull();
      d.failNext("createCampaign", { kind: "transient" }); // the request did not reach Twilio
      const first = await run(SD1, d);
      expect(first.outcome).toBe("retry_later");
      for (let i = 0; i < 3; i += 1) expect((await run(SD1, d)).outcome).toBe("unknown_outcome");
      expect(d.count("createCampaign")).toBe(1);
      expect(reservations(ED, "campaign_vetting")).toBe(`reserved:${PRICE.vetting}:credit`);
      const id = opId(SD1, "campaign");
      // the generic credit resolver cannot settle a provisioning reservation behind the ledger's back
      const resId = psql(`select cr.id from public.studio_sms_credit_reservations cr where cr.reservation_key = 'prov:${id}:campaign_vetting'`);
      for (const outcome of ["released", "captured"]) {
        expect((await rpc("tw4_credit_resolve_reservation", { p_reservation_id: resId, p_outcome: outcome, p_actor: U.padmin, p_note: "fixture: generic resolver attempt" })).error?.code).toBe("22023");
      }
      expect(reservations(ED, "campaign_vetting")).toBe(`reserved:${PRICE.vetting}:credit`);
      // an unknown FEE outcome is never closed as failed by the runner, and a fee is released only on a definite provider refusal
      const lease = `t-${RUN}`;
      await store.claim(SD1, U.padmin, lease);
      for (const errorCode of ["api", "unclear_outcome"]) {
        expect((await rpc("tw4_prov_finish", { p_onboarding_id: OD1, p_lease_owner: lease, p_operation_id: id, p_status: "failed", p_provider_sid: null, p_error_code: errorCode, p_error_detail: null })).error?.code, errorCode).toBe("TW034");
      }
      // not created within 20 minutes of the attempt: even an admin cannot declare it so
      await store.release(OD1, lease);
      expect((await rpc("tw4_prov_resolve", { p_operation_id: id, p_actor: U.padmin, p_resolution: "not_created", p_provider_sid: null, p_note: "fixture: too early to say" })).error?.code).toBe("22023");
      aged(`update public.studio_sms_prov_operations set started_at = started_at - interval '90 minutes' where id = '${id}'`);
      expect((await rpc("tw4_prov_resolve", { p_operation_id: id, p_actor: U.owner_a, p_resolution: "not_created", p_provider_sid: null, p_note: "fixture: checked the console" })).error?.code).toBe("42501");
      expect((await rpc("tw4_prov_resolve", { p_operation_id: id, p_actor: U.padmin, p_resolution: "not_created", p_provider_sid: null, p_note: "short" })).error?.code).toBe("22023");
      // an administrator's word is no longer enough to release a fee: provider-backed evidence of non-creation is required (the full evidence matrix is in localStack.feeres.test.ts)
      expect((await rpc("tw4_prov_resolve", { p_operation_id: id, p_actor: U.padmin, p_resolution: "not_created", p_provider_sid: null, p_note: "fixture: checked the console, no campaign exists" })).error?.code).toBe("TW046");
      expect(reservations(ED, "campaign_vetting")).toBe(`reserved:${PRICE.vetting}:credit`);
      const evidence = new ProvisionEvidenceStore(admin);
      expect((await checkCampaignAbsence({ store, evidence, adapter: d, studioId: SD1, actorId: U.padmin })).outcome).toBe("recorded");
      aged(`update public.studio_sms_prov_listings set observed_at = observed_at - interval '15 minutes', read_started_at = read_started_at - interval '15 minutes' where studio_id = '${SD1}'`);
      expect((await checkCampaignAbsence({ store, evidence, adapter: d, studioId: SD1, actorId: U.padmin })).outcome).toBe("recorded");
      expect((await rpc("tw4_prov_resolve", { p_operation_id: id, p_actor: U.padmin, p_resolution: "not_created", p_provider_sid: null, p_note: "fixture: checked the console, no campaign exists" })).error).toBeNull();
      expect(ops(SD1, "campaign")).toBe("1:abandoned:false");
      expect(reservations(ED, "campaign_vetting")).toBe(`released:${PRICE.vetting}:credit`);
      // the released approval cannot be reused: a new attempt needs a fresh explicit authorization
      expect((await run(SD1, d)).outcome).toBe("spend_blocked");
      expect(d.count("createCampaign")).toBe(1);
      expect((await authorize(ED, SD1, "campaign_vetting", PRICE.vetting, ref("vetting-d1"))).error?.code).toBe("TW019");
      expect((await authorize(ED, SD1, "campaign_vetting", PRICE.vetting, ref("vetting-d1-again"))).error).toBeNull();
      expect((await run(SD1, d)).outcome).toBe("campaign_submitted");
      expect(ops(SD1, "campaign")).toBe("1:abandoned:true,2:succeeded:false");
    });

  });

  describe("tier eligibility", () => {
    it("a location chosen as Low-Volume Standard WITHOUT the verified eligibility record has no campaign path: nothing is reserved or called", async () => {
      // business A's second location: its own service is refused by the entity rule, so test the path read directly
      aged(`update public.studio_sms_onboarding set tier = 'low_volume_standard' where studio_id = '${SA2}'`);
      const req = JSON.parse(psql(`select public._tw4prov_campaign_requirements('${SA2}')::text`)) as { blocker: string; use_case: string | null; path: string };
      aged(`update public.studio_sms_onboarding set tier = null where studio_id = '${SA2}'`);
      expect(req).toMatchObject({ blocker: "tier_ineligible", use_case: null, path: "low_volume_unverified" });
    });
  });

  describe("ConfiDance pilot business", () => {
    it("each fee component needs its own written approval, inside the cumulative ceiling; the ceiling is not credit; no standing authorization", async () => {
      // the suite must FAIL (not skip) when it cannot pin the pilot rule: the database holds one pilot slot
      expect(pilotUsable, "another pilot exception exists on this database: remove it or run on a clean local stack").toBe(true);
      const c = hub.adapterFor(ACC.C);
      const base = ref("pilot-founder");
      // a standing authorization that exists BEFORE the pilot exception would charge the same month from credit: the pilot business is refused
      aged(`insert into public.studio_sms_recurring_authorizations (legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, expires_at, authorized_by, statement)
             values ('${EC}', '${SC1}', 'monthly', ${PRICE.monthly}, 3, ${PRICE.monthly * 3}, now() + interval '90 days', '${U.owner_a}', 'fixture: a standing authorization made before the pilot exception existed')`);
      expect((await rpc("tw4_pilot_exception_create", { p_entity_id: EC, p_ceiling_cents: 15_000, p_approval_ref: base, p_actor: U.padmin, ...exceptionEvidenceRpc(EC, 15_000) })).error).toBeNull();
      expect((await authorize(EC, SC1, "campaign_vetting", PRICE.vetting, ref("pilot-vetting-0"), "pilot")).error).toBeNull();
      expect((await authorize(EC, SC1, "monthly", PRICE.monthly, ref("pilot-monthly-0"), "pilot")).error).toBeNull();
      const conflict = await run(SC1, c);
      expect(conflict.outcome).toBe("pilot_conflict");
      expect(c.count("createCampaign")).toBe(0);
      expect(reservations(EC, "campaign_vetting")).toBeFalsy();
      aged(`delete from public.studio_sms_recurring_authorizations where legal_entity_id = '${EC}'`);
      for (const r of ["pilot-vetting-0", "pilot-monthly-0"]) {
        const id = psql(`select id from public.studio_sms_spend_events where approval_ref = $q$${ref(r)}$q$`);
        expect((await rpc("tw4_spend_withdraw", { p_spend_event_id: id, p_actor: U.padmin, p_note: "fixture: clear the approvals before the main scenario" })).error).toBeNull();
      }
      aged(`update public.studio_sms_pilot_exceptions set ceiling_cents = 3000 where legal_entity_id = '${EC}'`);
      // only the vetting fee approved: the monthly fee needs its own approval
      expect((await authorize(EC, SC1, "campaign_vetting", PRICE.vetting, ref("pilot-vetting"), "pilot")).error).toBeNull();
      expect((await run(SC1, c)).outcome).toBe("spend_blocked");
      // one reference never covers two fees
      expect((await authorize(EC, SC1, "monthly", PRICE.monthly, ref("pilot-vetting"), "pilot")).error?.code).toBe("TW019");
      expect((await authorize(EC, SC1, "monthly", PRICE.monthly, ref("pilot-monthly"), "pilot")).error).toBeNull();
      // 1900 + 1250 = 3150 exceeds a 3000 cumulative ceiling: refused, nothing reserved
      expect((await run(SC1, c)).outcome).toBe("insufficient_credit");
      expect(c.count("createCampaign")).toBe(0);
      expect(reservations(EC, "campaign_vetting")).toBeFalsy();
      // the ceiling is raised; the monthly approval is funded as CREDIT by mistake (no credit exists): the second reservation fails inside the same
      // transaction as the first, so the vetting approval is NOT consumed (all or none)
      const pilotMonthlyId = psql(`select id from public.studio_sms_spend_events where approval_ref = $q$${ref("pilot-monthly")}$q$`);
      expect((await rpc("tw4_spend_withdraw", { p_spend_event_id: pilotMonthlyId, p_actor: U.padmin, p_note: "fixture: replace by a credit-funded approval" })).error).toBeNull();
      aged(`update public.studio_sms_pilot_exceptions set ceiling_cents = 4000 where legal_entity_id = '${EC}'`);
      expect((await authorize(EC, SC1, "monthly", PRICE.monthly, ref("pilot-monthly-credit"), "credit")).error).toBeNull();
      expect((await run(SC1, c)).outcome).toBe("insufficient_credit");
      expect(spendStatus(ref("pilot-vetting"))).toBe("authorized");
      expect(reservations(EC, "campaign_vetting")).toBeFalsy();
      expect(c.count("createCampaign")).toBe(0);
      const creditMonthlyId = psql(`select id from public.studio_sms_spend_events where approval_ref = $q$${ref("pilot-monthly-credit")}$q$`);
      expect((await rpc("tw4_spend_withdraw", { p_spend_event_id: creditMonthlyId, p_actor: U.padmin, p_note: "fixture: replace by a pilot-funded approval" })).error).toBeNull();
      expect((await authorize(EC, SC1, "monthly", PRICE.monthly, ref("pilot-monthly-2"), "pilot")).error).toBeNull();
      expect((await recurring(SC1, U.owner_a, "monthly", PRICE.monthly)).error?.code).toBe("TW011"); // no standing authorization for the pilot business
      expect(psql(`select count(*) from public.studio_sms_recurring_authorizations where legal_entity_id = '${EC}'`)).toBe("0");
      const result = await run(SC1, c);
      expect(result.outcome).toBe("campaign_submitted");
      expect(reservations(EC, "campaign_vetting")).toBe(`captured:${PRICE.vetting}:pilot`);
      // only the non-refundable vetting fee is spent by a submission; the first month waits for the provider's approval
      expect(reservations(EC, "monthly")).toBe(`reserved:${PRICE.monthly}:pilot`);
      const pilotOp = opId(SC1, "campaign");
      expect((await rpc("tw4_prov_settle_admin", { p_operation_id: pilotOp, p_actor: U.owner_a, p_kind: "monthly", p_outcome: "released", p_note: "fixture: not an admin" })).error?.code).toBe("42501");
      expect((await rpc("tw4_prov_settle_admin", { p_operation_id: pilotOp, p_actor: U.padmin, p_kind: "monthly", p_outcome: "released", p_note: "short" })).error?.code).toBe("22023");
      expect((await rpc("tw4_prov_settle_admin", { p_operation_id: pilotOp, p_actor: U.padmin, p_kind: "campaign_vetting", p_outcome: "released", p_note: "fixture: the vetting fee is already captured" })).error?.code).toBe("22023");
      // the pilot business's cumulative ceiling is never replenished by an administrator: only a definitive provider refusal releases for it
      expect((await rpc("tw4_prov_settle_admin", { p_operation_id: pilotOp, p_actor: U.padmin, p_kind: "monthly", p_outcome: "released", p_note: "fixture: mismatch stays, release the held first month" })).error?.code).toBe("TW048");
      expect(reservations(EC, "monthly")).toBe(`reserved:${PRICE.monthly}:pilot`);
      const qe = [...c.campaigns.keys()][0];
      c.setCampaignStatus(qe, "VERIFIED");
      expect((await refresh(SC1, c)).outcome).toBe("campaign_verified");
      expect(reservations(EC, "monthly")).toBe(`captured:${PRICE.monthly}:pilot`);
      expect(psql(`select coalesce(balance_cents, 0) from public.studio_sms_credit_accounts where legal_entity_id = '${EC}'`) || "0").toBe("0"); // no credit was ever involved
      expect(c.count("createCampaign")).toBe(1);
    });
  });

  it("the brand must be the one registered ON THIS business's subaccount (a parent-era or foreign brand is not a prerequisite)", () => {
    expect(psql(`select public._tw4prov_brand('${SA1}')`)).toBe(BRAND.A1);
    aged(`update public.studio_sms_provisioning_steps set twilio_account_sid = null where studio_id = '${SA1}' and step_key = 'B1'`);
    expect(psql(`select coalesce(public._tw4prov_brand('${SA1}'), 'none')`)).toBe("none");
    aged(`update public.studio_sms_provisioning_steps set twilio_account_sid = '${ACC.B}' where studio_id = '${SA1}' and step_key = 'B1'`);
    expect(psql(`select coalesce(public._tw4prov_brand('${SA1}'), 'none')`)).toBe("none");
    aged(`update public.studio_sms_provisioning_steps set twilio_account_sid = '${ACC.A}' where studio_id = '${SA1}' and step_key = 'B1'`);
    expect(psql(`select public._tw4prov_brand('${SA1}')`)).toBe(BRAND.A1);
  });

  it("the runner window is a database guarantee at the paid step too: closing it mid-run stops a begin, whatever mode the lease was claimed in", async () => {
    const lease = `w-${RUN}`;
    await store.claim(SB1, U.padmin, lease, 120, "refresh"); // a refresh lease does not check the window
    expect((await rpc("tw4_runner_set_window", { p_studio_id: SB1, p_actor: U.padmin, p_hours: 0, p_reason: "fixture: close the window" })).error).toBeNull();
    const begin = await rpc("tw4_prov_begin", {
      p_onboarding_id: OB1, p_lease_owner: lease, p_op_kind: "messaging_service", p_friendly_name: "df:test:window", p_request_digest: "0".repeat(64), p_params: {}, p_actor: U.padmin,
    });
    await store.release(OB1, lease);
    await window(SB1);
    expect(begin.error?.code).toBe("TW001");
  });

  it("the admin status read is platform-admin only and reports the ledger", async () => {
    expect((await rpc("tw4_prov_status", { p_studio_id: SA1, p_actor: U.owner_a })).error?.code).toBe("42501");
    const { data, error } = await rpc("tw4_prov_status", { p_studio_id: SA1, p_actor: U.padmin });
    expect(error).toBeNull();
    const status = data as { operations: { kind: string; attempt: number; resource: { status: string } | null }[]; state: string };
    expect(status.operations.map((o) => `${o.kind}:${o.attempt}`)).toEqual(["campaign:1", "campaign:2", "messaging_service:1"]);
    expect(status.operations.at(-1)?.resource?.status).toBe("ready");
  });

  it("the ledger is append-only evidence: identity and provider sids cannot change and nothing is deleted or truncated", () => {
    const id = opId(SA1, "messaging_service");
    expect(psqlError(`update public.studio_sms_prov_operations set twilio_account_sid = '${ACC.B}' where id = '${id}';`)).toMatch(/identity of an operation is fixed/);
    expect(psqlError(`update public.studio_sms_prov_operations set provider_sid = 'MG${"0".repeat(32)}' where id = '${id}';`)).toMatch(/never changes/);
    expect(psqlError(`delete from public.studio_sms_prov_operations where id = '${id}';`)).toMatch(/never deleted/);
    expect(psqlError(`truncate public.studio_sms_prov_operations;`)).not.toBe("");
    expect(psqlError(`update public.studio_sms_prov_resources set provider_sid = 'MG${"0".repeat(32)}' where operation_id = '${id}';`)).toMatch(/identity of a resource is fixed/);
    expect(psqlError(`update public.studio_sms_prov_operations set status = 'failed' where id = '${id}';`)).toMatch(/closed operation is final/);
  });

  // ---- rollback scenarios -------------------------------------------------------------------------------------------------------------------------
  // The layers built on R2a are DISCOVERED, never listed: every rollback script in the rollback directory with a version above R2a's is a candidate, and it is
  // APPLIED on this stack when the object its own "not applied" guard checks (else the first function it drops) exists. They come off newest-first, each by its
  // OWN rollback script, inside one transaction that is rolled back, before R2a's. No CASCADE, no truncate, and the rollback scripts run with triggers enabled
  // (session_replication_role is touched only to clear this suite's fixture rows first, never while a rollback script runs).
  const R2A = "20261207090000_twilio_r2a_messaging_service_campaign";
  const rollbackDir = join(process.cwd(), "src/lib/supabase/migrations/rollback");
  const rbSql = (file: string) => readFileSync(join(rollbackDir, file), "utf8").replace(/^begin;/m, "").replace(/^commit;/m, "");
  function appliedLaterLayers(): { file: string; probe: string; applied: boolean }[] {
    return readdirSync(rollbackDir)
      .filter((f) => /^\d{14}_.*_rollback\.sql$/.test(f) && f.slice(0, 14) > R2A.slice(0, 14))
      .sort()
      .reverse()
      .map((file) => {
        const text = readFileSync(join(rollbackDir, file), "utf8");
        const guard = text.match(/to_regclass\('public\.([a-z0-9_]+)'\) is null/i);
        const fn = text.match(/drop function if exists public\.([a-z0-9_]+)\(([^)]*)\)/i);
        // a layer that only REPLACES functions (no table, nothing it creates to drop) states its precondition as "to_regprocedure('public.f(args)') is null -> not applied"
        const pre = text.match(/if to_regprocedure\('public\.([a-z0-9_]+\([^)]*\))'\) is null then/i);
        // a layer that only adds a column states it as "not exists (select 1 from pg_attribute ... attrelid = 'public.T'::regclass and attname = 'c' ...) -> not applied"
        const col = text.match(/if not exists \(select 1 from pg_attribute a where a\.attrelid = 'public\.([a-z0-9_]+)'::regclass and a\.attname = '([a-z0-9_]+)'/i);
        // a layer that replaces a body and fingerprints it: "to_regprocedure('public.f(args)') is null or left(md5(...body...), 8) <> '<hash>' -> not applied or changed"
        const fp = text.match(/to_regprocedure\('public\.([a-z0-9_]+\([^)]*\))'\) is null or left\(md5\(replace\(\(select p\.prosrc from pg_proc p where p\.oid = '[^']+'::regprocedure\), chr\(13\), ''\)\), 8\) <> '([0-9a-f]{8})'/i);
        // 20270202090000 (studio_subscriptions read watermark, #360) is an unrelated Stripe-billing layer: its rollback has NO precondition guard by design, because it is a single
        // idempotent "alter table ... drop column if exists" (it drops only a standalone ordering column, so nothing can be lost that a guard would protect and a second run is a no-op).
        // It is applied exactly when the column exists; it is classified by that, never skipped.
        const dropcol = text.match(/alter table public.([a-z0-9_]+) drop column if exists ([a-z0-9_]+)/i);
        const probe = guard ? `to_regclass('public.${guard[1]}') is not null`
          : fn ? `to_regprocedure('public.${fn[1]}(${fn[2]})') is not null`
          : pre ? `to_regprocedure('public.${pre[1]}') is not null`
          : dropcol ? `exists (select 1 from pg_attribute a where a.attrelid = 'public.${dropcol[1]}'::regclass and a.attname = '${dropcol[2]}' and not a.attisdropped)`
          : col ? `exists (select 1 from pg_attribute a where a.attrelid = 'public.${col[1]}'::regclass and a.attname = '${col[2]}' and not a.attisdropped)`
          : fp ? `coalesce((select left(md5(replace(p.prosrc, chr(13), '')), 8) = '${fp[2]}' from pg_proc p where p.oid = to_regprocedure('public.${fp[1]}')), false)`
          // 20261231090000 (platform-admin AAL2) only REPLACES _sms_onb_is_platform_admin() and re-creates policies; its rollback has no "not applied" guard and drops nothing.
          // It is applied exactly when the live function requires the aal2 claim (the rollback restores the role-only body).
          : /create or replace function public\._sms_onb_is_platform_admin\(\)/i.test(text) ? `coalesce((select position('aal2' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public._sms_onb_is_platform_admin()')), false)`
          : "";
        return { file, probe, applied: probe !== "" && psql(`select ${probe}`) === "t" };
      });
  }
  // This suite's own fixture studios and legal businesses: every deletion below is scoped to them (never the whole table), inside the rolled-back transaction.
  const FIXTURE_STUDIOS = [SA1, SA2, SB1, SC1, SD1];
  const FIXTURE_ENTITIES = [EA, EB, EC, ED];
  const sqlList = (ids: string[]) => ids.map((id) => `'${id}'`).join(", ");
  /**
   * The fixtures' lifecycle rows (provider resources a layer such as 20261221 registers for verified campaigns, and everything that references them or their alerts,
   * found from the catalogue by foreign key, one level below each lifecycle parent). The 20261209 rollback refuses while ANY such row exists; that refusal stays covered
   * by its own test below, so the rows are removed here only for the fixtures and only to show that the stack comes off cleanly when they are gone. No CASCADE, no truncate.
   */
  // 20261230: the fixtures' pilot approvals carry append-only evidence, which makes the 20261230 rollback refuse by design; inside this rolled-back transaction the fixture rows are removed
  // (its guard is `enable always`, so it is disabled for the delete and restored; the whole block is rolled back)
  const clearSpendEvidence = () => psql("select to_regclass('public.studio_sms_pilot_spend_evidence') is not null") !== "t" ? "" : `
      alter table public.studio_sms_pilot_spend_evidence disable trigger studio_sms_pilot_spend_evidence_guard;
      delete from public.studio_sms_pilot_spend_evidence where legal_entity_id in (${sqlList(FIXTURE_ENTITIES)});
      alter table public.studio_sms_pilot_spend_evidence enable always trigger studio_sms_pilot_spend_evidence_guard;`;
  const clearFixtureLifecycle = () => psql("select to_regclass('public.studio_sms_provider_resources') is not null") !== "t" ? "" : `
      do $clear$
      declare
        c record;
        p text;
        v_ents uuid[] := array[${sqlList(FIXTURE_ENTITIES)}]::uuid[];
        v_parents text[] := array['studio_sms_provider_alerts', 'studio_sms_provider_exposure', 'studio_sms_provider_cover', 'studio_sms_provider_cancel_ops'];
      begin
        foreach p in array v_parents loop
          if to_regclass('public.' || p) is null then continue; end if;
          for c in select k.conrelid::regclass::text as child, a.attname as col from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
                    where k.contype = 'f' and k.confrelid = ('public.' || p)::regclass and k.conrelid <> all (select ('public.' || x)::regclass from unnest(v_parents) x where to_regclass('public.' || x) is not null) loop
            execute format('delete from %s where %I in (select id from public.%I where legal_entity_id = any($1))', c.child, c.col, p) using v_ents;
          end loop;
        end loop;
        for c in select k.conrelid::regclass::text as child, a.attname as col from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
                  where k.contype = 'f' and k.confrelid = 'public.studio_sms_provider_resources'::regclass and k.conrelid <> all (select ('public.' || x)::regclass from unnest(v_parents) x where to_regclass('public.' || x) is not null) loop
          execute format('delete from %s where %I in (select id from public.studio_sms_provider_resources where legal_entity_id = any($1))', c.child, c.col) using v_ents;
        end loop;
        foreach p in array v_parents loop
          if to_regclass('public.' || p) is not null then execute format('delete from public.%I where legal_entity_id = any($1)', p) using v_ents; end if;
        end loop;
        delete from public.studio_sms_provider_resources where legal_entity_id = any(v_ents);
        delete from public.studio_sms_onboarding_audit where action like 'rfl\\_%' and studio_id = any(array[${sqlList(FIXTURE_STUDIOS)}]::uuid[]);
      end $clear$;`;
  const clearFixtureEvidence = () => `set local session_replication_role = replica;
      ${psql("select to_regclass('public.studio_sms_prov_listings') is not null") === "t"
        ? `delete from public.studio_sms_prov_orphans where legal_entity_id in (${sqlList(FIXTURE_ENTITIES)}); delete from public.studio_sms_prov_dispositions where legal_entity_id in (${sqlList(FIXTURE_ENTITIES)}); delete from public.studio_sms_prov_listings where legal_entity_id in (${sqlList(FIXTURE_ENTITIES)});`
        : ""}
      delete from public.studio_sms_prov_resources where operation_id in (select id from public.studio_sms_prov_operations where studio_id in (${sqlList(FIXTURE_STUDIOS)}));
      delete from public.studio_sms_prov_operations where studio_id in (${sqlList(FIXTURE_STUDIOS)});
      delete from public.studio_sms_onboarding_audit where action like 'prov\\_%' and studio_id in (${sqlList(FIXTURE_STUDIOS)});
      ${clearFixtureLifecycle()}
      ${clearSpendEvidence()}
      set local session_replication_role = origin;`;
  const r2aIntact = () => psql(`select to_regclass('public.studio_sms_prov_operations') is not null and to_regprocedure('public.tw4_prov_settle_admin(uuid,uuid,text,text,text)') is not null`);

  it("rollback discovery: every later rollback script is classified, none silently omitted", (ctx) => {
    const layers = appliedLaterLayers();
    for (const l of layers) expect(l.probe, `${l.file} has no guard or drop to detect whether it is applied: teach appliedLaterLayers`).not.toBe("");
    console.info(`[r2a-rollback] layers above R2a: ${layers.map((l) => `${l.file.slice(0, 14)}=${l.applied ? "applied" : "absent"}`).join(", ") || "none exist"}`);
    if (!layers.some((l) => l.applied)) ctx.skip("R2a-only stack: nothing to classify as layered (the R2a-only rollback test covers this stack)");
  });

  it("R2a-only rollback parses and completes where there is no evidence (executed in a transaction that is rolled back)", (ctx) => {
    const layers = appliedLaterLayers().filter((l) => l.applied);
    if (layers.length > 0) ctx.skip(`not an R2a-only stack: ${layers.map((l) => l.file.slice(0, 14)).join(", ")} applied on top of R2a (the layered rollback test covers this stack)`);
    const out = psqlError(`begin; ${clearFixtureEvidence()}
      ${rbSql(`${R2A}_rollback.sql`)}
      rollback;`);
    expect(out).toBe("");
    expect(r2aIntact()).toBe("t");
  });

  it("layered rollback (newest layer first, each by its own script, then R2a) completes where there is no evidence (executed in a transaction that is rolled back)", (ctx) => {
    const layers = appliedLaterLayers().filter((l) => l.applied);
    if (layers.length === 0) ctx.skip("no layer above R2a is applied on this stack (the R2a-only rollback test covers this stack)");
    const out = psqlError(`begin; ${clearFixtureEvidence()}
      ${layers.map((l) => `-- ${l.file}\n${rbSql(l.file)}`).join("\n")}
      -- ${R2A}\n${rbSql(`${R2A}_rollback.sql`)}
      rollback;`);
    expect(out, `layers rolled back newest-first: ${layers.map((l) => l.file.slice(0, 14)).join(" > ")} > ${R2A.slice(0, 14)}`).toBe("");
    expect(r2aIntact()).toBe("t");
  });

  it("layered rollback refuses while a layer's own evidence exists: each applied layer's guard is exercised in a rolled-back transaction", (ctx) => {
    // a later layer's rollback must stay refusable: R2a's own evidence blocks R2a's rollback (shown below); a layer that cannot be shown refusing here is reported, not assumed
    const layers = appliedLaterLayers().filter((l) => l.applied);
    if (layers.length === 0) ctx.skip("no layer above R2a is applied on this stack");
    const out = psqlError(`begin; ${layers.map((l) => rbSql(l.file)).join("\n")} ${rbSql(`${R2A}_rollback.sql`)} rollback;`);
    // with this suite's fixtures still present the stack as a whole must refuse (R2a evidence), never destroy it
    expect(out).toMatch(/refused|evidence exists/);
    expect(r2aIntact()).toBe("t");
  });

  it("the 20261209 lifecycle rollback still refuses while a lifecycle row remains: one fixture alert row is enough (executed in a transaction that is rolled back)", (ctx) => {
    const lifecycle = appliedLaterLayers().find((l) => l.file.startsWith("20261209090000") && l.applied);
    if (!lifecycle) ctx.skip("the recurring-fee lifecycle layer (20261209) is not applied on this stack");
    const out = psqlError(`begin; set local session_replication_role = replica;
      insert into public.studio_sms_provider_alerts (legal_entity_id, kind, dedupe_key, audience, severity, summary)
        values ('${EA}', 'inventory_gap', 'fixture:rollback-refusal', 'admin', 'warning', 'fixture rollback refusal row');
      set local session_replication_role = origin;
      ${rbSql(lifecycle!.file)}
      rollback;`);
    expect(out).toMatch(/lifecycle evidence exists/);
    expect(psql(`select to_regclass('public.studio_sms_provider_alerts') is not null`)).toBe("t");
  });

  it("rollback refuses once provisioning evidence exists (executed in a transaction that is rolled back)", () => {
    const sql = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261207090000_twilio_r2a_messaging_service_campaign_rollback.sql"), "utf8").replace(/^commit;/m, "rollback;");
    const out = psqlError(sql);
    expect(out).toMatch(/provisioning evidence exists/);
    expect(psql(`select to_regclass('public.studio_sms_prov_operations') is not null`)).toBe("t");
  });
});
