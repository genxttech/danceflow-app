/**
 * TW-4F audit F-11 (migration 20270223090000) against a REAL schema: the funding-exposure check wired into the existing provider-fee lifecycle scan, and the
 * explicit account states of the recurring lifecycle it watches.
 *
 *  1. tw4_act_exposure answers exactly as its 20261208 body (now read from _tw4fx_exposure_rows); its administrator check is unchanged.
 *  2. Each alert kind (unfunded, unauthorized, grace ending, threshold): raised once per dedupe key, administrator audience, no amount / number / SID in the
 *     summary, attached to the right business only, replay- and concurrency-safe, nothing raised for a covered / fresh / cancelled / other-tenant resource, an
 *     unattributable location counted instead of dropped.
 *  3. Recurring lifecycle states: sufficient settled credit enforced before a monthly charge posts (reserved credit is not spendable), an unfunded charge is
 *     RECORDED as unfunded (and alerted), a top-up then charges exactly once (replay safe), 7-day grace then suspension while the provider resource stays live
 *     (alerted as DanceFlow-borne until a dual-control cancellation), the pilot business refused, revoked / expired / limit-hit reasons, and month boundaries
 *     in the business's timezone.
 *  4. Notification only (no money, sender, inbound or resource row changes), privileges from the catalog, and the rollback's refusal / clean re-apply.
 * Synthetic fixtures; no Twilio, no SMS, no Stripe, no email.
 *
 * LOCAL QA ONLY: a DEDICATED Postgres with the migrations through 20270223090000 applied (the iso-qa `numeric` or `main` scenario), ISO_QA_MARKER=1:
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4FX_DB=postgres
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.tw4fx.test.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { seedPriceIfMissing } from "./priceFixture";
import { pilotExceptionArgs } from "./rflEvidenceHelper";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4FX_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `fa${RUN}-0000-4000-8000-000000000501`;   // platform administrator
const P2 = `fa${RUN}-0000-4000-8000-000000000502`;  // a second one (dual control)
const MIG = join(__dirname, "../../../supabase/migrations");
const FWD = "20270223090000_twilio_funding_exposure_alerts.sql";
const RB = "rollback/20270223090000_twilio_funding_exposure_alerts_rollback.sql";
const KINDS = ["funding_exposure_unfunded", "funding_exposure_unauthorized", "funding_exposure_grace_ending", "funding_exposure_threshold"];

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
    child.stdin.end(sql);
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
const file = (name: string) => readFileSync(join(MIG, name), "utf8").replace(/\r/g, "");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

const hex = (n: number) => randomBytes(n).toString("hex");
const sid = (prefix: string) => `${prefix}${hex(16)}`;
const digest = () => hex(32);
const ref = (label: string) => `Written approval ${RUN} ${label} ${hex(3)}`;
const e164 = () => `+12${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

type Check = { unfunded: number; unauthorized: number; grace_ending: number; threshold: number; unattributed: number };
const check = (): Check => JSON.parse(psql("select public.tw4_rfl_funding_exposure_check()::text")) as Check;
const total = (c: Check) => c.unfunded + c.unauthorized + c.grace_ending + c.threshold;

type World = { entity: string; studio: string; owner: string; account: string; pilot: boolean };
const PRICE = { number: 0, monthly: 0, monthlyProvider: 0 };
const monthOf = (w: World) => psql(`select public._tw4ml_month_key('${w.entity}', now())`);
const keyAdd = (k: string, n: number) => psql(`select public._tw4ml_key_add('${k}', ${n})`);

/** A synthetic business (or another location of the ONE pilot business) with an active subaccount, onboarding access, credit and a monthly limit. */
function world(o: { pilot?: boolean; fund?: number; tz?: string } = {}): World {
  const w: World = { entity: randomUUID(), studio: randomUUID(), owner: randomUUID(), account: sid("AC"), pilot: Boolean(o.pilot) };
  const people = `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${hex(4)}@fx-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'FX ${hex(3)}', 'fx-${hex(4)}', null, '${o.tz ?? "UTC"}');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);`;
  const access = `insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) values ('${w.studio}', true, 'fixture: FX suite', '${P}');`;
  if (w.pilot) {
    const existing = psql(`select y.legal_entity_id || '|' || t.twilio_account_sid from public.studio_sms_pilot_exceptions y join public.studio_sms_twilio_accounts t on t.legal_entity_id = y.legal_entity_id and t.status = 'active'`);
    if (existing) {
      [w.entity, w.account] = existing.split("|");
      psql(`begin; ${people} commit;`);
      replica(`insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now()); ${access}`);
      return w;
    }
  }
  psql(`begin; ${people}
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', '${w.pilot ? "ConfiDance Unlimited, LLC" : `FX World ${hex(3)} LLC`}', '7777', ${w.pilot ? 15000 : 500000}, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: verified synthetic business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${w.entity}', '${w.account}', 'fx-${hex(3)}', 'test', 'active', '${P}');
commit;`);
  replica(access);
  const fund = o.fund ?? 200_000;
  if (fund > 0) call("tw4_credit_adjust", w.entity, fund, `fx-fund-${hex(4)}`, "fixture funding for the FX suite", P);
  call("tw4_monthly_limit_set_admin", w.entity, P, 20_000, null, "fixture: monthly limit for the FX suite");
  if (w.pilot) call("tw4_pilot_exception_create", ...pilotExceptionArgs(psql, w.entity, 15000, `Founder written pilot approval ${RUN}`, P));
  return w;
}

