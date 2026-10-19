/**
 * TW-4F-3b-0 (prepaid SMS credits) against a REAL schema: the append-only ledger, settled-only funding, atomic debits under concurrency, replays,
 * reversals and negative-balance blocking, holds, the low-balance flag, reconciliation records and what a studio's owner may see, using the real SQL
 * functions (service role, through PostgREST). The reservation / capture / release path of the runner is exercised in `localStack.tw4f3a.test.ts`.
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

const X = "a3b00000-0000-4000-8000-00000000000a";
const Y = "a3b00000-0000-4000-8000-00000000000b";
const U = {
  owner_x: "a3b00000-0000-4000-8000-000000000101",
  owner_y: "a3b00000-0000-4000-8000-000000000201",
  fd_x: "a3b00000-0000-4000-8000-000000000102",
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
delete from public.studio_sms_credit_ledger where studio_id in ('${X}', '${Y}');
delete from public.studio_sms_credit_reservations where studio_id in ('${X}', '${Y}');
delete from public.studio_sms_credit_topups where studio_id in ('${X}', '${Y}');
delete from public.studio_sms_provider_charges where studio_id in ('${X}', '${Y}');
delete from public.studio_sms_credit_accounts where studio_id in ('${X}', '${Y}');
delete from public.studio_sms_price_list where created_by = '${U.padmin}';
delete from public.user_studio_roles where studio_id in ('${X}', '${Y}');
delete from public.studio_sms_onboarding_audit where studio_id in ('${X}', '${Y}');
delete from public.studios where id in ('${X}', '${Y}');
delete from public.profiles where id in ('${U.owner_x}', '${U.owner_y}', '${U.fd_x}', '${U.padmin}');
delete from auth.users where email like '%@tw4f3b-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('${U.owner_x}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_x@tw4f3b-e2e.test', now(), now()),
  ('${U.owner_y}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_y@tw4f3b-e2e.test', now(), now()),
  ('${U.fd_x}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fd_x@tw4f3b-e2e.test', now(), now()),
  ('${U.padmin}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin@tw4f3b-e2e.test', now(), now());
insert into public.profiles (id, platform_role) values ('${U.owner_x}', null), ('${U.owner_y}', null), ('${U.fd_x}', null), ('${U.padmin}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values ('${X}', 'TW4F3B E2E Studio X', 'tw4f3b-e2e-x', null), ('${Y}', 'TW4F3B E2E Studio Y', 'tw4f3b-e2e-y', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_x}', '${X}', 'studio_owner', true), ('${U.owner_y}', '${Y}', 'studio_owner', true), ('${U.fd_x}', '${X}', 'front_desk', true);
commit;`;

describe.skipIf(!enabled)("TW-4F-3b-0 prepaid credit ledger against the local QA stack (real SQL functions)", () => {
  let credits: SupabaseCreditStore;
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof RunnerStoreError ? error.code : `other:${String(error)}`;
    }
  };
  const account = (studio: string) => psql(`select balance_cents || ':' || reserved_cents from public.studio_sms_credit_accounts where studio_id = '${studio}'`);
  const ledgerCount = (studio: string) => count(`select count(*) from public.studio_sms_credit_ledger where studio_id = '${studio}'`);

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
      "tw4_price_set(text, int, int, text, uuid)", "tw4_credit_topup_pending(uuid, text, int)", "tw4_credit_settle_topup(uuid, text, int, text)",
      "tw4_credit_reverse_topup(text, int, text, text)", "tw4_credit_adjust(uuid, bigint, text, text, uuid)", "tw4_credit_set_hold(uuid, boolean, text, uuid)",
      "tw4_credit_set_threshold(uuid, int, uuid)", "tw4_credit_debit_usage(uuid, int, text, text)", "tw4_credit_refund_usage(uuid, int, text, text)",
      "tw4_credit_record_provider_charge(uuid, text, text, int, uuid)", "tw4_credit_verify(uuid)", "tw4_spend_settle(uuid, text, text, text, text)",
      "tw4_spend_reserve(uuid, text, text)", "tw4_spend_authorize(uuid, text, int, text, uuid)", "tw4_entity_create_for_studio(uuid, uuid, text)",
      "_tw4c_lock(uuid)", "_tw4c_post(uuid, text, bigint, bigint, text, uuid, text, uuid, text)", "_tw4c_admin(uuid)", "_tw4c_immutable_guard()",
    ];
    const checks: string[] = [];
    for (const fn of admin) {
      for (const role of ["anon", "authenticated"]) checks.push(`select case when has_function_privilege('${role}', 'public.${fn}', 'execute') then '${role} may execute ${fn}' end`);
      if (!fn.startsWith("_")) checks.push(`select case when not has_function_privilege('service_role', 'public.${fn}', 'execute') then 'service_role may not execute ${fn}' end`);
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

  it("only a SETTLED payment becomes credit; a pending one is not spendable; a replayed event or payment credits nothing twice", async () => {
    await credits.topupPending(X, "pi_x_1", 5_000);
    expect(ledgerCount(X)).toBe(0);
    expect(await code(credits.debitUsage(X, 1, "pending-use", "m"))).toBe("TW007"); // nothing settled yet
    expect(await credits.settleTopup(X, "pi_x_1", 5_000, "evt_1")).toEqual({ replayed: false });
    expect(account(X)).toBe("5000:0");
    expect(await credits.settleTopup(X, "pi_x_1", 5_000, "evt_1")).toEqual({ replayed: true }); // webhook retry
    expect(await credits.settleTopup(X, "pi_x_1", 5_000, "evt_other")).toEqual({ replayed: true }); // same payment, different event id
    expect(account(X)).toBe("5000:0");
    expect(count(`select count(*) from public.studio_sms_credit_ledger where studio_id = '${X}' and kind = 'topup_settled'`)).toBe(1);
    // the same payment cannot be claimed by another studio or for another amount
    expect(await code(credits.settleTopup(Y, "pi_x_1", 5_000, "evt_y"))).toBe("23505");
    expect(await code(credits.settleTopup(X, "pi_x_1", 4_000, "evt_x"))).toBe("23505");
    expect((await credits.verify(X)).ok).toBe(true);
  });

  it("concurrent replays of one payment credit it exactly once", async () => {
    await Promise.all(Array.from({ length: 6 }, () => credits.settleTopup(Y, "pi_y_race", 2_000, "evt_race")));
    expect(account(Y)).toBe("2000:0");
    expect(count(`select count(*) from public.studio_sms_credit_ledger where studio_id = '${Y}' and kind = 'topup_settled'`)).toBe(1);
    expect((await credits.verify(Y)).ok).toBe(true);
  });

  it("usage debits are atomic under concurrency: the balance can never be overdrawn, and a retried debit is not charged twice", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => code(credits.debitUsage(Y, 300, `race-${i}`, `msg-${i}`))));
    expect(results.filter((r) => r === "ok")).toHaveLength(6); // 2000 / 300
    expect(results.filter((r) => r === "TW007")).toHaveLength(4);
    expect(account(Y)).toBe("200:0");
    const winner = results.findIndex((r) => r === "ok");
    expect(await credits.debitUsage(Y, 300, `race-${winner}`, `msg-${winner}`)).toEqual({ replayed: true }); // replay succeeds without a charge, even though the balance is now low
    expect(account(Y)).toBe("200:0");
    expect(await code(credits.debitUsage(Y, 250, "too-much", "m"))).toBe("TW007");
    expect(await code(credits.debitUsage(Y, 100, `race-${winner}`, "m"))).toBe("23505"); // a key is never reused for a different amount
    expect((await credits.verify(Y)).ok).toBe(true);
  });

  it("refunds credit back only part of a recorded usage charge of the SAME studio, never more than it, and exactly once per key", async () => {
    await credits.debitUsage(Y, 100, "refund-src", "SM-src");
    expect(account(Y)).toBe("100:0");
    expect(await code(credits.refundUsage(Y, 10, "r0", "no-such-usage"))).toBe("22023"); // not a recorded charge
    expect(await code(credits.refundUsage(X, 10, "r0", "refund-src"))).toBe("22023"); // another studio's charge
    expect(await credits.refundUsage(Y, 60, "r1", "refund-src")).toEqual({ replayed: false });
    expect(await credits.refundUsage(Y, 60, "r1", "refund-src")).toEqual({ replayed: true });
    expect(account(Y)).toBe("160:0");
    expect(await code(credits.refundUsage(Y, 60, "r2", "refund-src"))).toBe("22023"); // 60 + 60 > 100
    expect(await credits.refundUsage(Y, 40, "r3", "refund-src")).toEqual({ replayed: false });
    expect(account(Y)).toBe("200:0");
    expect((await credits.verify(Y)).ok).toBe(true);
  });

  it("a failed payment never becomes credit and is no longer pending", async () => {
    await credits.topupPending(X, "pi_fail", 500);
    await credits.topupFailed("pi_fail", "evt_fail");
    expect(await code(credits.settleTopup(X, "pi_fail", 500, "evt_fail_late"))).toBe("42501");
    expect(count(`select count(*) from public.studio_sms_credit_ledger where studio_id = '${X}' and ref = 'pi_fail'`)).toBe(0);
    expect(await code(credits.topupFailed("pi_x_1", "evt_x"))).toBe("22023"); // a settled payment cannot be failed
  });

  it("a reversal (refund or lost dispute) takes the credit back once, can make the balance negative, and a negative balance blocks all spending until funded again", async () => {
    await credits.reverseTopup("pi_x_1", 3_000, "evt_refund_1", "customer refund");
    await credits.reverseTopup("pi_x_1", 3_000, "evt_refund_1", "customer refund (retry)");
    expect(account(X)).toBe("2000:0");
    expect(await code(credits.reverseTopup("pi_x_1", 2_500, "evt_refund_2", "more than was paid"))).toBe("22023"); // 3000 + 2500 > 5000
    expect(await code(credits.reverseTopup("pi_x_1", 100, "", "no event id"))).toBe("22023"); // the provider event id is required
    // the same provider event id on ANOTHER payment is a different reversal (the key includes the payment)
    expect(await credits.reverseTopup("pi_y_race", 50, "evt_refund_1", "other studio, same event id")).toEqual({ replayed: false });
    await credits.adjust(Y, 50, "restore-after-reuse-test", "restore the test balance after the reversal", U.padmin);
    expect(account(X)).toBe("2000:0");
    // spend most of it, then a late dispute for the rest of the payment drives the balance negative
    await credits.debitUsage(X, 1_900, "use-x", "m");
    await credits.reverseTopup("pi_x_1", 2_000, "evt_dispute", "lost dispute");
    expect(account(X)).toBe("-1900:0");
    expect(await code(credits.debitUsage(X, 1, "blocked-neg", "m"))).toBe("TW007");
    expect((await credits.verify(X)).ok).toBe(true);
    await credits.settleTopup(X, "pi_x_2", 1_900, "evt_2"); // back to exactly zero: still nothing to spend
    expect(await code(credits.debitUsage(X, 1, "blocked-zero", "m"))).toBe("TW007");
    await credits.settleTopup(X, "pi_x_3", 1_000, "evt_3");
    expect(await credits.debitUsage(X, 200, "ok-again", "m")).toEqual({ replayed: false });
    expect(account(X)).toBe("800:0");
  });

  it("adjustments need a written reason, are idempotent, and are audited", async () => {
    expect(await code(credits.adjust(X, 100, "a1", "short", U.padmin))).toBe("22023");
    expect(await code(credits.adjust(X, 0, "a1", "a long enough reason", U.padmin))).toBe("22023");
    expect(await code(credits.adjust(X, 100, "a1", "goodwill credit for a failed send", U.owner_x))).toBe("42501");
    expect(await credits.adjust(X, 100, "a1", "goodwill credit for a failed send", U.padmin)).toEqual({ replayed: false });
    expect(await credits.adjust(X, 100, "a1", "goodwill credit for a failed send", U.padmin)).toEqual({ replayed: true });
    expect(account(X)).toBe("900:0");
    expect(count(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${X}' and action = 'credit_adjustment'`)).toBe(1);
  });

  it("a hold blocks spending without touching the balance; lifting it restores spending", async () => {
    expect(await code(credits.setHold(X, true, "x", U.padmin))).not.toBe("ok"); // a reason is required
    await credits.setHold(X, true, "chargeback under review", U.padmin);
    expect(await code(credits.debitUsage(X, 1, "held", "m"))).toBe("TW007");
    expect(account(X)).toBe("900:0");
    await credits.setHold(X, false, "", U.padmin);
    expect(await credits.debitUsage(X, 1, "unheld", "m")).toEqual({ replayed: false });
  });

  it("the low-balance flag is set once the available balance dips under the threshold and clears when funded", async () => {
    await credits.setThreshold(X, 1_000, U.padmin);
    expect(psql(`select (low_balance_flagged_at is not null)::text from public.studio_sms_credit_accounts where studio_id = '${X}'`)).toBe("true"); // 899 < 1000
    const first = psql(`select low_balance_flagged_at::text from public.studio_sms_credit_accounts where studio_id = '${X}'`);
    await credits.debitUsage(X, 1, "low-1", "m");
    expect(psql(`select low_balance_flagged_at::text from public.studio_sms_credit_accounts where studio_id = '${X}'`)).toBe(first); // flagged once per dip
    await credits.settleTopup(X, "pi_x_4", 5_000, "evt_4");
    expect(psql(`select (low_balance_flagged_at is null)::text from public.studio_sms_credit_accounts where studio_id = '${X}'`)).toBe("true");
  });

  it("reconciliation records the actual Twilio charge idempotently and flags a variance without re-debiting the studio", async () => {
    expect(await code(credits.recordProviderCharge(X, "sms_usage", "BN_ref_1", 400, U.owner_x))).toBe("42501");
    await credits.setPrice("sms_usage", 1_000, 400, "Brand registration", U.padmin);
    const before = account(X);
    expect(await credits.recordProviderCharge(X, "sms_usage", "BN_ref_1", 400, U.padmin)).toEqual({ status: "matched", replayed: false });
    expect(await credits.recordProviderCharge(X, "sms_usage", "BN_ref_1", 400, U.padmin)).toEqual({ status: "matched", replayed: true });
    expect(await credits.recordProviderCharge(X, "sms_usage", "BN_ref_2", 450, U.padmin)).toEqual({ status: "variance", replayed: false });
    expect(await code(credits.recordProviderCharge(X, "sms_usage", "BN_ref_2", 999, U.padmin))).toBe("23505");
    expect(psql(`select variance_cents from public.studio_sms_provider_charges where provider_ref = 'BN_ref_2'`)).toBe("50");
    expect(account(X)).toBe(before);
  });

  it("prices are published once and never edited; a change retires the old price", async () => {
    await credits.setPrice("sms_usage", 1_200, 500, "Brand registration (new price)", U.padmin);
    expect(count(`select count(*) from public.studio_sms_price_list where kind = 'sms_usage' and active`)).toBe(1);
    expect(psql(`select customer_price_cents from public.studio_sms_price_list where kind = 'sms_usage' and active`)).toBe("1200");
    expect(psqlError(`update public.studio_sms_price_list set customer_price_cents = 1 where kind = 'sms_usage' and active`)).toContain("never edited");
    expect(psqlError(`update public.studio_sms_price_list set active = true where kind = 'sms_usage' and not active`)).toContain("never edited");
    expect(await code(credits.setPrice("sms_usage", 1_200, 500, "x", U.padmin))).not.toBe("ok");
  });

  it("the studio's owner sees only their own balance, history and the published prices (no provider cost); front desk and other studios are refused", async () => {
    const own = await as("owner_x").rpc("sms_credit_overview", { p_studio_id: X });
    expect(own.error).toBeNull();
    expect(own.data).toMatchObject({ on_hold: false, low_balance: false });
    expect((own.data as { available_cents: number }).available_cents).toBeGreaterThan(0);
    expect((await as("owner_y").rpc("sms_credit_overview", { p_studio_id: X })).error?.code).toBe("42501");
    expect((await as("fd_x").rpc("sms_credit_overview", { p_studio_id: X })).error?.code).toBe("42501");
    expect((await as("owner_y").rpc("sms_credit_history", { p_studio_id: X })).error?.code).toBe("42501");
    const history = await as("owner_x").rpc("sms_credit_history", { p_studio_id: X, p_limit: 5 });
    expect(history.error).toBeNull();
    const rows = history.data as Record<string, unknown>[];
    expect(rows).toHaveLength(5);
    expect(rows[0].seq as number).toBeGreaterThan(rows[1].seq as number);
    expect(JSON.stringify(rows)).not.toMatch(/provider|idempotency|ref|actor/i);
    const prices = await as("owner_x").rpc("sms_price_list", {});
    expect(prices.error).toBeNull();
    expect(JSON.stringify(prices.data)).toContain("customer_price_cents");
    expect(JSON.stringify(prices.data)).not.toContain("provider");
    expect((await as("fd_x").rpc("sms_price_list", {})).error?.code).toBe("42501");
  });

  it("the ledger is append-only and always reconciles with the account counters", async () => {
    expect(psqlError(`update public.studio_sms_credit_ledger set balance_delta_cents = 1`)).toContain("append-only");
    expect(psqlError(`delete from public.studio_sms_credit_ledger`)).toContain("append-only");
    expect(psqlError(`truncate public.studio_sms_credit_ledger`)).toContain("never truncated");
    expect(psqlError(`update public.studio_sms_credit_topups set amount_cents = 1`)).toContain("not edited");
    expect(psqlError(`insert into public.studio_sms_credit_ledger (studio_id, seq, kind, balance_delta_cents, idempotency_key) values ('${X}', 9999, 'usage_charge', 5, 'bad-sign')`)).toContain("shape");
    for (const studio of [X, Y]) expect((await credits.verify(studio)).ok, studio).toBe(true);
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
