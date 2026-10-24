/**
 * TW-4F F4 recovery tooling (20261221090000) against a REAL schema: a provider-verified campaign registers in the recurring-fee inventory in the same transaction as its
 * observation, the audited registration retry records the platform-admin actor (and its refusals), deferred number retirements are listed and retried under the number
 * runner's lock order with the sender-release prerequisite, the consolidated exposure view shows each provider resource once with unknown costs as null, the
 * evidence-console read never permits a pilot release, and every entry point refuses owners, outsiders and the API roles. Synthetic fixtures with fresh ids; fake
 * provider evidence only (no Twilio, no SMS, no Stripe).
 * LOCAL QA ONLY: a DEDICATED Postgres with migrations 20261207090000 .. 20261217090000 and 20261221090000 applied:
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4F4_DB=postgres
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.f4recovery.test.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pilotCoverArgs } from "./rflEvidenceHelper";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4F4_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `f4${RUN}-0000-4000-8000-000000000401`;
const OUTSIDER = `f4${RUN}-0000-4000-8000-000000000999`;
const MIG = join(__dirname, "../../../supabase/migrations");

const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", sqlArgs, { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const psqlAsync = (sql: string): Promise<{ out: string; err: string }> =>
  new Promise((resolve) => {
    const child = spawn("docker", sqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => resolve({ out: out.trim(), err: code === 0 ? "" : err || "failed" }));
    child.stdin.end(`\\set VERBOSITY verbose\n${sql}`);
  });
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  const s = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
};
const callSql = (fn: string, ...args: unknown[]) => `select public.${fn}(${args.map(lit).join(", ")})::text;`;
const call = <T = Record<string, unknown>>(fn: string, ...args: unknown[]): T => JSON.parse(psql(callSql(fn, ...args)) || "null") as T;
const callErr = (fn: string, ...args: unknown[]) => psqlError(callSql(fn, ...args));
const hasCode = (err: string, code: string) => new RegExp(`ERROR:\\s+${code}:`).test(err);
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);

const hex = (n: number) => randomBytes(n).toString("hex");
const sid = (prefix: string) => `${prefix}${hex(16)}`;
const digest = () => hex(32);
const e164 = () => `+12${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const NOTE = "Checked the inventory with the provider console before retrying";

type World = { entity: string; studio: string; owner: string; account: string; onboarding: string; pilot: boolean };
/** Businesses this run created: their open number findings are cleared afterwards (tw4_num_orphan_escalate is global and other suites count its alerts). */
const ENTITIES = new Set<string>();

/** A synthetic business (or a fresh location of the one pilot business) with an active subaccount, funded credit, a leased onboarding and an approved, non-mock brand. */
function world(opts: { pilot?: boolean; state?: string } = {}): World {
  const w: World = { entity: randomUUID(), studio: randomUUID(), owner: randomUUID(), account: sid("AC"), onboarding: randomUUID(), pilot: Boolean(opts.pilot) };
  const existing = w.pilot ? psql(`select y.legal_entity_id || '|' || t.twilio_account_sid from public.studio_sms_pilot_exceptions y join public.studio_sms_twilio_accounts t on t.legal_entity_id = y.legal_entity_id and t.status = 'active'`) : "";
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${hex(4)}@f4recovery-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'F4 ${hex(3)}', 'f4-${hex(4)}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
commit;`);
  if (existing) {
    [w.entity, w.account] = existing.split("|");
    replica(`insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now());`);
  } else {
    ENTITIES.add(w.entity);
    psql(`begin;
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', '${w.pilot ? "ConfiDance Unlimited, LLC" : `F4 World ${hex(3)} LLC`}', '7777', ${w.pilot ? 15000 : 500000}, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: verified synthetic business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${w.entity}', '${w.account}', 'f4-${hex(3)}', 'test', 'active', '${P}');
commit;`);
    call("tw4_credit_adjust", w.entity, 200_000, `f4-fund-${hex(4)}`, "fixture funding for the recovery suite", P);
    if (w.pilot) call("tw4_pilot_exception_create", w.entity, 15000, `Founder written pilot approval ${RUN}`, P);
  }
  const brand = sid("BN");
  replica(`insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at, lease_owner, lease_expires_at)
    values ('${w.onboarding}', '${w.studio}', '${opts.state ?? "campaign_pending"}', 'F4 LLC', 'llc', '7777', 1, now(), 'lc', now() + interval '2 hours');
  insert into public.studio_sms_registrations (studio_id, registration_status, brand_sid, brand_status) values ('${w.studio}', 'in_review', '${brand}', 'approved');
  insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status, provider_sid, mock, twilio_account_sid)
    values ('${w.onboarding}', '${w.studio}', 'B1', 1, 'succeeded', '${brand}', false, '${w.account}');`);
  return w;
}
const brandOf = (w: World) => psql(`select brand_sid from public.studio_sms_registrations where studio_id = '${w.studio}'`);
const releaseLease = (w: World) => replica(`update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where id = '${w.onboarding}';`);

type Campaign = { ms: string; msOp: string; op: string; qe: string };
/** The R2a ledger for a location: a ready Messaging Service and a campaign operation (fee-bearing) in the given status. */
function campaign(w: World, o: { status?: "succeeded" | "unknown_outcome" | "in_flight"; pilotReservation?: "captured" | "reserved"; startedAgo?: string; reservedAgo?: string; capturedAgo?: string } = {}): Campaign {
  const c: Campaign = { ms: sid("MG"), msOp: randomUUID(), op: randomUUID(), qe: sid("QE") };
  const status = o.status ?? "succeeded";
  replica(`insert into public.studio_sms_prov_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, params, provider_sid, started_by, finished_at)
    values ('${c.msOp}', '${w.onboarding}', '${w.studio}', '${w.entity}', '${w.account}', 'messaging_service', 1, 1, 'succeeded', 'fixture service', '${digest()}', '{}'::jsonb, '${c.ms}', '${P}', now());
  insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, status, source, evidence_digest)
    values ('${c.msOp}', '${w.entity}', '${w.studio}', '${w.account}', 'messaging_service', '${c.ms}', 'ready', 'fake', '${digest()}');
  insert into public.studio_sms_prov_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, params, provider_sid,
                                                 fee_bearing, fee_kinds, started_by, started_at, finished_at)
    values ('${c.op}', '${w.onboarding}', '${w.studio}', '${w.entity}', '${w.account}', 'campaign', 1, 1, '${status}', 'fixture campaign', '${digest()}',
            '{"use_case":"MIXED","messaging_service_sid":"${c.ms}"}'::jsonb, ${status === "succeeded" ? `'${c.qe}'` : "null"}, true, array['campaign_vetting','monthly'], '${P}',
            now() - interval '${o.startedAgo ?? "0 minutes"}', ${status === "succeeded" ? "now()" : "null"});`);
  if (o.pilotReservation) {
    replica(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, created_at, closed_at)
      values ('${w.entity}', '${w.studio}', 'monthly', 1500, 'pilot', '${o.pilotReservation}', 'prov:${c.op}:monthly', now() - interval '${o.reservedAgo ?? "0 minutes"}',
              ${o.pilotReservation === "captured" ? `now() - interval '${o.capturedAgo ?? "0 minutes"}'` : "null"});`);
  }
  return c;
}
/** The spend event that makes a pilot reservation settleable by tw4_prov_observe (R2a: settlement goes through the spend event). */
const spendEvent = (w: World, c: Campaign, ago: string) =>
  replica(`insert into public.studio_sms_spend_events (legal_entity_id, studio_id, kind, amount_cents, status, approval_ref, authorized_by, authorized_at, reservation_key, reserved_at, credit_reservation_id, funding)
    values ('${w.entity}', '${w.studio}', 'monthly', 1500, 'reserved', 'Written approval ${RUN} first month ${hex(3)}', '${P}', now() - interval '${ago}', 'prov:${c.op}:monthly', now() - interval '${ago}',
            (select id from public.studio_sms_credit_reservations where reservation_key = 'prov:${c.op}:monthly'), 'pilot');`);
