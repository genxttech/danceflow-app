/**
 * TW-4F-3b-0 (prepaid SMS credits) against a REAL schema. Owner decision 1: ONE prepaid balance per verified LEGAL BUSINESS, with usage and cost
 * attributed to the studio LOCATION it belongs to; no funding, balance or approval crosses legal businesses. Covers the append-only ledger, settled-only
 * funding (packs, $500 ceiling), atomic debits under concurrency, replays, reversals and negative-balance blocking, holds, the low-balance flag, the
 * one-time founder-authorized pilot grant, reconciliation records and what a studio owner may see, using the real SQL functions (service role, through
 * PostgREST). The reservation / capture / release path of the runner is exercised in `localStack.tw4f3a.test.ts`.
 * LOCAL QA STACK ONLY (skipped unless the variables below point at a loopback Supabase stack with TW-4A .. TW-4F-3a and the 3b-0 migration applied).
 * Synthetic fixtures; no Twilio and no Stripe call is possible.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { SupabaseCreditStore } from "../creditStore";
import { RunnerStoreError } from "../store";

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

const X1 = "a3b00000-0000-4000-8000-00000000000a"; // location 1 of legal business 1
const X2 = "a3b00000-0000-4000-8000-00000000000b"; // location 2 of legal business 1
const Y = "a3b00000-0000-4000-8000-00000000000c"; // the only location of legal business 2
const E1 = "e3b00000-0000-4000-8000-0000000000e1";
const E2 = "e3b00000-0000-4000-8000-0000000000e2";
const U = {
  owner_x: "a3b00000-0000-4000-8000-000000000101", // owns BOTH locations of business 1
  fd_x2: "a3b00000-0000-4000-8000-000000000102",
  owner_y: "a3b00000-0000-4000-8000-000000000201",
  padmin: "a3b00000-0000-4000-8000-000000000401",
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp: 1983812996 }) : "");
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const userToken = (sub: string) => sign({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
function client(token: string | null, key = anonKey()): SupabaseClient {
  return createClient(URL_, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: token ? { Authorization: `Bearer ${token}` } : {} } });
}
const as = (who: keyof typeof U) => client(userToken(U[who]));
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
const count = (sql: string) => Number(psql(sql));

const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_credit_ledger where legal_entity_id in ('${E1}', '${E2}');
delete from public.studio_sms_credit_reservations where legal_entity_id in ('${E1}', '${E2}');
delete from public.studio_sms_credit_topups where legal_entity_id in ('${E1}', '${E2}');
delete from public.studio_sms_provider_charges where legal_entity_id in ('${E1}', '${E2}');
delete from public.studio_sms_credit_accounts where legal_entity_id in ('${E1}', '${E2}');
delete from public.studio_sms_price_list where created_by = '${U.padmin}';
delete from public.studio_sms_entity_studios where legal_entity_id in ('${E1}', '${E2}');
delete from public.studio_sms_legal_entities where id in ('${E1}', '${E2}');
delete from public.user_studio_roles where studio_id in ('${X1}', '${X2}', '${Y}');
delete from public.studio_sms_onboarding_audit where studio_id in ('${X1}', '${X2}', '${Y}');
delete from public.studios where id in ('${X1}', '${X2}', '${Y}');
delete from public.profiles where id in ('${U.owner_x}', '${U.fd_x2}', '${U.owner_y}', '${U.padmin}');
delete from auth.users where email like '%@tw4f3b-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('${U.owner_x}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_x@tw4f3b-e2e.test', now(), now()),
  ('${U.fd_x2}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fd_x2@tw4f3b-e2e.test', now(), now()),
  ('${U.owner_y}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_y@tw4f3b-e2e.test', now(), now()),
  ('${U.padmin}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin@tw4f3b-e2e.test', now(), now());
insert into public.profiles (id, platform_role) values ('${U.owner_x}', null), ('${U.fd_x2}', null), ('${U.owner_y}', null), ('${U.padmin}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  ('${X1}', 'TW4F3B E2E Location X1', 'tw4f3b-e2e-x1', null), ('${X2}', 'TW4F3B E2E Location X2', 'tw4f3b-e2e-x2', null), ('${Y}', 'TW4F3B E2E Location Y', 'tw4f3b-e2e-y', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_x}', '${X1}', 'studio_owner', true), ('${U.owner_x}', '${X2}', 'studio_owner', true), ('${U.fd_x2}', '${X2}', 'front_desk', true), ('${U.owner_y}', '${Y}', 'studio_owner', true);
-- two verified legal businesses (fixture shortcut: the verification flow itself is covered by the 3a suite)
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${E1}', 'F3B Alpha LLC', '1111', 15000, '${U.padmin}'), ('${E2}', 'F3B Beta LLC', '2222', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values
  ('${X1}', '${E1}', 'founding', '${U.padmin}', 'fixture: verified business one, location one'),
  ('${X2}', '${E1}', 'founding', '${U.padmin}', 'fixture: verified business one, location two'),
  ('${Y}', '${E2}', 'founding', '${U.padmin}', 'fixture: verified business two');
commit;`;

describe.skipIf(!enabled)("TW-4F-3b-0 prepaid credit: one balance per legal business, attributed by location (real SQL functions)", () => {
  let credits: SupabaseCreditStore;
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof RunnerStoreError ? error.code : `other:${String(error)}`;
    }
  };
  const account = (entity: string) => psql(`select balance_cents || ':' || reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'`);
  const ledgerCount = (entity: string) => count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${entity}'`);

  beforeAll(() => {
    credits = new SupabaseCreditStore(client(null, serviceKey()));
    psqlFile(FIXTURES);
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
    } catch {
      /* best effort */
    }
  });

  it("every credit function is executable by the service role only (the three read functions by studio managers), and the tables have no API privileges", () => {
    // Asserted from the catalog: a permission-denied call by anon / authenticated crashes the supautils hint hook of this local image.
    const admin = [
      "tw4_price_set(text, int, int, text, uuid)", "tw4_credit_topup_pending(uuid, uuid, text, int)", "tw4_credit_settle_topup(uuid, uuid, text, int, text)",
      "tw4_credit_reverse_topup(text, int, text, text)", "tw4_credit_topup_failed(text, text)", "tw4_credit_adjust(uuid, bigint, text, text, uuid)",
      "tw4_credit_grant_pilot(uuid, int, text, uuid)", "tw4_credit_set_hold(uuid, boolean, text, uuid)", "tw4_credit_set_threshold(uuid, int, uuid)",
      "tw4_credit_debit_usage(uuid, uuid, int, text, text)", "tw4_credit_refund_usage(uuid, int, text, text)", "tw4_credit_record_provider_charge(uuid, uuid, text, text, int, uuid)",
      "tw4_credit_verify(uuid)", "tw4_spend_settle(uuid, text, text, text, text)", "tw4_spend_reserve(uuid, text, text)", "tw4_spend_authorize(uuid, text, int, text, uuid)",
      "tw4_credit_resolve_reservation(uuid, text, uuid, text)", "tw4_credit_open_reservations(uuid, uuid)", "tw4_spend_withdraw(uuid, uuid, text)",
      "_tw4c_lock(uuid)", "_tw4c_post(uuid, uuid, text, bigint, bigint, text, uuid, text, uuid, text)", "_tw4c_admin(uuid)", "_tw4c_any_location(uuid)", "_tw4c_immutable_guard()",
    ];
    const checks: string[] = [];
    for (const fn of admin) {
      for (const role of ["anon", "authenticated"]) checks.push(`select case when has_function_privilege('${role}', 'public.${fn}', 'execute') then '${role} may execute ${fn}' end`);
      if (!fn.startsWith("_")) checks.push(`select case when not has_function_privilege('service_role', 'public.${fn}', 'execute') then 'service_role may not execute ${fn}' end`);
      if (fn.startsWith("_")) checks.push(`select case when has_function_privilege('service_role', 'public.${fn}', 'execute') then 'service_role may execute ${fn}' end`);
    }
    for (const fn of ["sms_credit_overview(uuid)", "sms_credit_history(uuid, int, bigint)", "sms_price_list()"]) {
      checks.push(`select case when not has_function_privilege('authenticated', 'public.${fn}', 'execute') then 'authenticated may not execute ${fn}' end`);
      checks.push(`select case when has_function_privilege('anon', 'public.${fn}', 'execute') then 'anon may execute ${fn}' end`);
    }
    for (const table of ["studio_sms_price_list", "studio_sms_credit_accounts", "studio_sms_credit_reservations", "studio_sms_credit_ledger", "studio_sms_credit_topups", "studio_sms_provider_charges"]) {
      for (const role of ["anon", "authenticated", "service_role"]) checks.push(`select case when has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete') then '${role} has privileges on ${table}' end`);
      checks.push(`select case when not (select relrowsecurity from pg_class where oid = 'public.${table}'::regclass) then 'RLS off on ${table}' end`);
    }
    expect(psql(checks.join(" union all ") + " order by 1")).toBe("");
  });

  it("checkout rules: only $25 / $50 / $100 packs, and never above the $500 balance ceiling (balance + pending + the new pack); a pending payment is not spendable", async () => {
    expect(await code(credits.topupPending(E1, X1, "pi_odd", 3_000))).toBe("22023");
    expect(await code(credits.topupPending(E1, X1, "pi_odd", 100))).toBe("22023");
    await credits.topupPending(E1, X1, "pi_e1_1", 5_000);
    expect(ledgerCount(E1)).toBe(0);
    expect(await code(credits.debitUsage(E1, X1, 1, "pending-use", "m"))).toBe("TW007"); // nothing settled yet
    // ceiling: 5000 pending + 9 x 5000 = 50000 is the limit
    for (let i = 0; i < 9; i++) await credits.topupPending(E2, Y, `pi_ceiling_${i}`, 5_000); // E2: 45000 pending
    await credits.topupPending(E2, Y, "pi_ceiling_9", 5_000); // exactly 50000
    expect(await code(credits.topupPending(E2, Y, "pi_ceiling_10", 2_500))).toBe("TW009");
    for (let i = 0; i < 10; i++) await credits.topupFailed(`pi_ceiling_${i}`, `evt_c${i}`); // the pending ones fail: the ceiling frees up
    await credits.topupPending(E2, Y, "pi_ceiling_11", 10_000);
    await credits.topupFailed("pi_ceiling_11", "evt_c11");
    // the pending payment's location must belong to the SAME business
    expect(await code(credits.topupPending(E1, Y, "pi_cross", 2_500))).not.toBe("ok");
  });

  it("only a SETTLED payment becomes credit; replays credit nothing twice; a payment belongs to exactly one legal business", async () => {
    expect(await credits.settleTopup(E1, X1, "pi_e1_1", 5_000, "evt_1")).toEqual({ replayed: false });
    expect(account(E1)).toBe("5000:0");
    expect(await credits.settleTopup(E1, X1, "pi_e1_1", 5_000, "evt_1")).toEqual({ replayed: true }); // webhook retry
    expect(await credits.settleTopup(E1, X1, "pi_e1_1", 5_000, "evt_other")).toEqual({ replayed: true }); // same payment, different event id
    expect(account(E1)).toBe("5000:0");
    expect(await code(credits.settleTopup(E2, Y, "pi_e1_1", 5_000, "evt_y"))).toBe("23505"); // another business cannot claim it
    expect(await code(credits.settleTopup(E1, X1, "pi_e1_1", 4_000, "evt_x"))).toBe("23505");
    expect(await code(credits.settleTopup(E1, Y, "pi_cross_settle", 5_000, "evt_cross"))).not.toBe("ok"); // paid-by location of another business
    expect(count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${E1}' and ref = 'pi_cross_settle'`)).toBe(0);
    expect((await credits.verify(E1)).ok).toBe(true);
  });

  it("concurrent replays of one payment credit it exactly once", async () => {
    await Promise.all(Array.from({ length: 6 }, () => credits.settleTopup(E2, Y, "pi_e2_race", 2_500, "evt_race")));
    expect(account(E2)).toBe("2500:0");
    expect(count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${E2}' and kind = 'topup_settled'`)).toBe(1);
    expect((await credits.verify(E2)).ok).toBe(true);
  });

  it("usage by EITHER location debits the ONE business balance and is attributed to the location that sent; a location of another business is refused", async () => {
    await credits.debitUsage(E1, X1, 100, "u-x1", "m1");
    await credits.debitUsage(E1, X2, 250, "u-x2", "m2");
    expect(account(E1)).toBe("4650:0");
    expect(psql(`select studio_id = '${X1}' from public.studio_sms_credit_ledger where legal_entity_id = '${E1}' and idempotency_key = 'usage:u-x1'`)).toBe("t");
    expect(psql(`select studio_id = '${X2}' from public.studio_sms_credit_ledger where legal_entity_id = '${E1}' and idempotency_key = 'usage:u-x2'`)).toBe("t");
    // business 2's location cannot spend business 1's money, and business 1's location cannot be charged to business 2
    expect(await code(credits.debitUsage(E1, Y, 10, "u-cross-1", "m"))).toBe("22023");
    expect(await code(credits.debitUsage(E2, X1, 10, "u-cross-2", "m"))).toBe("22023");
    expect(count(`select count(*) from public.studio_sms_credit_ledger where idempotency_key like 'usage:u-cross-%'`)).toBe(0);
    // the database itself refuses a ledger row that attributes a location to the wrong business (composite foreign key)
    expect(psqlError(`insert into public.studio_sms_credit_ledger (legal_entity_id, seq, kind, balance_delta_cents, idempotency_key, studio_id) values ('${E1}', 9001, 'usage_charge', -1, 'sql-cross', '${Y}')`)).toContain("studio_sms_credit_ledger_location");
    expect(psqlError(`insert into public.studio_sms_credit_ledger (legal_entity_id, seq, kind, balance_delta_cents, idempotency_key) values ('${E1}', 9002, 'usage_charge', -1, 'sql-unattributed')`)).toContain("attributed");
    expect(account(E1)).toBe("4650:0");
    expect((await credits.verify(E1)).ok).toBe(true);
  });

  it("usage debits are atomic under concurrency: the balance can never be overdrawn, and a retried debit is not charged twice", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => code(credits.debitUsage(E2, Y, 300, `race-${i}`, `msg-${i}`))));
    expect(results.filter((r) => r === "ok")).toHaveLength(8); // 2500 / 300
    expect(results.filter((r) => r === "TW007")).toHaveLength(2);
    expect(account(E2)).toBe("100:0");
    const winner = results.findIndex((r) => r === "ok");
    expect(await credits.debitUsage(E2, Y, 300, `race-${winner}`, `msg-${winner}`)).toEqual({ replayed: true }); // replay succeeds without a charge, even though the balance is low
    expect(account(E2)).toBe("100:0");
    expect(await code(credits.debitUsage(E2, Y, 250, "too-much", "m"))).toBe("TW007");
    expect(await code(credits.debitUsage(E2, Y, 100, `race-${winner}`, "m"))).toBe("23505"); // a key is never reused for a different amount
    expect((await credits.verify(E2)).ok).toBe(true);
  });

  it("refunds credit back only part of a recorded usage charge of the SAME business, never more than it, and exactly once per key", async () => {
    await credits.debitUsage(E1, X2, 100, "refund-src", "SM-src");
    expect(account(E1)).toBe("4550:0");
    expect(await code(credits.refundUsage(E1, 10, "r0", "no-such-usage"))).toBe("22023");
    expect(await code(credits.refundUsage(E2, 10, "r0", "refund-src"))).toBe("22023"); // another business's charge
    expect(await credits.refundUsage(E1, 60, "r1", "refund-src")).toEqual({ replayed: false });
    expect(await credits.refundUsage(E1, 60, "r1", "refund-src")).toEqual({ replayed: true });
    expect(await code(credits.refundUsage(E1, 60, "r2", "refund-src"))).toBe("22023"); // 60 + 60 > 100
    expect(await credits.refundUsage(E1, 40, "r3", "refund-src")).toEqual({ replayed: false });
    // a long original key (the refund total is matched on the original ledger entry, not on a truncated key)
    const longKey = "k".repeat(190);
    await credits.debitUsage(E1, X1, 100, longKey, "SM-long");
    await credits.refundUsage(E1, 100, "long-r1", longKey);
    expect(await code(credits.refundUsage(E1, 1, "long-r2", longKey))).toBe("22023");
    expect(account(E1)).toBe("4650:0");
    expect(psql(`select studio_id = '${X2}' from public.studio_sms_credit_ledger where legal_entity_id = '${E1}' and idempotency_key = 'usage_refund:r1'`)).toBe("t"); // the refund follows the original attribution
    expect((await credits.verify(E1)).ok).toBe(true);
  });

  it("a failed payment is not credit and not pending; if Stripe later settles it anyway (the money was taken) it becomes credit exactly once; a settled payment cannot be failed", async () => {
    const before = account(E1);
    await credits.topupPending(E1, X1, "pi_fail", 2_500);
    await credits.topupFailed("pi_fail", "evt_fail");
    expect(account(E1)).toBe(before);
    expect(count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${E1}' and ref = 'pi_fail'`)).toBe(0);
    expect(await credits.settleTopup(E1, X1, "pi_fail", 2_500, "evt_fail_late")).toEqual({ replayed: false });
    expect(await credits.settleTopup(E1, X1, "pi_fail", 2_500, "evt_fail_late")).toEqual({ replayed: true });
    expect(count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${E1}' and ref = 'pi_fail'`)).toBe(1);
    expect(Number(account(E1).split(":")[0]) - Number(before.split(":")[0])).toBe(2_500);
    expect(await code(credits.topupFailed("pi_e1_1", "evt_x"))).toBe("22023"); // a settled payment cannot be failed
    expect(psqlError(`update public.studio_sms_credit_topups set status = 'pending' where provider_ref = 'pi_fail'`)).toContain("not edited"); // and nothing goes back to pending
    await credits.adjust(E1, -2_500, "undo-fail-test", "remove the late settled test payment from the balance", U.padmin);
  });

  it("a reversal takes the credit back once per payment event, can make the balance negative, and a negative balance blocks all spending until funded again", async () => {
    await credits.reverseTopup("pi_e1_1", 3_000, "evt_refund_1", "customer refund");
    await credits.reverseTopup("pi_e1_1", 3_000, "evt_refund_1", "customer refund (retry)");
    expect(account(E1)).toBe("1650:0");
    expect(await code(credits.reverseTopup("pi_e1_1", 2_500, "evt_refund_2", "more than was paid"))).toBe("22023"); // 3000 + 2500 > 5000
    expect(await code(credits.reverseTopup("pi_e1_1", 100, "", "no event id"))).toBe("22023");
    expect(await credits.reverseTopup("pi_e2_race", 50, "evt_refund_1", "other business, same event id")).toEqual({ replayed: false }); // the key includes the payment
    await credits.adjust(E2, 50, "restore-after-reuse-test", "restore the test balance after the reversal", U.padmin);
    await credits.debitUsage(E1, X1, 1_600, "use-x", "m");
    await credits.reverseTopup("pi_e1_1", 2_000, "evt_dispute", "lost dispute");
    expect(account(E1)).toBe("-1950:0");
    expect(await code(credits.debitUsage(E1, X2, 1, "blocked-neg", "m"))).toBe("TW007"); // BOTH locations are blocked by the shared balance
    expect(await code(credits.debitUsage(E1, X1, 1, "blocked-neg-2", "m"))).toBe("TW007");
    expect((await credits.verify(E1)).ok).toBe(true);
    await credits.settleTopup(E1, X1, "pi_e1_2", 5_000, "evt_2"); // funded again
    expect(await credits.debitUsage(E1, X2, 200, "ok-again", "m")).toEqual({ replayed: false });
    expect(account(E1)).toBe("2850:0");
  });

  it("adjustments need a written reason, are idempotent, and are audited", async () => {
    expect(await code(credits.adjust(E1, 100, "a1", "short", U.padmin))).toBe("22023");
    expect(await code(credits.adjust(E1, 0, "a1", "a long enough reason", U.padmin))).toBe("22023");
    expect(await code(credits.adjust(E1, 100, "a1", "goodwill credit for a failed send", U.owner_x))).toBe("42501");
    expect(await credits.adjust(E1, 100, "a1", "goodwill credit for a failed send", U.padmin)).toEqual({ replayed: false });
    expect(await credits.adjust(E1, 100, "a1", "goodwill credit for a failed send", U.padmin)).toEqual({ replayed: true });
    expect(account(E1)).toBe("2950:0");
    expect(count(`select count(*) from public.studio_sms_onboarding_audit where studio_id in ('${X1}', '${X2}') and action = 'credit_adjustment'`)).toBe(2); // the late-payment test adjustment and this one
  });

  it("a hold on the business blocks spending at every location without touching the balance; lifting it restores spending", async () => {
    expect(await code(credits.setHold(E1, true, "x", U.padmin))).not.toBe("ok");
    await credits.setHold(E1, true, "chargeback under review", U.padmin);
    expect(await code(credits.debitUsage(E1, X1, 1, "held-1", "m"))).toBe("TW007");
    expect(await code(credits.debitUsage(E1, X2, 1, "held-2", "m"))).toBe("TW007");
    expect(account(E1)).toBe("2950:0");
    await credits.setHold(E1, false, "", U.padmin);
    expect(await credits.debitUsage(E1, X1, 1, "unheld", "m")).toEqual({ replayed: false });
  });

  it("the low-balance threshold defaults to $10 and the flag is set once per dip and clears when funded", async () => {
    expect(psql(`select low_balance_threshold_cents from public.studio_sms_credit_accounts where legal_entity_id = '${E2}'`)).toBe("1000"); // E2 has dipped under $10 already
    expect(psql(`select (low_balance_flagged_at is not null)::text from public.studio_sms_credit_accounts where legal_entity_id = '${E2}'`)).toBe("true");
    const first = psql(`select low_balance_flagged_at::text from public.studio_sms_credit_accounts where legal_entity_id = '${E2}'`);
    await credits.debitUsage(E2, Y, 1, "low-1", "m");
    expect(psql(`select low_balance_flagged_at::text from public.studio_sms_credit_accounts where legal_entity_id = '${E2}'`)).toBe(first); // flagged once per dip
    await credits.settleTopup(E2, Y, "pi_e2_refill", 5_000, "evt_refill");
    expect(psql(`select (low_balance_flagged_at is null)::text from public.studio_sms_credit_accounts where legal_entity_id = '${E2}'`)).toBe("true");
    await credits.setThreshold(E2, 6_000, U.padmin); // raised (e.g. to the expected monthly charges)
    expect(psql(`select (low_balance_flagged_at is not null)::text from public.studio_sms_credit_accounts where legal_entity_id = '${E2}'`)).toBe("true");
    await credits.setThreshold(E2, 1_000, U.padmin);
  });

  it("the founder-authorized pilot exception: one time, platform admin only, written approval, never above $150 or the entity spend cap, ordinary ledger credit", async () => {
    expect(await code(credits.grantPilot(E1, 15_000, "founder approved the ConfiDance pilot exception", U.owner_x))).toBe("42501");
    expect(await code(credits.grantPilot(E1, 15_001, "founder approved the ConfiDance pilot exception", U.padmin))).toBe("22023"); // above $150
    expect(await code(credits.grantPilot(E1, 5_000, "short", U.padmin))).toBe("22023"); // approval reference required
    // a business whose recorded cap is below the grant cannot receive it
    psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_legal_entities set spend_cap_cents = 5000 where id = '${E2}'; commit;`);
    expect(await code(credits.grantPilot(E2, 10_000, "founder approved the ConfiDance pilot exception", U.padmin))).toBe("22023");
    psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_legal_entities set spend_cap_cents = 15000 where id = '${E2}'; commit;`);
    const before = account(E2);
    expect(await credits.grantPilot(E2, 15_000, "founder approved the ConfiDance pilot exception", U.padmin)).toEqual({ replayed: false });
    expect(await credits.grantPilot(E2, 15_000, "founder approved the ConfiDance pilot exception", U.padmin)).toEqual({ replayed: true });
    expect(await code(credits.grantPilot(E2, 5_000, "founder approved the ConfiDance pilot exception", U.padmin))).toBe("23505"); // not a second, different grant
    expect(Number(account(E2).split(":")[0]) - Number(before.split(":")[0])).toBe(15_000);
    expect(count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${E2}' and kind = 'pilot_grant'`)).toBe(1);
    // the exception exists ONCE in the whole system: no other business can receive a pilot grant (a second pilot needs a reviewed migration)
    expect(await code(credits.grantPilot(E1, 5_000, "founder approved the ConfiDance pilot exception", U.padmin))).toBe("23505");
    expect(count(`select count(*) from public.studio_sms_credit_ledger where kind = 'pilot_grant'`)).toBe(1);
    expect(count(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${Y}' and action = 'credit_pilot_grant'`)).toBe(1);
    expect((await credits.verify(E2)).ok).toBe(true);
  });

  it("reconciliation records the actual Twilio charge idempotently and flags a variance without re-debiting the business", async () => {
    expect(await code(credits.recordProviderCharge(E1, X1, "sms_usage", "BN_ref_1", 400, U.owner_x))).toBe("42501");
    await credits.setPrice("sms_usage", 1_000, 400, "Messaging (test price)", U.padmin);
    const before = account(E1);
    expect(await credits.recordProviderCharge(E1, X1, "sms_usage", "BN_ref_1", 400, U.padmin)).toEqual({ status: "matched", replayed: false });
    expect(await credits.recordProviderCharge(E1, X1, "sms_usage", "BN_ref_1", 400, U.padmin)).toEqual({ status: "matched", replayed: true });
    expect(await credits.recordProviderCharge(E1, X2, "sms_usage", "BN_ref_2", 450, U.padmin)).toEqual({ status: "variance", replayed: false });
    expect(await code(credits.recordProviderCharge(E1, X2, "sms_usage", "BN_ref_2", 999, U.padmin))).toBe("23505");
    expect(await code(credits.recordProviderCharge(E1, Y, "sms_usage", "BN_ref_3", 400, U.padmin))).not.toBe("ok"); // a location of another business
    expect(psql(`select variance_cents from public.studio_sms_provider_charges where provider_ref = 'BN_ref_2'`)).toBe("50");
    expect(account(E1)).toBe(before);
  });

  it("prices are published once and never edited; a change retires the old price", async () => {
    await credits.setPrice("sms_usage", 1_200, 500, "Messaging (new test price)", U.padmin);
    expect(count(`select count(*) from public.studio_sms_price_list where kind = 'sms_usage' and active`)).toBe(1);
    expect(psql(`select customer_price_cents from public.studio_sms_price_list where kind = 'sms_usage' and active`)).toBe("1200");
    expect(psqlError(`update public.studio_sms_price_list set customer_price_cents = 1 where kind = 'sms_usage' and active`)).toContain("never edited");
    expect(psqlError(`update public.studio_sms_price_list set active = true where kind = 'sms_usage' and not active`)).toContain("never edited");
    expect(await code(credits.setPrice("sms_usage", 1_200, 500, "x", U.padmin))).not.toBe("ok");
  });

  it("an owner sees their legal business balance and per-location attribution; another business, front desk and strangers are refused; no provider cost leaks", async () => {
    // owner_x owns both locations of business 1: either location shows the SAME balance, with that location's own net charges
    const one = await as("owner_x").rpc("sms_credit_overview", { p_studio_id: X1 });
    const two = await as("owner_x").rpc("sms_credit_overview", { p_studio_id: X2 });
    expect(one.error).toBeNull();
    expect((one.data as { balance_cents: number }).balance_cents).toBe((two.data as { balance_cents: number }).balance_cents);
    expect(one.data).toMatchObject({ legal_business: true, on_hold: false });
    expect((one.data as { this_location_net_charges_cents: number }).this_location_net_charges_cents).not.toBe((two.data as { this_location_net_charges_cents: number }).this_location_net_charges_cents);
    expect((await as("owner_y").rpc("sms_credit_overview", { p_studio_id: X1 })).error?.code).toBe("42501");
    expect((await as("fd_x2").rpc("sms_credit_overview", { p_studio_id: X2 })).error?.code).toBe("42501"); // front desk
    expect((await as("owner_y").rpc("sms_credit_history", { p_studio_id: X1 })).error?.code).toBe("42501");
    const history = await as("owner_x").rpc("sms_credit_history", { p_studio_id: X2, p_limit: 6 });
    expect(history.error).toBeNull();
    const rows = history.data as { seq: number; location_id: string | null; this_location: boolean | null }[];
    expect(rows).toHaveLength(6);
    expect(rows[0].seq).toBeGreaterThan(rows[1].seq);
    expect(rows.some((r) => r.location_id === X1 && r.this_location === false)).toBe(true); // the other location's entries are attributed, not hidden
    expect(JSON.stringify(rows)).not.toMatch(/provider|idempotency|ref"|actor/i);
    // the other business only ever sees its own
    const other = await as("owner_y").rpc("sms_credit_history", { p_studio_id: Y, p_limit: 200 });
    expect((other.data as { location_id: string | null }[]).every((r) => r.location_id === null || r.location_id === Y)).toBe(true);
    const prices = await as("owner_x").rpc("sms_price_list", {});
    expect(prices.error).toBeNull();
    expect(JSON.stringify(prices.data)).toContain("customer_price_cents");
    expect(JSON.stringify(prices.data)).not.toContain("provider");
    expect((await as("fd_x2").rpc("sms_price_list", {})).error?.code).toBe("42501");
  });

  it("the ledger is append-only and always reconciles with the account counters", async () => {
    expect(psqlError(`update public.studio_sms_credit_ledger set balance_delta_cents = 1`)).toContain("append-only");
    expect(psqlError(`delete from public.studio_sms_credit_ledger`)).toContain("append-only");
    expect(psqlError(`truncate public.studio_sms_credit_ledger`)).toContain("never truncated");
    expect(psqlError(`update public.studio_sms_credit_topups set amount_cents = 1`)).toContain("not edited");
    expect(psqlError(`insert into public.studio_sms_credit_ledger (legal_entity_id, seq, kind, balance_delta_cents, idempotency_key, studio_id) values ('${E1}', 9999, 'usage_charge', 5, 'bad-sign', '${X1}')`)).toContain("shape");
    for (const entity of [E1, E2]) expect((await credits.verify(entity)).ok, entity).toBe(true);
  });

  it("the rollback refuses while credit evidence exists", () => {
    const rollback = readFileSync(join(__dirname, "../../../supabase/migrations/rollback/20261122090000_twilio_tw4f3b0_prepaid_credits_rollback.sql"), "utf8");
    let error = "";
    try {
      execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: rollback, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      error = String((e as { stderr?: Buffer | string }).stderr ?? e);
    }
    expect(error).toContain("rollback refused");
    expect(count("select count(*) from information_schema.tables where table_name = 'studio_sms_credit_ledger'")).toBe(1);
  });
});
