/**
 * TW-4F sub-cent per-segment prices (migration 20261231130000_twilio_sms_price_micros) against a REAL schema. SQL only: every call goes through psql into the
 * database container (no PostgREST, no Twilio, no Stripe). Synthetic fixtures with fixed ids that are cleaned up first and last.
 *
 * THE ONE ACCOUNTING RULE under test (public._tw4pm_carry, option R2 carried remainder): exact = segments x unit_price_micros; per business total = carry + exact,
 * cents = floor(total / 10000), new carry = total mod 10000. 17,000 micros, one-segment texts post 1, 2, 2, 1, 2 cents (carry 7000, 4000, 1000, 8000, 5000); 13,000 inbound
 * releases 1, 1, 1, 2. The reservation is ceil(exact / 10000) and always covers the charge. Whole-cent price rows never touch the carry.
 *
 * LOCAL QA ONLY: a DEDICATED Postgres built with migrations through 20261231130000 and WITHOUT the unapplied 20270210* price dual-control migrations (it publishes
 * prices with the owner-level tw4_price_set / tw4_price_set_micros, which dual control closes):
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4RFL_DB=postgres
 *   npx vitest run --no-file-parallelism src/lib/sms/__tests__/localStack.pricemicros.test.ts
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LOCAL_QA_MARKER, newSenderIds, readySender, reconcilerReadySql, reconcilerRunsCleanupSql, type SenderIds } from "./senderFixtures";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const MIGRATIONS = join(process.cwd(), "src/lib/supabase/migrations");
const MIG = "20261231130000_twilio_sms_price_micros.sql";
const read = (...p: string[]) => readFileSync(join(MIGRATIONS, ...p), "utf8").replace(/\r/g, "");

const ST = "b1c0aaaa-0000-4000-8000-00000000000a";
const EN = "b1c0aaaa-0000-4000-8000-0000000000e1";
const PADMIN = "b1c0aaaa-0000-4000-8000-000000000401";
const OTHER_ADMIN_ROLE = "b1c0aaaa-0000-4000-8000-000000000501";
const ACC = `AC${"b1".repeat(16)}`;
const MG = `MG${"b1".repeat(16)}`;
const PHONE = "+15125550142";
const RUN = randomBytes(3).toString("hex");

type Err = { code: string; message: string };
const run = (sql: string): string =>
  execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const psql = run;
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const aged = (sql: string) => run(`begin; set local session_replication_role = replica; ${sql}; commit;`);

const lit = (v: unknown): string =>
  v === null || v === undefined ? "null" : typeof v === "number" || typeof v === "boolean" ? String(v) : typeof v === "object" ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb` : `'${String(v).replace(/'/g, "''")}'`;
/** the PostgREST-shaped helper the shared fixtures expect, over psql: named-argument call, JSON result, SQLSTATE parsed from the verbose error */
const rpc = async (fn: string, args: Record<string, unknown> = {}): Promise<{ data: unknown; error: Err | null }> => {
  const call = `select to_jsonb(public.${fn}(${Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(", ")}))`;
  try {
    const out = execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: `\\set VERBOSITY verbose\n${call};`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { data: out ? JSON.parse(out) : null, error: null };
  } catch (error) {
    const text = String((error as { stderr?: Buffer | string }).stderr ?? error);
    const m = /ERROR:\s+(\w{5}):\s+(.*)/.exec(text);
    return { data: null, error: { code: m?.[1] ?? "unknown", message: m?.[2] ?? text } };
  }
};

const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_inbound_usage where legal_entity_id = '${EN}';
delete from public.studio_sms_usage_attempts where legal_entity_id = '${EN}';
delete from public.studio_sms_sender_verifications where legal_entity_id = '${EN}';
delete from public.studio_sms_provisioning_steps where studio_id = '${ST}';
delete from public.studio_sms_approval_refs where legal_entity_id = '${EN}';
delete from public.studio_sms_billed_senders where legal_entity_id = '${EN}';
delete from public.studio_sms_usage_switch_log where changed_by = '${PADMIN}';
delete from public.sms_message_logs where studio_id = '${ST}';
delete from public.studio_sms_monthly_limits where legal_entity_id = '${EN}';
delete from public.studio_sms_entity_timezones where legal_entity_id = '${EN}';
delete from public.studio_sms_limit_ceilings where legal_entity_id = '${EN}';
delete from public.studio_sms_credit_ledger where legal_entity_id = '${EN}';
delete from public.studio_sms_credit_reservations where legal_entity_id = '${EN}';
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id = '${EN}');
delete from public.studio_sms_credit_topups where legal_entity_id = '${EN}';
delete from public.studio_sms_credit_accounts where legal_entity_id = '${EN}';
delete from public.studio_sms_twilio_accounts where legal_entity_id = '${EN}';
delete from public.studio_sms_entity_studios where legal_entity_id = '${EN}';
delete from public.studio_sms_legal_entities where id = '${EN}';
delete from public.studio_sms_price_list where created_by = '${PADMIN}';
delete from public.user_studio_roles where studio_id = '${ST}';
delete from public.studio_sms_onboarding_audit where studio_id = '${ST}';
delete from public.studios where id = '${ST}';
delete from public.profiles where id in ('${PADMIN}', '${OTHER_ADMIN_ROLE}');
delete from auth.users where email like '%@pricemicros-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${PADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin@pricemicros-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${PADMIN}', 'platform_admin') on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values ('${ST}', 'PRICEMICROS A', 'pricemicros-a', null, 'America/Chicago');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${EN}', 'PM Alpha LLC', '5561', 15000, '${PADMIN}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at)
  values ('${ST}', '${EN}', 'founding', '${PADMIN}', 'fixture: verified business', now() - interval '2 days');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by)
  values ('${EN}', '${ACC}', 'df:test:${EN}', 'test', 'active', '${PADMIN}');
