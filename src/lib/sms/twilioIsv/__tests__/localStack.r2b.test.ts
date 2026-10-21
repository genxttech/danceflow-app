/**
 * TW-4F R2b (20261208090000) against a REAL schema: number offers and owner approvals, the purchase fee gate (credit-funded and the ConfiDance pilot ceiling),
 * unknown-outcome handling, duplicate-purchase prevention, tenant isolation, suspension, the sender-registry hand-off, the Advanced Opt-Out attestation, the
 * compliance validation and the activation checklist, driven through the real runner with the FAKE provider (no Twilio, no SMS, no Stripe).
 * Synthetic fixtures with their own id block; every row written is removed afterwards. Rollback is only ever executed inside a transaction that is rolled back.
 * LOCAL QA STACK ONLY (skipped unless the variables point at a loopback stack with the migrations through 20261208090000 applied):
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.r2b.test.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

import { activate, activationCheck, attestOptOut, markReady, recordSenderFromLedger, runComplianceValidation, suspend, verifyForActivation, type OptOutChecklist } from "../../activation";
import { FakeSenderReadProvider } from "../../senderVerification";
import { SupabaseCreditStore } from "../creditStore";
import { FakeNumberAdapter, FakeNumberHub } from "../fakeNumbers";
import { SupabaseNumberStore } from "../numberStore";
import { offerNumbers, refreshNumber, runNumberAcquisition } from "../numberRunner";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DBN = process.env.TW4A_LOCAL_DB_NAME ?? "postgres";
// an isolated PostgREST (own database) has no gateway in front of it: its paths have no /rest/v1 prefix
const NO_PREFIX = process.env.TW4A_LOCAL_NO_REST_PREFIX === "1";
const mkClient = (key: string) =>
  createClient(URL_, key, { auth: { persistSession: false, autoRefreshToken: false }, ...(NO_PREFIX ? { global: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    // an idle keep-alive socket that PostgREST already closed fails BEFORE the request is processed: retry that once (a stack behind a gateway never needs this)
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetch(String(input).replace("/rest/v1", ""), init);
      } catch (error) {
        if (attempt >= 2 || !/ECONNRESET|fetch failed/.test(String((error as Error)?.cause ?? error))) throw error;
      }
    }
  } } } : {}) });
const loopback = (() => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(URL_).hostname);
  } catch {
    return false;
  }
})();
const enabled = Boolean(URL_ && SECRET && PG) && loopback;

const SA1 = "b2b00000-0000-4000-8000-00000000000a"; // business A (credit funded), location 1: the full activation flow
const SA2 = "b2b00000-0000-4000-8000-00000000000b"; // business A, location 2
const SB1 = "b2b00000-0000-4000-8000-00000000000c"; // business B (credit funded): the other tenant
const SC1 = "b2b00000-0000-4000-8000-00000000000d"; // business C (the ConfiDance pilot business)
const SD1 = "b2b00000-0000-4000-8000-00000000000e"; // business D (credit funded): ambiguity and refusal flows
const EA = "e2b00000-0000-4000-8000-0000000000a1";
const EB = "e2b00000-0000-4000-8000-0000000000b1";
const EC = "e2b00000-0000-4000-8000-0000000000c1";
const ED = "e2b00000-0000-4000-8000-0000000000d1";
const OA1 = "02b00000-0000-4000-8000-0000000000a1";
const OA2 = "02b00000-0000-4000-8000-0000000000a2";
const OB1 = "02b00000-0000-4000-8000-0000000000b1";
const OC1 = "02b00000-0000-4000-8000-0000000000c1";
const OD1 = "02b00000-0000-4000-8000-0000000000d1";
const U = { owner_a: "b2b00000-0000-4000-8000-000000000101", owner_b: "b2b00000-0000-4000-8000-000000000201", padmin: "b2b00000-0000-4000-8000-000000000401", stranger: "b2b00000-0000-4000-8000-000000000501" };
const ACC = { A: `AC${"a3".repeat(16)}`, B: `AC${"b3".repeat(16)}`, C: `AC${"c3".repeat(16)}`, D: `AC${"d3".repeat(16)}` };
const sid = (prefix: string, tag: string) => prefix + tag.repeat(16);
const MG = { A1: sid("MG", "a1"), A2: sid("MG", "a2"), B1: sid("MG", "b1"), C1: sid("MG", "c1"), D1: sid("MG", "d1") };
const QE = { A1: sid("QE", "a1"), A2: sid("QE", "a2"), B1: sid("QE", "b1"), C1: sid("QE", "c1"), D1: sid("QE", "d1") };
const BRAND = { A1: sid("BN", "a1"), A2: sid("BN", "a2"), B1: sid("BN", "b1"), C1: sid("BN", "c1"), D1: sid("BN", "d1") };
const RUN = randomBytes(3).toString("hex");
const INBOUND = "https://app.example.test/api/sms/twilio/inbound";
const PRICE = { number: 200, monthly: 1250, vetting: 1900 };
const NUM = {
  a1: "+12025550101", a1b: "+12025550102", a2: "+12025550103", b1: "+12025550104", c1: "+12025550105", c2: "+12025550106", d1: "+12025550107", d2: "+12025550108", d3: "+12025550109",
  addr: "+12025550110", nosms: "+12025550111", a1c: "+12025550112",
};
const CHECKLIST: OptOutChecklist = { advanced_opt_out_enabled: true, stop_keyword_confirmed: true, start_keyword_confirmed: true, help_keyword_confirmed: true, confirmation_replies_confirmed: true };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DBN, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DBN, "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DBN, "-q", "-v", "ON_ERROR_STOP=1"], { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
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
delete from public.studio_sms_inbound_route_pins where set_by = '${U.padmin}';
delete from public.studio_sms_num_inventory_acks where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_compliance_checks where studio_id in (${STUDIOS});
delete from public.studio_sms_optout_attestations where studio_id in (${STUDIOS});
delete from public.studio_sms_num_resources where studio_id in (${STUDIOS});
delete from public.studio_sms_num_operations where studio_id in (${STUDIOS});
delete from public.studio_sms_number_selections where studio_id in (${STUDIOS});
delete from public.studio_sms_number_offers where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_resources where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_operations where studio_id in (${STUDIOS});
delete from public.studio_sms_sender_verifications where studio_id in (${STUDIOS});
delete from public.studio_sms_billed_senders where studio_id in (${STUDIOS});
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
delete from auth.users where email like '%@tw4r2b-e2e.test';
commit;`;

const hex = (tag: string) => tag.repeat(64).slice(0, 64);
/** The state R2a leaves behind: a Messaging Service the provider read `ready` and a campaign it read VERIFIED (the observed truth, seeded directly). */
const ledgerSql = (onboarding: string, studio: string, entity: string, account: string, mg: string, qe: string, brand: string) => `
  insert into public.studio_sms_registrations (studio_id, registration_status, brand_sid, brand_status) values ('${studio}', 'in_review', '${brand}', 'approved')
    on conflict (studio_id) do update set brand_sid = excluded.brand_sid, brand_status = excluded.brand_status;
  insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status, provider_sid, mock, twilio_account_sid)
    values ('${onboarding}', '${studio}', 'B1', 1, 'succeeded', '${brand}', false, '${account}');
  with ms as (insert into public.studio_sms_prov_operations (onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, provider_sid, started_by)
      values ('${onboarding}', '${studio}', '${entity}', '${account}', 'messaging_service', 1, 1, 'succeeded', 'df:test:fixture:ms', '${hex("a")}', '${mg}', '${U.padmin}') returning id),
       qe as (insert into public.studio_sms_prov_operations (onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, provider_sid,
                                                              fee_bearing, fee_kinds, started_by)
      values ('${onboarding}', '${studio}', '${entity}', '${account}', 'campaign', 1, 1, 'succeeded', 'df:test:fixture:c1', '${hex("b")}', '${qe}', true, array['campaign_vetting'], '${U.padmin}') returning id)
  insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, brand_sid, use_case, status, source, evidence_digest, verified_at)
    select ms.id, '${entity}'::uuid, '${studio}'::uuid, '${account}', 'messaging_service', '${mg}', null, null, null, 'ready', 'fake', '${hex("c")}', now() from ms
    union all select qe.id, '${entity}'::uuid, '${studio}'::uuid, '${account}', 'campaign', '${qe}', '${mg}', '${brand}', 'MIXED', 'verified', 'fake', '${hex("d")}', now() from qe;`;

const onboardingRow = (id: string, studio: string, last4: string, name: string) => `('${id}', '${studio}', 'campaign_pending', '${name}', 'llc', '${last4}', 1, now())`;

