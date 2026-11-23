/**
 * TW-4F controlled test credit (20270223091000) against a REAL schema.
 *   1. Privileges and shape: service_role-only entry points, internals revoked, tables without API privileges, RLS on, ENABLE ALWAYS triggers.
 *   2. Dark by default: the kill switch is OFF without a row and the test budget is 0; a grant needs both.
 *   3. Authorization: platform admin only; pilot business only; U-4 evidence (date, role, scope, amount, current month, document, sha256) or nothing is recorded.
 *   4. Budget: a grant over the remaining budget is refused; a budget below what was granted is refused; reversals never free budget.
 *   5. Idempotency per approval reference; one reference / one document per decision across the shared registry.
 *   6. Texting only: a non-texting reservation can never use test credit; texting consumes it first; a usage refund gives it back as test credit.
 *   7. Reversal of unused credit (bounded, idempotent, allowed with the switch off); hold / negative-balance refusals; direct writes refused (also in replica mode).
 *   8. Concurrency: two grants racing for the last of the budget; the same grant twice.
 *   9. Rollback refuses while rows exist; on a schema-only scratch copy it restores and re-applies cleanly.
 * Synthetic fixtures; nothing reaches Twilio, Stripe or any SMS path.
 *
 * LOCAL QA ONLY: an isolated Postgres with migrations through 20270223091000 and the local-QA marker table (ISO_QA_MARKER=1):
 *   TW4A_LOCAL_DB_CONTAINER=<container> [TW4RFL_DB=<database>]
 *   node scripts/qa/iso-qa.mjs run numeric -- src/lib/sms/twilioIsv/__tests__/localStack.tw4testcredit.test.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { seedPriceIfMissing } from "./priceFixture";
import { pilotExceptionArgs } from "./rflEvidenceHelper";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "postgres";
const enabled = Boolean(PG);

const RUN = randomBytes(3).toString("hex");
const P = `ad${RUN}-0000-4000-8000-000000000701`; // platform admin
const N = `ad${RUN}-0000-4000-8000-000000000702`; // NOT a platform admin

const sqlArgs = (db = DB) => ["exec", "-i", PG, "psql", "-U", "postgres", "-d", db, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", sqlArgs(), { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", sqlArgs(), { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
};
const callSql = (fn: string, ...args: unknown[]) => `select public.${fn}(${args.map(lit).join(", ")})::text;`;
const call = <T = Record<string, unknown>>(fn: string, ...args: unknown[]): T => JSON.parse(psql(callSql(fn, ...args)) || "null") as T;
const callErr = (fn: string, ...args: unknown[]) => psqlError(callSql(fn, ...args));
const hasCode = (err: string, code: string) => new RegExp(`ERROR:\\s+${code}:`).test(err);

const hex = (n: number) => randomBytes(n).toString("hex");
const sha = () => randomBytes(32).toString("hex");
const docId = () => `AUTH-DOC-${hex(5)}`;
const ref = (label: string) => `Written test credit approval ${RUN} ${label} ${hex(3)}`;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const GRANT = "public.tw4_credit_test_grant(uuid,integer,text,uuid,date,text,text,integer,text,text,text)";
const BUDGET = "public.tw4_credit_test_budget_set(uuid,integer,text,uuid,date,text,text,integer,text,text,text)";
const SWITCH = "public.tw4_credit_test_set_switch(boolean,uuid,text)";
const REVERSE = "public.tw4_credit_test_reverse(uuid,integer,text,text,uuid)";
const STATUS = "public.tw4_credit_test_status(uuid)";
const INTERNAL = ["public._tw4tc_guard()", "public._tw4tc_ledger_trigger()", "public._tw4tc_on_ledger(public.studio_sms_credit_ledger,text)", "public._tw4tc_switch_on()",
  "public._tw4tc_check_evidence(uuid,text,bigint,date,text,text,bigint,text,text,text)", "public._tw4tc_require_pilot(uuid)", "public._tw4tc_budget(uuid)"];
const TABLES = ["studio_sms_test_credit_switch_log", "studio_sms_test_credit_budgets", "studio_sms_test_credit_budget_changes", "studio_sms_test_credit_grants", "studio_sms_test_credit_movements"];

const mdir = join(process.cwd(), "src/lib/supabase/migrations");
const forward = readFileSync(join(mdir, "20270223091000_twilio_test_credit_grant.sql"), "utf8");
const back = readFileSync(join(mdir, "rollback/20270223091000_twilio_test_credit_grant_rollback.sql"), "utf8");

let EP = ""; // the pilot business
let SP = ""; // its location
let EN = ""; // an ordinary (non-pilot) business
let SN = "";
const period = (entity: string) => psql(`select public._tw4ml_month_key('${entity}', now())`);

type Ev = Partial<{ on: string | null; role: string | null; scope: string | null; amount: number | null; period: string | null; doc: string | null; sha: string | null }>;
const ev7 = (entity: string, scope: string, amount: number, o: Ev = {}): unknown[] => {
  const base = { on: day(-2), role: "owner_written", scope, amount, period: period(entity), doc: docId(), sha: sha() };
  const pick = <K extends keyof Ev>(k: K) => (k in o ? o[k] : base[k]);
  return [pick("on"), pick("role"), pick("scope"), pick("amount"), pick("period"), pick("doc"), pick("sha")];
};
const grantArgs = (entity: string, cents: number, approval: string, o: Ev = {}, actor = P) => [entity, cents, approval, actor, ...ev7(entity, "test_credit_grant", cents, o)];
const budgetArgs = (entity: string, cents: number, approval: string, o: Ev = {}, actor = P) => [entity, cents, approval, actor, ...ev7(entity, "test_credit_budget", cents, o)];
const grant = (entity: string, cents: number, approval = ref("g"), o: Ev = {}) => call<{ grant_id: string; entry_id: string; replayed: boolean }>("tw4_credit_test_grant", ...grantArgs(entity, cents, approval, o));
const grantErr = (entity: string, cents: number, approval = ref("g"), o: Ev = {}, actor = P) => callErr("tw4_credit_test_grant", ...grantArgs(entity, cents, approval, o, actor));
const setBudget = (entity: string, cents: number, approval = ref("b"), o: Ev = {}) => call<{ budget_cents: number; replayed: boolean }>("tw4_credit_test_budget_set", ...budgetArgs(entity, cents, approval, o));
const budgetErr = (entity: string, cents: number, approval = ref("b"), o: Ev = {}, actor = P) => callErr("tw4_credit_test_budget_set", ...budgetArgs(entity, cents, approval, o, actor));
const switchTo = (on: boolean) => call("tw4_credit_test_set_switch", on, P, `fixture: switch ${on ? "on" : "off"} for the suite`);
type Status = { switch_enabled: boolean; is_pilot: boolean; budget_cents: number; granted_cents: number; budget_left_cents: number; consumed_cents: number; restored_cents: number;
  reversed_cents: number; forfeited_cents: number; unused_cents: number; balance_cents: number; reserved_cents: number; non_test_available_cents: number; grants: number; ok: boolean };
const status = (entity: string) => call<Status>("tw4_credit_test_status", entity);
const count = (sql: string) => Number(psql(sql));
const grantsOf = (entity: string) => count(`select count(*) from public.studio_sms_test_credit_grants where legal_entity_id = '${entity}'`);
const ledgerOf = (entity: string) => count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${entity}'`);
const refRegistered = (approval: string) => psql(`select exists (select 1 from public.studio_sms_approval_refs where ref_norm = public._tw4fi_ref_norm(${lit(approval)}))`) === "t";

/** Purchased-equivalent credit for fixtures (tw4_credit_adjust is the existing admin adjustment; it is NOT test credit). */
const adjust = (entity: string, cents: number) => call("tw4_credit_adjust", entity, cents, `fx-${hex(6)}`, "fixture adjustment for the test-credit suite", P);
/** A fee (or texting) reservation exactly as every fee path makes it: the reservation row, then the 'reserve' ledger primitive, under the account lock. */
const reserveSql = (entity: string, studio: string, kind: string, cents: number) => {
  const key = `fx:${kind}:${hex(6)}`;
  return `begin;
select public._tw4c_lock('${entity}');
with r as (insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key) values ('${entity}', '${studio}', '${kind}', ${cents}, 'credit', '${key}') returning id)
select public._tw4c_post('${entity}', '${studio}', 'reserve', 0, ${cents}, 'reserve:${key}', (select id from r), 'fixture', null, null) from r;
commit;`;
};
/** Releases every open fixture reservation of a business (so each scenario starts from settled balances). */
const releaseAll = (entity: string) => psql(`begin;
select public._tw4c_lock('${entity}');
select public._tw4c_post(r.legal_entity_id, r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, 'fixture', null, null)
  from public.studio_sms_credit_reservations r where r.legal_entity_id = '${entity}' and r.status = 'reserved' and r.funding = 'credit';
update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where legal_entity_id = '${entity}' and status = 'reserved';
commit;`);
/** Brings the pilot business back to a known state: no open reservations, no unused test credit, balance exactly `balance` cents of ordinary credit. */
function resetPilot(balance = 0) {
  releaseAll(EP);
  const s = status(EP);
  if (s.unused_cents > 0) call("tw4_credit_test_reverse", EP, s.unused_cents, `reset-${hex(5)}`, "fixture reset of unused test credit", P);
  const bal = status(EP).balance_cents;
  if (bal !== balance) adjust(EP, balance - bal);
}

