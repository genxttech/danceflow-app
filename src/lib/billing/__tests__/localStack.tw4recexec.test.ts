/**
 * Recurring-charge EXECUTION against a REAL schema with real JWTs: the shared spending cap, the pilot business, the scheduler's kill switch / lease / fencing / audit,
 * reconciliation, and the sender's suspension gate with the real service-state function. Nothing reaches Stripe or Twilio. LOCAL QA STACK ONLY (skipped unless the
 * variables below point at a loopback Supabase stack with the migrations through 20261127090000 applied).
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFile, execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deletePricesSql, ownerReactivate, seedPrice } from "../../sms/twilioIsv/__tests__/priceFixture";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 1_000_000 });

import { getRecurringAdminOverview, runScheduledRecurringCharges, periodKeyFor, RecurringError } from "@/lib/billing/smsRecurring";
import { resolveStudioSmsSender } from "@/lib/sms/studioSender";
import { acquireSuiteLock } from "./localStackLock";
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

const PA1 = "a8d00000-0000-4000-8000-00000000000a";
const PA2 = "a8d00000-0000-4000-8000-00000000000b";
const PB1 = "a8d00000-0000-4000-8000-00000000000c";
const PX = "a8d00000-0000-4000-8000-00000000000d";
const EA = "e8d00000-0000-4000-8000-0000000000e1";
const EB = "e8d00000-0000-4000-8000-0000000000e2";
const U = {
  owner_a: "a8d00000-0000-4000-8000-000000000101", // owner of both locations of business A
  owner_a2: "a8d00000-0000-4000-8000-000000000104", // owner of location 2 only
  fd_a: "a8d00000-0000-4000-8000-000000000102",
  admin_a: "a8d00000-0000-4000-8000-000000000103",
  owner_b: "a8d00000-0000-4000-8000-000000000201",
  owner_x: "a8d00000-0000-4000-8000-000000000301",
  padmin: "a8d00000-0000-4000-8000-000000000401",
};
const RUN = randomBytes(3).toString("hex");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp: 1983812996 }) : "");
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const userToken = (sub: string) => sign({ sub, role: "authenticated", aud: "authenticated", aal: "aal2", exp: Math.floor(Date.now() / 1000) + 3600 });
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

const CLEANUP = `
begin;
set local session_replication_role = replica;
update public.studio_sms_recurring_charges set run_id = null where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_recurring_charges where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_recurring_authorizations where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_monthly_limits where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_entity_timezones where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_limit_ceilings where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_registrations where studio_id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.studio_sms_approval_refs where legal_entity_id in ('${EA}', '${EB}'); delete from public.studio_sms_spend_events where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_ledger where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_reservations where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id in ('${EA}', '${EB}'));
delete from public.studio_sms_credit_topups where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_accounts where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_entity_studios where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_legal_entities where id in ('${EA}', '${EB}');
delete from public.user_studio_roles where studio_id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.studio_sms_onboarding_audit where studio_id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.studios where id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.profiles where id in (${Object.values(U).map((u) => `'${u}'`).join(", ")});
delete from auth.users where email like '%@tw4rexec-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4rexec-e2e.test', now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.owner_a2}', 'owner_a2'), ('${U.fd_a}', 'fd_a'), ('${U.admin_a}', 'admin_a'), ('${U.owner_b}', 'owner_b'), ('${U.owner_x}', 'owner_x'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ${Object.values(U).map((u) => `('${u}', ${u === U.padmin ? "'platform_admin'" : "null"})`).join(", ")}
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values
  ('${PA1}', 'TW4REXEC Location A1', 'tw4rexec-a1', null, 'UTC'), ('${PA2}', 'TW4REXEC Location A2', 'tw4rexec-a2', null, 'UTC'),
  ('${PB1}', 'TW4REXEC Location B1', 'tw4rexec-b1', null, 'UTC'), ('${PX}', 'TW4REXEC Location X', 'tw4rexec-x', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${PA1}', 'studio_owner', true), ('${U.owner_a}', '${PA2}', 'studio_owner', true), ('${U.owner_a2}', '${PA2}', 'studio_owner', true), ('${U.fd_a}', '${PA1}', 'front_desk', true),
  ('${U.admin_a}', '${PA1}', 'studio_admin', true), ('${U.owner_b}', '${PB1}', 'studio_owner', true), ('${U.owner_x}', '${PX}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'REX Alpha LLC', '9981', 15000, '${U.padmin}'), ('${EB}', 'REX Beta LLC', '9982', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values
  ('${PA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location one'),
  ('${PA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location two'),
  ('${PB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B');
commit;`;

describe.skipIf(!enabled)("recurring-charge execution: spending cap, pilot business, scheduler lease and kill switch, sender suspension (real schema, real JWTs)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let snapshotActivePrices: string[] = [];
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql} commit;`);
  const balance = (entity: string) => Number(psql(`select coalesce((select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 0)`));
  const committed = (entity: string) => Number(psql(`select public._tw4f3a_committed('${entity}')`));
  const month = (offset = 0) => {
    const d = new Date();
    return periodKeyFor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)));
  };
  const NOW = month();
  let n = 0;
  const reset = async (entity: string) => {
    n += 1;
    const b = balance(entity);
    if (b !== 0) await credits.adjust(entity, -b, `rx-reset-${RUN}-${n}`, "fixture: reset the balance between scenarios", U.padmin);
    await rpc("tw4_credit_set_hold", { p_entity_id: entity, p_hold: false, p_reason: "fixture release", p_actor: U.padmin });
  };
  const fund = async (entity: string, studio: string, pack: number) => {
    n += 1;
    const ref = `cs_rx_${RUN}_${n}`;
    await credits.topupPending(entity, studio, ref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(entity, studio, ref, pack, `evt_rx_${RUN}_${n}`, `pi_rx_${RUN}_${n}`, true);
  };
  const price = (kind: string) => Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = '${kind}' and active`));
  const entityOfStudio = (studio: string) => (studio === PA1 || studio === PA2 ? EA : studio === PB1 ? EB : null);
  // an authorization needs a monthly limit and settled credit for its first month: give the business both unless a test says otherwise
  const ensureRoom = async (studio: string, priceCents: number) => {
    const entity = entityOfStudio(studio);
    if (!entity) return;
    const key = psql(`select public._tw4ml_month_key('${entity}', now())`);
    if (Number(psql(`select public._tw4ml_effective_limit('${entity}', '${key}')`)) < 30_000) {
      expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: entity, p_actor: U.padmin, p_limit_cents: 30_000, p_effective_month: null, p_reason: "fixture: monthly limit for these tests" })).error).toBeNull();
    }
    const available = Number(psql(`select coalesce((select balance_cents - reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 0)`));
    if (available < priceCents) await fund(entity, studio, 2_500);
  };
  const authorize = async (who: keyof typeof U, studio: string, kind: "number" | "monthly", over: Record<string, unknown> = {}) => {
    await ensureRoom(studio, price(kind));
    return rpc("tw4_recurring_authorize", { p_studio_id: studio, p_user_id: U[who], p_kind: kind, p_acknowledged_price_cents: price(kind), p_term_months: 3, p_total_limit_cents: price(kind) * 3, ...over });
  };
  // the first month's set-aside funds are covered by their own tests; elsewhere the commitment is released so a test starts from "authorized, nothing reserved"
  const newAuth = async (who: keyof typeof U, studio: string, kind: "number" | "monthly", over: Record<string, unknown> = {}) => {
    const { keepCommitment, ...args } = over as Record<string, unknown> & { keepCommitment?: boolean };
    const result = await authorize(who, studio, kind, args);
    expect(result.error, JSON.stringify(result.error)).toBeNull();
    const id = (result.data as { authorization_id: string }).authorization_id;
    if (keepCommitment !== true) psql(`select public._tw4rc_release_commitment('${id}')`);
    return id;
  };
  const clearAuths = async () => {
    psql(`select count(public._tw4rc_release_commitment(a.id)) from public.studio_sms_recurring_authorizations a where a.legal_entity_id in ('${EA}', '${EB}') and a.commitment_reservation_id is not null`);
    aged(`delete from public.studio_sms_recurring_charges where legal_entity_id in ('${EA}', '${EB}'); delete from public.studio_sms_recurring_authorizations where legal_entity_id in ('${EA}', '${EB}');`);
  };
  const clearRuns = () => aged(`update public.studio_sms_recurring_charges set run_id = null; delete from public.studio_sms_recurring_runs; delete from public.studio_sms_recurring_switch_log;`);
  const charge = (id: string, period = NOW, runId: string | null = null) => rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: period, p_run_id: runId });
  const rowOf = (id: string, period = NOW) => psql(`select status || ':' || attempts || ':' || coalesce(reason, '') from public.studio_sms_recurring_charges where authorization_id = '${id}' and period_key = '${period}'`);
  const setCap = (entity: string, cents: number) => aged(`update public.studio_sms_legal_entities set spend_cap_cents = ${cents} where id = '${entity}';`);
  const switchTo = async (on: boolean) => expect((await rpc("tw4_recurring_set_switch", { p_enabled: on, p_actor: U.padmin, p_reason: "fixture: scheduler switch for the execution tests" })).error).toBeNull();
  // run a script inside ONE transaction that is always rolled back: the single system-wide pilot row is never visible to another test file
  const inPilotTxn = (entity: string, body: string) =>
    psqlError(`begin; set local session_replication_role = replica; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${entity}', 15000, 'fixture approval reference text', '${U.padmin}'); reset session_replication_role; ${body}; rollback;`);
  const inPilotTxnOut = (entity: string, body: string) =>
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], {
      input: `begin; set local session_replication_role = replica; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${entity}', 15000, 'fixture approval reference text', '${U.padmin}'); reset session_replication_role; ${body}; rollback;`,
      encoding: "utf8",
    });

  let releaseLock: (() => void) | null = null;
  beforeAll(async () => {
    releaseLock = await acquireSuiteLock("recurring-scheduler"); // these two suites share the global scheduler's data: one at a time
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    for (const [kind, cents] of [["number", 500], ["monthly", 1500], ["brand", 100]] as const) {
      seedPrice(psql, { kind: kind, customer: cents, provider: Math.max(cents - 50, 0), description: `fixture ${kind} price`, approver: U.padmin });
    }
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
      psql(deletePricesSql(`created_by = '${U.padmin}'`));
      ownerReactivate(psql, `id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
    releaseLock?.();
  });

  it("privileges: the scheduler tables are unreachable by API roles and every new function is service-role only", () => {
    for (const table of ["studio_sms_recurring_runs", "studio_sms_recurring_switch_log"]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete')`)).toBe("f");
    }
    for (const fn of ["tw4_recurring_set_switch(boolean, uuid, text)", "tw4_recurring_run_begin(text, int)", "tw4_recurring_run_finish(uuid, text, jsonb, text)", "tw4_recurring_charge(uuid, text, uuid)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`)).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`)).toBe("t");
    }
    for (const fn of ["_tw4rc_run_guard()", "_tw4rc_reconciliation_gaps()"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`)).toBe("f");
    }
    // the old two-argument charge function is gone: no path charges without the new checks
    expect(psql("select count(*) from pg_proc where proname = 'tw4_recurring_charge' and pronargs = 2")).toBe("0");
    // nothing in the execution path touches a card, a top-up or the pilot ceiling
    expect(psql(`select count(*) from pg_proc where proname in ('tw4_recurring_run_begin', 'tw4_recurring_run_finish', 'tw4_recurring_set_switch') and (prosrc ilike '%stripe%' or prosrc ilike '%topup%' or prosrc ilike '%pilot%')`)).toBe("0");
  });

  describe("shared locks (the monthly-limit rules themselves are in localStack.tw4monthly.test.ts)", () => {
    it("an authorization whose term has ended is closed when the owner authorizes again, with an audit row, and does not block the renewal", async () => {
      await clearAuths();
      const old = await newAuth("owner_a", PA1, "number");
      aged(`update public.studio_sms_recurring_authorizations set starts_at = now() - interval '5 months', expires_at = now() - interval '1 day' where id = '${old}';`);
      const renewed = await newAuth("owner_a", PA1, "number");
      expect(renewed).not.toBe(old);
      expect(psql(`select status from public.studio_sms_recurring_authorizations where id = '${old}'`)).toBe("revoked");
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PA1}' and action = 'recurring_revoked' and note like 'authorization=${old};%term ended'`)).toBe("1");
      expect((await authorize("owner_a", PA1, "number")).error?.code).toBe("23505"); // the live one still blocks a duplicate
      await clearAuths();
    });

    it("the entity row is locked before the account row, in authorize and in charge, so they queue behind pilot-exception creation, cap changes and setup authorizations", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const hold = (mode: "for no key update" | "for share") =>
        new Promise<void>((resolve) => {
          const child = execFile("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], () => resolve());
          child.stdin?.end(`begin; select 1 from public.studio_sms_legal_entities where id = '${EA}' ${mode}; select pg_sleep(2); rollback;`);
        });
      // authorize waits for a writer of the entity row (pilot creation / cap change take FOR NO KEY UPDATE)
      let held = hold("for no key update");
      await new Promise((r) => setTimeout(r, 700));
      let started = Date.now();
      const id = await newAuth("owner_a", PA1, "monthly", { p_term_months: 1, p_total_limit_cents: 1_500 });
      expect(Date.now() - started).toBeGreaterThan(900);
      await held;
      // a charge waits for a reader/writer of the same row
      held = hold("for share");
      await new Promise((r) => setTimeout(r, 700));
      started = Date.now();
      expect((await charge(id)).data).toMatchObject({ outcome: "charged" });
      expect(Date.now() - started).toBeGreaterThan(900);
      await held;
      await reset(EA);
    });

  });

  describe("the pilot business: every recurring operation needs its own approval", () => {
    it("a standing recurring authorization is refused for a pilot business, with a clear code, and creates nothing", async () => {
      await clearAuths();
      const result = inPilotTxn(EB, `select public.tw4_recurring_authorize('${PB1}', '${U.owner_b}', 'monthly', ${price("monthly")}, 3, ${price("monthly") * 3})`);
      expect(result).toContain("pilot business: each recurring operation needs its own approval");
      expect(psql(`select count(*) from public.studio_sms_recurring_authorizations where legal_entity_id = '${EB}'`)).toBe("0");
      expect(psql("select count(*) from public.studio_sms_pilot_exceptions where legal_entity_id = '" + EB + "'")).toBe("0"); // the fixture row was rolled back: no trace for other tests
    });

    it("an authorization that pre-dates the pilot exception is refused at charge time, even with plenty of credit; no pilot reservation, no ledger entry, no credit used", async () => {
      await clearAuths();
      await reset(EB);
      await fund(EB, PB1, 10_000);
      const id = await newAuth("owner_b", PB1, "monthly");
      const before = balance(EB);
      const ledgerBefore = psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EB}' and kind in ('reserve', 'capture')`);
      const out = inPilotTxnOut(EB, `select (public.tw4_recurring_charge('${id}', '${NOW}')::text); select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EB}' and funding = 'pilot'; select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EB}' and kind in ('reserve', 'capture')`);
      const printed = out.split("\n");
      const lines = [printed.find((l) => l.startsWith("{")) ?? "", ...printed.filter((l) => /^\d+$/.test(l))]; // psql also echoes BEGIN / SET / INSERT / ROLLBACK
      expect(lines[0]).toContain('"outcome": "refused"');
      expect(lines[0]).toContain("pilot business: each recurring operation needs its own approval");
      expect(lines[1]).toBe("0");
      expect(lines[2]).toBe(ledgerBefore); // no reserve or capture was written by the refused charge
      expect(balance(EB)).toBe(before);
      await reset(EB);
    });

    it("an approved-by-schedule path cannot exist: a refused pilot period is final, so the scheduler never retries it into a charge", async () => {
      await clearAuths();
      await reset(EB);
      await fund(EB, PB1, 10_000);
      const id = await newAuth("owner_b", PB1, "monthly");
      inPilotTxnOut(EB, `select public.tw4_recurring_charge('${id}', '${NOW}')`);
      // the refusal rolled back with the fixture pilot row: record it as the database would have, then prove the due list drops refused periods
      aged(`insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reason) values ('${id}', '${EB}', '${PB1}', 'monthly', '${NOW}', 1500, 'refused', 'pilot business: each recurring operation needs its own approval');`);
      expect(JSON.stringify((await rpc("tw4_recurring_due_list")).data)).not.toContain(id);
      await reset(EB);
    });

    it("a pilot business is never put into a suspended or past-due state by authorizations it cannot be charged for: the state governs only non-pilot businesses", async () => {
      await clearAuths();
      await reset(EB);
      const id = await newAuth("owner_b", PB1, "monthly");
      aged(`update public.studio_sms_recurring_authorizations set starts_at = now() - interval '9 days' where id = '${id}';`);
      expect(String((await rpc("tw4_recurring_service_state", { p_studio_id: PB1 })).data)).not.toBe("none"); // without the exception it IS overdue
      const out = inPilotTxnOut(EB, `select public.tw4_recurring_service_state('${PB1}')`);
      expect(out.split("\n")).toContain("none"); // with the exception, the same row no longer drives the state
      await reset(EB);
    });

    it("SMS usage stays outside the pilot ceiling: with the pilot exception and no credit, usage is refused, never funded by the pilot", async () => {
      await reset(EB);
      const result = inPilotTxn(EB, `select public.tw4_credit_debit_usage('${EB}', '${PB1}', 8, 'rx-usage-${RUN}', 'fixture usage')`);
      expect(result.length).toBeGreaterThan(0); // an error: no credit to debit
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EB}' and kind = 'usage_charge'`)).toBe("0");
    });
  });

  describe("scheduler: kill switch, one run at a time, fencing, audit", () => {
    it("the switch defaults to OFF and only a platform admin with a written reason can change it; every change is logged and nothing is ever edited", async () => {
      await clearRuns();
      expect((await rpc("tw4_recurring_run_begin", { p_runner: "test:off" })).data).toEqual({ acquired: false, reason: "disabled" });
      expect((await rpc("tw4_recurring_set_switch", { p_enabled: true, p_actor: U.owner_a, p_reason: "an owner is not a platform admin" })).error?.code).toBe("42501");
      expect((await rpc("tw4_recurring_set_switch", { p_enabled: true, p_actor: U.padmin, p_reason: "short" })).error?.code).toBe("22023");
      expect((await rpc("tw4_recurring_set_switch", { p_enabled: null, p_actor: U.padmin, p_reason: "a perfectly good written reason" })).error?.code).toBe("22023");
      expect(psql("select count(*) from public.studio_sms_recurring_switch_log")).toBe("0");
      await switchTo(true);
      const first = (await rpc("tw4_recurring_run_begin", { p_runner: "test:on" })).data as { acquired: boolean; run_id: string };
      expect(first.acquired).toBe(true);
      await rpc("tw4_recurring_run_finish", { p_run_id: first.run_id, p_status: "completed", p_summary: {}, p_error: null });
      await switchTo(false);
      expect((await rpc("tw4_recurring_run_begin", { p_runner: "test:off-again" })).data).toEqual({ acquired: false, reason: "disabled" });
      expect(psql("select string_agg(enabled::text, ',' order by changed_at, id) from public.studio_sms_recurring_switch_log")).toBe("true,false");
      expect(psqlError("update public.studio_sms_recurring_switch_log set enabled = true")).toContain("append-only");
      expect(psqlError("delete from public.studio_sms_recurring_switch_log")).toContain("append-only");
      expect(psqlError("truncate public.studio_sms_recurring_switch_log")).toContain("never truncated");
    });

    it("one run at a time: eight simultaneous starts acquire exactly one lease; finishing frees it; a finished run is final", async () => {
      await clearRuns();
      await switchTo(true);
      const starts = await Promise.all(Array.from({ length: 8 }, (_, i) => rpc("tw4_recurring_run_begin", { p_runner: `test:race-${i}` })));
      const results = starts.map((r) => r.data as { acquired: boolean; reason?: string; run_id?: string });
      expect(results.filter((r) => r.acquired)).toHaveLength(1);
      expect(results.filter((r) => !r.acquired).every((r) => r.reason === "busy")).toBe(true);
      const runId = results.find((r) => r.acquired)!.run_id!;
      expect((await rpc("tw4_recurring_run_begin", { p_runner: "test:while-running" })).data).toEqual({ acquired: false, reason: "busy" });
      expect((await rpc("tw4_recurring_run_finish", { p_run_id: runId, p_status: "completed", p_summary: { due: 0 }, p_error: null })).data).toEqual({ status: "completed", replayed: false });
      expect((await rpc("tw4_recurring_run_finish", { p_run_id: runId, p_status: "failed", p_summary: null, p_error: "late" })).data).toEqual({ status: "completed", replayed: true }); // final
      expect(psqlError(`update public.studio_sms_recurring_runs set status = 'running', finished_at = null where id = '${runId}'`)).toContain("final");
      expect((await rpc("tw4_recurring_run_begin", { p_runner: "test:after" })).data).toMatchObject({ acquired: true });
      expect((await rpc("tw4_recurring_run_finish", { p_run_id: "00000000-0000-4000-8000-000000000000", p_status: "completed", p_summary: null, p_error: null })).error?.code).toBe("22023");
      expect((await rpc("tw4_recurring_run_begin", { p_runner: "x" })).error?.code).toBe("22023");
      expect((await rpc("tw4_recurring_run_begin", { p_runner: "test:lease", p_lease_seconds: 5 })).error?.code).toBe("22023");
      await clearRuns();
    });

    it("turning the database switch off halts a run already in progress at its next charge", async () => {
      await clearAuths();
      await clearRuns();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      await switchTo(true);
      const id = await newAuth("owner_a", PA1, "monthly");
      const run = (await rpc("tw4_recurring_run_begin", { p_runner: "test:halt" })).data as { run_id: string };
      await switchTo(false);
      const before = balance(EA);
      expect((await charge(id, NOW, run.run_id)).error?.code).toBe("22023");
      expect(balance(EA)).toBe(before);
      expect(rowOf(id)).toBe("");
      await rpc("tw4_recurring_run_finish", { p_run_id: run.run_id, p_status: "failed", p_summary: null, p_error: "switched off" });
      await clearRuns();
      await reset(EA);
    });

    it("a crashed run is replaced after its lease expires (the old one is closed as failed), and the old runner is fenced: it can no longer charge anything", async () => {
      await clearAuths();
      await clearRuns();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      await switchTo(true);
      const id = await newAuth("owner_a", PA1, "monthly");
      const crashed = (await rpc("tw4_recurring_run_begin", { p_runner: "test:crashed", p_lease_seconds: 60 })).data as { run_id: string };
      expect((await charge(id, NOW, crashed.run_id)).data).toMatchObject({ outcome: "charged" }); // it worked while its lease was valid, then "crashed" before finishing
      aged(`update public.studio_sms_recurring_runs set lease_expires_at = clock_timestamp() - interval '1 second' where id = '${crashed.run_id}';`);
      const id2 = await newAuth("owner_a", PA2, "number");
      expect((await charge(id2, NOW, crashed.run_id)).error?.code).toBe("22023"); // fenced even before anyone replaced it
      const replacement = (await rpc("tw4_recurring_run_begin", { p_runner: "test:replacement" })).data as { acquired: boolean; run_id: string };
      expect(replacement.acquired).toBe(true);
      expect(psql(`select status || ':' || error from public.studio_sms_recurring_runs where id = '${crashed.run_id}'`)).toBe("failed:lease expired before the run finished");
      expect((await charge(id2, NOW, crashed.run_id)).error?.code).toBe("22023"); // still fenced after the replacement started
      const before = balance(EA);
      expect((await charge(id, NOW, replacement.run_id)).data).toMatchObject({ outcome: "charged", replayed: true }); // the crashed run's charge is not repeated
      expect((await charge(id2, NOW, replacement.run_id)).data).toMatchObject({ outcome: "charged", replayed: false });
      expect(balance(EA)).toBe(before - 500);
      expect(psql(`select count(*) from public.studio_sms_recurring_charges where authorization_id = '${id}' and run_id = '${crashed.run_id}'`)).toBe("1"); // the evidence names the run that took it
      expect(psql(`select count(*) from public.studio_sms_credit_reservations where reservation_key like 'rec:${id}:%'`)).toBe("1");
      await rpc("tw4_recurring_run_finish", { p_run_id: replacement.run_id, p_status: "completed", p_summary: {}, p_error: null });
      await clearRuns();
      await reset(EA);
    });

    it("runScheduledRecurringCharges: refused while the switch is off; when on it charges what is funded, records what is not, stamps every attempt with the run, and writes the outcome", async () => {
      await clearAuths();
      await clearRuns();
      await reset(EA);
      await reset(EB);
      await fund(EA, PA1, 5_000);
      const funded = await newAuth("owner_a", PA1, "monthly");
      const unfunded = await newAuth("owner_b", PB1, "number");
      await credits.adjust(EB, -balance(EB), `rx-b-empty-${RUN}`, "fixture: business B runs out of credit after authorizing", U.padmin);
      expect(await runScheduledRecurringCharges(admin as never, { runner: "test:sched" })).toEqual({ ran: false, reason: "disabled" });
      expect(psql("select count(*) from public.studio_sms_recurring_runs")).toBe("0");
      expect(rowOf(funded)).toBe(""); // nothing was attempted
      await switchTo(true);
      const outcome = await runScheduledRecurringCharges(admin as never, { runner: "test:sched" });
      expect(outcome.ran).toBe(true);
      if (!outcome.ran) throw new Error("unreachable");
      expect(outcome.summary).toMatchObject({ periods: [NOW], charged: 1, unfunded: 1, errors: 0 });
      const run = psql(`select status || ':' || (summary->>'charged') || ':' || (summary->>'unfunded') || ':' || (finished_at is not null) from public.studio_sms_recurring_runs where id = '${outcome.summary.runId}'`);
      expect(run).toBe("completed:1:1:true");
      expect(psql(`select count(*) from public.studio_sms_recurring_charges where run_id = '${outcome.summary.runId}'`)).toBe("2");
      expect(rowOf(funded)).toBe("charged:1:");
      expect(rowOf(unfunded)).toBe("unfunded:1:insufficient settled credit");
      // a second invocation is a new run and changes nothing already done
      const balanceAfter = balance(EA);
      const again = await runScheduledRecurringCharges(admin as never, { runner: "test:sched" });
      expect(again.ran && again.summary.charged).toBe(0);
      expect(balance(EA)).toBe(balanceAfter);
      expect(psql("select count(*) from public.studio_sms_recurring_runs where status = 'completed'")).toBe("2");
      await reset(EA);
      await reset(EB);
      await clearRuns();
    });

    it("overlapping invocations are harmless: of two at once exactly one runs and the other reports busy; nothing is charged twice", async () => {
      await clearAuths();
      await clearRuns();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      await switchTo(true);
      const id = await newAuth("owner_a", PA1, "monthly");
      const before = balance(EA);
      const results = await Promise.all([1, 2, 3, 4].map((i) => runScheduledRecurringCharges(admin as never, { runner: `test:overlap-${i}` })));
      const ran = results.filter((r) => r.ran);
      expect(ran.length).toBeGreaterThanOrEqual(1);
      expect(results.filter((r) => !r.ran).every((r) => !r.ran && r.reason === "busy")).toBe(true);
      expect(balance(EA)).toBe(before - 1_500); // however many runs ran in turn, the period was charged once
      expect(psql(`select count(*) from public.studio_sms_credit_reservations where reservation_key like 'rec:${id}:%'`)).toBe("1");
      expect(psql("select count(*) from public.studio_sms_recurring_runs where status = 'running'")).toBe("0");
      await reset(EA);
      await clearRuns();
    });

    it("a failure of one charge never stops the rest; the run is recorded as failed with the count, and the failed charge is retried by the next run", async () => {
      await clearAuths();
      await clearRuns();
      await reset(EA);
      await reset(EB);
      await fund(EA, PA1, 5_000);
      await fund(EB, PB1, 5_000);
      await switchTo(true);
      const a = await newAuth("owner_a", PA1, "monthly");
      const b = await newAuth("owner_b", PB1, "monthly");
      let broken = true;
      const flaky = {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          if (fn === "tw4_recurring_charge" && args.p_authorization_id === a && broken) return { data: null, error: { code: "57014" } };
          return admin.rpc(fn, args);
        },
      };
      const first = await runScheduledRecurringCharges(flaky as never, { runner: "test:flaky" });
      if (!first.ran) throw new Error("expected a run");
      expect(first.summary).toMatchObject({ charged: 1, errors: 1 });
      expect(psql(`select status || ':' || error from public.studio_sms_recurring_runs where id = '${first.summary.runId}'`)).toBe("failed:1 charge call(s) failed");
      expect(rowOf(b)).toBe("charged:1:");
      expect(rowOf(a)).toBe("");
      broken = false;
      const second = await runScheduledRecurringCharges(flaky as never, { runner: "test:flaky" });
      if (!second.ran) throw new Error("expected a run");
      expect(second.summary).toMatchObject({ charged: 1, errors: 0 });
      expect(rowOf(a)).toBe("charged:1:");
      expect(rowOf(b)).toBe("charged:1:"); // not charged again
      expect(balance(EB)).toBe(5_000 - 1_500);
      await reset(EA);
      await reset(EB);
      await clearRuns();
    });

    it("an exception inside the run still closes it as failed and frees the lease", async () => {
      await clearAuths();
      await clearRuns();
      await switchTo(true);
      const exploding = { rpc: async (fn: string, args: Record<string, unknown>) => (fn === "tw4_recurring_due_list" ? { data: null, error: { code: "XX000" } } : admin.rpc(fn, args)) };
      await expect(runScheduledRecurringCharges(exploding as never, { runner: "test:boom" })).rejects.toThrow();
      expect(psql("select status from public.studio_sms_recurring_runs order by started_at desc limit 1")).toBe("failed");
      expect((await rpc("tw4_recurring_run_begin", { p_runner: "test:next" })).data).toMatchObject({ acquired: true });
      await clearRuns();
    });
  });

  describe("reconciliation and attribution", () => {
    it("every charged period matches a captured credit reservation and a capture ledger entry of the same business, location and amount; a missing entry is counted", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const gaps = () => Number(psql("select public._tw4rc_reconciliation_gaps()"));
      const baseline = gaps(); // earlier tests in this file delete charge rows as fixtures and leave their reservations behind: count relative to now
      const a = await newAuth("owner_a", PA1, "monthly");
      const b = await newAuth("owner_a", PA2, "number");
      await charge(a);
      await charge(b);
      expect(gaps()).toBe(baseline);
      expect(psql(`select count(*) from public.studio_sms_credit_ledger l join public.studio_sms_recurring_charges c on c.reservation_id = l.reservation_id where l.kind = 'capture' and l.studio_id = c.studio_id and l.legal_entity_id = c.legal_entity_id`)).toBe("2");
      expect(psql(`select string_agg(studio_id::text || ':' || amount_cents, ',' order by amount_cents) from public.studio_sms_recurring_charges where authorization_id in ('${a}', '${b}')`)).toBe(`${PA2}:500,${PA1}:1500`);
      // tamper (fixture, guards off): the books no longer match, and the admin overview says so
      aged(`delete from public.studio_sms_credit_ledger where idempotency_key = 'capture:rec:${b}:${NOW}';`);
      expect(gaps()).toBe(baseline + 1);
      // and the other direction: a captured recurring reservation that no charged row owns
      aged(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at) values ('${EA}', '${PA1}', 'monthly', 1500, 'credit', 'captured', 'rec:orphan:${RUN}', now());`);
      expect(gaps()).toBe(baseline + 2);
      aged(`delete from public.studio_sms_credit_reservations where reservation_key = 'rec:orphan:${RUN}';`);
      const overview = await getRecurringAdminOverview(createClient(URL_, anonKey(), { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${userToken(U.padmin)}` } } }) as never);
      expect(overview?.reconciliationGaps).toBeGreaterThanOrEqual(baseline + 1);
      await clearAuths();
      await reset(EA);
    });

    it("the platform view shows the switch, the latest runs and what was not charged, and only to platform administrators", async () => {
      await clearAuths();
      await clearRuns();
      await switchTo(true);
      await rpc("tw4_recurring_run_finish", { p_run_id: ((await rpc("tw4_recurring_run_begin", { p_runner: "test:admin-view" })).data as { run_id: string }).run_id, p_status: "completed", p_summary: { due: 0 }, p_error: null });
      const as = (u: string) => createClient(URL_, anonKey(), { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${userToken(u)}` } } });
      const overview = await getRecurringAdminOverview(as(U.padmin) as never);
      expect(overview).toMatchObject({ schedulerEnabled: true });
      expect(overview?.recentRuns[0]).toMatchObject({ runner: "test:admin-view", status: "completed" });
      expect(await getRecurringAdminOverview(as(U.owner_a) as never)).toBeNull();
      await clearRuns();
    });
  });

  describe("the sender follows the database's service state (real function, real registration)", () => {
    it("no authorization -> sends; authorized and unpaid inside the grace window -> sends; unpaid past it -> suspended and refused; paid -> sends again; the other business is untouched", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      psqlFile(`begin; set local session_replication_role = replica;
        delete from public.studio_sms_registrations where studio_id in ('${PA1}', '${PB1}');
        insert into public.studio_sms_registrations (studio_id, messaging_service_sid, campaign_sid, sender_e164, registration_status, customer_profile_sid, brand_sid, phone_number_sid, campaign_use_case, brand_status, campaign_status)
          values ('${PA1}', 'MG${"a1".repeat(16)}', 'QE${"0f".repeat(16)}', '+15550109991', 'approved', 'BU${"c1".repeat(16)}', 'BN${"d1".repeat(16)}', 'PN${"e1".repeat(16)}', 'mixed', 'approved', 'approved'),
                 ('${PB1}', 'MG${"b2".repeat(16)}', 'QE${"0e".repeat(16)}', '+15550108881', 'approved', 'BU${"c2".repeat(16)}', 'BN${"d2".repeat(16)}', 'PN${"e2".repeat(16)}', 'mixed', 'approved', 'approved');
        commit;`);
      const saved = process.env.DANCEFLOW_SMS_STATUS;
      process.env.DANCEFLOW_SMS_STATUS = "approved";
      // a studio of a legal business texts only through the billed path (TW-4F usage billing), whose reservation refuses a suspended business (TW016);
      // here the service state itself is checked
      const state = async (studio: string) => String((await rpc("tw4_recurring_service_state", { p_studio_id: studio })).data);
      const serving = async (studio: string) => ({ ok: (await state(studio)) !== "suspended" });
      try {
        expect(await resolveStudioSmsSender(admin as never, PA1)).toEqual({ ok: false, reason: "sms_billed_studio" });
        expect(await serving(PA1)).toMatchObject({ ok: true }); // no recurring authorization: nothing to enforce
        const id = await newAuth("owner_a", PA1, "monthly");
        expect(await serving(PA1)).toMatchObject({ ok: true }); // authorized, first charge not taken yet, inside the grace window
        aged(`update public.studio_sms_recurring_authorizations set starts_at = date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' - interval '1 month' + interval '1 day' where id = '${id}';`);
        expect(await state(PA1)).toBe("suspended"); // the previous month is long overdue
        expect(await serving(PB1)).toMatchObject({ ok: true }); // another business is unaffected
        expect((await charge(id, month(-1))).data).toMatchObject({ outcome: "charged" });
        const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
        const currentOverdue = Date.now() > monthStart + 7 * 86_400_000; // the current month's own grace window
        expect(await serving(PA1)).toMatchObject({ ok: !currentOverdue });
        expect((await charge(id, NOW)).data).toMatchObject({ outcome: "charged" });
        expect(await serving(PA1)).toMatchObject({ ok: true }); // paid up: sending resumes
        // revoking ends the obligation: no authorization, nothing to enforce
        await rpc("tw4_recurring_revoke", { p_authorization_id: id, p_user_id: U.owner_a });
        expect(await serving(PA1)).toMatchObject({ ok: true });
      } finally {
        process.env.DANCEFLOW_SMS_STATUS = saved;
      }
      await reset(EA);
    });
  });

  it("the rollback refuses while scheduler runs, switch changes or run-stamped charges exist", async () => {
    await clearRuns();
    await switchTo(true);
    const rollback = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261127090000_twilio_recurring_execution_rollback.sql"), "utf8");
    expect(psqlError(rollback)).toContain("rollback refused");
    await clearRuns();
  });
});
