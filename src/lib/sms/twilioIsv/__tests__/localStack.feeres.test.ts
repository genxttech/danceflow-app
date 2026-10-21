/**
 * TW-4F evidence-backed provisioning fee resolution (20261212090000) against a REAL schema, on top of R2a (20261207090000): the provisioning ledger, the fee gate, provider-evidence verdicts, unknown-outcome handling and
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
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

import { SupabaseCreditStore } from "../creditStore";
import { FakeProvisioningAdapter, FakeProvisioningHub } from "../fakeProvisioning";
import { SupabaseProvisionStore } from "../provisionStore";
import { runProvisioning, type ProvisionInput } from "../provisionRunner";
import { ProvisionEvidenceStore, checkCampaignAbsence, listingDigest, type ListingFacts } from "../provisionEvidence";


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

const SA1 = "f2e00000-0000-4000-8000-00000000000a"; // business A (credit funded, Standard), location 1
const SA2 = "f2e00000-0000-4000-8000-00000000000b"; // business A, location 2
const SB1 = "f2e00000-0000-4000-8000-00000000000c"; // business B (credit funded, verified Low-Volume Standard)
const SC1 = "f2e00000-0000-4000-8000-00000000000d"; // business C (the ConfiDance pilot business)
const SD1 = "f2e00000-0000-4000-8000-00000000000e"; // business D (credit funded, Standard)
const EA = "f2e10000-0000-4000-8000-0000000000a1";
const EB = "f2e10000-0000-4000-8000-0000000000b1";
const EC = "f2e10000-0000-4000-8000-0000000000c1";
const ED = "f2e10000-0000-4000-8000-0000000000d1";
const OA1 = "f2e20000-0000-4000-8000-0000000000a1";
const OA2 = "f2e20000-0000-4000-8000-0000000000a2";
const OB1 = "f2e20000-0000-4000-8000-0000000000b1";
const OC1 = "f2e20000-0000-4000-8000-0000000000c1";
const OD1 = "f2e20000-0000-4000-8000-0000000000d1";
const U = { owner_a: "f2e00000-0000-4000-8000-000000000101", owner_b: "f2e00000-0000-4000-8000-000000000201", padmin: "f2e00000-0000-4000-8000-000000000401" };
const ACC = { A: `AC${"f2".repeat(16)}`, B: `AC${"f3".repeat(16)}`, C: `AC${"f4".repeat(16)}`, D: `AC${"f5".repeat(16)}` };
const BRAND = { A1: `BN${"f6".repeat(16)}`, A2: `BN${"f7".repeat(16)}`, B1: `BN${"f8".repeat(16)}`, C1: `BN${"f9".repeat(16)}`, D1: `BN${"fa".repeat(16)}` };
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
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp: 1983812996 }) : "");
const userKey = (id: string) => sign({ iss: "supabase-demo", sub: id, role: "authenticated", aud: "authenticated", exp: 1983812996 });
/** Only the isolated QA stack (docs/twilio/TW-4F_Isolated_QA.md) survives a permission-denied call by an API role; the shared stack can crash. */
const isolated = process.env.TW4_ISO_QA === "1";
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
delete from public.studio_sms_prov_orphans where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_dispositions where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_listings where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_orphans where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_dispositions where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_listings where studio_id in (${STUDIOS});
delete from public.studio_sms_provider_alerts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_provider_cover where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_provider_exposure where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_provider_resources where legal_entity_id in (${ENTITIES});
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
delete from auth.users where email like '%@tw4fee-e2e.test';
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
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4fee-e2e.test', now(), now(), now()
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
  const hub = new FakeProvisioningHub();
  let n = 0;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const ref = (label: string) => `Owner email ${RUN} ${label} approving one fee`;
  const authorize = (entity: string, studio: string, kind: string, cents: number, approvalRef: string, funding: "credit" | "pilot" = "credit") =>
    rpc("tw4_spend_authorize", { p_entity_id: entity, p_kind: kind, p_amount_cents: cents, p_approval_ref: approvalRef, p_actor: U.padmin, p_funding: funding, p_studio_id: studio });
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
  const ops = (studio: string, kind: string) => psql(`select string_agg(attempt || ':' || status || ':' || (superseded_at is not null), ',' order by attempt) from public.studio_sms_prov_operations where studio_id = '${studio}' and op_kind = '${kind}'`);
  const opId = (studio: string, kind: string, attempt = 1) => psql(`select id from public.studio_sms_prov_operations where studio_id = '${studio}' and op_kind = '${kind}' and attempt = ${attempt}`);
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
      expect((await rpc("tw4_price_set", { p_kind: kind, p_customer_cents: customer, p_provider_cents: provider, p_description: `fixture ${kind}`, p_actor: U.padmin })).error).toBeNull();
    }
    for (const s of [SA1, SA2, SB1, SC1, SD1]) await window(s);
  });

  afterAll(() => {
    if (!enabled) return;
    try {
      psqlFile(CLEANUP);
      aged(`update public.studio_sms_price_list set active = true where id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
  });


  // ---------------------------------------------------------------------------------------------------------------------------------------------
  // helpers of this suite
  // ---------------------------------------------------------------------------------------------------------------------------------------------
  const evidence = () => new ProvisionEvidenceStore(admin);
  const msSid = (studio: string) => psql(`select provider_sid from public.studio_sms_prov_operations where studio_id = '${studio}' and op_kind = 'messaging_service' and status = 'succeeded' and superseded_at is null`);
  const listingRows = (studio: string) => psql(`select coalesce(string_agg(verdict, ',' order by observed_at, id), '') from public.studio_sms_prov_listings where studio_id = '${studio}'`);
  /** Shifts every recorded listing of a studio into the past (the database clock decides every rule; tests move the evidence, never the rules). */
  const ageListings = (studio: string, minutes: number) =>
    aged(`update public.studio_sms_prov_listings set observed_at = observed_at - interval '${minutes} minutes', read_started_at = read_started_at - interval '${minutes} minutes' where studio_id = '${studio}'`);
  const ageOperation = (id: string, minutes: number) => aged(`update public.studio_sms_prov_operations set started_at = started_at - interval '${minutes} minutes' where id = '${id}'`);
  const check = (studio: string, adapter: FakeProvisioningAdapter) => checkCampaignAbsence({ store, evidence: evidence(), adapter, studioId: studio, actorId: U.padmin });
  const resolveNotCreated = (id: string, note = "fixture: checked the Twilio console, no campaign exists") =>
    rpc("tw4_prov_resolve", { p_operation_id: id, p_actor: U.padmin, p_resolution: "not_created", p_provider_sid: null, p_note: note });
  const dispositions = (id: string) => psql(`select coalesce(string_agg(disposition || ':' || coalesce(fee_kind, '-') || ':' || cardinality(listing_ids), ',' order by disposition, fee_kind), '') from public.studio_sms_prov_dispositions where operation_id = '${id}' and disposition not like 'reservation_%'`);
  const auditCount = (studio: string, action: string) => Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${studio}' and action = '${action}'`));
  const withLease = async <T,>(studio: string, fn: (onboardingId: string, lease: string) => Promise<T>): Promise<T> => {
    const lease = `f-${RUN}-${(n += 1)}`;
    const claim = await store.claim(studio, U.padmin, lease, 120, "refresh");
    try {
      return await fn(claim.onboarding_id, lease);
    } finally {
      await store.release(claim.onboarding_id, lease);
    }
  };
  const record = (studio: string, opId_: string, facts: Partial<ListingFacts> = {}, digest?: string) =>
    withLease(studio, async (onboardingId, lease) => {
      const full: ListingFacts = {
        account_sid: psql(`select twilio_account_sid from public.studio_sms_prov_operations where id = '${opId_}'`), scope_sid: msSid(studio),
        read_id: randomUUID(), read_started_at: new Date().toISOString(), complete: true, listed: [], ...facts,
      };
      return rpc("tw4_prov_listing_record", { p_onboarding_id: onboardingId, p_lease_owner: lease, p_operation_id: opId_, p_facts: full, p_source: "fake", p_digest: digest ?? listingDigest(full) });
    });
  /** A credit-funded business with an UNKNOWN fee-bearing campaign outcome (the request never reached Twilio; the provider lookup is empty). */
  async function unknownFeeOp(entity: string, studio: string, owner: string, adapter: FakeProvisioningAdapter, tag: string, kind: "monthly" | "monthly_low_volume" = "monthly") {
    await fund(entity, studio, 5_000, true);
    expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: entity, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly limit" })).error).toBeNull();
    expect((await recurring(studio, owner, kind, kind === "monthly" ? PRICE.monthly : PRICE.monthlyLvs)).error).toBeNull();
    expect((await authorize(entity, studio, "campaign_vetting", PRICE.vetting, ref(`vetting-${tag}`))).error).toBeNull();
    adapter.failNext("createCampaign", { kind: "transient" });
    expect((await run(studio, adapter)).outcome).toBe("retry_later");
    expect((await run(studio, adapter)).outcome).toBe("unknown_outcome");
    return opId(studio, "campaign");
  }
  /** Two independent clean listings, the first 15 minutes before the second, both well after the attempt. */
  async function proveAbsence(studio: string, adapter: FakeProvisioningAdapter, id: string) {
    ageOperation(id, 90);
    expect((await check(studio, adapter)).outcome).toBe("recorded");
    ageListings(studio, 15);
    expect((await check(studio, adapter)).outcome).toBe("recorded");
  }

  it("privileges: the evidence tables are unreachable by API roles; the new actions are service-role only; helpers are callable by no API role", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of ["studio_sms_prov_listings", "studio_sms_prov_orphans", "studio_sms_prov_dispositions"]) {
        expect(psql(`select has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete')`), `${role} ${table}`).toBe("f");
      }
    }
    for (const fn of ["tw4_prov_listing_record(uuid, text, uuid, jsonb, text, text)", "tw4_prov_orphan_register(uuid, uuid)", "tw4_prov_orphan_close(uuid, uuid, text)", "tw4_prov_evidence(uuid, uuid)",
      "tw4_prov_resolve(uuid, uuid, text, text, text)", "tw4_prov_settle_admin(uuid, uuid, text, text, text)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    for (const fn of ["_tw4prov2_guard()", "_tw4prov2_is_pilot(uuid)", "_tw4prov2_proof(uuid)", "_tw4prov2_orphan_block()", "_tw4prov2_refusal_disposition()"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("f");
    }
  });

  // runtime role paths: the isolated stack mitigates the permission-denied crash of the shared QA image (supautils), so these are exercised only here
  it.skipIf(!isolated)("runtime: API roles are refused (42501) on every evidence function and the database survives each refusal", async () => {
    const anon = createClient(URL_, anonKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const authed = createClient(URL_, userKey(U.owner_a), { auth: { persistSession: false, autoRefreshToken: false } });
    const zero = "00000000-0000-4000-8000-000000000000";
    const calls: [string, Record<string, unknown>][] = [
      ["tw4_prov_listing_record", { p_onboarding_id: zero, p_lease_owner: "x", p_operation_id: zero, p_facts: {}, p_source: "fake", p_digest: "0".repeat(64) }],
      ["tw4_prov_resolve", { p_operation_id: zero, p_actor: U.padmin, p_resolution: "not_created", p_provider_sid: null, p_note: "fixture: runtime role check" }],
      ["tw4_prov_settle_admin", { p_operation_id: zero, p_actor: U.padmin, p_kind: "campaign_vetting", p_outcome: "released", p_note: "fixture: runtime role check" }],
      ["tw4_prov_orphan_register", { p_orphan_id: zero, p_actor: U.padmin }],
      ["tw4_prov_orphan_close", { p_orphan_id: zero, p_actor: U.padmin, p_note: "fixture: runtime role check" }],
      ["tw4_prov_evidence", { p_studio_id: zero, p_actor: U.padmin }],
    ];
    for (const [fn, args] of calls) {
      for (const client of [anon, authed]) {
        const r = (await client.rpc(fn, args)) as { error: { code?: string } | null };
        expect(r.error?.code, fn).toBe("42501");
      }
      expect(psql("select 1"), `database alive after ${fn}`).toBe("1");
    }
    // a user-bound token cannot reach the ledger tables either
    expect(((await authed.from("studio_sms_prov_listings").select("id").limit(1)) as { error: { code?: string } | null }).error).not.toBeNull();
  });

  it("rollback: parses and completes where there is no evidence (contained in a rolled-back transaction)", () => {
    const sql = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261212090000_twilio_prov_fee_resolution_evidence_rollback.sql"), "utf8").replace(/^begin;/m, "").replace(/^commit;/m, "");
    const out = psqlError(`begin;
      ${sql}
      do $$ begin
        if to_regclass('public.studio_sms_prov_listings') is not null or to_regclass('public.studio_sms_prov_orphans') is not null or to_regclass('public.studio_sms_prov_dispositions') is not null then raise exception 'tables remain'; end if;
        if to_regprocedure('public.tw4_prov_listing_record(uuid,text,uuid,jsonb,text,text)') is not null then raise exception 'function remains'; end if;
        if position('provider-backed' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_prov_resolve(uuid,uuid,text,text,text)'::regprocedure)) <> 0
           or position('only an unresolved operation can be resolved' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_prov_resolve(uuid,uuid,text,text,text)'::regprocedure)) = 0 then raise exception 'resolve not restored'; end if;
        if position('provider-backed' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_prov_settle_admin(uuid,uuid,text,text,text)'::regprocedure)) <> 0 then raise exception 'settle_admin not restored'; end if;
        if exists (select 1 from pg_trigger where tgname like '%orphan_block' or tgname like '%refusal_disposition') then raise exception 'trigger remains'; end if;
      end $$;
      rollback;`);
    expect(out).toBe("");
    expect(psql(`select to_regclass('public.studio_sms_prov_listings') is not null and position('provider-backed' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_prov_resolve(uuid,uuid,text,text,text)'::regprocedure)) > 0`)).toBe("t");
  });

  describe("credit-funded business: an unknown fee-bearing outcome is released only on provider-backed evidence", () => {
    let id = "";
    let d: FakeProvisioningAdapter;
    it("setup: an unknown outcome holds the reservation", async () => {
      d = hub.adapterFor(ACC.D);
      id = await unknownFeeOp(ED, SD1, U.owner_a, d, "d1");
      expect(reservations(ED, "campaign_vetting")).toBe(`reserved:${PRICE.vetting}:credit`);
    });

    it("no evidence at all, and an attempt younger than 20 minutes: refused (the old attestation path is closed)", async () => {
      expect((await resolveNotCreated(id)).error?.code).toBe("22023"); // the existing 20-minute rule still comes first
      ageOperation(id, 90);
      const r = await resolveNotCreated(id);
      expect(r.error?.code).toBe("TW046");
      expect(r.error?.message ?? "").not.toContain("QE");
      expect(reservations(ED, "campaign_vetting")).toBe(`reserved:${PRICE.vetting}:credit`);
      expect(dispositions(id)).toBe("");
    });

    it("a listing read earlier than 20 minutes after the attempt is 'premature' and counts for nothing", async () => {
      ageOperation(id, -80); // the attempt is 10 minutes old again
      expect((await check(SD1, d)).outcome).toBe("recorded");
      expect(listingRows(SD1)).toBe("premature");
      ageOperation(id, 80);
      aged(`delete from public.studio_sms_prov_listings where studio_id = '${SD1}'`);
    });

    it("one clean listing is not enough; two must be independent; replays, overlapping, stale and future reads are refused", async () => {
      expect((await check(SD1, d)).outcome).toBe("recorded");
      expect(listingRows(SD1)).toBe("absent");
      expect((await resolveNotCreated(id)).error?.code).toBe("TW046");
      // a replay of the same read is idempotent (no second observation) and a different digest for the same read is refused
      const same = randomUUID();
      const start = new Date().toISOString();
      const f = (extra: Partial<ListingFacts> = {}): Partial<ListingFacts> => ({ read_id: same, read_started_at: start, ...extra });
      ageListings(SD1, 1);
      const first = await record(SD1, id, f());
      expect(first.error).toBeNull();
      const again = await record(SD1, id, f());
      expect(again.error).toBeNull();
      expect((again.data as { replayed: boolean }).replayed).toBe(true);
      expect(listingRows(SD1)).toBe("absent,absent");
      expect((await record(SD1, id, f(), "ab".repeat(32))).error?.code).toBe("TW046");
      // a read that began before the previous record (an old read presented late) is not independent
      const prevMs = Number(psql(`select floor(extract(epoch from max(observed_at)) * 1000) from public.studio_sms_prov_listings where studio_id = '${SD1}'`));
      expect((await record(SD1, id, { read_started_at: new Date(prevMs - 1000).toISOString() })).error?.code).toBe("TW046");
      // stale (older than 10 minutes) and future reads
      expect((await record(SD1, id, { read_started_at: new Date(Date.now() - 11 * 60_000).toISOString() })).error?.code).toBe("TW046");
      expect((await record(SD1, id, { read_started_at: new Date(Date.now() + 5 * 60_000).toISOString() })).error?.code).toBe("TW046");
      // the read must follow the attempt
      aged(`update public.studio_sms_prov_operations set started_at = now() + interval '1 hour' where id = '${id}'`);
      expect((await record(SD1, id)).error?.code).toBe("TW046");
      ageOperation(id, 60 + 90);
      expect(listingRows(SD1)).toBe("absent,absent");
    });

    it("wrong subaccount, wrong Messaging Service, wrong business and wrong operation are refused and recorded as nothing", async () => {
      const before = listingRows(SD1);
      expect((await record(SD1, id, { account_sid: ACC.B })).error?.code).toBe("TW005");
      expect((await record(SD1, id, { scope_sid: `MG${"7".repeat(32)}` })).error?.code).toBe("TW049");
      // another business's operation under THIS studio's lease: not part of this onboarding
      const otherOp = psql(`select id from public.studio_sms_prov_operations where studio_id = '${SA1}' and op_kind = 'campaign' limit 1`) || "00000000-0000-4000-8000-0000000000aa";
      expect((await record(SD1, otherOp)).error?.code).toBe("22023");
      // the adapter of another business is refused before any provider call
      const wrongAdapter = hub.adapterFor(ACC.B);
      const calls = wrongAdapter.calls.length;
      expect((await check(SD1, wrongAdapter)).outcome).toBe("account_mismatch");
      expect(wrongAdapter.calls.length).toBe(calls);
      // a fake observation presented as a provider read is refused outside the local QA marker; here the marker exists, so only the digest shape is checked
      expect((await record(SD1, id, {}, "not-a-digest")).error?.code).toBe("22023");
      expect((await record(SD1, id, { listed: ["not-a-sid"] })).error?.code).toBe("22023");
      expect(listingRows(SD1)).toBe(before);
    });

    it("an incomplete read is inconclusive and breaks the chain: the evidence must be rebuilt; stale evidence is refused", async () => {
      aged(`delete from public.studio_sms_prov_listings where studio_id = '${SD1}'`);
      expect((await check(SD1, d)).outcome).toBe("recorded"); // absent (A)
      ageListings(SD1, 15);
      expect((await record(SD1, id, { complete: false })).error).toBeNull();
      ageListings(SD1, 1);
      expect((await check(SD1, d)).outcome).toBe("recorded"); // absent (C), 16+ minutes after A
      expect(listingRows(SD1)).toBe("absent,inconclusive,absent");
      expect((await resolveNotCreated(id)).error?.code).toBe("TW046"); // A -> inconclusive -> C: the chain from A is broken, C has no partner
      // stale: even a clean pair is refused once the latest read is older than 60 minutes
      ageListings(SD1, 70);
      expect((await resolveNotCreated(id)).error?.code).toBe("TW046");
      expect(reservations(ED, "campaign_vetting")).toBe(`reserved:${PRICE.vetting}:credit`);
    });

    it("two fresh independent clean listings after the interruption restore the proof: the fee is released ONCE, with its basis and evidence recorded", async () => {
      expect((await check(SD1, d)).outcome).toBe("recorded");
      aged(`update public.studio_sms_prov_listings set observed_at = observed_at - interval '15 minutes', read_started_at = read_started_at - interval '15 minutes' where studio_id = '${SD1}' and id = (select id from public.studio_sms_prov_listings where studio_id = '${SD1}' order by observed_at desc limit 1)`);
      expect((await check(SD1, d)).outcome).toBe("recorded");
      // an administrator who is not one is refused; a short reason is refused; nobody gets a second release
      expect((await rpc("tw4_prov_resolve", { p_operation_id: id, p_actor: U.owner_a, p_resolution: "not_created", p_provider_sid: null, p_note: "fixture: checked the console" })).error?.code).toBe("42501");
      expect((await resolveNotCreated(id, "short")).error?.code).toBe("22023");
      const ok = await resolveNotCreated(id);
      expect(ok.error).toBeNull();
      expect(ops(SD1, "campaign")).toBe("1:abandoned:false");
      expect(reservations(ED, "campaign_vetting")).toBe(`released:${PRICE.vetting}:credit`);
      expect(dispositions(id)).toBe("verified_absence:campaign_vetting:2");
      expect(auditCount(SD1, "prov_resolved")).toBe(1);
      expect(auditCount(SD1, "prov_listing")).toBeGreaterThan(0);
      expect((await resolveNotCreated(id)).error?.code).toBe("22023"); // replay: the operation is closed
      expect(dispositions(id)).toBe("verified_absence:campaign_vetting:2");
      expect(Number(psql(`select count(*) from public.studio_sms_credit_ledger l join public.studio_sms_credit_reservations r on r.id = l.reservation_id where r.legal_entity_id = '${ED}' and l.kind = 'release'`))).toBe(1);
    });

    it("the administrator-settlement path no longer releases on a note alone (legacy state reconstructed inside rolled-back transactions)", () => {
      const legacy = `update public.studio_sms_credit_reservations set status = 'reserved', closed_at = null where reservation_key = 'prov:${id}:campaign_vetting';
        update public.studio_sms_spend_events set status = 'reserved' where reservation_key = 'prov:${id}:campaign_vetting';
        delete from public.studio_sms_prov_dispositions where operation_id = '${id}';`;
      const call = (actor: string, outcome: string) => `select public.tw4_prov_settle_admin('${id}', '${actor}', 'campaign_vetting', '${outcome}', 'fixture: legacy state, release on a note alone');`;
      const attempt = (sql: string) => psqlError(`begin; set local session_replication_role = replica; ${legacy} set local session_replication_role = origin; ${sql} rollback;`);
      expect(attempt(call(U.padmin, "released"))).toMatch(/TW046/);
      expect(attempt(call(U.owner_a, "released"))).toMatch(/42501/);
      expect(attempt(call(U.padmin, "bogus"))).toMatch(/22023/);
      // with the recorded verified-absence disposition the settlement is allowed (and is itself recorded)
      const allowed = attempt(`insert into public.studio_sms_prov_dispositions (operation_id, legal_entity_id, studio_id, fee_kind, disposition, note) values ('${id}', '${ED}', '${SD1}', 'campaign_vetting', 'verified_absence', 'fixture: evidence recorded earlier');
        ${call(U.padmin, "released")}
        do $$ begin if (select count(*) from public.studio_sms_prov_dispositions where operation_id = '${id}' and disposition = 'settled_released') <> 1 then raise exception 'not recorded'; end if; end $$;`);
      expect(allowed).toBe("");
      expect(reservations(ED, "campaign_vetting")).toBe(`released:${PRICE.vetting}:credit`); // nothing leaked out of the rolled-back transactions
      expect(dispositions(id)).toBe("verified_absence:campaign_vetting:2");
    });
  });

  describe("late discovery: a provider resource found after the operation was closed is never ignored", () => {
    let id = "";
    let a: FakeProvisioningAdapter;
    let orphanId = "";
    it("setup: the unknown outcome is released on evidence, then the provider turns out to have created it", async () => {
      a = hub.adapterFor(ACC.A);
      id = await unknownFeeOp(EA, SA1, U.owner_a, a, "a1");
      await proveAbsence(SA1, a, id);
      expect((await resolveNotCreated(id)).error).toBeNull();
      expect(reservations(EA, "campaign_vetting")).toBe(`released:${PRICE.vetting}:credit`);
      // "Twilio" completes the create it had accepted earlier (a late, asynchronous creation)
      const ms = msSid(SA1);
      await a.createCampaign({
        messagingServiceSid: ms, brandSid: BRAND.A1, useCase: "MIXED", description: "late", messageFlow: "late", messageSamples: ["a", "b"], hasEmbeddedLinks: false, hasEmbeddedPhone: false,
        subscriberOptIn: true, ageGated: false, directLending: false, optInMessage: "o", optOutMessage: "o", helpMessage: "h", optInKeywords: ["START"], optOutKeywords: ["STOP"], helpKeywords: ["HELP"],
      });
    });

    it("a listing recorded AFTER the operation is abandoned still counts: the orphan is recorded once, with alerts for the owner and the administrators and no studio charge", async () => {
      ageListings(SA1, 20);
      const out = await check(SA1, a);
      expect(out.outcome).toBe("recorded");
      expect(listingRows(SA1)).toMatch(/present$/);
      expect(psql(`select count(*) from public.studio_sms_prov_orphans where studio_id = '${SA1}'`)).toBe("1");
      orphanId = psql(`select id from public.studio_sms_prov_orphans where studio_id = '${SA1}'`);
      expect(psql(`select status from public.studio_sms_prov_orphans where id = '${orphanId}'`)).toBe("open");
      // idempotent: the same discovery again changes nothing
      ageListings(SA1, 1);
      expect((await check(SA1, a)).outcome).toBe("recorded");
      expect(psql(`select count(*) from public.studio_sms_prov_orphans where studio_id = '${SA1}'`)).toBe("1");
      expect(psql(`select count(*) from public.studio_sms_provider_alerts where dedupe_key like 'prov_orphan:${orphanId}:%'`)).toBe("2");
      // owner text: no identifier, no amount; administrators are told, with the orphan id and no provider identifier
      const owner = psql(`select summary from public.studio_sms_provider_alerts where dedupe_key = 'prov_orphan:${orphanId}:owner'`);
      const adminText = psql(`select summary from public.studio_sms_provider_alerts where dedupe_key = 'prov_orphan:${orphanId}:admin'`);
      expect(owner).not.toMatch(/\b(QE|MG|AC)[0-9a-f]{8}|\$|\d{3}/i);
      expect(adminText).not.toMatch(/\b(QE|MG|AC)[0-9a-f]{32}\b/i);
      expect(psql(`select audience || ':' || kind from public.studio_sms_provider_alerts where dedupe_key = 'prov_orphan:${orphanId}:owner'`)).toBe("owner:inventory_gap");
      expect(auditCount(SA1, "prov_orphan")).toBe(1);
      // the lifecycle's own delivery queue picks the alerts up (no competing delivery system)
      const claimed = await rpc("tw4_rfl_alerts_claim", { p_limit: 100 });
      expect(claimed.error).toBeNull();
      const mine = psql(`select string_agg(id::text, ',') from public.studio_sms_provider_alerts where dedupe_key like 'prov_orphan:${orphanId}:%'`).split(",");
      const claimedIds = (claimed.data as { alert_id: string }[]).map((c) => c.alert_id);
      expect(mine).toHaveLength(2);
      for (const alertId of mine) expect(claimedIds).toContain(alertId);
      // no studio charge: the orphan created no credit movement
      expect(Number(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and kind in ('usage_charge','capture')`))).toBe(0);
    });

    it("it blocks every further fee-bearing operation of the business", async () => {
      expect((await authorize(EA, SA1, "campaign_vetting", PRICE.vetting, ref("vetting-a1-again"))).error).toBeNull();
      const opsBefore = psql(`select count(*) from public.studio_sms_prov_operations where studio_id = '${SA1}'`);
      const created = a.count("createCampaign");
      const out = await run(SA1, a);
      expect(out.outcome).not.toBe("campaign_submitted");
      expect(a.count("createCampaign")).toBe(created);
      expect(psql(`select count(*) from public.studio_sms_prov_operations where studio_id = '${SA1}'`)).toBe(opsBefore);
      expect(psql(`select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EA}' and status = 'reserved' and reservation_key like 'prov:%'`)).toBe("0");
      // the block is a database trigger on both provisioning ledgers, not a runner choice
      expect(psql(`select count(*) from pg_trigger where tgname in ('studio_sms_prov_operations_orphan_block', 'studio_sms_num_operations_orphan_block')`)).toBe("2");
    });

    it("registration with the lifecycle makes it provider-cost exposure; replay is idempotent; only an administrator may; it cannot be closed while the resource is live", async () => {
      expect((await rpc("tw4_prov_orphan_register", { p_orphan_id: orphanId, p_actor: U.owner_a })).error?.code).toBe("42501");
      const first = await rpc("tw4_prov_orphan_register", { p_orphan_id: orphanId, p_actor: U.padmin });
      expect(first.error).toBeNull();
      expect((first.data as { replayed: boolean }).replayed).toBe(false);
      const again = await rpc("tw4_prov_orphan_register", { p_orphan_id: orphanId, p_actor: U.padmin });
      expect((again.data as { replayed: boolean }).replayed).toBe(true);
      expect(psql(`select status from public.studio_sms_prov_orphans where id = '${orphanId}'`)).toBe("registered");
      expect(psql(`select count(*) from public.studio_sms_provider_resources where id = (select rfl_resource_id from public.studio_sms_prov_orphans where id = '${orphanId}') and provider_state = 'active' and resource_kind = 'campaign' and legal_entity_id = '${EA}'`)).toBe("1");
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphanId, p_actor: U.padmin, p_note: "fixture: close while the resource is live" })).error?.code).toBe("TW046");
      // still blocked and still visible to the administrators
      const view = (await rpc("tw4_prov_evidence", { p_studio_id: SA1, p_actor: U.padmin })).data as { orphans: { id: string; status: string }[] };
      expect(view.orphans.map((o) => `${o.id}:${o.status}`)).toEqual([`${orphanId}:registered`]);
    });

    it("it closes only after the lifecycle shows the resource cancelled with provider evidence; the block then lifts", async () => {
      aged(`update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = now(), cancel_evidence_digest = '${"ab".repeat(32)}' where id = (select rfl_resource_id from public.studio_sms_prov_orphans where id = '${orphanId}')`);
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphanId, p_actor: U.owner_a, p_note: "fixture: not an administrator" })).error?.code).toBe("42501");
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphanId, p_actor: U.padmin, p_note: "short" })).error?.code).toBe("22023");
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphanId, p_actor: U.padmin, p_note: "fixture: the lifecycle shows the cancellation evidence" })).error).toBeNull();
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphanId, p_actor: U.padmin, p_note: "fixture: the lifecycle shows the cancellation evidence" })).data).toMatchObject({ replayed: true });
      expect(psql(`select count(*) from public.studio_sms_prov_orphans where legal_entity_id = '${EA}' and status <> 'closed'`)).toBe("0");
    });
  });

  describe("a present or conflicting observation fails closed", () => {
    it("a campaign the provider lists makes 'not created' impossible, even after later clean reads", async () => {
      const b = hub.adapterFor(ACC.B);
      const id = await unknownFeeOp(EB, SB1, U.owner_b, b, "b1", "monthly_low_volume");
      ageOperation(id, 120);
      // the provider holds a campaign for this service (the adapter lost the response after Twilio accepted it)
      const ms = msSid(SB1);
      const sid = await b.createCampaign({
        messagingServiceSid: ms, brandSid: BRAND.B1, useCase: "LOW_VOLUME", description: "x", messageFlow: "x", messageSamples: ["a", "b"], hasEmbeddedLinks: false, hasEmbeddedPhone: false,
        subscriberOptIn: true, ageGated: false, directLending: false, optInMessage: "o", optOutMessage: "o", helpMessage: "h", optInKeywords: ["START"], optOutKeywords: ["STOP"], helpKeywords: ["HELP"],
      });
      expect((await check(SB1, b)).outcome).toBe("recorded");
      expect(listingRows(SB1)).toBe("present");
      // an open operation with exactly one new candidate is the resource it is waiting for: adopted by the runner, not an orphan
      expect(psql(`select count(*) from public.studio_sms_prov_orphans where studio_id = '${SB1}'`)).toBe("0");
      b.campaigns.delete(sid); // the resource disappears from the listing
      ageListings(SB1, 15);
      expect((await check(SB1, b)).outcome).toBe("recorded");
      ageListings(SB1, 15);
      expect((await check(SB1, b)).outcome).toBe("recorded");
      expect(listingRows(SB1)).toBe("present,absent,absent");
      expect((await resolveNotCreated(id)).error?.code).toBe("TW046"); // a resource was seen: conflicting evidence never resolves as not created
      expect(reservations(EB, "campaign_vetting")).toBe(`reserved:${PRICE.vetting}:credit`);
      expect(dispositions(id)).toBe("");
    });
  });

  describe("concurrency", () => {
    it("two administrators resolving the same proven operation at once: exactly one release", async () => {
      // business A's location 2 cannot hold its own service; reuse business D's second scenario is not possible, so a fresh operation is built on business B after its conflict is cleared
      const b = hub.adapterFor(ACC.B);
      const id = opId(SB1, "campaign");
      aged(`delete from public.studio_sms_prov_listings where studio_id = '${SB1}'`);
      b.campaigns.clear();
      await proveAbsence(SB1, b, id);
      const results = await Promise.all([resolveNotCreated(id), resolveNotCreated(id, "fixture: second administrator, same facts")]);
      const ok = results.filter((r) => r.error === null).length;
      expect(ok).toBe(1);
      expect(results.filter((r) => r.error !== null).every((r) => r.error?.code === "22023" || r.error?.code === "55P03")).toBe(true);
      expect(reservations(EB, "campaign_vetting")).toBe(`released:${PRICE.vetting}:credit`);
      expect(dispositions(id)).toBe("verified_absence:campaign_vetting:2");
      expect(Number(psql(`select count(*) from public.studio_sms_credit_ledger l join public.studio_sms_credit_reservations r on r.id = l.reservation_id where r.legal_entity_id = '${EB}' and l.kind = 'release'`))).toBe(1);
    });

    it("a provider discovery racing a resolution never leaves a released fee with an unrecorded resource", async () => {
      // business A's location again is blocked by its closed orphan history; use business D, whose operation was released earlier, for a fresh unknown outcome
      const d = hub.adapterFor(ACC.D);
      expect((await authorize(ED, SD1, "campaign_vetting", PRICE.vetting, ref("vetting-d1-race"))).error).toBeNull();
      d.failNext("createCampaign", { kind: "transient" });
      expect((await run(SD1, d)).outcome).toBe("retry_later");
      expect((await run(SD1, d)).outcome).toBe("unknown_outcome");
      const id = opId(SD1, "campaign", 2);
      await proveAbsence(SD1, d, id);
      await d.createCampaign({
        messagingServiceSid: msSid(SD1), brandSid: BRAND.D1, useCase: "MIXED", description: "race", messageFlow: "race", messageSamples: ["a", "b"], hasEmbeddedLinks: false, hasEmbeddedPhone: false,
        subscriberOptIn: true, ageGated: false, directLending: false, optInMessage: "o", optOutMessage: "o", helpMessage: "h", optInKeywords: ["START"], optOutKeywords: ["STOP"], helpKeywords: ["HELP"],
      });
      ageListings(SD1, 1);
      const [res, seen] = await Promise.all([resolveNotCreated(id), check(SD1, d)]);
      const status = psql(`select status from public.studio_sms_prov_operations where id = '${id}'`);
      const present = Number(psql(`select count(*) from public.studio_sms_prov_listings where operation_id = '${id}' and verdict = 'present'`));
      if (res.error === null) {
        // resolved first: the late observation (if it ran) is an orphan, never silently dropped
        expect(status).toBe("abandoned");
        if (present > 0) expect(Number(psql(`select count(*) from public.studio_sms_prov_orphans where source_operation_id = '${id}'`))).toBeGreaterThan(0);
      } else {
        // the observation came first (or the lease was busy): nothing was released
        expect(["TW046", "55P03"]).toContain(res.error.code);
        expect(status).toBe("unknown_outcome");
        expect(reservations(ED, "campaign_vetting")).toMatch(/reserved:/);
      }
      expect(["recorded", "lease_busy"]).toContain(seen.outcome);
    });
  });

  describe("ConfiDance (pilot business)", () => {
    it("a fee-bearing 'not created' is never allowed, even with perfect provider evidence; the cumulative ceiling is not replenished", async () => {
      const c = hub.adapterFor(ACC.C);
      const base = ref("pilot-founder-fee");
      expect((await rpc("tw4_pilot_exception_create", { p_entity_id: EC, p_ceiling_cents: 15_000, p_approval_ref: base, p_actor: U.padmin })).error).toBeNull();
      expect((await authorize(EC, SC1, "campaign_vetting", PRICE.vetting, ref("pilot-vetting-fee"), "pilot")).error).toBeNull();
      expect((await authorize(EC, SC1, "monthly", PRICE.monthly, ref("pilot-monthly-fee"), "pilot")).error).toBeNull();
      c.failNext("createCampaign", { kind: "transient" });
      expect((await run(SC1, c)).outcome).toBe("retry_later");
      expect((await run(SC1, c)).outcome).toBe("unknown_outcome");
      const id = opId(SC1, "campaign");
      const used = () => psql(`select coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${EC}' and funding = 'pilot' and status in ('reserved', 'captured')`);
      const before = used();
      expect(Number(before)).toBe(PRICE.vetting + PRICE.monthly);
      await proveAbsence(SC1, c, id);
      expect(listingRows(SC1)).toBe("absent,absent");
      expect(psql(`select (public._tw4prov2_proof('${id}') ->> 'ok')`)).toBe("true"); // the evidence itself is perfect
      const r = await resolveNotCreated(id);
      expect(r.error?.code).toBe("TW048");
      expect(used()).toBe(before);
      expect(reservations(EC, "campaign_vetting")).toBe(`reserved:${PRICE.vetting}:pilot`);
      expect(reservations(EC, "monthly")).toBe(`reserved:${PRICE.monthly}:pilot`);
      expect(ops(SC1, "campaign")).toBe("1:unknown_outcome:false");
      expect(dispositions(id)).toBe("");
    });

    it("the administrator settlement never releases a pilot reservation; a definitive provider refusal is the only release and is recorded as such", async () => {
      const c = hub.adapterFor(ACC.C);
      const id = opId(SC1, "campaign");
      // pilot rule beats any state and any evidence: a succeeded operation, then an abandoned one with a recorded absence (contained)
      const surgery = (status: string) => `update public.studio_sms_prov_operations set status = '${status}', provider_sid = ${status === "succeeded" ? "'QE" + "c".repeat(32) + "'" : "null"} where id = '${id}';`;
      const settle = `select public.tw4_prov_settle_admin('${id}', '${U.padmin}', 'monthly', 'released', 'fixture: release the pilot first month on a note');`;
      const attempt = (sql: string) => psqlError(`begin; set local session_replication_role = replica; ${sql} set local session_replication_role = origin; ${settle} rollback;`);
      expect(attempt(surgery("succeeded"))).toMatch(/TW048/);
      expect(attempt(`${surgery("abandoned")} insert into public.studio_sms_prov_dispositions (operation_id, legal_entity_id, studio_id, fee_kind, disposition, note) values ('${id}', '${EC}', '${SC1}', 'monthly', 'verified_absence', 'fixture: a recorded absence does not release the pilot');`)).toMatch(/TW048/);
      expect(reservations(EC, "monthly")).toBe(`reserved:${PRICE.monthly}:pilot`);
      // clear the unknown attempt exactly as a prior, unrelated closure would have (this reconstruction is fixture-only), then a NEW attempt is refused by the provider
      aged(`update public.studio_sms_prov_operations set status = 'abandoned', superseded_at = now() where id = '${id}';
            update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where legal_entity_id = '${EC}' and reservation_key like 'prov:${id}:%';
            set local tw4.credit_settle = 'on'; update public.studio_sms_spend_events set status = 'void' where reservation_key like 'prov:${id}:%'; `);
      expect((await authorize(EC, SC1, "campaign_vetting", PRICE.vetting, ref("pilot-vetting-fee-2"), "pilot")).error).toBeNull();
      expect((await authorize(EC, SC1, "monthly", PRICE.monthly, ref("pilot-monthly-fee-2"), "pilot")).error).toBeNull();
      c.failNext("createCampaign", { kind: "validation" }); // Twilio answered, definitively: refused
      const out = await run(SC1, c);
      expect(out.outcome).not.toBe("campaign_submitted");
      const second = opId(SC1, "campaign", 2);
      expect(ops(SC1, "campaign")).toMatch(/2:failed:false$/);
      expect(psql(`select string_agg(disposition || ':' || fee_kind, ',' order by fee_kind) from public.studio_sms_prov_dispositions where operation_id = '${second}' and disposition = 'provider_refusal'`)).toBe("provider_refusal:campaign_vetting,provider_refusal:monthly");
      expect(reservations(EC, "campaign_vetting")).toContain(`released:${PRICE.vetting}:pilot`);
      expect(c.count("createCampaign")).toBe(2);
      // every settlement, by any path, also left an automatic reservation disposition (one per released fee kind)
      expect(psql(`select string_agg(disposition || ':' || fee_kind, ',' order by fee_kind) from public.studio_sms_prov_dispositions where operation_id = '${second}' and disposition like 'reservation\\_%'`)).toBe("reservation_released:campaign_vetting,reservation_released:monthly");
    });
  });

  describe("review hardening", () => {
    const anyCampaign = (messagingServiceSid: string, brandSid: string) => ({
      messagingServiceSid, brandSid, useCase: "MIXED" as const, description: "x", messageFlow: "x", messageSamples: ["a", "b"], hasEmbeddedLinks: false, hasEmbeddedPhone: false,
      subscriberOptIn: true, ageGated: false, directLending: false, optInMessage: "o", optOutMessage: "o", helpMessage: "h", optInKeywords: ["START"], optOutKeywords: ["STOP"], helpKeywords: ["HELP"],
    });

    it("the evidence lease works while the onboarding is parked in 'exception' (where an unknown fee outcome leaves it); the runner's own claim does not", async () => {
      const c = hub.adapterFor(ACC.C);
      const prior = psql(`select state from public.studio_sms_onboarding where studio_id = '${SC1}'`);
      aged(`update public.studio_sms_onboarding set state = 'exception', last_error_code = 'prov_unknown_fee' where studio_id = '${SC1}'`);
      try {
        await expect(store.claim(SC1, U.padmin, `r-${RUN}`, 60, "refresh")).rejects.toMatchObject({ code: "TW030" });
        const out = await checkCampaignAbsence({ store, evidence: evidence(), adapter: c, studioId: SC1, actorId: U.padmin });
        expect(out.outcome).toBe("recorded");
        expect(psql(`select state from public.studio_sms_onboarding where studio_id = '${SC1}'`)).toBe("exception"); // the evidence lease changed no state
        expect(psql(`select coalesce(lease_owner, '') from public.studio_sms_onboarding where studio_id = '${SC1}'`)).toBe(""); // and released the lease
      } finally {
        aged(`update public.studio_sms_onboarding set state = '${prior}', last_error_code = null where studio_id = '${SC1}'`);
      }
      // only a platform administrator can take it, and a held lease excludes it
      expect((await rpc("tw4_prov_evidence_claim", { p_studio_id: SC1, p_actor: U.owner_a, p_lease_owner: "x", p_lease_seconds: 60 })).error?.code).toBe("42501");
      const held = await store.claim(SC1, U.padmin, `held-${RUN}`, 60, "refresh");
      expect((await rpc("tw4_prov_evidence_claim", { p_studio_id: SC1, p_actor: U.padmin, p_lease_owner: "other", p_lease_seconds: 60 })).error?.code).toBe("55P03");
      await store.release(held.onboarding_id, `held-${RUN}`);
    });

    it("a still-open attempt's own resource is NOT filed as an orphan (the runner adopts it); more candidates than open attempts are all recorded", async () => {
      const b = hub.adapterFor(ACC.B);
      // business B has no open attempt (its operation was closed in the concurrency test): a found campaign is an orphan
      const ms = msSid(SB1);
      const sid1 = await b.createCampaign(anyCampaign(ms, BRAND.B1));
      ageListings(SB1, 20);
      expect((await check(SB1, b)).outcome).toBe("recorded");
      expect(psql(`select provider_sid from public.studio_sms_prov_orphans where studio_id = '${SB1}'`)).toBe(sid1);
      // with the ledger now accounting for it, the orphan closes without any administrator claim; before that it cannot
      const orphan = psql(`select id from public.studio_sms_prov_orphans where studio_id = '${SB1}'`);
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphan, p_actor: U.padmin, p_note: "fixture: the resource is really ours, I say" })).error?.code).toBe("TW046");
      // pilot business: one open attempt, one found campaign = the attempt's own resource, no orphan
      const c = hub.adapterFor(ACC.C);
      const cSid = await c.createCampaign(anyCampaign(msSid(SC1), BRAND.C1));
      expect((await check(SC1, c)).outcome).toBe("recorded");
      expect(psql(`select count(*) from public.studio_sms_prov_orphans where studio_id = '${SC1}'`)).toBe("0");
      expect(listingRows(SC1)).toMatch(/present$/);
      c.campaigns.delete(cSid);
      // the ledger comes to account for the first orphan's SID: it closes (database-checked), idempotently
      aged(`update public.studio_sms_prov_operations set provider_sid = '${sid1}', status = 'succeeded' where id = (select id from public.studio_sms_prov_operations where studio_id = '${SB1}' and op_kind = 'campaign' order by attempt desc limit 1)`);
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphan, p_actor: U.padmin, p_note: "fixture: the ledger now accounts for this resource" })).error).toBeNull();
      expect(psql(`select status from public.studio_sms_prov_orphans where id = '${orphan}'`)).toBe("closed");
    });

    it("an orphan also closes when two later complete provider listings, 10+ minutes apart, no longer show it; one listing, or a listing that still shows it, does not", async () => {
      const a = hub.adapterFor(ACC.A);
      const ms = msSid(SA1);
      const gone = await a.createCampaign(anyCampaign(ms, BRAND.A1));
      ageListings(SA1, 120);
      expect((await check(SA1, a)).outcome).toBe("recorded");
      const orphan = psql(`select id from public.studio_sms_prov_orphans where provider_sid = '${gone}'`);
      aged(`update public.studio_sms_prov_orphans set discovered_at = discovered_at - interval '3 hours' where id = '${orphan}'`); // the test moves time, not the rule
      const note = "fixture: the listings no longer show it";
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphan, p_actor: U.padmin, p_note: note })).error?.code).toBe("TW046"); // still listed
      a.campaigns.delete(gone);
      ageListings(SA1, 15);
      expect((await check(SA1, a)).outcome).toBe("recorded");
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphan, p_actor: U.padmin, p_note: note })).error?.code).toBe("TW046"); // one clean listing is not enough
      ageListings(SA1, 15);
      expect((await check(SA1, a)).outcome).toBe("recorded");
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphan, p_actor: U.owner_a, p_note: note })).error?.code).toBe("42501");
      expect((await rpc("tw4_prov_orphan_close", { p_orphan_id: orphan, p_actor: U.padmin, p_note: note })).error).toBeNull();
    });

    it("a SUCCEEDED operation is never released by the administrator settlement, even with a lifecycle 'cancellation' digest (it is administrator-typed, not provider-verified)", () => {
      const id = opId(SD1, "campaign");
      const out = psqlError(`begin; set local session_replication_role = replica;
        update public.studio_sms_prov_operations set status = 'succeeded', provider_sid = 'QE${"e".repeat(32)}' where id = '${id}';
        update public.studio_sms_credit_reservations set status = 'reserved', closed_at = null where reservation_key = 'prov:${id}:campaign_vetting';
        update public.studio_sms_spend_events set status = 'reserved' where reservation_key = 'prov:${id}:campaign_vetting';
        insert into public.studio_sms_provider_resources (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, fee_kind, source, source_operation_id, provider_state, registered_by, cancelled_at, cancel_evidence_digest)
          values ('${ED}', '${SD1}', '${ACC.D}', 'campaign', 'QE${"e".repeat(32)}', 'monthly', 'admin', '${id}', 'cancelled', '${U.padmin}', now(), '${"ab".repeat(32)}');
        set local session_replication_role = origin;
        select public.tw4_prov_settle_admin('${id}', '${U.padmin}', 'campaign_vetting', 'released', 'fixture: a cancellation digest an administrator typed');
        rollback;`);
      expect(out).toMatch(/TW046/);
    });

    it("a 'refusal' is refused while a provider listing shows a resource for the operation; without that listing the same update is allowed", () => {
      const id = opId(SC1, "campaign", 1);
      const attempt = (withPresent: boolean) =>
        psqlError(`begin; set local session_replication_role = replica;
          update public.studio_sms_prov_operations set status = 'in_flight', superseded_at = null where id = '${id}';
          ${withPresent ? "" : `delete from public.studio_sms_prov_listings where operation_id = '${id}' and verdict = 'present';`}
          set local session_replication_role = origin;
          update public.studio_sms_prov_operations set status = 'failed', error_code = 'api' where id = '${id}';
          rollback;`);
      expect(attempt(true)).toMatch(/TW046/);
      expect(attempt(false)).toBe("");
    });

    it("the new evidence tables have row-level security enabled (no policies: no API role can read them)", () => {
      expect(psql(`select string_agg(relname || ':' || relrowsecurity::text, ',' order by relname) from pg_class where relname in ('studio_sms_prov_listings', 'studio_sms_prov_orphans', 'studio_sms_prov_dispositions')`))
        .toBe("studio_sms_prov_dispositions:true,studio_sms_prov_listings:true,studio_sms_prov_orphans:true");
    });
  });
});