const FIXTURES = `${CLEANUP}
create table if not exists public.tw4_local_qa_only (note text); revoke all on public.tw4_local_qa_only from public, anon, authenticated, service_role;
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4r2b-e2e.test', now(), now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.owner_b}', 'owner_b'), ('${U.padmin}', 'padmin'), ('${U.stranger}', 'stranger')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.owner_b}', null), ('${U.padmin}', 'platform_admin'), ('${U.stranger}', null)
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values
  ('${SA1}', 'R2B Location A1', 'r2b-a1', null, 'UTC'), ('${SA2}', 'R2B Location A2', 'r2b-a2', null, 'UTC'), ('${SB1}', 'R2B Location B1', 'r2b-b1', null, 'UTC'),
  ('${SC1}', 'R2B Location C1', 'r2b-c1', null, 'UTC'), ('${SD1}', 'R2B Location D1', 'r2b-d1', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${SA1}', 'studio_owner', true), ('${U.owner_a}', '${SA2}', 'studio_owner', true), ('${U.owner_a}', '${SD1}', 'studio_owner', true), ('${U.owner_a}', '${SC1}', 'studio_owner', true),
  ('${U.owner_b}', '${SB1}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'R2B Alpha LLC', '9881', 50000, '${U.padmin}'), ('${EB}', 'R2B Beta LLC', '9882', 50000, '${U.padmin}'),
  ('${EC}', 'ConfiDance Unlimited, LLC', '9883', 15000, '${U.padmin}'), ('${ED}', 'R2B Delta LLC', '9884', 50000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${SA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 1', now()),
  ('${SA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 2', now()),
  ('${SB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B', now()),
  ('${SC1}', '${EC}', 'founding', '${U.padmin}', 'fixture: verified business C', now()),
  ('${SD1}', '${ED}', 'founding', '${U.padmin}', 'fixture: verified business D', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${EA}', '${ACC.A}', 'df:test:${EA}', 'test', 'active', '${U.padmin}'), ('${EB}', '${ACC.B}', 'df:test:${EB}', 'test', 'active', '${U.padmin}'),
  ('${EC}', '${ACC.C}', 'df:test:${EC}', 'test', 'active', '${U.padmin}'), ('${ED}', '${ACC.D}', 'df:test:${ED}', 'test', 'active', '${U.padmin}');
insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) select s, true, 'fixture: number tests', '${U.padmin}' from unnest(array[${STUDIOS}]::uuid[]) s;
commit;
begin;
set local session_replication_role = replica;
insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at) values
  ${onboardingRow(OA1, SA1, "9881", "R2B Alpha LLC")}, ${onboardingRow(OA2, SA2, "9881", "R2B Alpha LLC")}, ${onboardingRow(OB1, SB1, "9882", "R2B Beta LLC")},
  ${onboardingRow(OC1, SC1, "9883", "ConfiDance Unlimited, LLC")}, ${onboardingRow(OD1, SD1, "9884", "R2B Delta LLC")};
${ledgerSql(OA1, SA1, EA, ACC.A, MG.A1, QE.A1, BRAND.A1)}
${ledgerSql(OA2, SA2, EA, ACC.A, MG.A2, QE.A2, BRAND.A2)}
${ledgerSql(OB1, SB1, EB, ACC.B, MG.B1, QE.B1, BRAND.B1)}
${ledgerSql(OC1, SC1, EC, ACC.C, MG.C1, QE.C1, BRAND.C1)}
${ledgerSql(OD1, SD1, ED, ACC.D, MG.D1, QE.D1, BRAND.D1)}
commit;`;