commit;`;

describe.skipIf(!enabled)("TW-4F sub-cent per-segment prices: one rounding rule, frozen prices, exact micros, whole-cent compatibility (real schema)", () => {
  let n = 0;
  let ids: SenderIds;
  const sid = () => `SM${randomBytes(16).toString("hex")}`;
  const balance = () => Number(psql(`select coalesce((select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${EN}'), 0)`));
  const reserved = () => Number(psql(`select coalesce((select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${EN}'), 0)`));
  const gaps = () => Number(psql("select public._tw4us_reconciliation_gaps()"));
  const inGaps = () => Number(psql("select public._tw4in_reconciliation_gaps()"));
  const verifyJson = () => JSON.parse(psql(`select public.tw4_credit_verify('${EN}')::text`)) as Record<string, unknown>;
  const carryNow = () => Number(psql(`select coalesce((select usage_carry_micros from public.studio_sms_credit_accounts where legal_entity_id = '${EN}'), 0)`));
  const row = <T = Record<string, unknown>>(sql: string) => JSON.parse(psql(`select row_to_json(t)::text from (${sql}) t`)) as T;
  const attempt = (id: string) => row(`select * from public.studio_sms_usage_attempts where id = '${id}'`) as Record<string, string | number | null>;
  const ledgerFor = (key: string) => psql(`select coalesce(string_agg(balance_delta_cents::text, ','), '') from public.studio_sms_credit_ledger where legal_entity_id = '${EN}' and idempotency_key = '${key}'`);
  const setPriceCents = async (kind: string, cents: number, provider: number) => {
    const r = await rpc("tw4_price_set", { p_kind: kind, p_customer_cents: cents, p_provider_cents: provider, p_description: `fixture ${kind} cents`, p_actor: PADMIN });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
  };
  const setPriceMicros = async (kind: string, price: number, cost: number) => {
    // no API role can execute it (by design): the suite runs as the database owner
    const out = psql(`select public.tw4_price_set_micros('${kind}', ${price}, ${cost}, 'fixture ${kind} micros', '${PADMIN}')::text`);
    expect(out).toContain("price_id");
  };
  const fund = async (pack = 10_000) => {
    n += 1;
    const ref = `cs_pm_${RUN}_${n}`;
    expect((await rpc("tw4_credit_topup_pending", { p_entity_id: EN, p_paid_by_studio_id: ST, p_provider_ref: ref, p_amount_cents: pack, p_expires_at: new Date(Date.now() + 20 * 60_000).toISOString() })).error).toBeNull();
    expect((await rpc("tw4_credit_settle_topup", { p_entity_id: EN, p_paid_by_studio_id: ST, p_provider_ref: ref, p_amount_cents: pack, p_event_id: `evt_pm_${RUN}_${n}`, p_payment_intent: `pi_pm_${RUN}_${n}`, p_require_pending: true })).error).toBeNull();
  };
  const resetMoney = () =>
    aged(`delete from public.studio_sms_inbound_usage where legal_entity_id = '${EN}'; delete from public.studio_sms_usage_attempts where legal_entity_id = '${EN}';
          delete from public.sms_message_logs where studio_id = '${ST}'; delete from public.studio_sms_recurring_charges where legal_entity_id = '${EN}';
          delete from public.studio_sms_credit_ledger where legal_entity_id = '${EN}'; delete from public.studio_sms_credit_reservations where legal_entity_id = '${EN}';
          delete from public.studio_sms_credit_topups where legal_entity_id = '${EN}'; delete from public.studio_sms_credit_accounts where legal_entity_id = '${EN}'`);
  const ready = async (funds = 10_000) => {
    resetMoney();
    aged(`delete from public.studio_sms_monthly_limits where legal_entity_id = '${EN}'`);
    await fund(funds);
    expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: EN, p_actor: PADMIN, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly texting limit" })).error).toBeNull();
    aged(reconcilerReadySql(`pm:${RUN}`));
    expect((await rpc("tw4_usage_set_switch", { p_enabled: true, p_actor: PADMIN, p_reason: "fixture: switch on for tests" })).error).toBeNull();
  };
  const ONE = "Your lesson is tomorrow at 6pm. Reply STOP to opt out."; // 1 segment
  const THREE = "a".repeat(400); // 306 < 400 <= 459: 3 segments
  const SEVEN = "a".repeat(1000); // 918 < 1000 <= 1071: 7 segments
  const begin = async (body = ONE) => {
    const r = await rpc("tw4_usage_begin", {
      p_source_kind: "manual", p_source_id: randomUUID(), p_studio_id: ST, p_client_id: null, p_phone_e164: PHONE, p_body: body,
      p_message_type: "manual", p_related_table: null, p_related_id: null, p_sent_by: null,
    });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return r.data as { attempt_id: string; amount_cents: number; segments: number };
  };
  const submitted = async (body = ONE) => {
    const b = await begin(body);
    expect((await rpc("tw4_usage_dispatching", { p_attempt_id: b.attempt_id })).data).toMatchObject({ dispatch: true });
    const s = sid();
    expect((await rpc("tw4_usage_submitted", { p_attempt_id: b.attempt_id, p_provider_sid: s })).error).toBeNull();
    return { ...b, sid: s };
  };
  const evidence = (s: string, segments: number, over: Record<string, unknown> = {}) => {
    const [mg, from, to] = psql(`select coalesce(a.messaging_service_sid, '') || '|' || coalesce(a.sender_e164, '') || '|' || coalesce(l.phone_e164, '') from public.studio_sms_usage_attempts a
                       join public.sms_message_logs l on l.id = a.message_log_id where a.provider_sid = '${s}'`).split("|");
    return { sid: s, account_sid: ACC, status: "delivered", num_segments: String(segments), num_media: "0", price: "-0.00790", price_unit: "USD",
      direction: "outbound-api", messaging_service_sid: mg || null, from: from || null, to: to || null, date_created: new Date().toISOString(), ...over };
  };
  const settle = (id: string, ev: Record<string, unknown>) => rpc("tw4_usage_settle", { p_attempt_id: id, p_evidence: ev });
  const inbound = (over: Record<string, unknown> = {}) =>
    rpc("tw4_inbound_record", { p_studio_id: ST, p_signer_account: ACC, p_provider_sid: sid(), p_segments: 1, p_media: 0, p_classification: "ordinary", p_reply_body: null, p_received_at: null, p_source: "webhook", ...over });

  beforeAll(async () => {
    expect(psql("select to_regprocedure('public._tw4pm_cents(bigint)') is not null")).toBe("t");
    run(FIXTURES);
    run(LOCAL_QA_MARKER);
    ids = newSenderIds("+15125550201", { mg: MG });
    await readySender(rpc, (sql) => aged(sql), { studio: ST, account: ACC, actor: PADMIN, ids });
  });
  afterAll(() => {
    try {
      run(CLEANUP);
      aged(reconcilerRunsCleanupSql(`pm:${RUN}`));
    } catch {
      /* best effort */
    }
  });

  it("the reservation bound is CEIL(micros / 10000) and always covers the carried charge at the same segment count", () => {
    const cents = (m: number) => Number(psql(`select public._tw4pm_cents(${m})`));
    expect([0, 1, 9_999, 10_000, 10_001, 13_000, 17_000, 51_000, 119_000, 130_000].map(cents)).toEqual([0, 1, 1, 1, 2, 2, 2, 6, 12, 13]);
    // exhaustive: for every prices x segments x carry in 0..9999 the carried charge floor((carry + exact) / 10000) is <= the reservation ceil(exact / 10000)
    const bad = psql(`select count(*) from (values (1),(9999),(10000),(10001),(13000),(17000),(19000),(19999),(25000),(30000)) p(u), generate_series(1, 20) s(n), generate_series(0, 9999, 37) c(carry)
                      where (c.carry + p.u::bigint * s.n) / 10000 > public._tw4pm_cents(p.u::bigint * s.n)`);
    expect(bad).toBe("0");
    expect(psqlError("select public._tw4pm_cents(-1)")).toMatch(/22023/);
    expect(psqlError("select public._tw4pm_cents(null)")).toMatch(/22023/);
  });

  it("privileges: the micro setter and the helpers are executable by no API role; the replaced functions keep their grants", () => {
    for (const fn of ["tw4_price_set_micros(text, int, int, text, uuid)", "_tw4pm_cents(bigint)", "_tw4pm_carry(uuid, bigint)", "_tw4pm_attempt_guard()"]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_function_privilege('${role}', 'public.${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
    }
    expect(psql("select has_function_privilege('service_role', 'public.tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid)', 'execute')")).toBe("t");
    expect(psql("select has_function_privilege('anon', 'public.tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid)', 'execute')")).toBe("f");
    expect(psql("select has_function_privilege('service_role', 'public.tw4_inbound_record(uuid, text, text, int, int, text, text, timestamptz, text)', 'execute')")).toBe("t");
    expect(psql("select has_function_privilege('anon', 'public.tw4_inbound_record(uuid, text, text, int, int, text, text, timestamptz, text)', 'execute')")).toBe("f");
    expect(psql("select has_function_privilege('service_role', 'public.tw4_credit_verify(uuid)', 'execute')")).toBe("t");
    expect(psql("select has_function_privilege('anon', 'public.tw4_credit_verify(uuid)', 'execute') or has_function_privilege('authenticated', 'public.tw4_credit_verify(uuid)', 'execute')")).toBe("f");
  });

  it("stores 13,000 (inbound) and 17,000 (outbound) micros exactly, with informational cents; fixed-fee kinds reject micros; bad shapes are refused", async () => {
    await setPriceMicros("sms_inbound", 13_000, 5_000);
    await setPriceMicros("sms_usage", 17_000, 11_800);
    expect(row("select unit_price_micros, unit_cost_micros, customer_price_cents, provider_cost_cents from public.studio_sms_price_list where kind = 'sms_inbound' and active")).toEqual({ unit_price_micros: 13_000, unit_cost_micros: 5_000, customer_price_cents: 2, provider_cost_cents: 1 });
    expect(row("select unit_price_micros, unit_cost_micros, customer_price_cents, provider_cost_cents from public.studio_sms_price_list where kind = 'sms_usage' and active")).toEqual({ unit_price_micros: 17_000, unit_cost_micros: 11_800, customer_price_cents: 2, provider_cost_cents: 2 });
    expect(psql("select count(*) from public.studio_sms_price_list where active and kind in ('sms_usage', 'sms_inbound') and unit_price_micros % 10000 = 0")).toBe("0");
    expect(psqlError(`select public.tw4_price_set_micros('monthly', 15000, 1000, 'fixture monthly micros', '${PADMIN}')`)).toMatch(/22023/);
    expect(psqlError(`select public.tw4_price_set_micros('sms_usage', 0, 1000, 'fixture zero price', '${PADMIN}')`)).toMatch(/22023/);
    expect(psqlError(`select public.tw4_price_set_micros('sms_usage', 17000, null, 'fixture null cost', '${PADMIN}')`)).toMatch(/22023/);
    expect(psqlError(`select public.tw4_price_set_micros('sms_usage', 17000, 1000, 'fixture non admin', '${OTHER_ADMIN_ROLE}')`)).toMatch(/42501/);
    for (const bad of [
      "('monthly', 2, 1, 15000, 1000)", // fixed-fee kind with micros
      "('sms_usage', 3, 1, 17000, 1000)", // cents not the ceiling of the micros
      "('sms_usage', 2, 1, 17000, null)", // one micro column only
      "('sms_usage', 2, 1, null, 1000)",
    ]) {
      expect(psqlError(`insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, unit_price_micros, unit_cost_micros, description, created_by, active)
                        values ${bad.replace(")", ", 'fixture bad shape', '" + PADMIN + "', false)")}`), bad).toMatch(/23514|violates check/);
    }
  });

  it("carried remainder, outbound at 17,000 micros: one-segment texts post 1, 2, 2, 1, 2 cents (carry 7000, 4000, 1000, 8000, 5000); then 3 and 7 segments; replay never carries twice", async () => {
    await ready();
    expect(carryNow()).toBe(0);
    const results: Array<{ cents: number; carry: number }> = [];
    for (const [expCents, expCarry] of [[1, 7_000], [2, 4_000], [2, 1_000], [1, 8_000], [2, 5_000]] as const) {
      const before = balance();
      const s = await submitted(ONE);
      expect(s.segments).toBe(1);
      expect(s.amount_cents).toBe(2); // the reservation (ceil of 17,000) always covers the carried charge
      expect(reserved()).toBe(2);
      const a0 = attempt(s.attempt_id);
      expect(a0).toMatchObject({ unit_price_micros: 17_000, unit_cost_micros: 11_800, exact_micros: 17_000, reserved_cents: 2, charged_micros: null, carry_before_micros: null, unit_price_cents: 2 });
      const out = await settle(s.attempt_id, evidence(s.sid, 1));
      expect(out.error, JSON.stringify(out.error)).toBeNull();
      expect(out.data).toMatchObject({ outcome: "settled", charged_cents: expCents, replayed: false });
      expect(attempt(s.attempt_id)).toMatchObject({ state: "settled", charged_cents: expCents, charged_micros: 17_000, carry_after_micros: expCarry });
      expect(carryNow()).toBe(expCarry);
      expect(balance()).toBe(before - expCents);
      expect(reserved()).toBe(0);
      expect(ledgerFor(`usage:sms:${s.attempt_id}`)).toBe(String(-expCents));
      // replay: no second ledger row, nothing carried twice
      const again = await settle(s.attempt_id, evidence(s.sid, 1));
      expect(again.data).toMatchObject({ outcome: "settled", charged_cents: expCents, replayed: true });
      expect(ledgerFor(`usage:sms:${s.attempt_id}`)).toBe(String(-expCents));
      expect(carryNow()).toBe(expCarry);
      results.push({ cents: expCents, carry: expCarry });
    }
    expect(results.reduce((n, r) => n + r.cents, 0)).toBe(8); // 5 x 17,000 = 85,000 = 8 cents + 5,000 carried
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
    // multi-segment texts continue from the carry
    for (const [body, segs, exact] of [[THREE, 3, 51_000], [SEVEN, 7, 119_000]] as const) {
      const c0 = carryNow();
      const expCents = Math.floor((c0 + exact) / 10_000);
      const s = await submitted(body);
      expect(s.segments).toBe(segs);
      expect(s.amount_cents).toBe(Math.ceil(exact / 10_000));
      expect(expCents).toBeLessThanOrEqual(s.amount_cents);
      expect((await settle(s.attempt_id, evidence(s.sid, segs))).data).toMatchObject({ charged_cents: expCents });
      expect(attempt(s.attempt_id)).toMatchObject({ exact_micros: exact, charged_micros: exact, carry_before_micros: c0, carry_after_micros: (c0 + exact) % 10_000 });
      expect(carryNow()).toBe((c0 + exact) % 10_000);
    }
    expect(carryNow()).toBe(5_000); // 85,000 + 51,000 + 119,000 = 255,000 = 25 cents + 5,000
    expect(psql(`select -sum(balance_delta_cents) from public.studio_sms_credit_ledger where legal_entity_id = '${EN}' and kind = 'usage_charge'`)).toBe("25");
    expect(gaps()).toBe(0);
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
  });

  it("a text that releases 0 cents (3,000 micros): reserved 1 cent, settled with no ledger row, its micros sit in the carry and are paid by later texts", async () => {
    await setPriceMicros("sms_usage", 3_000, 1_000);
    await ready();
    const expected = [0, 0, 0, 1, 0, 0, 1]; // carry 3000, 6000, 9000, 2000 (12000 -> 1), 5000, 8000, 1000 (11000 -> 1)
    for (const [i, cents] of expected.entries()) {
      const before = balance();
      const s = await submitted(ONE);
      expect(s.amount_cents).toBe(1);
      const out = await settle(s.attempt_id, evidence(s.sid, 1));
      expect(out.data, `text ${i}`).toMatchObject({ outcome: "settled", charged_cents: cents });
      expect(attempt(s.attempt_id)).toMatchObject({ state: "settled", charged_cents: cents, charged_micros: 3_000 });
      expect(balance()).toBe(before - cents);
      expect(reserved()).toBe(0);
      expect(ledgerFor(`usage:sms:${s.attempt_id}`)).toBe(cents === 0 ? "" : String(-cents));
    }
    expect(carryNow()).toBe(1_000);
    expect(gaps()).toBe(0);
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
    await setPriceMicros("sms_usage", 17_000, 11_800);
  });

  it("actual segments above the estimate are charged on the actual count (overage allowed); a failed text closes with no charge and no carry movement", async () => {
    await ready();
    const s = await submitted(ONE); // estimated 1 -> reserved 2 cents
    const exp = Math.floor((carryNow() + 34_000) / 10_000);
    const out = await settle(s.attempt_id, evidence(s.sid, 2)); // 2 x 17,000
    expect(out.data).toMatchObject({ outcome: "settled", charged_cents: exp });
    expect(attempt(s.attempt_id)).toMatchObject({ charged_micros: 34_000, exact_micros: 17_000, reserved_cents: 2, carry_before_micros: 0, carry_after_micros: 4_000 });
    expect(carryNow()).toBe(4_000);
    expect(reserved()).toBe(0);
    const f = await submitted(THREE);
    const failed = await settle(f.attempt_id, evidence(f.sid, 3, { status: "failed" }));
    expect(failed.data).toMatchObject({ outcome: "settled", charged_cents: 0 });
    expect(attempt(f.attempt_id)).toMatchObject({ state: "settled", charged_cents: 0, charged_micros: 0, carry_before_micros: null, carry_after_micros: null });
    expect(ledgerFor(`usage:sms:${f.attempt_id}`)).toBe("");
    expect(carryNow()).toBe(4_000);
    expect(reserved()).toBe(0);
    expect(gaps()).toBe(0);
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
  });

  it("admin resolution charges through the same carried rule", async () => {
    const c0 = carryNow();
    const s = await submitted(ONE);
    aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '2 hours', submitting_at = now() - interval '2 hours' where id = '${s.attempt_id}'`);
    const r = await rpc("tw4_usage_resolve", { p_attempt_id: s.attempt_id, p_actor: PADMIN, p_outcome: "charged", p_segments: 3, p_reason: "fixture: admin confirms three segments" });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const exp = Math.floor((c0 + 51_000) / 10_000);
    expect(r.data).toMatchObject({ state: "settled", charged_cents: exp });
    expect(attempt(s.attempt_id)).toMatchObject({ charged_cents: exp, charged_micros: 51_000, exact_micros: 17_000, carry_before_micros: c0, carry_after_micros: (c0 + 51_000) % 10_000 });
    expect(ledgerFor(`usage:sms:${s.attempt_id}`)).toBe(String(-exp));
    expect(carryNow()).toBe((c0 + 51_000) % 10_000);
    expect(gaps()).toBe(0);
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
  });

  it("the price is frozen on the attempt; the guard trigger and checks refuse every micro mutation and every charge that does not add up through the carry", async () => {
    const s = await submitted(THREE); // reserved at 17,000
    await setPriceMicros("sms_usage", 25_000, 11_800);
    const c0 = carryNow();
    const out = await settle(s.attempt_id, evidence(s.sid, 3));
    expect(out.data).toMatchObject({ charged_cents: Math.floor((c0 + 51_000) / 10_000) }); // still 3 x 17,000, not 3 x 25,000
    expect(attempt(s.attempt_id)).toMatchObject({ unit_price_micros: 17_000, charged_micros: 51_000 });
    const w = "set local tw4.usage_write = 'on';";
    for (const sql of [
      `update public.studio_sms_usage_attempts set unit_price_micros = 1000 where id = '${s.attempt_id}'`,
      `update public.studio_sms_usage_attempts set unit_cost_micros = 1 where id = '${s.attempt_id}'`,
      `update public.studio_sms_usage_attempts set exact_micros = 1 where id = '${s.attempt_id}'`,
      `update public.studio_sms_usage_attempts set charged_micros = 1 where id = '${s.attempt_id}'`,
      `update public.studio_sms_usage_attempts set carry_after_micros = 1 where id = '${s.attempt_id}'`,
      `update public.studio_sms_usage_attempts set unit_price_micros = null, unit_cost_micros = null, exact_micros = null where id = '${s.attempt_id}'`,
    ]) expect(psqlError(`begin; ${w} ${sql}; rollback;`), sql).toMatch(/42501|23514/);
    await setPriceMicros("sms_usage", 17_000, 11_800);
    const open = await submitted(ONE);
    // an open attempt cannot be given micro results
    expect(psqlError(`begin; ${w} update public.studio_sms_usage_attempts set charged_micros = 17000 where id = '${open.attempt_id}'; rollback;`)).toMatch(/23514/);
    // a charge without the charge function's hand-over is refused
    expect(psqlError(`begin; ${w} update public.studio_sms_usage_attempts set state = 'settled', charged_cents = 2, closed_at = now() where id = '${open.attempt_id}'; rollback;`)).toMatch(/42501/);
    // a hand-over whose cents do not add up (before 0 + 17,000 = after 7,000 + 10,000 x 1) is refused by the row check
    const hand = (cents: number, after: number) => `begin; ${w} select set_config('tw4.usage_carry', '${open.attempt_id}|1|0|${after}', true) is not null;
      update public.studio_sms_usage_attempts set state = 'settled', charged_cents = ${cents}, closed_at = now() where id = '${open.attempt_id}'; rollback;`;
    expect(psqlError(hand(2, 7_000))).toMatch(/23514/);
    expect(psqlError(hand(1, 6_000))).toMatch(/23514/);
    expect(psqlError(hand(1, 7_000))).toBe(""); // positive control: 0 + 17,000 = 7,000 + 10,000 x 1
    // a hand-over for ANOTHER attempt is ignored (no stale hand-over can be used)
    expect(psqlError(`begin; ${w} select set_config('tw4.usage_carry', '${s.attempt_id}|1|0|7000', true) is not null;
      update public.studio_sms_usage_attempts set state = 'settled', charged_cents = 1, closed_at = now() where id = '${open.attempt_id}'; rollback;`)).toMatch(/42501/);
    expect((await settle(open.attempt_id, evidence(open.sid, 1))).data).toMatchObject({ outcome: "settled" });
  });

  it("refund exactness and idempotency (whole cents against the posted charge); the carry is untouched", async () => {
    const c0 = carryNow();
    const s = await submitted(THREE);
    const posted = Math.floor((c0 + 51_000) / 10_000);
    expect((await settle(s.attempt_id, evidence(s.sid, 3))).data).toMatchObject({ charged_cents: posted });
    const carry = carryNow();
    const before = balance();
    const refund = (cents: number, key: string) => rpc("tw4_credit_refund_usage", { p_entity_id: EN, p_cents: cents, p_key: key, p_original_key: `sms:${s.attempt_id}` });
    expect((await refund(2, `pm-r1-${RUN}`)).error).toBeNull();
    expect(balance()).toBe(before + 2);
    expect((await refund(2, `pm-r1-${RUN}`)).error).toBeNull(); // same key: replay, no second credit
    expect(balance()).toBe(before + 2);
    expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EN}' and idempotency_key = 'usage_refund:pm-r1-${RUN}'`)).toBe("1");
    expect((await refund(posted - 2, `pm-r2-${RUN}`)).error).toBeNull(); // the rest of the posted charge
    expect(balance()).toBe(before + posted);
    expect((await refund(1, `pm-r3-${RUN}`)).error?.code).toBe("22023"); // beyond the posted charge
    expect(balance()).toBe(before + posted);
    expect(carryNow()).toBe(carry);
    expect(attempt(s.attempt_id)).toMatchObject({ charged_cents: posted, charged_micros: 51_000 });
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
    expect(gaps()).toBe(0);
  });

  it("inbound at 13,000 micros: texts release 1, 1, 1, 2 cents (carry 3000, 6000, 9000, 2000); exact and billable recorded; MMS and compliance are free and leave the carry; a replay posts and carries once", async () => {
    await ready();
    expect(carryNow()).toBe(0);
    const got: number[] = [];
    for (const [cents, carry] of [[1, 3_000], [1, 6_000], [1, 9_000], [2, 2_000]] as const) {
      const sidv = sid();
      const r = await inbound({ p_provider_sid: sidv });
      expect(r.error, JSON.stringify(r.error)).toBeNull();
      expect(r.data).toMatchObject({ recorded: true, replayed: false, classification: "ordinary", charged_cents: cents, uncollected_cents: 0 });
      expect(psql(`select unit_price_micros || '|' || exact_micros || '|' || billable_cents || '|' || carry_after_micros || '|' || unit_price_cents from public.studio_sms_inbound_usage where provider_sid = '${sidv}'`)).toBe(`13000|13000|${cents}|${carry}|2`);
      expect(ledgerFor(`usage:in:${sidv}`)).toBe(String(-cents));
      expect(carryNow()).toBe(carry);
      got.push(cents);
    }
    expect(got.reduce((a, b) => a + b, 0)).toBe(5); // 4 x 13,000 = 52,000 = 5 cents + 2,000
    // a replay of the same message SID: nothing posted, nothing carried
    const p3 = sid();
    const c0 = carryNow();
    const first = await inbound({ p_provider_sid: p3, p_segments: 3 }); // 39,000 + 2,000 = 41,000 -> 4 cents, carry 1,000
    expect(first.data).toMatchObject({ charged_cents: 4 });
    expect(carryNow()).toBe((c0 + 39_000) % 10_000);
    expect((await inbound({ p_provider_sid: p3, p_segments: 3 })).data).toMatchObject({ replayed: true, charged_cents: 4 });
    expect(ledgerFor(`usage:in:${p3}`)).toBe("-4");
    expect(carryNow()).toBe((c0 + 39_000) % 10_000);
    // MMS (not billable) and compliance traffic (always free): exact 0, the carry is recorded but does not move
    const c1 = carryNow();
    const mms = `MM${randomBytes(16).toString("hex")}`;
    expect((await inbound({ p_provider_sid: mms, p_media: 1 })).data).toMatchObject({ charged_cents: 0, uncollected_cents: 0 });
    expect(psql(`select exact_micros || '|' || billable_cents || '|' || carry_before_micros || '|' || carry_after_micros from public.studio_sms_inbound_usage where provider_sid = '${mms}'`)).toBe(`0|0|${c1}|${c1}`);
    const stop = sid();
    expect((await inbound({ p_provider_sid: stop, p_classification: "compliance" })).data).toMatchObject({ charged_cents: 0 });
    expect(psql(`select exact_micros || '|' || billable_cents from public.studio_sms_inbound_usage where provider_sid = '${stop}'`)).toBe("0|0");
    expect(carryNow()).toBe(c1);
    // the row check refuses a record whose cents do not add up through the carry
    expect(psqlError(`insert into public.studio_sms_inbound_usage (legal_entity_id, studio_id, provider_sid, account_sid, source, classification, segments, unit_price_micros, exact_micros, carry_before_micros, carry_after_micros, billable_cents, charged_cents, uncollected_cents, ceiling_cents, received_at)
      values ('${EN}', '${ST}', '${sid()}', '${ACC}', 'webhook', 'ordinary', 1, 13000, 13000, 0, 3000, 2, 2, 0, 0, now())`)).toMatch(/23514|violates check/);
    expect(inGaps()).toBe(0);
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
  });

  it("inbound: a micro-priced ordinary text can release 0 cents (billable 0, exact > 0); short funds split the RELEASED cents into charged + uncollected", async () => {
    await setPriceMicros("sms_inbound", 3_000, 1_000);
    await ready();
    const s0 = sid();
    expect((await inbound({ p_provider_sid: s0 })).data).toMatchObject({ charged_cents: 0, uncollected_cents: 0 });
    expect(psql(`select exact_micros || '|' || billable_cents || '|' || charged_cents || '|' || uncollected_cents || '|' || carry_after_micros || '|' || coalesce(est_provider_cost_cents::text, 'null') from public.studio_sms_inbound_usage where provider_sid = '${s0}'`)).toBe("3000|0|0|0|3000|1");
    expect(ledgerFor(`usage:in:${s0}`)).toBe("");
    for (let i = 0; i < 2; i += 1) await inbound();
    const s3 = sid();
    expect((await inbound({ p_provider_sid: s3 })).data).toMatchObject({ charged_cents: 1 }); // 4 x 3,000 = 12,000
    expect(carryNow()).toBe(2_000);
    await setPriceMicros("sms_inbound", 13_000, 5_000);
    // shortage: balance 1 cent -> the released cents are charged within the ceiling, the rest is uncollected
    await ready(2_500);
    expect((await rpc("tw4_credit_adjust", { p_entity_id: EN, p_amount_cents: -2_499, p_key: `pm-adj-${RUN}`, p_note: "fixture: leave one cent of credit", p_actor: PADMIN })).error).toBeNull();
    const sid2 = sid();
    const short = await inbound({ p_provider_sid: sid2, p_segments: 3 }); // 39,000 -> 3 cents released
    const d = short.data as { charged_cents: number; uncollected_cents: number };
    expect(d.charged_cents + d.uncollected_cents).toBe(3);
    expect(d.charged_cents).toBeLessThanOrEqual(1 + Number(psql("select public._tw4in_ceiling('" + EN + "')")));
    expect(psql(`select billable_cents || '|' || (charged_cents + uncollected_cents) || '|' || carry_after_micros from public.studio_sms_inbound_usage where provider_sid = '${sid2}'`)).toBe("3|3|9000");
    expect(inGaps()).toBe(0);
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
  });

  it("backward compatibility: a whole-cent price row behaves exactly as before (segments x cents, null micros and carry columns, carry untouched), outbound and inbound", async () => {
    await setPriceCents("sms_usage", 3, 1);
    await setPriceCents("sms_inbound", 2, 1);
    expect(row("select unit_price_micros, unit_cost_micros, customer_price_cents from public.studio_sms_price_list where kind = 'sms_usage' and active")).toEqual({ unit_price_micros: null, unit_cost_micros: null, customer_price_cents: 3 });
    await ready();
    for (const [body, segs, cents] of [[ONE, 1, 3], [THREE, 3, 9], [SEVEN, 7, 21]] as const) {
      const before = balance();
      const s = await submitted(body);
      expect(s.segments).toBe(segs);
      expect(s.amount_cents).toBe(cents);
      expect(attempt(s.attempt_id)).toMatchObject({ unit_price_cents: 3, unit_price_micros: null, unit_cost_micros: null, exact_micros: null, reserved_cents: cents });
      expect((await settle(s.attempt_id, evidence(s.sid, segs))).data).toMatchObject({ outcome: "settled", charged_cents: cents });
      expect(attempt(s.attempt_id)).toMatchObject({ state: "settled", charged_cents: cents, charged_micros: null, exact_micros: null, carry_before_micros: null, carry_after_micros: null });
      expect(balance()).toBe(before - cents);
      expect(ledgerFor(`usage:sms:${s.attempt_id}`)).toBe(String(-cents));
    }
    const o = await submitted(ONE);
    expect((await settle(o.attempt_id, evidence(o.sid, 2))).data).toMatchObject({ charged_cents: 6 }); // overage on the actual count, as before
    const f = await submitted(ONE);
    expect((await settle(f.attempt_id, evidence(f.sid, 1, { status: "canceled" }))).data).toMatchObject({ charged_cents: 0 });
    expect(attempt(f.attempt_id).charged_micros).toBeNull();
    const i = sid();
    expect((await inbound({ p_provider_sid: i, p_segments: 3 })).data).toMatchObject({ charged_cents: 6, uncollected_cents: 0 });
    expect(psql(`select coalesce(unit_price_micros::text, 'null') || '|' || coalesce(exact_micros::text, 'null') || '|' || coalesce(carry_after_micros::text, 'null') || '|' || billable_cents || '|' || unit_price_cents from public.studio_sms_inbound_usage where provider_sid = '${i}'`)).toBe("null|null|null|6|2");
    expect(carryNow()).toBe(0);
    expect(gaps()).toBe(0);
    expect(inGaps()).toBe(0);
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
    // a mixed history: an open whole-cent attempt keeps cents when the price becomes micro; later texts use the carry
    const open = await submitted(THREE);
    await setPriceMicros("sms_usage", 17_000, 11_800);
    expect((await settle(open.attempt_id, evidence(open.sid, 3))).data).toMatchObject({ charged_cents: 9 });
    expect(attempt(open.attempt_id)).toMatchObject({ unit_price_micros: null, charged_micros: null, carry_after_micros: null });
    expect(carryNow()).toBe(0);
    const later = await submitted(THREE);
    expect(later.amount_cents).toBe(6);
    expect((await settle(later.attempt_id, evidence(later.sid, 3))).data).toMatchObject({ charged_cents: 5 }); // 51,000 from carry 0
    expect(carryNow()).toBe(1_000);
    expect(gaps()).toBe(0);
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
  });

  it("the studio-facing price list adds the exact micro value (and keeps every old key)", async () => {
    await setPriceMicros("sms_usage", 17_000, 11_800);
    await setPriceMicros("sms_inbound", 13_000, 5_000);
    expect((await inbound()).error).toBeNull(); // a micro-priced inbound record exists for the rollback-refusal tests below
    const out = JSON.parse(psql(`begin;
      insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${PADMIN}', '${ST}', 'studio_owner', true);
      do $j$ begin perform set_config('request.jwt.claims', '{"sub":"${PADMIN}","role":"authenticated"}', true); end $j$;
      select public.sms_price_list()::text; rollback;`)) as Array<Record<string, unknown>>;
    expect(out.find((e) => e.kind === "sms_usage")).toMatchObject({ kind: "sms_usage", unit_price_micros: 17_000, customer_price_cents: 2 });
    expect(out.find((e) => e.kind === "sms_inbound")).toMatchObject({ unit_price_micros: 13_000, customer_price_cents: 2 });
    expect(out.find((e) => e.kind === "sms_usage")).toHaveProperty("description");
  });

  it("tw4_credit_verify carries the micro equation: a tampered carry or an altered charge record is reported (rolled-back scratch runs)", () => {
    expect(verifyJson()).toMatchObject({ ok: true, usage_micros_ok: true });
    const tampered = (sql: string) => JSON.parse(psql(`begin; set local session_replication_role = replica; ${sql}; set local session_replication_role = origin;
      select public.tw4_credit_verify('${EN}')::text; rollback;`)) as Record<string, unknown>;
    expect(tampered(`update public.studio_sms_credit_accounts set usage_carry_micros = (usage_carry_micros + 1) % 10000 where legal_entity_id = '${EN}'`)).toMatchObject({ ok: false, usage_micros_ok: false });
    expect(tampered(`alter table public.studio_sms_inbound_usage drop constraint studio_sms_inbound_usage_micros; update public.studio_sms_inbound_usage set exact_micros = exact_micros + 1 where id = (select id from public.studio_sms_inbound_usage where legal_entity_id = '${EN}' and exact_micros > 0 limit 1)`)).toMatchObject({ ok: false, usage_micros_ok: false });
    expect(tampered(`alter table public.studio_sms_usage_attempts drop constraint studio_sms_usage_attempts_micros_charged; update public.studio_sms_usage_attempts set charged_cents = charged_cents + 1 where id = (select id from public.studio_sms_usage_attempts where legal_entity_id = '${EN}' and charged_micros > 0 limit 1)`)).toMatchObject({ usage_micros_ok: false });
  });

  describe("apply and rollback (transactional scratch runs: every statement is rolled back at the end)", () => {
    const apply = read(MIG);
    const rollback = read("rollback", "20261231130000_twilio_sms_price_micros_rollback.sql");
    // the file minus its leading BEGIN and its final COMMIT, so a run can be wrapped in a transaction that is rolled back
    const noCommit = (sql: string) => sql.slice(0, sql.lastIndexOf("commit;")).replace("begin;", "");
    const fingerprint = (fn: string) => `select left(md5(replace(prosrc, chr(13), '')), 8) from pg_proc where oid = '${fn}'::regprocedure`;
    const BEGIN_SIG = "public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)";
    const VERIFY_SIG = "public.tw4_credit_verify(uuid)";
    const MICRO_COLS = `select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('studio_sms_price_list', 'studio_sms_usage_attempts', 'studio_sms_inbound_usage', 'studio_sms_credit_accounts')
                         and column_name in ('unit_price_micros', 'unit_cost_micros', 'exact_micros', 'charged_micros', 'carry_before_micros', 'carry_after_micros', 'usage_carry_micros')`;
    // removes every micro-priced row (replica role bypasses the append-only guards; origin again afterwards)
    const purge = `set local session_replication_role = replica;
        delete from public.studio_sms_inbound_usage where unit_price_micros is not null;
        delete from public.studio_sms_usage_attempts where unit_price_micros is not null;
        delete from public.studio_sms_price_list where unit_price_micros is not null;
        set local session_replication_role = origin;`;
    const zeroCarry = `set local session_replication_role = replica; update public.studio_sms_credit_accounts set usage_carry_micros = 0; set local session_replication_role = origin;`;

    it("the migration refuses to apply twice and refuses when a replaced function was changed; neither file commits before its end", () => {
      expect(psqlError(apply)).toMatch(/already applied/);
      expect(apply.split("commit;").length - 1).toBe(1);
      expect(rollback.split("commit;").length - 1).toBe(1);
      for (const fn of ["public._tw4us_charge(a public.studio_sms_usage_attempts, p_segments int, p_ref text) returns int", "public.tw4_credit_verify(p_entity_id uuid) returns jsonb"]) {
        const out = psqlError(`begin; ${purge} ${zeroCarry}
          ${noCommit(rollback)}
          create or replace function ${fn} language plpgsql as $$ begin return null; end $$;
          ${noCommit(apply)}
          rollback;`);
        expect(out, fn).toMatch(/price-micros precondition failed/);
      }
    });

    it("the rollback REFUSES while any micro-priced row exists (price rows, attempts, inbound records)", () => {
      expect(psqlError(rollback)).toMatch(/micro-priced rows exist|non-zero sub-cent remainder/);
      for (const table of ["studio_sms_usage_attempts", "studio_sms_inbound_usage", "studio_sms_price_list"]) {
        expect(Number(psql(`select count(*) from public.${table} where unit_price_micros is not null`)), table).toBeGreaterThan(0);
        const others = ["studio_sms_usage_attempts", "studio_sms_inbound_usage"].filter((t) => t !== table);
        const out = psqlError(`begin; ${zeroCarry} set local session_replication_role = replica;
          ${others.map((t) => `delete from public.${t} where unit_price_micros is not null;`).join(" ")}
          set local session_replication_role = origin;
          ${noCommit(rollback)} rollback;`);
        expect(out, table).toMatch(/micro-priced rows exist/);
      }
    });

    it("the rollback REFUSES while a business carries a non-zero sub-cent remainder, even with no micro-priced rows left", () => {
      expect(Number(psql("select count(*) from public.studio_sms_credit_accounts where usage_carry_micros <> 0"))).toBeGreaterThan(0);
      const out = psqlError(`begin; ${purge}
        ${noCommit(rollback)} rollback;`);
      expect(out).toMatch(/non-zero sub-cent remainder/);
    });

    it("with no micro-priced rows and no carry the rollback restores the five functions byte-exactly and removes the columns, then the migration re-applies", () => {
      const out = psql(`begin; ${purge} ${zeroCarry}
        ${noCommit(rollback)}
        select 'begin=' || (${fingerprint(BEGIN_SIG)});
        select 'verify=' || (${fingerprint(VERIFY_SIG)});
        select 'cols=' || (${MICRO_COLS});
        select 'fns=' || count(*) from pg_proc where proname in ('_tw4pm_cents', '_tw4pm_carry', '_tw4pm_attempt_guard', 'tw4_price_set_micros');
        select 'trg=' || count(*) from pg_trigger where tgname = 'studio_sms_usage_attempts_micros';
        ${noCommit(apply)}
        select 'cols2=' || (${MICRO_COLS});
        rollback;`);
      expect(out).toContain("begin=7e85d636"); // the 20261218090000 body, byte-exactly
      expect(out).toContain("verify=61da0813"); // the 20261122090000 body, byte-exactly
      expect(out).toContain("cols=0");
      expect(out).toContain("fns=0");
      expect(out).toContain("trg=0");
      expect(out).toContain("cols2=13"); // 2 (price list) + 6 (attempts) + 4 (inbound) + 1 (carry register)
      expect(psql("select to_regprocedure('public._tw4pm_carry(uuid,bigint)') is not null")).toBe("t");
      expect(Number(psql("select count(*) from public.studio_sms_usage_attempts where unit_price_micros is not null"))).toBeGreaterThan(0);
    });

    it("the migration file pins the fingerprints of the five functions it replaces and states the carried-remainder rule", () => {
      for (const fp of ["fec36e86", "7e85d636", "8d24953b", "ed9f57d9", "61da0813"]) expect(apply).toContain(`'${fp}'`);
      expect(apply).toContain("floor(total / 10000)");
      expect(apply).toContain("CARRIED REMAINDER");
      expect(createHash("sha256").update(apply).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