type Loc = World & { onboarding: string; op: string; pn: string; number: string; qe: string };
/** A location as R2a / R2b leave it (a provider-confirmed number purchase, observed and so registered in the fee inventory; campaign registered), onboarding at `state`. */
function location(o: { state: string; pilot?: boolean }): Loc {
  const w = world({ pilot: o.pilot });
  const l: Loc = { ...w, onboarding: randomUUID(), op: randomUUID(), pn: sid("PN"), number: e164(), qe: sid("QE") };
  const selection = randomUUID();
  const mg = sid("MG");
  replica(`insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at, lease_owner, lease_expires_at)
    values ('${l.onboarding}', '${l.studio}', 'campaign_pending', 'FX LLC', 'llc', '7777', 1, now(), 'lc', now() + interval '2 hours');
  insert into public.studio_sms_number_selections (id, offer_id, studio_id, legal_entity_id, twilio_account_sid, e164, price_cents, funding_mode, approver_user, approver_role, approval_ref, statement, expires_at, status, consumed_at, consumed_by_operation)
    values ('${selection}', '${randomUUID()}', '${l.studio}', '${l.entity}', '${l.account}', '${l.number}', 200, '${l.pilot ? "pilot" : "credit_recurring"}', '${l.owner}', 'studio_owner', '${ref("selection")}',
            'fixture: the owner approved this single number for purchase in the FX suite', now() + interval '1 day', 'consumed', now(), '${l.op}');
  insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, selection_id, e164, friendly_name, request_digest, params,
                                                 provider_sid, fee_bearing, fee_kinds, started_by, finished_at)
    values ('${l.op}', '${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'number_purchase', 1, 1, 'succeeded', '${selection}', '${l.number}', 'fixture number', '${digest()}',
            '{"funding_mode":"${l.pilot ? "pilot" : "credit"}"}'::jsonb, '${l.pn}', true, array['number'], '${P}', now());
  with ms as (insert into public.studio_sms_prov_operations (onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, provider_sid, started_by)
      values ('${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'messaging_service', 1, 1, 'succeeded', 'df:test:fx:ms', '${digest()}', '${mg}', '${P}') returning id),
       qe as (insert into public.studio_sms_prov_operations (onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, provider_sid,
                                                              fee_bearing, fee_kinds, started_by)
      values ('${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'campaign', 1, 1, 'succeeded', 'df:test:fx:c1', '${digest()}', '${l.qe}', true, array['campaign_vetting'], '${P}') returning id)
  insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, brand_sid, use_case, status, source, evidence_digest, verified_at)
    select ms.id, '${l.entity}'::uuid, '${l.studio}'::uuid, '${l.account}', 'messaging_service', '${mg}', null, null, null, 'ready', 'fake', '${digest()}', now() from ms
    union all select qe.id, '${l.entity}'::uuid, '${l.studio}'::uuid, '${l.account}', 'campaign', '${l.qe}', '${mg}', '${sid("BN")}', 'MIXED', 'verified', 'fake', '${digest()}', now() from qe;`);
  const seen = call<{ status: string }>("tw4_num_observe", l.onboarding, "lc", l.op, { sid: l.pn, account_sid: l.account, phone_number: l.number, sms_capable: true }, "fake", digest());
  expect(seen.status).toBe("owned");
  call("tw4_rfl_register", l.studio, P, "campaign", l.qe, l.account, null, "admin", null, null);
  replica(`update public.studio_sms_onboarding set state = '${o.state}', lease_owner = null, lease_expires_at = null where id = '${l.onboarding}';`);
  return l;
}