/** The pilot ceiling's usage, exactly as tw4_rfl_pilot_cover computes it (reserved + captured pilot reservations of the business). */
const pilotUsed = (w: World) => Number(psql(`select coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured')`));
const ledgerSum = (w: World) => Number(psql(`select coalesce(sum(balance_delta_cents), 0) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}'`));
const campaignFacts = (w: World, c: Campaign, status = "VERIFIED", over: Record<string, unknown> = {}) => ({
  sid: c.qe, account_sid: w.account, messaging_service_sid: c.ms, brand_registration_sid: brandOf(w), us_app_to_person_usecase: "MIXED", campaign_status: status, mock: false, errors: "", ...over,
});
const observeSql = (w: World, c: Campaign, status = "VERIFIED") => callSql("tw4_prov_observe", w.onboarding, "lc", c.op, campaignFacts(w, c, status), null, "fake", digest());
const observeCampaign = (w: World, c: Campaign, status = "VERIFIED") => JSON.parse(psql(observeSql(w, c, status))) as { status: string; code: string | null };

type NumberLedger = { op: string; attach: string; pn: string; number: string };
/** The number ledger for a location: a consumed selection, a succeeded purchase (and optionally its attachment). */
function numberLedger(w: World, o: { attach?: boolean } = {}): NumberLedger {
  const l: NumberLedger = { op: randomUUID(), attach: randomUUID(), pn: sid("PN"), number: e164() };
  const selection = randomUUID();
  replica(`insert into public.studio_sms_number_selections (id, offer_id, studio_id, legal_entity_id, twilio_account_sid, e164, price_cents, funding_mode, approver_user, approver_role, approval_ref, statement, expires_at, status, consumed_at, consumed_by_operation)
    values ('${selection}', '${randomUUID()}', '${w.studio}', '${w.entity}', '${w.account}', '${l.number}', 200, 'credit_recurring', '${w.owner}', 'studio_owner', 'Written approval ${RUN} ${hex(3)}',
            'fixture: the owner approved this single number for purchase in the recovery suite', now() + interval '1 day', 'consumed', now(), '${l.op}');
  insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, selection_id, e164, friendly_name, request_digest, params,
                                                 provider_sid, fee_bearing, fee_kinds, started_by, finished_at)
    values ('${l.op}', '${w.onboarding}', '${w.studio}', '${w.entity}', '${w.account}', 'number_purchase', 1, 1, 'succeeded', '${selection}', '${l.number}', 'fixture number', '${digest()}',
            '{"funding_mode":"credit"}'::jsonb, '${l.pn}', true, array['number'], '${P}', now());`);
  if (o.attach) {
    replica(`insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, e164, friendly_name, request_digest, params, provider_sid, started_by, finished_at)
      values ('${l.attach}', '${w.onboarding}', '${w.studio}', '${w.entity}', '${w.account}', 'number_attach', 1, 1, 'succeeded', '${l.number}', 'fixture attach', '${digest()}', '{}'::jsonb, '${l.pn}', '${P}', now());`);
  }
  return l;
}
const observeNumber = (w: World, l: NumberLedger) =>
  call<{ status: string }>("tw4_num_observe", w.onboarding, "lc", l.op, { sid: l.pn, account_sid: w.account, phone_number: l.number, sms_capable: true }, "fake", digest());
/** A live resource already registered for the location (blocks a second live registration of that kind with TW040). */
const liveBlocker = (w: World, kind: "number" | "campaign") => {
  const id = randomUUID();
  replica(`insert into public.studio_sms_provider_resources (id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, fee_kind, source, registered_by)
    values ('${id}', '${w.entity}', '${w.studio}', '${w.account}', '${kind}', '${kind === "number" ? sid("PN") : sid("QE")}', ${kind === "number" ? `'${e164()}'` : "null"}, '${kind === "number" ? "number" : "monthly"}', 'admin', '${P}');`);
  return id;
};
const cancelResource = (id: string) => replica(`update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = now(), cancel_evidence_digest = '${digest()}' where id = '${id}';`);
const resourcesOf = (w: World) => JSON.parse(psql(`select coalesce(json_agg(json_build_object('id', id, 'kind', resource_kind, 'sid', provider_sid, 'source', source, 'op', source_operation_id, 'by', registered_by, 'state', provider_state, 'fee', fee_kind)), '[]'::json)::text
  from public.studio_sms_provider_resources where studio_id = '${w.studio}'`)) as Array<{ id: string; kind: string; sid: string; source: string; op: string; by: string; state: string; fee: string }>;
const count = (sql: string) => Number(psql(`select count(*) from (${sql}) q`));
const audits = (w: World, action: string) => JSON.parse(psql(`select coalesce(json_agg(json_build_object('type', actor_type, 'by', actor_user_id, 'note', note) order by created_at, id), '[]'::json)::text
  from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = '${action}'`)) as Array<{ type: string; by: string | null; note: string }>;