describe.skipIf(!enabled)("TW-4F R2b: number provisioning and sender activation (real schema, fake provider)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let store: SupabaseNumberStore;
  let snapshotActivePrices: string[] = [];
  const hub = new FakeNumberHub();
  let n = 0;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const ref = (label: string) => `Owner email ${RUN} ${label} approving one fee`;
  const authorize = (entity: string, studio: string, kind: string, cents: number, approvalRef: string, funding: "credit" | "pilot" = "credit") =>
    rpc("tw4_spend_authorize", { p_entity_id: entity, p_kind: kind, p_amount_cents: cents, p_approval_ref: approvalRef, p_actor: U.padmin, p_funding: funding, p_studio_id: studio });
  const fund = async (entity: string, studio: string, pack: number) => {
    n += 1;
    const pref = `cs_r2b_${RUN}_${n}`;
    await credits.topupPending(entity, studio, pref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(entity, studio, pref, pack, `evt_r2b_${RUN}_${n}`, `pi_r2b_${RUN}_${n}`, true);
  };
  const recurring = (studio: string, user: string, kind: string, price: number, months = 3) =>
    rpc("tw4_recurring_authorize", { p_studio_id: studio, p_user_id: user, p_kind: kind, p_acknowledged_price_cents: price, p_term_months: months, p_total_limit_cents: null });
  const window = async (studio: string) => expect((await rpc("tw4_runner_set_window", { p_studio_id: studio, p_actor: U.padmin, p_hours: 2, p_reason: "fixture: number window" })).error).toBeNull();
  const adapterOf = (account: string) => hub.adapterFor(account);
  const run = async (studio: string, adapter: FakeNumberAdapter, over: { confirmFee?: boolean } = {}) => {
    const result = await runNumberAcquisition({ store, adapter, studioId: studio, actorId: U.padmin, envName: "test", confirmFee: over.confirmFee ?? true });
    if (process.env.R2B_DEBUG) console.log("run", studio.slice(-2), JSON.stringify(result));
    return result;
  };
  const offer = async (studio: string, adapter: FakeNumberAdapter) => {
    const result = await offerNumbers({ store, adapter, studioId: studio, actorId: U.padmin });
    if (process.env.R2B_DEBUG) console.log("offer", studio.slice(-2), JSON.stringify(result));
    return result;
  };
  /** A client signed in AS that user (an authenticated session): the only way an owner approval is made. */
  const asUser = (id: string) => mkClient(sign({ role: "authenticated", sub: id, aud: "authenticated", exp: 1983812996 }));
  const select = (studio: string, user: string, offerId: string, e164: string, price = PRICE.number, approvalRef?: string) =>
    user === U.padmin || approvalRef !== undefined
      ? rpc("tw4_num_select", { p_studio_id: studio, p_actor: user, p_offer_id: offerId, p_e164: e164, p_ack_price_cents: price, p_approval_ref: approvalRef ?? null })
      : (asUser(user).rpc("tw4_num_select_as_owner", { p_studio_id: studio, p_offer_id: offerId, p_e164: e164, p_ack_price_cents: price }) as unknown as ReturnType<typeof rpc>);
  const withdraw = (studio: string, user: string, selectionId: string, note: string) =>
    user === U.padmin
      ? rpc("tw4_num_withdraw", { p_studio_id: studio, p_actor: user, p_selection_id: selectionId, p_note: note })
      : (asUser(user).rpc("tw4_num_withdraw_as_owner", { p_studio_id: studio, p_selection_id: selectionId, p_note: note }) as unknown as ReturnType<typeof rpc>);
  const basis = async (studio: string) => (await rpc("tw4_num_rent_basis", { p_studio_id: studio })).data as { live: boolean; reason: string };
  /** offer + owner selection in one go (returns the selection id) */
  const choose = async (studio: string, user: string, adapter: FakeNumberAdapter, e164: string) => {
    const o = await offer(studio, adapter);
    expect(o.outcome).toBe("offered");
    const sel = await select(studio, user, o.offer!.offerId, e164);
    expect(sel.error, `select ${e164}`).toBeNull();
    return (sel.data as { selection_id: string }).selection_id;
  };
  const state = (studio: string) => psql(`select state from public.studio_sms_onboarding where studio_id = '${studio}'`);
  const step = (studio: string) => psql(`select coalesce(step, '') from public.studio_sms_onboarding where studio_id = '${studio}'`);
  const code = (studio: string) => psql(`select coalesce(last_error_code, '') from public.studio_sms_onboarding where studio_id = '${studio}'`);
  const ops = (studio: string, kind: string) => psql(`select string_agg(attempt || ':' || status || ':' || (superseded_at is not null), ',' order by attempt) from public.studio_sms_num_operations where studio_id = '${studio}' and op_kind = '${kind}'`);
  const opId = (studio: string, kind: string, attempt = 1) => psql(`select id from public.studio_sms_num_operations where studio_id = '${studio}' and op_kind = '${kind}' and attempt = ${attempt}`);
  const selStatus = (id: string) => psql(`select status from public.studio_sms_number_selections where id = '${id}'`);
  const reserved = (entity: string) => Number(psql(`select coalesce((select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 0)`));
  const reservations = (entity: string, kind: string) => psql(`select string_agg(status || ':' || amount_cents || ':' || funding, ',' order by created_at) from public.studio_sms_credit_reservations where legal_entity_id = '${entity}' and kind = '${kind}'`);
  const noRunnerWork = (a: FakeNumberAdapter) => expect(a.count("purchaseNumber") + a.count("attachNumber")).toBe(0);

  beforeAll(async () => {
    expect(psql(`select to_regclass('public.studio_sms_num_operations') is not null`)).toBe("t");
    psqlFile(FIXTURES);
    admin = mkClient(serviceKey());
    credits = new SupabaseCreditStore(admin);
    store = new SupabaseNumberStore(admin);
    // PostgREST reloads its schema cache after DDL: wait until the newest function answers before the first test
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const probe = await admin.rpc("tw4_num_rent_basis", { p_studio_id: SA1 });
      if (!probe.error) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // PostgREST reloads its schema cache after DDL: wait until it answers with a real error code (or success) before the first test
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const probe = await admin.rpc("tw4_num_status", { p_studio_id: SA1, p_actor: U.padmin });
      if (!probe.error || probe.error.code) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    for (const [kind, customer, provider] of [["number", PRICE.number, 115], ["monthly", PRICE.monthly, 1000], ["campaign_vetting", PRICE.vetting, 1500]] as const) {
      expect((await rpc("tw4_price_set", { p_kind: kind, p_customer_cents: customer, p_provider_cents: provider, p_description: `fixture ${kind}`, p_actor: U.padmin })).error).toBeNull();
    }
    for (const s of [SA1, SA2, SB1, SC1, SD1]) await window(s);
    // the provider's world: numbers a search can return, and the (already verified) services and campaigns of each subaccount
    const a = adapterOf(ACC.A);
    for (const e of [NUM.a1, NUM.a1b, NUM.a1c, NUM.a2, NUM.b1, NUM.c1, NUM.c2, NUM.d1, NUM.d2, NUM.d3]) a.seedAvailable(e);
    a.seedAvailable(NUM.addr, { address_requirements: "local" });
    a.seedAvailable(NUM.nosms, { sms_capable: false });
    const accounts: [string, string, string][] = [[ACC.A, MG.A1, QE.A1], [ACC.A, MG.A2, QE.A2], [ACC.B, MG.B1, QE.B1], [ACC.C, MG.C1, QE.C1], [ACC.D, MG.D1, QE.D1]];
    for (const [acc, mg, qe] of accounts) {
      adapterOf(acc).registerService(mg, { inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
      adapterOf(acc).registerCampaign(qe, { messaging_service_sid: mg });
    }
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

  it("privileges: the evidence tables are unreachable by API roles; actions are service-role only; helpers are callable by no API role", () => {
    const tables = ["studio_sms_number_offers", "studio_sms_number_selections", "studio_sms_num_operations", "studio_sms_num_resources", "studio_sms_optout_attestations", "studio_sms_compliance_checks"];
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of tables) expect(psql(`select has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete')`), `${role} ${table}`).toBe("f");
    }
    const fns = ["tw4_num_offer_record(uuid, uuid, text, jsonb, jsonb, text, text)", "tw4_num_select(uuid, uuid, uuid, text, integer, text)", "tw4_num_withdraw(uuid, uuid, uuid, text)",
      "tw4_num_claim(uuid, uuid, text, integer, text)", "tw4_num_context(uuid, text)", "tw4_num_begin(uuid, text, text, text, text, jsonb, uuid)", "tw4_num_finish(uuid, text, uuid, text, text, text, text)",
      "tw4_num_observe(uuid, text, uuid, jsonb, text, text)", "tw4_num_resolve(uuid, uuid, text, text, text)", "tw4_num_settle_admin(uuid, uuid, text, text)", "tw4_num_reopen(uuid, uuid, text)",
      "tw4_num_retire(uuid, uuid, text)", "tw4_num_record_sender(uuid, uuid)", "tw4_num_status(uuid, uuid)", "tw4_act_attest(uuid, uuid, jsonb, text)",
      "tw4_act_compliance_record(uuid, uuid, jsonb, text, text, text)", "tw4_act_verify_sender(uuid, uuid, uuid, jsonb, text)", "tw4_act_check(uuid, uuid)", "tw4_act_mark_ready(uuid, uuid, text)",
      "tw4_act_activate(uuid, uuid, text)", "tw4_act_suspend(uuid, uuid, text)", "tw4_act_exposure(uuid)"];
    for (const fn of fns) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    for (const fn of ["_tw4num_account(uuid)", "_tw4num_service(uuid)", "_tw4num_campaign(uuid)", "_tw4num_price(text)", "_tw4num_taken(text, uuid)", "_tw4num_requirements(uuid)",
      "_tw4num_reserve(public.studio_sms_onboarding, uuid, integer)", "_tw4num_settle_if_held(uuid, text, text)", "_tw4act_items(uuid)", "_tw4act_funding(uuid)", "_tw4act_require(uuid)", "_tw4num_guard()"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("f");
    }
  });

  describe("search and owner approval (nothing is bought)", () => {
    it("a search is free: the database re-filters it (address-required, non-SMS and unknown shapes never become choices) and nothing is reserved or bought", async () => {
      const a = adapterOf(ACC.A);
      const result = await offer(SA1, a);
      expect(result.outcome).toBe("offered");
      const offered = result.offer!.candidates.map((c) => c.e164);
      expect(offered).toContain(NUM.a1);
      expect(offered).not.toContain(NUM.addr);
      expect(offered).not.toContain(NUM.nosms);
      noRunnerWork(a);
      expect(reserved(EA)).toBe(0);
      expect(psql(`select count(*) from public.studio_sms_num_operations where studio_id = '${SA1}'`)).toBe("0");
      // a tampered provider answer cannot add choices the database does not accept
      const rogue = await rpc("tw4_num_offer_record", { p_studio_id: SA1, p_actor: U.padmin, p_account_sid: ACC.A, p_search: {}, p_source: "fake", p_digest: hex("e"),
        p_candidates: [{ e164: "+10005550100", sms_capable: true, address_requirements: "none" }, { e164: "12025550199", sms_capable: true }, { e164: NUM.addr, sms_capable: true, address_requirements: "local" }] });
      expect(rogue.error?.code).toBe("TW043");
    });

    it("a search that ran in another business's subaccount is refused; the offer cannot cross tenants", async () => {
      const b = adapterOf(ACC.B);
      b.seedAvailable(NUM.b1);
      const wrong = await offerNumbers({ store, adapter: b, studioId: SA1, actorId: U.padmin });
      expect(wrong.outcome).toBe("account_mismatch");
      // business B's studio cannot use business A's offer
      const o = await offer(SA1, adapterOf(ACC.A));
      const crossed = await select(SB1, U.owner_b, o.offer!.offerId, NUM.a1);
      expect(crossed.error?.code).toBe("22023");
    });

    it("searches are rate limited per location", async () => {
      aged(`insert into public.studio_sms_number_offers (studio_id, legal_entity_id, twilio_account_sid, candidates, source, evidence_digest, requested_by, expires_at)
             select '${SD1}', '${ED}', '${ACC.D}', '[{"e164":"${NUM.d1}"}]'::jsonb, 'fake', '${hex("f")}', '${U.padmin}', now() + interval '30 minutes' from generate_series(1, 20)`);
      const limited = await offerNumbers({ store, adapter: adapterOf(ACC.D), studioId: SD1, actorId: U.padmin });
      expect(limited.outcome).toBe("exception");
      expect(limited.detail).toContain("54000");
      aged(`delete from public.studio_sms_number_offers where studio_id = '${SD1}'`);
    });

    it("only the studio owner (or an admin recording the owner's written approval) can choose; the price must be the published price; the offer expires", async () => {
      const o = await offer(SA1, adapterOf(ACC.A));
      expect((await select(SA1, U.stranger, o.offer!.offerId, NUM.a1)).error?.code).toBe("42501");
      // a service-role call that only NAMES the owner (no session) is a forged owner approval, with or without a reference: refused
      for (const approvalRef of [null, "Owner email says yes to this number"]) {
        expect((await rpc("tw4_num_select", { p_studio_id: SA1, p_actor: U.owner_a, p_offer_id: o.offer!.offerId, p_e164: NUM.a1, p_ack_price_cents: PRICE.number, p_approval_ref: approvalRef })).error?.code).toBe("42501");
      }
      expect(psql(`select count(*) from public.studio_sms_number_selections where studio_id = '${SA1}'`)).toBe("0");
      expect((await select(SA1, U.owner_b, o.offer!.offerId, NUM.a1)).error?.code).toBe("42501"); // another business's owner
      expect((await select(SA1, U.owner_a, o.offer!.offerId, NUM.a1, PRICE.number + 1)).error?.code).toBe("TW008");
      expect((await select(SA1, U.owner_a, o.offer!.offerId, NUM.addr)).error?.code).toBe("22023"); // not in the offer
      expect((await select(SA1, U.padmin, o.offer!.offerId, NUM.a1)).error?.code).toBe("22023"); // an admin must name the owner's written approval
      expect((await select(SA1, U.padmin, o.offer!.offerId, NUM.a1, PRICE.number, "short")).error?.code).toBe("22023");
      aged(`update public.studio_sms_number_offers set expires_at = now() - interval '1 minute' where id = '${o.offer!.offerId}'`);
      expect((await select(SA1, U.owner_a, o.offer!.offerId, NUM.a1)).error?.code).toBe("TW040");
      expect(psql(`select count(*) from public.studio_sms_number_selections where studio_id = '${SA1}'`)).toBe("0");
    });

    it("an approval states the number, the recurring monthly cost and the funding, lives 24 hours, and there is one open approval per location", async () => {
      const a = adapterOf(ACC.A);
      const o = await offer(SA1, a);
      const first = await select(SA1, U.owner_a, o.offer!.offerId, NUM.a1b);
      expect(first.error).toBeNull();
      const row = first.data as { statement: string; price_cents: number; funding_mode: string; selection_id: string };
      expect(row.price_cents).toBe(PRICE.number);
      expect(row.funding_mode).toBe("credit_recurring");
      expect(row.statement).toContain(NUM.a1b);
      expect(row.statement).toContain("$2.00");
      expect(row.statement).toContain("recurring");
      expect(Number(psql(`select extract(epoch from (expires_at - approved_at)) from public.studio_sms_number_selections where id = '${row.selection_id}'`))).toBeGreaterThan(86_000);
      // a second open approval is refused; the same number cannot be approved twice
      const second = await select(SA1, U.owner_a, o.offer!.offerId, NUM.a1);
      expect(second.error?.code).toBe("23505");
      expect((await withdraw(SA1, U.stranger, row.selection_id, "nope")).error?.code).toBe("42501");
      // a service-role call that merely NAMES the owner is a forged approval: refused (the owner path trusts no parameter)
      expect((await rpc("tw4_num_withdraw", { p_studio_id: SA1, p_actor: U.owner_a, p_selection_id: row.selection_id, p_note: "forged" })).error?.code).toBe("42501");
      expect((await withdraw(SA1, U.owner_a, row.selection_id, "changed my mind")).error).toBeNull();
      expect(selStatus(row.selection_id)).toBe("withdrawn");
      // an approval is never edited (history is fixed)
      expect(psqlError(`update public.studio_sms_number_selections set e164 = '${NUM.a1}' where id = '${row.selection_id}'`)).toContain("never edited");
    });

    it("two locations choosing the same number at once: exactly one approval exists", async () => {
      const a = adapterOf(ACC.A);
      const o1 = await offer(SA1, a);
      const o2 = await offer(SA2, a);
      const results = await Promise.all([select(SA1, U.owner_a, o1.offer!.offerId, NUM.a2), select(SA2, U.owner_a, o2.offer!.offerId, NUM.a2)]);
      expect(results.filter((r) => !r.error).length).toBe(1);
      expect(results.filter((r) => r.error?.code === "23505").length).toBe(1);
      const winner = psql(`select studio_id from public.studio_sms_number_selections where e164 = '${NUM.a2}' and status = 'approved'`);
      expect([SA1, SA2]).toContain(winner);
      const sel = psql(`select id from public.studio_sms_number_selections where e164 = '${NUM.a2}' and status = 'approved'`);
      expect((await rpc("tw4_num_withdraw", { p_studio_id: winner, p_actor: U.padmin, p_selection_id: sel, p_note: "fixture cleanup" })).error).toBeNull();
    });
  });

  describe("an admin recording the owner's written approval", () => {
    it("needs a reference to that approval, used once in the fee-approval namespace; the approver is recorded as the admin acting for the owner", async () => {
      const a = adapterOf(ACC.A);
      const o = await offer(SA2, a);
      const written = "Owner email 2026-10-21 approves number a2 for location 2";
      const first = await select(SA2, U.padmin, o.offer!.offerId, NUM.a2, PRICE.number, written);
      expect(first.error).toBeNull();
      expect(psql(`select approver_role || '|' || approver_user from public.studio_sms_number_selections where studio_id = '${SA2}' and status = 'approved'`)).toBe(`platform_admin_recorded|${U.padmin}`);
      expect(psql(`select actor_type from public.studio_sms_onboarding_audit where studio_id = '${SA2}' and action = 'num_selected'`)).toBe("platform_admin");
      const id = (first.data as { selection_id: string }).selection_id;
      expect((await withdraw(SA2, U.padmin, id, "fixture cleanup")).error).toBeNull();
      // the same written approval cannot approve another operation, whatever its spelling
      const o2 = await offer(SA2, a);
      expect((await select(SA2, U.padmin, o2.offer!.offerId, NUM.a2, PRICE.number, "  OWNER email 2026-10-21 approves  number a2 for location 2 ")).error?.code).toBe("23505");
      // an owner's own approval is attributed to the owner (user), not to an admin
      const owner = await select(SA2, U.owner_a, o2.offer!.offerId, NUM.a2);
      expect(owner.error).toBeNull();
      expect(psql(`select actor_type from public.studio_sms_onboarding_audit where studio_id = '${SA2}' and action = 'num_selected' order by created_at desc limit 1`)).toBe("user");
      expect((await withdraw(SA2, U.owner_a, (owner.data as { selection_id: string }).selection_id, "fixture cleanup")).error).toBeNull();
    });
  });

  describe("purchase gate: credit-funded business A", () => {
    it("fund the business and approve one number (setup)", async () => {
      expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: EA, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly limit" })).error).toBeNull();
      await fund(EA, SA1, 5_000);
      await fund(EA, SA1, 5_000);
      const id = await choose(SA1, U.owner_a, adapterOf(ACC.A), NUM.a1);
      expect(selStatus(id)).toBe("approved");
    });

    it("without the admin's confirmation, or with no recurring authorization, nothing is reserved and nothing is called", async () => {
      const a = adapterOf(ACC.A);
      expect((await run(SA1, a, { confirmFee: false })).outcome).toBe("recurring_missing"); // the database's blocker comes first
      expect(ops(SA1, "number_purchase")).toBeFalsy();
      noRunnerWork(a);
      expect(a.count("searchAvailableNumbers") + a.count("findOwnedNumbers")).toBeGreaterThan(0); // the offers searched; the purchase path looked at nothing
      expect(a.count("findOwnedNumbers")).toBe(0);
    });

    it("an authorization that is too short or revoked does not fund the number; the owner's authorization does", async () => {
      const a = adapterOf(ACC.A);
      // one month: less than the 28-day cover the start requires
      const shortAuth = await recurring(SA1, U.owner_a, "number", PRICE.number, 1);
      expect(shortAuth.error).toBeNull();
      expect((await run(SA1, a)).outcome).toBe("recurring_missing");
      const shortId = (shortAuth.data as { authorization_id: string }).authorization_id;
      aged(`update public.studio_sms_recurring_authorizations set expires_at = now() + interval '20 days' where id = '${shortId}'`);
      expect((await run(SA1, a)).outcome).toBe("recurring_missing");
      expect((await rpc("tw4_recurring_revoke", { p_authorization_id: shortId, p_user_id: U.owner_a })).error).toBeNull();
      const good = await recurring(SA1, U.owner_a, "number", PRICE.number, 3);
      expect(good.error).toBeNull();
      noRunnerWork(a);
      // revoked between approval and the run: refused again
      const goodId = (good.data as { authorization_id: string }).authorization_id;
      expect((await rpc("tw4_recurring_revoke", { p_authorization_id: goodId, p_user_id: U.owner_a })).error).toBeNull();
      expect((await run(SA1, a)).outcome).toBe("recurring_missing");
      noRunnerWork(a);
      expect((await recurring(SA1, U.owner_a, "number", PRICE.number, 3)).error).toBeNull();
    });

    it("a credit account on hold, a price that changed since the approval, and an expired approval each stop the purchase before any provider call", async () => {
      const a = adapterOf(ACC.A);
      expect((await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: hold", p_actor: U.padmin })).error).toBeNull();
      expect((await run(SA1, a)).outcome).toBe("insufficient_credit");
      expect((await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: false, p_reason: "fixture: release", p_actor: U.padmin })).error).toBeNull();
      noRunnerWork(a);
      // the first month's set-aside is gone (released) and nothing was charged for this month: the rent is not funded, whatever the authorization says
      const commit = psql(`select commitment_reservation_id from public.studio_sms_recurring_authorizations where studio_id = '${SA1}' and kind = 'number' and status = 'active'`);
      aged(`update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = '${commit}'`);
      expect((await run(SA1, a)).outcome).toBe("insufficient_credit");
      noRunnerWork(a);
      aged(`update public.studio_sms_credit_reservations set status = 'reserved', closed_at = null where id = '${commit}'`);
      // the published price moved: the approval was for the old price
      expect((await rpc("tw4_price_set", { p_kind: "number", p_customer_cents: PRICE.number + 50, p_provider_cents: 115, p_description: "fixture: price moved", p_actor: U.padmin })).error).toBeNull();
      expect((await run(SA1, a)).outcome).toBe("price_unavailable");
      expect((await rpc("tw4_price_set", { p_kind: "number", p_customer_cents: PRICE.number, p_provider_cents: 115, p_description: "fixture: price restored", p_actor: U.padmin })).error).toBeNull();
      // an expired approval
      const selId = psql(`select id from public.studio_sms_number_selections where studio_id = '${SA1}' and status = 'approved'`);
      aged(`update public.studio_sms_number_selections set expires_at = now() - interval '1 minute' where id = '${selId}'`);
      expect((await run(SA1, a)).outcome).toBe("no_selection");
      noRunnerWork(a);
      aged(`update public.studio_sms_number_selections set expires_at = now() + interval '23 hours' where id = '${selId}'`);
    });

    it("the purchase: recorded before the call, owned only after a provider read, the approval consumed, no second charge posted; a replay buys nothing", async () => {
      const a = adapterOf(ACC.A);
      const before = reserved(EA);
      const result = await run(SA1, a);
      expect(result.outcome).toBe("number_ready");
      expect(a.count("purchaseNumber")).toBe(1);
      expect(a.count("attachNumber")).toBe(1);
      expect(ops(SA1, "number_purchase")).toBe("1:succeeded:false");
      expect(ops(SA1, "number_attach")).toBe("1:succeeded:false");
      expect(psql(`select r.status || '|' || r.source || '|' || r.twilio_account_sid from public.studio_sms_num_resources r where r.operation_id = '${opId(SA1, "number_purchase")}'`)).toBe(`owned|fake|${ACC.A}`);
      expect(psql(`select r.status from public.studio_sms_num_resources r where r.operation_id = '${opId(SA1, "number_attach")}'`)).toBe("attached");
      expect(psql(`select status from public.studio_sms_number_selections where studio_id = '${SA1}' and e164 = '${NUM.a1}'`)).toBe("consumed");
      // the rent is the recurring authorization's: R2b posts no second reservation or charge
      expect(reserved(EA)).toBe(before);
      expect(psql(`select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EA}' and reservation_key like 'prov:%'`)).toBe("0");
      expect(step(SA1)).toBe("N3");
      expect(state(SA1)).toBe("campaign_pending");
      // the contract the recurring-fee lifecycle asks before it charges number rent: a purchase confirmed by the provider, in the active subaccount, not retired
      expect(await basis(SA1)).toMatchObject({ live: true, reason: "ok", pilot: false });
      expect(await basis(SB1)).toMatchObject({ live: false, reason: "no_live_purchase", managed: false });
      expect(await basis(SA1)).toMatchObject({ managed: true });
      const again = await run(SA1, a);
      expect(again.outcome).toBe("number_ready");
      expect(a.count("purchaseNumber")).toBe(1);
      expect(a.count("attachNumber")).toBe(1);
      const refreshed = await refreshNumber({ store, adapter: a, studioId: SA1, actorId: U.padmin, envName: "test" });
      expect(refreshed.outcome).toBe("number_ready");
      expect(a.count("purchaseNumber")).toBe(1);
    });

    it("a second purchase for a location that already has a number is refused until the number is released (PR #249's rule), and the ledger lets it buy another afterwards", async () => {
      const a = adapterOf(ACC.A);
      const sender = await recordSenderFromLedger(admin, SA1, U.padmin);
      expect(sender.ok).toBe(true);
      const o = await offer(SA1, a);
      // the approval itself is refused while the current number is unreleased
      expect((await select(SA1, U.owner_a, o.offer!.offerId, NUM.a1c)).error?.code).toBe("TW022");
      // a replacement needs the sender row released AND the ledger retired by an admin who confirms the provider release
      expect((await rpc("tw4_num_retire", { p_studio_id: SA1, p_actor: U.padmin, p_note: "released at the provider console (fixture)" })).error?.code).toBe("TW022");
      const senderId = (sender.ok ? sender.data.sender_id : "") as string;
      expect(senderId).toBeTruthy();
      expect((await rpc("tw4_sender_revoke", { p_studio_id: SA1, p_actor: U.padmin, p_reason: "fixture: location released its number", p_release: true })).error).toBeNull();
      expect((await rpc("tw4_num_retire", { p_studio_id: SA1, p_actor: U.padmin, p_note: "released at the provider console (fixture)" })).error).toBeNull();
      expect(ops(SA1, "number_purchase")).toBe("1:succeeded:true");
      expect(await basis(SA1)).toMatchObject({ live: false, reason: "no_live_purchase" });
      // the old number stays in the sender history; a fresh approval of ANOTHER number works again and the old number cannot be re-approved by someone else while still owned
      const o2 = await offer(SA1, a);
      const sel = await select(SA1, U.owner_a, o2.offer!.offerId, NUM.a1c);
      expect(sel.error).toBeNull();
      expect((await withdraw(SA1, U.owner_a, (sel.data as { selection_id: string }).selection_id, "fixture cleanup")).error).toBeNull();
    });
  });

  describe("provider ambiguity and refusals (business D)", () => {
    it("fund business D and authorize its number rent (setup)", async () => {
      expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: ED, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly limit" })).error).toBeNull();
      await fund(ED, SD1, 5_000);
      await fund(ED, SD1, 5_000);
      expect((await recurring(SD1, U.owner_a, "number", PRICE.number)).error).toBeNull();
    });

    it("a lost response on the purchase is reconciled by lookup: the number is adopted, never bought twice", async () => {
      const d = adapterOf(ACC.D);
      await choose(SD1, U.owner_a, d, NUM.d1);
      d.failNext("purchaseNumber", { kind: "transient", lostResponse: true });
      const first = await run(SD1, d);
      expect(first.outcome).toBe("retry_later");
      expect(ops(SD1, "number_purchase")).toBe("1:unknown_outcome:false");
      expect(psql(`select count(*) from public.studio_sms_num_resources where studio_id = '${SD1}'`)).toBe("0");
      const second = await run(SD1, d);
      expect(second.outcome).toBe("number_ready");
      expect(d.count("purchaseNumber")).toBe(1);
      expect(ops(SD1, "number_purchase")).toBe("1:succeeded:false");
    });

    it("an unclear purchase whose number then cannot be found stays an unknown outcome and is never repeated; only an admin can settle it, after 20 minutes, with a reason", async () => {
      const d = adapterOf(ACC.D);
      // free the location for a second purchase: record + release the sender, retire the ledger (fixture path)
      expect((await recordSenderFromLedger(admin, SD1, U.padmin)).ok).toBe(true);
      expect((await rpc("tw4_sender_revoke", { p_studio_id: SD1, p_actor: U.padmin, p_reason: "fixture: released", p_release: true })).error).toBeNull();
      expect((await rpc("tw4_num_retire", { p_studio_id: SD1, p_actor: U.padmin, p_note: "released at the provider console (fixture)" })).error).toBeNull();
      await choose(SD1, U.owner_a, d, NUM.d2);
      // the request succeeds inside "Twilio" and then the number VANISHES from the lookup (an admin removed it, or the provider lists lag): nothing can prove it was not bought
      d.failNext("purchaseNumber", { kind: "transient", lostResponse: true });
      expect((await run(SD1, d)).outcome).toBe("retry_later");
      const bought = [...d.universe.owned.values()].find((row) => row.phone_number === NUM.d2)!;
      d.universe.owned.delete(bought.sid);
      const before = d.count("purchaseNumber");
      for (let i = 0; i < 3; i += 1) expect((await run(SD1, d)).outcome).toBe("unknown_outcome");
      expect(d.count("purchaseNumber")).toBe(before);
      expect(ops(SD1, "number_purchase")).toMatch(/2:unknown_outcome:false$/);
      // the database refuses to close a fee operation as failed on its own say-so, and an admin may not declare "not created" within 20 minutes
      const op = opId(SD1, "number_purchase", 2);
      expect((await rpc("tw4_num_finish", { p_onboarding_id: OD1, p_lease_owner: "x", p_operation_id: op, p_status: "failed", p_provider_sid: null, p_error_code: "reconciled_absent", p_error_detail: null })).error?.code).toBe("55P03");
      expect((await rpc("tw4_num_resolve", { p_operation_id: op, p_actor: U.padmin, p_resolution: "not_created", p_provider_sid: null, p_note: "checked the console, no such number" })).error?.code).toBe("22023");
      aged(`update public.studio_sms_num_operations set started_at = now() - interval '30 minutes' where id = '${op}'`);
      expect((await rpc("tw4_num_resolve", { p_operation_id: op, p_actor: U.padmin, p_resolution: "not_created", p_provider_sid: null, p_note: "short" })).error?.code).toBe("22023");
      const selId = psql(`select selection_id from public.studio_sms_num_operations where id = '${op}'`);
      expect(selStatus(selId)).toBe("consumed");
      expect((await rpc("tw4_num_resolve", { p_operation_id: op, p_actor: U.padmin, p_resolution: "not_created", p_provider_sid: null, p_note: "checked the console: no such number" })).error).toBeNull();
      expect(ops(SD1, "number_purchase")).toMatch(/2:abandoned:false$/);
      // the abandoned attempt frees the number for a NEW approval (the consumed approval itself is never reused)
      expect(selStatus(selId)).toBe("withdrawn");
      expect((await select(SD1, U.owner_a, (await offer(SD1, d)).offer!.offerId, NUM.d2)).error).toBeNull();
    });

    it("a number the subaccount already owns that the ledger never recorded is NOT adopted: a human decides, nothing is bought, nothing is spent", async () => {
      const d = adapterOf(ACC.D);
      d.seedOwned(NUM.d2);
      const before = d.count("purchaseNumber");
      const result = await run(SD1, d);
      expect(result.outcome).toBe("exception");
      // the inventory reconciliation stops it BEFORE anything is recorded or bought
      expect(result.detail).toContain("inventory_unrecorded");
      expect(d.count("purchaseNumber")).toBe(before);
      expect(code(SD1)).toBe("num_inventory_unknown");
      expect(ops(SD1, "number_purchase")).toMatch(/^1:succeeded:true,2:abandoned:false$/);
      expect(psql(`select count(*) from public.studio_sms_num_operations where studio_id = '${SD1}' and op_kind = 'number_purchase' and attempt = 3`)).toBe("0");
      // a number-step exception is reopened by an admin with a reason; nothing else moves it
      expect((await rpc("tw4_num_reopen", { p_studio_id: SD1, p_actor: U.padmin, p_reason: "short" })).error?.code).toBe("22023");
      expect((await rpc("tw4_num_reopen", { p_studio_id: SD1, p_actor: U.stranger, p_reason: "the number was reviewed by a person" })).error?.code).toBe("42501");
      expect((await rpc("tw4_num_reopen", { p_studio_id: SD1, p_actor: U.padmin, p_reason: "the number was reviewed by a person" })).error).toBeNull();
      expect(state(SD1)).toBe("campaign_pending");
      // an admin acknowledges the foreign number (nothing is bought, released or charged by that): the inventory no longer blocks, and the per-number lookup still refuses to adopt it
      const foreign = [...d.universe.owned.values()].find((row) => row.phone_number === NUM.d2)!;
      expect((await rpc("tw4_num_inventory_ack", { p_studio_id: SD1, p_actor: U.stranger, p_phone_number_sid: foreign.sid, p_e164: NUM.d2, p_note: "bought by hand before the system" })).error?.code).toBe("42501");
      expect((await rpc("tw4_num_inventory_ack", { p_studio_id: SD1, p_actor: U.padmin, p_phone_number_sid: foreign.sid, p_e164: NUM.d2, p_note: "short" })).error?.code).toBe("22023");
      expect((await rpc("tw4_num_inventory_ack", { p_studio_id: SD1, p_actor: U.padmin, p_phone_number_sid: foreign.sid, p_e164: NUM.d2, p_note: "bought by hand before the system" })).error).toBeNull();
      const second = await run(SD1, d);
      expect(second.detail).toContain("exists_unrecorded");
      expect(d.count("purchaseNumber")).toBe(before);
      expect((await rpc("tw4_num_reopen", { p_studio_id: SD1, p_actor: U.padmin, p_reason: "the number was reviewed by a person again" })).error).toBeNull();
    });

    it("a definite provider refusal closes the attempt, consumes the approval for good (a retry needs a NEW approval) and leaves no reservation", async () => {
      const d = adapterOf(ACC.D);
      // make room: the colliding owned number is gone, the earlier approval is withdrawn
      const open = psql(`select id from public.studio_sms_number_selections where studio_id = '${SD1}' and status = 'approved'`);
      expect((await withdraw(SD1, U.owner_a, open, "fixture")).error).toBeNull();
      const row = [...d.universe.owned.values()].find((r) => r.phone_number === NUM.d2)!;
      d.universe.owned.delete(row.sid);
      const selId = await choose(SD1, U.owner_a, d, NUM.d3);
      d.failNext("purchaseNumber", { kind: "validation", code: "21452" });
      const refused = await run(SD1, d);
      expect(refused.outcome).toBe("exception");
      expect(ops(SD1, "number_purchase")).toMatch(/3:failed:false$/);
      expect(selStatus(selId)).toBe("withdrawn");
      expect(code(SD1)).toBe("num_refused");
      expect((await rpc("tw4_num_reopen", { p_studio_id: SD1, p_actor: U.padmin, p_reason: "the refusal was reviewed by a person" })).error).toBeNull();
      const calls = d.count("purchaseNumber");
      expect((await run(SD1, d)).outcome).toBe("no_selection");
      expect(d.count("purchaseNumber")).toBe(calls);
      // a fresh approval works
      await choose(SD1, U.owner_a, d, NUM.d3);
      expect((await run(SD1, d)).outcome).toBe("number_ready");
      expect(d.count("purchaseNumber")).toBe(calls + 1);
    });
  });

  describe("duplicate purchases and tenant isolation", () => {
    it("two runners at once buy exactly once (the lease and the one-live-operation index); a number is bought once GLOBALLY", async () => {
      expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: EB, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly limit" })).error).toBeNull();
      await fund(EB, SB1, 5_000);
      await fund(EB, SB1, 5_000);
      expect((await recurring(SB1, U.owner_b, "number", PRICE.number)).error).toBeNull();
      const b = adapterOf(ACC.B);
      await choose(SB1, U.owner_b, b, NUM.b1);
      const results = await Promise.all([run(SB1, b), run(SB1, b)]);
      expect(b.count("purchaseNumber")).toBe(1);
      expect(results.every((r) => r.outcome === "number_ready" || r.outcome === "lease_busy")).toBe(true);
      expect(results.some((r) => r.outcome === "number_ready")).toBe(true);
      // the database refuses a second live purchase of the same number from anywhere, whatever the application does
      const err = psqlError(`set local session_replication_role = replica; insert into public.studio_sms_num_operations (onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status,
        selection_id, e164, friendly_name, request_digest, started_by, fee_bearing, fee_kinds)
        select '${OA2}', '${SA2}', '${EA}', '${ACC.A}', 'number_purchase', 1, 1, 'in_flight', s.id, '${NUM.b1}', 'dup', '${hex("1")}', '${U.padmin}', true, array['number']
          from public.studio_sms_number_selections s where s.e164 = '${NUM.b1}'`);
      expect(err).toMatch(/duplicate key value violates unique constraint "studio_sms_num_operations_(e164|selection)_once"/);
    });

    it("another business's adapter, a parent-like account and a stale token are refused before any call", async () => {
      const wrong = adapterOf(ACC.B);
      const before = wrong.calls.length;
      expect((await run(SA1, wrong)).outcome).toBe("account_mismatch");
      expect(wrong.calls.length).toBe(before);
      const parentLike = new FakeNumberAdapter(`AC${"9".repeat(32)}`);
      expect((await run(SA1, parentLike)).outcome).toBe("account_mismatch");
      expect(parentLike.calls).toHaveLength(0);
    });

    it("the Messaging Service, campaign and number a purchase attaches to must be the studio's own verified ones", async () => {
      // location A2 must never attach to business B's service: a forged attach request is refused by the ledger
      const lease = "r2b-forge";
      const claim = await store.claim(SA2, U.padmin, lease);
      const forged = await store.begin(claim.onboarding_id, lease, { kind: "number_attach", friendlyName: "forge", digest: hex("2"), params: { messaging_service_sid: MG.B1, phone_number_sid: sid("PN", "ab") }, actorId: U.padmin }).catch((error) => error);
      expect((forged as { code?: string }).code).toBe("TW032");
      await store.release(claim.onboarding_id, lease);
      expect(psql(`select count(*) from public.studio_sms_num_operations where studio_id = '${SA2}'`)).toBe("0");
    });
  });

  describe("suspension and the runner window", () => {
    it("a suspended or closed subaccount is not a funding or provider target: the search and the purchase stop; a closed window stops the runner", async () => {
      const d = adapterOf(ACC.D);
      aged(`update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = '${ED}'`);
      const search = await offerNumbers({ store, adapter: d, studioId: SD1, actorId: U.padmin });
      expect(search.outcome).toBe("account_mismatch");
      expect((await run(SD1, d)).outcome).toBe("needs_subaccount");
      aged(`update public.studio_sms_twilio_accounts set status = 'active' where legal_entity_id = '${ED}'`);
      aged(`delete from public.studio_sms_runner_windows where studio_id = '${SD1}'`);
      expect((await run(SD1, d)).outcome).toBe("runner_closed");
      await window(SD1);
    });

    it("an onboarding that is not at the number step (suspended or cancelled) is not runnable", async () => {
      const d = adapterOf(ACC.D);
      aged(`update public.studio_sms_onboarding set state = 'suspended' where studio_id = '${SD1}'`);
      expect((await run(SD1, d)).outcome).toBe("not_runnable");
      expect((await offerNumbers({ store, adapter: d, studioId: SD1, actorId: U.padmin })).outcome).toBe("not_runnable");
      aged(`update public.studio_sms_onboarding set state = 'campaign_pending' where studio_id = '${SD1}'`);
    });
  });

  describe("ConfiDance pilot business: the $150 setup ceiling and per-operation approvals", () => {
    it("every purchase needs its own written approval inside the cumulative ceiling; the ceiling is not credit; no standing authorization", async () => {
      const c = adapterOf(ACC.C);
      aged(`insert into public.studio_sms_recurring_authorizations (legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, expires_at, authorized_by, statement)
             values ('${EC}', '${SC1}', 'number', ${PRICE.number}, 3, ${PRICE.number * 3}, now() + interval '90 days', '${U.owner_a}', 'fixture: a standing authorization made before the pilot exception existed')`);
      expect((await rpc("tw4_pilot_exception_create", { p_entity_id: EC, p_ceiling_cents: 15_000, p_approval_ref: ref("pilot-founder"), p_actor: U.padmin })).error).toBeNull();
      await choose(SC1, U.owner_a, c, NUM.c1);
      // a standing authorization is refused for the pilot business
      expect((await run(SC1, c)).outcome).toBe("pilot_conflict");
      aged(`delete from public.studio_sms_recurring_authorizations where legal_entity_id = '${EC}'`);
      // no written, owner-approved number spend
      expect((await run(SC1, c)).outcome).toBe("spend_blocked");
      noRunnerWork(c);
      expect(reserved(EC)).toBe(0);
      expect((await authorize(EC, SC1, "number", PRICE.number, ref("pilot-number-1"), "pilot")).error).toBeNull();
      const bought = await run(SC1, c);
      expect(bought.outcome).toBe("number_ready");
      expect(c.count("purchaseNumber")).toBe(1);
      // captured only after the provider read confirmed ownership; the approval is spent
      expect(reservations(EC, "number")).toBe("captured:200:pilot");
      expect(psql(`select status from public.studio_sms_spend_events where approval_ref = $q$${ref("pilot-number-1")}$q$`)).toBe("reserved");
      expect((await authorize(EC, SC1, "number", PRICE.number, ref("pilot-number-1"), "pilot")).error?.code).toBe("TW019"); // a spent reference stays spent
    });

    it("the cumulative ceiling is enforced: nothing is reserved when the number would exceed it", async () => {
      const c = adapterOf(ACC.C);
      aged(`update public.studio_sms_pilot_exceptions set ceiling_cents = 300 where legal_entity_id = '${EC}'`); // 200 captured, 100 left
      // release the first number so a second can be approved (location rule), then approve another
      expect((await recordSenderFromLedger(admin, SC1, U.padmin)).ok).toBe(true);
      expect((await rpc("tw4_sender_revoke", { p_studio_id: SC1, p_actor: U.padmin, p_reason: "fixture: released", p_release: true })).error).toBeNull();
      expect((await rpc("tw4_num_retire", { p_studio_id: SC1, p_actor: U.padmin, p_note: "released at the provider console (fixture)" })).error).toBeNull();
      await choose(SC1, U.owner_a, c, NUM.c2);
      expect((await authorize(EC, SC1, "number", PRICE.number, ref("pilot-number-2"), "pilot")).error).toBeNull();
      const before = c.count("purchaseNumber");
      expect((await run(SC1, c)).outcome).toBe("insufficient_credit");
      expect(c.count("purchaseNumber")).toBe(before);
      expect(reservations(EC, "number")).toBe("captured:200:pilot");
    });

    it("the pilot business cannot be activated: no month-two operation exists, and that is an explicit failing checklist item", async () => {
      const check = await activationCheck(admin, SC1, U.padmin);
      expect(check.ok).toBe(true);
      const item = check.ok ? check.data.items.find((i) => i.id === "funding_continuity") : undefined;
      expect(item).toMatchObject({ ok: false, detail: "pilot_month_two_undefined" });
      expect((await markReady(admin, SC1, U.padmin, "attempting to mark the pilot ready")).ok).toBe(false);
    });
  });

  describe("sender registry hand-off, Advanced Opt-Out, compliance and activation (business A, location 1)", () => {
    const provider = new FakeSenderReadProvider();
    let numberSid = "";
    const script = (over: { campaignStatus?: string } = {}) => {
      provider.script("account", ACC.A, { sid: ACC.A, status: "active" });
      provider.script("service", MG.A1, { sid: MG.A1, account_sid: ACC.A, us_app_to_person_registered: true, inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
      provider.script("campaign", QE.A1, { sid: QE.A1, account_sid: ACC.A, messaging_service_sid: MG.A1, campaign_status: over.campaignStatus ?? "VERIFIED", mock: false, brand_registration_sid: BRAND.A1, us_app_to_person_usecase: "MIXED" });
      provider.script("brand", BRAND.A1, { sid: BRAND.A1, status: "APPROVED", mock: false });
      provider.script("number", numberSid, { sid: numberSid, account_sid: ACC.A, phone_number: NUM.a1c, sms_capable: true, status: "in-use", sms_url: null });
      provider.script("service_number", numberSid, { sid: numberSid, service_sid: MG.A1, account_sid: ACC.A });
    };
    // the PR #249 readiness (which sender may send) and the R2b send gate on top of it (only an ACTIVE onboarding sends)
    const readyCore = () => psql(`select (public._tw4sr_ready_core('${SA1}')).id is not null`);
    const ready = () => psql(`select (public._tw4sr_ready('${SA1}')).id is not null`);
    const items = async () => {
      const check = await activationCheck(admin, SA1, U.padmin);
      expect(check.ok).toBe(true);
      return Object.fromEntries((check.ok ? check.data.items : []).map((i) => [i.id, i]));
    };
    const verify = () => verifyForActivation(admin, provider, { studioId: SA1, actorId: U.padmin, inboundUrl: INBOUND });
    const compliance = async (adapter: FakeNumberAdapter = adapterOf(ACC.A)) => { const r = await runComplianceValidation(admin, adapter, { studioId: SA1, actorId: U.padmin, inboundUrl: INBOUND }); if (process.env.R2B_DEBUG) console.log("compliance", JSON.stringify(r)); return r; };

    it("the location buys its replacement number (the ledger holds one live purchase and one attachment)", async () => {
      const a = adapterOf(ACC.A);
      await choose(SA1, U.owner_a, a, NUM.a1c);
      const result = await run(SA1, a);
      expect(result.outcome).toBe("number_ready");
      numberSid = psql(`select provider_sid from public.studio_sms_num_operations where studio_id = '${SA1}' and op_kind = 'number_purchase' and superseded_at is null`);
      expect(numberSid).toMatch(/^PN[0-9a-f]{32}$/);
      expect(ops(SA1, "number_purchase")).toBe("1:succeeded:true,2:succeeded:false");
    });

    it("the sender is recorded from the LEDGER only; nothing is ready, and every checklist item says why", async () => {
      const before = await items();
      expect(before.sender_ready.ok).toBe(false);
      expect(before.opt_out_attested.ok).toBe(false);
      expect(before.compliance_passed.ok).toBe(false);
      expect(before.number_owned.ok).toBe(true);
      expect(before.number_attached.ok).toBe(true);
      const recorded = await recordSenderFromLedger(admin, SA1, U.padmin);
      expect(recorded.ok).toBe(true);
      const again = await recordSenderFromLedger(admin, SA1, U.padmin);
      expect(again.ok && (again.data as { replayed?: boolean }).replayed).toBe(true);
      expect(psql(`select status || '|' || phone_number_sid || '|' || sender_e164 || '|' || messaging_service_sid || '|' || campaign_sid from (select * from public.studio_sms_billed_senders where studio_id = '${SA1}' order by seq desc limit 1) s`))
        .toBe(`pending|${numberSid}|${NUM.a1c}|${MG.A1}|${QE.A1}`);
      // another location cannot record this location's number (PR #249's global uniqueness)
      expect((await rpc("tw4_sender_record", { p_studio_id: SA2, p_actor: U.padmin, p_messaging_service_sid: MG.A2, p_campaign_sid: QE.A2, p_phone_number_sid: numberSid, p_sender_e164: NUM.a1c, p_reason: "fixture: duplicate number" })).error?.code).toBe("23505");
    });

    it("verification needs a current Advanced Opt-Out attestation AND a passed compliance validation: otherwise the database refuses (nothing is verified)", async () => {
      script();
      expect((await verify()).ok).toBe(false);
      expect(psql(`select count(*) from public.studio_sms_sender_verifications where studio_id = '${SA1}'`)).toBe("0");
      const incomplete = await rpc("tw4_act_attest", { p_studio_id: SA1, p_actor: U.padmin, p_checklist: { ...CHECKLIST, help_keyword_confirmed: false }, p_evidence_ref: "Twilio console screenshot 2026-10-21" });
      expect(incomplete.error?.code).toBe("22023");
      expect((await rpc("tw4_act_attest", { p_studio_id: SA1, p_actor: U.padmin, p_checklist: CHECKLIST, p_evidence_ref: "short" })).error?.code).toBe("22023");
      expect((await rpc("tw4_act_attest", { p_studio_id: SA1, p_actor: U.stranger, p_checklist: CHECKLIST, p_evidence_ref: "Twilio console screenshot 2026-10-21" })).error?.code).toBe("42501");
      expect((await attestOptOut(admin, { studioId: SA1, actorId: U.padmin, checklist: CHECKLIST, evidenceRef: "Twilio console screenshot 2026-10-21" })).ok).toBe(true);
      // attested, but no compliance validation yet
      expect(await verify()).toMatchObject({ ok: false, code: "TW041" });
      expect(psql(`select count(*) from public.studio_sms_sender_verifications where studio_id = '${SA1}'`)).toBe("0");
    });

    it("the compliance validation judges the campaign's STOP / START / HELP setup from provider reads; a campaign without STOP fails and blocks verification; another account's reads prove nothing", async () => {
      const a = adapterOf(ACC.A);
      // the route DanceFlow expects is pinned in the database by an admin: without a pin, or with a different origin, nothing is judged
      expect((await items()).inbound_route_pinned).toMatchObject({ ok: false });
      expect(await compliance()).toMatchObject({ ok: false, code: "TW044" });
      expect((await rpc("tw4_inbound_route_pin_set", { p_actor: U.stranger, p_origin: "https://other.example.test", p_reason: "pin the canonical origin" })).error?.code).toBe("42501");
      expect((await rpc("tw4_inbound_route_pin_set", { p_actor: U.padmin, p_origin: "https://evil.example/path?x=", p_reason: "pin the canonical origin" })).error?.code).toBe("22023");
      expect((await rpc("tw4_inbound_route_pin_set", { p_actor: U.padmin, p_origin: "https://other.example.test", p_reason: "pin the canonical origin (wrong one first)" })).error).toBeNull();
      expect(await compliance()).toMatchObject({ ok: false, code: "TW044" }); // INBOUND is app.example.test: it differs from the pin
      expect((await rpc("tw4_inbound_route_pin_set", { p_actor: U.padmin, p_origin: "https://app.example.test", p_reason: "pin the canonical origin" })).error).toBeNull();
      expect((await items()).inbound_route_pinned).toMatchObject({ ok: true });
      a.registerCampaign(QE.A1, { messaging_service_sid: MG.A1, opt_out_keywords: ["QUIT"] });
      const failed = await compliance();
      expect(failed.ok && failed.data).toMatchObject({ outcome: "failed" });
      expect(failed.ok && failed.data.codes).toContain("no_stop_keyword");
      expect(await verify()).toMatchObject({ ok: false, code: "TW041" });
      a.registerCampaign(QE.A1, { messaging_service_sid: MG.A1, help_message: "", campaign_status: "IN_PROGRESS" });
      const bad = await compliance();
      expect(bad.ok && bad.data.codes).toEqual(expect.arrayContaining(["campaign_not_verified", "no_help_message"]));
      expect((await compliance(adapterOf(ACC.B))).ok).toBe(false); // a read made in another business's account
      // a service that does not route to DanceFlow fails the route check
      a.registerCampaign(QE.A1, { messaging_service_sid: MG.A1 });
      a.services.get(MG.A1)!.inbound_request_url = "https://elsewhere.example/hook";
      const route = await compliance();
      expect(route.ok && route.data.codes).toContain("inbound_route");
      a.services.get(MG.A1)!.inbound_request_url = INBOUND;
      const good = await compliance();
      expect(good).toMatchObject({ ok: true, data: { outcome: "passed", codes: [] } });
      expect(psql(`select count(*) from public.studio_sms_compliance_checks where studio_id = '${SA1}'`)).toBe("4");
    });

    it("with both in place the sender is verified from provider reads (PR #249's judge) and becomes ready", async () => {
      expect(await readyCore()).toBe("f");
      const verified = await verify();
      expect(verified).toMatchObject({ ok: true, data: { outcome: "verified" } });
      expect(await readyCore()).toBe("t");
      // verified is not activated: the location does not send before the activation checklist and the state change (the send gate)
      expect(await ready()).toBe("f");
      expect(state(SA1)).toBe("campaign_pending");
      expect(psql(`select attested_opt_out from public.studio_sms_sender_verifications where studio_id = '${SA1}' order by seq desc limit 1`)).toBe("t");
    });

    it("funding continuity: the campaign monthly fee AND the number rent need authorizations with more than 35 days left; the checklist says which is missing", async () => {
      expect((await items()).funding_continuity).toMatchObject({ ok: false, detail: "campaign_authorization_short_or_missing" });
      expect((await recurring(SA1, U.owner_a, "monthly", PRICE.monthly)).error).toBeNull();
      expect((await items()).funding_continuity).toMatchObject({ ok: true });
      // 30 days left is not enough (35 required)
      const numberAuth = psql(`select id from public.studio_sms_recurring_authorizations where studio_id = '${SA1}' and kind = 'number' and status = 'active'`);
      aged(`update public.studio_sms_recurring_authorizations set expires_at = now() + interval '30 days' where id = '${numberAuth}'`);
      expect((await items()).funding_continuity).toMatchObject({ ok: false, detail: "number_authorization_short_or_missing" });
      aged(`update public.studio_sms_recurring_authorizations set expires_at = now() + interval '80 days' where id = '${numberAuth}'`);
      expect((await items()).funding_continuity.ok).toBe(true);
    });

    it("ready for activation only when every item passes; each lapse (authorization, verification age, attestation age, compliance age) blocks activation again, and nothing activates by itself", async () => {
      expect(state(SA1)).toBe("campaign_pending");
      expect((await markReady(admin, SA1, U.padmin, "short")).ok).toBe(false);
      const marked = await markReady(admin, SA1, U.padmin, "checklist reviewed by the platform admin");
      expect(marked).toMatchObject({ ok: true, data: { state: "ready_for_activation" } });
      expect(state(SA1)).toBe("ready_for_activation");
      // 1. the number rent authorization is revoked
      const numberAuth = psql(`select id from public.studio_sms_recurring_authorizations where studio_id = '${SA1}' and kind = 'number' and status = 'active'`);
      expect((await rpc("tw4_recurring_revoke", { p_authorization_id: numberAuth, p_user_id: U.owner_a })).error).toBeNull();
      expect(await activate(admin, SA1, U.padmin, "attempt with a revoked authorization")).toMatchObject({ ok: false, code: "TW042" });
      expect((await recurring(SA1, U.owner_a, "number", PRICE.number)).error).toBeNull();
      // 2. the verification is older than 24 hours (PR #249's freshness rule)
      aged(`update public.studio_sms_sender_verifications set created_at = now() - interval '25 hours' where studio_id = '${SA1}'`);
      expect(await activate(admin, SA1, U.padmin, "attempt with a stale verification")).toMatchObject({ ok: false, code: "TW042" });
      // 3. the compliance validation is older than 24 hours
      aged(`update public.studio_sms_compliance_checks set created_at = now() - interval '25 hours' where studio_id = '${SA1}'`);
      expect((await items()).compliance_passed.ok).toBe(false);
      // 4. the attestation is older than 30 days
      aged(`update public.studio_sms_optout_attestations set created_at = now() - interval '31 days' where studio_id = '${SA1}'`);
      expect((await items()).opt_out_attested.ok).toBe(false);
      expect(state(SA1)).toBe("ready_for_activation");
      // renew everything the database asks for, in the order it asks
      expect((await attestOptOut(admin, { studioId: SA1, actorId: U.padmin, checklist: CHECKLIST, evidenceRef: "Twilio console screenshot 2026-10-21 renewed" })).ok).toBe(true);
      expect((await compliance()).ok).toBe(true);
      expect(await verify()).toMatchObject({ ok: true, data: { outcome: "verified" } });
      expect((await activate(admin, SA1, U.stranger, "an unauthorized actor attempts activation")).ok).toBe(false);
      expect(state(SA1)).toBe("ready_for_activation");
    });

    it("activation re-evaluates everything in its own transaction: it succeeds only now, and a re-verification (PR #249 judge, the one PR #251 schedules) keeps the sender ready; a failed read makes it not ready at once", async () => {
      const done = await activate(admin, SA1, U.padmin, "all checklist items are green");
      expect(done).toMatchObject({ ok: true, data: { state: "active" } });
      expect(state(SA1)).toBe("active");
      expect(step(SA1)).toBe("A2");
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${SA1}' and action in ('activation_ready', 'activation_done')`)).toBe("2");
      // a refresh of an approved sender (PR #249's verification; PR #251 schedules the same judge) keeps it ready. R2b adds no scheduler and does not call the
      // scheduler-only function, so it works with or without PR #251 applied.
      aged(`update public.studio_sms_sender_verifications set created_at = now() - interval '20 hours' where studio_id = '${SA1}'`);
      expect(await verify()).toMatchObject({ ok: true, data: { outcome: "verified" } });
      expect(await ready()).toBe("t");
      // the provider now reports the campaign failed: the next verification fails the sender and the checklist reflects it immediately
      script({ campaignStatus: "FAILED" });
      expect(await verify()).toMatchObject({ ok: true, data: { outcome: "failed" } });
      expect(await ready()).toBe("f");
      expect((await items()).sender_ready.ok).toBe(false);
      script();
    });

    it("suspension revokes the sender at once; reactivation needs the whole checklist again (a revoked sender is not ready)", async () => {
      const suspended = await suspend(admin, SA1, U.padmin, "owner asked to pause texting");
      expect(suspended).toMatchObject({ ok: true, data: { state: "suspended" } });
      expect(state(SA1)).toBe("suspended");
      expect(psql(`select status from (select * from public.studio_sms_billed_senders where studio_id = '${SA1}' order by seq desc limit 1) s`)).toBe("revoked");
      expect(await ready()).toBe("f");
      expect(await activate(admin, SA1, U.padmin, "attempt to resume without re-verifying")).toMatchObject({ ok: false, code: "TW042" });
      expect((await suspend(admin, SA1, U.padmin, "already suspended and paused")).ok).toBe(false);
      const exposure = await rpc("tw4_act_exposure", { p_actor: U.padmin });
      expect(exposure.error).toBeNull();
      expect(Array.isArray(exposure.data)).toBe(true);
    });

    it("a location past the number step can still replace its number: retire sends it through exception and reopen returns it to the number step; a number mismatch at the provider stops it at once", async () => {
      // the sender is already revoked by the suspension; release it, then the admin confirms the provider release
      expect((await rpc("tw4_sender_revoke", { p_studio_id: SA1, p_actor: U.padmin, p_reason: "fixture: location releases its number", p_release: true })).error).toBeNull();
      expect((await rpc("tw4_num_retire", { p_studio_id: SA1, p_actor: U.padmin, p_note: "released at the provider console (fixture)" })).error).toBeNull();
      expect(state(SA1)).toBe("exception");
      expect(code(SA1)).toBe("num_retired");
      expect((await rpc("tw4_num_reopen", { p_studio_id: SA1, p_actor: U.padmin, p_reason: "the replacement number will be bought" })).error).toBeNull();
      expect(state(SA1)).toBe("campaign_pending");
      expect(await ready()).toBe("f");
    });

    it("a number the provider no longer has is evidence: the next status check judges a mismatch, the sender is revoked and the location goes to exception", async () => {
      const a = adapterOf(ACC.A);
      await choose(SA1, U.owner_a, a, NUM.a1b);
      const bought = await run(SA1, a);
      expect(bought.outcome).toBe("number_ready");
      expect((await recordSenderFromLedger(admin, SA1, U.padmin)).ok).toBe(true);
      const sid = psql(`select provider_sid from public.studio_sms_num_operations where studio_id = '${SA1}' and op_kind = 'number_purchase' and superseded_at is null`);
      a.universe.owned.delete(sid); // released at the console
      const refreshed = await refreshNumber({ store, adapter: a, studioId: SA1, actorId: U.padmin, envName: "test" });
      expect(refreshed.outcome).toBe("exception");
      expect(state(SA1)).toBe("exception");
      expect(code(SA1)).toBe("num_mismatch");
      expect(psql(`select status from (select * from public.studio_sms_billed_senders where studio_id = '${SA1}' order by seq desc limit 1) s`)).toBe("revoked");
      // the provider says the number is gone: it is no basis for rent
      expect(await basis(SA1)).toMatchObject({ live: false, reason: "provider_ownership_lost" });
    });
  });

  describe("rollback safety", () => {
    const rollbackSql = () => readFileSync(join(__dirname, "..", "..", "..", "..", "lib", "supabase", "migrations", "rollback", "20261208090000_twilio_r2b_number_activation_rollback.sql"), "utf8");
    const contained = (sql: string) => `begin;\n${sql.replace(/^begin;$/m, "").replace(/^commit;$/m, "")}\nrollback;`;

    it("the rollback REFUSES while any provisioning evidence exists (nothing is dropped); with none it runs cleanly, and only inside a transaction that is rolled back here", () => {
      const refused = psqlError(contained(rollbackSql()));
      expect(refused).toContain("55000");
      expect(psql(`select to_regclass('public.studio_sms_num_operations') is not null`)).toBe("t");
      psqlFile(CLEANUP);
      expect(psqlError(contained(rollbackSql()))).toBe("");
      expect(psql(`select to_regclass('public.studio_sms_num_operations') is not null`)).toBe("t");
    });
  });
});
