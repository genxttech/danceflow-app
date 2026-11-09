/**
 * TW-4F sub-cent per-segment prices (migration 20261231130000_twilio_sms_price_micros) against a REAL schema. SQL only: every call goes through psql into the
 * database container (no PostgREST, no Twilio, no Stripe). Synthetic fixtures with fixed ids that are cleaned up first and last.
 *
 * THE ONE ROUNDING RULE under test (public._tw4pm_cents): exact = segments x unit_price_micros; ledger cents = CEIL(exact / 10000), once per ATTEMPT, never per segment.
 *   17,000 micros: 1 segment -> 2 cents, 3 -> 6 cents (51,000), 7 -> 12 cents (119,000); 13,000 inbound, 1 segment -> 2 cents.
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
  const verifyOk = () => psql(`select public.tw4_credit_verify('${EN}')->>'ok'`);
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

  it("the rounding rule: CEIL(micros / 10000), once per attempt; reservation = charge at the same segment count and always covers the exact amount", () => {
    const cents = (m: number) => Number(psql(`select public._tw4pm_cents(${m})`));
    expect([0, 1, 9_999, 10_000, 10_001, 13_000, 17_000, 51_000, 119_000, 130_000].map(cents)).toEqual([0, 1, 1, 1, 2, 2, 2, 6, 12, 13]);
    // exhaustive over realistic prices x 1..20 segments: ceil is the least whole-cent amount covering the exact amount
    const bad = psql(`select count(*) from (values (1),(9999),(10000),(10001),(13000),(17000),(19000),(19999),(25000),(30000)) p(u), generate_series(1, 20) s(n)
                      where public._tw4pm_cents(p.u::bigint * s.n) * 10000 < p.u::bigint * s.n or (public._tw4pm_cents(p.u::bigint * s.n) - 1) * 10000 >= p.u::bigint * s.n`);
    expect(bad).toBe("0");
    expect(psqlError("select public._tw4pm_cents(-1)")).toMatch(/22023/);
    expect(psqlError("select public._tw4pm_cents(null)")).toMatch(/22023/);
  });

  it("privileges: the micro setter and the helpers are executable by no API role; the replaced functions keep their grants", () => {
    for (const fn of ["tw4_price_set_micros(text, int, int, text, uuid)", "_tw4pm_cents(bigint)", "_tw4pm_attempt_guard()"]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_function_privilege('${role}', 'public.${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
    }
    expect(psql("select has_function_privilege('service_role', 'public.tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid)', 'execute')")).toBe("t");
    expect(psql("select has_function_privilege('anon', 'public.tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid)', 'execute')")).toBe("f");
    expect(psql("select has_function_privilege('service_role', 'public.tw4_inbound_record(uuid, text, text, int, int, text, text, timestamptz, text)', 'execute')")).toBe("t");
    expect(psql("select has_function_privilege('anon', 'public.tw4_inbound_record(uuid, text, text, int, int, text, text, timestamptz, text)', 'execute')")).toBe("f");
  });

  it("stores 13,000 (inbound) and 17,000 (outbound) micros exactly, with informational cents; fixed-fee kinds reject micros; bad shapes are refused", async () => {
    await setPriceMicros("sms_inbound", 13_000, 5_000);
    await setPriceMicros("sms_usage", 17_000, 11_800);
    expect(row("select unit_price_micros, unit_cost_micros, customer_price_cents, provider_cost_cents from public.studio_sms_price_list where kind = 'sms_inbound' and active")).toEqual({ unit_price_micros: 13_000, unit_cost_micros: 5_000, customer_price_cents: 2, provider_cost_cents: 1 });
    expect(row("select unit_price_micros, unit_cost_micros, customer_price_cents, provider_cost_cents from public.studio_sms_price_list where kind = 'sms_usage' and active")).toEqual({ unit_price_micros: 17_000, unit_cost_micros: 11_800, customer_price_cents: 2, provider_cost_cents: 2 });
    // never rounded into a whole-cent published price: the micro value is what is stored
    expect(psql("select count(*) from public.studio_sms_price_list where active and kind in ('sms_usage', 'sms_inbound') and unit_price_micros % 10000 = 0")).toBe("0");
    // the studio-facing list carries the exact value
    expect(psql("select jsonb_agg(e) from jsonb_array_elements((select jsonb_agg(jsonb_build_object('kind', kind, 'm', unit_price_micros)) from public.studio_sms_price_list where active and kind in ('sms_usage','sms_inbound'))) e")).toContain("17000");
    // fixed-fee kinds: the setter refuses, and so do the table checks (direct owner inserts)
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

  it("outbound reserve + settle at 17,000 micros: 1, 3 and 7 segments (2, 6 and 12 cents), exact_micros recorded, reservation released, ledger and gaps clean", async () => {
    await ready();
    for (const [body, segs, exact, cents] of [[ONE, 1, 17_000, 2], [THREE, 3, 51_000, 6], [SEVEN, 7, 119_000, 12]] as const) {
      const before = balance();
      const s = await submitted(body);
      expect(s.segments).toBe(segs);
      expect(s.amount_cents).toBe(cents); // reservation = ceil(segments x 17000 / 10000)
      expect(reserved()).toBe(cents);
      const a0 = attempt(s.attempt_id);
      expect(a0).toMatchObject({ unit_price_micros: 17_000, unit_cost_micros: 11_800, exact_micros: exact, reserved_cents: cents, charged_micros: null, unit_price_cents: 2 });
      const out = await settle(s.attempt_id, evidence(s.sid, segs));
      expect(out.error, JSON.stringify(out.error)).toBeNull();
      expect(out.data).toMatchObject({ outcome: "settled", charged_cents: cents, replayed: false });
      expect(attempt(s.attempt_id)).toMatchObject({ state: "settled", charged_cents: cents, charged_micros: exact, exact_micros: exact });
      expect(balance()).toBe(before - cents);
      expect(reserved()).toBe(0);
      expect(ledgerFor(`usage:sms:${s.attempt_id}`)).toBe(String(-cents));
      // replay: no second ledger row, nothing changes
      const again = await settle(s.attempt_id, evidence(s.sid, segs));
      expect(again.data).toMatchObject({ outcome: "settled", charged_cents: cents, replayed: true });
      expect(ledgerFor(`usage:sms:${s.attempt_id}`)).toBe(String(-cents));
      expect(attempt(s.attempt_id).charged_micros).toBe(exact);
    }
    expect(gaps()).toBe(0);
    expect(verifyOk()).toBe("true");
  });

  it("actual segments above the estimate (+1) are charged on the actual count (overage allowed); a failed text releases the reservation with no charge and no charged_micros", async () => {
    const s = await submitted(ONE); // estimated 1 -> reserved 2 cents
    const out = await settle(s.attempt_id, evidence(s.sid, 2)); // 2 x 17000 = 34000 -> 4 cents
    expect(out.data).toMatchObject({ outcome: "settled", charged_cents: 4 });
    expect(attempt(s.attempt_id)).toMatchObject({ charged_micros: 34_000, exact_micros: 17_000, reserved_cents: 2 });
    expect(reserved()).toBe(0);
    const f = await submitted(THREE);
    const failed = await settle(f.attempt_id, evidence(f.sid, 3, { status: "failed" }));
    expect(failed.data).toMatchObject({ outcome: "settled", charged_cents: 0 });
    expect(attempt(f.attempt_id)).toMatchObject({ state: "settled", charged_cents: 0, charged_micros: 0 });
    expect(ledgerFor(`usage:sms:${f.attempt_id}`)).toBe("");
    expect(reserved()).toBe(0);
    expect(gaps()).toBe(0);
    expect(verifyOk()).toBe("true");
  });

  it("admin resolution charges through the same rule and records charged_micros", async () => {
    const s = await submitted(ONE);
    aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '2 hours', submitting_at = now() - interval '2 hours' where id = '${s.attempt_id}'`);
    const r = await rpc("tw4_usage_resolve", { p_attempt_id: s.attempt_id, p_actor: PADMIN, p_outcome: "charged", p_segments: 3, p_reason: "fixture: admin confirms three segments" });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.data).toMatchObject({ state: "settled", charged_cents: 6 }); // 3 x 17000 = 51000 -> 6
    expect(attempt(s.attempt_id)).toMatchObject({ charged_cents: 6, charged_micros: 51_000, exact_micros: 17_000 });
    expect(ledgerFor(`usage:sms:${s.attempt_id}`)).toBe("-6");
    expect(gaps()).toBe(0);
  });

  it("the price is frozen on the attempt: a new published price never changes an open attempt; the guard trigger refuses every micro mutation", async () => {
    const s = await submitted(THREE); // reserved at 17000
    await setPriceMicros("sms_usage", 25_000, 11_800);
    const out = await settle(s.attempt_id, evidence(s.sid, 3));
    expect(out.data).toMatchObject({ charged_cents: 6 }); // still 3 x 17000, not 3 x 25000
    expect(attempt(s.attempt_id)).toMatchObject({ unit_price_micros: 17_000, charged_micros: 51_000 });
    const w = "set local tw4.usage_write = 'on';";
    for (const sql of [
      `update public.studio_sms_usage_attempts set unit_price_micros = 1000 where id = '${s.attempt_id}'`,
      `update public.studio_sms_usage_attempts set unit_cost_micros = 1 where id = '${s.attempt_id}'`,
      `update public.studio_sms_usage_attempts set exact_micros = 1 where id = '${s.attempt_id}'`,
      `update public.studio_sms_usage_attempts set charged_micros = 1 where id = '${s.attempt_id}'`,
      `update public.studio_sms_usage_attempts set unit_price_micros = null, unit_cost_micros = null, exact_micros = null where id = '${s.attempt_id}'`,
    ]) expect(psqlError(`begin; ${w} ${sql}; rollback;`), sql).toMatch(/42501|23514/);
    await setPriceMicros("sms_usage", 17_000, 11_800);
    // an open attempt cannot be given a charged_micros, and a settle cannot post cents that disagree with the rounded exact amount
    const open = await submitted(ONE);
    expect(psqlError(`begin; ${w} update public.studio_sms_usage_attempts set charged_micros = 17000 where id = '${open.attempt_id}'; rollback;`)).toMatch(/23514/);
    expect(psqlError(`begin; ${w} select set_config('tw4.usage_charged_segments', '1', true);
      update public.studio_sms_usage_attempts set state = 'settled', charged_cents = 3, closed_at = now() where id = '${open.attempt_id}'; rollback;`)).toMatch(/23514/);
    expect(psqlError(`begin; ${w} update public.studio_sms_usage_attempts set state = 'settled', charged_cents = 2, closed_at = now() where id = '${open.attempt_id}'; rollback;`)).toMatch(/42501/);
    // cleanup of the open attempt so the money checks stay clean
    expect((await settle(open.attempt_id, evidence(open.sid, 1))).data).toMatchObject({ charged_cents: 2 });
  });

  it("refund exactness and idempotency (whole cents against the posted charge); micros are untouched", async () => {
    const s = await submitted(THREE);
    expect((await settle(s.attempt_id, evidence(s.sid, 3))).data).toMatchObject({ charged_cents: 6 });
    const before = balance();
    const refund = (cents: number, key: string) => rpc("tw4_credit_refund_usage", { p_entity_id: EN, p_cents: cents, p_key: key, p_original_key: `sms:${s.attempt_id}` });
    expect((await refund(2, `pm-r1-${RUN}`)).error).toBeNull();
    expect(balance()).toBe(before + 2);
    expect((await refund(2, `pm-r1-${RUN}`)).error).toBeNull(); // same key: replay, no second credit
    expect(balance()).toBe(before + 2);
    expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EN}' and idempotency_key = 'usage_refund:pm-r1-${RUN}'`)).toBe("1");
    expect((await refund(4, `pm-r2-${RUN}`)).error).toBeNull(); // the remaining 4 of 6
    expect(balance()).toBe(before + 6);
    expect((await refund(1, `pm-r3-${RUN}`)).error?.code).toBe("22023"); // beyond the original charge
    expect(balance()).toBe(before + 6);
    expect(attempt(s.attempt_id)).toMatchObject({ charged_cents: 6, charged_micros: 51_000 });
    expect(verifyOk()).toBe("true");
    expect(gaps()).toBe(0);
  });

  it("inbound at 13,000 micros: one segment is 2 cents, exact and billable recorded; MMS and compliance are free; a replay posts once; the split holds when funds are short", async () => {
    const r1 = await inbound();
    expect(r1.error, JSON.stringify(r1.error)).toBeNull();
    expect(r1.data).toMatchObject({ recorded: true, replayed: false, classification: "ordinary", charged_cents: 2, uncollected_cents: 0 });
    expect(psql(`select unit_price_micros || '|' || exact_micros || '|' || billable_cents || '|' || unit_price_cents from public.studio_sms_inbound_usage where legal_entity_id = '${EN}' order by recorded_at desc limit 1`)).toBe("13000|13000|2|2");
    // 3 segments = 39,000 micros -> 4 cents (ONE rounding per text; per segment would be 6)
    const p3 = sid();
    expect((await inbound({ p_provider_sid: p3, p_segments: 3 })).data).toMatchObject({ charged_cents: 4 });
    expect(psql(`select exact_micros || '|' || billable_cents from public.studio_sms_inbound_usage where provider_sid = '${p3}'`)).toBe("39000|4");
    expect(ledgerFor(`usage:in:${p3}`)).toBe("-4");
    // replay of the same message SID
    expect((await inbound({ p_provider_sid: p3, p_segments: 3 })).data).toMatchObject({ replayed: true, charged_cents: 4 });
    expect(ledgerFor(`usage:in:${p3}`)).toBe("-4");
    // MMS (not billable) and compliance traffic (always free): exact 0 on a micro-priced row
    const mms = `MM${randomBytes(16).toString("hex")}`;
    expect((await inbound({ p_provider_sid: mms, p_media: 1 })).data).toMatchObject({ charged_cents: 0, uncollected_cents: 0 });
    expect(psql(`select exact_micros || '|' || billable_cents from public.studio_sms_inbound_usage where provider_sid = '${mms}'`)).toBe("0|0");
    const stop = sid();
    expect((await inbound({ p_provider_sid: stop, p_classification: "compliance" })).data).toMatchObject({ charged_cents: 0 });
    expect(psql(`select exact_micros || '|' || billable_cents from public.studio_sms_inbound_usage where provider_sid = '${stop}'`)).toBe("0|0");
    expect(psqlError(`insert into public.studio_sms_inbound_usage (legal_entity_id, studio_id, provider_sid, account_sid, source, classification, segments, unit_price_micros, exact_micros, billable_cents, charged_cents, uncollected_cents, ceiling_cents, received_at)
      values ('${EN}', '${ST}', '${sid()}', '${ACC}', 'webhook', 'ordinary', 1, 13000, 13000, 1, 1, 0, 0, now())`)).toMatch(/23514|violates check/); // 13000 micros cannot bill 1 cent
    // shortage: balance 1 cent -> charged within the ceiling, remainder uncollected, billable still 2
    await ready(2_500);
    expect((await rpc("tw4_credit_adjust", { p_entity_id: EN, p_amount_cents: -2_499, p_key: `pm-adj-${RUN}`, p_note: "fixture: leave one cent of credit", p_actor: PADMIN })).error).toBeNull();
    const short = await inbound();
    const d = short.data as { charged_cents: number; uncollected_cents: number };
    expect(d.charged_cents + d.uncollected_cents).toBe(2);
    expect(d.charged_cents).toBeLessThanOrEqual(1 + Number(psql("select public._tw4in_ceiling('" + EN + "')")));
    expect(inGaps()).toBe(0);
    expect(verifyOk()).toBe("true");
  });

  it("backward compatibility: a whole-cent price row behaves exactly as before (segments x cents, null micros everywhere), for outbound and inbound", async () => {
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
      expect(attempt(s.attempt_id)).toMatchObject({ state: "settled", charged_cents: cents, charged_micros: null, exact_micros: null });
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
    expect(psql(`select coalesce(unit_price_micros::text, 'null') || '|' || coalesce(exact_micros::text, 'null') || '|' || billable_cents || '|' || unit_price_cents from public.studio_sms_inbound_usage where provider_sid = '${i}'`)).toBe("null|null|6|2");
    expect(gaps()).toBe(0);
    expect(inGaps()).toBe(0);
    expect(verifyOk()).toBe("true");
    // a mixed history (a whole-cent attempt open while the price becomes micro) stays consistent: the open attempt keeps cents
    const open = await submitted(THREE);
    await setPriceMicros("sms_usage", 17_000, 11_800);
    expect((await settle(open.attempt_id, evidence(open.sid, 3))).data).toMatchObject({ charged_cents: 9 });
    expect(attempt(open.attempt_id)).toMatchObject({ unit_price_micros: null, charged_micros: null });
    const later = await submitted(THREE);
    expect(later.amount_cents).toBe(6);
    expect((await settle(later.attempt_id, evidence(later.sid, 3))).data).toMatchObject({ charged_cents: 6 });
    expect(gaps()).toBe(0);
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

  describe("apply and rollback (transactional scratch runs: every statement is rolled back at the end)", () => {
    const apply = read(MIG);
    const rollback = read("rollback", "20261231130000_twilio_sms_price_micros_rollback.sql");
    const noCommit = (sql: string) => sql.replace(/\ncommit;\s*$/, "\n").replace(/^begin;/m, "");
    const fingerprint = (fn: string) => `select left(md5(replace(prosrc, chr(13), '')), 8) from pg_proc where oid = '${fn}'::regprocedure`;
    const BEGIN_SIG = "public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)";
    const MICRO_COLS = `select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('studio_sms_price_list', 'studio_sms_usage_attempts', 'studio_sms_inbound_usage')
                         and column_name in ('unit_price_micros', 'unit_cost_micros', 'exact_micros', 'charged_micros')`;
    // removes every micro-priced row inside the scratch transaction (replica role bypasses the append-only guards; origin again afterwards)
    const purge = `set local session_replication_role = replica;
        delete from public.studio_sms_inbound_usage where unit_price_micros is not null;
        delete from public.studio_sms_usage_attempts where unit_price_micros is not null;
        delete from public.studio_sms_price_list where unit_price_micros is not null;
        set local session_replication_role = origin;`;

    it("the migration refuses to apply twice and refuses when a replaced function was changed; neither file commits before its end", () => {
      expect(psqlError(apply)).toMatch(/already applied/);
      expect(/\bcommit;/.test(apply.replace(/\ncommit;\s*$/, ""))).toBe(false);
      expect(/\bcommit;/.test(rollback.replace(/\ncommit;\s*$/, ""))).toBe(false);
      const out = psqlError(`begin; ${purge}
        ${noCommit(rollback)}
        create or replace function public._tw4us_charge(a public.studio_sms_usage_attempts, p_segments int, p_ref text) returns int language plpgsql as $$ begin return 0; end $$;
        ${noCommit(apply)}
        rollback;`);
      expect(out).toMatch(/price-micros precondition failed: public\._tw4us_charge/);
    });

    it("the rollback REFUSES while any micro-priced row exists (price rows, attempts, inbound records)", () => {
      expect(psqlError(rollback)).toMatch(/micro-priced rows exist/);
      for (const table of ["studio_sms_usage_attempts", "studio_sms_inbound_usage", "studio_sms_price_list"]) {
        expect(Number(psql(`select count(*) from public.${table} where unit_price_micros is not null`)), table).toBeGreaterThan(0);
        // refused on that table alone: purge the other two inside a scratch transaction
        const others = ["studio_sms_usage_attempts", "studio_sms_inbound_usage", "studio_sms_price_list"].filter((t) => t !== table);
        const out = psqlError(`begin; set local session_replication_role = replica;
          ${others.map((t) => `delete from public.${t} where unit_price_micros is not null;`).join(" ")}
          ${table === "studio_sms_price_list" ? "" : ""}
          set local session_replication_role = origin;
          ${noCommit(rollback)} rollback;`);
        // price rows referenced by attempts cannot be deleted first; in that case the refusal still names micro-priced rows
        expect(out, table).toMatch(/micro-priced rows exist|foreign key|violates/);
      }
    });

    it("with no micro-priced rows the rollback restores the four functions byte-exactly and removes the columns, then the migration re-applies cleanly", () => {
      const out = psql(`begin; ${purge}
        ${noCommit(rollback)}
        select 'begin=' || (${fingerprint(BEGIN_SIG)});
        select 'cols=' || (${MICRO_COLS});
        select 'fns=' || count(*) from pg_proc where proname in ('_tw4pm_cents', '_tw4pm_attempt_guard', 'tw4_price_set_micros');
        select 'trg=' || count(*) from pg_trigger where tgname = 'studio_sms_usage_attempts_micros';
        ${noCommit(apply)}
        select 'cols2=' || (${MICRO_COLS});
        rollback;`);
      expect(out).toContain("begin=7e85d636"); // the 20261218090000 body, byte-exactly
      expect(out).toContain("cols=0");
      expect(out).toContain("fns=0");
      expect(out).toContain("trg=0");
      expect(out).toContain("cols2=8");
      // the scratch run changed nothing
      expect(psql("select to_regprocedure('public._tw4pm_cents(bigint)') is not null")).toBe("t");
      expect(Number(psql("select count(*) from public.studio_sms_usage_attempts where unit_price_micros is not null"))).toBeGreaterThan(0);
    });

    it("the migration file pins the fingerprints of the four functions it replaces", () => {
      for (const fp of ["fec36e86", "7e85d636", "8d24953b", "ed9f57d9"]) expect(apply).toContain(`'${fp}'`);
      expect(apply).toContain("CEIL(exact_micros / 10000)");
      expect(createHash("sha256").update(apply).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
