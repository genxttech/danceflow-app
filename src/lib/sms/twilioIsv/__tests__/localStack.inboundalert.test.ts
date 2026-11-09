/**
 * Absorbed-inbound allowance alert (20261231140000) against a REAL schema: the one-place definition of DanceFlow-absorbed inbound cost, the 80% warning and 100%
 * critical thresholds (one alert per threshold per period, re-armed only by a new period), the daily-volume exception, exception-only behaviour, no effect on any
 * money / sender / inbound state (and STOP still records), entity-level administrator delivery through the REAL recipient function and the REAL sink to the verified
 * administrator only, escalation of an exhausted alert, privileges, and the rollback's refusal. Synthetic fixtures; no Twilio, no SMS, no Stripe, no email (the queue is a fake).
 * LOCAL QA ONLY: a DEDICATED Postgres with the migrations through 20261231140000 applied:
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4IA_DB=postgres
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.inboundalert.test.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pilotExceptionArgs } from "./rflEvidenceHelper";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("the sink must use the injected queue"); } }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

import { ProviderFeeOpsRpc } from "@/lib/sms/providerFeeAlerts/rpc";
import { createProviderFeeAlertSink, type RflAlertQueue } from "@/lib/sms/providerFeeAlerts/sink";
import type { ProviderFeeAlert } from "@/lib/sms/providerFeeLifecycle";

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4IA_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const hex = (n: number) => randomBytes(n).toString("hex");
const uid = (n: number) => `1a${RUN}-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;
const ADMIN = uid(1);          // verified platform administrator (also the actor)
const ADMIN_UNVERIFIED = uid(2);
const ADMIN_NO_MAIL = uid(3);
const OWNER_A = uid(4);
const OWNER_B = uid(5);
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
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);
const count = (sql: string) => Number(psql(`select count(*) from (${sql}) q`));
const sid = (prefix: string) => `${prefix}${hex(16)}`;
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  const t = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${t}'::uuid` : `'${t}'`;
};
const callSql = (fn: string, ...args: unknown[]) => `select public.${fn}(${args.map(lit).join(", ")})::text;`;

type World = { entity: string; studios: string[]; owner: string; account: string };
const WORLDS: World[] = [];

/** A verified business with two locations (the FIRST linked is the earliest), an active subaccount, an owner; optionally the one pilot exception. */
function world(opts: { pilot?: boolean; owner: string }): World {
  const w: World = { entity: randomUUID(), studios: [randomUUID(), randomUUID()], owner: opts.owner, account: sid("AC") };
  psql(`begin;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studios[0]}', 'IA ${hex(3)}', 'ia-${hex(4)}', null, 'UTC'), ('${w.studios[1]}', 'IA ${hex(3)}', 'ia-${hex(4)}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studios[0]}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', '${opts.pilot ? "ConfiDance Unlimited, LLC" : `IA World ${hex(3)} LLC`}', '7771', ${opts.pilot ? 15000 : 500000}, '${ADMIN}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${w.studios[0]}', '${w.entity}', 'founding', '${ADMIN}', 'fixture: earliest location', now() - interval '2 days'),
  ('${w.studios[1]}', '${w.entity}', 'founding', '${ADMIN}', 'fixture: later location', now() - interval '1 day');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${w.entity}', '${w.account}', 'ia-${hex(3)}', 'test', 'active', '${ADMIN}');
commit;`);
  psql(callSql("tw4_credit_adjust", w.entity, 200_000, `ia-fund-${hex(4)}`, "fixture funding for the inbound alert suite", ADMIN));
  if (opts.pilot) psql(callSql("tw4_pilot_exception_create", ...pilotExceptionArgs(psql, w.entity, 15000, `Founder written pilot approval ${RUN}`, ADMIN)));
  WORLDS.push(w);
  return w;
}

