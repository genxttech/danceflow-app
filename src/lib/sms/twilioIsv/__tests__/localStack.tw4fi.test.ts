/**
 * TW-4F financial integrity (20261202090000) against a REAL schema, real SQL functions through PostgREST (service role) and real JWTs:
 *   1. approval references are permanent (one written approval = one operation, once, across every legal business), with full linkage, under retries,
 *      replays, withdrawal, release, capture, concurrency, cross-tenant attempts and direct writes;
 *   2. the Low-Volume Standard price kinds follow the location's VERIFIED registration path in authorizations, reservations, settlements, recurring
 *      authorizations and tier changes; the Standard kinds are refused on that path.
 * Synthetic fixtures with their own id block. Only the two LOW-VOLUME kinds get (local, synthetic) prices, so suites that expect no Standard price are
 * unaffected; every row this suite writes is removed afterwards. Nothing reaches Twilio or Stripe.
 * LOCAL QA STACK ONLY (skipped unless the variables point at a loopback stack with the migrations through 20261202090000 applied):
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteFixtureRequestsSql, deletePricesSql, seedPrice, seedPriceSql } from "./priceFixture";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

import { buildAuthorizationStatement } from "@/lib/billing/smsRecurring";
import { SupabaseCreditStore } from "../creditStore";
import { SupabaseRunnerStore } from "../store";

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

const LA1 = "af100000-0000-4000-8000-00000000000a"; // business A, Low-Volume Standard (verified)
const LA2 = "af100000-0000-4000-8000-00000000000b"; // business A, Standard (no onboarding)
const LB1 = "af100000-0000-4000-8000-00000000000c"; // business B, Low-Volume Standard (verified)
const LU1 = "af100000-0000-4000-8000-00000000000d"; // business U, Low-Volume Standard chosen WITHOUT the eligibility record (unverified)
const EA = "ef100000-0000-4000-8000-0000000000a1";
const EB = "ef100000-0000-4000-8000-0000000000b1";
const EU = "ef100000-0000-4000-8000-0000000000c1";
const OA1 = "0f100000-0000-4000-8000-0000000000a1";
const OB1 = "0f100000-0000-4000-8000-0000000000b1";
const OU1 = "0f100000-0000-4000-8000-0000000000c1";
const U = {
  owner_a: "af100000-0000-4000-8000-000000000101",
  owner_b: "af100000-0000-4000-8000-000000000201",
  padmin: "af100000-0000-4000-8000-000000000401",
  padmin2: "af100000-0000-4000-8000-000000000402",
};
const RUN = randomBytes(3).toString("hex");
const CHECKLIST = { ein_registered: true, not_sole_proprietor: true, low_volume_expected: true, owner_informed_limits: true, owner_informed_review: true };
const LVS_BRAND = 700;
const LVS_MONTHLY = 250;

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
/** Runs a script and returns its error output with SQLSTATEs (empty when it succeeded). */
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};

const ENTITIES = `'${EA}', '${EB}', '${EU}'`;
const STUDIOS = `'${LA1}', '${LA2}', '${LB1}', '${LU1}'`;
const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_approval_refs where legal_entity_id in (${ENTITIES});
update public.studio_sms_recurring_charges set run_id = null where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_charges where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_authorizations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_monthly_limits where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_timezones where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_limit_ceilings where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_spend_events where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_ledger where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_reservations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES}));
delete from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_accounts where legal_entity_id in (${ENTITIES});
${deleteFixtureRequestsSql(U.padmin)}
${deletePricesSql(`created_by = '${U.padmin}'`)}
delete from public.studio_sms_tier_decisions where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding where studio_id in (${STUDIOS});
delete from public.studio_sms_entity_studios where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_legal_entities where id in (${ENTITIES});
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in (${Object.values(U).map((u) => `'${u}'`).join(", ")});
delete from auth.users where email like '%@tw4fi-e2e.test';
commit;`;
const onboardingRow = (id: string, studio: string, last4: string, tier: string | null) =>
  `('${id}', '${studio}', 'submitted_for_checks', ${tier ? `'${tier}'` : "null"}, 'FI ${last4} Dance LLC', 'llc', '${last4}', 1, now())`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4fi-e2e.test', now(), now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.owner_b}', 'owner_b'), ('${U.padmin}', 'padmin'), ('${U.padmin2}', 'padmin2')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.owner_b}', null), ('${U.padmin}', 'platform_admin'), ('${U.padmin2}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values
  ('${LA1}', 'TW4FI Location A1', 'tw4fi-a1', null, 'America/Chicago'), ('${LA2}', 'TW4FI Location A2', 'tw4fi-a2', null, 'America/Chicago'),
  ('${LB1}', 'TW4FI Location B1', 'tw4fi-b1', null, 'America/Denver'), ('${LU1}', 'TW4FI Location U1', 'tw4fi-u1', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${LA1}', 'studio_owner', true), ('${U.owner_a}', '${LA2}', 'studio_owner', true), ('${U.owner_a}', '${LU1}', 'studio_owner', true), ('${U.owner_b}', '${LB1}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'FI Alpha LLC', '8881', 50000, '${U.padmin}'), ('${EB}', 'FI Beta LLC', '8882', 50000, '${U.padmin}'), ('${EU}', 'FI Upsilon LLC', '8883', 50000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${LA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 1', now()),
  ('${LA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 2', now()),
  ('${LB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B', now()),
  ('${LU1}', '${EU}', 'founding', '${U.padmin}', 'fixture: verified business U', now());
commit;
begin;
set local session_replication_role = replica;
insert into public.studio_sms_onboarding (id, studio_id, state, tier, legal_name, entity_type, ein_last4, submission_seq, submitted_at) values
  ${onboardingRow(OA1, LA1, "8881", null)}, ${onboardingRow(OB1, LB1, "8882", null)}, ${onboardingRow(OU1, LU1, "8883", "low_volume_standard")};
commit;`;

