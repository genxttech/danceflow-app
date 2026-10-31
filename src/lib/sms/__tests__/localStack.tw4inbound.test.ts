/**
 * Inbound SMS usage recording against a REAL schema: one record per message SID per legal business, the negative-balance ceiling (D1), compliance traffic
 * never charged (D2), reply counters (D2/D3), monthly-limit accounting with overruns (D4), month attribution, concurrency, holds, tenant isolation and the
 * pilot business. Nothing reaches Twilio. LOCAL QA STACK ONLY (skipped unless the variables below point at a loopback Supabase stack with the migrations
 * through 20261203090000 applied).
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deletePricesSql, ownerReactivate, seedPrice, seedPriceSql } from "../twilioIsv/__tests__/priceFixture";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 1_000_000 });

import { SupabaseCreditStore } from "@/lib/sms/twilioIsv/creditStore";

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

const PA1 = "a7e00000-0000-4000-8000-00000000000a"; // business A, location 1 (Chicago)
const PA2 = "a7e00000-0000-4000-8000-00000000000b"; // business A, location 2
const PB1 = "a7e00000-0000-4000-8000-00000000000c"; // business B
const PL = "a7e00000-0000-4000-8000-00000000000d"; // legacy studio (no legal business)
const EA = "e7e00000-0000-4000-8000-0000000000e1";
const EB = "e7e00000-0000-4000-8000-0000000000e2";
const U = { owner_a: "a7e00000-0000-4000-8000-000000000101", padmin: "a7e00000-0000-4000-8000-000000000401" };
const ACC_A = `AC${"a7".repeat(16)}`;
const ACC_B = `AC${"b7".repeat(16)}`;
const MG_A1 = `MG${"7a".repeat(16)}`;
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
delete from public.studio_sms_inbound_usage where legal_entity_id in (${ENTITIES});
update public.studio_sms_recurring_charges set run_id = null where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_charges where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_authorizations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_approval_refs where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_inbound_exposure_ceilings where legal_entity_id in (${ENTITIES}) or set_by = '${U.padmin}';
delete from public.sms_inbound_reply_counters where account_key in ('${ACC_A}', '${ACC_B}');
delete from public.studio_sms_usage_attempts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_billed_senders where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_usage_switch_log where changed_by = '${U.padmin}';
delete from public.sms_message_logs where studio_id in (${STUDIOS});
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
delete from auth.users where email like '%@tw4inbound-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4inbound-e2e.test', now(), now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.padmin}', 'platform_admin') on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values
  ('${PA1}', 'TW4INBOUND A1', 'tw4inbound-a1', null, 'America/Chicago'), ('${PA2}', 'TW4INBOUND A2', 'tw4inbound-a2', null, 'America/Chicago'),
  ('${PB1}', 'TW4INBOUND B1', 'tw4inbound-b1', null, 'UTC'), ('${PL}', 'TW4INBOUND Legacy', 'tw4inbound-legacy', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${U.owner_a}', '${PA1}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'INB Alpha LLC', '6661', 15000, '${U.padmin}'), ('${EB}', 'INB Beta LLC', '6662', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${PA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 1', now() - interval '2 days'),
  ('${PA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 2', now() - interval '1 day'),
  ('${PB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${EA}', '${ACC_A}', 'df:test:${EA}', 'test', 'active', '${U.padmin}'), ('${EB}', '${ACC_B}', 'df:test:${EB}', 'test', 'active', '${U.padmin}');
commit;`;

describe.skipIf(!enabled)("inbound SMS usage recording: ceiling, compliance, limits, months, concurrency, tenants (real schema)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let snapshotActivePrices: string[] = [];
  let n = 0;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const balance = (e: string) => Number(psql(`select coalesce((select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${e}'), 0)`));
  const curKey = (e: string) => psql(`select public._tw4ml_month_key('${e}', now())`);
  const parts = (e: string, key?: string) => JSON.parse(psql(`select public._tw4ml_month_parts('${e}', '${key ?? curKey(e)}')::text`)) as Record<string, number>;
  const gaps = () => psql("select public._tw4in_reconciliation_gaps()");
  const sid = () => `SM${randomBytes(16).toString("hex")}`;
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const record = (studio: string, over: Record<string, unknown> = {}) =>
    rpc("tw4_inbound_record", {
      p_studio_id: studio, p_signer_account: studio === PB1 ? ACC_B : ACC_A, p_provider_sid: sid(), p_segments: 1, p_media: 0, p_classification: "ordinary",
      p_reply_body: null, p_received_at: null, p_source: "webhook", ...over,
    });
  const recorded = async (studio: string, over: Record<string, unknown> = {}) => {
    const r = await record(studio, over);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return r.data as { recorded: boolean; replayed: boolean; charged_cents: number; uncollected_cents: number; classification: string };
  };
  const fund = async (e: string, studio: string, pack: number) => {
    n += 1;
    const ref = `cs_inb_${RUN}_${n}`;
    await credits.topupPending(e, studio, ref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(e, studio, ref, pack, `evt_inb_${RUN}_${n}`, `pi_inb_${RUN}_${n}`, true);
  };
  const reset = (e: string) =>
    aged(`delete from public.studio_sms_inbound_usage where legal_entity_id = '${e}'; delete from public.studio_sms_inbound_exposure_ceilings where legal_entity_id = '${e}' or scope = 'platform' and set_by = '${U.padmin}';
          delete from public.studio_sms_usage_attempts where legal_entity_id = '${e}'; delete from public.sms_message_logs where studio_id in (select studio_id from public.studio_sms_entity_studios where legal_entity_id = '${e}');
          delete from public.studio_sms_monthly_limits where legal_entity_id = '${e}';
          delete from public.studio_sms_credit_ledger where legal_entity_id = '${e}'; delete from public.studio_sms_credit_reservations where legal_entity_id = '${e}';
          delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id = '${e}');
          delete from public.studio_sms_credit_topups where legal_entity_id = '${e}'; delete from public.studio_sms_credit_accounts where legal_entity_id = '${e}'`);
  const setLimit = (e: string, cents: number) => rpc("tw4_monthly_limit_set_admin", { p_entity_id: e, p_actor: U.padmin, p_limit_cents: cents, p_effective_month: null, p_reason: "fixture: monthly texting limit" });
  const priced = () => Number(psql("select customer_price_cents from public.studio_sms_price_list where kind = 'sms_inbound' and active"));

  beforeAll(async () => {
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
      psql(deletePricesSql(`created_by = '${U.padmin}'`));
      ownerReactivate(psql, `id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
  });
  const publish = async (kind: "sms_inbound" | "sms_usage" | "monthly" | "number", cents: number, provider: number) =>
    seedPrice(psql, { kind: kind, customer: cents, provider: provider, description: `fixture ${kind} price`, approver: U.padmin });
  const unpublish = (kind: string) => aged(`update public.studio_sms_price_list set active = false where kind = '${kind}' and created_by = '${U.padmin}'`);

  it("privileges: the tables are unreachable by API roles; the functions are service-role only; the helpers are callable by no API role; records are final", async () => {
    for (const table of ["studio_sms_inbound_usage", "studio_sms_inbound_exposure_ceilings", "sms_inbound_reply_counters"]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete')`), `${role} ${table}`).toBe("f");
    }
    for (const fn of ["tw4_inbound_record(uuid, text, text, int, int, text, text, timestamptz, text)", "tw4_inbound_reply_allowed(text, text, text, int)", "tw4_inbound_exposure_set(uuid, uuid, int, text)", "sms_inbound_admin_overview(uuid)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    for (const fn of ["_tw4in_ceiling(uuid)", "_tw4in_reconciliation_gaps()"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("f");
    }
    reset(EA);
    const s = sid();
    await recorded(PA1, { p_provider_sid: s });
    expect(psqlError(`update public.studio_sms_inbound_usage set charged_cents = 0 where provider_sid = '${s}'`)).toContain("append-only");
    expect(psqlError(`delete from public.studio_sms_inbound_usage where provider_sid = '${s}'`)).toContain("append-only");
    expect(psqlError("truncate public.studio_sms_inbound_usage")).toContain("never truncated");
    expect(psqlError(`select public.tw4_credit_debit_usage('${EA}', '${PA1}', 5, 'in:${s}', 'fixture')`)).toContain("billed texts"); // the direct debit cannot write an inbound key
  });

  describe("who is recorded", () => {
    it("a legacy studio is not billed; a text signed by the parent or by another business's subaccount is refused and nothing is written", async () => {
      reset(EA);
      expect((await recorded(PL, { p_signer_account: null })).recorded).toBe(false);
      for (const signer of [null, ACC_B, `AC${"00".repeat(16)}`]) expect((await record(PA1, { p_signer_account: signer })).error?.code, String(signer)).toBe("42501");
      expect(psql(`select count(*) from public.studio_sms_inbound_usage where studio_id in ('${PA1}', '${PL}')`)).toBe("0");
      // a suspended subaccount still receives (and records) texts: STOP must reach the business
      aged(`update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = '${EA}'`);
      expect((await recorded(PA1)).recorded).toBe(true);
      aged(`update public.studio_sms_twilio_accounts set status = 'active' where legal_entity_id = '${EA}'`);
    });

    it("input is validated: SID shape, classification, segments, media, source and timestamps", async () => {
      reset(EA);
      for (const over of [{ p_provider_sid: "SMbad" }, { p_classification: "spam" }, { p_segments: 0 }, { p_segments: 21 }, { p_media: 11 }, { p_source: "manual" },
        { p_source: "webhook", p_received_at: new Date().toISOString() }, { p_source: "reconciler", p_received_at: new Date(Date.now() + 3_600_000).toISOString() },
        { p_source: "reconciler", p_received_at: new Date(Date.now() - 401 * 86_400_000).toISOString() }]) {
        expect((await record(PA1, over)).error?.code, JSON.stringify(over)).toBe("22023");
      }
    });

    it("one record per message SID: a repeat is a replay, never a second charge; the same SID for another studio or business is refused", async () => {
      reset(EA);
      reset(EB);
      await fund(EA, PA1, 2_500);
      await publish("sms_inbound", 3, 1);
      const s = sid();
      expect(await recorded(PA1, { p_provider_sid: s, p_segments: 2 })).toMatchObject({ recorded: true, replayed: false, charged_cents: 6 });
      expect(await recorded(PA1, { p_provider_sid: s, p_segments: 2 })).toMatchObject({ replayed: true, charged_cents: 6 });
      expect((await record(PA2, { p_provider_sid: s })).error?.code).toBe("42501");
      expect((await record(PB1, { p_provider_sid: s })).error?.code).toBe("42501");
      expect(balance(EA)).toBe(2_500 - 6);
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where idempotency_key = 'usage:in:${s}'`)).toBe("1");
      const same = await Promise.all(Array.from({ length: 8 }, () => record(PA1, { p_provider_sid: sid().replace(/^SM.{32}$/, `SM${"c".repeat(32)}`) })));
      expect(same.filter((r) => !r.error)).toHaveLength(8);
      expect(same.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
      expect(psql(`select count(*) from public.studio_sms_inbound_usage where provider_sid = 'SM${"c".repeat(32)}'`)).toBe("1");
      expect(gaps()).toBe("0");
      unpublish("sms_inbound");
    });
  });

  describe("D1: charging within the negative-balance ceiling", () => {
    it("without a published inbound price nothing is charged; with one, an ordinary text is charged per segment", async () => {
      reset(EA);
      await fund(EA, PA1, 2_500);
      unpublish("sms_inbound");
      expect(await recorded(PA1, { p_segments: 3 })).toMatchObject({ recorded: true, charged_cents: 0, uncollected_cents: 0 });
      expect(balance(EA)).toBe(2_500);
      await publish("sms_inbound", 3, 1);
      expect(await recorded(PA1, { p_segments: 3 })).toMatchObject({ charged_cents: 9, uncollected_cents: 0 });
      expect(balance(EA)).toBe(2_491);
      // a multimedia message is not billable as SMS (recorded, absorbed)
      expect(await recorded(PA1, { p_provider_sid: `MM${randomBytes(16).toString("hex")}` })).toMatchObject({ charged_cents: 0 });
      expect(await recorded(PA1, { p_media: 1 })).toMatchObject({ charged_cents: 0 });
      unpublish("sms_inbound");
    });

    it("at no credit the text is charged down to -$10.00 and the rest is uncollected; texts keep being received; outgoing texts fail closed", async () => {
      reset(EA);
      await publish("sms_inbound", 300, 1); // a large fixture price to reach the ceiling quickly
      expect(balance(EA)).toBe(0);
      const results = [];
      for (let i = 0; i < 4; i += 1) results.push(await recorded(PA1));
      expect(results.map((r) => [r.charged_cents, r.uncollected_cents])).toEqual([[300, 0], [300, 0], [300, 0], [100, 200]]); // the fourth crosses -$10.00
      expect(await recorded(PA1)).toMatchObject({ charged_cents: 0, uncollected_cents: 300 }); // beyond the ceiling: received, recorded, absorbed
      expect(balance(EA)).toBe(-1_000);
      expect(psql(`select coalesce(sum(billable_cents), 0) || ':' || coalesce(sum(charged_cents), 0) || ':' || coalesce(sum(uncollected_cents), 0) from public.studio_sms_inbound_usage where legal_entity_id = '${EA}'`)).toBe("1500:1000:500");
      expect(psqlError(`select public.tw4_credit_debit_usage('${EA}', '${PA1}', 1, 'out-${RUN}', 'fixture')`)).toContain("insufficient settled credit"); // outgoing fails closed
      // a top-up pays the debt first
      await fund(EA, PA1, 2_500);
      expect(balance(EA)).toBe(1_500);
      expect(gaps()).toBe("0");
      unpublish("sms_inbound");
    });

    it("the ceiling is configurable per business and platform-wide by a platform admin only; it applies to the next charge", async () => {
      reset(EA);
      reset(EB);
      await publish("sms_inbound", 3, 1);
      const set = (entity: string | null, cents: number, actor = U.padmin, reason = "fixture: exposure decision") => rpc("tw4_inbound_exposure_set", { p_entity_id: entity, p_actor: actor, p_cents: cents, p_reason: reason });
      expect((await set(EA, 500, U.owner_a)).error?.code).toBe("42501");
      expect((await set(EA, 500, U.padmin, "short")).error?.code).toBe("22023");
      for (const bad of [-1, 10_001]) expect((await set(EA, bad)).error?.code).toBe("22023");
      expect((await set(randomUUID(), 500)).error?.code).toBe("22023");
      expect((await set(EA, 0)).error).toBeNull(); // business A: no inbound debt at all
      expect(await recorded(PA1)).toMatchObject({ charged_cents: 0, uncollected_cents: 3 });
      expect((await set(null, 4)).error).toBeNull(); // platform: 4 cents
      expect(await recorded(PB1)).toMatchObject({ charged_cents: 3 });
      expect(await recorded(PB1)).toMatchObject({ charged_cents: 1, uncollected_cents: 2 });
      expect(await recorded(PA1)).toMatchObject({ charged_cents: 0 }); // the business override wins
      expect(psql(`select ceiling_cents from public.studio_sms_inbound_usage where legal_entity_id = '${EB}' order by recorded_at desc limit 1`)).toBe("4");
      unpublish("sms_inbound");
      reset(EA);
      reset(EB);
    });

    it("a hold or a suspension does not stop recording or charging within the ceiling; it keeps blocking outgoing texts", async () => {
      reset(EA);
      await fund(EA, PA1, 2_500);
      await publish("sms_inbound", 3, 1);
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: hold for inbound", p_actor: U.padmin });
      expect(await recorded(PA1)).toMatchObject({ charged_cents: 3 });
      expect(psqlError(`select public.tw4_credit_debit_usage('${EA}', '${PA1}', 1, 'held-${RUN}', 'fixture')`)).toContain("on hold");
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: false, p_reason: "fixture release", p_actor: U.padmin });
      unpublish("sms_inbound");
    });

    it("concurrency: twenty simultaneous texts at no credit charge exactly the ceiling in total, and the books reconcile", async () => {
      reset(EA);
      await publish("sms_inbound", 70, 1);
      const results = await Promise.all(Array.from({ length: 20 }, () => record(PA1)));
      expect(results.every((r) => !r.error)).toBe(true);
      const charged = results.reduce((sum, r) => sum + (r.data as { charged_cents: number }).charged_cents, 0);
      const uncollected = results.reduce((sum, r) => sum + (r.data as { uncollected_cents: number }).uncollected_cents, 0);
      expect(charged).toBe(1_000);
      expect(charged + uncollected).toBe(20 * 70);
      expect(balance(EA)).toBe(-1_000);
      expect(gaps()).toBe("0");
      expect((await credits.verify(EA)).ok).toBe(true);
      unpublish("sms_inbound");
    });
  });

  describe("D2: compliance traffic", () => {
    it("STOP / START / HELP are recorded with their estimated costs but never charged, even with a price published and no credit", async () => {
      reset(EA);
      await publish("sms_inbound", 3, 1);
      await publish("sms_usage", 4, 2);
      const r = await recorded(PA1, { p_classification: "compliance", p_segments: 1, p_reply_body: "You have been unsubscribed from INB Alpha. Reply START to resubscribe." });
      expect(r).toMatchObject({ classification: "compliance", charged_cents: 0, uncollected_cents: 0 });
      expect(balance(EA)).toBe(0);
      expect(psql(`select billable_cents || ':' || est_provider_cost_cents || ':' || reply_segments || ':' || est_reply_cost_cents from public.studio_sms_inbound_usage where legal_entity_id = '${EA}'`)).toBe("0:1:1:2");
      expect(parts(EA)).toMatchObject({ inbound_cents: 0, absorbed_cost_cents: 3, total_cents: 0 });
      expect(psqlError(`begin; set local session_replication_role = replica; insert into public.studio_sms_inbound_usage (legal_entity_id, studio_id, provider_sid, account_sid, source, classification, segments, billable_cents, charged_cents, uncollected_cents, ceiling_cents, received_at) values ('${EA}', '${PA1}', '${sid()}', '${ACC_A}', 'webhook', 'compliance', 1, 3, 3, 0, 1000, now()); rollback;`))
        .toContain("studio_sms_inbound_usage_compliance_free"); // even a direct write cannot charge compliance traffic
      unpublish("sms_inbound");
      unpublish("sms_usage");
    });

    it("reply counters: one error reply per sender per day, five HELP/START confirmations; per account and kind; the sender is a hash", async () => {
      aged(`delete from public.sms_inbound_reply_counters where account_key in ('${ACC_A}', 'parent') and sender_hash in ('${hash("x")}', '${hash("y")}')`);
      const allowed = async (account: string | null, sender: string, kind: string, limit: number) => (await rpc("tw4_inbound_reply_allowed", { p_account_sid: account, p_sender_hash: hash(sender), p_kind: kind, p_limit: limit })).data;
      expect(await allowed(ACC_A, "x", "error_unrouted", 1)).toBe(true);
      expect(await allowed(ACC_A, "x", "error_unrouted", 1)).toBe(false);
      expect(await allowed(ACC_A, "x", "error_invalid", 1)).toBe(false); // ONE error reply per sender per day, whatever the error
      expect(await allowed(ACC_A, "y", "error_unrouted", 1)).toBe(true); // another sender
      expect(await allowed(null, "x", "error_unrouted", 1)).toBe(true); // the parent account is its own scope
      const help = [];
      for (let i = 0; i < 3; i += 1) help.push(await allowed(ACC_A, "x", "help", 5));
      for (let i = 0; i < 3; i += 1) help.push(await allowed(ACC_A, "x", "start", 5));
      expect(help).toEqual([true, true, true, true, true, false]); // HELP and START share one daily allowance of five confirmations
      for (const bad of [{ p_sender_hash: "+15125550100" }, { p_kind: "stop" }, { p_limit: 0 }, { p_account_sid: "ACbad" }]) {
        expect((await rpc("tw4_inbound_reply_allowed", { p_account_sid: ACC_A, p_sender_hash: hash("x"), p_kind: "help", p_limit: 5, ...bad })).error?.code, JSON.stringify(bad)).toBe("22023");
      }
      expect(psql(`select count(*) from public.sms_inbound_reply_counters where sender_hash like '+%'`)).toBe("0");
    });
  });

  describe("D4: monthly limits, overruns, months", () => {
    it("charged inbound counts toward the month and can overrun the limit; new outgoing chargeable texts are then refused; inbound is never refused", async () => {
      reset(EA);
      await fund(EA, PA1, 2_500);
      await publish("sms_inbound", 3, 1);
      expect((await setLimit(EA, 10)).error).toBeNull();
      for (let i = 0; i < 5; i += 1) expect((await recorded(PA1)).charged_cents).toBe(3); // 15 > 10: an overrun
      expect(parts(EA)).toMatchObject({ inbound_cents: 15, usage_cents: 0, total_cents: 15 });
      expect(psqlError(`select public.tw4_credit_debit_usage('${EA}', '${PA1}', 1, 'over-${RUN}', 'fixture')`)).toContain("monthly spending limit");
      expect(Number(psql(`select public._tw4ml_month_spend('${EA}', '${curKey(EA)}')`)) - Number(psql(`select public._tw4ml_effective_limit('${EA}', '${curKey(EA)}')`))).toBe(5); // the visible overrun
      unpublish("sms_inbound");
    });

    it("a text is counted in the month it was received, in the business's timezone (a late record from the reconciler included)", async () => {
      reset(EA);
      await fund(EA, PA1, 2_500);
      await publish("sms_inbound", 3, 1);
      const prev = psql(`select public._tw4ml_key_add('${curKey(EA)}', -1)`);
      const lastSecondPrev = psql(`select to_char(public._tw4ml_month_start('${EA}', '${curKey(EA)}') - interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
      expect(await recorded(PA1, { p_source: "reconciler", p_received_at: lastSecondPrev })).toMatchObject({ charged_cents: 3 });
      expect(parts(EA, prev)).toMatchObject({ inbound_cents: 3 });
      expect(parts(EA)).toMatchObject({ inbound_cents: 0 });
      unpublish("sms_inbound");
    });
  });

  describe("owner decision (PR 248): inbound never consumes funds or limit room of authorized recurring fees", () => {
    const authorizeMonthly = async () => {
      const made = await rpc("tw4_recurring_authorize", { p_studio_id: PA1, p_user_id: U.owner_a, p_kind: "monthly", p_acknowledged_price_cents: 1500, p_term_months: 3, p_total_limit_cents: 4500 });
      expect(made.error, JSON.stringify(made.error)).toBeNull();
      return (made.data as { authorization_id: string }).authorization_id;
    };
    const reserved = (e: string) => Number(psql(`select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${e}'`));
    const clearAuths = () => {
      psql(`select count(public._tw4rc_release_commitment(a.id)) from public.studio_sms_recurring_authorizations a where a.legal_entity_id = '${EA}' and a.commitment_reservation_id is not null`);
      aged(`delete from public.studio_sms_recurring_charges where legal_entity_id = '${EA}'; delete from public.studio_sms_recurring_authorizations where legal_entity_id = '${EA}'`);
    };

    describe("option B: one month of every active recurring fee stays available", () => {
      const authorizeKind = async (kind: "monthly" | "number", price: number) => {
        const made = await rpc("tw4_recurring_authorize", { p_studio_id: PA1, p_user_id: U.owner_a, p_kind: kind, p_acknowledged_price_cents: price, p_term_months: 3, p_total_limit_cents: price * 3 });
        expect(made.error, JSON.stringify(made.error)).toBeNull();
        const id = (made.data as { authorization_id: string }).authorization_id;
        psql(`select public._tw4rc_release_commitment('${id}')`); // a later month: nothing set aside, only the fee's authorization
        return id;
      };
      const sumCharged = async (n: number) => {
        let total = 0;
        for (let i = 0; i < n; i += 1) total += (await recorded(PA1)).charged_cents;
        return total;
      };

      it("inbound uses only the credit above one month of the fee, never creates debt, and the next fee is still funded", async () => {
        reset(EA);
        clearAuths();
        await fund(EA, PA1, 2_500);
        await publish("monthly", 1500, 1000);
        expect((await setLimit(EA, 10_000)).error).toBeNull();
        const id = await authorizeKind("monthly", 1500);
        expect(reserved(EA)).toBe(0);
        await publish("sms_inbound", 300, 1);
        expect(await sumCharged(6)).toBe(1_000); // 2500 - one month (1500); never below
        expect(balance(EA)).toBe(1_500);
        expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "charged" });
        expect(balance(EA)).toBe(0);
        expect(await sumCharged(2)).toBe(0); // the fee is still active: no inbound debt
        unpublish("sms_inbound");
        unpublish("monthly");
        clearAuths();
      });

      it("several active fees are protected together at their authorized prices; a set-aside first month is not counted twice", async () => {
        reset(EA);
        clearAuths();
        await fund(EA, PA1, 5_000);
        await publish("monthly", 1500, 1000);
        await publish("number", 500, 300);
        expect((await setLimit(EA, 10_000)).error).toBeNull();
        await authorizeKind("monthly", 1500);
        const made = await rpc("tw4_recurring_authorize", { p_studio_id: PA1, p_user_id: U.owner_a, p_kind: "number", p_acknowledged_price_cents: 500, p_term_months: 3, p_total_limit_cents: 1500 });
        expect(made.error, JSON.stringify(made.error)).toBeNull(); // this one keeps its first month set aside (500 reserved)
        expect(reserved(EA)).toBe(500);
        await publish("sms_inbound", 300, 1);
        // free = 5000 - 500 reserved (number, set aside) - 1500 (monthly, active) = 3000; the number fee is not counted a second time
        expect(await sumCharged(12)).toBe(3_000);
        expect(balance(EA)).toBe(2_000);
        unpublish("sms_inbound");
        unpublish("monthly");
        unpublish("number");
        clearAuths();
      });

      it("a revoked or expired authorization no longer protects anything: the $10 ceiling applies again", async () => {
        reset(EA);
        clearAuths();
        await fund(EA, PA1, 2_500);
        await publish("monthly", 1500, 1000);
        expect((await setLimit(EA, 10_000)).error).toBeNull();
        const id = await authorizeKind("monthly", 1500);
        await publish("sms_inbound", 300, 1);
        expect(await sumCharged(4)).toBe(1_000); // protected
        expect((await rpc("tw4_recurring_revoke", { p_authorization_id: id, p_user_id: U.owner_a })).data).toMatchObject({ status: "revoked" });
        expect(await sumCharged(10)).toBe(2_500); // 1500 left, then down to -$10.00
        expect(balance(EA)).toBe(-1_000);
        // expired: the same with a term that has ended
        reset(EA);
        clearAuths();
        await fund(EA, PA1, 2_500);
        expect((await setLimit(EA, 10_000)).error).toBeNull();
        const old = await authorizeKind("monthly", 1500);
        aged(`update public.studio_sms_recurring_authorizations set expires_at = now() - interval '1 hour' where id = '${old}'`);
        expect(await sumCharged(12)).toBe(3_500); // all 2500 and down to -$10.00
        unpublish("sms_inbound");
        unpublish("monthly");
        clearAuths();
      });

      it("review P2: a fee that can no longer be charged protects nothing (final month charged through the real set-aside path; price changed)", async () => {
        reset(EA);
        clearAuths();
        await fund(EA, PA1, 2_500);
        await publish("monthly", 1500, 1000);
        expect((await setLimit(EA, 10_000)).error).toBeNull();
        // a one-month term: its only month is set aside, then captured by its charge; after that no month is left to charge
        const made = await rpc("tw4_recurring_authorize", { p_studio_id: PA1, p_user_id: U.owner_a, p_kind: "monthly", p_acknowledged_price_cents: 1500, p_term_months: 1, p_total_limit_cents: 1500 });
        expect(made.error, JSON.stringify(made.error)).toBeNull();
        const id = (made.data as { authorization_id: string }).authorization_id;
        expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "charged" });
        expect(balance(EA)).toBe(1_000);
        await publish("sms_inbound", 300, 1);
        expect(await sumCharged(8)).toBe(2_000); // the $10.00 left and down to -$10.00: the ceiling applies again
        // price changed: every later charge would be refused, so the old fee is not protected either
        reset(EA);
        clearAuths();
        await fund(EA, PA1, 2_500);
        expect((await setLimit(EA, 10_000)).error).toBeNull();
        await authorizeKind("monthly", 1500);
        await publish("monthly", 1700, 1000);
        expect(await sumCharged(12)).toBe(3_500);
        unpublish("sms_inbound");
        unpublish("monthly");
        clearAuths();
      });

      it("concurrency: twenty simultaneous inbound texts beside an active fee charge exactly the free credit", async () => {
        reset(EA);
        clearAuths();
        await fund(EA, PA1, 2_500);
        await publish("monthly", 1500, 1000);
        expect((await setLimit(EA, 10_000)).error).toBeNull();
        await authorizeKind("monthly", 1500);
        await publish("sms_inbound", 70, 1);
        const results = await Promise.all(Array.from({ length: 20 }, () => record(PA1)));
        expect(results.every((r) => !r.error)).toBe(true);
        expect(results.reduce((s, r) => s + (r.data as { charged_cents: number }).charged_cents, 0)).toBe(1_000);
        expect(balance(EA)).toBe(1_500);
        expect((await credits.verify(EA)).ok).toBe(true);
        unpublish("sms_inbound");
        unpublish("monthly");
        clearAuths();
      });
    });

    it("review P1: with an outgoing text reserved beside the set-aside, inbound takes nothing from either, and the set-aside is still captured after the text settles", async () => {
      reset(EA);
      clearAuths();
      await fund(EA, PA1, 2_500);
      await publish("monthly", 1500, 1000);
      expect((await setLimit(EA, 10_000)).error).toBeNull();
      const id = await authorizeMonthly(); // 1500 set aside
      psql(`select public._tw4c_post('${EA}', '${PA1}', 'reserve', 0, 1000, 'reserve:fixture-text-${RUN}', null, 'fixture: an outgoing text in flight', null, null)`); // all 2500 reserved
      await publish("sms_inbound", 300, 1);
      const r = await recorded(PA1);
      expect(r).toMatchObject({ charged_cents: 0, uncollected_cents: 300 }); // no free credit and no debt while a set-aside is open
      expect(balance(EA)).toBe(2_500);
      // the text settles at its full reservation (release + charge, no funds check), then the first month is still covered
      psql(`select public._tw4c_post('${EA}', '${PA1}', 'release', 0, -1000, 'release:fixture-text-${RUN}', null, 'fixture', null, null)`);
      psql(`select public._tw4c_post('${EA}', '${PA1}', 'usage_charge', -1000, 0, 'usage:fixture-text-${RUN}', null, 'fixture', null, null)`);
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "charged" });
      expect(balance(EA)).toBe(0);
      unpublish("sms_inbound");
      unpublish("monthly");
      clearAuths();
    });

    it("the first month set aside stays covered: inbound charges only the free credit, the rest is absorbed, and the first charge still captures its set-aside", async () => {
      reset(EA);
      clearAuths();
      await fund(EA, PA1, 2_500);
      await publish("monthly", 1500, 1000);
      expect((await setLimit(EA, 10_000)).error).toBeNull();
      const id = await authorizeMonthly(); // 1500 set aside; 1000 free
      expect(reserved(EA)).toBe(1_500);
      await publish("sms_inbound", 300, 1);
      const charges = [];
      for (let i = 0; i < 6; i += 1) charges.push(await recorded(PA1));
      expect(charges.map((c) => c.charged_cents)).toEqual([300, 300, 300, 100, 0, 0]); // exactly the 1000 free, never into the set-aside, no debt
      expect(charges.reduce((s, c) => s + c.uncollected_cents, 0)).toBe(800);
      expect(balance(EA)).toBe(1_500);
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "charged" });
      expect(balance(EA)).toBe(0);
      expect(gaps()).toBe("0");
      unpublish("sms_inbound");
      unpublish("monthly");
      clearAuths();
    });

    it("concurrency: twenty simultaneous inbound texts beside a set-aside month never touch it", async () => {
      reset(EA);
      clearAuths();
      await fund(EA, PA1, 2_500);
      await publish("monthly", 1500, 1000);
      expect((await setLimit(EA, 10_000)).error).toBeNull();
      await authorizeMonthly();
      await publish("sms_inbound", 70, 1);
      const results = await Promise.all(Array.from({ length: 20 }, () => record(PA1)));
      expect(results.every((r) => !r.error)).toBe(true);
      expect(results.reduce((s, r) => s + (r.data as { charged_cents: number }).charged_cents, 0)).toBe(1_000);
      expect(balance(EA)).toBe(1_500); // the set-aside is fully covered
      expect(reserved(EA)).toBe(1_500);
      expect((await credits.verify(EA)).ok).toBe(true);
      unpublish("sms_inbound");
      unpublish("monthly");
      clearAuths();
    });

    it("a later month's recurring fee ignores inbound when checking the monthly limit; outgoing texts and the overrun still see it", async () => {
      reset(EA);
      clearAuths();
      await fund(EA, PA1, 5_000);
      await publish("monthly", 1500, 1000);
      expect((await setLimit(EA, 10_000)).error).toBeNull();
      const id = await authorizeMonthly();
      psql(`select public._tw4rc_release_commitment('${id}')`); // this month is charged by an ordinary reservation, not the set-aside
      expect((await setLimit(EA, 1_500)).error).toBeNull(); // room for exactly the fee
      await publish("sms_inbound", 300, 1);
      for (let i = 0; i < 3; i += 1) await recorded(PA1); // 900 of inbound: the month is now over the limit with the fee
      expect(parts(EA)).toMatchObject({ inbound_cents: 900 });
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "charged" });
      expect(Number(psql(`select public._tw4ml_month_spend('${EA}', '${curKey(EA)}')`))).toBe(2_400); // 1500 fee + 900 inbound: a visible overrun of 900
      expect(psqlError(`select public.tw4_credit_debit_usage('${EA}', '${PA1}', 1, 'after-fee-${RUN}', 'fixture')`)).toContain("monthly spending limit"); // outgoing still blocked
      unpublish("sms_inbound");
      unpublish("monthly");
      clearAuths();
    });

    it("without inbound, the recurring fee's own limit check is unchanged: a fee that does not fit is still held", async () => {
      reset(EA);
      clearAuths();
      await fund(EA, PA1, 5_000);
      await publish("monthly", 1500, 1000);
      expect((await setLimit(EA, 10_000)).error).toBeNull();
      const id = await authorizeMonthly();
      psql(`select public._tw4rc_release_commitment('${id}')`);
      expect((await setLimit(EA, 1_400)).error).toBeNull();
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: curKey(EA), p_run_id: null })).data).toMatchObject({ outcome: "held", reason: "monthly spending limit reached" });
      unpublish("monthly");
      clearAuths();
    });
  });

  describe("tenants, the pilot business, the platform view, the rollback", () => {
    it("each business pays only for its own texts; another business's subaccount cannot record for it", async () => {
      reset(EA);
      reset(EB);
      await fund(EA, PA1, 2_500);
      await fund(EB, PB1, 2_500);
      await publish("sms_inbound", 3, 1);
      await recorded(PA2);
      await recorded(PB1);
      expect([balance(EA), balance(EB)]).toEqual([2_497, 2_497]);
      expect((await record(PB1, { p_signer_account: ACC_A })).error?.code).toBe("42501");
      unpublish("sms_inbound");
    });

    it("the pilot business's inbound charges come from credit only and never create debt (its pilot-funded setup needs a non-negative balance)", async () => {
      const inPilot = () =>
        execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], {
          input: `begin; set local session_replication_role = replica; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${EB}', 15000, 'fixture approval reference text', '${U.padmin}'); reset session_replication_role;
                  ${seedPriceSql({ kind: "sms_inbound", customer: 3, provider: 1, description: "fixture inbound price", approver: U.padmin })}
                  select (public.tw4_inbound_record('${PB1}', '${ACC_B}', '${sid()}', 1, 0, 'ordinary', null, null, 'webhook'))->>'charged_cents';
                  select (public.tw4_inbound_record('${PB1}', '${ACC_B}', '${sid()}', 1, 0, 'ordinary', null, null, 'webhook'))->>'uncollected_cents';
                  select (select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${EB}');
                  select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EB}' and funding = 'pilot';
                  rollback;`,
          encoding: "utf8",
        }).split("\n").filter((l) => /^-?[0-9]+$/.test(l)).slice(-4);
      reset(EB);
      await fund(EB, PB1, 2_500);
      await credits.adjust(EB, -2_496, `inb-four-${RUN}`, "fixture: credit for about one text", U.padmin); // 4 cents left
      expect(inPilot()).toEqual(["3", "2", "0", "0"]); // first text from credit, the second only up to zero: never below, never from the pilot
      reset(EB);
      expect(inPilot()).toEqual(["0", "3", "0", "0"]); // no credit: nothing charged, no debt
    });

    it("the ceiling counts reserved funds as spent (review P1-1): an open reservation never lets inbound debt exceed the ceiling", async () => {
      reset(EA);
      await fund(EA, PA1, 2_500);
      await credits.adjust(EA, -2_000, `inb-five-${RUN}`, "fixture: five dollars of credit", U.padmin);
      psql(`select public._tw4c_post('${EA}', '${PA1}', 'reserve', 0, 500, 'reserve:fixture-${RUN}', null, 'fixture: an outgoing text in flight', null, null)`); // available = 0
      await publish("sms_inbound", 300, 1);
      let charged = 0;
      for (let i = 0; i < 6; i += 1) charged += (await recorded(PA1)).charged_cents;
      expect(charged).toBe(1_000); // down to available = -$10.00, not balance = -$10.00
      expect(balance(EA) - Number(psql(`select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${EA}'`))).toBe(-1_000);
      unpublish("sms_inbound");
      reset(EA);
    });

    it("the platform view flags volume and ceiling alerts; admins only", async () => {
      reset(EA);
      await publish("sms_inbound", 300, 1);
      for (let i = 0; i < 5; i += 1) await recorded(PA1);
      const view = (await rpc("sms_inbound_admin_overview", { p_actor: U.padmin })).data as { businesses: Array<Record<string, unknown>>; reconciliation_gaps: number };
      expect(view.reconciliation_gaps).toBe(0);
      expect(view.businesses.find((b) => b.legal_entity_id === EA)).toMatchObject({ alert_ceiling: true, balance_cents: -1_000, uncollected_month_cents: 500 });
      expect((await rpc("sms_inbound_admin_overview", { p_actor: U.owner_a })).error?.code).toBe("42501");
      unpublish("sms_inbound");
    });

    it("the rollback refuses once inbound records exist", async () => {
      await recorded(PA1); // evidence exists: the rollback must refuse (it must never run for real here)
      expect(Number(psql("select count(*) from public.studio_sms_inbound_usage"))).toBeGreaterThan(0);
      const rollback = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261203090000_twilio_inbound_usage_recording_rollback.sql"), "utf8");
      expect(psqlError(rollback)).toContain("rollback refused");
    });
  });
});