type Row = { cls?: "ordinary" | "compliance"; seg?: number; billable?: number; charged?: number; est?: number | null; reply?: number | null; sidPrefix?: "SM" | "MM"; ago?: string; deferredMicros?: number };
/** One inbound record written directly (fixture only: the recording RPC needs a published inbound price and a signed webhook). */
function inbound(w: World, r: Row = {}) {
  const billable = r.billable ?? 0;
  const charged = r.charged ?? 0;
  replica(`insert into public.studio_sms_inbound_usage (legal_entity_id, studio_id, provider_sid, account_sid, source, classification, segments, media, unit_price_cents, billable_cents, charged_cents,
      uncollected_cents, ceiling_cents, est_provider_cost_cents, reply_segments, est_reply_cost_cents, received_at${r.deferredMicros ? ", unit_price_micros, exact_micros, carry_before_micros, carry_after_micros" : ""})
    values ('${w.entity}', '${w.studios[0]}', '${r.sidPrefix ?? "SM"}${hex(16)}', '${w.account}', 'webhook', '${r.cls ?? "ordinary"}', ${r.seg ?? 1}, 0, null, ${billable}, ${charged}, ${billable - charged}, 0,
      ${r.est === undefined || r.est === null ? "null" : r.est}, null, ${r.reply === undefined || r.reply === null ? "null" : r.reply}, now() - interval '${r.ago ?? "0 seconds"}'${r.deferredMicros ? `, ${r.deferredMicros}, ${r.deferredMicros}, 0, ${r.deferredMicros}` : ""});`);
}
const check = () => JSON.parse(psql("select public.tw4_rfl_inbound_allowance_check()::text")) as { allowance_warnings: number; allowance_critical: number; volume: number };
const absorbed = (w: World, since = "'-infinity'::timestamptz") => Number(psql(`select public._tw4ia_absorbed_cents('${w.entity}', ${since})`));
type AlertRow = { id: string; kind: string; dedupe_key: string; audience: string; severity: string; studio_id: string | null; resource_id: string | null; summary: string };
const alertsOf = (w: World, kind?: string) =>
  JSON.parse(psql(`select coalesce(json_agg(json_build_object('id', id, 'kind', kind, 'dedupe_key', dedupe_key, 'audience', audience, 'severity', severity, 'studio_id', studio_id, 'resource_id', resource_id, 'summary', summary) order by created_at, id), '[]'::json)::text
    from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' ${kind ? `and kind = '${kind}'` : ""}`)) as AlertRow[];
/** Everything the check must never touch for a business. */
const footprint = (w: World) => psql(`select (select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}') || '|' || (select coalesce(balance_cents, 0) || ':' || reserved_cents || ':' || hold from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}')
  || '|' || (select count(*) || ':' || coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}') || '|' || (select coalesce(sum(ceiling_cents), 0) from public.studio_sms_pilot_exceptions where legal_entity_id = '${w.entity}')
  || '|' || (select count(*) || ':' || coalesce(sum(segments), 0) || ':' || coalesce(sum(charged_cents), 0) || ':' || coalesce(sum(uncollected_cents), 0) from public.studio_sms_inbound_usage where legal_entity_id = '${w.entity}')
  || '|' || (select count(*) from public.studio_sms_billed_senders where legal_entity_id = '${w.entity}') || '|' || (select count(*) from public.studio_sms_provider_resources where legal_entity_id = '${w.entity}')
  || '|' || (select count(*) from public.studio_sms_recurring_authorizations where legal_entity_id = '${w.entity}')`);