const register = (w: World, kind: "number" | "campaign") => {
  const providerSid = sid(kind === "number" ? "PN" : "QE");
  return call<{ resource_id: string }>("tw4_rfl_register", w.studio, P, kind, providerSid, w.account, kind === "number" ? e164() : null, "admin", null, null).resource_id;
};
/** Moves a resource's registration back in time (fixture only). */
const age = (resourceId: string, interval: string) => replica(`update public.studio_sms_provider_resources set registered_at = now() - interval '${interval}' where id = '${resourceId}';`);
/** A recurring authorization row (the real authorize path is covered by tw4recurring / tw4recexec); `limitPeriods` caps total_limit_cents. */
const authFixture = (w: World, kind: "number" | "monthly", o: { startsDaysAgo?: number; expiresInDays?: number; status?: "active" | "revoked"; term?: number; limitPeriods?: number } = {}) => {
  const id = randomUUID();
  const price = kind === "number" ? PRICE.number : PRICE.monthly;
  const term = o.term ?? 6;
  const revoked = o.status === "revoked";
  replica(`insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, starts_at, expires_at, status, authorized_by, statement, revoked_at, revoked_by)
    values ('${id}', '${w.entity}', '${w.studio}', '${kind}', ${price}, ${term}, ${price * (o.limitPeriods ?? term)}, now() - interval '${o.startsDaysAgo ?? 90} days', now() + interval '${o.expiresInDays ?? 90} days',
            '${revoked ? "revoked" : "active"}', '${w.owner}', 'fixture: the owner authorized this recurring charge in the FX suite', ${revoked ? "now()" : "null"}, ${revoked ? `'${w.owner}'` : "null"});`);
  return id;
};
const chargedFixture = (w: World, authId: string, kind: "number" | "monthly", period: string) => {
  const res = randomUUID();
  const price = kind === "number" ? PRICE.number : PRICE.monthly;
  replica(`insert into public.studio_sms_credit_reservations (id, legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
    values ('${res}', '${w.entity}', '${w.studio}', '${kind}', ${price}, 'credit', 'captured', 'rec:${authId}:${period}', now());
    insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reservation_id, charged_at)
    values ('${authId}', '${w.entity}', '${w.studio}', '${kind}', '${period}', ${price}, 'charged', '${res}', now());`);
};
const charge = (authId: string, period: string) => call<{ outcome: string; reason?: string; replayed: boolean }>("tw4_recurring_charge", authId, period, null);
const chargeRow = (authId: string, period: string) => psql(`select status || '|' || coalesce(reason, '') || '|' || attempts from public.studio_sms_recurring_charges where authorization_id = '${authId}' and period_key = '${period}'`);
const money = (w: World) => psql(`select (select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}') || '|' || balance_cents || ':' || reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}'`);
const captures = (w: World) => Number(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}' and kind = 'capture'`));
const scan = (w: World) => call<{ opened: number; closed: number; alerts: number }>("tw4_rfl_scan_entity", w.entity);

type AlertRow = { kind: string; dedupe_key: string; audience: string; severity: string; studio_id: string | null; resource_id: string | null; summary: string; legal_entity_id: string };
const alerts = (where: string): AlertRow[] =>
  JSON.parse(psql(`select coalesce(json_agg(json_build_object('kind', kind, 'dedupe_key', dedupe_key, 'audience', audience, 'severity', severity, 'studio_id', studio_id, 'resource_id', resource_id,
      'summary', summary, 'legal_entity_id', legal_entity_id) order by created_at, id), '[]'::json)::text from public.studio_sms_provider_alerts where kind like 'funding_exposure_%' and ${where}`)) as AlertRow[];
const alertsOf = (w: World, kind?: string) => alerts(`legal_entity_id = '${w.entity}' and (studio_id is null or studio_id = '${w.studio}')${kind ? ` and kind = '${kind}'` : ""}`);
/** No amount, phone number, SID or business name may appear in a summary. */
const expectClean = (a: AlertRow, extra: string[] = []) => {
  expect(a.audience).toBe("admin");
  expect(a.summary).not.toMatch(/\$|\bcents?\b|\+1\d{6,}|\b(PN|QE|MG|AC)[0-9a-f]{32}\b/i);
  for (const s of extra) expect(a.summary).not.toContain(s);
};