function makeBusiness(name: string, pilot: boolean): { entity: string; studio: string } {
  const entity = randomUUID();
  const studio = randomUUID();
  psql(`begin;
insert into public.studios (id, name, slug, public_name, timezone) values ('${studio}', 'TC ${name} ${RUN}', 'tc-${name}-${RUN}', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${entity}', ${lit(pilot ? "ConfiDance Unlimited, LLC" : `TC Ordinary ${RUN} LLC`)}, '9998', 15000, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${studio}', '${entity}', 'founding', '${P}', 'fixture: verified synthetic business', now());
commit;`);
  call("tw4_monthly_limit_set_admin", entity, P, 20_000, null, "fixture: monthly limit for the test-credit suite");
  if (pilot) call("tw4_pilot_exception_create", ...pilotExceptionArgs(psql, entity, 15000, `Founder written pilot approval ${RUN}`, P));
  return { entity, studio };
}

describe.skipIf(!enabled)("TW-4F controlled test credit (real schema)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`)).toBe("t");
    expect(psql(`select to_regprocedure('${GRANT}') is not null`)).toBe("t");
    // a fresh isolated database: no pilot exception exists yet (the platform allows exactly one)
    expect(count(`select count(*) from public.studio_sms_pilot_exceptions`)).toBe(0);
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at) values
  ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@tc-e2e.test', now(), now(), now()),
  ('${N}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nobody-${RUN}@tc-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
insert into public.profiles (id, platform_role) values ('${N}', null) on conflict (id) do update set platform_role = null;
commit;`);
    ({ entity: EP, studio: SP } = makeBusiness("pilot", true));
    ({ entity: EN, studio: SN } = makeBusiness("ordinary", false));
    // a per-text price (cents, no micros) for the provider-cost estimate of test-paid texting; published through the dual-control fixture
    seedPriceIfMissing(psql, { kind: "sms_usage", customer: 4, provider: 3, description: "fixture per-text price", approver: P });
  });

  describe("1. privileges and shape", () => {
    it("the five entry points are EXECUTE for service_role only; every internal function is revoked from every API role", () => {
      for (const fn of [GRANT, BUDGET, SWITCH, REVERSE, STATUS]) {
        expect(psql(`select has_function_privilege('service_role', '${fn}', 'execute')::text || has_function_privilege('authenticated', '${fn}', 'execute')::text
          || has_function_privilege('anon', '${fn}', 'execute')::text || has_function_privilege('public', '${fn}', 'execute')::text`), fn).toBe("truefalsefalsefalse");
        expect(psql(`select p.prosecdef::text || coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p where p.oid = '${fn}'::regprocedure`), fn).toBe("truesearch_path=pg_catalog, public, pg_temp");
      }
      for (const fn of INTERNAL) {
        for (const role of ["service_role", "authenticated", "anon"]) expect(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
      }
    });

    it("the five tables have no API privileges, RLS on, and ENABLE ALWAYS guards; the ledger trigger is ENABLE ALWAYS", () => {
      for (const t of TABLES) {
        for (const role of ["service_role", "authenticated", "anon"]) {
          expect(psql(`select has_table_privilege('${role}', 'public.${t}', 'select,insert,update,delete,truncate')`), `${role} ${t}`).toBe("f");
        }
        expect(psql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`), t).toBe("t");
        expect(psql(`select string_agg(tgenabled::text, '' order by tgname) from pg_trigger where tgrelid = 'public.${t}'::regclass and not tgisinternal and tgname like '%_guard'`), t).toBe("A");
      }
      expect(psql(`select tgenabled from pg_trigger where tgname = 'studio_sms_credit_ledger_40_test_credit'`)).toBe("A");
    });
  });

  describe("2-5. dark default, authorization, evidence, budget, idempotency", () => {
    it("the switch is OFF with no row and the budget is 0: nothing can be granted until both are set", () => {
      expect(count(`select count(*) from public.studio_sms_test_credit_switch_log`)).toBe(0);
      const s = status(EP);
      expect([s.switch_enabled, s.is_pilot, s.budget_cents, s.granted_cents, s.ok]).toEqual([false, true, 0, 0, true]);
      // switch off: refused before the budget is even considered
      expect(hasCode(grantErr(EP, 100), "TW070")).toBe(true);
      // switch on, budget 0: refused
      switchTo(true);
      expect(hasCode(grantErr(EP, 100), "TW071")).toBe(true);
      // budget set while ON works; turning OFF again blocks grants despite the budget (the switch is what matters)
      setBudget(EP, 1500);
      switchTo(false);
      const r = ref("blocked-by-switch");
      expect(hasCode(grantErr(EP, 100, r), "TW070")).toBe(true);
      expect(refRegistered(r)).toBe(false);
      expect(grantsOf(EP)).toBe(0);
      switchTo(true);
    });

    it("only a platform admin; only the pilot business; zero / negative / oversize amounts and short references are refused; nothing is recorded", () => {
      const before = ledgerOf(EP);
      expect(hasCode(grantErr(EP, 100, ref("n"), {}, N), "42501")).toBe(true);
      expect(hasCode(budgetErr(EP, 100, ref("n"), {}, N), "42501")).toBe(true);
      expect(hasCode(callErr("tw4_credit_test_set_switch", true, N, "not an admin trying"), "42501")).toBe(true);
      expect(hasCode(callErr("tw4_credit_test_reverse", EP, 1, "k-n", "not an admin trying", N), "42501")).toBe(true);
      expect(hasCode(grantErr(EN, 100), "TW072")).toBe(true);
      expect(hasCode(budgetErr(EN, 100), "TW072")).toBe(true);
      expect(count(`select count(*) from public.studio_sms_test_credit_budgets where legal_entity_id = '${EN}'`)).toBe(0);
      for (const cents of [0, -1, 50_001]) expect(hasCode(grantErr(EP, cents), "22023"), String(cents)).toBe(true);
      for (const cents of [-1, 50_001]) expect(hasCode(budgetErr(EP, cents), "22023"), String(cents)).toBe(true);
      expect(hasCode(grantErr(EP, 100, "too short"), "22023")).toBe(true);
      expect(ledgerOf(EP)).toBe(before);
      expect(grantsOf(EP)).toBe(0);
    });

    it("U-4 evidence: every missing or inconsistent field is refused (TW052) and burns no reference", () => {
      const cases: [string, Ev][] = [
        ["no date", { on: null }], ["future", { on: day(1) }], ["32 days old", { on: day(-32) }], ["role", { role: "studio_admin" }], ["no role", { role: null }],
        ["wrong scope", { scope: "test_credit_budget" }], ["fee scope", { scope: "pilot_number_purchase" }], ["amount", { amount: 101 }], ["no amount", { amount: null }],
        ["past month", { period: "2000-01" }], ["no period", { period: null }], ["link with query", { doc: "https://docs.example.test/a?token=x" }], ["no doc", { doc: null }],
        ["upper hash", { sha: "A".repeat(64) }], ["short hash", { sha: "ab" }],
      ];
      for (const [label, o] of cases) {
        const r = ref(`ev-${label}`);
        expect(hasCode(grantErr(EP, 100, r, o), "TW052"), label).toBe(true);
        expect(refRegistered(r), label).toBe(false);
      }
      // the budget function applies the same rules with its own scope
      expect(hasCode(budgetErr(EP, 1500, ref("bev"), { scope: "test_credit_grant" }), "TW052")).toBe(true);
      expect(hasCode(budgetErr(EP, 1500, ref("bev2"), { amount: 1000 }), "TW052")).toBe(true);
      expect(grantsOf(EP)).toBe(0);
      expect(status(EP).budget_cents).toBe(1500);
    });

    it("grants within the budget succeed, post a distinct ledger kind and an audit row; over the remaining budget is refused", () => {
      resetPilot(0);
      const bal0 = status(EP).balance_cents;
      const g1 = grant(EP, 1000);
      expect(g1.replayed).toBe(false);
      expect(psql(`select kind || ':' || balance_delta_cents || ':' || reserved_delta_cents || ':' || (studio_id is null)::text from public.studio_sms_credit_ledger where id = '${g1.entry_id}'`)).toBe("test_grant:1000:0:true");
      expect(count(`select count(*) from public.studio_sms_onboarding_audit where action = 'credit_test_grant' and note like '%grant=${g1.grant_id}%' and actor_user_id = '${P}'`)).toBe(1);
      expect(hasCode(grantErr(EP, 501), "TW071")).toBe(true);
      grant(EP, 500);
      const s = status(EP);
      expect([s.budget_cents, s.granted_cents, s.budget_left_cents, s.unused_cents, s.balance_cents - bal0, s.non_test_available_cents, s.ok]).toEqual([1500, 1500, 0, 1500, 1500, 0, true]);
      expect(hasCode(grantErr(EP, 1), "TW071")).toBe(true);
      // the budget can never drop below what was granted; raising it (with new evidence) makes room
      expect(hasCode(budgetErr(EP, 1000), "TW071")).toBe(true);
      expect(setBudget(EP, 2000).budget_cents).toBe(2000);
      expect(count(`select count(*) from public.studio_sms_test_credit_budget_changes where legal_entity_id = '${EP}'`)).toBe(2);
      // no reservation, spend event or pilot-funded anything was created: the pilot ceiling is untouched
      expect(count(`select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EP}' and funding = 'pilot'`)).toBe(0);
      expect(count(`select count(*) from public.studio_sms_spend_events where legal_entity_id = '${EP}'`)).toBe(0);
    });

    it("an identical replay returns the recorded grant / budget even when its evidence would no longer pass (replay detection runs before the evidence check)", () => {
      setBudget(EP, status(EP).budget_cents + 10);
      const gr = ref("stale-replay-g");
      const br = ref("stale-replay-b");
      const ga = grantArgs(EP, 10, gr, { doc: docId(), sha: sha() });
      const ba = budgetArgs(EP, status(EP).budget_cents, br, { doc: docId(), sha: sha() });
      expect(call<{ replayed: boolean }>("tw4_credit_test_grant", ...ga).replayed).toBe(false);
      expect(call<{ replayed: boolean }>("tw4_credit_test_budget_set", ...ba).replayed).toBe(false);
      // simulate evidence that has gone stale (for example older than 31 days) by making the evidence check refuse everything, in a rolled-back transaction
      const stale = `create or replace function public._tw4tc_check_evidence(p_entity uuid, p_scope text, p_amount bigint, p_authorized_on date, p_role text, p_ev_scope text, p_ev_amount bigint,
        p_ev_period text, p_doc text, p_sha text) returns void language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
        as $f$ begin raise exception 'stale evidence' using errcode = 'TW052'; end $f$;`;
      const out = psql(`begin; ${stale} ${callSql("tw4_credit_test_grant", ...ga)} ${callSql("tw4_credit_test_budget_set", ...ba)} rollback;`).split("\n").filter((l) => l.startsWith("{"));
      expect(out.map((l) => (JSON.parse(l) as { replayed: boolean }).replayed)).toEqual([true, true]);
      // a NEW decision is still refused by the (stale) evidence check
      expect(hasCode(psqlError(`begin; ${stale} ${callSql("tw4_credit_test_grant", ...grantArgs(EP, 10, ref("stale-new")))} rollback;`), "TW052")).toBe(true);
    });

    it("idempotent per approval reference: the same grant replays (also when spelled differently); a different claim with the same reference or document is refused", () => {
      const r = ref("idem");
      const o: Ev = { doc: docId(), sha: sha(), on: day(-1) };
      const first = grant(EP, 100, r, o);
      const n = ledgerOf(EP);
      const again = grant(EP, 100, r, o);
      expect([again.replayed, again.grant_id]).toEqual([true, first.grant_id]);
      expect(grant(EP, 100, `  ${r.toUpperCase()}  `, o).replayed).toBe(true);
      expect(ledgerOf(EP)).toBe(n);
      expect(hasCode(grantErr(EP, 200, r, { ...o, amount: 200 }), "TW019")).toBe(true);
      expect(hasCode(grantErr(EP, 100, r, { ...o, sha: sha() }), "TW019")).toBe(true);
      // one retained document authorizes one grant
      expect(hasCode(grantErr(EP, 100, ref("same-doc"), { sha: o.sha }), "TW019")).toBe(true);
      // a budget reference can never be reused for a grant, nor a fee approval's (shared permanent registry)
      const br = ref("budget-ref");
      setBudget(EP, 2100, br);
      expect(hasCode(grantErr(EP, 100, br), "TW019")).toBe(true);
      expect(ledgerOf(EP)).toBe(n);
    });
  });

  describe("6. texting only", () => {
    it("a non-texting reservation can never use test credit; a texting reservation can; ordinary credit still pays fees (mutation-proof boundary)", () => {
      resetPilot(0);
      setBudget(EP, status(EP).granted_cents + 1000);
      grant(EP, 1000);
      expect(status(EP).non_test_available_cents).toBe(0);
      // only test credit: every fee kind is refused (TW007), nothing is recorded
      for (const kind of ["brand", "campaign_vetting", "number", "monthly"]) {
        const n = ledgerOf(EP);
        expect(hasCode(psqlError(reserveSql(EP, SP, kind, 200)), "TW007"), kind).toBe(true);
        expect(ledgerOf(EP), kind).toBe(n);
      }
      // a texting reservation is allowed on test credit
      psql(reserveSql(EP, SP, "sms_usage", 300));
      releaseAll(EP);
      // ordinary credit pays a fee exactly up to the ordinary part
      adjust(EP, 250);
      expect(hasCode(psqlError(reserveSql(EP, SP, "number", 251)), "TW007")).toBe(true);
      psql(reserveSql(EP, SP, "number", 250));
      expect(status(EP).non_test_available_cents).toBe(0);
      releaseAll(EP);
      // an ordinary business without a budget is unaffected by any of this
      adjust(EN, 300);
      psql(reserveSql(EN, SN, "number", 300));
      releaseAll(EN);
      expect(count(`select count(*) from public.studio_sms_test_credit_movements where legal_entity_id = '${EN}'`)).toBe(0);
    });

    it("texting consumes test credit first; a usage refund gives it back as TEST credit (never ordinary); replays change nothing", () => {
      resetPilot(400); // 400 ordinary
      setBudget(EP, status(EP).granted_cents + 600);
      grant(EP, 600);
      const key = `tc-use-${hex(4)}`;
      call("tw4_credit_debit_usage", EP, SP, 500, key, "fixture texting");
      let s = status(EP);
      expect([s.unused_cents, s.non_test_available_cents, s.balance_cents]).toEqual([100, 400, 500]);
      call("tw4_credit_debit_usage", EP, SP, 500, key, "fixture texting"); // replay
      expect(status(EP).unused_cents).toBe(100);
      // a charge larger than the unused test credit takes the rest from ordinary credit
      call("tw4_credit_debit_usage", EP, SP, 300, `${key}-b`, "fixture texting");
      s = status(EP);
      expect([s.unused_cents, s.non_test_available_cents]).toEqual([0, 200]);
      // refund 200 of the first charge (it consumed 500 of test credit): 200 comes back as TEST credit, so fees still cannot use it
      call("tw4_credit_refund_usage", EP, 200, `${key}-r1`, key);
      call("tw4_credit_refund_usage", EP, 200, `${key}-r1`, key); // replay
      s = status(EP);
      expect([s.unused_cents, s.restored_cents > 0, s.non_test_available_cents]).toEqual([200, true, 200]);
      expect(hasCode(psqlError(reserveSql(EP, SP, "number", 201)), "TW007")).toBe(true);
      // the second charge consumed only 100 of test credit: refunding all 300 restores 100 as test credit and 200 as ordinary
      call("tw4_credit_refund_usage", EP, 300, `${key}-r2`, `${key}-b`);
      s = status(EP);
      expect([s.unused_cents, s.non_test_available_cents, s.ok]).toEqual([300, 400, true]);
      // test-paid texting is reported as such (not revenue), with DanceFlow's estimated provider cost at the active per-text price
      const t = call<Status & { test_paid_texting_cents: number; test_paid_texting_provider_cost_estimate_cents: number | null }>("tw4_credit_test_status", EP);
      const p = psql("select customer_price_cents || ':' || provider_cost_cents from public.studio_sms_price_list where kind = 'sms_usage' and active").split(":").map(Number);
      expect(t.test_paid_texting_cents).toBe(t.consumed_cents - t.restored_cents);
      expect(t.test_paid_texting_cents).toBeGreaterThan(0);
      expect(t.test_paid_texting_provider_cost_estimate_cents).toBe(Math.ceil((t.test_paid_texting_cents * p[1]) / p[0]));
      expect(call<{ ok: boolean }>("tw4_credit_verify", EP).ok).toBe(true);
    });

    it("test credit held by an open text is not counted twice: $10 own, $5 test, $3 texting hold -> a $10 fee passes, $10.01 does not", () => {
      resetPilot(1000);
      setBudget(EP, status(EP).granted_cents + 500);
      grant(EP, 500);
      psql(reserveSql(EP, SP, "sms_usage", 300));
      const s = status(EP);
      expect([s.balance_cents, s.reserved_cents, s.unused_cents, s.non_test_available_cents, s.ok]).toEqual([1500, 300, 500, 1000, true]);
      expect(hasCode(psqlError(reserveSql(EP, SP, "number", 1001)), "TW007")).toBe(true);
      psql(reserveSql(EP, SP, "number", 1000));
      expect(status(EP).non_test_available_cents).toBe(0);
      releaseAll(EP);
    });

    it("a texting charge is never refused by this migration, even beyond the balance (inbound and STOP-adjacent paths keep working)", () => {
      resetPilot(0);
      setBudget(EP, status(EP).granted_cents + 100);
      grant(EP, 100);
      // the ledger primitive the inbound recorder uses: a charge larger than everything still posts (the trigger only books consumption)
      psql(`begin; select public._tw4c_lock('${EP}'); select public._tw4c_post('${EP}', '${SP}', 'usage_charge', -250, 0, 'usage:in:fx-${hex(5)}', null, 'inbound', null, null); commit;`);
      const s = status(EP);
      expect([s.unused_cents, s.balance_cents, s.ok]).toEqual([0, -150, true]);
      // a negative account refuses a grant (test credit never pays a debt)
      expect(hasCode(grantErr(EP, 50), "TW007")).toBe(true);
      adjust(EP, 150);
    });

    it("a dispute never lands on test credit: $25 bought and spent, $10 test grant, $25 dispute leaves the balance at -$25 (all test credit forfeited)", () => {
      resetPilot(0);
      const pay = `cs_tc_${hex(6)}`;
      call("tw4_credit_settle_topup", EP, SP, pay, 2500, `evt_${hex(5)}`);
      call("tw4_credit_debit_usage", EP, SP, 2500, `tc-spend-${hex(4)}`, "fixture texting");
      expect(status(EP).balance_cents).toBe(0);
      setBudget(EP, status(EP).granted_cents + 1000);
      grant(EP, 1000);
      const before = status(EP);
      expect([before.balance_cents, before.unused_cents]).toEqual([1000, 1000]);
      call("tw4_credit_apply_dispute", pay, `dp_${hex(5)}`, 2500, "withdrawn", `evt_${hex(5)}`);
      const s = status(EP);
      expect([s.balance_cents, s.unused_cents, s.forfeited_cents - before.forfeited_cents, s.ok]).toEqual([-2500, 0, 1000, true]);
      expect(count(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EP}' and kind = 'test_grant_reversed' and idempotency_key like 'test_forfeit:%' and balance_delta_cents = -1000`)).toBe(1);
      expect(call<{ ok: boolean }>("tw4_credit_verify", EP).ok).toBe(true);
      adjust(EP, 2500);
    });

    it("a negative adjustment or a refund that keeps own money >= 0 forfeits nothing; one that takes it below zero forfeits all unused test credit", () => {
      resetPilot(600); // 600 own
      setBudget(EP, status(EP).granted_cents + 500);
      grant(EP, 500);
      adjust(EP, -600); // own 0: test credit untouched
      let s = status(EP);
      expect([s.balance_cents, s.unused_cents, s.non_test_available_cents, s.ok]).toEqual([500, 500, 0, true]);
      adjust(EP, -1); // own -1: everything forfeited, balance as without test credit
      s = status(EP);
      expect([s.balance_cents, s.unused_cents, s.ok]).toEqual([-1, 0, true]);
      adjust(EP, 1);
    });

    it("the studio view shows test credit separately and the $500 purchase ceiling ignores it (owner's own session)", () => {
      const owner = `ad${RUN}-0000-4000-8000-000000000703`;
      psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at) values ('${owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-${RUN}@tc-e2e.test', now(), now(), now()) on conflict (id) do nothing;
insert into public.profiles (id, platform_role) values ('${owner}', null) on conflict (id) do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${owner}', '${SP}', 'studio_owner', true) on conflict do nothing;
commit;`);
      const asOwner = (sql: string) => psql(`begin; set local role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: owner, role: "authenticated" })}', true); ${sql} commit;`).split("\n").pop() ?? "";
      resetPilot(47_000);
      setBudget(EP, status(EP).granted_cents + 1000);
      grant(EP, 1000);
      const ov = JSON.parse(asOwner(`select public.sms_credit_overview('${SP}')::text;`)) as Record<string, number>;
      expect([ov.balance_cents, ov.available_cents, ov.texting_available_cents, ov.test_credit_cents, ov.fee_available_cents]).toEqual([48_000, 48_000, 48_000, 1000, 47_000]);
      // own 47,000 + 2,500 fits; + 5,000 does not (before this migration the test credit would have blocked the $25 pack too: 48,000 + 2,500 > 50,000)
      const pack = `cs_tc_${hex(6)}`;
      call("tw4_credit_topup_pending", EP, SP, pack, 2500, null);
      expect(hasCode(callErr("tw4_credit_topup_pending", EP, SP, `cs_tc_${hex(6)}`, 5000, null), "TW009")).toBe(true);
      call("tw4_credit_topup_failed", pack, `evt_${hex(5)}`);
      resetPilot(0);
    });

    it("the verifier is not ok when unused test credit exceeds what the business holds (the invariant is checked, not assumed)", () => {
      resetPilot(0);
      setBudget(EP, status(EP).granted_cents + 200);
      grant(EP, 200);
      expect(status(EP).ok).toBe(true);
      // a forged debit that bypasses the trigger (replica mode only disables ordinary triggers; the test-credit trigger is ALWAYS, so drop it in a rolled-back transaction)
      const out = psql(`begin;
        alter table public.studio_sms_credit_ledger disable trigger studio_sms_credit_ledger_40_test_credit;
        select public._tw4c_post('${EP}', null, 'adjustment', -150, 0, 'adjust:forged-${hex(4)}', null, null, null, 'forged debit for the verifier check');
        select (public.tw4_credit_test_status('${EP}') ->> 'ok');
        rollback;`);
      expect(out.split("\n").pop()).toBe("false");
      expect(status(EP).ok).toBe(true);
    });
  });

  describe("7. reversal, hold, direct writes", () => {
    it("reverses only unused, unheld test credit; idempotent by key; allowed with the switch OFF; never frees budget", () => {
      resetPilot(0);
      setBudget(EP, status(EP).granted_cents + 800);
      grant(EP, 800);
      const left = status(EP).budget_left_cents;
      expect(left).toBe(0);
      expect(hasCode(callErr("tw4_credit_test_reverse", EP, 801, `rv-${hex(3)}`, "more than is unused here", P), "TW071")).toBe(true);
      expect(hasCode(callErr("tw4_credit_test_reverse", EP, 0, `rv-${hex(3)}`, "zero is not a reversal", P), "22023")).toBe(true);
      // money held by an open texting reservation cannot be reversed
      psql(reserveSql(EP, SP, "sms_usage", 500));
      expect(hasCode(callErr("tw4_credit_test_reverse", EP, 400, `rv-${hex(3)}`, "held by a reservation now", P), "TW007")).toBe(true);
      releaseAll(EP);
      switchTo(false);
      const k = `rv-${hex(4)}`;
      const r1 = call<{ replayed: boolean; entry_id: string }>("tw4_credit_test_reverse", EP, 800, k, "pilot test finished, unused", P);
      expect(r1.replayed).toBe(false);
      expect(call<{ replayed: boolean }>("tw4_credit_test_reverse", EP, 800, k, "pilot test finished, unused", P).replayed).toBe(true);
      expect(hasCode(callErr("tw4_credit_test_reverse", EP, 700, k, "pilot test finished, unused", P), "23505")).toBe(true);
      expect(psql(`select kind || ':' || balance_delta_cents from public.studio_sms_credit_ledger where id = '${r1.entry_id}'`)).toBe("test_grant_reversed:-800");
      const s = status(EP);
      expect([s.unused_cents, s.budget_left_cents, s.ok]).toEqual([0, 0, true]);
      switchTo(true);
      expect(hasCode(grantErr(EP, 1), "TW071")).toBe(true);
    });

    it("an account on hold refuses a grant", () => {
      setBudget(EP, status(EP).granted_cents + 100);
      call("tw4_credit_set_hold", EP, true, "fixture hold for the suite", P);
      expect(hasCode(grantErr(EP, 100), "TW007")).toBe(true);
      call("tw4_credit_set_hold", EP, false, "", P);
      grant(EP, 100);
    });

    it("test kinds, budgets, grants, movements and the switch can never be written directly (also in replica mode); nothing is edited, deleted or truncated", () => {
      const g = psql(`select id from public.studio_sms_test_credit_grants where legal_entity_id = '${EP}' limit 1`);
      const post = `select public._tw4c_post('${EP}', null, 'test_grant', 100, 0, 'test_grant:fx-${hex(4)}', null, null, null, null);`;
      expect(hasCode(psqlError(`begin; ${post} commit;`), "42501")).toBe(true);
      expect(hasCode(psqlError(`begin; set local session_replication_role = replica; ${post} commit;`), "42501")).toBe(true);
      expect(hasCode(psqlError(`begin; set local session_replication_role = replica; insert into public.studio_sms_credit_ledger (legal_entity_id, seq, kind, balance_delta_cents, idempotency_key)
        values ('${EP}', 999999, 'test_grant', 100, 'fx-${hex(4)}'); commit;`), "42501")).toBe(true);
      expect(hasCode(psqlError(`update public.studio_sms_test_credit_budgets set budget_cents = 50000 where legal_entity_id = '${EP}';`), "42501")).toBe(true);
      expect(hasCode(psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_test_credit_budgets set budget_cents = 50000 where legal_entity_id = '${EP}'; commit;`), "42501")).toBe(true);
      expect(hasCode(psqlError(`insert into public.studio_sms_test_credit_switch_log (enabled, changed_by, reason) values (true, '${P}', 'direct insert attempt');`), "42501")).toBe(true);
      expect(hasCode(psqlError(`update public.studio_sms_test_credit_grants set amount_cents = 1 where id = '${g}';`), "42501")).toBe(true);
      expect(hasCode(psqlError(`delete from public.studio_sms_test_credit_movements where legal_entity_id = '${EP}';`), "42501")).toBe(true);
      expect(hasCode(psqlError(`begin; select set_config('tw4.testcredit_write', 'on', true); update public.studio_sms_test_credit_budgets set granted_cents = 0 where legal_entity_id = '${EP}'; commit;`), "42501")).toBe(true);
      for (const t of TABLES) expect(hasCode(psqlError(`truncate public.${t} cascade;`), "42501"), t).toBe(true);
      expect(status(EP).ok).toBe(true);
    });
  });

  describe("8. concurrency", () => {
    const parallel = (sqls: string[]) =>
      Promise.all(sqls.map((sql) => new Promise<{ code: number; err: string }>((resolve) => {
        const p = spawn("docker", sqlArgs(), { stdio: ["pipe", "pipe", "pipe"] });
        let err = "";
        p.stderr.on("data", (d) => (err += String(d)));
        p.on("close", (code) => resolve({ code: code ?? 1, err }));
        p.stdin.end(`\\set VERBOSITY verbose\n${sql}`);
      })));

    it("a grant racing a switch-off waits for it and is refused (TW070): the grant reads the switch under the switch lock", async () => {
      setBudget(EP, status(EP).granted_cents + 50);
      const before = status(EP).granted_cents;
      const off = `begin; ${callSql("tw4_credit_test_set_switch", false, P, "race check: switching off")} select pg_sleep(3); commit;`;
      const late = `select pg_sleep(1); ${callSql("tw4_credit_test_grant", ...grantArgs(EP, 50, ref("race-switch")))}`;
      const [a, b] = await parallel([off, late]);
      expect(a.code).toBe(0);
      expect(hasCode(b.err, "TW070"), b.err).toBe(true);
      expect(status(EP).granted_cents).toBe(before);
      switchTo(true);
    });

    it("two grants racing for the last 300 cents of budget: exactly one succeeds; the same grant sent twice at once records once", async () => {
      resetPilot(0);
      setBudget(EP, status(EP).granted_cents + 300);
      const before = status(EP).granted_cents;
      const a = `begin; ${callSql("tw4_credit_test_grant", ...grantArgs(EP, 200, ref("race-a")))} select pg_sleep(1); commit;`;
      const b = `begin; ${callSql("tw4_credit_test_grant", ...grantArgs(EP, 200, ref("race-b")))} select pg_sleep(1); commit;`;
      const out = await parallel([a, b]);
      expect(out.map((o) => o.code).sort()).toEqual([0, 3]);
      expect(out.some((o) => hasCode(o.err, "TW071"))).toBe(true);
      expect(status(EP).granted_cents - before).toBe(200);
      setBudget(EP, status(EP).granted_cents + 100);
      const same = `begin; ${callSql("tw4_credit_test_grant", ...grantArgs(EP, 100, ref("race-same"), { doc: "AUTH-DOC-racesame1", sha: "c".repeat(64) }))} select pg_sleep(1); commit;`;
      const two = await parallel([same, same]);
      expect(two.map((o) => o.code)).toEqual([0, 0]);
      expect(count(`select count(*) from public.studio_sms_test_credit_grants where document_sha256 = '${"c".repeat(64)}'`)).toBe(1);
      expect(status(EP).ok).toBe(true);
    });
  });

  describe("9. rollback", () => {
    it("refuses while test-credit rows exist (evidence is never dropped)", () => {
      expect(psqlError(back)).toMatch(/Refusing to roll back 20270223091000/);
      expect(psql(`select to_regclass('public.studio_sms_test_credit_grants') is not null`)).toBe("t");
    });

    it("on a schema-only scratch copy: rollback removes everything and restores the constraints; it is re-runnable; forward re-applies to the same catalog; a second apply is refused", () => {
      const scratch = `tc_rb_${RUN}`;
      const sh = (cmd: string) => execFileSync("docker", ["exec", PG, "sh", "-c", cmd], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      const run = (sql: string) => execFileSync("docker", sqlArgs(scratch), { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      const fail = (sql: string) => {
        try {
          run(sql);
          return "";
        } catch (error) {
          return String((error as { stderr?: Buffer | string }).stderr ?? error);
        }
      };
      // the catalog pieces this migration touches, one line each: functions (body md5 + ACL), the three tables' constraints, the ledger's triggers
      const fpSql = `select kind || '|' || name || '|' || val from (
          select 'fn' kind, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' name, md5(p.prosrc) || '|' || coalesce(p.proacl::text, '') val
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
          union all select 'con', c.conrelid::regclass::text || '.' || c.conname, pg_get_constraintdef(c.oid) from pg_constraint c
            where c.conrelid in ('public.studio_sms_credit_ledger'::regclass, 'public.studio_sms_approval_refs'::regclass, 'public.studio_sms_onboarding_audit'::regclass)
          union all select 'trg', tgname, tgenabled::text from pg_trigger where tgrelid = 'public.studio_sms_credit_ledger'::regclass and not tgisinternal) x order by 1`;
      const fpLines = (r: (sql: string) => string) => r(fpSql).split("\n").filter(Boolean);
      /** constraints compared as logic: an OR / AND chain may be re-parenthesized by the deparser after a drop and re-add (same expression, different text) */
      const logical = (lines: string[]) => lines.map((l) => (l.startsWith("con|") ? l.replace(/[()\s]/g, "") : l));
      try {
        sh(`psql -U postgres -q -c 'create database ${scratch}'`);
        sh(`pg_dump -U postgres -s --no-owner ${DB} | psql -U postgres -d ${scratch} -q > /dev/null 2>&1; true`);
        const applied = fpLines(run);
        run(back);
        const rolled = fpLines(run);
        expect(rolled).not.toEqual(applied);
        expect(rolled.filter((l) => /tw4tc|tw4_credit_test|test_grant|test_credit|credit_test_/.test(l))).toEqual([]);
        // the two redefined functions are back to their predecessor bodies byte-exactly (the same md5 pins the forward checks)
        expect(run(`select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.sms_credit_overview(uuid)'::regprocedure`)).toBe("9c24016b4360b4a2ec382a9db97e09cd");
        expect(run(`select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_credit_topup_pending(uuid,uuid,text,integer,timestamp with time zone)'::regprocedure`)).toBe("2c7f609f3496572caf8c2e99ffc94831");
        expect(run(`select to_regclass('public.studio_sms_test_credit_budgets') is null and to_regprocedure('${GRANT}') is null
          and not exists (select 1 from pg_trigger where tgname = 'studio_sms_credit_ledger_40_test_credit')
          and not exists (select 1 from pg_constraint c where c.conrelid in ('public.studio_sms_credit_ledger'::regclass, 'public.studio_sms_approval_refs'::regclass, 'public.studio_sms_onboarding_audit'::regclass)
                          and (pg_get_constraintdef(c.oid) like '%test_grant%' or pg_get_constraintdef(c.oid) like '%test_credit%' or pg_get_constraintdef(c.oid) like '%credit_test_%'))`)).toBe("t");
        // the sibling sources and actions survive
        expect(run(`select pg_get_constraintdef(c.oid) like '%cancellation%' and pg_get_constraintdef(c.oid) like '%spend_authorization%' from pg_constraint c where c.conname = 'studio_sms_approval_refs_source_check'`)).toBe("t");
        expect(run(`select pg_get_constraintdef(c.oid) like '%rfl_cover_recorded%' from pg_constraint c where c.conname = 'studio_sms_onboarding_audit_action_check'`)).toBe("t");
        run(back); // re-runnable
        expect(fpLines(run)).toEqual(rolled);
        run(forward);
        const again = fpLines(run);
        const textual = again.filter((l, i) => l !== applied[i]);
        if (textual.length) console.log(["re-apply: textual-only catalog differences (checked logically below):", ...textual, "was:", ...applied.filter((l) => !again.includes(l))].join("\n"));
        expect(again.filter((l) => !l.startsWith("con|"))).toEqual(applied.filter((l) => !l.startsWith("con|")));
        expect(logical(again).sort()).toEqual(logical(applied).sort());
        expect(fail(forward)).toMatch(/already applied/);
      } finally {
        sh(`psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${scratch}'" -c 'drop database if exists ${scratch}' > /dev/null 2>&1; true`);
      }
    }, 900_000);
  });
  describe("10. mutation checks: each key guard, removed in a rolled-back transaction, lets the refused case through", () => {
    const fwd = forward.replace(/\r/g, "");
    const fnStmt = (name: string) => {
      const st = fwd.indexOf(`create or replace function public.${name}(`);
      expect(st, name).toBeGreaterThan(0);
      return fwd.slice(st, fwd.indexOf("end $$;", st) + 7);
    };
    const mutate = (name: string, from: string | RegExp, to: string) => {
      const orig = fnStmt(name);
      const out = orig.replace(from, to);
      expect(out, `mutation of ${name} must change its body`).not.toBe(orig);
      return out;
    };
    /** the scenario fails with the real guard (code) and succeeds with the mutated one; both inside a transaction that is rolled back */
    const proves = (code: string, mutated: string, scenario: string) => {
      expect(hasCode(psqlError(`begin; ${scenario} rollback;`), code), `control must fail with ${code}`).toBe(true);
      const err = psqlError(`begin; ${mutated} ${scenario} rollback;`);
      expect(err, "mutated scenario must pass").toBe("");
    };
    const granted = () => status(EP).granted_cents;
    const budgetSql = (cents: number, actor = P) => callSql("tw4_credit_test_budget_set", ...budgetArgs(EP, cents, ref("mut-b"), {}, actor));
    const grantSql = (cents: number, o: Ev = {}, actor = P) => callSql("tw4_credit_test_grant", ...grantArgs(EP, cents, ref("mut-g"), o, actor));

    it("kill switch (TW070)", () => {
      proves("TW070", mutate("tw4_credit_test_grant", "if not public._tw4tc_switch_on() then", "if false then"),
        `${callSql("tw4_credit_test_set_switch", false, P, "mutation check: switch off")} ${budgetSql(granted() + 50)} ${grantSql(50)}`);
    });
    it("test budget (TW071), enforced twice: the function check AND the table check (granted <= budget)", () => {
      const fn = mutate("tw4_credit_test_grant", "if b.granted_cents + p_cents > b.budget_cents then", "if false then");
      const scenario = `${budgetSql(granted())} ${grantSql(1)}`;
      // without the function check the table constraint still refuses (second layer)
      expect(hasCode(psqlError(`begin; ${fn} ${scenario} rollback;`), "23514")).toBe(true);
      // only with BOTH layers removed does an over-budget grant go through
      proves("TW071", `${fn} alter table public.studio_sms_test_credit_budgets drop constraint studio_sms_test_credit_budgets_within;`, scenario);
    });
    it("pilot business only (TW072)", () => {
      proves("TW072", mutate("tw4_credit_test_budget_set", "perform public._tw4tc_require_pilot(p_entity_id);", ""),
        callSql("tw4_credit_test_budget_set", ...budgetArgs(EN, 100, ref("mut-pilot"))));
    });
    it("U-4 evidence (TW052)", () => {
      proves("TW052", mutate("tw4_credit_test_grant", /perform public\._tw4tc_check_evidence\([\s\S]*?\);/, ""), `${budgetSql(granted() + 10)} ${grantSql(10, { on: day(3) })}`);
    });
    it("platform admin only (42501)", () => {
      proves("42501", mutate("tw4_credit_test_grant", "perform public._tw4c_admin(p_actor);", ""), `${budgetSql(granted() + 5)} ${grantSql(5, {}, N)}`);
    });
    it("texting only: the fee guard in the ledger trigger (TW007)", () => {
      const s0 = status(EP);
      expect(s0.unused_cents, "the suite leaves unused test credit for this check").toBeGreaterThan(0);
      proves("TW007", mutate("_tw4tc_on_ledger", "if a.balance_cents - a.reserved_cents - n.reserved_delta_cents - greatest(v_unused - v_open_sms, 0) < 0 then", "if false then"),
        reserveSql(EP, SP, "number", s0.non_test_available_cents + 1).replace(/^begin;|commit;$/gm, ""));
    });
    it("test kinds only from the grant / reverse functions (42501)", () => {
      proves("42501", mutate("_tw4tc_on_ledger", "if p_caller_flag <> 'on' then", "if false then"),
        `select public._tw4c_post('${EP}', null, 'test_grant', 100, 0, 'test_grant:mut-${hex(4)}', null, null, null, null);`);
    });

    /** the scenario passes with the real code and FAILS with the mutated one (the guard is what makes the good outcome happen) */
    const needed = (code: string, mutated: string, scenario: string) => {
      expect(psqlError(`begin; ${scenario} rollback;`), "control must pass").toBe("");
      expect(hasCode(psqlError(`begin; ${mutated} ${scenario} rollback;`), code), `mutated scenario must fail with ${code}`).toBe(true);
    };
    const assertSql = (cond: string, msg: string) => `do $a$ begin if not (${cond}) then raise exception '${msg}' using errcode = 'P0001'; end if; end $a$;`;

    it("forfeit on a non-texting debit: without it the test credit survives a debt and the verifier says not ok", () => {
      setBudget(EP, status(EP).granted_cents + 100);
      grant(EP, 100);
      const s0 = status(EP);
      expect(s0.unused_cents).toBeGreaterThan(0);
      const debit = -(Math.max(s0.non_test_available_cents, 0) + 1);
      const scenario = `select public.tw4_credit_adjust('${EP}', ${debit}, 'mut-forfeit-${hex(4)}', 'mutation check: debit below own money', '${P}');
        ${assertSql(`(public.tw4_credit_test_status('${EP}') ->> 'unused_cents')::bigint = 0 and (public.tw4_credit_test_status('${EP}') ->> 'ok')::boolean`, "test credit absorbed a debit")}`;
      needed("P0001", mutate("_tw4tc_on_ledger", "v_take := case when v_pool - v_unused < 0 then v_unused else 0 end;", "v_take := 0;"), scenario);
    });

    it("the in-flight texting hold is not counted twice: the old formula refuses a fee own money can pay (TW007)", () => {
      const s0 = status(EP);
      expect(s0.unused_cents).toBeGreaterThan(0);
      const scenario = `select public.tw4_credit_adjust('${EP}', 100, 'mut-own-${hex(4)}', 'mutation check: some own money', '${P}');
        ${reserveSql(EP, SP, "sms_usage", 1).replace(/^begin;|commit;$/gm, "")}
        ${reserveSql(EP, SP, "number", Math.max(s0.non_test_available_cents, 0) + 100).replace(/^begin;|commit;$/gm, "")}`;
      needed("TW007", mutate("_tw4tc_on_ledger", "n.reserved_delta_cents - greatest(v_unused - v_open_sms, 0) < 0 then", "n.reserved_delta_cents - v_unused < 0 then"), scenario);
    });
  });
});