/** A service-role client double over the REAL database functions (psql), for the real ProviderFeeOpsRpc and the real sink. */
const dbClient = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    try {
      if (fn === "tw4_rfl_alert_recipients") {
        const out = psql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from public.tw4_rfl_alert_recipients('${String(args.p_alert_id)}'::uuid) t`);
        return { data: JSON.parse(out), error: null };
      }
      if (fn === "tw4_rfl_alert_delivery_record") {
        const out = psql(`select public.tw4_rfl_alert_delivery_record('${String(args.p_alert_id)}'::uuid, '${String(args.p_claim_token)}'::uuid, '${String(args.p_recipient_ref)}', '${String(args.p_recipient_kind)}', '${String(args.p_outcome)}')::text`);
        return { data: JSON.parse(out), error: null };
      }
      return { data: null, error: { code: "unsupported" } };
    } catch (e) {
      return { data: null, error: { code: /ERROR:\s+(\w+):/.exec(String((e as { stderr?: string }).stderr ?? ""))?.[1] ?? "unknown" } };
    }
  },
};
function claim(alert: AlertRow): ProviderFeeAlert {
  const token = randomUUID();
  replica(`update public.studio_sms_provider_alerts set status = 'sending', attempts = attempts + 1, claim_token = '${token}', claimed_at = now() where id = '${alert.id}';`);
  return { id: alert.id, claimToken: token, legalEntityId: "", studioId: alert.studio_id, kind: alert.kind, audience: alert.audience as "admin", severity: alert.severity as "warning", summary: alert.summary };
}
function sinkWithFakeQueue() {
  const queued: Array<Parameters<RflAlertQueue>[0]> = [];
  const dedupe = new Map<string, { related_table: string | null; related_id: string | null; template_key: string | null }>();
  const queue: RflAlertQueue = async (p) => {
    if (p.dedupeKey && dedupe.has(p.dedupeKey)) return { queued: false, skipped: true, reason: "duplicate" };
    if (p.dedupeKey) dedupe.set(p.dedupeKey, { related_table: p.relatedTable ?? null, related_id: p.relatedId ?? null, template_key: p.templateKey });
    queued.push(p);
    return { queued: true, skipped: false };
  };
  const sink = createProviderFeeAlertSink({ ops: new ProviderFeeOpsRpc(dbClient as never), queue, lookupDelivery: async (k) => dedupe.get(k) ?? null });
  return { sink, queued };
}

describe.skipIf(!enabled)("absorbed-inbound allowance alert (20261231140000, real schema, fake queue)", () => {
  let pilot: World;
  let other: World;

  beforeAll(() => {
    expect(psql("select to_regprocedure('public.tw4_rfl_inbound_allowance_check()') is not null")).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at) values
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@inboundalert-e2e.test', now(), now(), now(), now()),
  ('${ADMIN_UNVERIFIED}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unverified-${RUN}@inboundalert-e2e.test', null, now(), now(), now()),
  ('${ADMIN_NO_MAIL}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, now(), now(), now(), now()),
  ('${OWNER_A}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ownera-${RUN}@inboundalert-e2e.test', now(), now(), now(), now()),
  ('${OWNER_B}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ownerb-${RUN}@inboundalert-e2e.test', now(), now(), now(), now());
insert into public.profiles (id, platform_role) values ('${ADMIN}', 'platform_admin'), ('${ADMIN_UNVERIFIED}', 'platform_admin'), ('${ADMIN_NO_MAIL}', 'platform_admin'), ('${OWNER_A}', null), ('${OWNER_B}', null)
  on conflict (id) do update set platform_role = excluded.platform_role;
commit;`);
    // the database allows exactly one pilot exception: reuse the existing business when a previous suite created it
    const existing = psql("select legal_entity_id from public.studio_sms_pilot_exceptions limit 1");
    if (existing) throw new Error("a pilot exception already exists on this database: rebuild a fresh container for a clean run");
    pilot = world({ pilot: true, owner: OWNER_A });
    other = world({ owner: OWNER_B });
  });

  afterAll(() => {
    if (!enabled) return;
    psql(`update public.profiles set platform_role = null where id in ('${ADMIN}', '${ADMIN_UNVERIFIED}', '${ADMIN_NO_MAIL}');`);   // other suites must not see these administrators
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("the definition and the single constant", () => {
    it("the allowance is ONE SQL constant (2000), the warning threshold derives from it, and the volume limit is the overview's 200", () => {
      expect(psql("select public._tw4ia_allowance_cents() || ':' || public._tw4ia_daily_segment_limit()")).toBe("2000:200");
      const sql = readFileSync(join(MIG, "20261231140000_twilio_inbound_absorbed_alert.sql"), "utf8");
      expect(sql.match(/select 2000 /g)).toHaveLength(1);                       // defined once
      expect(sql.replace(/--.*$/gm, "").match(/\b2000\b/g)).toHaveLength(1);    // and nowhere else in the code (comments aside)
      expect(sql).toContain("(public._tw4ia_allowance_cents() * 80 + 99) / 100");
      expect(readFileSync(join(MIG, "20261203090000_twilio_inbound_usage_recording.sql"), "utf8")).toContain("b.segments_today > 200");   // the overview's own condition
    });

    it("absorbed cost counts only what DanceFlow bears: compliance in full, the uncollected share of an ordinary text, unbilled texts, and every reply", () => {
      const w = other;
      inbound(w, { billable: 10, charged: 10, est: 8 });                     // charged in full: 0
      inbound(w, { billable: 10, charged: 4, est: 8 });                      // 6/10 of 8 = ceil(4.8) = 5
      inbound(w, { billable: 0, est: 7, sidPrefix: "MM" });                  // not billable (media): 7
      inbound(w, { cls: "compliance", est: 3, reply: 2 });                   // STOP/HELP: 3 + 2
      inbound(w, { reply: 4 });                                              // no estimate, a reply cost only: 4
      inbound(w, { billable: 5, charged: 5, est: null });                    // no estimate: 0
      inbound(w, { billable: 0, est: 9, deferredMicros: 3000 });             // micro-priced text whose cost went into the carry (billable 0, exact > 0): 0, not 9
      expect(absorbed(w)).toBe(0 + 5 + 7 + 5 + 4 + 0 + 0);
      expect(absorbed(w, "now() + interval '1 minute'")).toBe(0);            // the period start excludes earlier texts
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("thresholds, dedupe, periods and exception-only behaviour", () => {
    it("raises nothing while nothing is wrong (no email, no row)", () => {
      expect(check()).toEqual({ allowance_warnings: 0, allowance_critical: 0, volume: 0 });
      expect(alertsOf(pilot)).toHaveLength(0);
      inbound(pilot, { cls: "compliance", est: 1000, reply: 400 });          // 1400 of 2000 (70%)
      expect(absorbed(pilot)).toBe(1400);
      expect(check()).toEqual({ allowance_warnings: 0, allowance_critical: 0, volume: 0 });
      expect(alertsOf(pilot)).toHaveLength(0);
    });

    it("one WARNING at 80% (1600), administrator audience, entity level, no amounts; a repeat run raises nothing", () => {
      inbound(pilot, { cls: "compliance", est: 200 });                       // 1600
      expect(absorbed(pilot)).toBe(1600);
      expect(check()).toEqual({ allowance_warnings: 1, allowance_critical: 0, volume: 0 });
      const rows = alertsOf(pilot, "inbound_absorbed_allowance");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ audience: "admin", severity: "warning", studio_id: null, resource_id: null });
      expect(rows[0].dedupe_key).toMatch(/^inb-allow:[0-9a-f-]{36}:\d{20}:80$/);
      expect(rows[0].summary).not.toMatch(/\$|\d{3,}|\bcents?\b/i);
      expect(check()).toEqual({ allowance_warnings: 0, allowance_critical: 0, volume: 0 });
      expect(alertsOf(pilot, "inbound_absorbed_allowance")).toHaveLength(1);
    });

    it("one CRITICAL at 100% (2000) in addition to the warning; further absorbed cost raises nothing more", () => {
      inbound(pilot, { reply: 400 });                                        // 2000
      expect(absorbed(pilot)).toBe(2000);
      expect(check()).toEqual({ allowance_warnings: 0, allowance_critical: 1, volume: 0 });
      const rows = alertsOf(pilot, "inbound_absorbed_allowance");
      expect(rows.map((r) => r.severity).sort()).toEqual(["critical", "warning"]);
      expect(rows.find((r) => r.severity === "critical")).toMatchObject({ audience: "admin", studio_id: null });
      inbound(pilot, { cls: "compliance", est: 500 });                       // 2500: well past the allowance
      expect(check()).toEqual({ allowance_warnings: 0, allowance_critical: 0, volume: 0 });
      expect(alertsOf(pilot, "inbound_absorbed_allowance")).toHaveLength(2);
    });

    it("only a NEW period re-arms the alerts (a new pilot exception start gives new dedupe keys)", () => {
      const before = alertsOf(pilot, "inbound_absorbed_allowance").map((r) => r.dedupe_key);
      replica(`update public.studio_sms_pilot_exceptions set created_at = created_at - interval '1 hour' where legal_entity_id = '${pilot.entity}';`);
      expect(check()).toEqual({ allowance_warnings: 0, allowance_critical: 1, volume: 0 });
      const after = alertsOf(pilot, "inbound_absorbed_allowance").map((r) => r.dedupe_key);
      expect(after).toHaveLength(3);
      expect(new Set(after).size).toBe(3);
      expect(before.every((k) => after.includes(k))).toBe(true);
      replica(`update public.studio_sms_pilot_exceptions set created_at = created_at + interval '1 hour' where legal_entity_id = '${pilot.entity}';`);
    });

    it("a business WITHOUT a pilot exception never gets an allowance alert, however much it absorbs", () => {
      inbound(other, { cls: "compliance", est: 5000 });
      expect(absorbed(other)).toBeGreaterThan(2000);
      check();
      expect(alertsOf(other, "inbound_absorbed_allowance")).toHaveLength(0);
    });

    it("the daily-volume exception (over 200 segments in 24 hours): PILOT-ONLY, once per business per day, never for a quiet business, never for a non-pilot business", () => {
      const today = () => Number(psql(`select coalesce(sum(segments), 0) from public.studio_sms_inbound_usage where legal_entity_id = '${pilot.entity}' and received_at >= now() - interval '1 day'`));
      expect(check().volume).toBe(0);                                        // earlier tests left this business well under the limit
      for (let missing = 200 - today(); missing > 0; missing -= 20) inbound(pilot, { seg: Math.min(20, missing) });   // exactly 200 segments: not over
      expect(today()).toBe(200);
      expect(check().volume).toBe(0);
      inbound(pilot, { seg: 1 });                                            // 201
      expect(check().volume).toBe(1);
      const rows = alertsOf(pilot, "inbound_volume_high");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ audience: "admin", severity: "warning", studio_id: null });
      expect(check().volume).toBe(0);
      expect(alertsOf(pilot, "inbound_volume_high")).toHaveLength(1);
      for (let i = 0; i < 13; i++) inbound(other, { seg: 20 });                                        // a NON-pilot business over the limit raises nothing (pilot-only)
      check();
      expect(alertsOf(other, "inbound_volume_high")).toHaveLength(0);
      inbound(pilot, { seg: 20, ago: "3 days" });                            // old traffic does not count toward today
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("notification only: nothing is blocked, released, charged or changed", () => {
    it("the check changes no balance, reservation, ceiling, inbound record, sender or resource; STOP is still recorded afterwards", () => {
      const before = footprint(pilot);
      const beforeOther = footprint(other);
      check();
      expect(footprint(pilot)).toBe(before);
      expect(footprint(other)).toBe(beforeOther);
      // a STOP after the critical alert is processed exactly as before (compliance is never charged and never refused)
      const stopSid = sid("SM");
      const out = JSON.parse(psql(`select public.tw4_inbound_record('${pilot.studios[0]}'::uuid, '${pilot.account}', '${stopSid}', 1, 0, 'compliance', 'You are unsubscribed.', null, 'webhook')::text`)) as Record<string, unknown>;
      expect(out).toMatchObject({ recorded: true, classification: "compliance", charged_cents: 0, uncollected_cents: 0 });
      expect(count(`select 1 from public.studio_sms_inbound_usage where provider_sid = '${stopSid}'`)).toBe(1);
    });

    it("the check function writes only alert rows: it has no reference to any money, sender, number or inbound table write", () => {
      const body = readFileSync(join(MIG, "20261231140000_twilio_inbound_absorbed_alert.sql"), "utf8").replace(/--.*$/gm, "");
      expect(body).not.toMatch(/\b(update|delete)\s+(from\s+)?public\./i);
      expect(body).not.toMatch(/insert\s+into\s+public\.(?!studio_sms_provider_alerts)/i);
      expect(body).not.toMatch(/_tw4c_post|tw4_credit_|hold\s*=|set_config/i);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("delivery to the verified platform administrator for an entity-level alert (real recipient function, real sink)", () => {
    it("the database names the business's EARLIEST-linked location for the administrator row; only the verified administrator with an address is returned; no owner", () => {
      const a = alertsOf(pilot, "inbound_absorbed_allowance")[0];
      const rows = JSON.parse(psql(`select coalesce(jsonb_agg(to_jsonb(t) order by t.user_id), '[]'::jsonb)::text from public.tw4_rfl_alert_recipients('${a.id}') t`)) as Array<{ recipient_kind: string; user_id: string; studio_id: string | null; email: string; email_verified: boolean }>;
      const mine = rows.filter((r) => [ADMIN, ADMIN_UNVERIFIED, ADMIN_NO_MAIL, OWNER_A, OWNER_B].includes(r.user_id));
      expect(mine.map((r) => r.user_id)).toEqual([ADMIN]);                   // unverified and address-less administrators and both owners are absent
      expect(mine[0]).toMatchObject({ recipient_kind: "admin", studio_id: pilot.studios[0], email_verified: true });
      expect(rows.every((r) => r.recipient_kind === "admin")).toBe(true);    // an administrator-audience alert has NO owner recipient
      expect(pilot.studios).not.toContain(other.studios[0]);
      const b = alertsOf(pilot, "inbound_volume_high")[0];
      const rowsB = JSON.parse(psql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from public.tw4_rfl_alert_recipients('${b.id}') t where t.user_id = '${ADMIN}'`)) as Array<{ studio_id: string }>;
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].studio_id).toBe(pilot.studios[0]);                     // never a location of another legal business
    });

    it("the sink queues ONE mail to the verified administrator with a studio-scoped queue row, the admin template key and no amounts; nobody else is mailed; the outcome is recorded", async () => {
      const a = alertsOf(pilot, "inbound_absorbed_allowance").find((r) => r.severity === "critical")!;
      const claimed = claim(a);
      const { sink, queued } = sinkWithFakeQueue();
      // deliver() throws when a recipient is not reached; every reachable recipient is the verified administrator(s), so the call succeeds when at least one was queued
      await sink.deliver(claimed);
      const mine = queued.filter((q) => q.recipientEmail === `padmin-${RUN}@inboundalert-e2e.test`);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ studioId: pilot.studios[0], channel: "email", templateKey: "platform_rfl_admin_inbound_absorbed_allowance", relatedTable: "studio_sms_provider_alerts", relatedId: a.id });
      expect(queued.every((q) => q.templateKey.startsWith("platform_rfl_admin_"))).toBe(true);
      expect(queued.some((q) => /ownera|ownerb|unverified/.test(q.recipientEmail ?? ""))).toBe(false);
      expect(mine[0].bodyText).not.toMatch(/\$|\bcents?\b|\d{4}/);
      expect(count(`select 1 from public.studio_sms_rfl_alert_deliveries where alert_id = '${a.id}' and recipient_ref = 'admin:${ADMIN}' and outcome = 'queued'`)).toBe(1);
      expect(count(`select 1 from public.studio_sms_rfl_alert_deliveries where alert_id = '${a.id}' and recipient_ref like 'owner:%'`)).toBe(0);
      // a repeated delivery of the same claim collapses on the dedupe key (no second mail)
      await sink.deliver(claimed);
      expect(queued.filter((q) => q.recipientEmail === `padmin-${RUN}@inboundalert-e2e.test`)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("escalation when delivery is exhausted", () => {
    it("an allowance or volume alert whose delivery failed 5 times raises ONE alert_delivery_exhausted (administrator, critical); repeated runs add none", () => {
      const ids = [alertsOf(pilot, "inbound_absorbed_allowance")[0].id, alertsOf(pilot, "inbound_volume_high")[0].id];
      for (const id of ids) replica(`update public.studio_sms_provider_alerts set status = 'failed', attempts = 5, last_error = 'RflAlert_unreachable' where id = '${id}';`);
      const first = JSON.parse(psql("select public.tw4_rfl_escalate_delivery()::text")) as { escalated: number };
      expect(first.escalated).toBeGreaterThanOrEqual(2);
      for (const id of ids) {
        const esc = JSON.parse(psql(`select coalesce(json_agg(json_build_object('audience', audience, 'severity', severity, 'summary', summary)), '[]'::json)::text from public.studio_sms_provider_alerts where kind = 'alert_delivery_exhausted' and dedupe_key = 'exhausted:${id}'`)) as Array<{ audience: string; severity: string; summary: string }>;
        expect(esc).toHaveLength(1);
        expect(esc[0]).toMatchObject({ audience: "admin", severity: "critical" });
      }
      expect(JSON.parse(psql("select public.tw4_rfl_escalate_delivery()::text")).escalated).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("privileges and the rollback", () => {
    it("only the service role may run the check; the helpers are not callable by any API role", () => {
      const can = (role: string, fn: string) => psql(`select has_function_privilege('${role}', '${fn}', 'execute')`);
      expect(can("service_role", "public.tw4_rfl_inbound_allowance_check()")).toBe("t");
      for (const role of ["anon", "authenticated"]) expect(can(role, "public.tw4_rfl_inbound_allowance_check()")).toBe("f");
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(can(role, "public._tw4ia_allowance_cents()")).toBe("f");
        expect(can(role, "public._tw4ia_absorbed_cents(uuid, timestamptz)")).toBe("f");
      }
    });

    it("the rollback REFUSES while alert rows use the new kinds, and a clean rollback + re-apply restores the exact kind list", () => {
      const rollback = readFileSync(join(MIG, "rollback/20261231140000_twilio_inbound_absorbed_alert_rollback.sql"), "utf8");
      const err = psqlError(rollback);
      expect(err).toMatch(/inbound absorbed alert rollback refused/);
      expect(err).toMatch(/55000/);
      expect(psql("select to_regprocedure('public.tw4_rfl_inbound_allowance_check()') is not null")).toBe("t");   // nothing was dropped
      const kindsBefore = psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'");
      expect(kindsBefore).toContain("inbound_absorbed_allowance");
      // history is never deleted by the rollback itself; the test removes ONLY its own fixture alerts (and their escalations) to prove the clean path
      const mine = [pilot, other].map((w) => `'${w.entity}'`).join(", ");
      replica(`delete from public.studio_sms_rfl_alert_deliveries where alert_id in (select id from public.studio_sms_provider_alerts where legal_entity_id in (${mine}));
        delete from public.studio_sms_provider_alerts where legal_entity_id in (${mine});`);
      expect(count("select 1 from public.studio_sms_provider_alerts where kind in ('inbound_absorbed_allowance', 'inbound_volume_high')")).toBe(0);
      psql(rollback);
      expect(psql("select to_regprocedure('public.tw4_rfl_inbound_allowance_check()') is null and to_regprocedure('public._tw4ia_allowance_cents()') is null")).toBe("t");
      const restored = psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'");
      expect(restored).not.toContain("inbound_");
      expect(restored).toContain("alert_delivery_exhausted");
      expect(psqlError("insert into public.studio_sms_provider_alerts (legal_entity_id, kind, dedupe_key, audience, severity, summary) values (gen_random_uuid(), 'inbound_volume_high', 'x', 'admin', 'info', 'hello world');")).toMatch(/check|foreign key/i);
      psql(readFileSync(join(MIG, "20261231140000_twilio_inbound_absorbed_alert.sql"), "utf8"));                       // re-apply: the migration is repeatable after its rollback
      expect(psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'")).toBe(kindsBefore);
      expect(psql("select public._tw4ia_allowance_cents()")).toBe("2000");
    });
  });
});
