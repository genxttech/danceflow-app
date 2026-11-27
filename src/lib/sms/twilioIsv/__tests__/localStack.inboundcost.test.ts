/**
 * Absorbed inbound cost controls (20270222190000) against a REAL schema: a 10,000-segment flood in dollars recorded through the REAL tw4_inbound_record, alerts for
 * every business (volume, absorbed day/month, anomaly against the trailing average with an absolute floor, daily cap), the automatic response behind its database
 * switch (default OFF) that suppresses ONLY non-compliance automatic replies until the business's next local day or an administrator's clearance, STOP / START /
 * HELP never suppressed and still recorded at the cap, wrong-tenant isolation, replayed message SIDs never counted twice, day and month boundaries in the business
 * timezone, the pilot business unchanged, configuration validation and audit, privileges from the catalog, and the rollback's refusal.
 * Synthetic fixtures; no Twilio, no SMS, no Stripe, no email.
 *
 * LOCAL QA ONLY, through the isolated harness (ISO_QA_MARKER=1 creates the tw4_local_qa_only marker the price fixture requires):
 *   ISO_QA_MARKER=1 node scripts/qa/iso-qa.mjs run numeric -- src/lib/sms/twilioIsv/__tests__/localStack.inboundcost.test.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pilotExceptionArgs } from "./rflEvidenceHelper";
import { seedPrice } from "./priceFixture";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4IB_DB ?? "postgres";
const enabled = Boolean(PG);

const RUN = randomBytes(3).toString("hex");
const hex = (n: number) => randomBytes(n).toString("hex");
const uid = (n: number) => `1b${RUN}-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;
const ADMIN = uid(1);
const NOT_ADMIN = uid(2);
const MIG = join(__dirname, "../../../supabase/migrations");
const MIGRATION = "20270222190000_twilio_inbound_absorbed_cost_controls.sql";

const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 26 }).trim();
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", sqlArgs, { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);
const count = (sql: string) => Number(psql(`select count(*) from (${sql}) q`));
const sid = (prefix: string) => `${prefix}${hex(16)}`;
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const json = <T = Record<string, unknown>>(sql: string) => JSON.parse(psql(sql)) as T;

type World = { entity: string; studios: string[]; account: string; tz: string };

function world(opts: { tz?: string; fund?: number; pilot?: boolean } = {}): World {
  const w: World = { entity: randomUUID(), studios: [randomUUID(), randomUUID()], account: sid("AC"), tz: opts.tz ?? "UTC" };
  psql(`begin;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studios[0]}', 'IB ${hex(3)}', 'ib-${hex(4)}', null, ${q(w.tz)}), ('${w.studios[1]}', 'IB ${hex(3)}', 'ib-${hex(4)}', null, ${q(w.tz)});
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', '${opts.pilot ? "ConfiDance Unlimited, LLC" : `IB World ${hex(3)} LLC`}', '7772', ${opts.pilot ? 15000 : 500000}, '${ADMIN}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${w.studios[0]}', '${w.entity}', 'founding', '${ADMIN}', 'fixture: earliest location', now() - interval '60 days'),
  ('${w.studios[1]}', '${w.entity}', 'founding', '${ADMIN}', 'fixture: later location', now() - interval '59 days');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${w.entity}', '${w.account}', 'ib-${hex(3)}', 'test', 'active', '${ADMIN}');
commit;`);
  psql(`select public.tw4_credit_adjust('${w.entity}', ${opts.fund ?? 200_000}, 'ib-fund-${hex(4)}', 'fixture funding for the inbound cost suite', '${ADMIN}')::text`);
  if (opts.pilot) {
    const a = pilotExceptionArgs(psql, w.entity, 15000, `Founder written pilot approval ${RUN}`, ADMIN);
    const lit = (v: unknown) => (v === null ? "null" : typeof v === "number" ? String(v) : q(String(v)));
    psql(`select public.tw4_pilot_exception_create(${a.map(lit).join(", ")})::text`);
  }
  return w;
}

/** One inbound record written directly (fixture: any received time, any estimate). */
function inbound(w: World, r: { cls?: "ordinary" | "compliance"; seg?: number; est?: number | null; at?: string; sidValue?: string } = {}) {
  replica(`insert into public.studio_sms_inbound_usage (legal_entity_id, studio_id, provider_sid, account_sid, source, classification, segments, media, unit_price_cents, billable_cents, charged_cents,
      uncollected_cents, ceiling_cents, est_provider_cost_cents, reply_segments, est_reply_cost_cents, received_at)
    values ('${w.entity}', '${w.studios[0]}', '${r.sidValue ?? sid("SM")}', '${w.account}', 'webhook', '${r.cls ?? "compliance"}', ${r.seg ?? 1}, 0, null, 0, 0, 0, 0,
      ${r.est === undefined || r.est === null ? "null" : r.est}, null, null, ${r.at ?? "now()"});`);
}
/** The REAL recording function, as the webhook calls it (received now). */
const record = (w: World, providerSid: string, cls: "ordinary" | "compliance" = "ordinary", reply: string | null = null) =>
  json(`select public.tw4_inbound_record('${w.studios[0]}'::uuid, '${w.account}', '${providerSid}', 1, 0, '${cls}', ${reply === null ? "null" : q(reply)}, null, 'webhook')::text`);

