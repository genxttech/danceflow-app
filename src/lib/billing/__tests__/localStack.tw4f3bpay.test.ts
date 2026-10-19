/**
 * TW-4F-3b-pay against a REAL schema and the REAL webhook route: prepaid SMS credit purchases with SYNTHETIC Stripe objects. Nothing reaches Stripe: events are
 * built here and signed with a test secret; the route verifies them with the real Stripe library. LOCAL QA STACK ONLY (skipped unless the variables below point
 * at a loopback Supabase stack with the migrations through 20261123090000 applied).
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

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

const PA1 = "a3d00000-0000-4000-8000-00000000000a"; // location 1 of business A
const PA2 = "a3d00000-0000-4000-8000-00000000000b"; // location 2 of business A
const PB1 = "a3d00000-0000-4000-8000-00000000000c"; // the only location of business B
const PX = "a3d00000-0000-4000-8000-00000000000d"; // a studio with no verified legal business
const EA = "e3d00000-0000-4000-8000-0000000000e1";
const EB = "e3d00000-0000-4000-8000-0000000000e2";
const U = {
  owner_a: "a3d00000-0000-4000-8000-000000000101",
  fd_a: "a3d00000-0000-4000-8000-000000000102",
  admin_a: "a3d00000-0000-4000-8000-000000000103",
  owner_b: "a3d00000-0000-4000-8000-000000000201",
  owner_x: "a3d00000-0000-4000-8000-000000000301",
  padmin: "a3d00000-0000-4000-8000-000000000401",
};
const RUN = randomBytes(3).toString("hex");
const WEBHOOK_SECRET = "whsec_tw4f3bpay_platform_test";
const CONNECT_SECRET = "whsec_tw4f3bpay_connect_test";
const realStripe = new Stripe("sk_test_tw4f3bpay_not_a_real_key");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
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

// the route reads the signature through next/headers and the Stripe client through getStripe(): both are replaced; the signature check itself is the real one
let signatureHeader: string | null = null;
vi.mock("next/headers", () => ({ headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }) }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({ webhooks: realStripe.webhooks, checkout: { sessions: { list: async () => ({ data: [] }) } } }) }));

const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_credit_ledger where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_reservations where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_topups where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_provider_charges where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_accounts where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_entity_studios where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_legal_entities where id in ('${EA}', '${EB}');
delete from public.user_studio_roles where studio_id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.studio_sms_onboarding_audit where studio_id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.studios where id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.profiles where id in ('${U.owner_a}', '${U.fd_a}', '${U.admin_a}', '${U.owner_b}', '${U.owner_x}', '${U.padmin}');
delete from auth.users where email like '%@tw4f3bpay-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4f3bpay-e2e.test', now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.fd_a}', 'fd_a'), ('${U.admin_a}', 'admin_a'), ('${U.owner_b}', 'owner_b'), ('${U.owner_x}', 'owner_x'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.fd_a}', null), ('${U.admin_a}', null), ('${U.owner_b}', null), ('${U.owner_x}', null), ('${U.padmin}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  ('${PA1}', 'TW4F3BPAY Location A1', 'tw4f3bpay-a1', null), ('${PA2}', 'TW4F3BPAY Location A2', 'tw4f3bpay-a2', null),
  ('${PB1}', 'TW4F3BPAY Location B1', 'tw4f3bpay-b1', null), ('${PX}', 'TW4F3BPAY Location X', 'tw4f3bpay-x', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${PA1}', 'studio_owner', true), ('${U.owner_a}', '${PA2}', 'studio_owner', true), ('${U.fd_a}', '${PA1}', 'front_desk', true),
  ('${U.admin_a}', '${PA1}', 'studio_admin', true), ('${U.owner_b}', '${PB1}', 'studio_owner', true), ('${U.owner_x}', '${PX}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'F3P Alpha LLC', '3333', 15000, '${U.padmin}'), ('${EB}', 'F3P Beta LLC', '4444', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values
  ('${PA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location one'),
  ('${PA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location two'),
  ('${PB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B');
commit;`;

describe.skipIf(!enabled)("TW-4F-3b-pay credit purchases: real SQL functions, real webhook route, synthetic Stripe events", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  const code = async (promise: PromiseLike<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof RunnerStoreError ? error.code : `other:${String(error)}`;
    }
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
  const account = (entity: string) => psql(`select coalesce((select balance_cents || ':' || reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), '0:0')`);
  const balance = (entity: string) => Number(account(entity).split(":")[0]);
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();
  const topupRow = (ref: string) => psql(`select status || ':' || amount_cents || ':' || refunded_cents || ':' || disputed_cents || ':' || reversed_cents from public.studio_sms_credit_topups where provider_ref = '${ref}'`);

  beforeAll(() => {
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
    } catch {
      /* best effort */
    }
  });

  // ------------------------------------------------------------------------------------------------------------------
  // SQL layer
  // ------------------------------------------------------------------------------------------------------------------
  it("the purchase functions are executable by the service role only, the removed free-amount reversal is gone, and none of them knows about the pilot ceiling", () => {
    const fns = [
      "tw4_credit_checkout_context(uuid, uuid)", "tw4_credit_topup_pending(uuid, uuid, text, int, timestamptz)", "tw4_credit_settle_topup(uuid, uuid, text, int, text, text, boolean)",
      "tw4_credit_topup_lookup(text)", "tw4_credit_apply_refund(text, int, text, text)", "tw4_credit_apply_dispute(text, text, int, text, text)",
    ];
    const checks: string[] = [];
    for (const fn of fns) {
      for (const role of ["anon", "authenticated"]) checks.push(`select case when has_function_privilege('${role}', 'public.${fn}', 'execute') then '${role} may execute ${fn}' end`);
      checks.push(`select case when not has_function_privilege('service_role', 'public.${fn}', 'execute') then 'service_role may not execute ${fn}' end`);
    }
    checks.push("select case when to_regprocedure('public.tw4_credit_reverse_topup(text,integer,text,text)') is not null then 'free-amount reversal still exists' end");
    checks.push("select case when exists (select 1 from pg_proc p where p.proname in ('tw4_credit_checkout_context','tw4_credit_topup_pending','tw4_credit_settle_topup','tw4_credit_topup_lookup','tw4_credit_apply_refund','tw4_credit_apply_dispute') and p.prosrc ilike '%pilot%') then 'a purchase function mentions the pilot' end");
    checks.push("select case when exists (select 1 from pg_proc p where p.proname ilike '%transfer%' and p.proname like 'tw4\\_credit%') then 'a balance transfer function exists' end");
    expect(psql(checks.join(" union all ") + " order by 1")).toBe("");
  });

  it("the database authorizes a purchase: owner and administrator of a location of a verified legal business only", async () => {
    const ok = async (studio: string, user: string | null) => (await rpc("tw4_credit_checkout_context", { p_studio_id: studio, p_user_id: user })).error?.code ?? "ok";
    expect(await ok(PA1, U.owner_a)).toBe("ok");
    expect(await ok(PA2, U.owner_a)).toBe("ok");
    expect(await ok(PA1, U.admin_a)).toBe("ok");
    expect(await ok(PA1, U.fd_a)).toBe("42501"); // front desk
    expect(await ok(PA1, U.owner_b)).toBe("42501"); // the owner of another business
    expect(await ok(PB1, U.owner_a)).toBe("42501");
    expect(await ok(PA2, U.admin_a)).toBe("42501"); // administrator of location 1 only
    expect(await ok(PA1, null)).toBe("42501");
    expect(await ok(PX, U.owner_x)).toBe("TW010"); // authorized, but no verified legal business yet
    const entity = await rpc("tw4_credit_checkout_context", { p_studio_id: PA2, p_user_id: U.owner_a });
    expect(entity.data).toMatchObject({ legal_entity_id: EA });
  });

  it("checkout registration: packs only, a sane expiry, and the $500 ceiling over live pending payments holds under concurrency", async () => {
    expect(await code(credits.topupPending(EA, PA1, `cs_bad_${RUN}_1`, 3_000, future(60_000)))).toBe("22023");
    expect(await code(credits.topupPending(EA, PA1, `cs_bad_${RUN}_2`, 5_000, future(-1_000)))).toBe("22023");
    expect(await code(credits.topupPending(EA, PA1, `cs_bad_${RUN}_3`, 5_000, future(48 * 3_600_000)))).toBe("22023");
    expect(await code(credits.topupPending(EA, PB1, `cs_bad_${RUN}_4`, 5_000, future(60_000)))).not.toBe("ok"); // a location of another business
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => code(credits.topupPending(EA, PA1, `cs_race_${RUN}_${i}`, 10_000, future(600_000)))));
    expect(results.filter((r) => r === "ok")).toHaveLength(5); // 5 x $100 = $500
    expect(results.filter((r) => r === "TW009")).toHaveLength(3);
    expect(await code(credits.topupPending(EA, PA1, `cs_over_${RUN}`, 2_500, future(600_000)))).toBe("TW009"); // live pending payments count
    const winner = results.findIndex((r) => r === "ok");
    expect(await code(credits.topupPending(EA, PA1, `cs_race_${RUN}_${winner}`, 10_000, future(600_000)))).toBe("ok"); // the same session registered again is a replay, not a second reservation of ceiling
    expect(count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}'`)).toBe(0); // pending money is not credit
    expect(await code(credits.debitUsage(EA, PA1, 1, `pending-use-${RUN}`, "m"))).toBe("TW007");
    for (let i = 0; i < 8; i++) if (results[i] === "ok") await credits.topupFailed(`cs_race_${RUN}_${i}`, `evt_free_${RUN}_${i}`);
    expect(await code(credits.topupPending(EA, PA1, `cs_after_${RUN}`, 10_000, future(600_000)))).toBe("ok"); // failed payments stop counting
    await credits.topupFailed(`cs_after_${RUN}`, `evt_free_${RUN}_x`);
  });

  it("an expired checkout stops counting toward the ceiling; the balance counts; a payment that has already settled is never refused", async () => {
    for (let i = 0; i < 5; i++) await credits.topupPending(EB, PB1, `cs_exp_${RUN}_${i}`, 10_000, future(2_000));
    expect(await code(credits.topupPending(EB, PB1, `cs_exp_${RUN}_x`, 2_500, future(600_000)))).toBe("TW009");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    // the five pending payments are past their expiry: they no longer reserve ceiling
    for (let i = 0; i < 4; i++) await credits.settleTopup(EB, PB1, `pi_bal_${RUN}_${i}`, 10_000, `evt_bal_${RUN}_${i}`);
    await credits.settleTopup(EB, PB1, `pi_bal_${RUN}_4`, 5_000, `evt_bal_${RUN}_4`);
    expect(balance(EB)).toBe(45_000);
    expect(await code(credits.topupPending(EB, PB1, `cs_cap_${RUN}_1`, 10_000, future(600_000)))).toBe("TW009"); // 450 + 100 > 500
    expect(await code(credits.topupPending(EB, PB1, `cs_cap_${RUN}_2`, 5_000, future(600_000)))).toBe("ok"); // exactly 500
    expect(await code(credits.topupPending(EB, PB1, `cs_cap_${RUN}_3`, 2_500, future(600_000)))).toBe("TW009");
    expect((await credits.settleTopup(EB, PB1, `pi_late_${RUN}`, 10_000, `evt_late_${RUN}`)).replayed).toBe(false); // already paid: credited, never refused
    expect(balance(EB)).toBe(55_000);
    const overview = psql(`select pending_topups_cents from (select (select coalesce(sum(t.amount_cents), 0) from public.studio_sms_credit_topups t where t.legal_entity_id = '${EB}' and t.status = 'pending' and (t.expires_at is null or t.expires_at > now())) as pending_topups_cents) x`);
    expect(Number(overview)).toBe(5_000);
    expect((await credits.verify(EB)).ok).toBe(true);
  });

  it("settlement credits only what was registered, to the business, location and amount it was registered for, exactly once", async () => {
    const ref = `cs_set_${RUN}`;
    expect(await code(credits.settleTopup(EA, PA1, `cs_unknown_${RUN}`, 5_000, "evt_u", "pi_u", true))).toBe("22023"); // never registered
    expect(count(`select count(*) from public.studio_sms_credit_ledger where ref = 'cs_unknown_${RUN}'`)).toBe(0);
    await credits.topupPending(EA, PA1, ref, 5_000, future(600_000));
    expect(await code(credits.settleTopup(EB, PB1, ref, 5_000, "evt_x", `pi_set_${RUN}`, true))).toBe("23505"); // another business cannot settle it
    expect(await code(credits.settleTopup(EA, PA1, ref, 4_000, "evt_x", `pi_set_${RUN}`, true))).toBe("23505"); // another amount
    expect(await code(credits.settleTopup(EA, PA2, ref, 5_000, "evt_x", `pi_set_${RUN}`, true))).toBe("23505"); // another location of the same business
    expect(balance(EA)).toBe(0);
    expect((await credits.settleTopup(EA, PA1, ref, 5_000, `evt_set_${RUN}`, `pi_set_${RUN}`, true)).replayed).toBe(false);
    expect((await credits.settleTopup(EA, PA1, ref, 5_000, `evt_set_${RUN}`, `pi_set_${RUN}`, true)).replayed).toBe(true); // webhook retry
    expect((await credits.settleTopup(EA, PA1, ref, 5_000, `evt_set_again_${RUN}`, `pi_set_${RUN}`, true)).replayed).toBe(true); // a redelivery with a new event id
    expect(balance(EA)).toBe(5_000);
    expect(psql(`select payment_intent_ref from public.studio_sms_credit_topups where provider_ref = '${ref}'`)).toBe(`pi_set_${RUN}`);
    expect(psql(`select studio_id = '${PA1}' from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and idempotency_key = 'topup:${ref}'`)).toBe("t"); // attributed to the paying location
    // one payment cannot settle two registered purchases
    await credits.topupPending(EA, PA1, `${ref}_2`, 2_500, future(600_000)).catch(() => undefined);
    expect(await code(credits.settleTopup(EA, PA1, `${ref}_2`, 2_500, "evt_2", `pi_set_${RUN}`, true))).toBe("23505");
    expect(balance(EA)).toBe(5_000);
    // concurrent replays credit once
    const race = `cs_conc_${RUN}`;
    await credits.topupPending(EA, PA1, race, 2_500, future(600_000)).catch(() => undefined);
    await Promise.all(Array.from({ length: 8 }, () => credits.settleTopup(EA, PA1, race, 2_500, `evt_conc_${RUN}`, `pi_conc_${RUN}`, true)));
    expect(balance(EA)).toBe(7_500);
    expect(count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and kind = 'topup_settled' and ref = '${race}'`)).toBe(1);
    expect((await credits.verify(EA)).ok).toBe(true);
  });

  it("refunds apply Stripe's cumulative figure once; out-of-order and repeated events change nothing; the payment can never be over-reversed", async () => {
    const ref = `cs_ref_${RUN}`;
    const pi = `pi_ref_${RUN}`;
    await credits.settleTopup(EA, PA1, ref, 10_000, `evt_r0_${RUN}`, pi);
    const start = balance(EA);
    await credits.applyRefund(pi, 2_500, `evt_r1_${RUN}`, "customer refund");
    expect(balance(EA)).toBe(start - 2_500);
    expect((await credits.applyRefund(pi, 2_500, `evt_r1_${RUN}`, "retry")).replayed).toBe(true);
    expect((await credits.applyRefund(ref, 2_500, `evt_r1b_${RUN}`, "same by session id")).replayed).toBe(true);
    expect((await credits.applyRefund(pi, 1_000, `evt_r0b_${RUN}`, "older lower figure")).replayed).toBe(true);
    await credits.applyRefund(pi, 4_000, `evt_r2_${RUN}`, "second partial refund");
    expect(balance(EA)).toBe(start - 4_000);
    expect(topupRow(ref)).toBe("settled:10000:4000:0:4000");
    expect(await code(credits.applyRefund(pi, 10_001, `evt_r3_${RUN}`, "more than paid"))).toBe("22023");
    expect(await code(credits.applyRefund(pi, 5_000, "", "no event id"))).toBe("22023");
    expect(await code(credits.applyRefund("pi_unknown", 5_000, `evt_r4_${RUN}`, "no such payment"))).toBe("22023");
    expect(await code(credits.applyRefund(`cs_never_${RUN}`, 5_000, `evt_r5_${RUN}`, "no such payment"))).toBe("22023");
    expect(balance(EA)).toBe(start - 4_000);
    expect((await credits.verify(EA)).ok).toBe(true);
  });

  it("disputes withdraw once per dispute id and reinstate exactly what that dispute withdrew; with refunds they can never exceed the payment", async () => {
    const ref = `cs_dis_${RUN}`;
    const pi = `pi_dis_${RUN}`;
    await credits.settleTopup(EA, PA2, ref, 10_000, `evt_d0_${RUN}`, pi);
    const start = balance(EA);
    await credits.applyRefund(pi, 3_000, `evt_d1_${RUN}`, "partial refund");
    expect((await credits.applyDispute(pi, `dp_${RUN}_1`, 6_000, "withdrawn", `evt_d2_${RUN}`)).replayed).toBe(false);
    expect((await credits.applyDispute(pi, `dp_${RUN}_1`, 6_000, "withdrawn", `evt_d2b_${RUN}`)).replayed).toBe(true); // created, then funds_withdrawn
    expect(balance(EA)).toBe(start - 9_000);
    // a dispute larger than what is still unreversed is capped (3000 + 6000 + 1000 = 10000), never an error that retries forever; a further one is recorded as nothing left
    expect((await credits.applyDispute(pi, `dp_${RUN}_2`, 2_000, "withdrawn", `evt_d3_${RUN}`)).replayed).toBe(false);
    expect(balance(EA)).toBe(start - 10_000);
    expect(topupRow(ref)).toBe("settled:10000:3000:7000:10000");
    await credits.applyDispute(pi, `dp_${RUN}_3`, 500, "withdrawn", `evt_d3b_${RUN}`); // nothing left to take: accepted, moves nothing
    await credits.applyDispute(pi, `dp_${RUN}_3`, 500, "reinstated", `evt_d3c_${RUN}`); // nothing was taken, so nothing comes back
    expect(balance(EA)).toBe(start - 10_000);
    expect((await credits.applyDispute(pi, `dp_${RUN}_2`, 2_000, "reinstated", `evt_d3d_${RUN}`)).replayed).toBe(false); // gives back the 1000 it took
    expect(balance(EA)).toBe(start - 9_000);
    expect(await code(credits.applyDispute(pi, `dp_${RUN}_unknown`, 100, "reinstated", `evt_d4_${RUN}`))).toBe("22023"); // withdrew nothing
    expect(await code(credits.applyDispute(pi, `dp_${RUN}_1`, 100, "bogus" as never, `evt_d5_${RUN}`))).toBe("22023");
    expect(topupRow(ref)).toBe("settled:10000:3000:6000:9000");
    expect((await credits.applyDispute(pi, `dp_${RUN}_1`, 1, "reinstated", `evt_d6_${RUN}`)).replayed).toBe(false); // gives back what it withdrew (6000), not the number passed
    expect((await credits.applyDispute(pi, `dp_${RUN}_1`, 6_000, "reinstated", `evt_d7_${RUN}`)).replayed).toBe(true);
    expect(balance(EA)).toBe(start - 3_000);
    expect(topupRow(ref)).toBe("settled:10000:3000:0:3000");
    expect((await credits.verify(EA)).ok).toBe(true);
  });

  it("a refund that arrives after a dispute took the whole payment is recorded, and a won dispute then returns only what was not refunded", async () => {
    const ref = `cs_dfr_${RUN}`;
    const pi = `pi_dfr_${RUN}`;
    await credits.settleTopup(EA, PA2, ref, 2_500, `evt_f0_${RUN}`, pi);
    const start = balance(EA);
    await credits.applyDispute(pi, `dp_${RUN}_f`, 2_500, "withdrawn", `evt_f1_${RUN}`);
    expect(balance(EA)).toBe(start - 2_500);
    await credits.applyRefund(pi, 500, `evt_f2_${RUN}`, "late partial refund"); // would exceed the payment if added on top of the dispute
    expect(balance(EA)).toBe(start - 2_500); // nothing more to take
    expect(topupRow(ref)).toBe("settled:2500:500:2000:2500");
    await credits.applyDispute(pi, `dp_${RUN}_f`, 2_500, "reinstated", `evt_f3_${RUN}`);
    expect(balance(EA)).toBe(start - 500); // the 500 that was refunded is not given back
    expect(topupRow(ref)).toBe("settled:2500:500:0:500");
    expect((await credits.verify(EA)).ok).toBe(true);
  });

  it("a refund or lost dispute can drive the business negative, which blocks every location's spending until funded again; the other business is untouched", async () => {
    const before = account(EB);
    const ref = `cs_neg_${RUN}`;
    const pi = `pi_neg_${RUN}`;
    await credits.settleTopup(EA, PA1, ref, 2_500, `evt_n0_${RUN}`, pi);
    const spendable = balance(EA);
    await credits.debitUsage(EA, PA1, spendable, `use-all-${RUN}`, "m");
    await credits.applyRefund(pi, 2_500, `evt_n1_${RUN}`, "refund after spending");
    expect(balance(EA)).toBe(-2_500);
    expect(await code(credits.debitUsage(EA, PA1, 1, `blocked-1-${RUN}`, "m"))).toBe("TW007");
    expect(await code(credits.debitUsage(EA, PA2, 1, `blocked-2-${RUN}`, "m"))).toBe("TW007");
    expect(account(EB)).toBe(before);
    await credits.settleTopup(EA, PA1, `cs_back_${RUN}`, 10_000, `evt_n2_${RUN}`, `pi_back_${RUN}`);
    expect(await credits.debitUsage(EA, PA2, 1, `ok-${RUN}`, "m")).toEqual({ replayed: false });
    expect((await credits.verify(EA)).ok).toBe(true);
  });

  it("purchase evidence is guarded: the payment intent is final, refunds never decrease, the split always adds up, the expiry is fixed", () => {
    const ref = `cs_set_${RUN}`;
    expect(psqlError(`update public.studio_sms_credit_topups set payment_intent_ref = 'pi_other_${RUN}' where provider_ref = '${ref}'`)).toContain("not edited");
    expect(psqlError(`update public.studio_sms_credit_topups set refunded_cents = 0, reversed_cents = 0 where provider_ref = 'cs_ref_${RUN}'`)).toContain("not edited");
    expect(psqlError(`update public.studio_sms_credit_topups set expires_at = now() + interval '5 hours' where provider_ref = '${ref}'`)).toContain("not edited");
    expect(psqlError(`update public.studio_sms_credit_topups set reversed_cents = 1 where provider_ref = '${ref}'`)).toContain("studio_sms_credit_topups_split");
    expect(psqlError(`update public.studio_sms_credit_topups set status = 'pending' where provider_ref = '${ref}'`)).toContain("not edited");
  });

  it("the rollback refuses while purchase evidence exists", () => {
    const rollback = readFileSync(join(__dirname, "../../../lib/supabase/migrations/rollback/20261123090000_twilio_tw4f3b_pay_stripe_credit_purchases_rollback.sql"), "utf8");
    let error = "";
    try {
      execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: rollback, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      error = String((e as { stderr?: Buffer | string }).stderr ?? e);
    }
    expect(error).toContain("rollback refused");
    expect(count("select count(*) from information_schema.columns where table_name = 'studio_sms_credit_topups' and column_name = 'payment_intent_ref'")).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------------------------
  // the real webhook route with signed synthetic Stripe events
  // ------------------------------------------------------------------------------------------------------------------
  describe("webhook route", () => {
    let POST: (request: Request) => Promise<Response>;
    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
      process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey();
      process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
      ({ POST } = await import("@/app/api/payments/webhook/route"));
    });

    let sequence = 0;
    const eventId = (label: string) => `evt_${RUN}_${label}_${++sequence}`;
    function envelope(id: string, type: string, object: Record<string, unknown>, account?: string) {
      return JSON.stringify({ id, object: "event", type, api_version: "2024-06-20", created: Math.floor(Date.now() / 1000), data: { object }, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, ...(account ? { account } : {}) });
    }
    async function deliver(body: string, opts: { secret?: string; signature?: string | null } = {}) {
      signatureHeader =
        opts.signature === undefined
          ? (realStripe.webhooks.generateTestHeaderString({ payload: body, secret: opts.secret ?? WEBHOOK_SECRET } as Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0]) as string)
          : opts.signature;
      const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
      return { status: response.status, text: await response.text() };
    }
    const meta = (entity: string, studio: string, pack: number) => ({ df_purpose: "sms_credit_topup", legal_entity_id: entity, studio_id: studio, pack_cents: String(pack) });
    const session = (ref: string, entity: string, studio: string, pack: number, over: Record<string, unknown> = {}) => ({
      id: ref, object: "checkout.session", mode: "payment", currency: "usd", amount_total: pack, payment_status: "paid", payment_intent: `pi_for_${ref}`, metadata: meta(entity, studio, pack), ...over,
    });
    const claimStatus = (id: string) => psql(`select coalesce((select status from public.payment_provider_events where provider_event_id = '${id}'), 'none')`);

    it("a signed, paid event credits the registered purchase once; the replay and a redelivery under a new event id do not credit again", async () => {
      const ref = `cs_wh_${RUN}_1`;
      await credits.topupPending(EA, PA1, ref, 5_000, future(600_000));
      const before = balance(EA);
      const id = eventId("paid");
      const body = envelope(id, "checkout.session.completed", session(ref, EA, PA1, 5_000));
      expect(await deliver(body)).toMatchObject({ status: 200 });
      expect(balance(EA)).toBe(before + 5_000);
      expect(topupRow(ref)).toBe("settled:5000:0:0:0");
      expect(psql(`select payment_intent_ref from public.studio_sms_credit_topups where provider_ref = '${ref}'`)).toBe(`pi_for_${ref}`);
      const replay = await deliver(body);
      expect(replay).toMatchObject({ status: 200, text: "Already processed" });
      expect(await deliver(envelope(eventId("paid_again"), "checkout.session.async_payment_succeeded", session(ref, EA, PA1, 5_000)))).toMatchObject({ status: 200 });
      expect(balance(EA)).toBe(before + 5_000);
      expect(count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and ref = '${ref}'`)).toBe(1);
    });

    it("a bad or missing signature, a wrong secret and a stale payload change nothing", async () => {
      const ref = `cs_wh_${RUN}_2`;
      await credits.topupPending(EA, PA1, ref, 5_000, future(600_000));
      const before = account(EA);
      const body = envelope(eventId("badsig"), "checkout.session.completed", session(ref, EA, PA1, 5_000));
      expect((await deliver(body, { signature: "t=1,v1=deadbeef" })).status).toBe(400);
      expect((await deliver(body, { signature: null })).status).toBe(400);
      expect((await deliver(body, { secret: "whsec_not_the_secret" })).status).toBe(400);
      const tampered = body.replace('"amount_total":5000', '"amount_total":10000');
      const good = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET } as Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0]) as string;
      expect((await deliver(tampered, { signature: good })).status).toBe(400); // signed for different bytes
      expect(account(EA)).toBe(before);
      expect(topupRow(ref)).toBe("pending:5000:0:0:0");
    });

    it("a Connect-scoped event can never credit a purchase, even with the right Session id and flag", async () => {
      const ref = `cs_wh_${RUN}_3`;
      await credits.topupPending(EA, PA1, ref, 5_000, future(600_000));
      const before = account(EA);
      const body = envelope(eventId("connect"), "checkout.session.completed", session(ref, EA, PA1, 5_000), "acct_studio_1");
      await deliver(body, { secret: CONNECT_SECRET });
      expect(account(EA)).toBe(before);
      expect(topupRow(ref)).toBe("pending:5000:0:0:0");
      // and a platform-secret signature on a payload that claims an account is rejected as a scope mismatch
      expect((await deliver(body, { secret: WEBHOOK_SECRET })).status).toBe(400);
      expect(account(EA)).toBe(before);
    });

    it("tampered or mismatching sessions fail loudly and credit nothing; an unregistered session credits nothing", async () => {
      const ref = `cs_wh_${RUN}_4`;
      await credits.topupPending(EA, PA1, ref, 5_000, future(600_000));
      const before = account(EA);
      const bad: [string, Record<string, unknown>][] = [
        ["another business in the metadata", { metadata: meta(EB, PA1, 5_000) }],
        ["another location in the metadata", { metadata: meta(EA, PA2, 5_000) }],
        ["a different amount", { amount_total: 10_000 }],
        ["not a pack", { amount_total: 3_000 }],
        ["another currency", { currency: "eur" }],
      ];
      for (const [label, over] of bad) {
        const id = eventId("bad");
        const result = await deliver(envelope(id, "checkout.session.completed", session(ref, EA, PA1, 5_000, over)));
        expect(result.status, label).toBe(500);
        expect(claimStatus(id), label).toBe("failed");
        expect(account(EA), label).toBe(before);
      }
      const unregistered = await deliver(envelope(eventId("unreg"), "checkout.session.completed", session(`cs_wh_${RUN}_never`, EA, PA1, 5_000)));
      expect(unregistered.status).toBe(200);
      expect(count(`select count(*) from public.studio_sms_credit_ledger where ref = 'cs_wh_${RUN}_never'`)).toBe(0);
      expect(topupRow(ref)).toBe("pending:5000:0:0:0");
    });

    it("a delayed payment stays pending until it succeeds; failure and expiry close it; a payment that arrives after an expiry is still credited (the money was taken)", async () => {
      const delayed = `cs_wh_${RUN}_5`;
      await credits.topupPending(EA, PA1, delayed, 2_500, future(600_000));
      const before = balance(EA);
      await deliver(envelope(eventId("unpaid"), "checkout.session.completed", session(delayed, EA, PA1, 2_500, { payment_status: "unpaid" })));
      expect(balance(EA)).toBe(before);
      expect(topupRow(delayed)).toBe("pending:2500:0:0:0");
      await deliver(envelope(eventId("asyncok"), "checkout.session.async_payment_succeeded", session(delayed, EA, PA1, 2_500)));
      expect(balance(EA)).toBe(before + 2_500);
      const failed = `cs_wh_${RUN}_6`;
      await credits.topupPending(EA, PA1, failed, 2_500, future(600_000));
      await deliver(envelope(eventId("asyncfail"), "checkout.session.async_payment_failed", session(failed, EA, PA1, 2_500, { payment_status: "unpaid" })));
      expect(topupRow(failed)).toBe("failed:2500:0:0:0");
      expect(balance(EA)).toBe(before + 2_500);
      const expired = `cs_wh_${RUN}_7`;
      await credits.topupPending(EA, PA1, expired, 2_500, future(600_000));
      await deliver(envelope(eventId("expired"), "checkout.session.expired", session(expired, EA, PA1, 2_500, { payment_status: "unpaid" })));
      expect(topupRow(expired)).toBe("failed:2500:0:0:0");
      await deliver(envelope(eventId("late"), "checkout.session.completed", session(expired, EA, PA1, 2_500)));
      expect(topupRow(expired)).toBe("settled:2500:0:0:0");
      expect(balance(EA)).toBe(before + 5_000);
    });

    it("refunds and disputes arriving by webhook move the balance once; replays, Connect events and strangers do not", async () => {
      const ref = `cs_wh_${RUN}_8`;
      const pi = `pi_for_${ref}`;
      await credits.topupPending(EA, PA2, ref, 10_000, future(600_000));
      await deliver(envelope(eventId("p"), "checkout.session.completed", session(ref, EA, PA2, 10_000)));
      const start = balance(EA);
      const charge = (refunded: number) => ({ id: `ch_${ref}`, object: "charge", payment_intent: pi, amount: 10_000, amount_refunded: refunded, metadata: meta(EA, PA2, 10_000) });
      const refundEvent = envelope(eventId("rf"), "charge.refunded", charge(4_000));
      expect((await deliver(refundEvent)).status).toBe(200);
      expect((await deliver(refundEvent)).text).toBe("Already processed");
      expect((await deliver(envelope(eventId("rf2"), "charge.updated", charge(4_000)))).status).toBe(200);
      expect(balance(EA)).toBe(start - 4_000);
      await deliver(envelope(eventId("rf3"), "charge.refunded", charge(5_000)));
      expect(balance(EA)).toBe(start - 5_000);
      await deliver(envelope(eventId("rf4"), "charge.refunded", charge(5_000), "acct_studio_1"), { secret: CONNECT_SECRET }); // a Connect charge with the same PI string is not ours
      expect(balance(EA)).toBe(start - 5_000);
      const dispute = (status: string) => ({ id: `dp_${ref}`, object: "dispute", payment_intent: pi, amount: 5_000, status });
      await deliver(envelope(eventId("dc"), "charge.dispute.created", dispute("needs_response")));
      await deliver(envelope(eventId("dw"), "charge.dispute.funds_withdrawn", dispute("needs_response")));
      expect(balance(EA)).toBe(start - 10_000);
      await deliver(envelope(eventId("dl"), "charge.dispute.updated", dispute("under_review")));
      expect(balance(EA)).toBe(start - 10_000);
      await deliver(envelope(eventId("dr"), "charge.dispute.closed", dispute("won")));
      await deliver(envelope(eventId("dr2"), "charge.dispute.funds_reinstated", dispute("won")));
      expect(balance(EA)).toBe(start - 5_000);
      expect(topupRow(ref)).toBe("settled:10000:5000:0:5000");
      // a charge and a dispute that are not ours still go to the other handlers (they do not touch credit)
      const strangerCharge = { id: "ch_other", object: "charge", payment_intent: "pi_not_ours", amount: 1000, amount_refunded: 1000, metadata: {} };
      const before = account(EA);
      await deliver(envelope(eventId("st"), "charge.refunded", strangerCharge));
      await deliver(envelope(eventId("sd"), "charge.dispute.created", { id: "dp_other", object: "dispute", payment_intent: "pi_not_ours", amount: 1000, status: "needs_response" }));
      expect(account(EA)).toBe(before);
      expect((await credits.verify(EA)).ok).toBe(true);
    });

    it("unrelated platform events are acknowledged without touching credit", async () => {
      const before = [account(EA), account(EB)];
      expect((await deliver(envelope(eventId("cus"), "customer.created", { id: "cus_1", object: "customer" }))).status).toBe(200);
      expect([account(EA), account(EB)]).toEqual(before);
    });
  });
});
