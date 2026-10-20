/**
 * Monthly spending limits against a REAL schema with real JWTs: calendar months in the legal business's timezone (DST, leap year, extreme offsets, a timezone change),
 * spend attribution by the ledger's own timestamps, the owner / platform-admin actions, the platform ceiling, usage enforcement, the first-month commitment of a recurring
 * authorization, the pilot business, concurrency and tenant isolation. Nothing reaches Stripe or Twilio. LOCAL QA STACK ONLY (skipped unless the variables below point at a
 * loopback Supabase stack with the migrations through 20261128090000 applied).
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 1_000_000 });

import { acquireSuiteLock } from "./localStackLock";
import { getMonthlyLimitOverview, setEntityTimezone, setMonthlyLimit, MonthlyLimitError } from "@/lib/billing/smsMonthlyLimits";
import { SupabaseCreditStore } from "@/lib/sms/twilioIsv/creditStore";
import { RunnerStoreError } from "@/lib/sms/twilioIsv/store";

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

const PA1 = "a9d00000-0000-4000-8000-00000000000a"; // founding location of A (New York)
const PA2 = "a9d00000-0000-4000-8000-00000000000b"; // second location of A (Tokyo)
const PB1 = "a9d00000-0000-4000-8000-00000000000c"; // business B (Auckland)
const PC1 = "a9d00000-0000-4000-8000-00000000000d"; // business C: synthetic ledger rows only
const PX = "a9d00000-0000-4000-8000-00000000000e"; // a studio with no verified legal business
const EA = "e9d00000-0000-4000-8000-0000000000e1";
const EB = "e9d00000-0000-4000-8000-0000000000e2";
const EC = "e9d00000-0000-4000-8000-0000000000e3";
const U = {
  owner_a: "a9d00000-0000-4000-8000-000000000101",
  owner_a2: "a9d00000-0000-4000-8000-000000000104", // owner of location 2 only
  fd_a: "a9d00000-0000-4000-8000-000000000102",
  admin_a: "a9d00000-0000-4000-8000-000000000103",
  owner_b: "a9d00000-0000-4000-8000-000000000201",
  owner_x: "a9d00000-0000-4000-8000-000000000301",
  padmin: "a9d00000-0000-4000-8000-000000000401",
};
const RUN = randomBytes(3).toString("hex");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp: 1983812996 }) : "");
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const userToken = (sub: string) => sign({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
const as = (who: keyof typeof U): SupabaseClient =>
  createClient(URL_, anonKey(), { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${userToken(U[who])}` } } });
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

const ENTITIES = `'${EA}', '${EB}', '${EC}'`;
const STUDIOS = `'${PA1}', '${PA2}', '${PB1}', '${PC1}', '${PX}'`;
const CLEANUP = `
begin;
set local session_replication_role = replica;
update public.studio_sms_recurring_charges set run_id = null where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_charges where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_authorizations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_monthly_limits where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_timezones where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_limit_ceilings where legal_entity_id in (${ENTITIES}) or (scope = 'platform' and approved_by = '${U.padmin}');
delete from public.studio_sms_spend_events where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_ledger where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_reservations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES}));
delete from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_studios where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_legal_entities where id in (${ENTITIES});
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in (${Object.values(U).map((u) => `'${u}'`).join(", ")});
delete from auth.users where email like '%@tw4monthly-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4monthly-e2e.test', now(), now(), u.signed
    from (values ('${U.owner_a}'::uuid, 'owner_a', now()), ('${U.owner_a2}', 'owner_a2', now()), ('${U.fd_a}', 'fd_a', now()), ('${U.admin_a}', 'admin_a', now()),
                 ('${U.owner_b}', 'owner_b', now() - interval '3 hours'), ('${U.owner_x}', 'owner_x', now()), ('${U.padmin}', 'padmin', now())) u(id, n, signed);
insert into public.profiles (id, platform_role) values ${Object.values(U).map((u) => `('${u}', ${u === U.padmin ? "'platform_admin'" : "null"})`).join(", ")}
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values
  ('${PA1}', 'TW4MONTHLY Location A1', 'tw4monthly-a1', null, 'America/New_York'), ('${PA2}', 'TW4MONTHLY Location A2', 'tw4monthly-a2', null, 'Asia/Tokyo'),
  ('${PB1}', 'TW4MONTHLY Location B1', 'tw4monthly-b1', null, 'Pacific/Auckland'), ('${PC1}', 'TW4MONTHLY Location C1', 'tw4monthly-c1', null, 'UTC'),
  ('${PX}', 'TW4MONTHLY Location X', 'tw4monthly-x', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${PA1}', 'studio_owner', true), ('${U.owner_a}', '${PA2}', 'studio_owner', true), ('${U.owner_a2}', '${PA2}', 'studio_owner', true), ('${U.fd_a}', '${PA1}', 'front_desk', true),
  ('${U.admin_a}', '${PA1}', 'studio_admin', true), ('${U.owner_b}', '${PB1}', 'studio_owner', true), ('${U.owner_x}', '${PX}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'MON Alpha LLC', '7771', 15000, '${U.padmin}'), ('${EB}', 'MON Beta LLC', '7772', 15000, '${U.padmin}'), ('${EC}', 'MON Gamma LLC', '7773', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${PA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, founding location', now() - interval '2 days'),
  ('${PA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, second location', now() - interval '1 day'),
  ('${PB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B', now()),
  ('${PC1}', '${EC}', 'founding', '${U.padmin}', 'fixture: verified business C (synthetic ledger rows)', now());
commit;`;

describe.skipIf(!enabled)("monthly spending limits: months in the business's timezone, limits, ceilings, usage, commitments, concurrency (real schema, real JWTs)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let releaseLock: (() => void) | null = null;
  let snapshotActivePrices: string[] = [];
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql} commit;`);
  const balance = (entity: string) => Number(psql(`select coalesce((select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 0)`));
  const reservedCents = (entity: string) => Number(psql(`select coalesce((select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 0)`));
  const keyAt = (entity: string, iso: string) => psql(`select public._tw4ml_month_key('${entity}', '${iso}'::timestamptz)`);
  const startOf = (entity: string, key: string) => psql(`select to_char(public._tw4ml_month_start('${entity}', '${key}') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
  const curKey = (entity: string) => psql(`select public._tw4ml_month_key('${entity}', now())`);
  const addMonths = (key: string, n: number) => psql(`select public._tw4ml_key_add('${key}', ${n})`);
  const spend = (entity: string, key?: string) => Number(psql(`select public._tw4ml_month_spend('${entity}', '${key ?? curKey(entity)}')`));
  const code = async (promise: PromiseLike<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      if (error instanceof RunnerStoreError) return error.code;
      if (error instanceof MonthlyLimitError) return error.code;
      return `other:${String(error)}`;
    }
  };
  let n = 0;
  /** the legal business's base timezone, as if it had always been that (fixture) */
  const setBaseTz = (entity: string, tz: string) =>
    aged(`delete from public.studio_sms_entity_timezones where legal_entity_id = '${entity}'; insert into public.studio_sms_entity_timezones (legal_entity_id, timezone, effective_month, set_by_role, reason) values ('${entity}', '${tz}', '1970-01', 'system', 'fixture');`);
  const clearLimits = () => aged(`delete from public.studio_sms_monthly_limits where legal_entity_id in (${ENTITIES}); delete from public.studio_sms_limit_ceilings where legal_entity_id in (${ENTITIES}) or (scope = 'platform' and approved_by = '${U.padmin}');`);
  const resetMoney = async (entity: string) => {
    aged(`delete from public.studio_sms_recurring_charges where legal_entity_id = '${entity}'; delete from public.studio_sms_recurring_authorizations where legal_entity_id = '${entity}';
          delete from public.studio_sms_spend_events where legal_entity_id = '${entity}'; delete from public.studio_sms_credit_ledger where legal_entity_id = '${entity}';
          delete from public.studio_sms_credit_reservations where legal_entity_id = '${entity}'; delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id = '${entity}');
          delete from public.studio_sms_credit_topups where legal_entity_id = '${entity}'; delete from public.studio_sms_credit_accounts where legal_entity_id = '${entity}';`);
  };
  const fund = async (entity: string, studio: string, pack: number) => {
    n += 1;
    const ref = `cs_mon_${RUN}_${n}`;
    await credits.topupPending(entity, studio, ref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(entity, studio, ref, pack, `evt_mon_${RUN}_${n}`, `pi_mon_${RUN}_${n}`, true);
  };
  const adminSet = (entity: string, cents: number, month: string | null = null, reason = "fixture: set the monthly limit") =>
    rpc("tw4_monthly_limit_set_admin", { p_entity_id: entity, p_actor: U.padmin, p_limit_cents: cents, p_effective_month: month, p_reason: reason });
  const ownerSet = (who: keyof typeof U, studio: string, cents: number, over: Record<string, unknown> = {}) =>
    rpc("tw4_monthly_limit_set", { p_studio_id: studio, p_user_id: U[who], p_limit_cents: cents, p_effective_month: null, p_confirmed: true, p_reason: null, ...over });
  const usage = (entity: string, studio: string, cents: number, key: string) => rpc("tw4_credit_debit_usage", { p_entity_id: entity, p_studio_id: studio, p_cents: cents, p_key: `${key}-${RUN}`, p_ref: "fixture usage" });
  const price = (kind: string) => Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = '${kind}' and active`));
  const authorize = (who: keyof typeof U, studio: string, kind: "number" | "monthly", over: Record<string, unknown> = {}) =>
    rpc("tw4_recurring_authorize", { p_studio_id: studio, p_user_id: U[who], p_kind: kind, p_acknowledged_price_cents: price(kind), p_term_months: 3, p_total_limit_cents: price(kind) * 3, ...over });
  const clearAuths = () => {
    psql(`select count(public._tw4rc_release_commitment(a.id)) from public.studio_sms_recurring_authorizations a where a.legal_entity_id in (${ENTITIES}) and a.commitment_reservation_id is not null`);
    aged(`delete from public.studio_sms_recurring_charges where legal_entity_id in (${ENTITIES}); delete from public.studio_sms_recurring_authorizations where legal_entity_id in (${ENTITIES});`);
  };
  /** a ledger row at a chosen instant (fixture; the account counters are not touched, so these rows live on business C only) */
  const ledgerRow = (entity: string, studio: string, kind: string, delta: number, whenIso: string, key: string, reservation: string | null = null) =>
    aged(`insert into public.studio_sms_credit_ledger (legal_entity_id, seq, kind, balance_delta_cents, reserved_delta_cents, idempotency_key, studio_id, reservation_id, created_at)
          values ('${entity}', (select coalesce(max(seq), 0) + 1 from public.studio_sms_credit_ledger where legal_entity_id = '${entity}'), '${kind}', ${delta}, ${kind === "capture" ? delta : 0}, '${key}-${RUN}', '${studio}', ${reservation ? `'${reservation}'` : "null"}, '${whenIso}');`);
  const inPilotTxnOut = (entity: string, body: string) =>
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], {
      input: `begin; set local session_replication_role = replica; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${entity}', 15000, 'fixture approval reference text', '${U.padmin}'); reset session_replication_role; ${body}; rollback;`,
      encoding: "utf8",
    });

  beforeAll(async () => {
    releaseLock = await acquireSuiteLock("recurring-scheduler");
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    for (const [kind, cents] of [["number", 500], ["monthly", 1500]] as const) {
      expect((await rpc("tw4_price_set", { p_kind: kind, p_customer_cents: cents, p_provider_cents: cents - 100, p_description: `fixture ${kind} price`, p_actor: U.padmin })).error).toBeNull();
    }
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
      aged(`delete from public.studio_sms_price_list where created_by = '${U.padmin}'; update public.studio_sms_price_list set active = true where id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"});`);
    } catch {
      /* best effort */
    }
    releaseLock?.();
  });

  it("privileges: the new tables are unreachable by API roles; every action is service-role only; only the read overview is for signed-in users", async () => {
    expect((await adminSet(EA, 100)).error).toBeNull();
    expect((await rpc("tw4_entity_timezone_set_admin", { p_entity_id: EA, p_actor: U.padmin, p_timezone: "UTC", p_reason: "fixture row for the privilege test" })).error).toBeNull();
    expect((await rpc("tw4_limit_ceiling_set_platform", { p_actor: U.padmin, p_cents: 50_000, p_approval_ref: "fixture row for the privilege test" })).error).toBeNull();
    for (const table of ["studio_sms_entity_timezones", "studio_sms_monthly_limits", "studio_sms_limit_ceilings"]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete')`)).toBe("f");
    }
    for (const fn of [
      "tw4_monthly_limit_set(uuid, uuid, int, text, boolean, text)", "tw4_monthly_limit_set_admin(uuid, uuid, int, text, text)", "tw4_entity_timezone_set(uuid, uuid, text, text)",
      "tw4_entity_timezone_set_admin(uuid, uuid, text, text)", "tw4_limit_ceiling_set_platform(uuid, int, text)", "tw4_limit_ceiling_approve_entity(uuid, uuid, int, text)",
      "tw4_recurring_release_ended()", "tw4_recurring_due_list()",
    ]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    expect(psql(`select has_function_privilege('anon', 'public.sms_monthly_limit_overview(uuid)', 'execute')`)).toBe("f");
    expect(psql(`select has_function_privilege('authenticated', 'public.sms_monthly_limit_overview(uuid)', 'execute')`)).toBe("t");
    for (const fn of ["_tw4ml_month_key(uuid, timestamptz)", "_tw4ml_apply_limit(uuid, uuid, uuid, text, int, text, text, boolean)", "_tw4ml_require_room(uuid, bigint, bigint)", "_tw4rc_release_commitment(uuid)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("f");
    }
    for (const stmt of ["update public.studio_sms_monthly_limits set limit_cents = 1", "delete from public.studio_sms_monthly_limits", "update public.studio_sms_entity_timezones set timezone = 'UTC'", "delete from public.studio_sms_limit_ceilings"]) {
      expect(psqlError(stmt), stmt).toContain("append-only");
    }
    expect(psqlError("truncate public.studio_sms_monthly_limits")).toContain("never truncated");
  });

  describe("calendar months in the legal business's timezone", () => {
    it("the timezone is inherited from the founding location (the first linked), and month boundaries are local midnight", () => {
      aged(`delete from public.studio_sms_entity_timezones where legal_entity_id in (${ENTITIES});`);
      expect(psql(`select public._tw4ml_default_tz('${EA}')`)).toBe("America/New_York"); // PA1 was linked first; PA2 (Tokyo) was not the founding location
      expect(psql(`select public._tw4ml_default_tz('${EB}')`)).toBe("Pacific/Auckland");
      expect(startOf(EA, "2026-11")).toBe("2026-11-01T04:00:00Z"); // New York is still on daylight time at midnight of Nov 1, 2026 (UTC-4)
      expect(startOf(EA, "2026-12")).toBe("2026-12-01T05:00:00Z"); // standard time (UTC-5)
      expect(keyAt(EA, "2026-11-01T03:59:59Z")).toBe("2026-10");
      expect(keyAt(EA, "2026-11-01T04:00:00Z")).toBe("2026-11");
    });

    it("extreme offsets, half-hour zones, leap years and daylight saving all tile the timeline without gaps or overlap", () => {
      const cases: [string, string, string][] = [
        ["Pacific/Auckland", "2026-11", "2026-10-31T11:00:00Z"], // UTC+13 in summer
        ["Pacific/Kiritimati", "2026-11", "2026-10-31T10:00:00Z"], // UTC+14
        ["Pacific/Pago_Pago", "2026-11", "2026-11-01T11:00:00Z"], // UTC-11
        ["Asia/Kolkata", "2026-11", "2026-10-31T18:30:00Z"], // UTC+5:30
        ["Asia/Kathmandu", "2026-11", "2026-10-31T18:15:00Z"], // UTC+5:45
        ["Australia/Lord_Howe", "2026-11", "2026-10-31T13:00:00Z"], // UTC+11 (daylight time)
        ["UTC", "2026-11", "2026-11-01T00:00:00Z"],
      ];
      for (const [tz, key, expected] of cases) {
        setBaseTz(EC, tz);
        expect(startOf(EC, key), tz).toBe(expected);
        const startMs = Date.parse(expected);
        expect(keyAt(EC, new Date(startMs - 1000).toISOString()), `${tz} one second before`).toBe(addMonths(key, -1));
        expect(keyAt(EC, new Date(startMs).toISOString()), `${tz} at the start`).toBe(key);
        expect(keyAt(EC, new Date(startMs + 1000).toISOString()), `${tz} one second after`).toBe(key);
      }
      setBaseTz(EC, "America/New_York");
      // a leap February is 29 days, an ordinary one 28; the daylight-saving months are 31 days with a 23- or 25-hour day inside
      const len = (a: string, b: string) => (Date.parse(startOf(EC, b)) - Date.parse(startOf(EC, a))) / 86_400_000;
      expect(len("2028-02", "2028-03")).toBe(29);
      expect(len("2027-02", "2027-03")).toBe(28);
      expect(len("2026-11", "2026-12")).toBeCloseTo(30 + 1 / 24, 5); // clocks go back on Nov 1: November has a 25-hour day
      expect(len("2026-03", "2026-04")).toBeCloseTo(31 - 1 / 24, 5); // clocks go forward in March
      // every instant of a sweep across a year maps to exactly one month, in order (one query)
      expect(
        psql(`select count(*) from (select t, public._tw4ml_month_key('${EC}', t) k from generate_series('2026-01-01T07:00Z'::timestamptz, '2027-02-05T07:00Z'::timestamptz, interval '3 days 1 hour') t) q
              where not (public._tw4ml_month_start('${EC}', k) <= t and t < public._tw4ml_month_start('${EC}', public._tw4ml_key_add(k, 1)))`),
      ).toBe("0");
      expect(psql(`select count(*) from (select k, lag(k) over (order by t) pk from (select t, public._tw4ml_month_key('${EC}', t) k from generate_series('2026-01-01T07:00Z'::timestamptz, '2027-02-05T07:00Z'::timestamptz, interval '3 days 1 hour') t) q) r where pk is not null and k < pk`)).toBe("0");
    });

    it("only a real IANA zone is accepted; a timezone change takes effect from NEXT month, is audited, and never moves the current month", async () => {
      aged(`delete from public.studio_sms_entity_timezones where legal_entity_id = '${EA}';`);
      const ownerTz = (who: keyof typeof U, studio: string, tz: string, reason = "the studio moved") => rpc("tw4_entity_timezone_set", { p_studio_id: studio, p_user_id: U[who], p_timezone: tz, p_reason: reason });
      for (const bad of ["Mars/Phobos", "posix/UTC", "", "America/New_York; drop table x", "not a zone"]) expect((await ownerTz("owner_a", PA1, bad)).error?.code, bad).toBe("22023");
      expect((await ownerTz("owner_a", PA1, "UTC", "")).error?.code).toBe("22023"); // a reason is required
      for (const who of ["fd_a", "admin_a", "owner_b", "owner_x"] as const) expect((await ownerTz(who, PA1, "UTC")).error?.code, who).toBe("42501");
      const cur = curKey(EA);
      const before = startOf(EA, cur);
      const done = await ownerTz("owner_a", PA1, "Pacific/Auckland");
      expect(done.error).toBeNull();
      expect(done.data).toMatchObject({ timezone: "Pacific/Auckland", effective_month: addMonths(cur, 1), previous_timezone: "America/New_York" });
      expect(startOf(EA, cur)).toBe(before); // the current month did not move
      expect(curKey(EA)).toBe(cur);
      expect(psql(`select public._tw4ml_tz_for('${EA}', '${addMonths(cur, 1)}')`)).toBe("Pacific/Auckland");
      expect(psql(`select public._tw4ml_tz_for('${EA}', '${cur}')`)).toBe("America/New_York");
      // the months still tile across the change: no instant belongs to two months or to none
      const switchAt = Date.parse(startOf(EA, addMonths(cur, 1)));
      for (const delta of [-3_600_000, -1000, 0, 1000, 3_600_000, 13 * 3_600_000, 20 * 3_600_000]) {
        const key = keyAt(EA, new Date(switchAt + delta).toISOString());
        expect(Date.parse(startOf(EA, key)) <= switchAt + delta && switchAt + delta < Date.parse(startOf(EA, addMonths(key, 1))), `delta ${delta}`).toBe(true);
      }
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PA1}' and action = 'entity_timezone_set' and actor_user_id = '${U.owner_a}' and note like '%to=Pacific/Auckland%'`)).toBe("1");
      // another change before it takes effect replaces the pending one (latest wins); the admin path needs a written reason
      expect((await ownerTz("owner_a", PA1, "Asia/Tokyo", "second thoughts")).error).toBeNull();
      expect(psql(`select public._tw4ml_tz_for('${EA}', '${addMonths(cur, 1)}')`)).toBe("Asia/Tokyo");
      expect((await rpc("tw4_entity_timezone_set_admin", { p_entity_id: EA, p_actor: U.padmin, p_timezone: "UTC", p_reason: "short" })).error?.code).toBe("22023");
      expect((await rpc("tw4_entity_timezone_set_admin", { p_entity_id: EA, p_actor: U.owner_a, p_timezone: "UTC", p_reason: "a perfectly good reason" })).error?.code).toBe("42501");
      const adminAudits = () => Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PA1}' and action = 'entity_timezone_set' and note like '%role=platform_admin%'`));
      const auditsBefore = adminAudits();
      expect((await rpc("tw4_entity_timezone_set_admin", { p_entity_id: EA, p_actor: U.padmin, p_timezone: "UTC", p_reason: "platform correction by support" })).error).toBeNull();
      expect(adminAudits()).toBe(auditsBefore + 1);
      aged(`delete from public.studio_sms_entity_timezones where legal_entity_id = '${EA}';`);
      setBaseTz(EA, "UTC");
    });
  });

  describe("what counts toward a month, attributed by the ledger's own timestamps", () => {
    it("usage (net of refunds), recurring captures and captured commitments count; setup captures do not; open commitments count in their month; rows outside the window do not", async () => {
      setBaseTz(EC, "America/New_York");
      aged(`delete from public.studio_sms_credit_ledger where legal_entity_id = '${EC}'; delete from public.studio_sms_credit_reservations where legal_entity_id = '${EC}';`);
      const nov = "2026-11";
      const inside = "2026-11-01T04:00:00Z"; // the very first instant of November, New York
      const lastInstantOct = "2026-11-01T03:59:59Z";
      const lastInstantNov = "2026-12-01T04:59:59Z";
      const firstInstantDec = "2026-12-01T05:00:00Z";
      ledgerRow(EC, PC1, "usage_charge", -300, inside, "u1");
      ledgerRow(EC, PC1, "usage_charge", -200, lastInstantNov, "u2");
      ledgerRow(EC, PC1, "usage_refund", 50, "2026-11-15T12:00:00Z", "u3"); // a refund nets usage down
      ledgerRow(EC, PC1, "usage_charge", -999, lastInstantOct, "u-oct"); // belongs to October
      ledgerRow(EC, PC1, "usage_charge", -888, firstInstantDec, "u-dec"); // belongs to December
      ledgerRow(EC, PC1, "capture", -1500, "2026-11-10T12:00:00Z", "capture:rec:aaaa");
      ledgerRow(EC, PC1, "capture", -500, "2026-11-11T12:00:00Z", "capture:commit:bbbb");
      ledgerRow(EC, PC1, "capture", -7000, "2026-11-12T12:00:00Z", "capture:setupfee"); // a one-time setup fee: not a routine cost
      aged(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, created_at)
            values ('${EC}', '${PC1}', 'monthly', 400, 'credit', 'reserved', 'commit:open-nov-${RUN}', '2026-11-20T12:00:00Z'),
                   ('${EC}', '${PC1}', 'monthly', 600, 'credit', 'reserved', 'commit:open-oct-${RUN}', '2026-10-20T12:00:00Z'),
                   ('${EC}', '${PC1}', 'monthly', 700, 'credit', 'reserved', 'setup-${RUN}', '2026-11-20T12:00:00Z');`);
      const parts = JSON.parse(psql(`select public._tw4ml_month_parts('${EC}', '${nov}')::text`));
      expect(parts).toMatchObject({ usage_cents: 300 + 200 - 50, recurring_cents: 1500 + 500, reserved_cents: 400, total_cents: 450 + 2000 + 400 });
      expect(spend(EC, "2026-10")).toBe(999 + 600); // October: the usage in its last second and the commitment still held from October
      expect(spend(EC, "2026-12")).toBe(888);
      expect(psql(`select to_char(public._tw4ml_month_start('${EC}', '2026-11') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`)).toBe(inside);
    });
  });

  describe("limits: default zero, owner and platform actions, the ceiling, immediate effect", () => {
    it("a business with no configured limit can spend nothing on routine costs, however much credit it has", async () => {
      await clearLimitsAndMoney();
      await fund(EA, PA1, 5_000);
      expect(Number(psql(`select public._tw4ml_effective_limit('${EA}', '${curKey(EA)}')`))).toBe(0);
      expect((await usage(EA, PA1, 10, "nolimit")).error?.code).toBe("TW012");
      expect((await authorize("owner_a", PA1, "monthly")).error?.code).toBe("TW012");
      expect(balance(EA)).toBe(5_000);
    });

    it("only an OWNER of the studio can set the limit, and only with an explicit confirmation, inside the platform ceiling, from the current month to a year ahead", async () => {
      await clearLimitsAndMoney();
      for (const [who, studio] of [["fd_a", PA1], ["admin_a", PA1], ["owner_a2", PA1], ["owner_b", PA1], ["owner_x", PA1], ["owner_a", PB1]] as const) {
        expect((await ownerSet(who, studio, 1_000)).error?.code, `${who}@${studio}`).toBe("42501");
      }
      expect((await ownerSet("owner_x", PX, 1_000)).error?.code).toBe("TW010");
      expect((await ownerSet("owner_a", PA1, 1_000, { p_confirmed: false })).error?.code).toBe("22023");
      expect((await ownerSet("owner_a", PA1, 1_000, { p_confirmed: null })).error?.code).toBe("22023");
      for (const bad of [-1, 50_001, 2_000_000_000]) expect((await ownerSet("owner_a", PA1, bad)).error?.code, String(bad)).toBe("TW013");
      const cur = curKey(EA);
      for (const bad of ["2020-01", addMonths(cur, -1), addMonths(cur, 13), "2026-13", "garbage", "2026-1"]) expect((await ownerSet("owner_a", PA1, 1_000, { p_effective_month: bad })).error?.code, bad).toBe("22023");
      expect(psql(`select count(*) from public.studio_sms_monthly_limits where legal_entity_id = '${EA}'`)).toBe("0");
      const ok = await ownerSet("owner_a", PA1, 2_000, { p_reason: "first month of texting" });
      expect(ok.error, JSON.stringify(ok.error)).toBeNull();
      expect(ok.data).toMatchObject({ limit_cents: 2_000, previous_limit_cents: 0, effective_month: cur, spend_cents: 0 });
      expect(psql(`select changed_by_role || ':' || limit_cents || ':' || previous_limit_cents || ':' || spend_at_change_cents from public.studio_sms_monthly_limits where legal_entity_id = '${EA}'`)).toBe("owner:2000:0:0");
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PA1}' and action = 'monthly_limit_set' and actor_user_id = '${U.owner_a}' and note like '%to=2000%'`)).toBe("1");
    });

    it("a lower limit applies at once; a higher one also applies at once but needs a recent sign-in, no hold and a non-negative balance; the month's spending is recorded with the change", async () => {
      await clearLimitsAndMoney();
      await fund(EA, PA1, 5_000);
      expect((await adminSet(EA, 1_000)).error).toBeNull();
      expect((await usage(EA, PA1, 700, "a")).error).toBeNull();
      // raise: owner_b has not signed in recently, owner_a has
      expect((await ownerSet("owner_a", PA1, 3_000)).error).toBeNull();
      expect(psql(`select spend_at_change_cents from public.studio_sms_monthly_limits where legal_entity_id = '${EA}' order by created_at desc limit 1`)).toBe("700");
      aged(`update auth.users set last_sign_in_at = now() - interval '2 hours' where id = '${U.owner_a}';`);
      expect((await ownerSet("owner_a", PA1, 4_000)).error?.code).toBe("TW014"); // a raise asks for a fresh sign-in
      expect((await ownerSet("owner_a", PA1, 500)).error).toBeNull(); // a decrease does not
      expect((await usage(EA, PA1, 10, "after-decrease")).error?.code).toBe("TW012"); // 700 already spent, the limit is 500: nothing more
      aged(`update auth.users set last_sign_in_at = null where id = '${U.owner_a}';`);
      expect((await ownerSet("owner_a", PA1, 4_000)).error?.code).toBe("TW014");
      aged(`update auth.users set last_sign_in_at = now() where id = '${U.owner_a}';`);
      // a hold or a negative balance blocks a raise (and only a raise)
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: hold for the limit test", p_actor: U.padmin });
      expect((await ownerSet("owner_a", PA1, 4_000)).error?.code).toBe("TW007");
      expect((await adminSet(EA, 4_000)).error?.code).toBe("TW007"); // the platform cannot raise through a hold either
      expect((await ownerSet("owner_a", PA1, 400)).error).toBeNull();
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: false, p_reason: "fixture release", p_actor: U.padmin });
      await credits.adjust(EA, -(balance(EA) + 100), `mon-neg-${RUN}`, "fixture: negative balance", U.padmin);
      expect((await ownerSet("owner_a", PA1, 4_000)).error?.code).toBe("TW007");
      await resetMoney(EA);
    });

    it("the platform administrator path needs a written reason, a real admin, and stays inside the ceiling", async () => {
      await clearLimitsAndMoney();
      expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: EA, p_actor: U.owner_a, p_limit_cents: 1_000, p_effective_month: null, p_reason: "an owner is not a platform admin" })).error?.code).toBe("42501");
      expect((await adminSet(EA, 1_000, null, "short")).error?.code).toBe("22023");
      expect((await adminSet(EA, 50_001, null, "above the platform ceiling for sure")).error?.code).toBe("TW013");
      expect((await adminSet(EA, 1_000, null, "support set this at the owner's request")).error).toBeNull();
      expect(psql(`select changed_by_role from public.studio_sms_monthly_limits where legal_entity_id = '${EA}'`)).toBe("platform_admin");
    });

    it("a limit scheduled for a future month governs only from that month; the current month is untouched; the latest decision for a month wins", async () => {
      await clearLimitsAndMoney();
      const cur = curKey(EA);
      const next = addMonths(cur, 1);
      const later = addMonths(cur, 2);
      expect((await adminSet(EA, 1_000)).error).toBeNull();
      expect((await adminSet(EA, 2_500, next)).error).toBeNull();
      expect((await adminSet(EA, 400, later)).error).toBeNull();
      const limitIn = (key: string) => Number(psql(`select public._tw4ml_limit_for('${EA}', '${key}')`));
      expect([limitIn(cur), limitIn(next), limitIn(later), limitIn(addMonths(cur, 5))]).toEqual([1_000, 2_500, 400, 400]);
      expect((await adminSet(EA, 1_700)).error).toBeNull(); // an immediate change in the current month does not erase the scheduled ones
      expect([limitIn(cur), limitIn(next), limitIn(later)]).toEqual([1_700, 2_500, 400]);
      expect((await adminSet(EA, 900, next)).error).toBeNull(); // a newer decision for the same month replaces the older one
      expect(limitIn(next)).toBe(900);
    });

    it("the platform ceiling bounds every limit: the effective limit is the lesser, a lower platform ceiling bites at once, and a higher ceiling for one business needs a separate approval", async () => {
      await clearLimitsAndMoney();
      await fund(EA, PA1, 10_000);
      await fund(EB, PB1, 10_000);
      expect(psql(`select public._tw4ml_ceiling_for('${EA}')`)).toBe("50000"); // the initial $500, a bound and not an authorization
      expect((await adminSet(EA, 40_000)).error).toBeNull();
      expect((await adminSet(EB, 40_000)).error).toBeNull();
      // lowering the platform ceiling below a configured limit caps the effective limit immediately
      expect((await rpc("tw4_limit_ceiling_set_platform", { p_actor: U.padmin, p_cents: 1_000, p_approval_ref: "ops decision lowering the ceiling" })).error).toBeNull();
      expect(Number(psql(`select public._tw4ml_effective_limit('${EA}', '${curKey(EA)}')`))).toBe(1_000);
      expect((await usage(EA, PA1, 1_001, "over-ceiling")).error?.code).toBe("TW012");
      expect((await usage(EA, PA1, 1_000, "at-ceiling")).error).toBeNull();
      // an owner cannot exceed it; only a separately authorized approval raises it for ONE business
      expect((await ownerSet("owner_a", PA1, 1_001)).error?.code).toBe("TW013");
      for (const bad of [{ p_actor: U.owner_a, p_cents: 5_000, p_approval_ref: "an owner is not a platform admin" }, { p_actor: U.padmin, p_cents: 5_000, p_approval_ref: "short" }, { p_actor: U.padmin, p_cents: -1, p_approval_ref: "negative ceiling is nonsense" }]) {
        expect((await rpc("tw4_limit_ceiling_approve_entity", { p_entity_id: EA, ...bad })).error?.code).toBeTruthy();
      }
      expect((await rpc("tw4_limit_ceiling_approve_entity", { p_entity_id: EA, p_actor: U.padmin, p_cents: 5_000, p_approval_ref: "approved in writing by the founder" })).error).toBeNull();
      expect(psql(`select public._tw4ml_ceiling_for('${EA}')`)).toBe("5000");
      expect(psql(`select public._tw4ml_ceiling_for('${EB}')`)).toBe("1000"); // another business keeps the platform ceiling
      expect((await ownerSet("owner_a", PA1, 5_000)).error).toBeNull();
      expect((await ownerSet("owner_b", PB1, 5_000)).error?.code).toBe("TW013");
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where action = 'monthly_limit_ceiling' and note like '%entity=${EA}%'`)).toBe("1");
      await clearLimitsAndMoney();
    });
  });

  describe("SMS usage honours funds AND the month's limit", () => {
    it("usage fits the limit exactly; the next cent is refused; a replay of an earlier debit still succeeds; a refund frees room; both conditions fail closed", async () => {
      await clearLimitsAndMoney();
      await fund(EA, PA1, 5_000);
      expect((await adminSet(EA, 1_000)).error).toBeNull();
      expect((await usage(EA, PA1, 600, "u1")).error).toBeNull();
      expect((await usage(EA, PA1, 401, "u2")).error?.code).toBe("TW012");
      expect((await usage(EA, PA1, 400, "u3")).error).toBeNull();
      expect(spend(EA)).toBe(1_000);
      expect((await usage(EA, PA1, 1, "u4")).error?.code).toBe("TW012");
      expect((await usage(EA, PA1, 600, "u1")).error).toBeNull(); // the same key again: a replay, not a second debit
      expect(spend(EA)).toBe(1_000);
      expect(balance(EA)).toBe(4_000);
      expect((await rpc("tw4_credit_refund_usage", { p_entity_id: EA, p_cents: 200, p_key: `r1-${RUN}`, p_original_key: `u1-${RUN}` })).error).toBeNull();
      expect(spend(EA)).toBe(800);
      expect((await usage(EA, PA1, 200, "u5")).error).toBeNull();
      expect((await usage(EA, PA1, 1, "u6")).error?.code).toBe("TW012");
      // the limit is open but the credit is not
      expect((await adminSet(EA, 50_000)).error).toBeNull();
      await credits.adjust(EA, -(balance(EA) - 50), `mon-low-${RUN}`, "fixture: 50 cents of credit left", U.padmin);
      expect((await usage(EA, PA1, 51, "u7")).error?.code).toBe("TW007");
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: hold for usage", p_actor: U.padmin });
      expect((await usage(EA, PA1, 10, "u8")).error?.code).toBe("TW007");
      await resetMoney(EA);
    });

    it("concurrency: twelve simultaneous debits against a limit that fits five succeed exactly five times, and the books reconcile", async () => {
      await clearLimitsAndMoney();
      await fund(EA, PA1, 5_000);
      expect((await adminSet(EA, 500)).error).toBeNull();
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => usage(EA, PA1, 100, `race-${i}`)));
      expect(results.filter((r) => !r.error)).toHaveLength(5);
      expect(results.filter((r) => r.error?.code === "TW012")).toHaveLength(7);
      expect(spend(EA)).toBe(500);
      expect(balance(EA)).toBe(4_500);
      expect((await credits.verify(EA)).ok).toBe(true);
      await resetMoney(EA);
    });

    it("concurrency: a limit decrease racing debits leaves a consistent result, and nothing is spent once the decrease has taken effect", async () => {
      await clearLimitsAndMoney();
      await fund(EA, PA1, 5_000);
      expect((await adminSet(EA, 2_000)).error).toBeNull();
      const ops = await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => usage(EA, PA1, 100, `dec-${i}`)),
        ownerSet("owner_a", PA1, 300),
      ]);
      expect(ops[10].error).toBeNull();
      const after = spend(EA);
      expect(after).toBeLessThanOrEqual(1_000); // never more than the ten attempts
      expect(after % 100).toBe(0);
      const refused = ops.slice(0, 10).filter((r) => r.error);
      for (const r of refused) expect(r.error?.code).toBe("TW012");
      // whatever happened, spending beyond the new limit cannot happen any more
      expect((await usage(EA, PA1, 100, "dec-after")).error?.code).toBe(after >= 300 ? "TW012" : undefined);
      expect((await credits.verify(EA)).ok).toBe(true);
      await resetMoney(EA);
    });

    it("concurrency: simultaneous limit changes leave exactly the decisions made, all audited, and one effective limit", async () => {
      await clearLimitsAndMoney();
      const results = await Promise.all([1_000, 2_000, 3_000, 4_000, 5_000, 6_000].map((cents) => adminSet(EA, cents)));
      expect(results.every((r) => !r.error)).toBe(true);
      expect(psql(`select count(*) from public.studio_sms_monthly_limits where legal_entity_id = '${EA}'`)).toBe("6");
      expect(psql(`select count(distinct previous_limit_cents) from public.studio_sms_monthly_limits where legal_entity_id = '${EA}'`)).toBe("6"); // each saw the one before it: serialized
      expect([1_000, 2_000, 3_000, 4_000, 5_000, 6_000]).toContain(Number(psql(`select public._tw4ml_limit_for('${EA}', '${curKey(EA)}')`)));
    });
  });

  describe("recurring charges: the first month is set aside, charged against the month, and no longer counted against the setup budget", () => {
    it("authorizing needs a configured limit with room and settled credit; it sets the first month aside (setup spending cannot consume it); the first charge captures that very reservation", async () => {
      await clearLimitsAndMoney();
      clearAuths();
      expect((await authorize("owner_a", PA1, "monthly")).error?.code).toBe("TW012"); // no limit yet
      expect((await adminSet(EA, 1_000)).error).toBeNull();
      expect((await authorize("owner_a", PA1, "monthly")).error?.code).toBe("TW012"); // 1500 does not fit under 1000
      expect((await adminSet(EA, 3_000)).error).toBeNull();
      expect((await authorize("owner_a", PA1, "monthly")).error?.code).toBe("TW007"); // no credit to set aside
      await fund(EA, PA1, 2_500);
      const made = await authorize("owner_a", PA1, "monthly");
      expect(made.error, JSON.stringify(made.error)).toBeNull();
      const id = (made.data as { authorization_id: string }).authorization_id;
      expect(reservedCents(EA)).toBe(1_500);
      expect(balance(EA)).toBe(2_500);
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and idempotency_key = 'reserve:commit:${id}'`)).toBe("1");
      expect(spend(EA)).toBe(1_500); // the set-aside month counts toward the limit
      // other spending cannot touch the set-aside funds: 2500 - 1500 reserved = 1000 available
      expect((await usage(EA, PA1, 1_001, "into-commitment")).error?.code).toBe("TW007");
      expect((await usage(EA, PA1, 1_000, "outside-commitment")).error).toBeNull();
      // the first charge captures the commitment: no new reserve entry, one capture, the same reservation, reconciled
      const gapsBefore = psql("select public._tw4rc_reconciliation_gaps()");
      const reserveEntriesBefore = psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and kind = 'reserve'`);
      const charged = await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null });
      expect(charged.data).toMatchObject({ outcome: "charged", replayed: false });
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and kind = 'reserve'`)).toBe(reserveEntriesBefore);
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and idempotency_key = 'capture:commit:${id}'`)).toBe("1");
      expect(reservedCents(EA)).toBe(0);
      expect(balance(EA)).toBe(2_500 - 1_000 - 1_500);
      expect(spend(EA)).toBe(1_500 + 1_000); // the commitment became a capture within the month: counted once
      expect(psql(`select (select reservation_id from public.studio_sms_recurring_charges where authorization_id = '${id}') = commitment_reservation_id from public.studio_sms_recurring_authorizations where id = '${id}'`)).toBe("t");
      expect(psql("select public._tw4rc_reconciliation_gaps()")).toBe(gapsBefore); // the captured set-aside leaves no reconciliation gap
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ replayed: true });
      expect(spend(EA)).toBe(2_500);
      expect((await credits.verify(EA)).ok).toBe(true);
      // the second month is an ordinary reserve + capture and counts against ITS month
      const prev = addMonths(curKey(EA), -1);
      aged(`update public.studio_sms_recurring_authorizations set starts_at = now() - interval '40 days' where id = '${id}';`);
      await fund(EA, PA1, 2_500);
      expect((await adminSet(EA, 6_000)).error).toBeNull();
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: prev, p_run_id: null })).data).toMatchObject({ outcome: "charged" });
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and idempotency_key = 'capture:rec:${id}:${prev}'`)).toBe("1");
      expect(spend(EA)).toBe(4_000); // charged now, so it counts in this month even though it pays for last month's service
      await resetMoney(EA);
      clearAuths();
    });

    it("a charge that would pass the month's limit is held (nothing taken), recorded, and goes through when the owner raises the limit or the next month begins", async () => {
      await clearLimitsAndMoney();
      clearAuths();
      await fund(EA, PA1, 5_000);
      expect((await adminSet(EA, 1_500)).error).toBeNull();
      const made = await authorize("owner_a", PA1, "monthly", { p_term_months: 3 });
      const id = (made.data as { authorization_id: string }).authorization_id;
      psql(`select public._tw4rc_release_commitment('${id}')`);
      expect((await usage(EA, PA1, 100, "uses-the-room")).error).toBeNull();
      const before = balance(EA);
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "held", reason: "monthly spending limit reached" });
      expect(balance(EA)).toBe(before);
      expect(psql(`select status || ':' || reason from public.studio_sms_recurring_charges where authorization_id = '${id}'`)).toBe("held:monthly spending limit reached");
      expect((await adminSet(EA, 1_600)).error).toBeNull();
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "charged" });
      expect(balance(EA)).toBe(before - 1_500);
      await resetMoney(EA);
      clearAuths();
    });

    it("recurring charges no longer count toward the cumulative SETUP budget, which setup fees keep using", async () => {
      await clearLimitsAndMoney();
      clearAuths();
      await fund(EA, PA1, 5_000);
      expect((await adminSet(EA, 10_000)).error).toBeNull();
      const id = ((await authorize("owner_a", PA1, "monthly")).data as { authorization_id: string }).authorization_id;
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "charged" });
      expect(Number(psql(`select public._tw4f3a_committed('${EA}')`))).toBe(0); // the setup budget is untouched by a recurring fee
      expect(Number(psql(`select spend_cap_cents from public.studio_sms_legal_entities where id = '${EA}'`))).toBe(15_000);
      // a setup-fee authorization still draws on (and is bounded by) the cumulative budget
      expect((await rpc("tw4_price_set", { p_kind: "brand", p_customer_cents: 20_000, p_provider_cents: 100, p_description: "fixture brand price over the budget", p_actor: U.padmin })).error).toBeNull();
      expect((await rpc("tw4_spend_authorize", { p_entity_id: EA, p_kind: "brand", p_amount_cents: 20_000, p_approval_ref: "fixture approval ref", p_actor: U.padmin })).error?.code).toBe("TW004");
      expect((await rpc("tw4_price_set", { p_kind: "brand", p_customer_cents: 5_000, p_provider_cents: 100, p_description: "fixture brand price within the budget", p_actor: U.padmin })).error).toBeNull();
      const event = await rpc("tw4_spend_authorize", { p_entity_id: EA, p_kind: "brand", p_amount_cents: 5_000, p_approval_ref: "fixture approval ref", p_actor: U.padmin });
      expect(event.error).toBeNull();
      expect(Number(psql(`select public._tw4f3a_committed('${EA}')`))).toBe(5_000);
      expect(spend(EA)).toBe(1_500); // and the setup fee is not a routine cost of the month
      await rpc("tw4_spend_withdraw", { p_spend_event_id: (event.data as { spend_event_id: string }).spend_event_id, p_actor: U.padmin, p_note: "fixture: withdraw the setup authorization" });
      aged(`delete from public.studio_sms_spend_events where legal_entity_id = '${EA}'; delete from public.studio_sms_price_list where kind = 'brand' and created_by = '${U.padmin}';`);
      await resetMoney(EA);
      clearAuths();
    });

    it("revoking releases the set-aside month; an ended term is released by the scheduler's housekeeping; nothing is released twice", async () => {
      await clearLimitsAndMoney();
      clearAuths();
      await fund(EA, PA1, 5_000);
      expect((await adminSet(EA, 10_000)).error).toBeNull();
      const a = ((await authorize("owner_a", PA1, "monthly")).data as { authorization_id: string }).authorization_id;
      const b = ((await authorize("owner_a", PA2, "number")).data as { authorization_id: string }).authorization_id;
      expect(reservedCents(EA)).toBe(2_000);
      expect((await rpc("tw4_recurring_revoke", { p_authorization_id: a, p_user_id: U.owner_a })).data).toMatchObject({ status: "revoked" });
      expect(reservedCents(EA)).toBe(500);
      expect((await rpc("tw4_recurring_revoke", { p_authorization_id: a, p_user_id: U.owner_a })).data).toMatchObject({ replayed: true });
      expect(reservedCents(EA)).toBe(500);
      aged(`update public.studio_sms_recurring_authorizations set expires_at = now() - interval '1 hour' where id = '${b}';`);
      expect((await rpc("tw4_recurring_release_ended")).data).toMatchObject({ released: 1 });
      expect(reservedCents(EA)).toBe(0);
      expect((await rpc("tw4_recurring_release_ended")).data).toMatchObject({ released: 0 });
      expect((await credits.verify(EA)).ok).toBe(true);
      await resetMoney(EA);
      clearAuths();
    });

    it("concurrency: simultaneous authorizations of one charge set aside the first month exactly once, and simultaneous charges capture it exactly once", async () => {
      await clearLimitsAndMoney();
      clearAuths();
      await fund(EA, PA1, 5_000);
      expect((await adminSet(EA, 10_000)).error).toBeNull();
      const made = await Promise.all(Array.from({ length: 6 }, () => authorize("owner_a", PA1, "monthly")));
      expect(made.filter((r) => !r.error)).toHaveLength(1);
      expect(made.filter((r) => r.error?.code === "23505")).toHaveLength(5);
      expect(reservedCents(EA)).toBe(1_500);
      const id = (made.find((r) => !r.error)!.data as { authorization_id: string }).authorization_id;
      const charges = await Promise.all(Array.from({ length: 8 }, () => rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })));
      expect(charges.every((r) => !r.error)).toBe(true);
      expect(charges.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
      expect(balance(EA)).toBe(3_500);
      expect(reservedCents(EA)).toBe(0);
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and idempotency_key like 'capture:%${id}%'`)).toBe("1");
      expect((await credits.verify(EA)).ok).toBe(true);
      await resetMoney(EA);
      clearAuths();
    });
  });

  describe("review findings: set-asides in later months, refunds, manual resolution, indexes", () => {
    it("a set-aside made in an earlier month and captured by a later month's charge is counted ONCE, in the month it was set aside, and does not hold the later month", async () => {
      await clearLimitsAndMoney();
      clearAuths();
      await fund(EA, PA1, 5_000);
      expect((await adminSet(EA, 1_500)).error).toBeNull(); // the limit is exactly the recurring price
      const id = ((await authorize("owner_a", PA1, "monthly")).data as { authorization_id: string }).authorization_id;
      const prev = addMonths(curKey(EA), -1);
      const mid = psql(`select to_char(public._tw4ml_month_start('${EA}', '${prev}') + interval '10 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
      aged(`update public.studio_sms_credit_reservations set created_at = '${mid}' where reservation_key = 'commit:${id}'; update public.studio_sms_credit_ledger set created_at = '${mid}' where idempotency_key = 'reserve:commit:${id}';`);
      expect(spend(EA, prev)).toBe(1_500);
      expect(spend(EA)).toBe(0);
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "charged" });
      expect(spend(EA, prev)).toBe(1_500); // still where it was set aside
      expect(spend(EA)).toBe(0); // and not again in this month
      expect((await usage(EA, PA1, 1_500, "room-still-there")).error).toBeNull();
      await resetMoney(EA);
      clearAuths();
    });

    it("a set-aside is NOT captured when a refund or reversal took the credit behind it: the charge is recorded unfunded and the set-aside is kept", async () => {
      await clearLimitsAndMoney();
      clearAuths();
      await fund(EA, PA1, 2_500);
      expect((await adminSet(EA, 10_000)).error).toBeNull();
      const id = ((await authorize("owner_a", PA1, "monthly")).data as { authorization_id: string }).authorization_id;
      await credits.adjust(EA, -balance(EA), `mon-refunded-${RUN}`, "fixture: the funded top-up was refunded", U.padmin);
      expect(reservedCents(EA)).toBe(1_500);
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "unfunded" });
      expect(balance(EA)).toBe(0);
      expect(psql(`select status from public.studio_sms_credit_reservations where reservation_key = 'commit:${id}'`)).toBe("reserved");
      await credits.adjust(EA, -balance(EA) + 100, `mon-refunded2-${RUN}`, "fixture: a small credit is left", U.padmin);
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "unfunded" }); // 100 < 1500
      await resetMoney(EA);
      clearAuths();
    });

    it("an administrator cannot capture or release a recurring set-aside by hand; revoking releases it", async () => {
      await clearLimitsAndMoney();
      clearAuths();
      await fund(EA, PA1, 2_500);
      expect((await adminSet(EA, 10_000)).error).toBeNull();
      const id = ((await authorize("owner_a", PA1, "monthly")).data as { authorization_id: string }).authorization_id;
      const res = psql(`select id from public.studio_sms_credit_reservations where reservation_key = 'commit:${id}'`);
      for (const outcome of ["captured", "released"]) {
        const r = await rpc("tw4_credit_resolve_reservation", { p_reservation_id: res, p_outcome: outcome, p_actor: U.padmin, p_note: "fixture: manual attempt" });
        expect(r.error?.code, outcome).toBe("22023");
      }
      expect(psql(`select status from public.studio_sms_credit_reservations where id = '${res}'`)).toBe("reserved");
      expect((await rpc("tw4_recurring_revoke", { p_authorization_id: id, p_user_id: U.owner_a })).data).toMatchObject({ status: "revoked" });
      expect(psql(`select status from public.studio_sms_credit_reservations where id = '${res}'`)).toBe("released");
      await resetMoney(EA);
      clearAuths();
    });

    it("the month-spend queries are indexed by business and time", () => {
      expect(psql("select count(*) from pg_indexes where indexname in ('studio_sms_credit_ledger_entity_created', 'studio_sms_credit_reservations_entity_created')")).toBe("2");
    });
  });

  describe("the pilot business", () => {
    it("keeps its separate pilot ceiling: usage is limited by the monthly limit and paid from CREDIT only, never from the pilot; recurring stays per-operation", async () => {
      await clearLimitsAndMoney();
      clearAuths();
      await fund(EB, PB1, 5_000);
      expect((await adminSet(EB, 500)).error).toBeNull();
      const out = inPilotTxnOut(
        EB,
        `select (public.tw4_credit_debit_usage('${EB}', '${PB1}', 300, 'pilot-usage-${RUN}', 'fixture')->>'replayed');
         select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EB}' and funding = 'pilot';
         select count(*) from public.studio_sms_pilot_exceptions where legal_entity_id = '${EB}';
         select (select ceiling_cents from public.studio_sms_pilot_exceptions where legal_entity_id = '${EB}');`,
      );
      const lines = out.split("\n").filter((l) => /^[0-9a-z]+$/.test(l) && l !== "BEGIN");
      expect(lines.slice(-4)).toEqual(["false", "0", "1", "15000"]); // usage debited the credit; no pilot reservation exists; the ceiling is still $150 and untouched
      const standing = psqlError(`begin; set local session_replication_role = replica; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${EB}', 15000, 'fixture approval reference text', '${U.padmin}'); reset session_replication_role; select public.tw4_recurring_authorize('${PB1}', '${U.owner_b}', 'monthly', ${price("monthly")}, 3, ${price("monthly") * 3}); rollback;`);
      expect(standing).toContain("pilot business: each recurring operation needs its own approval");
      const noLimit = psqlError(`begin; set local session_replication_role = replica; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${EB}', 15000, 'fixture approval reference text', '${U.padmin}'); reset session_replication_role; select public.tw4_credit_debit_usage('${EB}', '${PB1}', 600, 'pilot-too-much-${RUN}', 'fixture'); rollback;`);
      expect(noLimit).toContain("the monthly spending limit would be exceeded"); // the pilot exception does not lift the monthly limit
      expect(balance(EB)).toBe(5_000);
      await resetMoney(EB);
    });
  });

  describe("tenant isolation and the screen's data", () => {
    it("each business sees and changes only its own limit; the overview is for owners and administrators of that studio only", async () => {
      await clearLimitsAndMoney();
      await fund(EA, PA1, 2_500);
      expect((await adminSet(EA, 1_234)).error).toBeNull();
      expect((await adminSet(EB, 4_321)).error).toBeNull();
      const a = await getMonthlyLimitOverview(as("owner_a") as never, PA1);
      expect(a).toMatchObject({ legalBusiness: true, limitCents: 1_234, effectiveLimitCents: 1_234, ceilingCents: 50_000, usageCents: 0, availableCents: 2_500 });
      expect(a?.timezone).toBeTruthy();
      expect(JSON.stringify(a)).not.toContain("4321");
      expect((await getMonthlyLimitOverview(as("admin_a") as never, PA1))?.limitCents).toBe(1_234); // administrators can look
      const b = await getMonthlyLimitOverview(as("owner_b") as never, PB1);
      expect(b?.limitCents).toBe(4_321);
      expect(await getMonthlyLimitOverview(as("owner_b") as never, PA1)).toBeNull();
      expect(await getMonthlyLimitOverview(as("fd_a") as never, PA1)).toBeNull();
      expect((await getMonthlyLimitOverview(as("owner_x") as never, PX))?.legalBusiness).toBe(false);
      // changing A's limit never changes B's
      expect((await ownerSet("owner_a", PA2, 900)).error).toBeNull(); // owner of location 2 of business A: the same legal business
      expect(Number(psql(`select public._tw4ml_limit_for('${EA}', '${curKey(EA)}')`))).toBe(900);
      expect(Number(psql(`select public._tw4ml_limit_for('${EB}', '${curKey(EB)}')`))).toBe(4_321);
      expect((await ownerSet("owner_a2", PA2, 800)).error).toBeNull(); // a sole owner of location 2 may set it too: it is the same business's limit
      await resetMoney(EA);
    });

    it("the application layer maps database answers to plain codes and passes the session's user, never the body's", async () => {
      await clearLimitsAndMoney();
      const base = { studioId: PA1, userId: U.owner_a, limitCents: 700, confirmed: true as const };
      expect(await code(setMonthlyLimit(admin as never, { ...base, userId: U.fd_a }))).toBe("not_authorized");
      expect(await code(setMonthlyLimit(admin as never, { ...base, limitCents: 50_001 }))).toBe("above_ceiling");
      expect(await code(setMonthlyLimit(admin as never, { ...base, confirmed: false as never }))).toBe("invalid");
      expect(await code(setMonthlyLimit(admin as never, { ...base, effectiveMonth: "2020-01" }))).toBe("invalid");
      expect(await code(setMonthlyLimit(admin as never, { ...base, studioId: PX, userId: U.owner_x }))).toBe("no_legal_business");
      aged(`update auth.users set last_sign_in_at = null where id = '${U.owner_a}';`);
      expect(await code(setMonthlyLimit(admin as never, base))).toBe("reauth_required");
      aged(`update auth.users set last_sign_in_at = now() where id = '${U.owner_a}';`);
      expect(await setMonthlyLimit(admin as never, base)).toMatchObject({ limitCents: 700, previousLimitCents: 0 });
      expect(await code(setEntityTimezone(admin as never, { studioId: PA1, userId: U.fd_a, timezone: "UTC", reason: "no" + "pe" }))).toBe("not_authorized");
      expect(await setEntityTimezone(admin as never, { studioId: PA1, userId: U.owner_a, timezone: "America/Chicago", reason: "the studio moved" })).toMatchObject({ timezone: "America/Chicago" });
      aged(`delete from public.studio_sms_entity_timezones where legal_entity_id = '${EA}' and effective_month <> '1970-01';`);
    });
  });

  it("the rollback refuses while limits, ceilings, timezone changes or set-aside commitments exist", async () => {
    await clearLimitsAndMoney();
    expect((await adminSet(EA, 1_000)).error).toBeNull();
    const rollback = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261128090000_twilio_monthly_spending_limits_rollback.sql"), "utf8");
    expect(psqlError(rollback)).toContain("rollback refused");
  });

  async function clearLimitsAndMoney() {
    clearLimits();
    setBaseTz(EA, "UTC");
    setBaseTz(EB, "UTC");
    await resetMoney(EA);
    await resetMoney(EB);
  }
});