const metrics = (w: World, at = "now()") => json<Record<string, string | number>>(`select public._tw4ib_metrics('${w.entity}', ${at})::text`);
const check = (at = "now()") => json<{ volume_alerts: number; absorbed_alerts: number; anomaly_alerts: number; cap_alerts: number; suppressed: number; errors: number }>(`select public._tw4ib_check(${at})::text`);
const replyAllowed = (account: string | null, kind: string, at = "now()") => psql(`select public._tw4ib_reply_allowed(${account === null ? "null" : q(account)}, ${q(kind)}, ${at})`);
const alertsOf = (w: World, kind?: string) =>
  json<Array<{ kind: string; dedupe_key: string; audience: string; severity: string; studio_id: string | null; summary: string }>>(
    `select coalesce(json_agg(json_build_object('kind', kind, 'dedupe_key', dedupe_key, 'audience', audience, 'severity', severity, 'studio_id', studio_id, 'summary', summary) order by created_at, id), '[]'::json)::text
       from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' ${kind ? `and kind = '${kind}'` : ""}`);
const setSwitch = (on: boolean) => psql(`select public.tw4_inbound_reply_cap_switch_set('${ADMIN}', ${on}, 'suite switch change ${RUN} ${on ? "on" : "off"}')::text`);
const setConfig = (w: World | null, settings: Record<string, unknown>) =>
  json(`select public.tw4_inbound_cost_controls_set(${w ? `'${w.entity}'` : "null"}, '${ADMIN}', '${JSON.stringify(settings)}'::jsonb, 'suite configuration change ${RUN}')::text`);
const suppression = (w: World) => json<Array<{ local_day: string; trigger: string; source: string; cleared: boolean }>>(
  `select coalesce(json_agg(json_build_object('local_day', local_day, 'trigger', trigger, 'source', source, 'cleared', cleared_at is not null) order by local_day), '[]'::json)::text
     from public.studio_sms_inbound_reply_suppressions where legal_entity_id = '${w.entity}'`);
const ERROR_KINDS = ["error_unavailable", "error_invalid", "error_unrecognized", "error_unrouted"];