const money = (w: World) => psql(`select (select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}') || '|' || (select count(*) from public.studio_sms_recurring_charges where legal_entity_id = '${w.entity}')
  || '|' || (select count(*) || ':' || coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}') || '|' || (select coalesce(sum(ceiling_cents), 0) from public.studio_sms_pilot_exceptions where legal_entity_id = '${w.entity}')
  || '|' || (select count(*) from public.studio_sms_spend_events where legal_entity_id = '${w.entity}')`);
const sender = (w: World, status: string, pn: string | null) =>
  replica(`insert into public.studio_sms_billed_senders (legal_entity_id, studio_id, account_sid, messaging_service_sid, status, set_by, reason, phone_number_sid)
    values ('${w.entity}', '${w.studio}', '${w.account}', '${sid("MG")}', '${status}', '${P}', 'fixture sender row for the recovery suite', ${pn ? `'${pn}'` : "null"});`);

type Exposure = {
  resources: Array<{ provider_sid: string; resource_kind: string; findings: Array<{ finding: string }>; cost: { basis: string; known: boolean; provider_billed_cents: number | null; expected_provider_cents_estimate: number | null; in_rfl_exposure_report: boolean } }>;
  aggregate: Record<string, number | null | boolean>;
};

describe.skipIf(!enabled)("TW-4F F4 recovery tooling (20261221090000, real schema, fake evidence)", () => {
  beforeAll(() => {
    expect(psql(`select to_regprocedure('public.tw4_admin_exposure(uuid,uuid)') is not null`)).toBe("t");
    psql(`create table if not exists public.tw4_local_qa_only (note text); revoke all on public.tw4_local_qa_only from public, anon, authenticated, service_role;
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@f4recovery-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin') on conflict (id) do update set platform_role = excluded.platform_role;
commit;`);
  });

  afterAll(() => {
    if (!enabled || ENTITIES.size === 0) return;
    replica(`update public.studio_sms_num_orphans set status = 'cleared' where status = 'open' and legal_entity_id in (${[...ENTITIES].map((e) => `'${e}'`).join(", ")});`);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("campaign registration in the observation's transaction (A-12)", () => {
    it("a provider-VERIFIED campaign is registered from the ledger's rows, with no charge and no cover for a business with standing authorizations", () => {
      const w = world();
      const c = campaign(w);
      const before = money(w);
      expect(observeCampaign(w, c).status).toBe("verified");
      const rows = resourcesOf(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "campaign", sid: c.qe, source: "r2a", op: c.op, by: P, state: "active", fee: "monthly" });
      expect(count(`select 1 from public.studio_sms_provider_cover where studio_id = '${w.studio}'`)).toBe(0);
      expect(money(w)).toBe(before);
      expect(audits(w, "rfl_registered")[0]).toMatchObject({ type: "system", by: null });
      // a second identical observation replays the registration (no second row)
      expect(observeCampaign(w, c).status).toBe("verified");
      expect(resourcesOf(w)).toHaveLength(1);
    });

    it("a campaign still IN_PROGRESS (pending) is not registered", () => {
      const w = world();
      const c = campaign(w);
      expect(observeCampaign(w, c, "IN_PROGRESS").status).toBe("pending");
      expect(resourcesOf(w)).toHaveLength(0);
    });

    it("the registration and the observation are ONE transaction: rolling the observation back leaves neither", () => {
      const w = world();
      const c = campaign(w);
      const out = psql(`begin; ${observeSql(w, c)} select count(*) from public.studio_sms_provider_resources where provider_sid = '${c.qe}'; rollback;`);
      expect(out.split("\n").pop()).toBe("1");
      expect(count(`select 1 from public.studio_sms_provider_resources where provider_sid = '${c.qe}'`)).toBe(0);
      expect(count(`select 1 from public.studio_sms_prov_resources where operation_id = '${c.op}'`)).toBe(0);
    });

    it("a refused registration never discards the provider evidence: the observation stays, an ADMIN alert is raised and the gap is listed", () => {
      const w = world();
      liveBlocker(w, "campaign");
      const c = campaign(w);
      expect(observeCampaign(w, c).status).toBe("verified");
      expect(psql(`select status from public.studio_sms_prov_resources where operation_id = '${c.op}'`)).toBe("verified");
      expect(psql(`select audience || ':' || severity from public.studio_sms_provider_alerts where kind = 'inventory_gap' and dedupe_key = 'unregistered:${c.op}'`)).toBe("admin:critical");
      expect(audits(w, "prov_observed").some((a) => /registration_failed=TW040/.test(a.note))).toBe(true);
      const gaps = call<Array<{ kind: string; operation_id: string; last_failure_at: string | null }>>("tw4_admin_registration_gaps", P);
      expect(gaps.find((g) => g.operation_id === c.op)).toMatchObject({ kind: "campaign" });
      expect(gaps.find((g) => g.operation_id === c.op)?.last_failure_at).not.toBeNull();
    });

    it("the pilot's own first-month reservation of THIS attempt covers the registration month; nothing else is captured or charged", () => {
      const w = world({ pilot: true });
      const c = campaign(w, { pilotReservation: "captured" });
      const before = money(w);
      observeCampaign(w, c);
      const rows = resourcesOf(w);
      expect(rows).toHaveLength(1);
      expect(psql(`select basis || ':' || (reservation_id = (select id from public.studio_sms_credit_reservations where reservation_key = 'prov:${c.op}:monthly')) from public.studio_sms_provider_cover where resource_id = '${rows[0].id}'`)).toBe("initial_reservation:true");
      expect(money(w)).toBe(before);
    });

    it("D5: a pilot reservation MADE last month and captured on approval this month binds no cover; this month then takes its own written approval (tw4_rfl_pilot_cover)", () => {
      const w = world({ pilot: true });
      const c = campaign(w, { pilotReservation: "captured", startedAgo: "40 days", reservedAgo: "40 days" });
      observeCampaign(w, c);
      const rows = resourcesOf(w);
      expect(rows).toHaveLength(1);
      expect(count(`select 1 from public.studio_sms_provider_cover where resource_id = '${rows[0].id}'`)).toBe(0);
      // the remedy works (no "already covered"): one written approval for the registration month
      if (!psql(`select 1 from public.studio_sms_price_list where kind = 'monthly' and active`)) call("tw4_price_set", "monthly", 1000, 150, "fixture monthly price", P);
      const cover = call<{ cover_id: string; replayed: boolean }>("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, rows[0].id, psql(`select public._tw4ml_month_key('${w.entity}', now())`), `Written approval ${RUN} campaign month ${hex(3)}`, P));
      expect(cover.replayed).toBe(false);
      expect(psql(`select basis from public.studio_sms_provider_cover where resource_id = '${rows[0].id}'`)).toBe("pilot_approval");
    });

    it("KI-1 (20261228) on the REAL path: a monthly pilot reservation still held from LAST month is RELEASED on approval; the month's written approval is the ONE capture, and the ceiling and ledger sums are exact", () => {
      const w = world({ pilot: true });
      const c = campaign(w, { pilotReservation: "reserved", startedAgo: "40 days", reservedAgo: "40 days" });
      spendEvent(w, c, "40 days");
      const before = { used: pilotUsed(w), ledger: ledgerSum(w) };
      observeCampaign(w, c);
      const key = `prov:${c.op}:monthly`;
      expect(psql(`select status from public.studio_sms_credit_reservations where reservation_key = '${key}'`)).toBe("released");
      expect(psql(`select status from public.studio_sms_spend_events where reservation_key = '${key}'`)).toBe("void");
      expect(psql(`select disposition || ':' || note from public.studio_sms_prov_dispositions where operation_id = '${c.op}' and fee_kind = 'monthly'`)).toBe("reservation_released:pilot");
      expect(audits(w, "prov_observed").some((a) => /;ki1_released=monthly/.test(a.note))).toBe(true);
      // an ADMIN alert names the reservation's month (the provider may have billed it); never an owner request
      const alert = psql(`select audience || '|' || severity || '|' || summary from public.studio_sms_provider_alerts where kind = 'pilot_approval_needed' and dedupe_key = 'ki1:${c.op}:monthly'`);
      expect(alert.startsWith("admin|warning|")).toBe(true);
      expect(alert).toContain(psql(`select public._tw4ml_month_key('${w.entity}', now() - interval '40 days')`));
      expect(pilotUsed(w)).toBe(before.used - 1500);   // the headroom returns
      const rows = resourcesOf(w);
      expect(rows).toHaveLength(1);
      expect(count(`select 1 from public.studio_sms_provider_cover where resource_id = '${rows[0].id}'`)).toBe(0);   // D5: no cover from a released reservation
      if (!psql(`select 1 from public.studio_sms_price_list where kind = 'monthly' and active`)) call("tw4_price_set", "monthly", 1000, 150, "fixture monthly price", P);
      const price = Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = 'monthly' and active`));
      call("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, rows[0].id, psql(`select public._tw4ml_month_key('${w.entity}', now())`), `Written approval ${RUN} campaign month ${hex(3)}`, P));
      // one provider month, ONE pilot capture
      expect(Number(psql(`select count(*) from public.studio_sms_credit_reservations where studio_id = '${w.studio}' and funding = 'pilot' and status = 'captured' and kind = 'monthly'`))).toBe(1);
      expect(pilotUsed(w)).toBe(before.used - 1500 + price);
      expect(ledgerSum(w)).toBe(before.ledger);   // pilot funding posts nothing to the prepaid credit ledger
      // replay: a second approval observation releases or captures nothing more
      observeCampaign(w, c);
      expect(pilotUsed(w)).toBe(before.used - 1500 + price);
      expect(audits(w, "prov_observed").filter((a) => /;ki1_released=/.test(a.note))).toHaveLength(1);
    });

    it("KI-1: a SAME-month pilot approval is unchanged (captured on approval, and it is the registration month's cover)", () => {
      const w = world({ pilot: true });
      const c = campaign(w, { pilotReservation: "reserved" });
      spendEvent(w, c, "0 minutes");
      const used = pilotUsed(w);
      observeCampaign(w, c);
      expect(psql(`select status from public.studio_sms_credit_reservations where reservation_key = 'prov:${c.op}:monthly'`)).toBe("captured");
      const rows = resourcesOf(w);
      expect(count(`select 1 from public.studio_sms_provider_cover where resource_id = '${rows[0].id}' and basis = 'initial_reservation'`)).toBe(1);
      expect(pilotUsed(w)).toBe(used);   // a capture keeps the reservation counted; nothing released
      expect(audits(w, "prov_observed").some((a) => /ki1_released/.test(a.note))).toBe(false);
    });

    it("KI-1: a non-pilot (credit-funded) reservation from last month is still captured on approval, posting to the prepaid ledger as before", () => {
      const w = world();
      const c = campaign(w);
      replica(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, created_at)
        values ('${w.entity}', '${w.studio}', 'monthly', 1500, 'credit', 'reserved', 'prov:${c.op}:monthly', now() - interval '40 days');
        update public.studio_sms_credit_accounts set reserved_cents = reserved_cents + 1500 where legal_entity_id = '${w.entity}';`);
      replica(`insert into public.studio_sms_spend_events (legal_entity_id, studio_id, kind, amount_cents, status, approval_ref, authorized_by, authorized_at, reservation_key, reserved_at, credit_reservation_id, funding)
        values ('${w.entity}', '${w.studio}', 'monthly', 1500, 'reserved', 'Written approval ${RUN} credit month ${hex(3)}', '${P}', now() - interval '40 days', 'prov:${c.op}:monthly', now() - interval '40 days',
                (select id from public.studio_sms_credit_reservations where reservation_key = 'prov:${c.op}:monthly'), 'credit');`);
      const ledger = ledgerSum(w);
      observeCampaign(w, c);
      expect(psql(`select status from public.studio_sms_credit_reservations where reservation_key = 'prov:${c.op}:monthly'`)).toBe("captured");
      expect(ledgerSum(w)).toBe(ledger - 1500);
      expect(audits(w, "prov_observed").some((a) => /ki1_released/.test(a.note))).toBe(false);
    });

    it("KI-1: a pending (IN_PROGRESS) observation releases or captures no monthly reservation, whatever its month", () => {
      const w = world({ pilot: true });
      const c = campaign(w, { pilotReservation: "reserved", startedAgo: "40 days", reservedAgo: "40 days" });
      spendEvent(w, c, "40 days");
      observeCampaign(w, c, "IN_PROGRESS");
      expect(psql(`select status from public.studio_sms_credit_reservations where reservation_key = 'prov:${c.op}:monthly'`)).toBe("reserved");
    });

    it("KI-1: a cross-month VETTING reservation is still captured, and a cross-month REJECTION still releases as campaign_rejected (no KI-1 marker)", () => {
      const w = world({ pilot: true });
      const c = campaign(w, { startedAgo: "40 days" });
      const vet = (key: string) => replica(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, created_at)
          values ('${w.entity}', '${w.studio}', 'campaign_vetting', 1500, 'pilot', 'reserved', '${key}', now() - interval '40 days');
        insert into public.studio_sms_spend_events (legal_entity_id, studio_id, kind, amount_cents, status, approval_ref, authorized_by, authorized_at, reservation_key, reserved_at, credit_reservation_id, funding)
          values ('${w.entity}', '${w.studio}', 'campaign_vetting', 1500, 'reserved', 'Written approval ${RUN} vetting ${hex(3)}', '${P}', now() - interval '40 days', '${key}', now() - interval '40 days',
                  (select id from public.studio_sms_credit_reservations where reservation_key = '${key}'), 'pilot');`);
      vet(`prov:${c.op}:campaign_vetting`);
      observeCampaign(w, c);
      expect(psql(`select status from public.studio_sms_credit_reservations where reservation_key = 'prov:${c.op}:campaign_vetting'`)).toBe("captured");
      const r = world({ pilot: true });
      const rej = campaign(r, { pilotReservation: "reserved", startedAgo: "40 days", reservedAgo: "40 days" });
      spendEvent(r, rej, "40 days");
      observeCampaign(r, rej, "FAILED");
      expect(psql(`select status from public.studio_sms_credit_reservations where reservation_key = 'prov:${rej.op}:monthly'`)).toBe("released");
      expect(audits(r, "prov_observed").some((a) => /ki1_released/.test(a.note))).toBe(false);
      expect(count(`select 1 from public.studio_sms_provider_alerts where dedupe_key like 'ki1:${rej.op}:%'`)).toBe(0);
    });

    it("KI-1 rollback refuses once a release was recorded, and otherwise restores the 20261221 body exactly (in rolled-back transactions)", () => {
      const rb = readFileSync(join(MIG, "rollback/20261228090000_twilio_ki1_cross_month_release_rollback.sql"), "utf8").replace(/^begin;/m, "").replace(/^commit;/m, "");
      // the refusal is tested against a release row this test seeds itself (inside the rolled-back transaction), not one an earlier test happened to leave
      const w = world();
      expect(psqlError(`begin;
        set local session_replication_role = replica;
        insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, action, note) values ('${w.studio}', '${w.onboarding}', 'system', 'prov_observed', 'op=x;kind=campaign;status=verified;src=fake;ki1_released=monthly');
        set local session_replication_role = origin;
        ${rb} rollback;`)).toMatch(/55000: KI-1 rollback refused/);
      const out = psql(`begin;
        set local session_replication_role = replica; delete from public.studio_sms_onboarding_audit where action = 'prov_observed' and note like '%;ki1_released=%'; set local session_replication_role = origin;
        ${rb}
        select left(md5(replace(prosrc, chr(13), '')), 8) from pg_proc where oid = 'public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text)'::regprocedure;
        rollback;`);
      expect(out.split("\n").pop()).toBe("fcb78bdc");
      expect(psql(`select position('ki1_cross_month' in prosrc) > 0 from pg_proc where oid = 'public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text)'::regprocedure`)).toBe("t");
    });

    it("a pilot reservation made AND captured in an earlier month never pays the month the campaign is registered in", () => {
      const w = world({ pilot: true });
      const c = campaign(w, { pilotReservation: "captured", startedAgo: "45 days", reservedAgo: "45 days", capturedAgo: "40 days" });
      observeCampaign(w, c);
      const rows = resourcesOf(w);
      expect(rows).toHaveLength(1);
      expect(count(`select 1 from public.studio_sms_provider_cover where resource_id = '${rows[0].id}'`)).toBe(0);
    });

    it("a campaign the lifecycle shows CANCELLED while the provider reports it VERIFIED is never a silent replay: alerted, listed as a gap and as exposure (review P2)", () => {
      const w = world();
      const c = campaign(w);
      replica(`insert into public.studio_sms_provider_resources (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, fee_kind, source, source_operation_id, registered_by, provider_state, cancelled_at, cancel_evidence_digest)
        values ('${w.entity}', '${w.studio}', '${w.account}', 'campaign', '${c.qe}', 'monthly', 'r2a', '${c.op}', '${P}', 'cancelled', now(), '${digest()}');`);
      expect(observeCampaign(w, c).status).toBe("verified");
      expect(psql(`select audience || ':' || severity from public.studio_sms_provider_alerts where kind = 'inventory_gap' and dedupe_key = 'unregistered:${c.op}'`)).toBe("admin:critical");
      expect(call<Array<{ operation_id: string }>>("tw4_admin_registration_gaps", P).map((g) => g.operation_id)).toContain(c.op);
      const e = call<Exposure>("tw4_admin_exposure", P, w.entity);
      expect(e.resources.find((r) => r.provider_sid === c.qe)?.findings.map((f) => f.finding)).toEqual(["unregistered_ledger_resource"]);
      releaseLease(w);
      expect(call("tw4_admin_registration_retry", w.studio, P, "campaign", NOTE)).toEqual({ outcome: "refused", code: "TW040" });
    });

    it("an orphan of THIS attempt that an administrator already registered is a replay on observation: registration only, no cover attached, nothing charged", () => {
      const w = world({ pilot: true });
      const c = campaign(w, { pilotReservation: "captured" });
      const rfl = randomUUID();
      replica(`insert into public.studio_sms_provider_resources (id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, fee_kind, source, source_operation_id, registered_by)
        values ('${rfl}', '${w.entity}', '${w.studio}', '${w.account}', 'campaign', '${c.qe}', 'monthly', 'admin', '${c.op}', '${P}');`);
      const before = money(w);
      observeCampaign(w, c);
      observeCampaign(w, c);
      expect(resourcesOf(w)).toHaveLength(1);
      expect(count(`select 1 from public.studio_sms_provider_cover where resource_id = '${rfl}'`)).toBe(0);
      expect(psql(`select source || ':' || provider_state from public.studio_sms_provider_resources where id = '${rfl}'`)).toBe("admin:active");
      expect(money(w)).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("audited registration retry (A-9)", () => {
    it("a successful campaign retry records the platform-admin actor, the reason and the outcome; a repeat reports it already registered", () => {
      const w = world();
      const blocker = liveBlocker(w, "campaign");
      const c = campaign(w);
      observeCampaign(w, c);
      cancelResource(blocker);
      // a run holding the lease may be recording a newer provider read: a campaign retry waits for it (propagated, nothing recorded)
      expect(hasCode(callErr("tw4_admin_registration_retry", w.studio, P, "campaign", NOTE), "55P03")).toBe(true);
      expect(audits(w, "rfl_registration_retry")).toHaveLength(0);
      releaseLease(w);
      const out = call<{ outcome: string; resource_id: string; operation_id: string }>("tw4_admin_registration_retry", w.studio, P, "campaign", NOTE);
      expect(out).toMatchObject({ outcome: "registered", operation_id: c.op });
      const audit = audits(w, "rfl_registration_retry");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ type: "platform_admin", by: P });
      expect(audit[0].note).toContain(`kind=campaign;op=${c.op};outcome=registered`);
      expect(audit[0].note).toContain(`by=${P}`);
      expect(audit[0].note).toContain("Checked the inventory");
      expect(call<{ outcome: string }>("tw4_admin_registration_retry", w.studio, P, "campaign", NOTE).outcome).toBe("already_registered");
      expect(call<Array<{ operation_id: string }>>("tw4_admin_registration_gaps", P).map((g) => g.operation_id)).not.toContain(c.op);
    });

    it("a refused retry is RETURNED (not raised) so its audit row, with the actor, is kept; the gap shows the last retry", () => {
      const w = world();
      liveBlocker(w, "campaign");
      const c = campaign(w);
      observeCampaign(w, c);
      releaseLease(w);
      expect(call("tw4_admin_registration_retry", w.studio, P, "campaign", NOTE)).toEqual({ outcome: "refused", code: "TW040" });
      expect(audits(w, "rfl_registration_retry")[0]).toMatchObject({ type: "platform_admin", by: P });
      const gap = call<Array<{ operation_id: string; last_retry: { by: string; outcome: string; code: string } }>>("tw4_admin_registration_gaps", P).find((g) => g.operation_id === c.op);
      expect(gap?.last_retry).toMatchObject({ by: P, outcome: "refused", code: "TW040" });
      expect(resourcesOf(w).filter((r) => r.sid === c.qe)).toHaveLength(0);
    });

    it("a number retry through the audited wrapper AND through tw4_num_registration_retry records the administrator", () => {
      const w = world();
      const blocker = liveBlocker(w, "number");
      const l = numberLedger(w);
      expect(observeNumber(w, l).status).toBe("owned");
      expect(call<Array<{ operation_id: string; kind: string }>>("tw4_admin_registration_gaps", P).find((g) => g.operation_id === l.op)?.kind).toBe("number");
      expect(call("tw4_admin_registration_retry", w.studio, P, "number", NOTE)).toEqual({ outcome: "refused", code: "TW040" });
      cancelResource(blocker);
      const out = call<{ resource_id: string; replayed: boolean }>("tw4_num_registration_retry", w.studio, P);
      expect(out.replayed).toBe(false);
      expect(out).not.toHaveProperty("operation_id");   // the 20261217 contract's shape is kept
      const audit = audits(w, "rfl_registration_retry");
      expect(audit.map((a) => [a.type, a.by])).toEqual([["platform_admin", P], ["platform_admin", P]]);
      expect(audit[1].note).toContain(`kind=number;op=${l.op};outcome=registered`);
    });

    it("refuses a missing reason, an unknown kind, an unknown location; nothing live to register is a recorded refusal", () => {
      const w = world();
      expect(hasCode(callErr("tw4_admin_registration_retry", w.studio, P, "campaign", "short"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_admin_registration_retry", w.studio, P, "brand", NOTE), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_admin_registration_retry", randomUUID(), P, "number", NOTE), "22023")).toBe(true);
      expect(call("tw4_admin_registration_retry", w.studio, P, "number", NOTE)).toEqual({ outcome: "refused", code: "TW032" });
      expect(audits(w, "rfl_registration_retry")[0].note).toContain("op=none;outcome=refused;code=TW032");
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("deferred number retirements (A-10)", () => {
    const deferred = (w: World, attach = true) => {
      const l = numberLedger(w, { attach });
      const id = randomUUID();
      replica(`insert into public.studio_sms_provider_resources (id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, fee_kind, source, source_operation_id, registered_by, provider_state, cancelled_at, cancel_evidence_digest)
        values ('${id}', '${w.entity}', '${w.studio}', '${w.account}', 'number', '${l.pn}', '${l.number}', 'number', 'r2b', '${l.op}', '${P}', 'cancelled', now(), '${digest()}');
        insert into public.studio_sms_provider_alerts (legal_entity_id, studio_id, kind, dedupe_key, audience, severity, summary)
        values ('${w.entity}', '${w.studio}', 'inventory_gap', 'cancel_ledger:${randomUUID()}', 'admin', 'warning', 'fixture: deferred retirement warning');`);
      return { l, resource: id };
    };
    const listed = (w: World) =>
      call<Array<{ studio_id: string; phone_number_sid: string; ready: boolean; deferral_alerted: boolean; blockers: Record<string, boolean>; operations: unknown[] }>>("tw4_admin_deferred_retirements", P).find((d) => d.studio_id === w.studio);
    const retire = (w: World, pn: string) => callSql("tw4_admin_deferred_retire", w.studio, pn, P, NOTE);

    it("lists a cancelled number the ledger still holds, with explicit blockers (lease, sender release); retiring is refused until the sender row is RELEASED", () => {
      const w = world({ state: "ready_for_activation" });
      const { l } = deferred(w);
      sender(w, "revoked", l.pn);
      let d = listed(w);
      expect(d).toMatchObject({ phone_number_sid: l.pn, ready: false, deferral_alerted: true });
      expect(d?.blockers).toMatchObject({ lease_held: true, sender_release_required: true, operation_unresolved: false });
      expect(d?.operations).toHaveLength(2);
      expect(hasCode(psqlError(retire(w, l.pn)), "55P03")).toBe(true);
      releaseLease(w);
      expect(hasCode(psqlError(retire(w, l.pn)), "TW022")).toBe(true);
      sender(w, "released", l.pn);
      d = listed(w);
      expect(d?.ready).toBe(true);
      const out = JSON.parse(psql(retire(w, l.pn))) as { retired: boolean; operations: string[] };
      expect(out.retired).toBe(true);
      expect(out.operations.sort()).toEqual([l.op, l.attach].sort());
      expect(count(`select 1 from public.studio_sms_num_operations where studio_id = '${w.studio}' and superseded_at is null and status = 'succeeded'`)).toBe(0);
      expect(audits(w, "num_retired")[0]).toMatchObject({ type: "platform_admin", by: P });
      expect(psql(`select state || ':' || last_error_code from public.studio_sms_onboarding where id = '${w.onboarding}'`)).toBe("exception:num_retired");
      expect(listed(w)).toBeUndefined();
      // idempotent
      expect(JSON.parse(psql(retire(w, l.pn)))).toEqual({ retired: false, replayed: true });
    });

    it("a sender on ANOTHER number is not this number's prerequisite; an unresolved number operation blocks", () => {
      const w = world();
      releaseLease(w);
      const { l } = deferred(w, false);
      sender(w, "approved", sid("PN"));
      replica(`insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, e164, friendly_name, request_digest, params, started_by)
        values ('${randomUUID()}', '${w.onboarding}', '${w.studio}', '${w.entity}', '${w.account}', 'number_attach', 1, 1, 'unknown_outcome', '${l.number}', 'fixture open attachment', '${digest()}', '{}'::jsonb, '${P}');`);
      expect(listed(w)?.blockers).toMatchObject({ sender_release_required: false, operation_unresolved: true });
      expect(hasCode(psqlError(retire(w, l.pn)), "TW034")).toBe(true);
    });

    it("never retires a number the lifecycle does not show cancelled (the note is not evidence)", () => {
      const w = world();
      releaseLease(w);
      const l = numberLedger(w);
      replica(`insert into public.studio_sms_provider_resources (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, fee_kind, source, source_operation_id, registered_by)
        values ('${w.entity}', '${w.studio}', '${w.account}', 'number', '${l.pn}', '${l.number}', 'number', 'r2b', '${l.op}', '${P}');`);
      expect(hasCode(psqlError(retire(w, l.pn)), "TW034")).toBe(true);
      expect(hasCode(psqlError(retire(w, sid("PN"))), "TW034")).toBe(true);
      expect(count(`select 1 from public.studio_sms_num_operations where id = '${l.op}' and superseded_at is null`)).toBe(1);
    });

    it("takes the number runner's lock order and WAITS for the onboarding row (it never skips it): a runner holding it delays, not defeats, the retirement", async () => {
      const w = world();
      releaseLease(w);
      const { l } = deferred(w);
      const holder = psqlAsync(`begin; select 1 from public.studio_sms_onboarding where id = '${w.onboarding}' for update; select pg_sleep(2); commit;`);
      await new Promise((r) => setTimeout(r, 600));
      const started = Date.now();
      const res = await psqlAsync(`set lock_timeout = '20s'; ${retire(w, l.pn)}`);
      await holder;
      expect(res.err).toBe("");
      expect(Date.now() - started).toBeGreaterThan(700);
      expect(JSON.parse(res.out.split("\n").pop() ?? "{}").retired).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("consolidated exposure (A-8)", () => {
    const exposure = (w: World) => call<Exposure>("tw4_admin_exposure", P, w.entity);
    const orphanCampaign = (w: World, c: Campaign, status: "open" | "registered" = "open", rfl: string | null = null) => {
      const listing = randomUUID();
      const qe = c.qe;
      replica(`insert into public.studio_sms_prov_listings (id, operation_id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, scope_sid, read_id, read_started_at, source, complete, listed_sids, evidence_digest, verdict, recorded_by_lease)
        values ('${listing}', '${c.op}', '${w.onboarding}', '${w.studio}', '${w.entity}', '${w.account}', 'campaign', '${c.ms}', '${randomUUID()}', now(), 'fake', true, array['${qe}'], '${digest()}', 'present', 'lc');
        insert into public.studio_sms_prov_orphans (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, scope_sid, first_listing_id, source_operation_id, status, rfl_resource_id, registered_by, registered_at)
        values ('${w.entity}', '${w.studio}', '${w.account}', 'campaign', '${qe}', '${c.ms}', '${listing}', '${c.op}', '${status}', ${rfl ? `'${rfl}'` : "null"}, ${status === "registered" ? `'${P}'` : "null"}, ${status === "registered" ? "now()" : "null"});`);
    };

    it("one row per provider resource: an orphan SID that is ALSO an unregistered ledger campaign is shown once, with both findings, at an unknown (null) cost", () => {
      const w = world();
      liveBlocker(w, "campaign");
      const c = campaign(w);
      observeCampaign(w, c);   // refused registration: an unregistered ledger campaign
      orphanCampaign(w, c);
      const e = exposure(w);
      const rows = e.resources.filter((r) => r.provider_sid === c.qe);
      expect(rows).toHaveLength(1);
      expect(rows[0].findings.map((f) => f.finding).sort()).toEqual(["campaign_orphan", "unregistered_ledger_resource"]);
      expect(rows[0].cost).toMatchObject({ basis: "unknown", known: false, provider_billed_cents: null, expected_provider_cents_estimate: null, in_rfl_exposure_report: false });
      expect(e.aggregate.provider_billed_cents).toBeNull();
      expect(e.aggregate.expected_provider_cents_estimate).toBeNull();
      expect(e.aggregate.cost_unknown).toBe(1);
    });

    it("a REGISTERED orphan is shown once with its recorded lifecycle cost (counted once, flagged as already in the lifecycle report)", () => {
      const w = world();
      const c = campaign(w, { status: "unknown_outcome" });
      const rfl = randomUUID();
      replica(`insert into public.studio_sms_provider_resources (id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, fee_kind, source, source_operation_id, registered_by)
        values ('${rfl}', '${w.entity}', '${w.studio}', '${w.account}', 'campaign', '${c.qe}', 'monthly', 'admin', '${c.op}', '${P}');
        insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents, provider_billed_cents)
        values ('${rfl}', '${w.entity}', '${w.studio}', to_char(now(), 'YYYY-MM'), 'no_authorization', 1000, 0),
               ('${rfl}', '${w.entity}', '${w.studio}', to_char(now() - interval '1 month', 'YYYY-MM'), 'no_authorization', 1000, 250);`);
      orphanCampaign(w, c, "registered", rfl);
      const e = exposure(w);
      expect(e.resources).toHaveLength(1);
      expect(e.resources[0].cost).toMatchObject({ basis: "recorded", known: true, provider_billed_cents: 250, expected_provider_cents_estimate: 2000, in_rfl_exposure_report: true });
      expect(e.aggregate).toMatchObject({ resources: 1, cost_recorded: 1, cost_unknown: 0, provider_billed_cents: 250, expected_provider_cents_estimate: 2000, in_rfl_exposure_report: 1, amounts_overlap_rfl_exposure_report: true });
      // an open period whose expected cost is unknown makes the estimate unknown (null), never a smaller partial sum (review P2)
      replica(`insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents, provider_billed_cents)
        values ('${rfl}', '${w.entity}', '${w.studio}', to_char(now() - interval '2 months', 'YYYY-MM'), 'no_authorization', null, 0);`);
      const e2 = exposure(w);
      expect(e2.resources[0].cost).toMatchObject({ known: true, provider_billed_cents: 250, expected_provider_cents_estimate: null });
      expect(e2.aggregate.expected_provider_cents_estimate).toBeNull();
    });

    it("number orphans (open and adopted) and a number that is both an orphan finding and an unregistered ledger number are one row each; unknown cost is null, never zero", () => {
      const w = world();
      liveBlocker(w, "number");
      const l = numberLedger(w);
      observeNumber(w, l);   // owned, registration refused: unregistered ledger number
      const unknown = sid("PN");
      replica(`insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind, ledger_operation_id) values ('${w.entity}', '${w.account}', '${l.pn}', '${l.number}', 'ownership_mismatch', '${l.op}');
        insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind) values ('${w.entity}', '${w.account}', '${unknown}', '${e164()}', 'unknown');
        insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind, status, cost_bearer, resolved_by, resolved_at, resolution_note)
          values ('${w.entity}', '${w.account}', '${sid("PN")}', '${e164()}', 'unknown', 'adopted', 'danceflow', '${P}', now(), 'fixture: adopted by DanceFlow');
        insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind, status) values ('${w.entity}', '${w.account}', '${sid("PN")}', '${e164()}', 'unknown', 'cleared');`);
      const e = exposure(w);
      const numbers = e.resources.filter((r) => r.resource_kind === "number");
      expect(numbers).toHaveLength(3);   // the cleared finding is history
      expect(numbers.find((r) => r.provider_sid === l.pn)?.findings.map((f) => f.finding).sort()).toEqual(["number_ownership_mismatch", "unregistered_ledger_resource"]);
      for (const r of numbers) expect(r.cost).toMatchObject({ basis: "unknown", known: false, provider_billed_cents: null });
      expect(e.aggregate).toMatchObject({ numbers: 3, cost_unknown: 3, provider_billed_cents: null });
      expect(JSON.stringify(e)).not.toMatch(/"provider_billed_cents":0/);
    });

    it("is read-only and does not change the lifecycle's own exposure report", () => {
      const w = world();
      const snapshot = () => psql(`select (select count(*) from public.studio_sms_provider_alerts) || '|' || (select count(*) from public.studio_sms_onboarding_audit) || '|' || (select count(*) from public.studio_sms_provider_exposure)`);
      const report = () => psql(`select public.tw4_rfl_exposure_report('${P}')::text`);
      const before = [snapshot(), report()];
      exposure(w);
      call("tw4_admin_exposure", P, null);
      expect([snapshot(), report()]).toEqual(before);
      expect(psql(`select provolatile from pg_proc where oid = 'public.tw4_admin_exposure(uuid,uuid)'::regprocedure`)).toBe("s");
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("evidence console read (A-5 / A-7)", () => {
    it("reports the proof status of an unresolved fee-bearing campaign and never permits a pilot release", () => {
      const w = world();
      const c = campaign(w, { status: "unknown_outcome", startedAgo: "30 minutes" });
      const rows = call<Array<{ operation_id: string; proof: { ok: boolean; reason: string }; pilot: boolean; release_permitted_by_evidence: boolean; listings: number }>>("tw4_admin_prov_proof", w.studio, P);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ operation_id: c.op, pilot: false, release_permitted_by_evidence: false, listings: 0 });
      expect(rows[0].proof).toEqual({ ok: false, reason: "no_listing" });
      const pw = world({ pilot: true });
      campaign(pw, { status: "unknown_outcome", startedAgo: "30 minutes" });
      expect(call<Array<{ pilot: boolean; release_permitted_by_evidence: boolean }>>("tw4_admin_prov_proof", pw.studio, P)[0]).toMatchObject({ pilot: true, release_permitted_by_evidence: false });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("personas and privileges", () => {
    const ENTRY = [
      "public.tw4_admin_registration_retry(uuid,uuid,text,text)", "public.tw4_admin_registration_gaps(uuid)", "public.tw4_admin_deferred_retirements(uuid)",
      "public.tw4_admin_deferred_retire(uuid,text,uuid,text)", "public.tw4_admin_exposure(uuid,uuid)", "public.tw4_admin_prov_proof(uuid,uuid)",
    ];
    const INTERNAL = ["public._tw4prov_ledger_reservation(uuid)", "public._tw4prov_register_verified(uuid)", "public._tw4f4_retry_target(uuid,text)", "public._tw4f4_retry(uuid,text)", "public._tw4f4_sender_status(uuid,text)"];

    it("entry points are service-role only; helpers are callable by no API role (checked without calling them as an API role)", () => {
      for (const fn of ENTRY) {
        expect(psql(`select has_function_privilege('service_role', '${fn}', 'execute')`), fn).toBe("t");
        for (const role of ["anon", "authenticated"]) expect(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
      }
      for (const fn of INTERNAL) for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
      // the replaced functions keep their grants
      expect(psql(`select has_function_privilege('service_role', 'public.tw4_num_registration_retry(uuid,uuid)', 'execute') and has_function_privilege('service_role', 'public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text)', 'execute')`)).toBe("t");
    });

    it("a studio owner, an owner of ANOTHER studio and an unknown id are refused by every entry point (42501), with nothing written", () => {
      const w = world();
      const other = world();
      const l = numberLedger(w);
      const before = psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id in ('${w.studio}', '${other.studio}')`);
      for (const actor of [w.owner, other.owner, OUTSIDER]) {
        expect(hasCode(callErr("tw4_admin_registration_retry", w.studio, actor, "number", NOTE), "42501"), actor).toBe(true);
        expect(hasCode(callErr("tw4_admin_registration_gaps", actor), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_admin_deferred_retirements", actor), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_admin_deferred_retire", w.studio, l.pn, actor, NOTE), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_admin_exposure", actor, null), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_admin_prov_proof", w.studio, actor), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_num_registration_retry", w.studio, actor), "42501")).toBe(true);
      }
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id in ('${w.studio}', '${other.studio}')`)).toBe(before);
    });

    it("owners never receive a request to authorize or pay for an orphan or a recovery: every alert this migration can raise is for administrators", () => {
      const sql = readFileSync(join(MIG, "20261221090000_twilio_admin_recovery_tooling.sql"), "utf8");
      const raised = [...sql.matchAll(/_tw4rfl_alert\(([^;]*?)\);/g)].map((m) => m[1]);
      expect(raised.length).toBeGreaterThan(0);
      for (const args of raised) expect(args).toMatch(/'admin',\s*'(critical|warning|info)'/);
      // and nothing in the fixtures of this run produced an owner-facing alert
      expect(count(`select 1 from public.studio_sms_provider_alerts a join public.studio_sms_entity_studios es on es.studio_id = a.studio_id
                     join public.studios s on s.id = es.studio_id where s.slug like 'f4-%' and a.audience in ('owner', 'both')`)).toBe(0);
    });
  });
});