describe.skipIf(!enabled)("TW-4F financial integrity: permanent approval references and Low-Volume Standard price kinds (real schema)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let runner: SupabaseRunnerStore;
  let n = 0;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const ref = (label: string) => `Owner email ${RUN} ${label} approving one fee`;
  const authorize = (entity: string, studio: string | null, kind: string, cents: number, approvalRef: string, actor = U.padmin) =>
    rpc("tw4_spend_authorize", { p_entity_id: entity, p_kind: kind, p_amount_cents: cents, p_approval_ref: approvalRef, p_actor: actor, p_funding: "credit", p_studio_id: studio });
  const errCode = async (p: Promise<{ error: { code?: string } | null }>) => (await p).error?.code ?? null;
  const fund = async (entity: string, studio: string, pack: number) => {
    n += 1;
    const pref = `cs_fi_${RUN}_${n}`;
    await credits.topupPending(entity, studio, pref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(entity, studio, pref, pack, `evt_fi_${RUN}_${n}`, `pi_fi_${RUN}_${n}`, true);
  };
  const lease = (onboarding: string, owner: string | null) =>
    psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_onboarding set lease_owner = ${owner ? `'${owner}'` : "null"}, lease_expires_at = ${owner ? "now() + interval '10 minutes'" : "null"}, submission_seq = submission_seq + ${owner ? 1 : 0} where id = '${onboarding}'; commit;`);
  /** withdraws every still-unused approval of a business, so the next reservation binds exactly the approval a scenario just recorded */
  const clearOpen = async (entity: string) => {
    for (const id of psql(`select id from public.studio_sms_spend_events where legal_entity_id = '${entity}' and status = 'authorized'`).split("\n").filter(Boolean)) {
      expect((await rpc("tw4_spend_withdraw", { p_spend_event_id: id, p_actor: U.padmin, p_note: "fixture: clear open approvals between scenarios" })).error).toBeNull();
    }
  };
  const refRows = (approvalRef: string) => Number(psql(`select count(*) from public.studio_sms_approval_refs where ref_norm = public._tw4fi_ref_norm($q$${approvalRef}$q$)`));

  beforeAll(async () => {
    expect(psql(`select to_regclass('public.studio_sms_approval_refs') is not null`)).toBe("t");
    psqlFile(FIXTURES);
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    runner = new SupabaseRunnerStore(admin);
    // the verified Low-Volume Standard path for A1 and B1, through the real tier decision (checklist + EIN match)
    for (const studio of [LA1, LB1]) {
      expect((await rpc("tw4_onboarding_decide_tier", { p_studio_id: studio, p_actor: U.padmin, p_tier: "low_volume_standard", p_reason: "fixture: EIN business, low volume", p_eligibility: CHECKLIST })).error).toBeNull();
    }
    // synthetic, LOCAL-ONLY prices for the two low-volume kinds (DRAFT in reality: nothing is published by the migration)
    seedPrice(psql, { kind: "brand_low_volume", customer: LVS_BRAND, provider: 450, description: "fixture LVS brand", approver: U.padmin });
    seedPrice(psql, { kind: "monthly_low_volume", customer: LVS_MONTHLY, provider: 150, description: "fixture LVM campaign", approver: U.padmin });
    await fund(EA, LA1, 10_000);
    await fund(EB, LB1, 10_000);
  });

  afterAll(() => {
    if (enabled) psqlFile(CLEANUP);
  });

  describe("approval references are permanent", () => {
    it("an authorization registers its reference with the full linkage (business, location, kind, amount, funding, approver)", async () => {
      const r = ref("linkage");
      const { data, error } = await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r);
      expect(error).toBeNull();
      const id = (data as { spend_event_id: string }).spend_event_id;
      expect(psql(`select legal_entity_id || '|' || studio_id || '|' || spend_event_id || '|' || kind || '|' || amount_cents || '|' || funding || '|' || approved_by || '|' || source
                     from public.studio_sms_approval_refs where ref_norm = public._tw4fi_ref_norm($q$${r}$q$)`))
        .toBe(`${EA}|${LA1}|${id}|brand_low_volume|${LVS_BRAND}|credit|${U.padmin}|spend_authorization`);
      expect((await rpc("tw4_spend_withdraw", { p_spend_event_id: id, p_actor: U.padmin, p_note: "fixture: withdraw after linkage check" })).error).toBeNull();
    });

    it("an identical retry of a still-unused authorization returns it (no second authorization); any other variation is refused", async () => {
      const r = ref("retry");
      const first = await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r);
      const again = await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r);
      expect(again.error).toBeNull();
      expect(again.data).toMatchObject({ spend_event_id: (first.data as { spend_event_id: string }).spend_event_id, replayed: true });
      expect(Number(psql(`select count(*) from public.studio_sms_spend_events where approval_ref = $q$${r}$q$`))).toBe(1);
      // another approver, another location, another kind, another amount: never "the same approval"
      expect(await errCode(authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r, U.padmin2))).toBe("TW019");
      expect(await errCode(authorize(EA, null, "brand_low_volume", LVS_BRAND, r))).toBe("TW019");
      expect(await errCode(authorize(EA, LA1, "monthly_low_volume", LVS_MONTHLY, r))).toBe("TW019");
      expect(await errCode(authorize(EA, LA1, "brand_low_volume", LVS_BRAND + 1, r))).toBe("TW019");
      expect(refRows(r)).toBe(1);
      await rpc("tw4_spend_withdraw", { p_spend_event_id: (first.data as { spend_event_id: string }).spend_event_id, p_actor: U.padmin, p_note: "fixture: withdraw after retry check" });
    });

    it("after WITHDRAWAL the reference can never be used again (also not by an identical retry, nor in another spelling)", async () => {
      const r = ref("withdrawn");
      const { data } = await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r);
      expect((await rpc("tw4_spend_withdraw", { p_spend_event_id: (data as { spend_event_id: string }).spend_event_id, p_actor: U.padmin, p_note: "fixture: owner withdrew" })).error).toBeNull();
      expect(await errCode(authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r))).toBe("TW019");
      for (const spelling of [r.toUpperCase(), `  ${r.replaceAll(" ", "   ")}  `, r.replace("Owner", "Ｏｗｎｅｒ"), `${r}\t`]) {
        expect(await errCode(authorize(EA, LA1, "brand_low_volume", LVS_BRAND, spelling))).toBe("TW019");
      }
      expect(Number(psql(`select count(*) from public.studio_sms_spend_events where public._tw4fi_ref_norm(approval_ref) = public._tw4fi_ref_norm($q$${r}$q$)`))).toBe(1);
    });

    it("after a RELEASE (the operation definitely did not happen) and after a CAPTURE (it happened) the reference is spent", async () => {
      for (const outcome of ["released", "captured"] as const) {
        const r = ref(`settled-${outcome}`);
        await clearOpen(EA);
        const made = await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r);
        expect(made.error).toBeNull();
        const owner = `fi-${RUN}-${outcome}`;
        lease(OA1, owner);
        const reserved = await runner.reserveSpend(OA1, owner, "brand_low_volume");
        expect(reserved.amountCents).toBe(LVS_BRAND);
        expect(reserved.spendEventId).toBe((made.data as { spend_event_id: string }).spend_event_id);
        await runner.settleSpend(OA1, owner, "brand_low_volume", outcome, `fixture-${outcome}`);
        lease(OA1, null);
        expect(await errCode(authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r))).toBe("TW019");
        expect(refRows(r)).toBe(1);
      }
    });

    it("another legal business can never use a reference already recorded for a different business (cross-tenant replay)", async () => {
      const r = ref("cross-tenant");
      expect((await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r)).error).toBeNull();
      expect(await errCode(authorize(EB, LB1, "brand_low_volume", LVS_BRAND, r))).toBe("TW019");
      expect(Number(psql(`select count(*) from public.studio_sms_spend_events where legal_entity_id = '${EB}' and approval_ref = $q$${r}$q$`))).toBe(0);
      expect(psql(`select legal_entity_id from public.studio_sms_approval_refs where ref_norm = public._tw4fi_ref_norm($q$${r}$q$)`)).toBe(EA);
    });

    it("spending-limit ceiling approvals and fee approvals never share a reference (both directions)", async () => {
      const fee = ref("ceiling-a");
      expect((await authorize(EB, LB1, "brand_low_volume", LVS_BRAND, fee)).error).toBeNull();
      expect(await errCode(rpc("tw4_limit_ceiling_approve_entity", { p_entity_id: EB, p_actor: U.padmin, p_cents: 60_000, p_approval_ref: fee }))).toBe("TW019");
      const ceiling = ref("ceiling-b");
      expect((await rpc("tw4_limit_ceiling_approve_entity", { p_entity_id: EB, p_actor: U.padmin, p_cents: 60_000, p_approval_ref: ceiling })).error).toBeNull();
      expect(await errCode(authorize(EB, LB1, "brand_low_volume", LVS_BRAND, ceiling))).toBe("TW019");
    });

    it("the pilot exception's founder approval is not an operation approval (in a rolled-back transaction: the pilot slot stays free)", () => {
      if (psql(`select count(*) from public.studio_sms_pilot_exceptions`) !== "0") return; // another suite holds the one pilot slot: covered by its own run
      const founder = ref("pilot-founder");
      const out = psqlError(`begin;
        insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${EU}', 15000, $q$${founder}$q$, '${U.padmin}');
        select public.tw4_spend_authorize('${EA}', 'brand_low_volume', ${LVS_BRAND}, $q$${founder}$q$, '${U.padmin}', 'credit', '${LA1}');
        rollback;`);
      expect(out).toMatch(/TW019/);
      expect(psql(`select count(*) from public.studio_sms_pilot_exceptions`)).toBe("0");
    });

    it("concurrent attempts with ONE reference across two businesses create exactly one authorization; same-business retries replay it", async () => {
      const r = ref("race");
      const results = await Promise.all([EA, EB, EA, EB, EA, EB, EA, EB].map((entity) => authorize(entity, entity === EA ? LA1 : LB1, "brand_low_volume", LVS_BRAND, r)));
      const ok = results.filter((x) => !x.error);
      const refused = results.filter((x) => x.error);
      expect(Number(psql(`select count(*) from public.studio_sms_spend_events where approval_ref = $q$${r}$q$`))).toBe(1);
      expect(refRows(r)).toBe(1);
      expect(refused.every((x) => x.error?.code === "TW019")).toBe(true);
      expect(new Set(ok.map((x) => (x.data as { spend_event_id: string }).spend_event_id)).size).toBe(1);
      const winner = psql(`select legal_entity_id from public.studio_sms_spend_events where approval_ref = $q$${r}$q$`);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      expect(ok.length).toBeLessThanOrEqual(4); // only the winning business's own retries can succeed (as replays)
      expect([EA, EB]).toContain(winner);
    });

    it("the registry cannot be edited, deleted, truncated or reached by an API role; the register function is not callable", async () => {
      const r = ref("tamper");
      expect((await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r)).error).toBeNull();
      const norm = `public._tw4fi_ref_norm($q$${r}$q$)`;
      expect(psqlError(`update public.studio_sms_approval_refs set legal_entity_id = '${EB}' where ref_norm = ${norm};`)).toMatch(/permanent/);
      expect(psqlError(`delete from public.studio_sms_approval_refs where ref_norm = ${norm};`)).toMatch(/permanent/);
      expect(psqlError(`truncate public.studio_sms_approval_refs;`)).toMatch(/permanent/);
      // the reference on the authorization itself cannot be changed either (existing guard), so the linkage cannot drift
      expect(psqlError(`update public.studio_sms_spend_events set approval_ref = 'Something else entirely' where approval_ref = $q$${r}$q$;`)).toMatch(/cannot be edited/);
      expect((await admin.from("studio_sms_approval_refs").select("*").limit(1)).error).not.toBeNull();
      expect((await admin.from("studio_sms_approval_refs").insert({ ref_norm: "x".repeat(10), approval_ref: "x", source: "pilot_exception", legal_entity_id: EA, approved_by: U.padmin })).error).not.toBeNull();
      expect((await as("owner_a").from("studio_sms_approval_refs").select("*").limit(1)).error).not.toBeNull();
      // (a PostgREST call to a function an API role cannot execute crashes this LOCAL stack's backend: the privilege is checked in SQL instead)
      expect(psql(`select bool_or(has_function_privilege(r, 'public._tw4fi_register(text, text, uuid, uuid, uuid, text, int, text, uuid)', 'execute')) from unnest(array['anon', 'authenticated', 'service_role']) r`)).toBe("f");
      expect(psql(`select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\\_tw4fi\\_%'
                     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))`)).toBe("0");
    });

    it("the trace links one reference to its authorization, reservation, operation and ledger (platform admin only)", async () => {
      const r = ref("trace");
      await clearOpen(EA);
      expect((await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r)).error).toBeNull();
      const owner = `fi-${RUN}-trace`;
      lease(OA1, owner);
      await runner.reserveSpend(OA1, owner, "brand_low_volume");
      await runner.settleSpend(OA1, owner, "brand_low_volume", "captured", "BN-fixture-trace");
      lease(OA1, null);
      const { data, error } = await rpc("tw4_approval_ref_trace", { p_approval_ref: r.toUpperCase(), p_actor: U.padmin });
      expect(error).toBeNull();
      const t = data as { spend_event: unknown; reservation: unknown; ledger: { kind: string; balance_delta_cents: number; ref: string }[] } & Record<string, unknown>;
      expect(t).toMatchObject({ found: true, source: "spend_authorization", legal_entity_id: EA, approved_location_id: LA1, approved_by: U.padmin });
      expect(t.spend_event).toMatchObject({ kind: "brand_low_volume", amount_cents: LVS_BRAND, status: "reserved", onboarding_id: OA1 });
      expect(t.reservation).toMatchObject({ location_id: LA1, kind: "brand_low_volume", amount_cents: LVS_BRAND, status: "captured" });
      expect(t.ledger.map((l) => l.kind)).toEqual(["reserve", "capture"]);
      expect(t.ledger[1]).toMatchObject({ balance_delta_cents: -LVS_BRAND, ref: "BN-fixture-trace" });
      expect((await rpc("tw4_approval_ref_trace", { p_approval_ref: r, p_actor: U.owner_a })).error?.code).toBe("42501");
      expect(psql(`select has_function_privilege('authenticated', 'public.tw4_approval_ref_trace(text, uuid)', 'execute')`)).toBe("f"); // not exposed to a user session
      expect((await rpc("tw4_approval_ref_trace", { p_approval_ref: "Owner email never recorded anywhere", p_actor: U.padmin })).data).toEqual({ found: false });
    });

    it("invisible format characters, dash and quote variants do not make a new reference (review P2-3)", async () => {
      const r = `Owner email ${RUN} 2026-10-20 "brand" approval`;
      const { data } = await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r);
      await rpc("tw4_spend_withdraw", { p_spend_event_id: (data as { spend_event_id: string }).spend_event_id, p_actor: U.padmin, p_note: "fixture: spend the reference" });
      const variants = [
        r.replace("email", "em​ail"), r.replace("Owner", "Ow­ner"), `﻿${r}`, r.replace("email", "e⁠mail"),
        r.replaceAll("-", "–"), r.replaceAll("-", "‑"), r.replaceAll("\"", "“"), r.replace(" ", " "), r.replace(" ", "‎ "),
      ];
      for (const v of variants) expect(await errCode(authorize(EA, LA1, "brand_low_volume", LVS_BRAND, v))).toBe("TW019");
      expect(refRows(r)).toBe(1);
    });

    it("a fee approval and a ceiling approval racing with ONE reference: exactly one is recorded (review P2-2)", async () => {
      for (let i = 0; i < 6; i += 1) {
        const r = ref(`ceiling-race-${i}`);
        const [fee, ceiling] = await Promise.all([
          authorize(EB, LB1, "brand_low_volume", LVS_BRAND, r),
          rpc("tw4_limit_ceiling_approve_entity", { p_entity_id: EB, p_actor: U.padmin, p_cents: 60_000, p_approval_ref: r }),
        ]);
        expect([fee.error, ceiling.error].filter(Boolean)).toHaveLength(1);
        expect([fee.error?.code, ceiling.error?.code].filter(Boolean)).toEqual(["TW019"]);
        const fees = Number(psql(`select count(*) from public.studio_sms_spend_events where approval_ref = $q$${r}$q$`));
        const ceilings = Number(psql(`select count(*) from public.studio_sms_limit_ceilings where approval_ref = $q$${r}$q$`));
        expect(fees + ceilings).toBe(1);
      }
      await clearOpen(EB);
    });

    it("an approval written in replica mode (restore / data-fix session) is still registered, and its reference still refused for reuse", () => {
      const r = ref("replica");
      const out = psqlError(`begin;
        set local session_replication_role = replica;
        insert into public.studio_sms_spend_events (legal_entity_id, kind, amount_cents, approval_ref, authorized_by, funding, studio_id)
          values ('${EA}', 'brand_low_volume', ${LVS_BRAND}, $q$${r}$q$, '${U.padmin}', 'credit', '${LA1}');
        do $d$ begin if not exists (select 1 from public.studio_sms_approval_refs where ref_norm = public._tw4fi_ref_norm($q$${r}$q$)) then raise exception 'NOT_REGISTERED'; end if; end $d$;
        insert into public.studio_sms_spend_events (legal_entity_id, kind, amount_cents, approval_ref, authorized_by, funding, studio_id)
          values ('${EB}', 'brand_low_volume', ${LVS_BRAND}, $q$${r.toUpperCase()}$q$, '${U.padmin}', 'credit', '${LB1}');
        rollback;`);
      expect(out).not.toMatch(/NOT_REGISTERED/);
      expect(out).toMatch(/TW019/);
      expect(refRows(r)).toBe(0); // rolled back
    });
  });

  describe("lock order and recovery (review P2-1, P2-4)", () => {
    it("runner reserve/settle, admin approvals and tier decisions on ONE location in parallel never deadlock", async () => {
      const errors: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        await clearOpen(EA);
        const owner = `fi-${RUN}-lock-${i}`;
        expect((await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, ref(`lock-seed-${i}`))).error).toBeNull();
        lease(OA1, owner);
        const runnerSide = (async () => {
          try {
            await runner.reserveSpend(OA1, owner, "brand_low_volume");
            await runner.settleSpend(OA1, owner, "brand_low_volume", "released", "fixture-lock");
          } catch (error) {
            errors.push(`runner:${(error as { code?: string }).code}`);
          }
        })();
        const adminSide = Promise.all([
          authorize(EA, LA1, "brand_low_volume", LVS_BRAND, ref(`lock-admin-${i}`)),
          rpc("tw4_onboarding_decide_tier", { p_studio_id: LA1, p_actor: U.padmin, p_tier: "low_volume_standard", p_reason: "fixture: concurrent decision", p_eligibility: CHECKLIST }),
        ]).then((rs) => rs.forEach((x) => x.error && errors.push(`admin:${x.error.code}`)));
        await Promise.all([runnerSide, adminSide]);
        lease(OA1, null);
      }
      expect(errors.filter((e) => e.endsWith(":40P01"))).toEqual([]);
      // the only acceptable refusal: the tier decision meets the runner's live lease (55P03) - never a deadlock (40P01) or a lock timeout (55P03 from lock_timeout is not raised by these functions)
      expect(errors.filter((e) => e !== "admin:55P03")).toEqual([]);
      await clearOpen(EA);
    });

    it("a recurring charge follows the path checked when the owner authorized it; an unknown authorization key does not", () => {
      const out = psqlError(`begin;
        insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, expires_at, authorized_by, statement)
          values ('${"ab".repeat(4)}-0000-4000-8000-${"0".repeat(12)}', '${EA}', '${LA1}', 'monthly_low_volume', ${LVS_MONTHLY}, 3, ${LVS_MONTHLY * 3}, now() + interval '60 days', '${U.owner_a}', 'fixture statement for the pinned path test (rolled back)');
        set local session_replication_role = replica;
        update public.studio_sms_onboarding set ein_last4 = '0000' where id = '${OA1}';   -- the path is no longer verified
        set local session_replication_role = origin;
        insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
          values ('${EA}', '${LA1}', 'monthly_low_volume', ${LVS_MONTHLY}, 'credit', 'rec:${"ab".repeat(4)}-0000-4000-8000-${"0".repeat(12)}:2026-12');
        do $d$ begin raise exception 'PINNED_OK'; end $d$;
        rollback;`);
      expect(out).toMatch(/PINNED_OK/);
      const forged = psqlError(`begin;
        set local session_replication_role = replica;
        update public.studio_sms_onboarding set ein_last4 = '0000' where id = '${OA1}';
        set local session_replication_role = origin;
        insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
          values ('${EA}', '${LA1}', 'monthly_low_volume', ${LVS_MONTHLY}, 'credit', 'rec:${"cd".repeat(4)}-0000-4000-8000-${"0".repeat(12)}:2026-12');
        rollback;`);
      expect(forged).toMatch(/TW020/);
    });

    it("an unverified Low-Volume Standard onboarding can be re-verified by recording the full checklist again (same tier)", () => {
      const out = psqlError(`begin;
        do $d$ declare v jsonb; begin
          v := public.tw4_onboarding_decide_tier('${LU1}', '${U.padmin}', 'low_volume_standard', 'fixture: re-verify with the full checklist', '${JSON.stringify(CHECKLIST)}'::jsonb);
          if v ->> 'reverified' is distinct from 'true' or public._tw4fi_location_path_nolock('${LU1}') <> 'low_volume_standard' then raise exception 'NOT_REVERIFIED %', v; end if;
          raise exception 'REVERIFIED_OK';
        end $d$;
        rollback;`);
      expect(out).toMatch(/REVERIFIED_OK/);
      expect(psql(`select public._tw4fi_location_path_nolock('${LU1}')`)).toBe("low_volume_unverified"); // rolled back
    });
  });

  describe("Low-Volume Standard price kinds follow the location's VERIFIED registration path", () => {
    it("a low-volume brand approval needs a verified Low-Volume Standard location (not Standard, not the whole business, not unverified)", async () => {
      expect(await errCode(authorize(EA, LA2, "brand_low_volume", LVS_BRAND, ref("lvs-on-standard")))).toBe("TW020");
      expect(await errCode(authorize(EA, null, "brand_low_volume", LVS_BRAND, ref("lvs-no-location")))).toBe("TW020");
      expect(await errCode(authorize(EU, LU1, "brand_low_volume", LVS_BRAND, ref("lvs-unverified")))).toBe("TW020");
      // a refused attempt leaves no trace that could block the owner's real approval later
      for (const label of ["lvs-on-standard", "lvs-no-location", "lvs-unverified"]) expect(refRows(ref(label))).toBe(0);
      // and the published amount is still enforced on the verified path
      expect(await errCode(authorize(EA, LA1, "brand_low_volume", LVS_BRAND - 1, ref("lvs-wrong-amount")))).toBe("TW008");
    });

    it("a tier decided without the full checklist (or later contradicted) is not verified", async () => {
      expect(psql(`select public._tw4fi_location_path_nolock('${LU1}')`)).toBe("low_volume_unverified");
      expect(psql(`select public._tw4fi_location_path_nolock('${LA1}')`)).toBe("low_volume_standard");
      expect(psql(`select public._tw4fi_location_path_nolock('${LA2}')`)).toBe("standard");
      // an EIN that no longer agrees with the legal business: unverified (checked on every use, not only at decision time)
      psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_onboarding set ein_last4 = '0000' where id = '${OB1}'; commit;`);
      expect(psql(`select public._tw4fi_location_path_nolock('${LB1}')`)).toBe("low_volume_unverified");
      expect(await errCode(authorize(EB, LB1, "brand_low_volume", LVS_BRAND, ref("lvs-ein-drift")))).toBe("TW020");
      psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_onboarding set ein_last4 = '8882' where id = '${OB1}'; commit;`);
      expect(psql(`select public._tw4fi_location_path_nolock('${LB1}')`)).toBe("low_volume_standard");
    });

    it("every write path refuses a Standard kind on a Low-Volume Standard location and a low-volume kind elsewhere (database triggers)", () => {
      expect(psqlError(`insert into public.studio_sms_spend_events (legal_entity_id, kind, amount_cents, approval_ref, authorized_by, funding, studio_id)
                          values ('${EA}', 'brand', 4600, $q$${ref("direct-brand")}$q$, '${U.padmin}', 'credit', '${LA1}');`)).toMatch(/TW020/);
      expect(psqlError(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
                          values ('${EA}', '${LA1}', 'brand', 4600, 'credit', 'fi-direct-${RUN}-1');`)).toMatch(/TW020/);
      expect(psqlError(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
                          values ('${EA}', '${LA1}', 'monthly', 1000, 'credit', 'fi-direct-${RUN}-2');`)).toMatch(/TW020/);
      expect(psqlError(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
                          values ('${EA}', '${LA2}', 'brand_low_volume', ${LVS_BRAND}, 'credit', 'fi-direct-${RUN}-3');`)).toMatch(/TW020/);
      expect(psqlError(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
                          values ('${EU}', '${LU1}', 'monthly_low_volume', ${LVS_MONTHLY}, 'credit', 'fi-direct-${RUN}-4');`)).toMatch(/TW020/);
      // path-neutral kinds are untouched
      expect(psqlError(`begin; insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
                          values ('${EA}', '${LA1}', 'number', 150, 'credit', 'fi-direct-${RUN}-5'); rollback;`)).toBe("");
    });

    it("a business-wide Standard brand approval cannot be reserved by a Low-Volume Standard location's run", async () => {
      // the Standard price exists only inside this rolled-back transaction, so no other suite ever sees it
      const out = psqlError(`begin;
        ${seedPriceSql({ kind: "brand", customer: 4600, provider: 4600, description: "fixture standard brand (rolled back)", approver: U.padmin, ifMissing: true })}
        select public.tw4_spend_authorize('${EA}', 'brand', (select customer_price_cents from public.studio_sms_price_list where kind = 'brand' and active), $q$${ref("std-wide")}$q$, '${U.padmin}', 'credit', null);
        set local session_replication_role = replica;
        update public.studio_sms_onboarding set lease_owner = 'fi-wide', lease_expires_at = now() + interval '5 minutes' where id = '${OA1}';
        set local session_replication_role = origin;
        select public.tw4_spend_reserve('${OA1}', 'fi-wide', 'brand');
        rollback;`);
      expect(out).toMatch(/TW020/);
    });

    it("reserve -> capture and reserve -> release work for the low-volume brand at its own price, with the ledger balanced", async () => {
      const before = Number(psql(`select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${EB}'`));
      expect((await authorize(EB, LB1, "brand_low_volume", LVS_BRAND, ref("lb1-capture"))).error).toBeNull();
      const owner = `fi-${RUN}-b1`;
      lease(OB1, owner);
      const fees = await runner.getFeeKinds(OB1, owner);
      expect(fees).toEqual({ path: "low_volume_standard", brandKind: "brand_low_volume", campaignMonthlyKind: "monthly_low_volume", brandPriceCents: LVS_BRAND, campaignMonthlyPriceCents: LVS_MONTHLY });
      const first = await runner.reserveSpend(OB1, owner, "brand_low_volume");
      expect(await runner.reserveSpend(OB1, owner, "brand_low_volume")).toEqual(first); // idempotent replay of the same operation
      await runner.settleSpend(OB1, owner, "brand_low_volume", "captured", "BN-fixture-b1");
      await runner.settleSpend(OB1, owner, "brand_low_volume", "captured", "BN-fixture-b1"); // replay: no second charge
      lease(OB1, null);
      expect(Number(psql(`select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${EB}'`))).toBe(before - LVS_BRAND);
      expect((await rpc("tw4_credit_verify", { p_entity_id: EB })).data).toMatchObject({ ok: true });
      // the Standard kind is refused for this onboarding even with the same lease (wrong path)
      lease(OB1, owner);
      await expect(runner.reserveSpend(OB1, owner, "brand")).rejects.toMatchObject({ code: "TW004" }); // no Standard approval can even exist here
      lease(OB1, null);
    });

    it("tier changes are refused while the other path has an open approval or an active recurring authorization", async () => {
      const r = ref("pin-tier");
      const { data } = await authorize(EA, LA1, "brand_low_volume", LVS_BRAND, r);
      expect(await errCode(rpc("tw4_onboarding_decide_tier", { p_studio_id: LA1, p_actor: U.padmin, p_tier: "standard", p_reason: "fixture: back to standard", p_eligibility: null }))).toBe("55000");
      expect(await errCode(rpc("tw4_onboarding_set_tier", { p_studio_id: LA1, p_actor: U.padmin, p_tier: "standard", p_reason: "fixture: back" }))).toBe("55000");
      await rpc("tw4_spend_withdraw", { p_spend_event_id: (data as { spend_event_id: string }).spend_event_id, p_actor: U.padmin, p_note: "fixture: withdraw to unpin" });
      // nothing open any more (the other open approvals of this suite on A are withdrawn or reserved-and-settled): the switch is allowed, and back again
      psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_spend_events set status = 'void' where legal_entity_id = '${EA}' and kind = 'brand_low_volume' and status = 'authorized'; commit;`);
      expect((await rpc("tw4_onboarding_set_tier", { p_studio_id: LA1, p_actor: U.padmin, p_tier: "standard", p_reason: "fixture: back" })).error).toBeNull();
      expect(psql(`select public._tw4fi_location_path_nolock('${LA1}')`)).toBe("standard");
      expect((await rpc("tw4_onboarding_decide_tier", { p_studio_id: LA1, p_actor: U.padmin, p_tier: "low_volume_standard", p_reason: "fixture: EIN business, low volume", p_eligibility: CHECKLIST })).error).toBeNull();
      expect(psql(`select public._tw4fi_location_path_nolock('${LA1}')`)).toBe("low_volume_standard");
    });

    it("recurring: the Low Volume Mixed campaign fee is authorized on its path only, once per location, with the owner wording", async () => {
      expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: EA, p_actor: U.padmin, p_limit_cents: 30_000, p_effective_month: null, p_reason: "fixture: monthly limit for these tests" })).error).toBeNull();
      const authorizeRecurring = (studio: string, kind: string, price: number) =>
        rpc("tw4_recurring_authorize", { p_studio_id: studio, p_user_id: U.owner_a, p_kind: kind, p_acknowledged_price_cents: price, p_term_months: 3, p_total_limit_cents: price * 3 });
      expect(await errCode(authorizeRecurring(LA1, "monthly", 1000))).toBe("TW020");   // the Standard campaign fee on the low-volume path
      expect(await errCode(authorizeRecurring(LA2, "monthly_low_volume", LVS_MONTHLY))).toBe("TW020");   // and the reverse
      expect(await errCode(authorizeRecurring(LU1, "monthly_low_volume", LVS_MONTHLY))).toBe("TW020");   // unverified path
      const ok = await authorizeRecurring(LA1, "monthly_low_volume", LVS_MONTHLY);
      expect(ok.error).toBeNull();
      const id = (ok.data as { authorization_id: string }).authorization_id;
      expect(psql(`select kind || '|' || price_cents from public.studio_sms_recurring_authorizations where id = '${id}'`)).toBe(`monthly_low_volume|${LVS_MONTHLY}`);
      expect(psql(`select statement from public.studio_sms_recurring_authorizations where id = '${id}'`))
        .toBe(buildAuthorizationStatement({ kind: "monthly_low_volume", priceCents: LVS_MONTHLY, termMonths: 3, totalLimitCents: LVS_MONTHLY * 3 }));
      expect(psql(`select kind || '|' || status from public.studio_sms_credit_reservations where reservation_key = 'commit:${id}'`)).toBe("monthly_low_volume|reserved");
      expect(await errCode(authorizeRecurring(LA1, "monthly_low_volume", LVS_MONTHLY))).toBe("23505");
      // an active campaign fee pins the path
      expect(await errCode(rpc("tw4_onboarding_set_tier", { p_studio_id: LA1, p_actor: U.padmin, p_tier: "standard", p_reason: "fixture: back" }))).toBe("55000");
      expect((await rpc("tw4_recurring_revoke", { p_authorization_id: id, p_user_id: U.owner_a })).error).toBeNull();
    });

    it("the owner's settings read reports the campaign kind of THIS location only, to its owner or administrator", async () => {
      expect((await as("owner_a").rpc("sms_location_fee_kinds", { p_studio_id: LA1 })).data).toEqual({ path: "low_volume_standard", campaign_monthly_kind: "monthly_low_volume" });
      expect((await as("owner_a").rpc("sms_location_fee_kinds", { p_studio_id: LA2 })).data).toEqual({ path: "standard", campaign_monthly_kind: "monthly" });
      expect((await as("owner_a").rpc("sms_location_fee_kinds", { p_studio_id: LU1 })).data).toEqual({ path: "low_volume_unverified", campaign_monthly_kind: null });
      expect((await as("owner_b").rpc("sms_location_fee_kinds", { p_studio_id: LA1 })).error?.code).toBe("42501");
      expect(psql(`select has_function_privilege('authenticated', 'public.tw4_location_fee_kinds(uuid)', 'execute')`)).toBe("f"); // the service-role read is not exposed
    });

    it("the rollback refuses once a low-volume kind has been used (evidence), leaving everything in place", () => {
      const out = psqlError(readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261202090000_twilio_tw4f_financial_integrity_rollback.sql"), "utf8"));
      // refused either by the evidence rule or, where the later inbound slice (20261203) is applied, by its "roll back 20261203 first" guard
      expect(out).toMatch(/rollback refused: (a Low-Volume Standard fee kind has been used|roll back 20261203090000)/);
      expect(psql(`select to_regclass('public.studio_sms_approval_refs') is not null`)).toBe("t");
    });
  });
});