describe.skipIf(!enabled)("absorbed inbound cost controls (20270222190000, real schema)", () => {
  let flood: World;
  let other: World;
  let pilot: World;

  beforeAll(() => {
    expect(psql("select to_regclass('public.tw4_local_qa_only') is not null")).toBe("t");   // isolated QA database only
    expect(psql("select to_regprocedure('public.tw4_inbound_cost_controls_check()') is not null")).toBe("t");
    if (psql("select legal_entity_id from public.studio_sms_pilot_exceptions limit 1")) throw new Error("a pilot exception already exists: run on a fresh isolated stack");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at) values
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@inboundcost-e2e.test', now(), now(), now(), now()),
  ('${NOT_ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'user-${RUN}@inboundcost-e2e.test', now(), now(), now(), now());
insert into public.profiles (id, platform_role) values ('${ADMIN}', 'platform_admin'), ('${NOT_ADMIN}', null) on conflict (id) do update set platform_role = excluded.platform_role;
commit;`);
    // a published inbound price (2 cents to the studio, 1 cent estimated provider cost per segment) through the real dual-control workflow
    seedPrice(psql, { kind: "sms_inbound", customer: 2, provider: 1, description: "Inbound text (suite fixture)", approver: ADMIN, ifMissing: true });
    flood = world({ tz: "America/Chicago", fund: 1000 });   // $10.00 of credit
    other = world({ tz: "America/Chicago" });
    pilot = world({ pilot: true });
  });

  afterAll(() => {
    if (!enabled) return;
    psql(`update public.profiles set platform_role = null where id = '${ADMIN}';`);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("safe defaults", () => {
    it("the automatic response is OFF with no switch row; the effective configuration is the built-in defaults; alerts default on", () => {
      expect(count("select 1 from public.studio_sms_inbound_reply_cap_switch_log")).toBe(0);
      expect(psql("select public._tw4ib_switch_on()")).toBe("f");
      expect(json(`select public._tw4ib_config('${flood.entity}')::text`)).toEqual({
        alerts_enabled: true, daily_segment_alert: 200, daily_absorbed_alert_cents: 500, monthly_absorbed_alert_cents: 2000, anomaly_multiple: 5,
        anomaly_trailing_days: 7, anomaly_min_segments: 100, anomaly_min_absorbed_cents: 200, cap_daily_absorbed_cents: 1000, cap_daily_segments: 2000,
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("a flood of 10,000 inbound segments in one day, in dollars (real recording function)", () => {
    const sids: string[] = [];
    it("records every text (none refused): $20.00 charged down to the -$10.00 ceiling, $180.00 uncollected, $90.00 absorbed by DanceFlow", () => {
      for (let i = 0; i < 10_000; i++) sids.push(sid("SM"));
      const chunks: string[] = [];
      for (let i = 0; i < sids.length; i += 250) {
        chunks.push(`do $f$ declare s text; begin foreach s in array array[${sids.slice(i, i + 250).map((s) => `'${s}'`).join(",")}] loop
          perform public.tw4_inbound_record('${flood.studios[0]}'::uuid, '${flood.account}', s, 1, 0, 'ordinary', null, null, 'webhook'); end loop; end $f$;`);
      }
      psql(chunks.join("\n"));
      const totals = json<{ n: number; seg: number; charged: number; uncollected: number }>(`select json_build_object('n', count(*), 'seg', sum(segments), 'charged', sum(charged_cents), 'uncollected', sum(uncollected_cents))::text
        from public.studio_sms_inbound_usage where legal_entity_id = '${flood.entity}'`);
      expect(totals).toEqual({ n: 10_000, seg: 10_000, charged: 2000, uncollected: 18_000 });   // 1,000 texts x 2 cents charged; 9,000 x 2 cents uncollected
      expect(Number(psql(`select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${flood.entity}'`))).toBe(-1000);
      const m = metrics(flood);
      expect(m.segments_today).toBe(10_000);
      expect(m.absorbed_today_cents).toBe(9000);                // 9,000 uncollected texts x 1 cent estimated provider cost = $90.00 absorbed today
      expect(m.absorbed_month_cents).toBe(9000);
      expect(m.timezone).toBe("America/Chicago");
    });

    it("with the switch OFF: every alert is raised once (administrator, entity level, no amounts), nothing is suppressed, every reply is still allowed", () => {
      check();
      const kinds = alertsOf(flood).map((a) => `${a.kind}:${a.dedupe_key.split(":").slice(2).join(":")}`).sort();
      const day = String(metrics(flood).local_day).replace(/-/g, "");
      const month = String(metrics(flood).month_key);
      expect(kinds).toEqual([
        `sms_in_absorbed_high:day:${day}`, `sms_in_absorbed_high:month:${month}`, `sms_in_anomaly:${day}:absorbed`, `sms_in_anomaly:${day}:segments`,
        `sms_in_daily_cap:${day}`, `sms_in_volume_high:${day}`,
      ].sort());
      for (const a of alertsOf(flood)) {
        expect(a).toMatchObject({ audience: "admin", studio_id: null });
        expect(a.summary).not.toMatch(/\$|\d|\bcents?\b|\bbalance\b/i);
      }
      expect(alertsOf(flood, "sms_in_daily_cap")[0]).toMatchObject({ severity: "critical" });
      expect(alertsOf(flood, "sms_in_daily_cap")[0].summary).toMatch(/switched off/);
      expect(suppression(flood)).toEqual([]);
      for (const k of ERROR_KINDS) expect(replyAllowed(flood.account, k)).toBe("t");
      // a repeated scan raises nothing new
      check();
      expect(alertsOf(flood)).toHaveLength(6);
    });

    it("with the switch ON: the scan suppresses ONLY the non-compliance automatic replies of the flooded business", () => {
      setSwitch(true);
      const out = check();
      expect(out.suppressed).toBeGreaterThanOrEqual(1);
      expect(suppression(flood)).toEqual([expect.objectContaining({ trigger: "absorbed", source: "scan", cleared: false })]);
      for (const k of ERROR_KINDS) expect(replyAllowed(flood.account, k), k).toBe("f");
      expect(psql(`select public.tw4_inbound_auto_reply_allowed('${flood.account}', 'error_unrouted')`)).toBe("f");   // the service entry point agrees
      expect(count(`select 1 from public.studio_sms_inbound_cost_control_events where legal_entity_id = '${flood.entity}' and event = 'suppressed' and actor is null`)).toBe(1);
    });

    it("compliance replies are NEVER suppressed at the cap, and STOP / START / HELP are still recorded (never charged, never refused)", () => {
      for (const k of ["stop", "start", "help"]) expect(replyAllowed(flood.account, k), k).toBe("t");
      for (const word of ["You are unsubscribed.", "You are subscribed again.", "Reply STOP to opt out."]) {
        const s = sid("SM");
        expect(record(flood, s, "compliance", word)).toMatchObject({ recorded: true, replayed: false, classification: "compliance", charged_cents: 0, uncollected_cents: 0 });
        expect(count(`select 1 from public.studio_sms_inbound_usage where provider_sid = '${s}'`)).toBe(1);
      }
      // an ordinary text received at the cap is still recorded (never refused); with the business at its ceiling it is uncollected
      expect(record(flood, sid("SM"))).toMatchObject({ recorded: true, charged_cents: 0, uncollected_cents: 2 });
    });

    it("replayed and duplicate message SIDs are never counted twice (the recording returns the first record)", () => {
      const before = metrics(flood);
      for (const s of sids.slice(0, 50)) expect(record(flood, s)).toMatchObject({ recorded: true, replayed: true });
      const after = metrics(flood);
      expect(after.segments_today).toBe(before.segments_today);
      expect(after.absorbed_today_cents).toBe(before.absorbed_today_cents);
      // a duplicate row for an existing SID is refused by the table itself
      expect(psqlError(`begin; set local session_replication_role = replica; insert into public.studio_sms_inbound_usage (legal_entity_id, studio_id, provider_sid, account_sid, source, classification, segments, media, billable_cents, charged_cents, uncollected_cents, ceiling_cents, received_at)
        values ('${flood.entity}', '${flood.studios[0]}', '${sids[0]}', '${flood.account}', 'webhook', 'ordinary', 1, 0, 0, 0, 0, 0, now()); commit;`)).toMatch(/23505|duplicate key/);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("tenant isolation", () => {
    it("another business is not suppressed by the flooded business's cap; unknown and parent accounts are never suppressed; a malformed account is refused", () => {
      inbound(other, { seg: 5, est: 5 });
      expect(replyAllowed(other.account, "error_invalid")).toBe("t");
      expect(suppression(other)).toEqual([]);
      expect(replyAllowed(sid("AC"), "error_invalid")).toBe("t");
      expect(replyAllowed(null, "error_invalid")).toBe("t");
      expect(psqlError(`select public._tw4ib_reply_allowed('ACnothex', 'error_invalid', now())`)).toMatch(/22023/);
      expect(psqlError(`select public._tw4ib_reply_allowed('${other.account}', 'ordinary_thanks', now())`)).toMatch(/22023/);
    });

    it("a configuration override for one business never changes another's", () => {
      setConfig(other, { cap_daily_segments: 3 });
      expect(json<Record<string, number>>(`select public._tw4ib_config('${other.entity}')::text`).cap_daily_segments).toBe(3);
      expect(json<Record<string, number>>(`select public._tw4ib_config('${flood.entity}')::text`).cap_daily_segments).toBe(2000);
      expect(replyAllowed(other.account, "error_invalid")).toBe("f");                     // 5 segments >= its own cap of 3
      expect(suppression(other)).toEqual([expect.objectContaining({ trigger: "segments", source: "reply_check" })]);
      setConfig(other, { cap_daily_segments: null });                                     // null removes the override
      expect(json<Record<string, number>>(`select public._tw4ib_config('${other.entity}')::text`).cap_daily_segments).toBe(2000);
    });

    it("clearing one business never clears another; only a platform administrator may clear, with a note; unknown business refused", () => {
      expect(psqlError(`select public.tw4_inbound_reply_suppression_clear('${flood.entity}', '${NOT_ADMIN}', 'not an administrator clearing')`)).toMatch(/42501/);
      expect(psqlError(`select public.tw4_inbound_reply_suppression_clear('${flood.entity}', '${ADMIN}', 'short')`)).toMatch(/22023/);
      expect(psqlError(`select public.tw4_inbound_reply_suppression_clear('${randomUUID()}', '${ADMIN}', 'an unknown business entirely')`)).toMatch(/22023/);
      expect(json(`select public.tw4_inbound_reply_suppression_clear('${other.entity}', '${ADMIN}', 'reviewed the other business traffic ${RUN}')::text`)).toMatchObject({ cleared: true });
      expect(replyAllowed(other.account, "error_invalid")).toBe("t");
      expect(replyAllowed(flood.account, "error_invalid")).toBe("f");                     // still suppressed
      expect(psqlError(`select public.tw4_inbound_cost_controls_status('${NOT_ADMIN}', '${flood.entity}')`)).toMatch(/42501/);
      expect(json(`select public.tw4_inbound_cost_controls_status('${ADMIN}', '${flood.entity}')::text`)).toMatchObject({ switch_on: true, suppression: "active", suppression_trigger: "absorbed" });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("the administrator clear (audited) and the rest of the day", () => {
    it("clears today's suppression with an audited note; a second clear finds nothing; the cap does not suppress again that day", () => {
      const out = json(`select public.tw4_inbound_reply_suppression_clear('${flood.entity}', '${ADMIN}', 'flood source identified and blocked at carrier ${RUN}')::text`);
      expect(out).toMatchObject({ cleared: true, local_day: metrics(flood).local_day });
      expect(count(`select 1 from public.studio_sms_inbound_cost_control_events where legal_entity_id = '${flood.entity}' and event = 'cleared' and actor = '${ADMIN}' and note like '%flood source identified%'`)).toBe(1);
      expect(count(`select 1 from public.studio_sms_inbound_reply_suppressions where legal_entity_id = '${flood.entity}' and cleared_by = '${ADMIN}' and clear_note like 'flood source%'`)).toBe(1);
      for (const k of ERROR_KINDS) expect(replyAllowed(flood.account, k)).toBe("t");
      expect(json(`select public.tw4_inbound_reply_suppression_clear('${flood.entity}', '${ADMIN}', 'second clear on the same day ${RUN}')::text`)).toMatchObject({ cleared: false });
      expect(check().suppressed).toBe(0);
      expect(replyAllowed(flood.account, "error_invalid")).toBe("t");
    });

    it("a suppression row is never deleted and never rewritten (only one clearance)", () => {
      expect(psqlError(`delete from public.studio_sms_inbound_reply_suppressions where legal_entity_id = '${flood.entity}'`)).toMatch(/never deleted/);
      expect(psqlError(`update public.studio_sms_inbound_reply_suppressions set clear_note = 'rewritten clearance note' where legal_entity_id = '${flood.entity}'`)).toMatch(/only be cleared, once/);
      expect(psqlError(`update public.studio_sms_inbound_reply_suppressions set trigger = 'segments' where legal_entity_id = '${flood.entity}'`)).toMatch(/only be cleared, once/);
      expect(psqlError(`delete from public.studio_sms_inbound_cost_control_events where legal_entity_id = '${flood.entity}'`)).toMatch(/append-only/);
    });

    it("the cap alert says what is actually true: 'suppressed' when a suppression is active, 'cleared' when the administrator already cleared today (switch on)", () => {
      const active = world();
      const cleared = world();
      for (const w of [active, cleared]) setConfig(w, { cap_daily_segments: 5 });
      for (const w of [active, cleared]) inbound(w, { seg: 6 });
      expect(replyAllowed(cleared.account, "error_invalid")).toBe("f");    // the reply path suppressed it first
      json(`select public.tw4_inbound_reply_suppression_clear('${cleared.entity}', '${ADMIN}', 'cleared before the scan ran ${RUN}')::text`);
      check();
      expect(alertsOf(active, "sms_in_daily_cap")[0].summary).toMatch(/are suppressed until/);
      expect(alertsOf(cleared, "sms_in_daily_cap")[0].summary).toMatch(/cleared by a platform administrator today/);
      expect(alertsOf(cleared, "sms_in_daily_cap")[0].summary).not.toMatch(/are suppressed until/);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("days and months in the business's timezone", () => {
    it("a local day is local midnight to local midnight (UTC+14), and a suppression lasts only until the next local day", () => {
      const k = world({ tz: "Pacific/Kiritimati" });
      // a past local day D (three local days ago) and its start S
      const S = psql(`select ((((now() at time zone 'Pacific/Kiritimati')::date - 3)::timestamp) at time zone 'Pacific/Kiritimati')::text`);
      inbound(k, { seg: 7, at: `'${S}'::timestamptz - interval '1 minute'` });       // the day before
      inbound(k, { seg: 11, at: `'${S}'::timestamptz` });                             // first instant of D
      inbound(k, { seg: 13, at: `'${S}'::timestamptz + interval '23 hours 59 minutes'` });
      inbound(k, { seg: 17, at: `'${S}'::timestamptz + interval '24 hours'` });       // first instant of D + 1
      const m = metrics(k, `'${S}'::timestamptz + interval '12 hours'`);
      expect(m.segments_today).toBe(24);
      expect(m.timezone).toBe("Pacific/Kiritimati");
      expect(new Date(String(m.day_starts_at)).getUTCHours()).toBe(10);              // local midnight is 10:00 UTC of the previous UTC day
      expect(metrics(k, `'${S}'::timestamptz - interval '1 second'`).segments_today).toBe(7);
      // a cap reached on D suppresses on D only
      setConfig(k, { cap_daily_segments: 20 });
      expect(replyAllowed(k.account, "error_invalid", `'${S}'::timestamptz + interval '12 hours'`)).toBe("f");
      expect(suppression(k)).toEqual([expect.objectContaining({ local_day: m.local_day, trigger: "segments" })]);
      expect(replyAllowed(k.account, "error_invalid", `'${S}'::timestamptz + interval '36 hours'`)).toBe("t");   // D + 1: 17 segments, under the cap
      expect(replyAllowed(k.account, "error_invalid")).toBe("t");                                                 // today
    });

    it("a month is the business's local month: a text one minute before local month start belongs to the previous month", () => {
      const m = world({ tz: "America/Los_Angeles" });
      const key = psql(`select public._tw4ml_key_add(public._tw4ml_month_key('${m.entity}', now()), -1)`);
      const MS = psql(`select public._tw4ml_month_start('${m.entity}', '${key}')::text`);
      const MN = psql(`select public._tw4ml_month_start('${m.entity}', public._tw4ml_key_add('${key}', 1))::text`);
      inbound(m, { est: 300, at: `'${MS}'::timestamptz - interval '1 minute'` });
      inbound(m, { est: 400, at: `'${MS}'::timestamptz` });
      inbound(m, { est: 500, at: `'${MN}'::timestamptz - interval '1 minute'` });
      inbound(m, { est: 600, at: `'${MN}'::timestamptz` });
      const mt = metrics(m, `'${MS}'::timestamptz + interval '2 days'`);
      expect(mt.month_key).toBe(key);
      expect(mt.absorbed_month_cents).toBe(900);
      expect(["7", "8"]).toContain(psql(`select extract(hour from '${MS}'::timestamptz at time zone 'UTC')::int`));   // local midnight in Los Angeles is 07:00 or 08:00 UTC
      setConfig(m, { monthly_absorbed_alert_cents: 800, daily_absorbed_alert_cents: 100000, anomaly_min_absorbed_cents: 100000 });
      check(`'${MS}'::timestamptz + interval '2 days'`);
      expect(alertsOf(m, "sms_in_absorbed_high").map((a) => a.dedupe_key)).toEqual([`inba:${m.entity}:month:${key}`]);
      check(`'${MS}'::timestamptz + interval '3 days'`);                                // same month: no second monthly alert
      expect(alertsOf(m, "sms_in_absorbed_high")).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("anomaly detection against the trailing average and an absolute floor", () => {
    const history = (w: World, perDay: number, est: number | null = null) => {
      // a stored text has at most 20 segments: a day's volume is split into texts of up to 20 (the estimate goes on the first one only)
      for (let i = 1; i <= 7; i++) {
        for (let left = perDay, first = true; left > 0; left -= 20, first = false) {
          inbound(w, { seg: Math.min(20, left), est: first ? est : null, at: `((((now() at time zone '${w.tz}')::date - ${i})::timestamp + interval '12 hours') at time zone '${w.tz}')` });
        }
      }
    };
    const today = (w: World, seg: number, est: number | null = null) => inbound(w, { seg: Math.min(seg, 20), est, at: `((((now() at time zone '${w.tz}')::date)::timestamp + interval '1 minute') at time zone '${w.tz}')` });
    const todayN = (w: World, seg: number, est: number | null = null) => { for (let left = seg; left > 0; left -= 20) today(w, Math.min(20, left), est); };

    it("raises segments and absorbed anomalies above multiple x trailing average AND at/above the floor; not below the floor; not within the multiple", () => {
      const hot = world();
      history(hot, 20, 10);                     // 20 segments / 10 absorbed per day
      todayN(hot, 160);                          // 160 > 5 x 20 and >= 100
      today(hot, 1, 250);                        // 250 absorbed > 5 x 10 and >= 200
      const low = world();
      history(low, 10);
      todayN(low, 99);                           // 99 > 5 x 10 but under the floor of 100
      const steady = world();
      history(steady, 40);
      todayN(steady, 160);                       // 160 < 5 x 40
      const fresh = world();                    // no history at all: a first-day flood over the floor is an anomaly
      todayN(fresh, 120);
      check();
      expect(alertsOf(hot, "sms_in_anomaly").map((a) => a.dedupe_key.split(":").pop()).sort()).toEqual(["absorbed", "segments"]);
      expect(alertsOf(low, "sms_in_anomaly")).toHaveLength(0);
      expect(alertsOf(steady, "sms_in_anomaly")).toHaveLength(0);
      expect(alertsOf(fresh, "sms_in_anomaly").map((a) => a.dedupe_key.split(":").pop())).toEqual(["segments"]);
      expect(Number(metrics(hot).avg_segments)).toBe(20);
      // the multiple and the floor are configurable per business
      setConfig(steady, { anomaly_multiple: 2 });
      check();
      expect(alertsOf(steady, "sms_in_anomaly")).toHaveLength(1);
      setConfig(low, { anomaly_min_segments: 50 });
      check();
      expect(alertsOf(low, "sms_in_anomaly")).toHaveLength(1);
      // the daily volume alert for every non-pilot business is distinct from the anomaly (over 200 segments in the local day)
      expect(alertsOf(hot, "sms_in_volume_high")).toHaveLength(0);
      todayN(hot, 60);                           // 220
      check();
      expect(alertsOf(hot, "sms_in_volume_high")).toHaveLength(1);
      // alerts can be turned off per business
      const quiet = world();
      setConfig(quiet, { alerts_enabled: false });
      todayN(quiet, 300);
      check();
      expect(alertsOf(quiet)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("the pilot business is unchanged", () => {
    it("keeps its own 20261231140000 alerts only (no duplicate volume alert), its zero inbound ceiling, and with the switch OFF nothing is suppressed", () => {
      setSwitch(false);
      for (let i = 0; i < 16; i++) inbound(pilot, { seg: 20, est: 100 });         // 320 segments, 1600 absorbed today
      const legacy = json<{ allowance_warnings: number; allowance_critical: number; volume: number }>("select public.tw4_rfl_inbound_allowance_check()::text");
      expect(legacy).toEqual({ allowance_warnings: 1, allowance_critical: 0, volume: 1 });
      check();
      expect(alertsOf(pilot, "inbound_volume_high")).toHaveLength(1);
      expect(alertsOf(pilot, "sms_in_volume_high")).toHaveLength(0);
      expect(alertsOf(pilot, "inbound_absorbed_allowance")).toHaveLength(1);
      for (const k of ERROR_KINDS) expect(replyAllowed(pilot.account, k)).toBe("t");
      expect(suppression(pilot)).toEqual([]);
      expect(record(pilot, sid("SM"))).toMatchObject({ recorded: true });
      expect(Number(psql(`select ceiling_cents from public.studio_sms_inbound_usage where legal_entity_id = '${pilot.entity}' and source = 'webhook' and price_list_id is not null order by recorded_at desc limit 1`))).toBe(0);
    });

    it("the migration replaces no existing function (the recording, the pilot alert check and the reply counter are byte-for-byte untouched)", () => {
      const sql = readFileSync(join(MIG, MIGRATION), "utf8");
      const names = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)/gi)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(10);
      for (const n of names) expect(n, n).toMatch(/^(_tw4ib_|tw4_inbound_cost_controls_|tw4_inbound_auto_reply_allowed$|tw4_inbound_reply_cap_switch_set$|tw4_inbound_reply_suppression_clear$)/);
      expect(sql).not.toMatch(/or\s+replace/i);
      expect(sql.replace(/--.*$/gm, "")).not.toMatch(/_tw4c_post|tw4_credit_|\bhold\s*=|insert\s+into\s+public\.studio_sms_inbound_usage|update\s+public\.studio_sms_(credit|inbound_usage|pending|billed)/i);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("configuration and switch: platform administrators only, validated, audited", () => {
    it("refuses a non-administrator, an unknown key, an out-of-range value, a wrong type and a short reason", () => {
      const set = (actor: string, settings: string, reason = "a valid written reason") => psqlError(`select public.tw4_inbound_cost_controls_set(null, '${actor}', '${settings}'::jsonb, '${reason}')`);
      expect(set(NOT_ADMIN, '{"cap_daily_segments": 10}')).toMatch(/42501/);
      expect(set(ADMIN, '{"refuse_inbound": true}')).toMatch(/22023/);
      expect(set(ADMIN, '{"cap_daily_segments": 0}')).toMatch(/22023/);
      expect(set(ADMIN, '{"cap_daily_segments": -5}')).toMatch(/22023/);
      expect(set(ADMIN, '{"cap_daily_absorbed_cents": 10.5}')).toMatch(/22023/);
      expect(set(ADMIN, '{"anomaly_multiple": 1}')).toMatch(/22023/);
      expect(set(ADMIN, '{"anomaly_trailing_days": 90}')).toMatch(/22023/);
      expect(set(ADMIN, '{"alerts_enabled": "yes"}')).toMatch(/22023/);
      expect(set(ADMIN, "{}")).toMatch(/22023/);
      expect(set(ADMIN, '{"cap_daily_segments": 10}', "short")).toMatch(/22023/);
      expect(psqlError(`select public.tw4_inbound_reply_cap_switch_set('${NOT_ADMIN}', true, 'not an administrator switching')`)).toMatch(/42501/);
      expect(psqlError(`select public.tw4_inbound_reply_cap_switch_set('${ADMIN}', null, 'a null switch state given')`)).toMatch(/22023/);
    });

    it("a platform row applies to every business below its own override; every change is appended to the audit timeline", () => {
      const before = count("select 1 from public.studio_sms_inbound_cost_control_events where event in ('config_set', 'switch_set')");
      setConfig(null, { daily_segment_alert: 500 });
      expect(json<Record<string, number>>(`select public._tw4ib_config('${flood.entity}')::text`).daily_segment_alert).toBe(500);
      setConfig(flood, { daily_segment_alert: 50 });
      expect(json<Record<string, number>>(`select public._tw4ib_config('${flood.entity}')::text`).daily_segment_alert).toBe(50);
      expect(json<Record<string, number>>(`select public._tw4ib_config('${other.entity}')::text`).daily_segment_alert).toBe(500);
      setConfig(null, { daily_segment_alert: null });
      setSwitch(true);
      setSwitch(false);
      expect(count("select 1 from public.studio_sms_inbound_cost_control_events where event in ('config_set', 'switch_set')")).toBe(before + 5);
      expect(psqlError(`update public.studio_sms_inbound_cost_controls set reason = 'rewritten reason text'`)).toMatch(/append-only/);
      expect(psqlError(`delete from public.studio_sms_inbound_reply_cap_switch_log`)).toMatch(/append-only/);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("integer settings written as decimals, and one business's unreadable setting (review item 1)", () => {
    it("the setter refuses 2000.0 and 7.0 for integer settings (scale must be 0); a decimal multiple stays allowed", () => {
      const set = (settings: string) => psqlError(`select public.tw4_inbound_cost_controls_set(null, '${ADMIN}', '${settings}'::jsonb, 'decimal integer settings check')`);
      expect(set('{"cap_daily_segments": 2000.0}')).toMatch(/22023/);
      expect(set('{"anomaly_trailing_days": 7.0}')).toMatch(/22023/);
      expect(set('{"cap_daily_absorbed_cents": 1000.00}')).toMatch(/22023/);
      expect(set('{"anomaly_multiple": 2.5}')).toBe("");
      setConfig(null, { anomaly_multiple: null });
    });

    it("a stored 30.0 / 7.0 / 25.0 override (written before validation) is still read correctly: the business is scanned, capped and measured", () => {
      const odd = world();
      replica(`insert into public.studio_sms_inbound_cost_controls (scope, legal_entity_id, settings, set_by, reason)
        values ('entity', '${odd.entity}', '{"cap_daily_segments": 30.0, "anomaly_trailing_days": 7.0, "daily_segment_alert": 25.0}'::jsonb, '${ADMIN}', 'legacy decimal override fixture');`);
      for (let i = 0; i < 2; i++) inbound(odd, { seg: 20 });   // 40 segments today
      expect(metrics(odd).trailing_days).toBe(7);
      expect(check()).toMatchObject({ errors: 0 });
      expect(alertsOf(odd, "sms_in_volume_high")).toHaveLength(1);   // 40 > 25.0
      expect(alertsOf(odd, "sms_in_daily_cap")).toHaveLength(1);     // 40 >= 30.0
      expect(replyAllowed(odd.account, "error_invalid")).toMatch(/^[tf]$/);   // the reply check reads it without a cast error
    });

    it("an unreadable stored setting for ONE business is counted as an error and never stops the scan for the others", () => {
      const bad = world();
      const good = world();
      replica(`insert into public.studio_sms_inbound_cost_controls (scope, legal_entity_id, settings, set_by, reason)
        values ('entity', '${bad.entity}', '{"cap_daily_segments": "not a number"}'::jsonb, '${ADMIN}', 'unreadable override fixture');`);
      for (let i = 0; i < 11; i++) { inbound(bad, { seg: 20 }); inbound(good, { seg: 20 }); }   // 220 segments each: over the volume threshold
      const out = check();
      expect(out.errors).toBeGreaterThanOrEqual(1);
      expect(alertsOf(good, "sms_in_volume_high")).toHaveLength(1);
      expect(alertsOf(bad)).toHaveLength(0);                          // its partial work was rolled back
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("privileges (from the catalog) and the rollback", () => {
    it("tables: RLS on, no API-role privilege; functions: the entry points are service-role only, the helpers callable by no API role", () => {
      for (const t of ["studio_sms_inbound_cost_controls", "studio_sms_inbound_reply_cap_switch_log", "studio_sms_inbound_reply_suppressions", "studio_sms_inbound_cost_control_events"]) {
        expect(psql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`), t).toBe("t");
        for (const role of ["anon", "authenticated", "service_role"]) {
          expect(psql(`select has_table_privilege('${role}', 'public.${t}', 'select') or has_table_privilege('${role}', 'public.${t}', 'insert') or has_table_privilege('${role}', 'public.${t}', 'update') or has_table_privilege('${role}', 'public.${t}', 'delete')`), `${role} ${t}`).toBe("f");
        }
      }
      const can = (role: string, fn: string) => psql(`select has_function_privilege('${role}', 'public.${fn}', 'execute')`);
      const entry = ["tw4_inbound_cost_controls_check()", "tw4_inbound_auto_reply_allowed(text, text)", "tw4_inbound_cost_controls_set(uuid, uuid, jsonb, text)",
        "tw4_inbound_reply_cap_switch_set(uuid, boolean, text)", "tw4_inbound_reply_suppression_clear(uuid, uuid, text)", "tw4_inbound_cost_controls_status(uuid, uuid)"];
      for (const fn of entry) {
        expect(can("service_role", fn), fn).toBe("t");
        for (const role of ["anon", "authenticated"]) expect(can(role, fn), `${role} ${fn}`).toBe("f");
      }
      const helpers = ["_tw4ib_defaults()", "_tw4ib_config(uuid)", "_tw4ib_switch_on()", "_tw4ib_metrics(uuid, timestamptz)", "_tw4ib_check(timestamptz)",
        "_tw4ib_reply_allowed(text, text, timestamptz)", "_tw4ib_suppress(uuid, text, date, timestamptz, timestamptz, text, bigint, bigint, text)", "_tw4ib_window(uuid, timestamptz, timestamptz)"];
      for (const fn of helpers) for (const role of ["anon", "authenticated", "service_role"]) expect(can(role, fn), `${role} ${fn}`).toBe("f");
      for (const fn of [...entry.map((f) => f.split("(")[0]), "_tw4ib_check", "_tw4ib_reply_allowed", "_tw4ib_metrics"]) {
        expect(psql(`select bool_and(prosecdef and array_to_string(proconfig, ',') like '%search_path=pg_catalog, public, pg_temp%') from pg_proc where proname = '${fn}' and pronamespace = 'public'::regnamespace`), fn).toBe("t");
      }
    });

    it("the migration file has no carriage returns", () => {
      expect(readFileSync(join(MIG, MIGRATION), "utf8")).not.toContain("\r");
      expect(readFileSync(join(MIG, `rollback/${MIGRATION.replace(".sql", "_rollback.sql")}`), "utf8")).not.toContain("\r");
    });

    it("the rollback REFUSES while history exists; after the suite's own fixtures are removed it restores the kind list and the migration re-applies", () => {
      const rollback = readFileSync(join(MIG, `rollback/${MIGRATION.replace(".sql", "_rollback.sql")}`), "utf8");
      const err = psqlError(rollback);
      expect(err).toMatch(/inbound cost controls rollback refused/);
      expect(err).toMatch(/55000/);
      expect(psql("select to_regprocedure('public.tw4_inbound_cost_controls_check()') is not null")).toBe("t");
      const kindsBefore = psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'");
      expect(kindsBefore).toContain("sms_in_daily_cap");
      // history is never deleted by the rollback; the test removes ONLY this isolated database's rows to prove the clean path
      replica(`delete from public.studio_sms_inbound_cost_control_events; delete from public.studio_sms_inbound_reply_suppressions; delete from public.studio_sms_inbound_reply_cap_switch_log;
        delete from public.studio_sms_inbound_cost_controls;`);
      expect(psqlError(rollback)).toMatch(/alert rows use a kind that only 20270222190000 allows/);
      replica(`delete from public.studio_sms_provider_alerts where kind like 'sms_in_%';`);
      psql(rollback);
      expect(psql("select to_regprocedure('public.tw4_inbound_cost_controls_check()') is null and to_regclass('public.studio_sms_inbound_reply_suppressions') is null")).toBe("t");
      const restored = psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'");
      expect(restored).not.toContain("sms_in_");
      expect(restored).toContain("inbound_volume_high");
      psql(rollback);                                                                    // re-runnable
      psql(readFileSync(join(MIG, MIGRATION), "utf8"));                                   // and the migration re-applies
      expect(psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'")).toBe(kindsBefore);
      expect(psql("select public._tw4ib_switch_on()")).toBe("f");
    });
  });
});
