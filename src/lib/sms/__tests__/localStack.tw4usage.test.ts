/**
 * SMS usage billing against a REAL schema: reservations before a send, the dispatch marker, provider answers (accepted / refused / uncertain), signed callbacks,
 * evidence-based settlement, admin resolution, month attribution, concurrency, holds, suspension, the kill switch, tenant isolation and the pilot business.
 * Nothing reaches Twilio: the provider is the in-memory fake. LOCAL QA STACK ONLY (skipped unless the variables below point at a loopback Supabase stack with the
 * migrations through 20261201090000 applied).
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 1_000_000 });

import { estimateBilledSegments } from "@/lib/sms/segments";
import { sendBilledSms } from "@/lib/sms/usageBilling";
import { FakeBilledSmsProvider } from "@/lib/sms/usageProvider";
import { reconcileSmsUsage } from "@/lib/sms/usageReconciler";
import { SupabaseCreditStore } from "@/lib/sms/twilioIsv/creditStore";
import { LOCAL_QA_MARKER, newSenderIds, readySender, type SenderIds } from "./senderFixtures";

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

const PA1 = "a5e00000-0000-4000-8000-00000000000a"; // business A, location 1
const PA2 = "a5e00000-0000-4000-8000-00000000000b"; // business A, location 2
const PB1 = "a5e00000-0000-4000-8000-00000000000c"; // business B
const PL = "a5e00000-0000-4000-8000-00000000000d"; // a legacy studio (no legal business)
const EA = "e5e00000-0000-4000-8000-0000000000e1";
const EB = "e5e00000-0000-4000-8000-0000000000e2";
const U = {
  owner_a: "a5e00000-0000-4000-8000-000000000101",
  owner_b: "a5e00000-0000-4000-8000-000000000201",
  padmin: "a5e00000-0000-4000-8000-000000000401",
};
const ACC_A = `AC${"a5".repeat(16)}`;
const ACC_B = `AC${"b5".repeat(16)}`;
const MG_A1 = `MG${"a1".repeat(16)}`;
const MG_A2 = `MG${"a2".repeat(16)}`;
const MG_B1 = `MG${"b1".repeat(16)}`;
const PHONE = "+15125550142";
const RUN = randomBytes(3).toString("hex");

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
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};

const ENTITIES = `'${EA}', '${EB}'`;
const STUDIOS = `'${PA1}', '${PA2}', '${PB1}', '${PL}'`;
const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_usage_attempts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_sender_verifications where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_provisioning_steps where studio_id in (${STUDIOS});
delete from public.studio_sms_approval_refs where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_billed_senders where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_usage_switch_log where changed_by = '${U.padmin}';
delete from public.sms_message_logs where studio_id in (${STUDIOS});
update public.studio_sms_recurring_charges set run_id = null where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_charges where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_authorizations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_monthly_limits where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_timezones where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_limit_ceilings where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_ledger where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_reservations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES}));
delete from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_twilio_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_studios where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_legal_entities where id in (${ENTITIES});
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in (${Object.values(U).map((u) => `'${u}'`).join(", ")});
delete from auth.users where email like '%@tw4usage-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4usage-e2e.test', now(), now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.owner_b}', 'owner_b'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.owner_b}', null), ('${U.padmin}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values
  ('${PA1}', 'TW4USAGE A1', 'tw4usage-a1', null, 'America/Chicago'), ('${PA2}', 'TW4USAGE A2', 'tw4usage-a2', null, 'America/Chicago'),
  ('${PB1}', 'TW4USAGE B1', 'tw4usage-b1', null, 'UTC'), ('${PL}', 'TW4USAGE Legacy', 'tw4usage-legacy', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${U.owner_a}', '${PA1}', 'studio_owner', true), ('${U.owner_b}', '${PB1}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'USG Alpha LLC', '5551', 15000, '${U.padmin}'), ('${EB}', 'USG Beta LLC', '5552', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${PA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 1', now() - interval '2 days'),
  ('${PA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 2', now() - interval '1 day'),
  ('${PB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${EA}', '${ACC_A}', 'df:test:${EA}', 'test', 'active', '${U.padmin}'), ('${EB}', '${ACC_B}', 'df:test:${EB}', 'test', 'active', '${U.padmin}');
commit;`;

describe.skipIf(!enabled)("SMS usage billing: reservations, provider answers, callbacks, evidence, admin resolution (real schema, fake provider)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let snapshotActivePrices: string[] = [];
  let n = 0;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const balance = (e: string) => Number(psql(`select coalesce((select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${e}'), 0)`));
  const reserved = (e: string) => Number(psql(`select coalesce((select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${e}'), 0)`));
  const curKey = (e: string) => psql(`select public._tw4ml_month_key('${e}', now())`);
  const spend = (e: string, key?: string) => Number(psql(`select public._tw4ml_month_spend('${e}', '${key ?? curKey(e)}')`));
  const gaps = () => psql("select public._tw4us_reconciliation_gaps()");
  const attempt = (id: string) => JSON.parse(psql(`select row_to_json(a)::text from public.studio_sms_usage_attempts a where a.id = '${id}'`)) as Record<string, unknown>;
  const sid = () => `SM${randomBytes(16).toString("hex")}`;
  const fund = async (e: string, studio: string, pack: number) => {
    n += 1;
    const ref = `cs_usg_${RUN}_${n}`;
    await credits.topupPending(e, studio, ref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(e, studio, ref, pack, `evt_usg_${RUN}_${n}`, `pi_usg_${RUN}_${n}`, true);
  };
  const resetMoney = (e: string) =>
    aged(`delete from public.studio_sms_usage_attempts where legal_entity_id = '${e}'; delete from public.sms_message_logs where studio_id in (select studio_id from public.studio_sms_entity_studios where legal_entity_id = '${e}');
          delete from public.studio_sms_recurring_charges where legal_entity_id = '${e}'; delete from public.studio_sms_recurring_authorizations where legal_entity_id = '${e}';
          delete from public.studio_sms_credit_ledger where legal_entity_id = '${e}'; delete from public.studio_sms_credit_reservations where legal_entity_id = '${e}';
          delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id = '${e}');
          delete from public.studio_sms_credit_topups where legal_entity_id = '${e}'; delete from public.studio_sms_credit_accounts where legal_entity_id = '${e}'`);
  const setLimit = (e: string, cents: number) => rpc("tw4_monthly_limit_set_admin", { p_entity_id: e, p_actor: U.padmin, p_limit_cents: cents, p_effective_month: null, p_reason: "fixture: monthly texting limit" });
  const senderIds: Record<string, SenderIds> = {};
  const numberFor: Record<string, string> = { [PA1]: "+15125550201", [PA2]: "+15125550202", [PB1]: "+15125550203" };
  const accountFor = (studio: string) => (studio === PB1 ? ACC_B : ACC_A);
  const setSender = async (studio: string, mg: string, status: "approved" | "revoked" = "approved") => {
    if (status === "revoked") return rpc("tw4_sender_revoke", { p_studio_id: studio, p_actor: U.padmin, p_reason: "fixture: revoke the sender", p_release: false });
    const ids = (senderIds[studio] ??= newSenderIds(numberFor[studio], { mg }));
    try {
      await readySender(rpc, (sql) => aged(sql), { studio, account: accountFor(studio), actor: U.padmin, ids });
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: { code: "fixture", message: String(error) } };
    }
  };
  const setSwitch = (on: boolean) => rpc("tw4_usage_set_switch", { p_enabled: on, p_actor: U.padmin, p_reason: `fixture: switch ${on ? "on" : "off"} for tests` });
  /** a fresh business state: money cleared, funded, a limit, senders approved, the switch on */
  const ready = async (e: string, studio: string, opts: { funds?: number; limit?: number } = {}) => {
    resetMoney(e);
    aged(`delete from public.studio_sms_monthly_limits where legal_entity_id = '${e}'`);
    if (opts.funds !== 0) await fund(e, studio, opts.funds ?? 5_000);
    expect((await setLimit(e, opts.limit ?? 10_000)).error).toBeNull();
    expect((await setSwitch(true)).error).toBeNull();
  };
  const begin = (studio: string, body = "Your lesson is tomorrow at 6pm. Reply STOP to opt out.", over: Record<string, unknown> = {}) =>
    rpc("tw4_usage_begin", {
      p_source_kind: "manual", p_source_id: randomUUID(), p_studio_id: studio, p_client_id: null, p_phone_e164: PHONE, p_body: body,
      p_message_type: "manual", p_related_table: null, p_related_id: null, p_sent_by: null, ...over,
    });
  const begun = async (studio: string, body?: string, over: Record<string, unknown> = {}) => {
    const r = await begin(studio, body, over);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return r.data as { attempt_id: string; message_log_id: string; amount_cents: number; segments: number; account_sid: string; messaging_service_sid: string; decision: string };
  };
  /** begin + marker + accepted SID */
  const submitted = async (studio: string, body?: string) => {
    const b = await begun(studio, body);
    expect((await rpc("tw4_usage_dispatching", { p_attempt_id: b.attempt_id })).data).toMatchObject({ dispatch: true });
    const s = sid();
    expect((await rpc("tw4_usage_submitted", { p_attempt_id: b.attempt_id, p_provider_sid: s })).error).toBeNull();
    return { ...b, sid: s };
  };
  // 20261205: settlement also checks the evidence's identity and time, so the fixture evidence carries what Twilio's Message resource would for this text
  const identity = (s: string) => {
    const row = psql(`select coalesce(a.messaging_service_sid, '') || '|' || coalesce(a.sender_e164, '') || '|' || coalesce(l.phone_e164, '') from public.studio_sms_usage_attempts a
                       join public.sms_message_logs l on l.id = a.message_log_id where a.provider_sid = '${s}'`);
    const [mg, from, to] = row ? row.split("|") : ["", "", ""];
    return { direction: "outbound-api", messaging_service_sid: mg || null, from: from || null, to: to || null, date_created: new Date().toISOString() };
  };
  const evidence = (account: string, s: string, over: Record<string, unknown> = {}) => ({ sid: s, account_sid: account, status: "delivered", num_segments: "1", num_media: "0", price: "-0.00790", price_unit: "USD", ...identity(s), ...over });
  const settle = (attemptId: string, ev: Record<string, unknown>) => rpc("tw4_usage_settle", { p_attempt_id: attemptId, p_evidence: ev });
  const callback = (attemptId: string | null, s: string, signer: string | null, status: string) =>
    rpc("tw4_usage_record_callback", { p_attempt_id: attemptId, p_provider_sid: s, p_signer_account: signer, p_status: status, p_error_code: null });
  const price = () => Number(psql("select customer_price_cents from public.studio_sms_price_list where kind = 'sms_usage' and active"));

  beforeAll(async () => {
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
    psqlFile(LOCAL_QA_MARKER);
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    for (const [kind, cents] of [["sms_usage", 3], ["monthly", 1500]] as const) {
      expect((await rpc("tw4_price_set", { p_kind: kind, p_customer_cents: cents, p_provider_cents: 1, p_description: `fixture ${kind} price`, p_actor: U.padmin })).error).toBeNull();
    }
    expect((await setSender(PA1, MG_A1)).error).toBeNull();
    expect((await setSender(PA2, MG_A2)).error).toBeNull();
    expect((await setSender(PB1, MG_B1)).error).toBeNull();
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
      aged(`delete from public.studio_sms_price_list where created_by = '${U.padmin}'; update public.studio_sms_price_list set active = true where id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
  });

  it("privileges: the tables are unreachable by API roles; every action is service-role only; the helpers are callable by no API role", () => {
    for (const table of ["studio_sms_usage_attempts", "studio_sms_billed_senders", "studio_sms_usage_switch_log"]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete')`), `${role} ${table}`).toBe("f");
    }
    for (const fn of [
      "tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid)", "tw4_usage_dispatching(uuid)", "tw4_usage_submitted(uuid, text)", "tw4_usage_rejected(uuid, text)",
      "tw4_usage_uncertain(uuid, text)", "tw4_usage_record_callback(uuid, text, text, text, text)", "tw4_usage_settle(uuid, jsonb)", "tw4_usage_release_unsent()",
      "tw4_usage_resolve(uuid, uuid, text, int, text)", "tw4_usage_due(int)", "tw4_usage_set_switch(boolean, uuid, text)",
      "tw4_usage_studio_mode(uuid)", "sms_usage_admin_overview(uuid)",
    ]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    for (const fn of ["_tw4us_segments(text)", "_tw4us_lock_attempt(uuid)", "_tw4us_charge(public.studio_sms_usage_attempts, int, text)", "_tw4us_reconciliation_gaps()", "_tw4us_switch_on()"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("f");
    }
    expect(psqlError("update public.studio_sms_usage_attempts set state = 'settled'")).toBe(""); // no rows yet: nothing to refuse
    expect(psqlError("truncate public.studio_sms_usage_attempts")).toMatch(/never truncated|cannot truncate a table referenced/); // 20261205: the transition history references it
    // 20261204: the old unverified setter is no longer callable by anyone
    expect(psql("select has_function_privilege('service_role', 'public.tw4_usage_billed_sender_set(uuid, uuid, text, text, text, text)', 'execute')")).toBe("f");
  });

  it("the database counts segments exactly like the app's estimator", () => {
    const bodies = ["hello", "a".repeat(160), "a".repeat(161), "a".repeat(306), "a".repeat(307), `${"a".repeat(158)}€`, `${"a".repeat(159)}€`, "héllo ✓", "😀".repeat(35), "😀".repeat(36),
      "line\nbreak\r\n", `${"x".repeat(150)}{}[]~|^\\`, "Ç and ç", "é".repeat(200), "Привет".repeat(20)];
    for (const body of bodies) {
      const sql = psql(`select public._tw4us_segments(convert_from(decode('${Buffer.from(body, "utf8").toString("base64")}', 'base64'), 'UTF8'))`);
      expect(Number(sql), JSON.stringify(body.slice(0, 20))).toBe(estimateBilledSegments(body).segments);
    }
  });

  describe("begin: everything is checked, in the database, before any provider call", () => {
    it("reserves segments x the price, writes the log row, counts toward the month, and a retry of the same source is a replay", async () => {
      await ready(EA, PA1);
      const before = balance(EA);
      const body = "a".repeat(200); // 2 segments
      const source = randomUUID();
      const b = await begun(PA1, body, { p_source_id: source });
      expect(b).toMatchObject({ decision: "send", segments: 2, amount_cents: 2 * price(), account_sid: ACC_A, messaging_service_sid: MG_A1 });
      expect(reserved(EA)).toBe(2 * price());
      expect(balance(EA)).toBe(before);
      expect(spend(EA)).toBe(2 * price());
      expect(psql(`select studio_id || ':' || status || ':' || segment_count || ':' || phone_e164 from public.sms_message_logs where id = '${b.message_log_id}'`)).toBe(`${PA1}:queued:2:${PHONE}`);
      expect(psql(`select count(*) from public.studio_sms_credit_reservations where reservation_key = 'sms:${b.attempt_id}' and funding = 'credit' and kind = 'sms_usage'`)).toBe("1");
      const again = await begin(PA1, body, { p_source_id: source });
      expect(again.data).toMatchObject({ decision: "replay", attempt_id: b.attempt_id, message_log_id: b.message_log_id, state: "reserved" });
      expect(reserved(EA)).toBe(2 * price());
      expect(psql(`select count(*) from public.sms_message_logs where studio_id = '${PA1}'`)).toBe("1");
      expect((await begin(PA2, body, { p_source_id: source })).error?.code).toBe("42501"); // another studio cannot claim this source
      expect(gaps()).toBe("0");
    });

    it("refuses: switch off, unlinked studio, non-NANP number, empty or long body, foreign client, no or revoked sender, inactive subaccount, no price", async () => {
      await ready(EA, PA1);
      expect((await setSwitch(false)).error).toBeNull();
      expect((await begin(PA1)).error?.code).toBe("TW018");
      expect((await setSwitch(true)).error).toBeNull();
      expect((await begin(PL)).error?.code).toBe("TW010");
      for (const phone of ["+447700900123", "+15125550", "5125550142", "+11125550142"]) expect((await begin(PA1, undefined, { p_phone_e164: phone })).error?.code, phone).toBe("22023");
      for (const body of ["", "   ", "a".repeat(1601), "😀".repeat(400)]) expect((await begin(PA1, body)).error?.code).toBe("22023");
      expect((await begin(PA1, undefined, { p_client_id: randomUUID() })).error?.code).toBe("42501");
      expect((await setSender(PA2, MG_A2, "revoked")).error).toBeNull();
      expect((await begin(PA2)).error?.code).toBe("TW015");
      expect((await setSender(PA2, MG_A2)).error).toBeNull();
      aged(`update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = '${EA}'`);
      expect((await begin(PA1)).error?.code).toBe("TW015");
      aged(`update public.studio_sms_twilio_accounts set status = 'active' where legal_entity_id = '${EA}'`);
      // a sender recorded for another subaccount (the business's account was replaced) is not usable
      aged(`update public.studio_sms_twilio_accounts set twilio_account_sid = 'AC${"ff".repeat(16)}' where legal_entity_id = '${EA}'`);
      expect((await begin(PA1)).error?.code).toBe("TW015");
      aged(`update public.studio_sms_twilio_accounts set twilio_account_sid = '${ACC_A}' where legal_entity_id = '${EA}'`);
      const active = psql("select id from public.studio_sms_price_list where kind = 'sms_usage' and active");
      aged(`update public.studio_sms_price_list set active = false where id = '${active}'`);
      expect((await begin(PA1)).error?.code).toBe("TW008");
      aged(`update public.studio_sms_price_list set active = true where id = '${active}'`);
      expect(reserved(EA)).toBe(0); // nothing was reserved by any refusal
      expect(psql(`select count(*) from public.sms_message_logs where studio_id in ('${PA1}', '${PA2}')`)).toBe("0");
    });

    it("fails closed on credit and on the monthly limit: no funds, hold, negative balance, no limit, the limit reached, the platform ceiling", async () => {
      await ready(EA, PA1, { funds: 0 });
      expect((await begin(PA1)).error?.code).toBe("TW007");
      await fund(EA, PA1, 2_500);
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: hold for usage", p_actor: U.padmin });
      expect((await begin(PA1)).error?.code).toBe("TW007");
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: false, p_reason: "fixture release", p_actor: U.padmin });
      await credits.adjust(EA, -(balance(EA) + 1), `usg-neg-${RUN}`, "fixture: negative balance", U.padmin);
      expect((await begin(PA1)).error?.code).toBe("TW007");
      await ready(EA, PA1, { limit: 0 });
      expect((await begin(PA1)).error?.code).toBe("TW012"); // no limit configured = nothing may be spent
      await ready(EA, PA1, { limit: 2 * price() });
      await begun(PA1);
      await begun(PA1);
      expect((await begin(PA1)).error?.code).toBe("TW012"); // two open reservations already fill the month
      await ready(EA, PA1, { limit: 50_000 });
      expect((await rpc("tw4_limit_ceiling_approve_entity", { p_entity_id: EA, p_actor: U.padmin, p_cents: price(), p_approval_ref: "fixture: a tiny ceiling for this test" })).error).toBeNull();
      await begun(PA1);
      expect((await begin(PA1)).error?.code).toBe("TW012"); // the platform ceiling bounds the configured limit
      aged(`delete from public.studio_sms_limit_ceilings where legal_entity_id = '${EA}'`);
    });

    it("a business suspended for an uncovered monthly charge cannot start a text; inbound handling never consults billing", async () => {
      await ready(EA, PA1);
      const auth = await rpc("tw4_recurring_authorize", { p_studio_id: PA1, p_user_id: U.owner_a, p_kind: "monthly", p_acknowledged_price_cents: 1500, p_term_months: 3, p_total_limit_cents: 4500 });
      expect(auth.error, JSON.stringify(auth.error)).toBeNull();
      const id = (auth.data as { authorization_id: string }).authorization_id;
      psql(`select public._tw4rc_release_commitment('${id}')`);
      aged(`update public.studio_sms_recurring_authorizations set starts_at = date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' - interval '1 month' + interval '1 day' where id = '${id}'`);
      expect(String((await rpc("tw4_recurring_service_state", { p_studio_id: PA1 })).data)).toBe("suspended");
      expect((await begin(PA1)).error?.code).toBe("TW016");
      expect((await begin(PB1)).error?.code).not.toBe("TW016"); // another business is unaffected
      const inbound = readFileSync(join(process.cwd(), "src/app/api/sms/twilio/inbound/route.ts"), "utf8");
      expect(inbound).not.toMatch(/tw4_usage|usageBilling|resolveStudioSmsSender\(/);
      resetMoney(EA);
    });
  });

  describe("provider answers", () => {
    it("the dispatch marker comes first and only once; an attempt that never got it is released by the reconciler after 10 minutes, and can then never be sent", async () => {
      await ready(EA, PA1);
      const a = await begun(PA1);
      const b = await begun(PA1);
      expect((await rpc("tw4_usage_dispatching", { p_attempt_id: a.attempt_id })).data).toMatchObject({ dispatch: true });
      expect((await rpc("tw4_usage_dispatching", { p_attempt_id: a.attempt_id })).data).toMatchObject({ dispatch: false, state: "submitting" });
      aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '11 minutes' where id in ('${a.attempt_id}', '${b.attempt_id}')`);
      expect((await rpc("tw4_usage_release_unsent")).data).toMatchObject({ released: 1 }); // only the never-dispatched one
      expect(attempt(b.attempt_id).state).toBe("released");
      expect(attempt(a.attempt_id).state).toBe("submitting"); // a dispatched attempt is NEVER released automatically
      expect((await rpc("tw4_usage_dispatching", { p_attempt_id: b.attempt_id })).data).toMatchObject({ dispatch: false, state: "released" });
      expect(reserved(EA)).toBe(a.amount_cents);
      expect(gaps()).toBe("0");
    });

    it("a definite refusal releases; an uncertain answer keeps the reservation; a later SID still binds; refusing after a SID is impossible", async () => {
      await ready(EA, PA1);
      const r = await begun(PA1);
      await rpc("tw4_usage_dispatching", { p_attempt_id: r.attempt_id });
      expect((await rpc("tw4_usage_rejected", { p_attempt_id: r.attempt_id, p_error_code: "21211" })).data).toMatchObject({ state: "released", replayed: false });
      expect((await rpc("tw4_usage_rejected", { p_attempt_id: r.attempt_id, p_error_code: "21211" })).data).toMatchObject({ replayed: true });
      expect(psql(`select status || ':' || provider_error_code from public.sms_message_logs where id = '${r.message_log_id}'`)).toBe("failed:21211");
      const u = await begun(PA1);
      await rpc("tw4_usage_dispatching", { p_attempt_id: u.attempt_id });
      expect((await rpc("tw4_usage_uncertain", { p_attempt_id: u.attempt_id, p_error_code: "timeout" })).data).toMatchObject({ state: "unknown" });
      expect(reserved(EA)).toBe(u.amount_cents);
      const s = sid();
      expect((await rpc("tw4_usage_submitted", { p_attempt_id: u.attempt_id, p_provider_sid: s })).data).toMatchObject({ state: "submitted" });
      expect(psql(`select provider_message_id from public.sms_message_logs where id = '${u.message_log_id}'`)).toBe(s);
      expect((await rpc("tw4_usage_rejected", { p_attempt_id: u.attempt_id, p_error_code: "21211" })).error?.code).toBe("22023");
      expect((await rpc("tw4_usage_submitted", { p_attempt_id: u.attempt_id, p_provider_sid: s })).data).toMatchObject({ replayed: true });
      expect((await rpc("tw4_usage_submitted", { p_attempt_id: u.attempt_id, p_provider_sid: sid() })).error?.code).toBe("23505");
      const other = await begun(PA1);
      await rpc("tw4_usage_dispatching", { p_attempt_id: other.attempt_id });
      expect((await rpc("tw4_usage_submitted", { p_attempt_id: other.attempt_id, p_provider_sid: s })).error?.code).toBe("23505"); // one SID, one attempt
      expect(gaps()).toBe("0");
    });
  });

  describe("signed delivery callbacks never move money", () => {
    it("only the attempt's own subaccount may report on it; parent-signed or other-business callbacks are refused; status is monotonic; a callback binds a lost SID", async () => {
      await ready(EA, PA1);
      const m = await submitted(PA1);
      const before = [balance(EA), reserved(EA)];
      expect((await callback(m.attempt_id, m.sid, null, "delivered")).error?.code).toBe("42501"); // parent-signed
      expect((await callback(m.attempt_id, m.sid, ACC_B, "delivered")).error?.code).toBe("42501"); // another business's subaccount
      expect((await callback(null, m.sid, ACC_B, "delivered")).error?.code).toBe("42501");
      expect((await callback(m.attempt_id, sid(), ACC_A, "delivered")).error?.code).toBe("42501"); // the attempt is bound to another message
      expect((await callback(m.attempt_id, m.sid, ACC_A, "delivered")).data).toMatchObject({ billed: true, needs_reconcile: true });
      expect((await callback(m.attempt_id, m.sid, ACC_A, "sent")).error).toBeNull(); // late and lower: ignored
      expect((await callback(m.attempt_id, m.sid, ACC_A, "delivered")).error).toBeNull(); // duplicate
      expect(attempt(m.attempt_id)).toMatchObject({ callback_status: "delivered", state: "submitted" });
      expect([balance(EA), reserved(EA)]).toEqual(before);
      expect((await callback(null, sid(), ACC_A, "delivered")).data).toMatchObject({ billed: false }); // not a billed text: the legacy path handles it
      // the send's own record of the SID was lost (uncertain): the signed callback, carrying the attempt id, binds it
      const u = await begun(PA1);
      await rpc("tw4_usage_dispatching", { p_attempt_id: u.attempt_id });
      await rpc("tw4_usage_uncertain", { p_attempt_id: u.attempt_id, p_error_code: "timeout" });
      const s = sid();
      expect((await callback(u.attempt_id, s, ACC_A, "sent")).data).toMatchObject({ billed: true });
      expect(attempt(u.attempt_id)).toMatchObject({ state: "submitted", provider_sid: s });
      expect(psql(`select provider_message_id from public.sms_message_logs where id = '${u.message_log_id}'`)).toBe(s);
      expect((await callback(m.attempt_id, s, ACC_A, "sent")).error?.code).toBe("42501"); // that SID is another attempt's
      const r = await begun(PA1); // never dispatched
      expect((await callback(r.attempt_id, sid(), ACC_A, "sent")).error?.code).toBe("22023");
      expect((await callback(randomUUID(), sid(), ACC_A, "sent")).error?.code).toBe("42501");
    });
  });

  describe("settlement from provider evidence", () => {
    it("charges the provider's segment count at the frozen price, releases the reservation, counts once, reconciles, and replays", async () => {
      await ready(EA, PA1);
      const m = await submitted(PA1, "a".repeat(200));
      const before = balance(EA);
      const frozen = price();
      expect((await rpc("tw4_price_set", { p_kind: "sms_usage", p_customer_cents: 9, p_provider_cents: 1, p_description: "fixture: a new price", p_actor: U.padmin })).error).toBeNull();
      const s = await settle(m.attempt_id, evidence(ACC_A, m.sid, { num_segments: "3" })); // more than estimated (2), within +2
      expect(s.data).toMatchObject({ outcome: "settled", charged_cents: 3 * frozen, replayed: false });
      expect(balance(EA)).toBe(before - 3 * frozen);
      expect(reserved(EA)).toBe(0);
      expect(spend(EA)).toBe(3 * frozen);
      expect(attempt(m.attempt_id)).toMatchObject({ state: "settled", charged_cents: 3 * frozen, evidence_segments: 3, evidence_price_unit: "USD" });
      expect(Number(attempt(m.attempt_id).evidence_price_micros)).toBe(7900);
      expect(psql(`select status || ':' || segment_count from public.sms_message_logs where id = '${m.message_log_id}'`)).toBe("delivered:3");
      expect((await settle(m.attempt_id, evidence(ACC_A, m.sid, { num_segments: "1" }))).data).toMatchObject({ replayed: true, charged_cents: 3 * frozen });
      expect(balance(EA)).toBe(before - 3 * frozen);
      expect(gaps()).toBe("0");
      expect((await credits.verify(EA)).ok).toBe(true);
      await rpc("tw4_price_set", { p_kind: "sms_usage", p_customer_cents: 3, p_provider_cents: 1, p_description: "fixture sms_usage price", p_actor: U.padmin });
    });

    it("the status table: failed and canceled release without charge; undelivered and read charge; sent waits 72 hours; queued waits; odd evidence goes to review", async () => {
      await ready(EA, PA1);
      const cases: [Record<string, unknown>, string, number | null][] = [
        [{ status: "failed", price: null, num_segments: "1" }, "settled", 0],
        [{ status: "failed", price: "-0.00100" }, "settled", 0], // a provider fee is DanceFlow's cost, never the studio's
        [{ status: "canceled" }, "settled", 0],
        [{ status: "undelivered" }, "settled", price()],
        [{ status: "read" }, "settled", price()],
        [{ status: "sent" }, "pending", null],
        [{ status: "queued", price: null }, "pending", null],
        [{ status: "delivered", num_media: "1" }, "review", null],
        [{ status: "delivered", price_unit: "EUR" }, "review", null],
        [{ status: "delivered", num_segments: "0" }, "review", null],
        [{ status: "delivered", num_segments: "4" }, "review", null], // estimate 1 + 2 < 4
        [{ status: "delivered", num_segments: null }, "review", null],
        [{ status: "partially_delivered" }, "review", null],
      ];
      for (const [over, outcome, charged] of cases) {
        const m = await submitted(PA1);
        const r = await settle(m.attempt_id, evidence(ACC_A, m.sid, over));
        expect(r.data, JSON.stringify(over)).toMatchObject({ outcome });
        if (charged !== null) expect(attempt(m.attempt_id).charged_cents, JSON.stringify(over)).toBe(charged);
        if (outcome === "review") expect(reserved(EA)).toBeGreaterThan(0); // the reservation is kept for an admin
      }
      // 'sent' with no receipt for 72 hours is charged
      const old = await submitted(PA1);
      aged(`update public.studio_sms_usage_attempts set submitted_at = now() - interval '73 hours', submitting_at = now() - interval '73 hours', created_at = now() - interval '73 hours' where id = '${old.attempt_id}'`);
      expect((await settle(old.attempt_id, evidence(ACC_A, old.sid, { status: "sent", date_created: new Date(Date.now() - 73 * 3_600_000).toISOString() }))).data).toMatchObject({ outcome: "settled", charged_cents: price() });
      // an MM SID is a multimedia message: review
      const mm = await begun(PA1);
      await rpc("tw4_usage_dispatching", { p_attempt_id: mm.attempt_id });
      const mmSid = `MM${randomBytes(16).toString("hex")}`;
      await rpc("tw4_usage_submitted", { p_attempt_id: mm.attempt_id, p_provider_sid: mmSid });
      expect((await settle(mm.attempt_id, evidence(ACC_A, mmSid))).data).toMatchObject({ outcome: "review" });
      expect(gaps()).toBe("0");
    });

    it("evidence for another message or account is refused; only a submitted text is settled", async () => {
      await ready(EA, PA1);
      const m = await submitted(PA1);
      expect((await settle(m.attempt_id, evidence(ACC_B, m.sid))).error?.code).toBe("42501");
      expect((await settle(m.attempt_id, evidence(ACC_A, sid()))).error?.code).toBe("42501");
      const r = await begun(PA1);
      expect((await settle(r.attempt_id, evidence(ACC_A, sid()))).error?.code).toBe("22023");
      expect(attempt(m.attempt_id).state).toBe("submitted");
    });

    it("the reconciler (fake provider) releases never-sent attempts, settles from evidence, leaves pending ones, and counts", async () => {
      await ready(EA, PA1);
      const provider = new FakeBilledSmsProvider();
      const done = await submitted(PA1);
      const waiting = await submitted(PA1);
      const broken = await submitted(PA1);
      const never = await begun(PA1);
      aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '11 minutes' where id = '${never.attempt_id}'`);
      provider.setEvidence(done.sid, evidence(ACC_A, done.sid) as never);
      provider.setEvidence(waiting.sid, evidence(ACC_A, waiting.sid, { status: "sending" }) as never);
      provider.failFetch(broken.sid);
      const summary = await reconcileSmsUsage(admin as never, provider);
      expect(summary).toMatchObject({ releasedUnsent: 1, settled: 1, chargedCents: price(), pending: 1, errors: 1 });
      expect(attempt(done.attempt_id).state).toBe("settled");
      expect(attempt(waiting.attempt_id).state).toBe("submitted");
      expect(attempt(never.attempt_id).state).toBe("released");
      // the pending one is not read again within 10 minutes
      expect((await reconcileSmsUsage(admin as never, provider)).due).toBe(0); // the pending one was read and the broken one stamped: neither is read again within 10 minutes
      expect(gaps()).toBe("0");
    });
  });

  describe("admin resolution of what evidence cannot settle", () => {
    it("platform admin only, with a reason, never within 15 minutes; a text that went out after an admin released it is still charged once", async () => {
      await ready(EA, PA1);
      const u = await begun(PA1);
      await rpc("tw4_usage_dispatching", { p_attempt_id: u.attempt_id });
      await rpc("tw4_usage_uncertain", { p_attempt_id: u.attempt_id, p_error_code: "http_503" });
      const resolve = (outcome: string, actor = U.padmin, segments: number | null = null, reason = "checked the provider console: nothing went out") =>
        rpc("tw4_usage_resolve", { p_attempt_id: u.attempt_id, p_actor: actor, p_outcome: outcome, p_segments: segments, p_reason: reason });
      expect((await resolve("released", U.owner_a)).error?.code).toBe("42501");
      expect((await resolve("released", U.padmin, null, "short")).error?.code).toBe("22023");
      expect((await resolve("released")).error?.code).toBe("22023"); // too early
      aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '16 minutes', submitting_at = now() - interval '16 minutes' where id = '${u.attempt_id}'`);
      expect((await resolve("released")).data).toMatchObject({ state: "released" });
      expect(reserved(EA)).toBe(0);
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where action = 'usage_resolved' and note like '%${u.attempt_id}%'`)).toBe("1");
      expect((await rpc("tw4_credit_resolve_reservation", { p_reservation_id: attempt(u.attempt_id).reservation_id, p_outcome: "captured", p_actor: U.padmin, p_note: "fixture: generic tool" })).error?.code).toBe("22023");
      // ...but the message had gone out after all: the late SID is recorded and charged from evidence, without a reservation
      const s = sid();
      expect((await rpc("tw4_usage_submitted", { p_attempt_id: u.attempt_id, p_provider_sid: s })).data).toMatchObject({ state: "submitted" });
      expect(gaps()).toBe("0");
      const before = balance(EA);
      expect((await settle(u.attempt_id, evidence(ACC_A, s))).data).toMatchObject({ outcome: "settled", charged_cents: price() });
      expect(balance(EA)).toBe(before - price());
      expect(reserved(EA)).toBe(0);
      expect(gaps()).toBe("0");
      // a charge resolution for a review case; a text with a SID cannot be released
      const m = await submitted(PA1);
      await settle(m.attempt_id, evidence(ACC_A, m.sid, { num_media: "2" }));
      aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '16 minutes', submitting_at = now() - interval '16 minutes' where id = '${m.attempt_id}'`);
      expect((await rpc("tw4_usage_resolve", { p_attempt_id: m.attempt_id, p_actor: U.padmin, p_outcome: "released", p_segments: null, p_reason: "fixture: release a sent text" })).error?.code).toBe("22023");
      expect((await rpc("tw4_usage_resolve", { p_attempt_id: m.attempt_id, p_actor: U.padmin, p_outcome: "charged", p_segments: 2, p_reason: "fixture: charged after review" })).data).toMatchObject({ state: "settled", charged_cents: 2 * price() });
      expect(gaps()).toBe("0");
      expect((await rpc("sms_usage_admin_overview", { p_actor: U.padmin })).data).toMatchObject({ switch_on: true, reconciliation_gaps: 0 });
      expect((await rpc("sms_usage_admin_overview", { p_actor: U.owner_a })).error?.code).toBe("42501");
    });
  });

  describe("concurrency, months and tenants", () => {
    it("twelve simultaneous texts against credit for five: exactly five reserve; simultaneous retries of one source send once; simultaneous settlements charge once", async () => {
      await ready(EA, PA1, { funds: 2_500 });
      await credits.adjust(EA, -(balance(EA) - 5 * price()), `usg-five-${RUN}`, "fixture: credit for five texts", U.padmin);
      const results = await Promise.all(Array.from({ length: 12 }, () => begin(PA1)));
      expect(results.filter((r) => !r.error)).toHaveLength(5);
      expect(results.filter((r) => r.error?.code === "TW007")).toHaveLength(7);
      expect(reserved(EA)).toBe(5 * price());
      await ready(EA, PA1);
      const source = randomUUID();
      const same = await Promise.all(Array.from({ length: 8 }, () => begin(PA1, undefined, { p_source_id: source })));
      expect(same.filter((r) => (r.data as { decision?: string })?.decision === "send")).toHaveLength(1);
      expect(same.filter((r) => (r.data as { decision?: string })?.decision === "replay")).toHaveLength(7);
      const id = (same.find((r) => (r.data as { decision?: string })?.decision === "send")!.data as { attempt_id: string }).attempt_id;
      const marks = await Promise.all(Array.from({ length: 6 }, () => rpc("tw4_usage_dispatching", { p_attempt_id: id })));
      expect(marks.filter((r) => (r.data as { dispatch?: boolean })?.dispatch === true)).toHaveLength(1); // only one caller may call the provider
      const s = sid();
      await rpc("tw4_usage_submitted", { p_attempt_id: id, p_provider_sid: s });
      const before = balance(EA);
      const settles = await Promise.all(Array.from({ length: 6 }, () => settle(id, evidence(ACC_A, s))));
      expect(settles.every((r) => !r.error)).toBe(true);
      expect(settles.filter((r) => (r.data as { replayed?: boolean }).replayed === false)).toHaveLength(1);
      expect(balance(EA)).toBe(before - price());
      expect(gaps()).toBe("0");
      expect((await credits.verify(EA)).ok).toBe(true);
    });

    it("a text reserved in one month and settled in the next counts once, in the month it was sent", async () => {
      await ready(EA, PA1);
      const m = await submitted(PA1);
      const prev = psql(`select public._tw4ml_key_add('${curKey(EA)}', -1)`);
      const mid = psql(`select to_char(public._tw4ml_month_start('${EA}', '${prev}') + interval '20 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
      aged(`update public.studio_sms_credit_reservations set created_at = '${mid}' where id = '${attempt(m.attempt_id).reservation_id}'`);
      expect(spend(EA, prev)).toBe(price());
      expect(spend(EA)).toBe(0);
      expect((await settle(m.attempt_id, evidence(ACC_A, m.sid, { num_segments: "2" }))).data).toMatchObject({ outcome: "settled" });
      expect(spend(EA, prev)).toBe(2 * price()); // the actual charge, in the sending month
      expect(spend(EA)).toBe(0);
    });

    it("each business is billed on its own subaccount and credit; one business's callback or evidence can never touch another's text", async () => {
      await ready(EA, PA1);
      await ready(EB, PB1);
      const a = await submitted(PA2); // location 2 of business A: business A's account and credit
      const b = await submitted(PB1);
      expect(a.account_sid).toBe(ACC_A);
      expect(a.messaging_service_sid).toBe(MG_A2);
      expect(b.account_sid).toBe(ACC_B);
      expect(reserved(EA)).toBe(price());
      expect(reserved(EB)).toBe(price());
      expect((await callback(a.attempt_id, a.sid, ACC_B, "delivered")).error?.code).toBe("42501");
      expect((await settle(a.attempt_id, evidence(ACC_B, a.sid))).error?.code).toBe("42501");
      expect((await settle(b.attempt_id, evidence(ACC_B, b.sid))).data).toMatchObject({ outcome: "settled" });
      expect(balance(EA)).toBe(5_000);
      expect(reserved(EA)).toBe(price());
    });

    it("the pilot business's texts are paid from credit under its monthly limit; the $150 pilot ceiling is never used", () => {
      const out = execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], {
        input: `begin; set local session_replication_role = replica; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${EB}', 15000, 'fixture approval reference text', '${U.padmin}'); reset session_replication_role;
                select (public.tw4_usage_begin('manual', gen_random_uuid(), '${PB1}', null, '${PHONE}', 'pilot text', 'manual', null, null, null))->>'decision';
                select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EB}' and funding = 'pilot';
                select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EB}' and reservation_key like 'sms:%' and funding = 'credit' and status = 'reserved';
                rollback;`,
        encoding: "utf8",
      });
      const lines = out.split("\n").filter((l) => /^[0-9a-z]+$/.test(l));
      expect(lines.slice(-3)).toEqual(["send", "0", "1"]); // this text's reservation is credit-funded; no pilot reservation exists
    });
  });

  it("the app path: sendBilledSms with the fake provider (accepted, refused, uncertain, replay) and the attempt id in the status callback", async () => {
    await ready(EA, PA1);
    const provider = new FakeBilledSmsProvider();
    const input = (source = randomUUID()) => ({
      source: { kind: "manual" as const, id: source }, studioId: PA1, clientId: null, phoneE164: PHONE, body: "Hello from the studio. Reply STOP to opt out.",
      messageType: "manual", relatedTable: null, relatedId: null, sentBy: null, statusCallbackBase: "https://example.test/api/sms/twilio/status?secret=s",
    });
    const sourceA = randomUUID();
    const sent = await sendBilledSms(admin as never, provider, input(sourceA));
    expect(sent).toMatchObject({ outcome: "sent" });
    expect(provider.sent.at(-1)).toMatchObject({ accountSid: ACC_A, messagingServiceSid: MG_A1, to: PHONE });
    expect(String(provider.sent.at(-1)?.statusCallbackUrl)).toMatch(/[?&]attempt=[0-9a-f-]{36}/);
    expect(await sendBilledSms(admin as never, provider, input(sourceA))).toMatchObject({ outcome: "replay", state: "submitted" });
    expect(provider.sent).toHaveLength(1); // the retry never reached the provider
    provider.nextSend({ kind: "refused", code: "21610" });
    expect(await sendBilledSms(admin as never, provider, input())).toMatchObject({ outcome: "rejected", code: "21610" });
    provider.nextSend({ kind: "uncertain", code: "timeout" });
    const unsure = await sendBilledSms(admin as never, provider, input());
    expect(unsure).toMatchObject({ outcome: "uncertain" });
    expect(reserved(EA)).toBe(2 * price()); // the sent one and the uncertain one; the refused one was released
    expect(await sendBilledSms(admin as never, provider, { ...input(), studioId: PL })).toMatchObject({ outcome: "refused", reason: "not_billed" });
    expect(gaps()).toBe("0");
  });

  describe("review findings: final states, late messages, the review exit, the queue, replays, guards", () => {
    it("an attempt's money and identity change only through the usage functions, and a settled attempt is final", async () => {
      await ready(EA, PA1);
      const m = await submitted(PA1);
      expect(psqlError(`update public.studio_sms_usage_attempts set state = 'released' where id = '${m.attempt_id}'`)).toContain("only through the usage functions");
      expect(psqlError(`begin; select set_config('tw4.usage_write', 'on', true); update public.studio_sms_usage_attempts set reserved_cents = 1 where id = '${m.attempt_id}'; commit;`)).toContain("final");
      expect(psqlError(`begin; select set_config('tw4.usage_write', 'on', true); update public.studio_sms_usage_attempts set messaging_service_sid = '${MG_B1}' where id = '${m.attempt_id}'; commit;`)).toContain("final");
      expect(psqlError(`delete from public.studio_sms_usage_attempts where id = '${m.attempt_id}'`)).toContain("never deleted");
      await settle(m.attempt_id, evidence(ACC_A, m.sid));
      expect(psqlError(`begin; select set_config('tw4.usage_write', 'on', true); update public.studio_sms_usage_attempts set callback_status = 'x' where id = '${m.attempt_id}'; commit;`)).toContain("final");
      expect(psqlError(`select public.tw4_credit_debit_usage('${EA}', '${PA1}', 5, 'sms:${m.attempt_id}', 'fixture')`)).toContain("billed texts"); // the direct debit cannot use the text key namespace
    });

    it("a callback after settlement is acknowledged and changes nothing (no 403)", async () => {
      await ready(EA, PA1);
      const m = await submitted(PA1);
      await settle(m.attempt_id, evidence(ACC_A, m.sid));
      const before = attempt(m.attempt_id);
      expect((await callback(m.attempt_id, m.sid, ACC_A, "read")).data).toMatchObject({ billed: true, needs_reconcile: false });
      expect((await callback(null, m.sid, ACC_A, "delivered")).error).toBeNull();
      expect(attempt(m.attempt_id)).toEqual(before);
      expect((await callback(m.attempt_id, m.sid, ACC_B, "read")).error?.code).toBe("42501"); // still only its own subaccount
    });

    it("failed and canceled texts are released even when multimedia or priced abroad; a review attempt can be closed without a charge", async () => {
      await ready(EA, PA1);
      const mm = await begun(PA1);
      await rpc("tw4_usage_dispatching", { p_attempt_id: mm.attempt_id });
      const mmSid = `MM${randomBytes(16).toString("hex")}`;
      await rpc("tw4_usage_submitted", { p_attempt_id: mm.attempt_id, p_provider_sid: mmSid });
      expect((await settle(mm.attempt_id, evidence(ACC_A, mmSid, { status: "failed", num_media: "1", price_unit: "EUR" }))).data).toMatchObject({ outcome: "settled", charged_cents: 0 });
      const r = await submitted(PA1);
      expect((await settle(r.attempt_id, evidence(ACC_A, r.sid, { num_media: "1" }))).data).toMatchObject({ outcome: "review" });
      aged(`update public.studio_sms_usage_attempts set submitting_at = now() - interval '16 minutes', created_at = now() - interval '16 minutes' where id = '${r.attempt_id}'`);
      const close = (outcome: string) => rpc("tw4_usage_resolve", { p_attempt_id: r.attempt_id, p_actor: U.padmin, p_outcome: outcome, p_segments: null, p_reason: "fixture: multimedia conversion was on, not billable" });
      expect((await close("released")).error?.code).toBe("22023"); // it reached the provider
      expect((await close("not_charged")).data).toMatchObject({ state: "settled", charged_cents: 0 });
      expect(reserved(EA)).toBe(0);
      expect(gaps()).toBe("0");
      // the 15-minute guard counts from the dispatch marker, not from begin
      const late = await begun(PA1);
      aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '1 hour' where id = '${late.attempt_id}'`);
      await rpc("tw4_usage_dispatching", { p_attempt_id: late.attempt_id });
      await rpc("tw4_usage_uncertain", { p_attempt_id: late.attempt_id, p_error_code: "timeout" });
      expect((await rpc("tw4_usage_resolve", { p_attempt_id: late.attempt_id, p_actor: U.padmin, p_outcome: "released", p_segments: null, p_reason: "fixture: too early after dispatch" })).error?.code).toBe("22023");
    });

    it("a text that went out after an admin released it can still go to review and be closed; nothing is stuck", async () => {
      await ready(EA, PA1);
      const u = await begun(PA1);
      await rpc("tw4_usage_dispatching", { p_attempt_id: u.attempt_id });
      await rpc("tw4_usage_uncertain", { p_attempt_id: u.attempt_id, p_error_code: "timeout" });
      aged(`update public.studio_sms_usage_attempts set submitting_at = now() - interval '16 minutes' where id = '${u.attempt_id}'`);
      expect((await rpc("tw4_usage_resolve", { p_attempt_id: u.attempt_id, p_actor: U.padmin, p_outcome: "released", p_segments: null, p_reason: "fixture: nothing seen at the provider" })).error).toBeNull();
      const s = sid();
      expect((await callback(u.attempt_id, s, ACC_A, "sent")).data).toMatchObject({ billed: true }); // the late SID arrives by callback
      expect((await settle(u.attempt_id, evidence(ACC_A, s, { num_segments: "7" }))).data).toMatchObject({ outcome: "review" });
      expect(attempt(u.attempt_id)).toMatchObject({ state: "review", closed_at: null });
      expect((await rpc("tw4_usage_resolve", { p_attempt_id: u.attempt_id, p_actor: U.padmin, p_outcome: "charged", p_segments: 2, p_reason: "fixture: charged after review" })).data).toMatchObject({ state: "settled", charged_cents: 2 * price() });
      expect(reserved(EA)).toBe(0);
      expect(gaps()).toBe("0");
    });

    it("the reconciler's queue: texts never read come first; a text that fails to read is stamped and does not block the others", async () => {
      await ready(EA, PA1);
      const provider = new FakeBilledSmsProvider();
      const bad = await submitted(PA1);
      const good = await submitted(PA1);
      aged(`update public.studio_sms_usage_attempts set submitted_at = now() - interval '2 hours' where id = '${bad.attempt_id}'`); // the oldest
      provider.failFetch(bad.sid);
      provider.setEvidence(good.sid, evidence(ACC_A, good.sid) as never);
      expect(await reconcileSmsUsage(admin as never, provider, { limit: 1 })).toMatchObject({ due: 1, errors: 1 }); // the oldest first, it fails and is stamped
      expect(await reconcileSmsUsage(admin as never, provider, { limit: 1 })).toMatchObject({ due: 1, settled: 1 }); // the next run reaches the other one
      expect(attempt(good.attempt_id).state).toBe("settled");
      expect(attempt(bad.attempt_id).last_reconciled_at).not.toBeNull();
    });

    it("an earlier run that stopped between begin and its dispatch marker: a retry of the same source sends the stored text once", async () => {
      await ready(EA, PA1);
      const provider = new FakeBilledSmsProvider();
      const source = randomUUID();
      const first = await begun(PA1, "The original reminder text.", { p_source_id: source }); // the earlier run died here
      const retry = { source: { kind: "manual" as const, id: source }, studioId: PA1, clientId: null, phoneE164: PHONE, body: "A re-rendered text", messageType: "manual",
        relatedTable: null, relatedId: null, sentBy: null, statusCallbackBase: null };
      const results = await Promise.all([sendBilledSms(admin as never, provider, retry), sendBilledSms(admin as never, provider, retry)]);
      expect(results.filter((r) => r.outcome === "sent")).toHaveLength(1);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]).toMatchObject({ body: "The original reminder text.", to: PHONE });
      expect(attempt(first.attempt_id).state).toBe("submitted");
      expect(psql(`select count(*) from public.sms_message_logs where studio_id = '${PA1}'`)).toBe("1");
    });
  });

  it("the rollback refuses once usage evidence exists", () => {
    const rollback = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261201090000_twilio_sms_usage_financials_rollback.sql"), "utf8");
    expect(psqlError(rollback)).toContain("rollback refused");
  });
});
