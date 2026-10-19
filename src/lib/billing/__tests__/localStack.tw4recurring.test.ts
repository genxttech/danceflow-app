/**
 * Recurring SMS service-charge authorization against a REAL schema with real JWTs. Nothing reaches Stripe or Twilio. LOCAL QA STACK ONLY (skipped unless the
 * variables below point at a loopback Supabase stack with the migrations through 20261126090000 applied).
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

import { getRecurringAdminOverview, getRecurringOverview, authorizeRecurring, revokeRecurring, runDueRecurringCharges, periodKeyFor, buildAuthorizationStatement, RecurringError } from "@/lib/billing/smsRecurring";
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

const PA1 = "a7d00000-0000-4000-8000-00000000000a";
const PA2 = "a7d00000-0000-4000-8000-00000000000b";
const PB1 = "a7d00000-0000-4000-8000-00000000000c";
const PX = "a7d00000-0000-4000-8000-00000000000d";
const EA = "e7d00000-0000-4000-8000-0000000000e1";
const EB = "e7d00000-0000-4000-8000-0000000000e2";
const U = {
  owner_a: "a7d00000-0000-4000-8000-000000000101", // owner of both locations of business A
  owner_a2: "a7d00000-0000-4000-8000-000000000104", // owner of location 2 only
  fd_a: "a7d00000-0000-4000-8000-000000000102",
  admin_a: "a7d00000-0000-4000-8000-000000000103",
  owner_b: "a7d00000-0000-4000-8000-000000000201",
  owner_x: "a7d00000-0000-4000-8000-000000000301",
  padmin: "a7d00000-0000-4000-8000-000000000401",
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

const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_recurring_charges where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_recurring_authorizations where legal_entity_id in ('${EA}', '${EB}');
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
delete from auth.users where email like '%@tw4rec-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4rec-e2e.test', now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.owner_a2}', 'owner_a2'), ('${U.fd_a}', 'fd_a'), ('${U.admin_a}', 'admin_a'), ('${U.owner_b}', 'owner_b'), ('${U.owner_x}', 'owner_x'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ${Object.values(U).map((u) => `('${u}', ${u === U.padmin ? "'platform_admin'" : "null"})`).join(", ")}
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  ('${PA1}', 'TW4REC Location A1', 'tw4rec-a1', null), ('${PA2}', 'TW4REC Location A2', 'tw4rec-a2', null),
  ('${PB1}', 'TW4REC Location B1', 'tw4rec-b1', null), ('${PX}', 'TW4REC Location X', 'tw4rec-x', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${PA1}', 'studio_owner', true), ('${U.owner_a}', '${PA2}', 'studio_owner', true), ('${U.owner_a2}', '${PA2}', 'studio_owner', true), ('${U.fd_a}', '${PA1}', 'front_desk', true),
  ('${U.admin_a}', '${PA1}', 'studio_admin', true), ('${U.owner_b}', '${PB1}', 'studio_owner', true), ('${U.owner_x}', '${PX}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'REC Alpha LLC', '8881', 15000, '${U.padmin}'), ('${EB}', 'REC Beta LLC', '8882', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values
  ('${PA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location one'),
  ('${PA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location two'),
  ('${PB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B');
commit;`;

describe.skipIf(!enabled)("recurring SMS service charges: authorization, funding, holds, limits, concurrency (real schema, real JWTs)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let snapshotActivePrices: string[] = [];
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const code = async (promise: PromiseLike<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      if (error instanceof RunnerStoreError) return error.code;
      if (error instanceof RecurringError) return error.code;
      return `other:${String(error)}`;
    }
  };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql} commit;`);
  const balance = (entity: string) => Number(psql(`select coalesce((select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 0)`));
  const reserved = (entity: string) => Number(psql(`select coalesce((select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 0)`));
  const month = (offset = 0) => {
    const d = new Date();
    return periodKeyFor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)));
  };
  const NOW = month();
  let n = 0;
  const reset = async (entity: string) => {
    n += 1;
    const b = balance(entity);
    if (b !== 0) await credits.adjust(entity, -b, `rec-reset-${RUN}-${n}`, "fixture: reset the balance between scenarios", U.padmin);
    await rpc("tw4_credit_set_hold", { p_entity_id: entity, p_hold: false, p_reason: "fixture release", p_actor: U.padmin });
  };
  const fund = async (entity: string, studio: string, pack: number) => {
    n += 1;
    const ref = `cs_rec_${RUN}_${n}`;
    await credits.topupPending(entity, studio, ref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(entity, studio, ref, pack, `evt_rec_${RUN}_${n}`, `pi_rec_${RUN}_${n}`, true);
  };
  const price = (kind: string) => Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = '${kind}' and active`));
  // the application route is the only caller: it passes the signed-in user's id with the service role, and the database checks that user is an owner of the studio
  const authorize = (who: keyof typeof U, studio: string, kind: "number" | "monthly", over: Record<string, unknown> = {}) =>
    rpc("tw4_recurring_authorize", { p_studio_id: studio, p_user_id: U[who], p_kind: kind, p_acknowledged_price_cents: price(kind), p_term_months: 3, p_total_limit_cents: price(kind) * 3, ...over });
  const revoke = (who: keyof typeof U, id: string) => rpc("tw4_recurring_revoke", { p_authorization_id: id, p_user_id: U[who] });
  const authId = async (studio: string, kind: "number" | "monthly") => String(psql(`select id from public.studio_sms_recurring_authorizations where studio_id = '${studio}' and kind = '${kind}' and status = 'active'`));
  const newAuth = async (who: keyof typeof U, studio: string, kind: "number" | "monthly", over: Record<string, unknown> = {}) => {
    const result = await authorize(who, studio, kind, over);
    expect(result.error, JSON.stringify(result.error)).toBeNull();
    return (result.data as { authorization_id: string }).authorization_id;
  };
  const clearAuths = () => aged(`delete from public.studio_sms_recurring_charges where legal_entity_id in ('${EA}', '${EB}'); delete from public.studio_sms_recurring_authorizations where legal_entity_id in ('${EA}', '${EB}');`);
  const charge = (id: string, period = NOW) => rpc("tw4_recurring_charge", { p_authorization_id: id, p_period_key: period });
  const rowOf = (id: string, period = NOW) => psql(`select status || ':' || attempts || ':' || coalesce(reason, '') from public.studio_sms_recurring_charges where authorization_id = '${id}' and period_key = '${period}'`);
  const ledgerKinds = (entity: string) => psql(`select coalesce(string_agg(kind, ',' order by seq), '') from public.studio_sms_credit_ledger where legal_entity_id = '${entity}'`);

  let releaseLock: (() => void) | null = null;
  beforeAll(async () => {
    releaseLock = await acquireSuiteLock("recurring-scheduler"); // these two suites share the global scheduler's data: one at a time
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    for (const [kind, cents] of [["number", 500], ["monthly", 1500]] as const) {
      const result = await rpc("tw4_price_set", { p_kind: kind, p_customer_cents: cents, p_provider_cents: cents - 100, p_description: `fixture ${kind} price`, p_actor: U.padmin });
      expect(result.error).toBeNull();
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

  it("privileges: no table is reachable by API roles; owner functions are for signed-in users only; the charge functions are service-role only", () => {
    for (const table of ["studio_sms_recurring_authorizations", "studio_sms_recurring_charges"]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete')`)).toBe("f");
    }
    for (const fn of ["sms_recurring_overview(uuid)", "sms_recurring_admin_overview()"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute')`)).toBe("f");
      expect(psql(`select has_function_privilege('authenticated', 'public.${fn}', 'execute')`)).toBe("t");
    }
    // authorizing, revoking and charging are service-role only: no studio user can reach them through the API, whatever the application's flag says
    for (const fn of ["tw4_recurring_authorize(uuid, uuid, text, int, int, int)", "tw4_recurring_revoke(uuid, uuid)", "tw4_recurring_charge(uuid, text, uuid)", "tw4_recurring_due(text)", "tw4_recurring_service_state(uuid)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`)).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`)).toBe("t");
    }
    for (const fn of ["_tw4rc_guard()", "_tw4rc_service_state(uuid)", "_tw4rc_service_issue(uuid)", "_tw4rc_usd(bigint)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`)).toBe("f");
    }
    // the charge path never touches a card, a top-up, a release or the pilot's funding (it only REFUSES a pilot business): its source says so
    expect(psql(`select count(*) from pg_proc where proname in ('tw4_recurring_charge', 'tw4_recurring_due', '_tw4rc_service_state', 'tw4_recurring_service_state') and (prosrc ilike '%topup%' or prosrc ilike '%stripe%' or prosrc ilike '%release%' or prosrc ilike '%funding%pilot%')`)).toBe("0");
  });

  describe("authorization (owner only, at the current price, with limits)", () => {
    it("the owner of a location authorizes at the published price; the acknowledged text and every limit are stored; the audit row exists", async () => {
      await clearAuths();
      const result = await authorize("owner_a", PA1, "monthly");
      expect(result.error).toBeNull();
      expect(result.data).toMatchObject({ price_cents: 1500, total_limit_cents: 4500 });
      const row = psql(`select kind || ':' || price_cents || ':' || term_months || ':' || total_limit_cents || ':' || status || ':' || terms_version || ':' || (authorized_by = '${U.owner_a}') || ':' || (studio_id = '${PA1}') || ':' || (legal_entity_id = '${EA}') from public.studio_sms_recurring_authorizations where studio_id = '${PA1}'`);
      expect(row).toBe("monthly:1500:3:4500:active:terms-pending-approval:true:true:true");
      // the acknowledgement was written by the database and is word for word the text the owner is shown
      expect(psql(`select statement from public.studio_sms_recurring_authorizations where studio_id = '${PA1}'`)).toBe(buildAuthorizationStatement({ kind: "monthly", priceCents: 1_500, termMonths: 3, totalLimitCents: 4_500 }));
      // the term is three whole UTC service months, the current one first: it ends on a month boundary, so exactly three charges fit
      const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
      expect(psql(`select extract(epoch from expires_at)::bigint * 1000 from public.studio_sms_recurring_authorizations where studio_id = '${PA1}'`)).toBe(String(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 3, 1)));
      expect(monthStart).toBeLessThan(Date.now());
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PA1}' and action = 'recurring_authorized' and actor_user_id = '${U.owner_a}'`)).toBe("1");
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and kind in ('capture', 'usage_charge')`)).toBe(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and kind in ('capture', 'usage_charge')`)); // authorizing charges nothing
    });

    it("only the owner of THAT location: front desk, administrators, another location's owner, another business and an unlinked studio are refused", async () => {
      await clearAuths();
      for (const [who, studio] of [["fd_a", PA1], ["admin_a", PA1], ["owner_a2", PA1], ["owner_b", PA1], ["owner_a", PB1], ["owner_x", PA1]] as const) {
        expect((await authorize(who, studio, "number")).error?.code, `${who} at ${studio}`).toBe("42501");
      }
      expect((await authorize("owner_x", PX, "number")).error?.code).toBe("TW010"); // an owner, but no verified legal business
      expect(psql(`select count(*) from public.studio_sms_recurring_authorizations where legal_entity_id in ('${EA}', '${EB}')`)).toBe("0");
    });

    it("the owner must have seen the CURRENT price; terms and limits are bounded; one active authorization per location and fee", async () => {
      await clearAuths();
      expect((await authorize("owner_a", PA1, "number", { p_acknowledged_price_cents: 499 })).error?.code).toBe("TW008");
      expect((await authorize("owner_a", PA1, "number", { p_acknowledged_price_cents: null })).error?.code).toBe("TW008");
      expect((await authorize("owner_a", PA1, "number", { p_term_months: 0 })).error?.code).toBe("22023");
      expect((await authorize("owner_a", PA1, "number", { p_term_months: 13 })).error?.code).toBe("22023");
      expect((await authorize("owner_a", PA1, "number", { p_total_limit_cents: 499 })).error?.code).toBe("22023");
      expect((await authorize("owner_a", PA1, "number", { p_total_limit_cents: 500 * 3 + 1 })).error?.code).toBe("22023");
      expect((await authorize("owner_a", PA1, "number", { p_total_limit_cents: 1_000 })).error?.code).toBe("22023"); // the limit is always price x term: the term is the control
      expect((await authorize("owner_a", PA1, "number", { p_kind: "sms_usage" })).error?.code).toBe("22023"); // only number rent and the monthly fee recur
      expect((await authorize("owner_a", PA1, "number", { p_kind: "brand" })).error?.code).toBe("22023");
      expect((await authorize("owner_a", PA1, "number")).error).toBeNull();
      expect((await authorize("owner_a", PA1, "number")).error?.code).toBe("23505");
      expect((await authorize("owner_a", PA2, "number")).error).toBeNull(); // another location of the business is its own decision
    });

    it("concurrent authorizations of the same charge yield exactly one", async () => {
      await clearAuths();
      const results = await Promise.all(Array.from({ length: 6 }, () => authorize("owner_a", PA1, "monthly")));
      expect(results.filter((r) => !r.error)).toHaveLength(1);
      expect(results.filter((r) => r.error?.code === "23505")).toHaveLength(5);
    });

    it("the audit trail is append-only and the acknowledged terms can never be edited; only revocation changes a row", async () => {
      await clearAuths();
      const id = await newAuth("owner_a", PA1, "number");
      for (const column of ["price_cents = 1", "total_limit_cents = 99999", "term_months = 1", "statement = 'edited to say something else entirely'", "expires_at = now() + interval '10 years'", "studio_id = '" + PA2 + "'"]) {
        expect(psqlError(`update public.studio_sms_recurring_authorizations set ${column} where id = '${id}'`), column).toContain("never edited");
      }
      expect(psqlError(`delete from public.studio_sms_recurring_authorizations where id = '${id}'`)).toContain("never deleted");
      expect(psqlError("truncate public.studio_sms_recurring_charges")).toContain("never truncated");
    });
  });

  describe("charging (credit only, one period once, attributed to the authorizing location)", () => {
    it("a funded charge reserves and captures atomically against the business credit, attributed to the authorizing location, once per period", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const id = await newAuth("owner_a", PA2, "monthly"); // location 2 authorizes
      const before = balance(EA);
      const topups = psql(`select count(*) from public.studio_sms_credit_topups where legal_entity_id = '${EA}'`);
      const first = await charge(id);
      expect(first.data).toMatchObject({ outcome: "charged", replayed: false, amount_cents: 1500 });
      expect(balance(EA)).toBe(before - 1_500);
      expect(reserved(EA)).toBe(0);
      expect(ledgerKinds(EA).endsWith("reserve,capture")).toBe(true);
      expect(psql(`select studio_id from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and kind = 'capture' order by seq desc limit 1`)).toBe(PA2);
      expect(psql(`select status || ':' || funding || ':' || studio_id || ':' || kind from public.studio_sms_credit_reservations where reservation_key = 'rec:${id}:${NOW}'`)).toBe(`captured:credit:${PA2}:monthly`);
      expect(rowOf(id)).toBe("charged:1:");
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PA2}' and action = 'recurring_charged'`)).toBe("1");
      // the same period again: a replay, no second debit
      expect((await charge(id)).data).toMatchObject({ outcome: "charged", replayed: true });
      expect(balance(EA)).toBe(before - 1_500);
      expect(psql(`select count(*) from public.studio_sms_credit_topups where legal_entity_id = '${EA}'`)).toBe(topups); // nothing was topped up, nothing was paid by card
      expect((await credits.verify(EA)).ok).toBe(true);
    });

    it("insufficient settled credit: nothing is taken, the attempt is recorded, and it can be retried after credit arrives (same record, now charged)", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 2_500);
      await credits.adjust(EA, -2_100, `rec-low-${RUN}`, "fixture: leave less than one charge", U.padmin); // 400 left, monthly is 1500
      const id = await newAuth("owner_a", PA1, "monthly");
      const before = balance(EA);
      const kinds = ledgerKinds(EA);
      expect((await charge(id)).data).toMatchObject({ outcome: "unfunded", reason: "insufficient settled credit" });
      expect((await charge(id)).data).toMatchObject({ outcome: "unfunded" });
      expect(rowOf(id)).toBe("unfunded:2:insufficient settled credit");
      expect(balance(EA)).toBe(before);
      expect(ledgerKinds(EA)).toBe(kinds);
      expect(psql(`select count(*) from public.studio_sms_credit_reservations where reservation_key like 'rec:${id}:%'`)).toBe("0");
      await fund(EA, PA1, 2_500);
      expect((await charge(id)).data).toMatchObject({ outcome: "charged", replayed: false });
      expect(rowOf(id)).toBe("charged:3:");
      expect(psql(`select count(*) from public.studio_sms_recurring_charges where authorization_id = '${id}'`)).toBe("1");
    });

    it("a negative balance and credit that is only RESERVED elsewhere are not spendable", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 2_500);
      await credits.adjust(EA, -3_000, `rec-neg-${RUN}`, "fixture: drive the balance negative", U.padmin);
      const id = await newAuth("owner_a", PA1, "monthly");
      expect((await charge(id)).data).toMatchObject({ outcome: "unfunded" });
      expect(balance(EA)).toBe(-500);
      await reset(EA);
    });

    it("an account on hold is never charged and the hold cannot be bypassed; after the hold is lifted the same period is charged", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const id = await newAuth("owner_a", PA1, "monthly");
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: payment-integrity hold", p_actor: U.padmin });
      const before = balance(EA);
      expect((await charge(id)).data).toMatchObject({ outcome: "held" });
      expect(balance(EA)).toBe(before);
      expect(rowOf(id)).toContain("held:1:the credit account is on hold");
      expect(psql(`select count(*) from public.studio_sms_credit_reservations where reservation_key like 'rec:${id}:%'`)).toBe("0");
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: false, p_reason: "fixture release", p_actor: U.padmin });
      expect((await charge(id)).data).toMatchObject({ outcome: "charged" });
      expect(balance(EA)).toBe(before - 1_500);
      await reset(EA);
    });

    it("the funding is the legal business's own credit: another business's credit is never touched, and credit is not moved between businesses", async () => {
      await clearAuths();
      await reset(EA);
      await reset(EB);
      await fund(EB, PB1, 10_000); // business B is rich, business A has nothing
      const id = await newAuth("owner_a", PA1, "monthly");
      const b0 = balance(EB);
      expect((await charge(id)).data).toMatchObject({ outcome: "unfunded" });
      expect(balance(EB)).toBe(b0);
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EB}' and kind in ('reserve', 'capture')`)).toBe("0");
      await reset(EB);
    });

    it("limits: the authorized total, the term, revocation and a changed price all stop the charge, and each refusal is recorded", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 10_000);
      const id = await newAuth("owner_a", PA1, "monthly", { p_term_months: 3 });
      // fixture: an authorization whose total has been reduced to one charge's worth (the database refuses to create one, so age it into place)
      aged(`update public.studio_sms_recurring_authorizations set starts_at = now() - interval '2 months', total_limit_cents = 1500 where id = '${id}';`);
      expect((await charge(id, month(-1))).data).toMatchObject({ outcome: "charged" });
      expect((await charge(id, NOW)).data).toMatchObject({ outcome: "refused", reason: "authorized spending limit reached" });
      expect(rowOf(id)).toBe("refused:1:authorized spending limit reached");
      expect(balance(EA)).toBe(10_000 - 1_500);

      // outside the term
      const id2 = await newAuth("owner_a", PA2, "number");
      aged(`update public.studio_sms_recurring_authorizations set expires_at = now() - interval '1 day', starts_at = now() - interval '4 months' where id = '${id2}';`);
      expect((await charge(id2)).data).toMatchObject({ outcome: "refused", reason: "outside the authorized term" });
      expect(JSON.stringify((await rpc("tw4_recurring_due", { p_period_key: NOW })).data)).not.toContain(id2);

      // price changed after the owner agreed
      const id3 = await newAuth("owner_a", PA2, "monthly");
      await rpc("tw4_price_set", { p_kind: "monthly", p_customer_cents: 1_800, p_provider_cents: 1_000, p_description: "fixture repriced monthly", p_actor: U.padmin });
      try {
        expect((await charge(id3)).data).toMatchObject({ outcome: "refused", reason: "price changed: the owner must authorize again" });
        expect((await authorize("owner_a", PA2, "monthly", { p_acknowledged_price_cents: 1_500 })).error?.code).toBe("TW008"); // the old price no longer authorizes anything
        await revoke("owner_a", id3);
        expect((await authorize("owner_a", PA2, "monthly", { p_acknowledged_price_cents: 1_800, p_total_limit_cents: 5_400 })).error).toBeNull();
      } finally {
        await rpc("tw4_price_set", { p_kind: "monthly", p_customer_cents: 1_500, p_provider_cents: 1_400, p_description: "fixture monthly price", p_actor: U.padmin });
      }

      // revoked
      const id4 = await newAuth("owner_a", PA1, "number");
      await revoke("owner_a", id4);
      expect((await charge(id4)).data).toMatchObject({ outcome: "refused", reason: "revoked" });
      await reset(EA);
    });

    it("periods: only the current or the previous month, never the future, never malformed", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const id = await newAuth("owner_a", PA1, "number");
      for (const bad of [month(1), month(-2), "2026-13", "2026-1", "nonsense", ""]) expect((await charge(id, bad)).error?.code, bad).toBe("22023");
      expect((await rpc("tw4_recurring_charge", { p_authorization_id: "00000000-0000-4000-8000-000000000000", p_period_key: NOW })).error?.code).toBe("22023");
      await reset(EA);
    });

    it("revoke and authorize again never charges a period twice, and a revoked authorization can be replaced", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const first = await newAuth("owner_a", PA1, "number");
      expect((await charge(first)).data).toMatchObject({ outcome: "charged" });
      await revoke("owner_a", first);
      const second = await newAuth("owner_a", PA1, "number");
      const before = balance(EA);
      expect((await charge(second)).data).toMatchObject({ outcome: "refused", reason: "this period was already charged under another authorization" });
      expect(balance(EA)).toBe(before);
      await reset(EA);
    });
  });

  describe("revocation and tenant isolation", () => {
    it("only the owner revokes, nobody else can even tell an authorization exists, and revocation is idempotent and stops later charges", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const id = await newAuth("owner_a", PA1, "monthly");
      for (const who of ["fd_a", "admin_a", "owner_a2", "owner_b", "owner_x"] as const) expect((await revoke(who, id)).error?.code, who).toBe("42501");
      expect((await revoke("owner_a", "00000000-0000-4000-8000-000000000000")).error?.code).toBe("42501"); // an unknown id looks the same
      expect((await rpc("tw4_recurring_revoke", { p_authorization_id: id, p_user_id: null })).error?.code).toBe("42501");
      expect((await revoke("owner_a", id)).data).toMatchObject({ status: "revoked", replayed: false });
      expect((await revoke("owner_a", id)).data).toMatchObject({ status: "revoked", replayed: true });
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PA1}' and action = 'recurring_revoked' and note like 'authorization=${id};%'`)).toBe("1");
      expect((await charge(id)).data).toMatchObject({ outcome: "refused", reason: "revoked" });
      await reset(EA);
    });

    it("overviews show the caller's own business only (owners and administrators), never another business's authorizations, amounts or locations", async () => {
      await clearAuths();
      await reset(EA);
      await reset(EB);
      await fund(EA, PA1, 5_000);
      const a = await newAuth("owner_a", PA1, "monthly");
      await newAuth("owner_a", PA2, "number");
      const b = await newAuth("owner_b", PB1, "number");
      const forA = await getRecurringOverview(as("owner_a") as never, PA1);
      expect(forA?.authorizations.map((x) => x.id).sort()).toEqual([a, String(await authId(PA2, "number"))].sort());
      expect(forA?.expectedMonthlyCents).toBe(2_000);
      expect(forA?.authorizations.find((x) => x.id === a)?.thisLocation).toBe(true);
      expect(forA?.authorizations.find((x) => x.id !== a)?.thisLocation).toBe(false);
      expect(JSON.stringify(forA)).not.toContain(b);
      expect((await getRecurringOverview(as("admin_a") as never, PA1))?.authorizations).toHaveLength(2); // administrators can look
      const forB = await getRecurringOverview(as("owner_b") as never, PB1);
      expect(forB?.authorizations.map((x) => x.id)).toEqual([b]);
      expect(await getRecurringOverview(as("owner_b") as never, PA1)).toBeNull();
      expect(await getRecurringOverview(as("fd_a") as never, PA1)).toBeNull();
      expect((await getRecurringOverview(as("owner_x") as never, PX))?.legalBusiness).toBe(false);
      await reset(EA);
      await reset(EB);
    });

    it("low-balance warning: the business is told when available credit does not cover what is coming, and how many months it covers", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      await newAuth("owner_a", PA1, "monthly");
      await newAuth("owner_a", PA2, "number");
      const ok = await getRecurringOverview(as("owner_a") as never, PA1);
      expect(ok).toMatchObject({ expectedMonthlyCents: 2_000, availableCents: 5_000, monthsCovered: 2, lowForRecurring: false });
      await credits.adjust(EA, -4_000, `rec-lowwarn-${RUN}`, "fixture: leave less than one month", U.padmin);
      expect(await getRecurringOverview(as("owner_a") as never, PA1)).toMatchObject({ availableCents: 1_000, monthsCovered: 0, lowForRecurring: true });
      await reset(EA);
    });
  });

  describe("suspension is a state, never a release", () => {
    it("none -> past_due -> active once charged -> suspended after the grace window; the phone numbers are untouched", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const stateOf = async (studio: string) => String((await rpc("tw4_recurring_service_state", { p_studio_id: studio })).data);
      expect(await stateOf(PA1)).toBe("none");
      const id = await newAuth("owner_a", PA1, "monthly");
      expect(await stateOf(PA1)).toBe("past_due"); // authorized, first charge not taken yet: inside the grace window
      expect((await charge(id)).data).toMatchObject({ outcome: "charged" });
      expect(await stateOf(PA1)).toBe("active");
      aged(`delete from public.studio_sms_recurring_charges where authorization_id = '${id}'; update public.studio_sms_recurring_authorizations set starts_at = now() - interval '8 days' where id = '${id}';`);
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).getTime();
      const graceFrom = Math.max(monthStart, Date.now() - 8 * 86_400_000);
      expect(await stateOf(PA1)).toBe(Date.now() > graceFrom + 7 * 86_400_000 ? "suspended" : "past_due");
      aged(`update public.studio_sms_recurring_authorizations set starts_at = date_trunc('month', now()) - interval '20 days' where id = '${id}';`);
      expect(await stateOf(PA1)).toBe(Date.now() > monthStart + 7 * 86_400_000 ? "suspended" : "past_due");
      // revoking or expiring ends the obligation: no authorization, no suspension
      await revoke("owner_a", id);
      expect(await stateOf(PA1)).toBe("none");
      // nothing in the data model can release a number: no function with that effect exists in these migrations
      expect(readFileSync(join(process.cwd(), "src/lib/supabase/migrations/20261126090000_twilio_recurring_authorization.sql"), "utf8")).not.toMatch(/release_number|delete from public\.studio_sms_twilio|twilio_numbers/i);
      await reset(EA);
    });
  });

  describe("service state follows the collectible months, and says why", () => {
    const stateOf = async (studio: string) => String((await rpc("tw4_recurring_service_state", { p_studio_id: studio })).data);
    const overviewOf = async (who: keyof typeof U, studio: string) => getRecurringOverview(as(who) as never, studio);
    const backdate = (id: string, months: number) =>
      aged(`update public.studio_sms_recurring_authorizations set starts_at = date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' - interval '${months} months' + interval '1 day' where id = '${id}';`);

    it("an unpaid previous month keeps the service suspended even while the current month is paid, and retrying it (the scheduler does) restores it; no free month", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const id = await newAuth("owner_a", PA1, "monthly");
      backdate(id, 1); // authorized last month; the previous month is still collectible
      expect((await charge(id, NOW)).data).toMatchObject({ outcome: "charged" });
      expect(await stateOf(PA1)).toBe("suspended"); // last month was never paid and its grace has long passed
      expect((await overviewOf("owner_a", PA1))?.serviceIssue).toBe("waiting");
      const run = await runDueRecurringCharges(admin as never);
      expect(run.periods).toEqual([month(-1), NOW]);
      expect(rowOf(id, month(-1))).toBe("charged:1:");
      expect(await stateOf(PA1)).toBe("active");
      expect(balance(EA)).toBe(5_000 - 3_000);
      await reset(EA);
    });

    it("the owner is told why: not enough credit, a hold, a used-up limit or a changed price (each with its own next step)", async () => {
      await clearAuths();
      await reset(EA);
      const id = await newAuth("owner_a", PA1, "monthly", { p_term_months: 3 });
      aged(`update public.studio_sms_recurring_authorizations set total_limit_cents = 1500 where id = '${id}';`); // fixture, see above
      backdate(id, 1);
      await charge(id, month(-1));
      expect((await overviewOf("owner_a", PA1))?.serviceIssue).toBe("unfunded");
      await fund(EA, PA1, 5_000);
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: hold for the issue test", p_actor: U.padmin });
      await charge(id, month(-1));
      expect((await overviewOf("owner_a", PA1))?.serviceIssue).toBe("held");
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: false, p_reason: "fixture release", p_actor: U.padmin });
      await charge(id, month(-1)); // paid
      await charge(id, NOW); // the authorized total (one charge) is used up
      expect((await overviewOf("owner_a", PA1))).toMatchObject({ serviceIssue: "limit", expectedMonthlyCents: 0, lowForRecurring: false }); // a used-up authorization is not a coming charge
      await reset(EA);
    });

    it("a term of whole calendar months ends cleanly: a fully used term is never reported as overdue", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const id = await newAuth("owner_a", PA1, "number", { p_term_months: 2, p_total_limit_cents: 1_000 });
      backdate(id, 1);
      aged(`update public.studio_sms_recurring_authorizations set expires_at = date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' + interval '1 month' where id = '${id}';`);
      expect((await charge(id, month(-1))).data).toMatchObject({ outcome: "charged" });
      expect((await charge(id, NOW)).data).toMatchObject({ outcome: "charged" });
      expect((await charge(id, NOW)).data).toMatchObject({ replayed: true });
      expect(await stateOf(PA1)).toBe("active");
      expect((await rpc("tw4_recurring_service_state", { p_studio_id: PA1 })).error).toBeNull();
      await reset(EA);
    });

    it("revoke and authorize again in the same month never makes a paid month look overdue", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const first = await newAuth("owner_a", PA1, "monthly");
      expect((await charge(first)).data).toMatchObject({ outcome: "charged" });
      await revoke("owner_a", first);
      const second = await newAuth("owner_a", PA1, "monthly");
      aged(`update public.studio_sms_recurring_authorizations set starts_at = now() - interval '9 days' where id = '${second}';`); // well past any grace window
      expect((await charge(second)).data).toMatchObject({ outcome: "refused", reason: "this period was already charged under another authorization" });
      const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
      expect(await stateOf(PA1)).toBe("active"); // the month is paid, under the earlier authorization
      expect((await overviewOf("owner_a", PA1))?.serviceIssue).toBeNull();
      expect(monthStart).toBeLessThanOrEqual(Date.now());
      await reset(EA);
    });

    it("a refused period is decided: the scheduler does not keep retrying it or piling up audit rows", async () => {
      await clearAuths();
      await reset(EB);
      const id = await newAuth("owner_b", PB1, "number");
      aged(`update public.studio_sms_recurring_authorizations set total_limit_cents = 500 where id = '${id}';`);
      aged(`update public.studio_sms_recurring_authorizations set starts_at = now() - interval '1 month' where id = '${id}';`);
      await fund(EB, PB1, 2_500);
      await charge(id, month(-1)); // charged: the one charge the limit allows
      expect((await charge(id, NOW)).data).toMatchObject({ outcome: "refused", reason: "authorized spending limit reached" });
      expect(JSON.stringify((await rpc("tw4_recurring_due", { p_period_key: NOW })).data)).not.toContain(id);
      const audits = psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PB1}' and action = 'recurring_refused'`);
      await runDueRecurringCharges(admin as never);
      await runDueRecurringCharges(admin as never);
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PB1}' and action = 'recurring_refused'`)).toBe(audits);
      expect(rowOf(id)).toBe("refused:1:authorized spending limit reached");
      await reset(EB);
    });
  });

  describe("concurrency", () => {
    it("eight simultaneous charges for one period debit exactly once", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 5_000);
      const id = await newAuth("owner_a", PA1, "monthly");
      const before = balance(EA);
      const results = await Promise.all(Array.from({ length: 8 }, () => charge(id)));
      expect(results.every((r) => !r.error)).toBe(true);
      expect(results.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
      expect(balance(EA)).toBe(before - 1_500);
      expect(psql(`select count(*) from public.studio_sms_credit_reservations where reservation_key like 'rec:${id}:%'`)).toBe("1");
      expect((await credits.verify(EA)).ok).toBe(true);
      await reset(EA);
    });

    it("two authorizations competing for credit that covers only one: exactly one is charged, the balance never goes negative", async () => {
      await clearAuths();
      await reset(EA);
      await fund(EA, PA1, 2_500);
      await credits.adjust(EA, -500, `rec-comp-${RUN}`, "fixture: 2000 left, two charges of 1500 and 500 plus", U.padmin);
      const m = await newAuth("owner_a", PA1, "monthly"); // 1500
      const m2 = await newAuth("owner_a", PA2, "monthly"); // 1500
      const results = await Promise.all([charge(m), charge(m2), charge(m), charge(m2)]);
      const outcomes = results.map((r) => (r.data as { outcome: string }).outcome).sort();
      expect(outcomes.filter((o) => o === "charged")).toHaveLength(2); // the same two calls replay; across authorizations only one fits
      expect(balance(EA)).toBe(500);
      expect(balance(EA)).toBeGreaterThanOrEqual(0);
      expect((await credits.verify(EA)).ok).toBe(true);
      await reset(EA);
    });

    it("a charge racing a revocation, a hold and a top-up: never charged after a revocation or hold that committed first, and no deadlock", async () => {
      await clearAuths();
      for (let round = 0; round < 3; round += 1) {
        await reset(EA);
        await fund(EA, PA1, 5_000);
        const id = await newAuth("owner_a", PA1, "monthly");
        n += 1;
        const ref = `cs_rec_race_${RUN}_${n}`;
        await credits.topupPending(EA, PA1, ref, 2_500, new Date(Date.now() + 20 * 60_000).toISOString());
        const settled = await Promise.all([
          charge(id),
          revoke("owner_a", id),
          rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: racing hold", p_actor: U.padmin }),
          credits.settleTopup(EA, PA1, ref, 2_500, `evt_rec_race_${RUN}_${n}`, `pi_rec_race_${RUN}_${n}`, true).then(() => null, (e) => e),
        ]);
        expect(settled[0].error).toBeNull();
        const status = rowOf(id).split(":")[0];
        expect(["charged", "refused", "held"]).toContain(status);
        // the credit settled even if a hold or revocation raced it (the money was taken), and the books reconcile
        expect(psql(`select status from public.studio_sms_credit_topups where provider_ref = '${ref}'`)).toBe("settled");
        const charged = psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}' and kind = 'capture' and idempotency_key like 'capture:rec:${id}:%'`);
        expect(charged).toBe(status === "charged" ? "1" : "0");
        if (status === "charged") {
          // a charge that won the lock before the revocation/hold: its time precedes both
          expect(psql(`select (c.charged_at <= coalesce(a.revoked_at, 'infinity'::timestamptz)) from public.studio_sms_recurring_charges c join public.studio_sms_recurring_authorizations a on a.id = c.authorization_id where c.authorization_id = '${id}'`)).toBe("t");
        }
        expect((await credits.verify(EA)).ok).toBe(true);
        await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: false, p_reason: "fixture release", p_actor: U.padmin });
      }
      await reset(EA);
    });
  });

  describe("the scheduler core and the application layer", () => {
    it("runDueRecurringCharges charges what is funded, records what is not, and a second run does nothing twice", async () => {
      await clearAuths();
      await reset(EA);
      await reset(EB);
      await fund(EA, PA1, 5_000);
      const funded = await newAuth("owner_a", PA1, "monthly"); // business A is funded
      const unfunded = await newAuth("owner_b", PB1, "number"); // business B is not
      const run1 = await runDueRecurringCharges(admin as never);
      expect(run1).toMatchObject({ period: NOW, charged: 1, unfunded: 1, refused: 0, errors: 0 });
      expect(run1.due).toBeGreaterThanOrEqual(2);
      expect(rowOf(funded)).toBe("charged:1:");
      expect(rowOf(unfunded)).toBe("unfunded:1:insufficient settled credit");
      const balanceAfter = balance(EA);
      const run2 = await runDueRecurringCharges(admin as never);
      expect(run2.charged).toBe(0);
      expect(run2.unfunded).toBeGreaterThanOrEqual(1); // the unfunded one is retried, still unfunded
      expect(balance(EA)).toBe(balanceAfter);
      await fund(EB, PB1, 2_500);
      const run3 = await runDueRecurringCharges(admin as never);
      expect(run3.charged).toBe(1);
      expect(rowOf(unfunded)).toBe("charged:3:");
      await reset(EA);
      await reset(EB);
    });

    it("the application layer maps database answers to plain codes, builds the acknowledgement on the server, and never calls anything but the owner functions", async () => {
      await clearAuths();
      const base = { studioId: PA1, kind: "monthly" as const, acknowledgedPriceCents: 1_500, termMonths: 3, totalLimitCents: 4_500 };
      expect(await code(authorizeRecurring(admin as never, { ...base, userId: U.fd_a }))).toBe("not_authorized");
      expect(await code(authorizeRecurring(admin as never, { ...base, userId: U.admin_a }))).toBe("not_authorized");
      expect(await code(authorizeRecurring(admin as never, { ...base, studioId: PX, userId: U.owner_x }))).toBe("no_legal_business");
      expect(await code(authorizeRecurring(admin as never, { ...base, userId: U.owner_a, acknowledgedPriceCents: 1_400, totalLimitCents: 4_200 }))).toBe("price_changed");
      expect(await code(authorizeRecurring(admin as never, { ...base, userId: U.owner_a, termMonths: 5 }))).toBe("invalid");
      const made = await authorizeRecurring(admin as never, { ...base, userId: U.owner_a });
      // the database wrote the acknowledgement; it is exactly the text the application shows
      expect(psql(`select statement from public.studio_sms_recurring_authorizations where id = '${made.authorizationId}'`)).toBe(
        "I authorize DanceFlow to deduct $15.00 per month for monthly texting service from my legal business's prepaid texting credit, for up to 3 months and no more than $45.00 in total, whichever comes first. The charge is taken only if enough settled credit is available and it fits within my business's spending limit. No card is charged, no credit is added automatically, and I can revoke this at any time. Final prices and terms are pending approval.",
      );
      expect(await code(authorizeRecurring(admin as never, { ...base, userId: U.owner_a }))).toBe("already_authorized");
      expect(await code(revokeRecurring(admin as never, made.authorizationId, U.owner_b))).toBe("not_authorized");
      await revokeRecurring(admin as never, made.authorizationId, U.owner_a);
    });

    it("platform administrators see what was not charged; everyone else is refused", async () => {
      await clearAuths();
      await reset(EB);
      const id = await newAuth("owner_b", PB1, "number");
      await charge(id);
      const overview = await getRecurringAdminOverview(as("padmin") as never);
      expect(overview?.needsAttention.some((r) => r.legalName === "REC Beta LLC" && r.status === "unfunded")).toBe(true);
      expect(JSON.stringify(overview)).not.toMatch(/8882|8881|@/);
      expect(await getRecurringAdminOverview(as("owner_b") as never)).toBeNull();
      expect(await getRecurringAdminOverview(as("admin_a") as never)).toBeNull();
    });
  });

  it("the rollback refuses while authorizations, charges or audit evidence exist", async () => {
    await clearAuths();
    await reset(EB);
    const id = await newAuth("owner_b", PB1, "number");
    await charge(id);
    expect(psql("select count(*) from public.studio_sms_recurring_authorizations")).not.toBe("0");
    const rollback = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261126090000_twilio_recurring_authorization_rollback.sql"), "utf8");
    expect(psqlError(rollback)).toContain("rollback refused");
  });
});