describe.skipIf(!enabled)("TW-4F funding-exposure alerts (20270223090000) and the recurring lifecycle states (real schema)", () => {
  beforeAll(() => {
    expect(psql("select to_regclass('public.tw4_local_qa_only') is not null")).toBe("t");
    expect(psql("select to_regprocedure('public.tw4_rfl_funding_exposure_check()') is not null")).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at) values
  ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@fx-e2e.test', now(), now(), now(), now()),
  ('${P2}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin2-${RUN}@fx-e2e.test', now(), now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin'), ('${P2}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
commit;`);
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150], ["monthly_low_volume", 1000, 150]] as const) {
      seedPriceIfMissing(psql, { kind, customer, provider, description: `fixture ${kind} price`, approver: P });
    }
    PRICE.number = Number(psql("select customer_price_cents from public.studio_sms_price_list where kind = 'number' and active"));
    PRICE.monthly = Number(psql("select customer_price_cents from public.studio_sms_price_list where kind = 'monthly' and active"));
    PRICE.monthlyProvider = Number(psql("select provider_cost_cents from public.studio_sms_price_list where kind = 'monthly' and active"));
    expect(PRICE.monthly).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------------
  describe("tw4_act_exposure is unchanged", () => {
    it("its body moved verbatim: the 20261208 function, installed under another name, gives the same answer on a populated database; the actor check stays", () => {
      location({ state: "active" });
      location({ state: "suspended" });
      const src = file("20261208090000_twilio_r2b_number_activation.sql");
      const start = src.indexOf("create or replace function public.tw4_act_exposure(p_actor uuid)");
      const body = src.slice(start, src.indexOf("end $$;", start) + "end $$;".length).replace("public.tw4_act_exposure(p_actor uuid)", "public._fx_orig_exposure(p_actor uuid)");
      expect(md5(body.slice(body.indexOf("$$") + 2, body.lastIndexOf("$$"))).slice(0, 12)).toBe("86f81f72241d");   // the md5 the migration's precondition pins
      const same = psql(`begin; ${body}
select (public._fx_orig_exposure('${P}'::uuid) = public.tw4_act_exposure('${P}'::uuid))::text || '|' || jsonb_array_length(public.tw4_act_exposure('${P}'::uuid)); rollback;`);
      const [eq, n] = same.split("|");
      expect(eq).toBe("true");
      expect(Number(n)).toBeGreaterThanOrEqual(4);   // the two locations above are each listed twice (funding continuity, number without authorization)
      expect(hasCode(callErr("tw4_act_exposure", randomUUID()), "42501")).toBe(true);
      expect(psql(`select public.tw4_act_exposure('${P}'::uuid) = public._tw4fx_exposure_rows()`)).toBe("t");
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------------
  describe("what tw4_act_exposure lists becomes deduped administrator alerts", () => {
    it("an ACTIVE location with no authorizations: one critical unfunded alert (funding continuity) and one critical unauthorized alert (number without rent authorization)", () => {
      const l = location({ state: "active" });
      expect(alertsOf(l)).toEqual([]);   // the check, not the fixture, raises them
      const out = check();
      expect(out.unfunded).toBeGreaterThanOrEqual(1);
      expect(out.unauthorized).toBeGreaterThanOrEqual(1);
      const month = monthOf(l);
      const fund = alertsOf(l, "funding_exposure_unfunded");
      expect(fund.map((a) => [a.dedupe_key, a.severity, a.studio_id])).toEqual([[`fx-fund:${l.studio}:campaign_authorization_short_or_missing:${month}`, "critical", l.studio]]);
      const noauth = alertsOf(l, "funding_exposure_unauthorized").filter((a) => a.dedupe_key.startsWith("fx-noauth:"));
      expect(noauth.map((a) => [a.dedupe_key, a.severity])).toEqual([[`fx-noauth:${l.studio}:${month}`, "critical"]]);
      for (const a of [...fund, ...noauth]) expectClean(a, [l.number, l.pn, "FX World"]);
      // replay: nothing new for this location
      const before = alertsOf(l).map((a) => a.dedupe_key);
      check();
      expect(alertsOf(l).map((a) => a.dedupe_key)).toEqual(before);
    });

    it("a SUSPENDED or READY location is a warning (not critical); a location in an earlier state is not a funding-continuity exposure", () => {
      const s = location({ state: "suspended" });
      const early = location({ state: "campaign_pending" });
      check();
      expect(alertsOf(s, "funding_exposure_unfunded").map((a) => a.severity)).toEqual(["warning"]);
      expect(alertsOf(early, "funding_exposure_unfunded")).toEqual([]);
      expect(alertsOf(early, "funding_exposure_unauthorized").filter((a) => a.dedupe_key.startsWith("fx-noauth:")).length).toBe(1);   // its live number still costs DanceFlow
    });

    it("a location whose number has an active rent authorization is not 'without authorization'; another tenant's alerts never name it", () => {
      const l = location({ state: "campaign_pending" });
      authFixture(l, "number");
      const other = location({ state: "active" });
      check();
      expect(alertsOf(l, "funding_exposure_unauthorized").filter((a) => a.dedupe_key.startsWith("fx-noauth:"))).toEqual([]);
      for (const a of alertsOf(other)) {
        expect(a.legal_entity_id).toBe(other.entity);
        expect(a.dedupe_key).not.toContain(l.studio);
      }
      expect(alerts(`legal_entity_id <> '${l.entity}' and dedupe_key like '%${l.studio}%'`)).toEqual([]);
    });

    it("the pilot's live number is a monthly warning (DanceFlow pays until each month is approved); never an owner alert", () => {
      const l = location({ state: "campaign_pending", pilot: true });
      check();
      const pilot = alertsOf(l, "funding_exposure_unauthorized").filter((a) => a.dedupe_key.startsWith("fx-pilot:"));
      expect(pilot.map((a) => [a.dedupe_key, a.severity])).toEqual([[`fx-pilot:${l.studio}:${monthOf(l)}`, "warning"]]);
      expect(alerts(`studio_id = '${l.studio}' and audience <> 'admin'`)).toEqual([]);
    });

    it("an active rent authorization on a managed location with no number to bill is raised (the owner could be charged for nothing)", () => {
      const l = location({ state: "campaign_pending" });
      authFixture(l, "number");
      replica(`update public.studio_sms_num_operations set superseded_at = now() where id = '${l.op}';`);   // the purchase is retired in the ledger
      const listed = call<Array<{ studio_id: string; reason: string }>>("tw4_act_exposure", P).filter((x) => x.studio_id === l.studio).map((x) => x.reason);
      check();
      if (listed.includes("authorization_without_number")) {
        expect(alertsOf(l, "funding_exposure_unauthorized").filter((a) => a.dedupe_key === `fx-nonum:${l.studio}:${monthOf(l)}`).length).toBe(1);
      } else {
        // the ledger reports the retired purchase as indeterminate rather than not billable: then it must be alerted as such
        expect(listed).toContain("rent_basis_indeterminate");
        expect(alertsOf(l, "funding_exposure_unauthorized").filter((a) => a.dedupe_key === `fx-basis:${l.studio}:${monthOf(l)}`).length).toBe(1);
      }
    });

    it("a listed location with no legal business is COUNTED as unattributed, not dropped silently and not attached to anyone", () => {
      const studio = randomUUID();
      psql(`insert into public.studios (id, name, slug, public_name, timezone) values ('${studio}', 'FX orphan', 'fx-orphan-${hex(4)}', null, 'UTC');`);
      replica(`insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at)
        values ('${randomUUID()}', '${studio}', 'active', 'FX orphan LLC', 'llc', '7777', 1, now());`);
      expect(call<Array<{ studio_id: string; funding: { detail: string } }>>("tw4_act_exposure", P).find((x) => x.studio_id === studio)?.funding.detail).toBe("no_legal_entity");
      expect(check().unattributed).toBeGreaterThanOrEqual(1);
      expect(alerts(`studio_id = '${studio}' or dedupe_key like '%${studio}%'`)).toEqual([]);
    });

    it("two checks running at once raise each alert exactly once", async () => {
      const l = location({ state: "active" });
      const [a, b] = await Promise.all([psqlAsync("select public.tw4_rfl_funding_exposure_check()::text;"), psqlAsync("select public.tw4_rfl_funding_exposure_check()::text;")]);
      expect(a.err).toBe("");
      expect(b.err).toBe("");
      const keys = alertsOf(l).map((x) => x.dedupe_key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual(expect.arrayContaining([`fx-fund:${l.studio}:campaign_authorization_short_or_missing:${monthOf(l)}`, `fx-noauth:${l.studio}:${monthOf(l)}`]));
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------------
  describe("sufficient credit before a monthly charge, and an unfunded charge is recorded, alerted and later charged exactly once", () => {
    it("insufficient settled credit: recorded UNFUNDED (not dropped), no money moves, the administrator is alerted once; a top-up then charges once; replay is safe", () => {
      const w = world({ fund: 100 });
      register(w, "campaign");
      const auth = authFixture(w, "monthly");
      const cur = monthOf(w);
      chargedFixture(w, auth, "monthly", keyAdd(cur, -1));   // the previous month is paid: the service issue then reflects THIS month's outcome
      const before = money(w);
      expect(charge(auth, cur)).toMatchObject({ outcome: "unfunded", reason: "insufficient settled credit", replayed: false });
      expect(money(w)).toBe(before);
      expect(chargeRow(auth, cur)).toBe("unfunded|insufficient settled credit|0");
      expect(psql(`select public._tw4rc_service_issue('${w.studio}')`)).toBe("unfunded");
      expect(alertsOf(w, "funding_exposure_unfunded")).toEqual([]);
      check();
      const unf = alertsOf(w, "funding_exposure_unfunded");
      const chargeId = psql(`select id from public.studio_sms_recurring_charges where authorization_id = '${auth}' and period_key = '${cur}'`);
      expect(unf.map((a) => [a.dedupe_key, a.severity])).toEqual([[`fx-unf:${chargeId}`, "critical"]]);
      expectClean(unf[0]);
      // retried while still unfunded: same row, one more attempt, no new alert
      expect(charge(auth, cur).outcome).toBe("unfunded");
      expect(chargeRow(auth, cur)).toBe("unfunded|insufficient settled credit|1");
      check();
      expect(alertsOf(w, "funding_exposure_unfunded").length).toBe(1);
      // funded: charged exactly once
      call("tw4_credit_adjust", w.entity, 5_000, `fx-topup-${hex(4)}`, "fixture top-up for the FX suite", P);
      expect(charge(auth, cur)).toMatchObject({ outcome: "charged", replayed: false });
      expect(charge(auth, cur)).toMatchObject({ outcome: "charged", replayed: true });
      expect(captures(w)).toBe(1);
      expect(psql(`select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}'`)).toBe(String(100 + 5_000 - PRICE.monthly));
      check();
      expect(alertsOf(w, "funding_exposure_unfunded").length).toBe(1);   // nothing new once charged
    });

    it("reserved credit is not spendable: balance above the price but balance minus reservations below it is unfunded", () => {
      const w = world({ fund: PRICE.monthly + 500 });
      register(w, "campaign");
      const auth = authFixture(w, "monthly");
      replica(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key)
        values ('${w.entity}', '${w.studio}', 'monthly', 1000, 'credit', 'reserved', 'fx-hold-${hex(4)}');
        update public.studio_sms_credit_accounts set reserved_cents = reserved_cents + 1000 where legal_entity_id = '${w.entity}';`);
      expect(charge(auth, monthOf(w))).toMatchObject({ outcome: "unfunded" });
      expect(captures(w)).toBe(0);
    });

    it("an unfunded charge for a fee with NO live resource is not a DanceFlow exposure alert (nothing is being billed)", () => {
      const w = world({ fund: 100 });
      const auth = authFixture(w, "monthly");
      replica(`insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reason)
        values ('${auth}', '${w.entity}', '${w.studio}', 'monthly', '${monthOf(w)}', ${PRICE.monthly}, 'unfunded', 'insufficient settled credit');`);
      check();
      expect(alertsOf(w, "funding_exposure_unfunded")).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------------
  describe("7-day grace, then suspension while the provider keeps billing", () => {
    it("an uncovered fee whose grace ends within 72 hours is warned once per resource and period; a fresh or a covered resource is not", () => {
      const near = world();
      const nearRes = register(near, "campaign");
      age(nearRes, "5 days");
      const fresh = world();
      age(register(fresh, "campaign"), "1 day");
      const covered = world();
      const coveredRes = register(covered, "campaign");
      age(coveredRes, "5 days");
      const ca = authFixture(covered, "monthly");
      for (const k of [keyAdd(monthOf(covered), -1), monthOf(covered)]) chargedFixture(covered, ca, "monthly", k);
      check();
      const g = alertsOf(near, "funding_exposure_grace_ending");
      expect(g.length).toBeGreaterThanOrEqual(1);
      expect(g.length).toBeLessThanOrEqual(2);
      for (const a of g) {
        expect(a.resource_id).toBe(nearRes);
        expect(a.dedupe_key).toMatch(new RegExp(`^fx-grace:${nearRes}:\\d{4}-\\d{2}$`));
        expect(a.summary).toContain("business time");
        expectClean(a);
      }
      expect(alertsOf(fresh, "funding_exposure_grace_ending")).toEqual([]);
      expect(alertsOf(covered, "funding_exposure_grace_ending")).toEqual([]);
      const n = g.length;
      check();
      expect(alertsOf(near, "funding_exposure_grace_ending").length).toBe(n);
    });

    it("past grace: sending is suspended, the provider resource stays live, the exposure opens, and the administrator is told DanceFlow pays until a dual-control cancellation", () => {
      const w = world();
      const res = register(w, "campaign");
      age(res, "75 days");
      expect(psql(`select public._tw4rc_service_state('${w.studio}')`)).toBe("suspended");
      expect(scan(w).opened).toBeGreaterThanOrEqual(1);
      expect(psql(`select provider_state from public.studio_sms_provider_resources where id = '${res}'`)).toBe("active");   // suspension never cancels at the provider
      expect(alertsOf(w, "funding_exposure_unauthorized")).toEqual([]);
      check();
      const open = alertsOf(w, "funding_exposure_unauthorized").filter((a) => a.dedupe_key.startsWith("fx-open:"));
      expect(open.map((a) => [a.dedupe_key, a.severity, a.resource_id])).toEqual([[`fx-open:${res}:${monthOf(w)}`, "critical", res]]);
      expect(open[0].summary).toMatch(/dual-control cancellation/);
      expectClean(open[0]);
      check();
      expect(alertsOf(w, "funding_exposure_unauthorized").filter((a) => a.dedupe_key.startsWith("fx-open:")).length).toBe(1);
    });

    it("a resource confirmed cancelled at the provider is no longer reported as open exposure", () => {
      const w = world();
      const res = register(w, "campaign");
      age(res, "75 days");
      scan(w);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", res, P, ref("cancel"), "owner_written", "The owner asked us in writing to cancel this campaign", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      expect(psql(`select provider_state from public.studio_sms_provider_resources where id = '${res}'`)).toBe("cancelled");
      check();
      expect(alertsOf(w, "funding_exposure_unauthorized").filter((a) => a.dedupe_key.startsWith("fx-open:"))).toEqual([]);
      expect(alertsOf(w, "funding_exposure_grace_ending")).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------------
  describe("tw4_recurring_charge refusals and holds (the reasons an administrator sees)", () => {
    it("the pilot business is refused (each recurring operation needs its own approval); nothing moves", () => {
      const p = world({ pilot: true });
      register(p, "campaign");
      const auth = authFixture(p, "monthly");
      const before = money(p);
      expect(charge(auth, monthOf(p))).toMatchObject({ outcome: "refused", reason: "pilot business: each recurring operation needs its own approval" });
      expect(money(p)).toBe(before);
    });

    it("revoked, expired and limit-reached authorizations are refused with their own reason; a period outside current/previous is an error", () => {
      const w = world();
      register(w, "campaign");
      const cur = monthOf(w);
      const revoked = authFixture(w, "monthly", { status: "revoked" });
      expect(charge(revoked, cur)).toMatchObject({ outcome: "refused", reason: "revoked" });
      const w2 = world();
      register(w2, "campaign");
      const expired = authFixture(w2, "monthly", { expiresInDays: -1 });
      expect(charge(expired, monthOf(w2))).toMatchObject({ outcome: "refused", reason: "outside the authorized term" });
      const w3 = world();
      register(w3, "campaign");
      const capped = authFixture(w3, "monthly", { limitPeriods: 1 });
      chargedFixture(w3, capped, "monthly", keyAdd(monthOf(w3), -1));
      expect(charge(capped, monthOf(w3))).toMatchObject({ outcome: "refused", reason: "authorized spending limit reached" });
      expect(captures(w3)).toBe(0);
      for (const k of [keyAdd(cur, 1), keyAdd(cur, -2)]) expect(hasCode(callErr("tw4_recurring_charge", revoked, k, null), "22023")).toBe(true);
    });

    it("month boundaries follow the business's timezone, not UTC (keys, month starts, the grace start and which periods may be charged)", () => {
      const la = world({ tz: "America/Los_Angeles" });
      const utc = world();
      call("_tw4ml_ensure_tz", la.entity);
      const key = (w: World, ts: string) => psql(`select public._tw4ml_month_key('${w.entity}', '${ts}'::timestamptz)`);
      expect(key(la, "2027-01-01 07:59:59+00")).toBe("2026-12");
      expect(key(la, "2027-01-01 08:00:00+00")).toBe("2027-01");
      expect(key(utc, "2027-01-01 07:59:59+00")).toBe("2027-01");
      expect(psql(`select public._tw4ml_month_start('${la.entity}', '2027-01') = '2027-01-01 08:00:00+00'::timestamptz`)).toBe("t");
      const res = register(la, "campaign");
      age(res, "400 days");
      expect(psql(`select public._tw4rfl_due_from(r, '2027-01') = '2027-01-08 08:00:00+00'::timestamptz from public.studio_sms_provider_resources r where r.id = '${res}'`)).toBe("t");
      const auth = authFixture(la, "monthly");
      const cur = monthOf(la);
      expect(cur).toBe(psql(`select to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM')`));
      expect(charge(auth, cur).outcome).toBe("charged");
      expect(hasCode(callErr("tw4_recurring_charge", auth, keyAdd(cur, 1), null), "22023")).toBe(true);
      // the alert dedupe month is the business's month as well
      const l = location({ state: "active" });
      check();
      expect(alertsOf(l, "funding_exposure_unfunded")[0].dedupe_key.endsWith(`:${monthOf(l)}`)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------------
  describe("thresholds on recorded open exposure", () => {
    it("one business at or above its threshold is raised once a month; a business below it is not; the platform total raises one platform alert", () => {
      const big = world();
      const small = world();
      /** one live number resource of the business with recorded OPEN exposure rows (fixture), one per [period, expected provider cents] */
      const exposure = (w: World, rows: Array<[string, number]>) => {
        const res = randomUUID();
        replica(`insert into public.studio_sms_provider_resources (id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, fee_kind, source, registered_by, registered_at)
            values ('${res}', '${w.entity}', '${w.studio}', '${w.account}', 'number', '${sid("PN")}', '${e164()}', 'number', 'admin', '${P}', now() - interval '400 days');
          ${rows.map(([period, cents]) => `insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents)
            values ('${res}', '${w.entity}', '${w.studio}', '${period}', 'no_authorization', ${cents});`).join("
")}`);
      };
      const entityThreshold = Number(psql("select public._tw4fx_entity_threshold_cents()"));
      const platformThreshold = Number(psql("select public._tw4fx_platform_threshold_cents()"));
      expect([entityThreshold, platformThreshold]).toEqual([1000, 5000]);
      exposure(small, [[monthOf(small), entityThreshold - 1]]);
      check();
      expect(alerts(`legal_entity_id = '${small.entity}' and kind = 'funding_exposure_threshold'`)).toEqual([]);   // just below: nothing
      expect(alerts(`dedupe_key like 'fx-thr-all:%'`)).toEqual([]);
      exposure(big, [[monthOf(big), entityThreshold], [keyAdd(monthOf(big), -1), platformThreshold]]);
      check();
      expect(alertsOf(big, "funding_exposure_threshold").map((a) => [a.dedupe_key, a.severity, a.studio_id])).toEqual(expect.arrayContaining([[`fx-thr:${big.entity}:${monthOf(big)}`, "critical", null]]));
      expect(alerts(`legal_entity_id = '${small.entity}' and kind = 'funding_exposure_threshold'`)).toEqual([]);
      const platform = alerts(`dedupe_key like 'fx-thr-all:%'`);
      expect(platform.length).toBe(1);
      expect(platform[0].legal_entity_id).toBe(big.entity);   // the largest share carries it, so the recipient function can address it
      for (const a of [...alertsOf(big, "funding_exposure_threshold"), ...platform]) expectClean(a);
      check();
      expect(alerts(`kind = 'funding_exposure_threshold' and legal_entity_id = '${big.entity}'`).length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------------
  describe("notification only, privileges and the rollback", () => {
    it("the check changes no money, authorization, charge, resource, exposure, sender, onboarding, inbound or opt-out row", () => {
      location({ state: "active" });
      const tables = ["studio_sms_credit_ledger", "studio_sms_credit_accounts", "studio_sms_credit_reservations", "studio_sms_recurring_authorizations", "studio_sms_recurring_charges",
        "studio_sms_provider_resources", "studio_sms_provider_exposure", "studio_sms_provider_cancel_ops", "studio_sms_billed_senders", "studio_sms_onboarding", "studio_sms_num_operations",
        "studio_sms_inbound_usage", "studio_sms_pilot_exceptions"];
      const fp = () => tables.map((t) => psql(`select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.${t} x`)).join("|");
      const before = fp();
      check();
      expect(fp()).toBe(before);
      const def = psql("select replace(prosrc, chr(13), '') from pg_proc where oid = 'public.tw4_rfl_funding_exposure_check()'::regprocedure");
      expect(def).not.toMatch(/\b(insert|update|delete|truncate)\b/i);   // its only write is through _tw4rfl_alert
      expect(def).not.toMatch(/opt_?out|tw4_sender|_tw4c_post|tw4_credit/i);
    });

    it("only the service role may run the check; the helpers are not callable by any API role; tw4_act_exposure keeps its grants", () => {
      const can = (role: string, fn: string) => psql(`select has_function_privilege('${role}', '${fn}', 'execute')`);
      expect(can("service_role", "public.tw4_rfl_funding_exposure_check()")).toBe("t");
      expect(can("service_role", "public.tw4_act_exposure(uuid)")).toBe("t");
      for (const role of ["anon", "authenticated"]) {
        expect(can(role, "public.tw4_rfl_funding_exposure_check()")).toBe("f");
        expect(can(role, "public.tw4_act_exposure(uuid)")).toBe("f");
      }
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const fn of ["public._tw4fx_exposure_rows()", "public._tw4fx_entity_threshold_cents()", "public._tw4fx_platform_threshold_cents()", "public._tw4fx_grace_warning()"]) expect(can(role, fn)).toBe("f");
      }
      expect(psql(`select count(*) from pg_proc where proname in ('tw4_rfl_funding_exposure_check', '_tw4fx_exposure_rows') and prosecdef and array_to_string(proconfig, ',') like 'search_path=pg_catalog, public, pg_temp'`)).toBe("2");
    });

    it("the rollback REFUSES while alert rows use the new kinds; a clean rollback restores the 20261208 body and the kind list; the migration re-applies", () => {
      const err = psqlError(file(RB));
      expect(err).toMatch(/funding exposure alert rollback refused/);
      expect(err).toMatch(/55000/);
      expect(psql("select to_regprocedure('public.tw4_rfl_funding_exposure_check()') is not null")).toBe("t");
      const kindsBefore = psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'");
      const bodyAfterMigration = psql("select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.tw4_act_exposure(uuid)'::regprocedure");
      // history is never deleted by the rollback; the test removes ONLY its own fixture alerts (isolated database) to prove the clean path
      replica(`delete from public.studio_sms_rfl_alert_deliveries where alert_id in (select id from public.studio_sms_provider_alerts where kind = any (array[${KINDS.map((k) => `'${k}'`).join(", ")}]));
        delete from public.studio_sms_provider_alerts where kind = any (array[${KINDS.map((k) => `'${k}'`).join(", ")}]);`);
      psql(file(RB));
      expect(psql("select to_regprocedure('public.tw4_rfl_funding_exposure_check()') is null and to_regprocedure('public._tw4fx_exposure_rows()') is null")).toBe("t");
      expect(psql("select left(md5(replace(prosrc, chr(13), '')), 12) from pg_proc where oid = 'public.tw4_act_exposure(uuid)'::regprocedure")).toBe("86f81f72241d");
      expect(psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'")).not.toContain("funding_exposure_");
      expect(psqlError(file(RB))).toMatch(/not applied/);   // a second rollback refuses
      psql(file(FWD));
      expect(psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'")).toBe(kindsBefore);
      expect(psql("select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.tw4_act_exposure(uuid)'::regprocedure")).toBe(bodyAfterMigration);
      expect(psqlError(file(FWD))).toMatch(/already applied/);
      expect(total(check())).toBeGreaterThan(0);   // working again after the re-apply
    });
  });
});
