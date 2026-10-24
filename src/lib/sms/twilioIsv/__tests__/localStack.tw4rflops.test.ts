/**
 * TW-4F RFL operational database controls (20261211090000) against a REAL schema: kill switches (fail closed), scan heartbeat / lease / health, exposure aging and variance
 * reports with an append-only acknowledgement, owner-notice escalation, exhausted-delivery escalation, recipient lookup with tenant isolation, the per-recipient delivery record,
 * and DUAL CONTROL (two distinct platform administrators) enforced inside tw4_rfl_exposure_dispose (absorbed) and tw4_rfl_cancel_authorize (phone numbers).
 * Every scenario creates its own synthetic "world" (unique ids). Nothing reaches Twilio, Stripe or any SMS / email channel.
 *
 * LOCAL QA DATABASE ONLY. Skipped unless both variables are set and the database carries the local-QA marker table (created by LOCAL QA fixtures only; no migration creates
 * it) with the migrations through 20261211090000 applied. Use an ISOLATED database cloned from the QA stack, not the stack's shared one:
 *
 *   TW4A_LOCAL_DB_CONTAINER=rfl-pg-qa  TW4RFL_DB=rfl_ops1
 *
 * The switches and the run table are GLOBAL state of the database: run this suite and localStack.tw4rfl.test.ts SERIALLY (`vitest run --no-file-parallelism`, or one after the
 * other), or give each its own database; never two at once against one database. Every scenario restores the switch state it found (afterEach); "no row" checks run inside a
 * transaction that is rolled back, and the only direct fixture edits are of rows this suite created or of runs still marked running (closed as failed).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceApplied, pilotCoverArgs } from "./rflEvidenceHelper";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `ab${RUN}-0000-4000-8000-000000000501`; // platform admins (verified emails)
const P2 = `ab${RUN}-0000-4000-8000-000000000502`;
const P3 = `ab${RUN}-0000-4000-8000-000000000503`;

const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", sqlArgs, { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const psqlAsync = (sql: string): Promise<{ out: string; err: string }> =>
  new Promise((resolve) => {
    const child = spawn("docker", sqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => resolve({ out: out.trim(), err: code === 0 ? "" : err || "failed" }));
    child.stdin.end(`\\set VERBOSITY verbose\n${sql}`);
  });
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  const s = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
};
const callSql = (fn: string, ...args: unknown[]) => `select public.${fn}(${args.map(lit).join(", ")})::text;`;
const call = <T = Record<string, unknown>>(fn: string, ...args: unknown[]): T => JSON.parse(psql(callSql(fn, ...args)) || "null") as T;
const callErr = (fn: string, ...args: unknown[]) => psqlError(callSql(fn, ...args));
const hasCode = (err: string, code: string) => new RegExp(`ERROR:\\s+${code}:`).test(err);
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);
const rows = <T = Record<string, unknown>>(sql: string): T[] => JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json)::text from (${sql}) t;`)) as T[];
const num = (sql: string): number => Number(psql(sql));

const sid = (prefix: string) => `${prefix}${randomBytes(16).toString("hex")}`;
const digest = () => randomBytes(32).toString("hex");
const ref = (label: string) => `Written approval ${RUN} ${label} ${randomBytes(3).toString("hex")}`;
const NOTE = "a second administrator reviewed and approves this request";

type World = { entity: string; studio: string; owner: string; account: string; pilot: boolean; n: number };
let worldSeq = 0;
const PRICE = { number: 0, monthly: 0 };
const EXP = { number: 0, monthly: 0 }; // the published EXPECTED provider cost (internal), read from the database
const cur = () => psql("select to_char(now() at time zone 'UTC', 'YYYY-MM')");
const keyAdd = (key: string, n: number) => psql(`select to_char((${lit(key + "-01")}::date + make_interval(months => ${n})), 'YYYY-MM')`);
const prevKey = () => keyAdd(cur(), -1);

function mkUser(o: { confirmed?: boolean; email?: string | null; banned?: boolean; deleted?: boolean; admin?: boolean } = {}): string {
  const id = randomUUID();
  const email = o.email === undefined ? `u-${RUN}-${id.slice(0, 8)}@rfl-ops.test` : o.email;
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, banned_until, deleted_at, created_at, updated_at, last_sign_in_at)
  values ('${id}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email === null ? "null" : `'${email}'`}, ${o.confirmed === false ? "null" : "now()"},
          ${o.banned ? "now() + interval '1 day'" : "null"}, ${o.deleted ? "now()" : "null"}, now(), now(), now());
insert into public.profiles (id, platform_role) values ('${id}', ${o.admin ? "'platform_admin'" : "null"}) on conflict (id) do update set platform_role = ${o.admin ? "'platform_admin'" : "null"};
commit;`);
  return id;
}
const addRole = (user: string, studio: string, role: string, active = true) =>
  psql(`insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${user}', '${studio}', '${role}', ${active});`);

/** A fresh synthetic business with one location, an active subaccount, funded credit and a monthly limit. */
function world(opts: { fund?: number } = {}): World {
  worldSeq += 1;
  const w: World = { entity: randomUUID(), studio: randomUUID(), owner: randomUUID(), account: sid("AC"), pilot: false, n: worldSeq };
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${RUN}-${w.n}@rfl-ops.test', now(), now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'RFLOPS ${RUN} ${w.n}', 'rflops-${RUN}-${w.n}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', 'RFLOPS World ${RUN} ${w.n} LLC', '7777', 500000, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at)
  values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: verified synthetic business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by)
  values ('${w.entity}', '${w.account}', 'rflops-${RUN}-${w.n}', 'test', 'active', '${P}');
commit;`);
  call("tw4_credit_adjust", w.entity, opts.fund ?? 200_000, `rflops-fund-${RUN}-${w.n}`, "fixture funding for the ops suite", P);
  call("tw4_monthly_limit_set_admin", w.entity, P, 20_000, null, "fixture: monthly limit for the ops suite");
  return w;
}
/** A second location of the same legal business, with its own verified owner. */
function addLocation(w: World): { studio: string; owner: string } {
  const studio = randomUUID();
  const owner = mkUser({ confirmed: true });
  psql(`insert into public.studios (id, name, slug, public_name, timezone) values ('${studio}', 'RFLOPS loc ${RUN} ${randomBytes(2).toString("hex")}', 'rflops-loc-${RUN}-${randomBytes(2).toString("hex")}', null, 'UTC');`);
  addRole(owner, studio, "studio_owner");
  replica(`insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location', now());`);
  return { studio, owner };
}

let pilotShared: { entity: string; account: string } | null = null;
function pilotWorld(): World {
  worldSeq += 1;
  if (!pilotShared) {
    const existing = psql(`select e.id || '|' || coalesce(t.twilio_account_sid, '') from public.studio_sms_legal_entities e left join public.studio_sms_twilio_accounts t on t.legal_entity_id = e.id
      where e.legal_name_key = public._tw4f3a_name_key('ConfiDance Unlimited, LLC')`);
    if (existing) {
      const [entity, account] = existing.split("|");
      pilotShared = { entity, account };
    } else {
      const entity = randomUUID();
      const account = sid("AC");
      const studio = randomUUID();
      psql(`begin;
insert into public.studios (id, name, slug, public_name, timezone) values ('${studio}', 'RFLOPS pilot founding', 'rflops-pilot-${RUN}', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${entity}', 'ConfiDance Unlimited, LLC', '9999', 15000, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${studio}', '${entity}', 'founding', '${P}', 'fixture: verified synthetic pilot business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${entity}', '${account}', 'rflops-pilot', 'test', 'active', '${P}');
commit;`);
      call("tw4_credit_adjust", entity, 200_000, `rflops-fund-pilot-${RUN}`, "fixture funding for the ops suite", P);
      call("tw4_monthly_limit_set_admin", entity, P, 20_000, null, "fixture: monthly limit for the ops suite");
      call("tw4_pilot_exception_create", entity, 15000, `Founder written pilot approval ${RUN}`, P);
      pilotShared = { entity, account };
    }
  }
  const w: World = { entity: pilotShared.entity, studio: randomUUID(), owner: randomUUID(), account: pilotShared.account, pilot: true, n: worldSeq };
  replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = coalesce(closed_at, now()) where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured');
    update public.studio_sms_spend_events set status = 'void' where legal_entity_id = '${w.entity}' and status in ('authorized', 'reserved');
    update public.studio_sms_pilot_exceptions set ceiling_cents = 15000 where legal_entity_id = '${w.entity}';
    update public.studio_sms_credit_accounts set hold = false, hold_reason = null where legal_entity_id = '${w.entity}';`);
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'po-${RUN}-${w.n}@rfl-ops.test', now(), now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'RFLOPS pilot ${RUN} ${w.n}', 'rflops-pilot-${RUN}-${w.n}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
commit;
begin; set local session_replication_role = replica;
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now());
commit;`);
  return w;
}

const register = (w: World, kind: "number" | "campaign" | "messaging_service") => {
  const providerSid = sid(kind === "number" ? "PN" : kind === "campaign" ? "QE" : "MG");
  const e164 = kind === "number" ? `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}` : null;
  const out = call<{ resource_id: string; fee_kind: string | null }>("tw4_rfl_register", w.studio, P, kind, providerSid, w.account, e164, "admin", null, null);
  return { ...out, sid: providerSid, e164 };
};
const authFixture = (w: World, kind: "number" | "monthly" | "monthly_low_volume", o: { startsDaysAgo?: number; expiresInDays?: number; status?: "active" | "revoked" } = {}) => {
  const id = randomUUID();
  const price = kind === "number" ? PRICE.number : PRICE.monthly; // (the price list is not consulted by a fixture row)
  const revoked = o.status === "revoked";
  replica(`insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, starts_at, expires_at, status, authorized_by, statement, revoked_at, revoked_by)
    values ('${id}', '${w.entity}', '${w.studio}', '${kind}', ${price}, 6, ${price * 6}, now() - interval '${o.startsDaysAgo ?? 90} days', now() + interval '${o.expiresInDays ?? 90} days',
            '${revoked ? "revoked" : "active"}', '${w.owner}', 'fixture: the owner authorized this recurring charge in the suite', ${revoked ? "now()" : "null"}, ${revoked ? `'${w.owner}'` : "null"});`);
  return id;
};
const age = (resourceId: string, days = 75) => replica(`update public.studio_sms_provider_resources set registered_at = registered_at - interval '${days} days' where id = '${resourceId}';`);
const scan = (w: World) => call<{ opened: number; closed: number; alerts: number }>("tw4_rfl_scan_entity", w.entity);
const exposureOf = (resourceId: string, period: string) =>
  rows<{ state: string; disposition: string | null; billed: number }>(`select state, disposition, provider_billed_cents as billed from public.studio_sms_provider_exposure where resource_id = '${resourceId}' and period_key = '${period}'`)[0];
const audit = (w: World, action: string) => num(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = '${action}'`);
const alertsOf = (w: World, kind: string) => rows<{ id: string; audience: string; dedupe_key: string; summary: string }>(
  `select id, audience, dedupe_key, summary from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' and kind = '${kind}' order by created_at, id`);
const reqStatus = (id: string) => psql(`select status from public.studio_sms_rfl_dual_requests where id = '${id}'`);
const money = (w: World) => psql(`select json_build_object('bal', a.balance_cents, 'res', a.reserved_cents, 'ledger', (select count(*) from public.studio_sms_credit_ledger l where l.legal_entity_id = a.legal_entity_id),
  'charges', (select count(*) from public.studio_sms_recurring_charges c where c.legal_entity_id = a.legal_entity_id),
  'auths', (select json_agg(x.expires_at order by x.id) from public.studio_sms_recurring_authorizations x where x.legal_entity_id = a.legal_entity_id))::text from public.studio_sms_credit_accounts a where a.legal_entity_id = '${w.entity}'`);
/** Switches on / off (global state) with the audited function. */
const setSwitch = (name: "scan" | "delivery", on: boolean) => call("tw4_rfl_set_switch", name, on, P, `fixture: ${name} ${on ? "on" : "off"} for the ops suite`);
/** An exposure on the PREVIOUS period of a freshly registered, aged resource. */
const exposed = (w: World, kind: "campaign" | "number" = "campaign") => {
  const res = register(w, kind);
  age(res.resource_id);
  scan(w);
  return { res, key: prevKey() };
};
const mkAlert = (w: World, o: { studio?: string | null; audience?: "owner" | "admin" | "both"; kind?: string; status?: string } = {}) => {
  const id = randomUUID();
  psql(`insert into public.studio_sms_provider_alerts (id, legal_entity_id, studio_id, kind, dedupe_key, audience, severity, summary, status)
    values ('${id}', '${w.entity}', ${o.studio === undefined ? `'${w.studio}'` : o.studio ? `'${o.studio}'` : "null"}, '${o.kind ?? "exposure_open"}', 'ops:${id}', '${o.audience ?? "both"}', 'warning', 'fixture alert for the ops suite', '${o.status ?? "pending"}');`);
  return id;
};
const isolateAlerts = (keep: string[]) =>
  replica(`update public.studio_sms_provider_alerts set status = 'delivered', delivered_at = now() where status <> 'delivered' and id <> all (array[${keep.map((k) => `'${k}'::uuid`).join(",") || "null::uuid"}]);`);
const claimAll = () => rows<{ alert_id: string; claim_token: string; legal_entity_id: string }>(`select * from public.tw4_rfl_alerts_claim(100)`);
const absorbRequest = (resourceId: string, period: string, note: string, actor = P) => call<{ request_id: string; facts_hash: string; expires_at: string; status: string; replayed: boolean }>(
  "tw4_rfl_dual_request", actor, "absorb_exposure", resourceId, period, note, null);
const cancelRequest = (resourceId: string, approval: string, reason: string, actor = P, decidedBy = "owner_written") => call<{ request_id: string; facts_hash: string; expires_at: string; status: string; replayed: boolean }>(
  "tw4_rfl_dual_request", actor, "cancel_number", resourceId, null, reason, approval, decidedBy);
const swState = (name: "scan" | "delivery") => psql(`select public.tw4_rfl_switch_enabled('${name}')::text`) === "true";
const dispose = (resourceId: string, period: string, note: string, actor = P) => callErr("tw4_rfl_exposure_dispose", resourceId, period, actor, "absorbed", note);
const REASON = "DanceFlow accepts the cost of this lapsed period";

describe.skipIf(!enabled)("TW-4F RFL ops (real schema)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`)).toBe("t");
    expect(psql(`select to_regclass('public.studio_sms_rfl_dual_requests') is not null`)).toBe("t");
    for (const [id, label] of [[P, "a"], [P2, "b"], [P3, "c"]] as const) {
      psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at)
  values ('${id}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${label}-${RUN}@rfl-ops.test', now(), now(), now(), now());
insert into public.profiles (id, platform_role) values ('${id}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
commit;`);
    }
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150]] as const) {
      if (!psql(`select 1 from public.studio_sms_price_list where kind = '${kind}' and active`)) call("tw4_price_set", kind, customer, provider, `fixture ${kind} price`, P);
    }
    PRICE.number = num(`select customer_price_cents from public.studio_sms_price_list where kind = 'number' and active`);
    PRICE.monthly = num(`select customer_price_cents from public.studio_sms_price_list where kind = 'monthly' and active`);
    EXP.number = num(`select provider_cost_cents from public.studio_sms_price_list where kind = 'number' and active`);
    EXP.monthly = num(`select provider_cost_cents from public.studio_sms_price_list where kind = 'monthly' and active`);
    // earlier runs' administrators must not crowd this run's out of the (capped, ordered) recipient lists; scratch database only
    replica(`update public.profiles set platform_role = null where platform_role = 'platform_admin' and id not in ('${P}', '${P2}', '${P3}');`);
  });

  let savedSwitches = { scan: false, delivery: false };
  beforeEach(() => {
    savedSwitches = { scan: swState("scan"), delivery: swState("delivery") };
  });
  afterEach(() => {
    // each scenario restores the switch state it found (the log is append-only, so this adds rows rather than editing any)
    for (const name of ["scan", "delivery"] as const) if (swState(name) !== savedSwitches[name]) setSwitch(name, savedSwitches[name]);
  });

  afterAll(() => {
    // the switches are global: leave both OFF (fail closed) for whatever runs next
    if (!enabled) return;
    try {
      setSwitch("scan", false);
      setSwitch("delivery", false);
    } catch {
      /* the database may already be gone */
    }
  });

  describe("kill switches (fail closed)", () => {
    it("default OFF: with no log row both switches are off, an unknown switch is off; the latest audited row wins; invalid requests change nothing", () => {
      // no row at all (inside a transaction that is rolled back): every switch is off
      expect(psql(`begin; set local session_replication_role = replica; truncate public.studio_sms_rfl_switch_log; set local session_replication_role = origin;
        select public.tw4_rfl_switch_enabled('scan')::text || public.tw4_rfl_switch_enabled('delivery')::text || public.tw4_rfl_switch_enabled('bogus')::text || public.tw4_rfl_switch_enabled(null)::text; rollback;`)).toBe("falsefalsefalsefalse");
      expect(call<{ switch: string; enabled: boolean }>("tw4_rfl_set_switch", "scan", true, P, "fixture: scan on for the ops suite")).toEqual({ switch: "scan", enabled: true });
      expect(psql(`select public.tw4_rfl_switch_enabled('scan')::text || public.tw4_rfl_switch_enabled('delivery')::text`)).toBe("truefalse"); // switches are independent
      setSwitch("delivery", true);
      setSwitch("scan", false);
      expect(psql(`select public.tw4_rfl_switch_enabled('scan')::text || public.tw4_rfl_switch_enabled('delivery')::text`)).toBe("falsetrue");
      setSwitch("delivery", false);
      const n = num(`select count(*) from public.studio_sms_rfl_switch_log`);
      expect(hasCode(callErr("tw4_rfl_set_switch", "scan", true, P, "short"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_set_switch", "bogus", true, P, "a long enough written reason"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_set_switch", "scan", null, P, "a long enough written reason"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_set_switch", "scan", true, P, "x".repeat(301)), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_set_switch", "scan", true, randomUUID(), "a long enough written reason"), "42501")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_set_switch", "scan", true, mkUser(), "a long enough written reason"), "42501")).toBe(true);
      expect(num(`select count(*) from public.studio_sms_rfl_switch_log`)).toBe(n);
      expect(psql(`begin; set local session_replication_role = replica; truncate public.studio_sms_rfl_switch_log; set local session_replication_role = origin; select public.tw4_rfl_switch_enabled('delivery')::text; rollback;`)).toBe("false");
    });

    it("every change is audited, and the log is append-only evidence (no update, delete or truncate)", () => {
      world(); // the platform-level audit row hangs on the first linked location
      const before = num(`select count(*) from public.studio_sms_onboarding_audit where action = 'rfl_switch_set'`);
      setSwitch("scan", true);
      setSwitch("scan", false);
      expect(num(`select count(*) from public.studio_sms_onboarding_audit where action = 'rfl_switch_set'`)).toBe(before + 2);
      expect(psql(`select note from public.studio_sms_onboarding_audit where action = 'rfl_switch_set' order by created_at desc limit 1`)).toMatch(/^switch=scan;enabled=false;/);
      const id = psql(`select id from public.studio_sms_rfl_switch_log order by changed_at desc limit 1`);
      expect(psqlError(`update public.studio_sms_rfl_switch_log set enabled = true where id = '${id}';`)).toMatch(/append-only/);
      expect(psqlError(`delete from public.studio_sms_rfl_switch_log where id = '${id}';`)).toMatch(/never deleted/);
      expect(psqlError(`truncate public.studio_sms_rfl_switch_log;`)).not.toBe("");
    });

    it("tw4_rfl_alerts_claim (same signature) returns NOTHING while delivery is off, and claims once it is on; the scan switch does not enable delivery", () => {
      const w = world();
      register(w, "campaign");
      scan(w);
      const mine = alertsOf(w, "next_period_uncovered").map((a) => a.id);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      isolateAlerts(mine);
      setSwitch("delivery", false);
      setSwitch("scan", true);
      expect(claimAll()).toHaveLength(0);
      expect(num(`select count(*) from public.studio_sms_provider_alerts where id = '${mine[0]}' and status = 'pending' and attempts = 0`)).toBe(1);
      setSwitch("delivery", true);
      const got = claimAll();
      expect(got.map((c) => c.alert_id)).toContain(mine[0]);
      setSwitch("delivery", false);
      expect(claimAll()).toHaveLength(0);
      setSwitch("scan", false);
      expect(psql(`select pg_get_function_arguments('public.tw4_rfl_alerts_claim(integer)'::regprocedure)`)).toBe("p_limit integer");
    });
  });

  describe("scan heartbeat, lease and health", () => {
    // only runs still marked 'running' are closed (as failed); nothing is truncated
    const resetRuns = () => replica(`update public.studio_sms_rfl_runs set status = 'failed', finished_at = now(), error = 'closed by the ops suite' where status = 'running';`);

    it("does not run while the scan switch is off (nothing is recorded), takes one lease when on, is busy while it is held, and finishes exactly once", () => {
      resetRuns();
      setSwitch("scan", false);
      const runsBefore = num(`select count(*) from public.studio_sms_rfl_runs`);
      expect(call("tw4_rfl_scan_begin", "ops-runner", 600)).toEqual({ ran: false, reason: "switched_off", run_id: null });
      expect(num(`select count(*) from public.studio_sms_rfl_runs`)).toBe(runsBefore);
      setSwitch("scan", true);
      const first = call<{ ran: boolean; reason: string | null; run_id: string }>("tw4_rfl_scan_begin", "ops-runner", 600);
      expect(first).toMatchObject({ ran: true, reason: null });
      expect(first.run_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(call("tw4_rfl_scan_begin", "other-runner", 600)).toEqual({ ran: false, reason: "busy", run_id: null });
      expect(call("tw4_rfl_scan_finish", first.run_id, "completed", { entities: 3, opened: 1 }, null)).toEqual({ updated: true });
      expect(call("tw4_rfl_scan_finish", first.run_id, "failed", null, "too late")).toEqual({ updated: false }); // final once
      expect(psql(`select status || ':' || summary::text from public.studio_sms_rfl_runs where id = '${first.run_id}'`)).toBe('completed:{"opened": 1, "entities": 3}');
      const second = call<{ ran: boolean; run_id: string }>("tw4_rfl_scan_begin", "ops-runner", 600);
      expect(second.ran).toBe(true);
      call("tw4_rfl_scan_finish", second.run_id, "failed", null, "an error text");
      // switching the scan off stops the next run, not the evidence
      setSwitch("scan", false);
      expect(call<{ reason: string }>("tw4_rfl_scan_begin", "ops-runner", 600).reason).toBe("switched_off");
    });

    it("an expired lease is closed as failed by the next begin, and the stale run can no longer finish", () => {
      resetRuns();
      setSwitch("scan", true);
      const stale = call<{ run_id: string }>("tw4_rfl_scan_begin", "crashed-runner", 60);
      replica(`update public.studio_sms_rfl_runs set lease_expires_at = now() - interval '1 second' where id = '${stale.run_id}';`);
      const next = call<{ ran: boolean; run_id: string }>("tw4_rfl_scan_begin", "ops-runner", 600);
      expect(next.ran).toBe(true);
      expect(psql(`select status || ':' || error from public.studio_sms_rfl_runs where id = '${stale.run_id}'`)).toBe("failed:lease expired before the run finished");
      expect(call("tw4_rfl_scan_finish", stale.run_id, "completed", { a: 1 }, null)).toEqual({ updated: false });
      call("tw4_rfl_scan_finish", next.run_id, "completed", {}, null);
      setSwitch("scan", false);
    });

    it("validates its inputs: runner and lease, the status, a COUNTS-ONLY summary, an unknown run; runs are append-only", () => {
      resetRuns();
      setSwitch("scan", true);
      expect(hasCode(callErr("tw4_rfl_scan_begin", "xx", 600), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_scan_begin", "ops-runner", 59), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_scan_begin", "ops-runner", 3601), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_scan_begin", null, 600), "22023")).toBe(true);
      const run = call<{ run_id: string }>("tw4_rfl_scan_begin", "ops-runner", 600);
      expect(hasCode(callErr("tw4_rfl_scan_finish", run.run_id, "running", {}, null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_scan_finish", run.run_id, null, {}, null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_scan_finish", run.run_id, "completed", { note: "text is not a count" }, null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_scan_finish", run.run_id, "completed", { nested: { a: 1 } }, null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_scan_finish", run.run_id, "completed", [1, 2], null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_scan_finish", randomUUID(), "completed", {}, null), "22023")).toBe(true);
      expect(psql(`select status from public.studio_sms_rfl_runs where id = '${run.run_id}'`)).toBe("running"); // nothing above changed it
      call("tw4_rfl_scan_finish", run.run_id, "failed", null, "e".repeat(500));
      expect(num(`select char_length(error) from public.studio_sms_rfl_runs where id = '${run.run_id}'`)).toBe(300);
      expect(psqlError(`update public.studio_sms_rfl_runs set status = 'completed' where id = '${run.run_id}';`)).toMatch(/final/);
      expect(psqlError(`delete from public.studio_sms_rfl_runs where id = '${run.run_id}';`)).toMatch(/never deleted/);
      expect(psqlError(`truncate public.studio_sms_rfl_runs;`)).not.toBe("");
      setSwitch("scan", false);
    });

    it("concurrent begins take exactly one lease", async () => {
      resetRuns();
      setSwitch("scan", true);
      const results = await Promise.all([1, 2, 3, 4, 5].map((i) => psqlAsync(callSql("tw4_rfl_scan_begin", `race-${i}-runner`, 600))));
      expect(results.every((r) => r.err === "")).toBe(true);
      const parsed = results.map((r) => JSON.parse(r.out) as { ran: boolean; reason: string | null });
      expect(parsed.filter((r) => r.ran)).toHaveLength(1);
      expect(parsed.filter((r) => !r.ran).every((r) => r.reason === "busy")).toBe(true);
      expect(num(`select count(*) from public.studio_sms_rfl_runs where status = 'running'`)).toBe(1);
      resetRuns();
      setSwitch("scan", false);
    });

    it("health: never ran = stale; a recent completed run is fresh; 26 hours without a completed run is stale; failures in 24 h are counted; admin only", () => {
      resetRuns();
      setSwitch("scan", false);
      setSwitch("delivery", false);
      const never = JSON.parse(psql(`begin; set local session_replication_role = replica; truncate public.studio_sms_rfl_runs; set local session_replication_role = origin;
        select public.tw4_rfl_health('${P}')::text; rollback;`)) as Record<string, unknown>;
      expect(never).toMatchObject({ scan_switch: false, delivery_switch: false, last_run_at: null, last_success_at: null, last_status: null, stale: true, runs_failed_24h: 0 });
      expect(Object.keys(never).sort()).toEqual(["alerts_exhausted", "alerts_failed", "alerts_pending", "delivery_switch", "last_run_at", "last_status", "last_success_at", "oldest_pending_alert_age_seconds",
        "open_cancel_operations", "open_exposure_count", "runs_failed_24h", "scan_switch", "stale"]);
      setSwitch("scan", true);
      const run = call<{ run_id: string }>("tw4_rfl_scan_begin", "ops-runner", 600);
      call("tw4_rfl_scan_finish", run.run_id, "completed", { entities: 1 }, null);
      const afterOk = call<Record<string, number>>("tw4_rfl_health", P);
      expect(afterOk).toMatchObject({ scan_switch: true, last_status: "completed", stale: false });
      const failed = call<{ run_id: string }>("tw4_rfl_scan_begin", "ops-runner", 600);
      call("tw4_rfl_scan_finish", failed.run_id, "failed", null, "boom");
      expect(call("tw4_rfl_health", P2)).toMatchObject({ last_status: "failed", stale: false, runs_failed_24h: afterOk.runs_failed_24h + 1 });
      replica(`update public.studio_sms_rfl_runs set started_at = started_at - interval '27 hours', finished_at = finished_at - interval '27 hours', lease_expires_at = lease_expires_at - interval '27 hours' where status = 'completed';`);
      expect(call("tw4_rfl_health", P)).toMatchObject({ stale: true });
      replica(`update public.studio_sms_rfl_runs set started_at = started_at - interval '25 hours', finished_at = finished_at - interval '25 hours', lease_expires_at = lease_expires_at - interval '25 hours' where status = 'failed';`);
      expect(call("tw4_rfl_health", P)).toMatchObject({ runs_failed_24h: 0 }); // the failure is older than 24 h
      expect(hasCode(callErr("tw4_rfl_health", mkUser()), "42501")).toBe(true);
      resetRuns();
      setSwitch("scan", false);
    });

    it("health counts alerts (pending / failed / exhausted, oldest pending age), open exposure and open cancellations", () => {
      const w = world();
      exposed(w, "number");
      const mineAlerts = alertsOf(w, "exposure_open").map((a) => a.id);
      const base = call<Record<string, number>>("tw4_rfl_health", P);
      expect(base.open_exposure_count).toBeGreaterThanOrEqual(1);
      isolateAlerts(mineAlerts);
      const iso = call<Record<string, number | null>>("tw4_rfl_health", P);
      const pend = mkAlert(w, { status: "pending" });
      replica(`update public.studio_sms_provider_alerts set created_at = now() - interval '2 hours' where id = '${pend}';`);
      const failedA = mkAlert(w, { status: "failed" });
      const exhaustedA = mkAlert(w, { status: "failed" });
      replica(`update public.studio_sms_provider_alerts set attempts = 5 where id = '${exhaustedA}'; update public.studio_sms_provider_alerts set attempts = 2 where id = '${failedA}';`);
      const stuck = mkAlert(w, { status: "sending" });
      replica(`update public.studio_sms_provider_alerts set attempts = 5, claim_token = '${randomUUID()}', claimed_at = now() - interval '20 minutes' where id = '${stuck}';`);
      const h = call<Record<string, number | null>>("tw4_rfl_health", P);
      expect((h.alerts_pending as number) - (iso.alerts_pending as number)).toBe(1);
      expect((h.alerts_failed as number) - (iso.alerts_failed as number)).toBe(2);
      expect((h.alerts_exhausted as number) - (iso.alerts_exhausted as number)).toBe(2); // failed at 5 attempts + a claim abandoned at the fifth
      expect(h.oldest_pending_alert_age_seconds as number).toBeGreaterThanOrEqual(2 * 3600 - 5);
      const ww = world();
      const camp = register(ww, "campaign");
      const before = call<Record<string, number>>("tw4_rfl_health", P).open_cancel_operations;
      call("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("health-op"), "owner_written", "The owner asked us in writing to cancel the campaign", true);
      expect(call<Record<string, number>>("tw4_rfl_health", P).open_cancel_operations).toBe(before + 1);
      replica(`update public.studio_sms_provider_alerts set status = 'delivered', delivered_at = now() where id in ('${pend}', '${failedA}', '${exhaustedA}', '${stuck}');`);
    });
  });

  describe("reports", () => {
    it("the exposure report: open exposure only, oldest first, aging buckets at their boundaries, resource facts and the dual-request status; admin only", () => {
      const w = world();
      const { res } = exposed(w, "number");
      age(res.resource_id, 220);
      scan(w);
      const all = rows<{ period_key: string }>(`select period_key from public.studio_sms_provider_exposure where resource_id = '${res.resource_id}' order by period_key`);
      expect(all.length).toBeGreaterThanOrEqual(6);
      const ages = [7, 8, 30, 31, 90, 91];
      all.slice(0, 6).forEach((r, i) =>
        replica(`update public.studio_sms_provider_exposure set first_detected_at = now() - interval '${ages[i]} days' - interval '1 hour' where resource_id = '${res.resource_id}' and period_key = '${r.period_key}';`));
      const report = call<Array<Record<string, unknown>>>("tw4_rfl_exposure_report", P);
      const mine = report.filter((r) => r.resource_id === res.resource_id);
      expect(mine.slice(0, 6).map((r) => r.aging_bucket)).toEqual(["90+", "31-90", "31-90", "8-30", "8-30", "0-7"]);
      expect(mine.slice(0, 6).map((r) => r.age_days)).toEqual([91, 90, 31, 30, 8, 7]);
      expect(mine[0]).toMatchObject({ legal_entity_id: w.entity, studio_id: w.studio, resource_id: res.resource_id, resource_kind: "number", fee_kind: "number", state: "open", reason: "no_authorization",
        expected_provider_cents: EXP.number, provider_billed_cents: 0, dual_request_status: null });
      expect(Object.keys(mine[0]).sort()).toEqual(["age_days", "aging_bucket", "dual_request_status", "expected_provider_cents", "fee_kind", "first_detected_at", "legal_entity_id", "period_key", "provider_billed_cents",
        "reason", "resource_id", "resource_kind", "state", "studio_id"]);
      // oldest first across the whole report
      const times = report.map((r) => Date.parse(String(r.first_detected_at)));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      // the dual-request status follows the request (pending, approved), and disappears when consumed
      const key = String(mine[0].period_key);
      const req = absorbRequest(res.resource_id, key, REASON);
      expect(call<Array<Record<string, unknown>>>("tw4_rfl_exposure_report", P).find((r) => r.resource_id === res.resource_id && r.period_key === key)?.dual_request_status).toBe("pending");
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      expect(call<Array<Record<string, unknown>>>("tw4_rfl_exposure_report", P).find((r) => r.resource_id === res.resource_id && r.period_key === key)?.dual_request_status).toBe("approved");
      expect(dispose(res.resource_id, key, REASON)).toBe("");
      // a closed exposure leaves the report
      expect(call<Array<Record<string, unknown>>>("tw4_rfl_exposure_report", P).some((r) => r.resource_id === res.resource_id && r.period_key === key)).toBe(false);
      expect(hasCode(callErr("tw4_rfl_exposure_report", w.owner), "42501")).toBe(true);
    });

    it("the variance report lists recorded recurring-fee variances newest first; one append-only acknowledgement per charge, DanceFlow-borne, never touching a ledger", () => {
      const w = world();
      const n1 = register(w, "number");
      age(n1.resource_id);
      scan(w);
      const k = prevKey();
      call("tw4_rfl_observe_provider_bill", n1.resource_id, k, `INV-${RUN}-${w.n}-var`, 999, P); // expected 115: a variance
      call("tw4_rfl_observe_provider_bill", n1.resource_id, keyAdd(k, 1), `INV-${RUN}-${w.n}-ok`, EXP.number, P); // matches: not a variance
      const chargeId = psql(`select id from public.studio_sms_provider_charges where legal_entity_id = '${w.entity}' and provider_ref = 'INV-${RUN}-${w.n}-var'`);
      const matched = psql(`select id from public.studio_sms_provider_charges where legal_entity_id = '${w.entity}' and provider_ref = 'INV-${RUN}-${w.n}-ok'`);
      const rep = () => call<Array<Record<string, unknown>>>("tw4_rfl_variance_report", P).filter((r) => r.legal_entity_id === w.entity);
      expect(rep()).toHaveLength(1);
      expect(rep()[0]).toMatchObject({ charge_id: chargeId, kind: "number", provider_ref: `INV-${RUN}-${w.n}-var`, expected_cost_cents: EXP.number, provider_cost_cents: 999, variance_cents: 999 - EXP.number, acknowledged: false, acknowledged_at: null, acknowledged_by: null, note: null });
      expect(Object.keys(rep()[0]).sort()).toEqual(["acknowledged", "acknowledged_at", "acknowledged_by", "charge_id", "expected_cost_cents", "kind", "legal_entity_id", "note", "provider_cost_cents", "provider_ref", "studio_id", "variance_cents"]);
      call("tw4_rfl_observe_provider_bill", n1.resource_id, keyAdd(k, -1), `INV-${RUN}-${w.n}-var2`, 500, P);
      const newest = call<Array<Record<string, unknown>>>("tw4_rfl_variance_report", P).filter((r) => r.legal_entity_id === w.entity).map((r) => r.provider_ref);
      expect(newest[0]).toBe(`INV-${RUN}-${w.n}-var2`);
      const before = money(w);
      expect(call("tw4_rfl_variance_ack", chargeId, P2, "reviewed with Twilio support; DanceFlow bears this variance")).toEqual({ acknowledged: true, replayed: false });
      expect(call("tw4_rfl_variance_ack", chargeId, P, "a second acknowledgement is only a replay of the first")).toEqual({ acknowledged: true, replayed: true });
      expect(num(`select count(*) from public.studio_sms_provider_variance_acks where charge_id = '${chargeId}'`)).toBe(1);
      expect(rep().find((r) => r.charge_id === chargeId)).toMatchObject({ acknowledged: true, acknowledged_by: P2, note: "reviewed with Twilio support; DanceFlow bears this variance" });
      expect(psql(`select outcome from public.studio_sms_provider_variance_acks where charge_id = '${chargeId}'`)).toBe("dancflow_borne");
      expect(audit(w, "rfl_variance_acked")).toBe(1);
      expect(money(w)).toBe(before); // D5: never charged, no ledger / balance / reservation / authorization change
      expect(hasCode(callErr("tw4_rfl_variance_ack", chargeId, w.owner, "an owner trying to acknowledge this"), "42501")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_variance_ack", randomUUID(), P, "an unknown charge cannot be acknowledged"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_variance_ack", matched, P, "a matched charge is not a variance at all"), "TW041")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_variance_ack", psql(`select id from public.studio_sms_provider_charges where provider_ref = 'INV-${RUN}-${w.n}-var2'`), P, "short"), "22023")).toBe(true);
      expect(psqlError(`update public.studio_sms_provider_variance_acks set note = 'rewritten after the fact by someone' where charge_id = '${chargeId}';`)).toMatch(/append-only/);
      expect(psqlError(`delete from public.studio_sms_provider_variance_acks where charge_id = '${chargeId}';`)).toMatch(/never deleted/);
      expect(psqlError(`update public.studio_sms_provider_variance_acks set outcome = 'charged' where charge_id = '${chargeId}';`)).not.toBe("");
      expect(hasCode(callErr("tw4_rfl_variance_report", w.owner), "42501")).toBe(true);
    });
  });

  describe("owner-notice escalation and exhausted-delivery escalation", () => {
    it("14 days before an authorization ends without a renewal: a second owner notice and an admin escalation, once each; the 35-day notice and exposure behaviour are unchanged", () => {
      const w = world();
      register(w, "number");
      const auth = authFixture(w, "number", { startsDaysAgo: 5, expiresInDays: 10 });
      scan(w);
      expect(alertsOf(w, "authorization_expiring")).toHaveLength(1); // the 35-day notice still fires
      const second = alertsOf(w, "owner_notice_second");
      const esc = alertsOf(w, "owner_unresponsive");
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({ audience: "both", dedupe_key: `auth2:${auth}` });
      expect(esc).toHaveLength(1);
      expect(esc[0]).toMatchObject({ audience: "admin", dedupe_key: `auth:${auth}:escalate` });
      expect(second[0].summary + esc[0].summary).not.toMatch(/\$|cents|token|AC[0-9a-f]{32}|PN[0-9a-f]{32}/i);
      scan(w);
      scan(w);
      expect(alertsOf(w, "owner_notice_second")).toHaveLength(1);
      expect(alertsOf(w, "owner_unresponsive")).toHaveLength(1);
      expect(alertsOf(w, "authorization_expiring")).toHaveLength(1);
      // nothing was extended, charged or created for the owner
      expect(num(`select count(*) from public.studio_sms_recurring_authorizations where studio_id = '${w.studio}'`)).toBe(1);
    });

    it("no second notice or escalation when the authorization ends later than 14 days, is already renewed, is revoked, or has no live resource", () => {
      const far = world();
      register(far, "number");
      authFixture(far, "number", { startsDaysAgo: 5, expiresInDays: 20 });
      scan(far);
      expect(alertsOf(far, "authorization_expiring")).toHaveLength(1);
      expect(alertsOf(far, "owner_notice_second")).toHaveLength(0);
      expect(alertsOf(far, "owner_unresponsive")).toHaveLength(0);

      // one active authorization per location and kind exists, so a renewal normally replaces the old one; a renewal under the OTHER campaign kind of the same fee
      // (the registration path changed) is the case where two are active at once
      const renewed = world();
      register(renewed, "campaign");
      authFixture(renewed, "monthly", { startsDaysAgo: 80, expiresInDays: 10 });
      authFixture(renewed, "monthly_low_volume", { startsDaysAgo: 1, expiresInDays: 150 }); // the owner's renewal, ending later
      scan(renewed);
      expect(alertsOf(renewed, "owner_notice_second")).toHaveLength(0);
      expect(alertsOf(renewed, "owner_unresponsive")).toHaveLength(0);
      // and without that later authorization the same expiring one DOES escalate
      const lone = world();
      register(lone, "campaign");
      authFixture(lone, "monthly", { startsDaysAgo: 80, expiresInDays: 10 });
      scan(lone);
      expect(alertsOf(lone, "owner_notice_second")).toHaveLength(1);
      expect(alertsOf(lone, "owner_unresponsive")).toHaveLength(1);

      const revoked = world();
      register(revoked, "number");
      authFixture(revoked, "number", { startsDaysAgo: 5, expiresInDays: 10, status: "revoked" });
      scan(revoked);
      expect(alertsOf(revoked, "owner_notice_second")).toHaveLength(0);

      const bare = world();
      register(bare, "campaign"); // a live campaign does not carry the number fee the authorization pays
      authFixture(bare, "number", { startsDaysAgo: 5, expiresInDays: 10 });
      scan(bare);
      expect(alertsOf(bare, "owner_notice_second")).toHaveLength(0);
    });

    it("an alert whose delivery was exhausted becomes ONE admin alert, once; retryable, delivered and the escalation itself are not escalated", () => {
      const w = world();
      const a = mkAlert(w, { status: "failed" });
      const retry = mkAlert(w, { status: "failed" });
      const delivered = mkAlert(w, { status: "pending" });
      const stuck = mkAlert(w, { status: "sending" });
      replica(`update public.studio_sms_provider_alerts set attempts = 5, last_error = 'smtp refused' where id = '${a}';
        update public.studio_sms_provider_alerts set attempts = 4 where id = '${retry}';
        update public.studio_sms_provider_alerts set status = 'delivered', delivered_at = now(), attempts = 5 where id = '${delivered}';
        update public.studio_sms_provider_alerts set attempts = 5, claim_token = '${randomUUID()}', claimed_at = now() - interval '30 minutes' where id = '${stuck}';`);
      const out = call<{ escalated: number }>("tw4_rfl_escalate_delivery");
      expect(out.escalated).toBeGreaterThanOrEqual(2);
      const esc = alertsOf(w, "alert_delivery_exhausted");
      expect(esc.map((e) => e.dedupe_key).sort()).toEqual([`exhausted:${a}`, `exhausted:${stuck}`].sort());
      expect(esc.every((e) => e.audience === "admin")).toBe(true);
      expect(esc.map((e) => e.summary).join(" ")).not.toMatch(/smtp|\$|cents|token/i);
      expect(call("tw4_rfl_escalate_delivery")).toEqual({ escalated: 0 });
      // an exhausted escalation does not escalate itself
      replica(`update public.studio_sms_provider_alerts set status = 'failed', attempts = 5 where id = '${esc[0].id}';`);
      expect(call("tw4_rfl_escalate_delivery")).toEqual({ escalated: 0 });
      expect(alertsOf(w, "alert_delivery_exhausted")).toHaveLength(2);
    });
  });

  describe("recipient lookup (tenant isolation, verified email only)", () => {
    const recips = (alertId: string) => rows<{ recipient_kind: string; user_id: string; studio_id: string | null; email: string; email_verified: boolean }>(`select * from public.tw4_rfl_alert_recipients('${alertId}')`);

    it("returns active verified studio owners of the alert's location and admins by audience; never unverified, banned, deleted, inactive or non-owner users", () => {
      const w = world(); // owner is verified
      const unverified = mkUser({ confirmed: false });
      const noEmail = mkUser({ email: null });
      const banned = mkUser({ banned: true });
      const deleted = mkUser({ deleted: true });
      const inactive = mkUser();
      const manager = mkUser();
      for (const u of [unverified, noEmail, banned, deleted, manager]) addRole(u, w.studio, u === manager ? "studio_admin" : "studio_owner");
      addRole(inactive, w.studio, "studio_owner", false);
      const owners = recips(mkAlert(w, { audience: "owner" }));
      expect(owners.map((r) => r.user_id)).toEqual([w.owner]);
      expect(owners[0]).toMatchObject({ recipient_kind: "owner", studio_id: w.studio, email_verified: true, email: `o-${RUN}-${w.n}@rfl-ops.test` });
      const admins = recips(mkAlert(w, { audience: "admin" }));
      expect(admins.every((r) => r.recipient_kind === "admin" && r.studio_id === w.studio && r.email_verified === true)).toBe(true); // an admin row carries the alert's own location
      expect(admins.map((r) => r.user_id)).toEqual(expect.arrayContaining([P, P2, P3]));
      expect(admins.map((r) => r.user_id)).not.toContain(w.owner);
      const both = recips(mkAlert(w, { audience: "both" }));
      expect(both.filter((r) => r.recipient_kind === "owner").map((r) => r.user_id)).toEqual([w.owner]);
      expect(both.filter((r) => r.recipient_kind === "admin").length).toBe(admins.length);
      // an unverified platform administrator is never a recipient
      const unverifiedAdmin = mkUser({ confirmed: false, admin: true });
      expect(recips(mkAlert(w, { audience: "admin" })).map((r) => r.user_id)).not.toContain(unverifiedAdmin);
      replica(`update public.profiles set platform_role = null where id = '${unverifiedAdmin}';`);
      expect(Object.keys(rows(`select * from public.tw4_rfl_alert_recipients('${mkAlert(w, { audience: "owner" })}')`)[0]).sort()).toEqual(["email", "email_verified", "recipient_kind", "studio_id", "user_id"]);
    });

    it("an administrator row always carries a non-null studio_id: the alert's own, else the earliest-linked location of its legal business", () => {
      const w = world();
      const second = addLocation(w);
      expect(second.studio).toBeTruthy();
      replica(`update public.studio_sms_entity_studios set linked_at = now() - interval '1 day' where studio_id = '${w.studio}';`);
      const entityAlert = recips(mkAlert(w, { studio: null, audience: "both" }));
      expect(entityAlert.filter((r) => r.recipient_kind === "admin").length).toBeGreaterThanOrEqual(1);
      expect(entityAlert.every((r) => typeof r.studio_id === "string" && r.studio_id.length > 0)).toBe(true);
      expect(entityAlert.filter((r) => r.recipient_kind === "admin").every((r) => r.studio_id === w.studio)).toBe(true);
      replica(`update public.studio_sms_entity_studios set linked_at = now() - interval '2 days' where studio_id = '${second.studio}';`);
      expect(recips(mkAlert(w, { studio: null, audience: "admin" })).every((r) => r.studio_id === second.studio)).toBe(true);
      expect(recips(mkAlert(w, { studio: second.studio, audience: "admin" })).every((r) => r.studio_id === second.studio)).toBe(true);
    });

    it("an entity-level alert reaches the owners of EVERY location of that legal business and nobody else's; a location alert only that location's owners", () => {
      const a = world();
      const second = addLocation(a);
      const b = world(); // another legal business
      const shared = mkUser({ confirmed: true });
      addRole(shared, a.studio, "studio_owner");
      addRole(shared, b.studio, "studio_owner"); // an owner of both businesses legitimately appears for each, once
      const entityAlert = recips(mkAlert(a, { studio: null, audience: "owner" }));
      expect(entityAlert.map((r) => r.user_id).sort()).toEqual([a.owner, second.owner, shared].sort());
      expect(entityAlert.map((r) => r.user_id)).not.toContain(b.owner);
      const loc2 = recips(mkAlert(a, { studio: second.studio, audience: "owner" }));
      expect(loc2.map((r) => r.user_id)).toEqual([second.owner]);
      const loc1 = recips(mkAlert(a, { audience: "owner" }));
      expect(loc1.map((r) => r.user_id).sort()).toEqual([a.owner, shared].sort());
      expect(recips(mkAlert(b, { audience: "owner" })).map((r) => r.user_id).sort()).toEqual([b.owner, shared].sort());
      // an alert that names a location of ANOTHER business returns no owner at all (the link row ties the location to its own business)
      const crossed = recips(mkAlert(a, { studio: b.studio, audience: "owner" }));
      expect(crossed).toEqual([]);
      // a multi-location owner is one recipient
      addRole(shared, second.studio, "studio_owner");
      expect(recips(mkAlert(a, { studio: null, audience: "owner" })).filter((r) => r.user_id === shared)).toHaveLength(1);
    });

    it("caps at 5 owners and 10 administrators; nothing for an unknown or already delivered alert", () => {
      const w = world();
      for (let i = 0; i < 6; i++) addRole(mkUser({ confirmed: true }), w.studio, "studio_owner"); // 7 verified owners in all
      const extraAdmins = Array.from({ length: 9 }, () => mkUser({ confirmed: true, admin: true })); // 12 verified administrators at least
      try {
        const both = recips(mkAlert(w, { audience: "both" }));
        expect(both.filter((r) => r.recipient_kind === "owner")).toHaveLength(5);
        expect(both.filter((r) => r.recipient_kind === "admin")).toHaveLength(10);
        expect(new Set(both.map((r) => `${r.recipient_kind}:${r.user_id}`)).size).toBe(15);
      } finally {
        replica(`update public.profiles set platform_role = null where id in (${extraAdmins.map((u) => `'${u}'`).join(",")});`);
      }
      expect(recips(randomUUID())).toEqual([]);
      const done = mkAlert(w, { audience: "both" });
      replica(`update public.studio_sms_provider_alerts set status = 'delivered', delivered_at = now() where id = '${done}';`);
      expect(recips(done)).toEqual([]);
    });

    it("is callable only by the service role", () => {
      for (const fn of ["tw4_rfl_alert_recipients(uuid)", "tw4_rfl_alert_delivery_record(uuid, uuid, text, text, text)"]) {
        expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute')::text || has_function_privilege('authenticated', 'public.${fn}', 'execute')::text
          || has_function_privilege('public', 'public.${fn}', 'execute')::text || has_function_privilege('service_role', 'public.${fn}', 'execute')::text`)).toBe("falsefalsefalsetrue");
      }
    });
  });

  describe("delivery record", () => {
    it("requires the current claim token; one row per (alert, recipient); replay-safe; never an email; audited without an address", () => {
      const w = world();
      const alert = mkAlert(w, { audience: "both" });
      isolateAlerts([alert]);
      setSwitch("delivery", true);
      try {
        const mine = claimAll().find((c) => c.alert_id === alert)!;
        expect(mine).toBeTruthy();
        const refOwner = `owner:${w.owner}`;
        expect(call("tw4_rfl_alert_delivery_record", alert, randomUUID(), refOwner, "owner", "queued")).toEqual({ recorded: false, replayed: false }); // not the current claim
        expect(call("tw4_rfl_alert_delivery_record", randomUUID(), mine.claim_token, refOwner, "owner", "queued")).toEqual({ recorded: false, replayed: false });
        expect(call("tw4_rfl_alert_delivery_record", alert, mine.claim_token, refOwner, "owner", "queued")).toEqual({ recorded: true, replayed: false });
        expect(call("tw4_rfl_alert_delivery_record", alert, mine.claim_token, refOwner, "owner", "duplicate")).toEqual({ recorded: true, replayed: true });
        expect(psql(`select outcome from public.studio_sms_rfl_alert_deliveries where alert_id = '${alert}' and recipient_ref = '${refOwner}'`)).toBe("queued"); // the first outcome stands
        expect(call("tw4_rfl_alert_delivery_record", alert, mine.claim_token, `admin:${P}`, "admin", "invalid_recipient")).toEqual({ recorded: true, replayed: false });
        expect(call("tw4_rfl_alert_delivery_record", alert, mine.claim_token, "admin:none", "admin", "no_recipient")).toEqual({ recorded: true, replayed: false });
        expect(num(`select count(*) from public.studio_sms_rfl_alert_deliveries where alert_id = '${alert}'`)).toBe(3);
        expect(audit(w, "rfl_alert_delivery")).toBe(3);
        expect(psql(`select string_agg(note, ' ') from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'rfl_alert_delivery'`)).not.toMatch(/@/);
        // invalid shapes
        for (const [r, k, o] of [["owner@example.com", "owner", "queued"], [`admin:${P}`, "owner", "queued"], [refOwner, "owner", "sent"], [refOwner, "boss", "queued"], ["owner:none", "owner", "queued"],
                                 [refOwner, "owner", "no_recipient"], ["owner:not-a-uuid", "owner", "queued"]] as const) {
          expect(hasCode(callErr("tw4_rfl_alert_delivery_record", alert, mine.claim_token, r, k, o), "22023")).toBe(true);
        }
        // once the claim is finished the token no longer records
        call("tw4_rfl_alert_finish", alert, mine.claim_token, true, null);
        expect(call("tw4_rfl_alert_delivery_record", alert, mine.claim_token, `owner:${randomUUID()}`, "owner", "queued")).toEqual({ recorded: false, replayed: false });
        expect(psqlError(`update public.studio_sms_rfl_alert_deliveries set outcome = 'duplicate' where alert_id = '${alert}';`)).toMatch(/append-only/);
        expect(psqlError(`delete from public.studio_sms_rfl_alert_deliveries where alert_id = '${alert}';`)).toMatch(/never deleted/);
        expect(psqlError(`insert into public.studio_sms_rfl_alert_deliveries (alert_id, claim_token, recipient_ref, recipient_kind, outcome) values ('${alert}', gen_random_uuid(), 'owner:person@example.com', 'owner', 'queued');`)).not.toBe("");
      } finally {
        setSwitch("delivery", false);
      }
    });

    it("concurrent records of the same recipient insert exactly one row", async () => {
      const w = world();
      const alert = mkAlert(w, { audience: "owner" });
      isolateAlerts([alert]);
      setSwitch("delivery", true);
      try {
        const mine = claimAll().find((c) => c.alert_id === alert)!;
        const r = `owner:${w.owner}`;
        const out = await Promise.all([1, 2, 3, 4].map(() => psqlAsync(callSql("tw4_rfl_alert_delivery_record", alert, mine.claim_token, r, "owner", "queued"))));
        expect(out.every((o) => o.err === "")).toBe(true);
        const parsed = out.map((o) => JSON.parse(o.out) as { recorded: boolean; replayed: boolean });
        expect(parsed.every((p) => p.recorded)).toBe(true);
        expect(parsed.filter((p) => !p.replayed)).toHaveLength(1);
        expect(num(`select count(*) from public.studio_sms_rfl_alert_deliveries where alert_id = '${alert}'`)).toBe(1);
      } finally {
        setSwitch("delivery", false);
      }
    });
  });

  describe("dual control: absorbing an exposure", () => {
    it("without an approved request the disposition is refused (TW042) and nothing changes; with one from a SECOND administrator it succeeds once, consumes the approval, and moves no money", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const money0 = money(w);
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open", disposition: null });
      const req = absorbRequest(res.resource_id, key, REASON);
      expect(req.facts_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(req.status).toBe("pending");
      expect(req.replayed).toBe(false);
      expect(num(`select extract(epoch from expires_at - requested_at) from public.studio_sms_rfl_dual_requests where id = '${req.request_id}'`)).toBe(86400);
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true); // pending is not approved
      expect(hasCode(callErr("tw4_rfl_dual_approve", req.request_id, P, NOTE), "42501")).toBe(true); // the requester cannot approve
      expect(reqStatus(req.request_id)).toBe("pending");
      expect(hasCode(callErr("tw4_rfl_dual_approve", req.request_id, w.owner, NOTE), "42501")).toBe(true); // nor can a non-administrator
      expect(hasCode(callErr("tw4_rfl_dual_approve", req.request_id, P2, "short"), "22023")).toBe(true);
      expect(call("tw4_rfl_dual_approve", req.request_id, P2, NOTE)).toMatchObject({ status: "approved" });
      expect(call("tw4_rfl_dual_approve", req.request_id, P2, NOTE)).toMatchObject({ status: "approved", replayed: true });
      expect(hasCode(callErr("tw4_rfl_dual_approve", req.request_id, P3, NOTE), "TW041")).toBe(true); // already decided by someone else
      expect(psql(`select decided_by from public.studio_sms_rfl_dual_requests where id = '${req.request_id}'`)).toBe(P2);
      // a non-administrator cannot execute it even with an approval on file
      expect(hasCode(callErr("tw4_rfl_exposure_dispose", res.resource_id, key, w.owner, "absorbed", REASON), "42501")).toBe(true);
      expect(call<{ replayed: boolean }>("tw4_rfl_exposure_dispose", res.resource_id, key, P3, "absorbed", REASON).replayed).toBe(false);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "closed", disposition: "absorbed" });
      expect(reqStatus(req.request_id)).toBe("consumed");
      expect(psql(`select consumed_by from public.studio_sms_rfl_dual_requests where id = '${req.request_id}'`)).toBe(P3);
      for (const a of ["rfl_dual_requested", "rfl_dual_approved", "rfl_dual_consumed", "rfl_exposure_disposed"]) expect(audit(w, a)).toBe(1);
      // a replay of the SAME disposition needs no new approval and consumes nothing
      expect(call<{ replayed: boolean }>("tw4_rfl_exposure_dispose", res.resource_id, key, P3, "absorbed", REASON).replayed).toBe(true);
      expect(audit(w, "rfl_dual_consumed")).toBe(1);
      expect(money(w)).toBe(money0);
    });

    it("an approval is single use: after the exposure is reopened by a new bill, absorbing again needs a NEW request", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const req = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      expect(dispose(res.resource_id, key, REASON)).toBe("");
      call("tw4_rfl_observe_provider_bill", res.resource_id, key, `INV-${RUN}-${w.n}-late`, EXP.number, P);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open" });
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      const again = absorbRequest(res.resource_id, key, REASON);
      expect(again.request_id).not.toBe(req.request_id);
      call("tw4_rfl_dual_approve", again.request_id, P3, NOTE);
      expect(dispose(res.resource_id, key, REASON)).toBe("");
      expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where resource_id = '${res.resource_id}' and status = 'consumed'`)).toBe(2);
    });

    it("the approval is bound to the exact resource, period and written reason; a mismatch leaves it approved and unconsumed", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      age(res.resource_id, 200);
      scan(w);
      const other = keyAdd(key, -1);
      expect(exposureOf(res.resource_id, other)).toBeTruthy();
      const w2 = world();
      const { res: res2, key: key2 } = exposed(w2, "number");
      const req = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      expect(hasCode(dispose(res.resource_id, other, REASON), "TW042")).toBe(true); // another period
      expect(hasCode(dispose(res2.resource_id, key2, REASON), "TW042")).toBe(true); // another resource
      expect(hasCode(dispose(res.resource_id, key, REASON + " (edited)"), "TW042")).toBe(true); // a changed reason
      expect(exposureOf(res.resource_id, other)).toMatchObject({ state: "open" });
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open" });
      expect(reqStatus(req.request_id)).toBe("approved");
      expect(dispose(res.resource_id, key, REASON)).toBe(""); // the exact binding still works afterwards
    });

    it("not_billed_confirmed is NOT gated (unchanged), and neither is anything on a campaign cancellation", () => {
      const w = world();
      const { res, key } = exposed(w, "campaign");
      expect(call<{ replayed: boolean }>("tw4_rfl_exposure_dispose", res.resource_id, key, P, "not_billed_confirmed", "Twilio console shows no bill for this period").replayed).toBe(false);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "closed", disposition: "not_billed_confirmed" });
      expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where legal_entity_id = '${w.entity}'`)).toBe(0);
    });

    it("a bound fact that changes invalidates the approval: a new bill before approval (invalidated, persisted), a new bill after approval (refused, then a new request supersedes it), a new open cancellation", () => {
      // 1. changed before the second administrator approves
      const a = world();
      const ea = exposed(a, "number");
      const r1 = absorbRequest(ea.res.resource_id, ea.key, REASON);
      call("tw4_rfl_observe_provider_bill", ea.res.resource_id, ea.key, `INV-${RUN}-${a.n}-pre`, EXP.number, P);
      expect(call("tw4_rfl_dual_approve", r1.request_id, P2, NOTE)).toMatchObject({ status: "invalidated" });
      expect(reqStatus(r1.request_id)).toBe("invalidated");
      expect(audit(a, "rfl_dual_invalidated")).toBe(1);
      expect(hasCode(dispose(ea.res.resource_id, ea.key, REASON), "TW042")).toBe(true);
      expect(call("tw4_rfl_dual_approve", r1.request_id, P2, NOTE)).toMatchObject({ status: "invalidated", replayed: true });
      const r1b = absorbRequest(ea.res.resource_id, ea.key, REASON);
      expect(r1b.request_id).not.toBe(r1.request_id);
      call("tw4_rfl_dual_approve", r1b.request_id, P3, NOTE);
      expect(dispose(ea.res.resource_id, ea.key, REASON)).toBe("");
      expect(exposureOf(ea.res.resource_id, ea.key)).toMatchObject({ disposition: "absorbed", billed: EXP.number });

      // 2. changed AFTER approval: refused (TW042), approval stays unconsumed, and a new request supersedes the stale one
      const b = world();
      const eb = exposed(b, "number");
      const r2 = absorbRequest(eb.res.resource_id, eb.key, REASON);
      call("tw4_rfl_dual_approve", r2.request_id, P2, NOTE);
      call("tw4_rfl_observe_provider_bill", eb.res.resource_id, eb.key, `INV-${RUN}-${b.n}-post`, EXP.number, P);
      expect(hasCode(dispose(eb.res.resource_id, eb.key, REASON), "TW042")).toBe(true);
      expect(exposureOf(eb.res.resource_id, eb.key)).toMatchObject({ state: "open" });
      expect(reqStatus(r2.request_id)).toBe("approved");
      const r2b = absorbRequest(eb.res.resource_id, eb.key, REASON, P2);
      expect(r2b.request_id).not.toBe(r2.request_id);
      expect(reqStatus(r2.request_id)).toBe("invalidated");
      expect(audit(b, "rfl_dual_invalidated")).toBe(1);
      call("tw4_rfl_dual_approve", r2b.request_id, P, NOTE);
      expect(dispose(eb.res.resource_id, eb.key, REASON, P3)).toBe("");

      // 3. a new open cancellation of the resource
      const c = world();
      const ec = exposed(c, "campaign");
      const r3 = absorbRequest(ec.res.resource_id, ec.key, REASON);
      call("tw4_rfl_dual_approve", r3.request_id, P2, NOTE);
      call("tw4_rfl_cancel_authorize", ec.res.resource_id, P, ref("facts-open-op"), "owner_written", "The owner asked us in writing to cancel the campaign", true);
      expect(hasCode(dispose(ec.res.resource_id, ec.key, REASON), "TW042")).toBe(true);
      expect(reqStatus(r3.request_id)).toBe("approved");
    });

    it("the same facts replay the same request (also for the other administrator); one open request per action, resource and period", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const first = absorbRequest(res.resource_id, key, REASON);
      const again = absorbRequest(res.resource_id, key, REASON);
      const other = absorbRequest(res.resource_id, key, REASON, P3);
      expect(again).toMatchObject({ request_id: first.request_id, facts_hash: first.facts_hash, replayed: true });
      expect(other.request_id).toBe(first.request_id);
      expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where resource_id = '${res.resource_id}'`)).toBe(1);
      expect(audit(w, "rfl_dual_requested")).toBe(1);
      // a different reason is a different binding: it supersedes the open request
      const changed = absorbRequest(res.resource_id, key, REASON + " v2");
      expect(changed.request_id).not.toBe(first.request_id);
      expect(reqStatus(first.request_id)).toBe("invalidated");
      expect(psqlError(`insert into public.studio_sms_rfl_dual_requests (action, legal_entity_id, studio_id, resource_id, period_key, reason, facts_hash, requested_by, expires_at)
        select action, legal_entity_id, studio_id, resource_id, period_key, reason, facts_hash, requested_by, now() + interval '1 hour' from public.studio_sms_rfl_dual_requests where id = '${changed.request_id}';`)).toMatch(/23505|duplicate key/);
    });

    it("validates a request: an administrator, the action, a written reason, the period, an open exposure of a fee resource", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const ms = register(w, "messaging_service");
      expect(hasCode(callErr("tw4_rfl_dual_request", w.owner, "absorb_exposure", res.resource_id, key, REASON, null), "42501")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "release_everything", res.resource_id, key, REASON, null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "absorb_exposure", res.resource_id, key, "short", null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "absorb_exposure", res.resource_id, key, "x".repeat(501), null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "absorb_exposure", res.resource_id, null, REASON, null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "absorb_exposure", res.resource_id, "2026-13", REASON, null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "absorb_exposure", randomUUID(), key, REASON, null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "absorb_exposure", ms.resource_id, key, REASON, null), "22023")).toBe(true); // a free resource
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "absorb_exposure", res.resource_id, keyAdd(cur(), 3), REASON, null), "TW041")).toBe(true); // no exposure for that period
      expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where legal_entity_id = '${w.entity}'`)).toBe(0);
    });

    it("a period the scan has not recorded yet can still be requested (the disposition records the row itself) and is then gated like any other", () => {
      const w = world();
      const res = register(w, "campaign");
      age(res.resource_id); // no scan: the exposure row does not exist yet
      const key = prevKey();
      expect(exposureOf(res.resource_id, key)).toBeUndefined();
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      expect(exposureOf(res.resource_id, key)).toBeUndefined(); // the refusal rolled the recording back
      const req = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      scan(w); // the scan records the row meanwhile: same open state and published cost, so the binding holds
      expect(dispose(res.resource_id, key, REASON)).toBe("");
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "closed", disposition: "absorbed" });
    });

    it("expires after 24 hours: an unapproved request cannot be approved (expired, persisted), an approved one cannot be consumed, and a new request replaces it", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const old = absorbRequest(res.resource_id, key, REASON);
      replica(`update public.studio_sms_rfl_dual_requests set requested_at = requested_at - interval '25 hours', expires_at = expires_at - interval '25 hours' where id = '${old.request_id}';`);
      expect(call("tw4_rfl_dual_approve", old.request_id, P2, NOTE)).toMatchObject({ status: "expired" });
      expect(reqStatus(old.request_id)).toBe("expired");
      expect(call("tw4_rfl_dual_approve", old.request_id, P2, NOTE)).toMatchObject({ status: "expired", replayed: true });
      const fresh = absorbRequest(res.resource_id, key, REASON);
      expect(fresh.request_id).not.toBe(old.request_id);
      call("tw4_rfl_dual_approve", fresh.request_id, P2, NOTE);
      replica(`update public.studio_sms_rfl_dual_requests set requested_at = requested_at - interval '25 hours', expires_at = expires_at - interval '25 hours' where id = '${fresh.request_id}';`);
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open" });
      // an expired-but-still-pending/approved row is replaced by the next request, and vanishes from the lists
      expect(call<Array<{ request_id: string }>>("tw4_rfl_dual_list", P).some((r) => r.request_id === fresh.request_id)).toBe(false);
      const third = absorbRequest(res.resource_id, key, REASON, P3);
      expect(third.request_id).not.toBe(fresh.request_id);
      expect(reqStatus(fresh.request_id)).toBe("expired");
    });

    it("reject / withdraw: the requester may withdraw, another administrator may reject; a rejected request cannot be approved or used; consumed is final", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const r = absorbRequest(res.resource_id, key, REASON);
      expect(hasCode(callErr("tw4_rfl_dual_reject", r.request_id, w.owner, NOTE), "42501")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_reject", r.request_id, P, "short"), "22023")).toBe(true);
      expect(call("tw4_rfl_dual_reject", r.request_id, P, "withdrawn by the requester after rereading it")).toMatchObject({ status: "rejected" });
      expect(call("tw4_rfl_dual_reject", r.request_id, P, "withdrawn by the requester after rereading it")).toMatchObject({ status: "rejected", replayed: true });
      expect(hasCode(callErr("tw4_rfl_dual_approve", r.request_id, P2, NOTE), "TW041")).toBe(true);
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      const r2 = absorbRequest(res.resource_id, key, REASON, P2);
      expect(r2.request_id).not.toBe(r.request_id);
      call("tw4_rfl_dual_approve", r2.request_id, P3, NOTE);
      expect(call("tw4_rfl_dual_reject", r2.request_id, P, "rejected by another administrator after review")).toMatchObject({ status: "rejected" }); // even after approval, before use
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      const r3 = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", r3.request_id, P2, NOTE);
      expect(dispose(res.resource_id, key, REASON)).toBe("");
      expect(hasCode(callErr("tw4_rfl_dual_reject", r3.request_id, P, "too late: the approval was already used"), "TW041")).toBe(true);
      expect(audit(w, "rfl_dual_rejected")).toBe(2);
    });

    it("the list shows pending and approved requests only (with the bound facts), for administrators only", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const r = absorbRequest(res.resource_id, key, REASON);
      const entry = () => call<Array<Record<string, unknown>>>("tw4_rfl_dual_list", P3).find((x) => x.request_id === r.request_id);
      expect(entry()).toMatchObject({ action: "absorb_exposure", legal_entity_id: w.entity, studio_id: w.studio, resource_id: res.resource_id, period_key: key, reason: REASON,
        expected_provider_cents: EXP.number, provider_billed_cents: 0, requested_by: P, status: "pending" });
      for (const k of ["request_id", "action", "legal_entity_id", "studio_id", "resource_id", "period_key", "reason", "expected_provider_cents", "provider_billed_cents", "requested_by", "requested_at", "expires_at", "status"]) {
        expect(Object.keys(entry()!)).toContain(k);
      }
      call("tw4_rfl_dual_approve", r.request_id, P2, NOTE);
      expect(entry()).toMatchObject({ status: "approved" });
      dispose(res.resource_id, key, REASON);
      expect(entry()).toBeUndefined();
      expect(hasCode(callErr("tw4_rfl_dual_list", w.owner), "42501")).toBe(true);
    });

    it("the table itself refuses an approver who is the requester, a rewritten binding, and a status move outside the functions", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const r = absorbRequest(res.resource_id, key, REASON);
      const id = r.request_id;
      expect(psqlError(`begin; select set_config('tw4.rflops_write', 'on', true); update public.studio_sms_rfl_dual_requests set status = 'approved', decided_by = requested_by, decided_at = now(), decision_note = '${NOTE}' where id = '${id}'; commit;`)).toMatch(/studio_sms_rfl_dual_requests_distinct|violates check/);
      expect(psqlError(`update public.studio_sms_rfl_dual_requests set status = 'approved', decided_by = '${P2}', decided_at = now(), decision_note = '${NOTE}' where id = '${id}';`)).toMatch(/only through the dual-control functions/);
      expect(psqlError(`begin; select set_config('tw4.rflops_write', 'on', true); update public.studio_sms_rfl_dual_requests set reason = 'a rewritten written reason here' where id = '${id}'; commit;`)).toMatch(/binding of a request is fixed/);
      expect(psqlError(`begin; select set_config('tw4.rflops_write', 'on', true); update public.studio_sms_rfl_dual_requests set facts_hash = '${digest()}' where id = '${id}'; commit;`)).toMatch(/binding of a request is fixed/);
      expect(psqlError(`begin; select set_config('tw4.rflops_write', 'on', true); update public.studio_sms_rfl_dual_requests set status = 'consumed', consumed_at = now(), consumed_by = '${P2}' where id = '${id}'; commit;`)).toMatch(/not a legal transition/);
      expect(psqlError(`delete from public.studio_sms_rfl_dual_requests where id = '${id}';`)).toMatch(/never deleted/);
      expect(psqlError(`truncate public.studio_sms_rfl_dual_requests;`)).not.toBe("");
      call("tw4_rfl_dual_reject", id, P2, "closing the fixture request for the final check");
      expect(psqlError(`begin; select set_config('tw4.rflops_write', 'on', true); update public.studio_sms_rfl_dual_requests set status = 'approved', decided_by = '${P3}' where id = '${id}'; commit;`)).toMatch(/not a legal transition|final/);
    });
  });

  describe("dual control: concurrency", () => {
    it("concurrent dispositions with one approval consume it exactly once", async () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const req = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      const results = await Promise.all([P, P, P2, P2, P3].map((actor) => psqlAsync(callSql("tw4_rfl_exposure_dispose", res.resource_id, key, actor, "absorbed", REASON))));
      const fresh = results.filter((r) => r.err === "" && (JSON.parse(r.out) as { replayed: boolean }).replayed === false);
      expect(fresh).toHaveLength(1);
      for (const r of results) if (r.err !== "") expect(hasCode(r.err, "TW041")).toBe(true); // a different administrator after the close: already closed
      expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where id = '${req.request_id}' and status = 'consumed'`)).toBe(1);
      expect(audit(w, "rfl_dual_consumed")).toBe(1);
      expect(audit(w, "rfl_exposure_disposed")).toBe(1);
    });

    it("concurrent approvals: exactly one administrator decides; concurrent identical requests share one row", async () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const reqs = await Promise.all([P, P2, P3, P].map((actor) => psqlAsync(callSql("tw4_rfl_dual_request", actor, "absorb_exposure", res.resource_id, key, REASON, null))));
      expect(reqs.every((r) => r.err === "")).toBe(true);
      const ids = new Set(reqs.map((r) => (JSON.parse(r.out) as { request_id: string }).request_id));
      expect(ids.size).toBe(1);
      const id = [...ids][0];
      const requester = psql(`select requested_by from public.studio_sms_rfl_dual_requests where id = '${id}'`);
      const approvers = [P, P2, P3].filter((p) => p !== requester);
      const out = await Promise.all(approvers.map((actor) => psqlAsync(callSql("tw4_rfl_dual_approve", id, actor, NOTE))));
      expect(out.filter((o) => o.err === "")).toHaveLength(1);
      expect(out.filter((o) => o.err !== "").every((o) => hasCode(o.err, "TW041"))).toBe(true);
      expect(psql(`select (status = 'approved' and decided_by <> requested_by)::text from public.studio_sms_rfl_dual_requests where id = '${id}'`)).toBe("true");
      expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where resource_id = '${res.resource_id}'`)).toBe(1);
    });

    it("concurrent number-cancellation authorizations with one approval create exactly one operation and consume it once", async () => {
      const w = world();
      const n = register(w, "number");
      const approval = ref("number-race");
      const reason = "The owner asked us in writing to release this number";
      const req = cancelRequest(n.resource_id, approval, reason);
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      const out = await Promise.all([P, P, P2, P3].map((actor) => psqlAsync(callSql("tw4_rfl_cancel_authorize", n.resource_id, actor, approval, "owner_written", reason, true))));
      expect(out.filter((o) => o.err === "" && (JSON.parse(o.out) as { replayed: boolean }).replayed === false)).toHaveLength(1);
      for (const o of out) if (o.err !== "") expect(hasCode(o.err, "TW043")).toBe(true); // another administrator reusing the reference
      expect(num(`select count(*) from public.studio_sms_provider_cancel_ops where resource_id = '${n.resource_id}'`)).toBe(1);
      expect(reqStatus(req.request_id)).toBe("consumed");
      expect(audit(w, "rfl_dual_consumed")).toBe(1);
    });

    it("dual-control calls interleaved with suspension, a campaign cancellation and the scan on the same location never deadlock (location, business, credit order)", async () => {
      for (let round = 0; round < 3; round++) {
        const w = world();
        const { res, key } = exposed(w, "number");
        const camp = register(w, "campaign");
        const req = absorbRequest(res.resource_id, key, REASON);
        const out = await Promise.all([
          psqlAsync(callSql("tw4_rfl_dual_approve", req.request_id, P2, NOTE)),
          psqlAsync(callSql("tw4_rfl_suspend_df", w.studio, P3, "safety suspension raced with an approval", true)),
          psqlAsync(callSql("tw4_rfl_cancel_authorize", camp.resource_id, P, ref(`race-${round}`), "owner_written", "The owner asked us in writing to cancel the campaign", true)),
          psqlAsync(callSql("tw4_rfl_scan_entity", w.entity)),
          psqlAsync(callSql("tw4_rfl_dual_request", P3, "absorb_exposure", res.resource_id, key, REASON, null)),
          psqlAsync(callSql("tw4_rfl_exposure_dispose", res.resource_id, key, P, "absorbed", REASON)),
        ]);
        for (const o of out) expect(o.err).not.toMatch(/40P01|deadlock/);
      }
    });
  });

  describe("dual control: phone-number cancellation", () => {
    const authorizeNum = (resourceId: string, approval: string, reason: string, by = "owner_written", actor = P) =>
      callErr("tw4_rfl_cancel_authorize", resourceId, actor, approval, by, reason, true);
    const CR = "The owner asked us in writing to release this number";

    it("needs an approved request bound to the same approval reference and reason; consumed by the authorization; replays need nothing", () => {
      const w = world();
      const n = register(w, "number");
      const approval = ref("number-release");
      expect(hasCode(authorizeNum(n.resource_id, approval, CR), "TW042")).toBe(true);
      expect(num(`select count(*) from public.studio_sms_provider_cancel_ops where resource_id = '${n.resource_id}'`)).toBe(0);
      expect(psql(`select count(*) from public.studio_sms_approval_refs where ref_norm = public._tw4fi_ref_norm('${approval}')`)).toBe("0");
      const req = cancelRequest(n.resource_id, approval, CR);
      expect(hasCode(authorizeNum(n.resource_id, approval, CR), "TW042")).toBe(true); // pending
      expect(hasCode(callErr("tw4_rfl_dual_approve", req.request_id, P, NOTE), "42501")).toBe(true);
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      expect(hasCode(authorizeNum(n.resource_id, ref("another-ref"), CR), "TW042")).toBe(true); // another approval reference
      expect(hasCode(authorizeNum(n.resource_id, approval, CR + " (edited)"), "TW042")).toBe(true); // another reason
      expect(reqStatus(req.request_id)).toBe("approved");
      expect(authorizeNum(n.resource_id, approval.toUpperCase().replace(/ /g, "  "), CR)).toBe(""); // the reference is matched in its normalized spelling
      expect(reqStatus(req.request_id)).toBe("consumed");
      const op = rows<{ id: string; status: string; authorized_by: string }>(`select id, status, authorized_by from public.studio_sms_provider_cancel_ops where resource_id = '${n.resource_id}'`);
      expect(op).toHaveLength(1);
      expect(op[0]).toMatchObject({ status: "authorized", authorized_by: P });
      for (const a of ["rfl_dual_requested", "rfl_dual_approved", "rfl_dual_consumed", "rfl_cancel_authorized"]) expect(audit(w, a)).toBe(1);
      // the same authorization again is a replay: no new approval, nothing consumed twice
      expect(call<{ replayed: boolean }>("tw4_rfl_cancel_authorize", n.resource_id, P, approval.toUpperCase().replace(/ /g, "  "), "owner_written", CR, true).replayed).toBe(true);
      expect(audit(w, "rfl_dual_consumed")).toBe(1);
      // the approval reference is now used for good
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", register(world(), "number").resource_id, null, CR, approval, "owner_written"), "TW043")).toBe(true);
    });

    it("validates the request: number only, an active resource, no open cancellation, a fresh written reference; campaigns and Messaging Services are unchanged (no approval needed)", () => {
      const w = world();
      const n = register(w, "number");
      const camp = register(w, "campaign");
      const ms = register(w, "messaging_service");
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", n.resource_id, null, CR, null), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", n.resource_id, null, CR, "short"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", n.resource_id, null, "short", ref("r"), "owner_written"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", w.owner, "cancel_number", n.resource_id, null, CR, ref("r"), "owner_written"), "42501")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", camp.resource_id, null, CR, ref("r"), "owner_written"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", ms.resource_id, null, CR, ref("r"), "owner_written"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", randomUUID(), null, CR, ref("r"), "owner_written"), "22023")).toBe(true);
      expect(authorizeNum(camp.resource_id, ref("camp"), "The owner asked us in writing to cancel the campaign")).toBe("");
      expect(authorizeNum(ms.resource_id, ref("ms"), "The owner asked us in writing to cancel the service")).toBe("");
      // an approval reference already used by an earlier cancellation decision is refused at request time
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", n.resource_id, null, CR, psql(`select approval_ref from public.studio_sms_provider_cancel_ops where resource_id = '${camp.resource_id}'`), "owner_written"), "TW043")).toBe(true);
      // a cancelled resource cannot be requested again
      const done = register(world(), "number");
      const doneRef = ref("done");
      const req = cancelRequest(done.resource_id, doneRef, CR);
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", done.resource_id, P, doneRef, "owner_written", CR, true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", done.resource_id, null, CR, ref("again"), "owner_written"), "TW041")).toBe(true);
    });

    it("keeps its other refusals first (policy_lapse on a number TW042, the live sender TW041), and the bound facts include open cancellations", () => {
      const w = world();
      const n = register(w, "number");
      expect(hasCode(authorizeNum(n.resource_id, ref("lapse"), "lapse policy applied to a phone number", "policy_lapse"), "TW042")).toBe(true);
      replica(`insert into public.studio_sms_billed_senders (id, legal_entity_id, studio_id, account_sid, messaging_service_sid, sender_e164, status, set_by, reason, campaign_sid, phone_number_sid)
        values ('${randomUUID()}', '${w.entity}', '${w.studio}', '${w.account}', '${sid("MG")}', '${n.e164}', 'approved', '${P}', 'fixture sender', null, '${n.sid}');`);
      expect(hasCode(authorizeNum(n.resource_id, ref("live"), CR), "TW041")).toBe(true); // the live sender is refused before any approval is looked at
      call("tw4_rfl_suspend_df", w.studio, P, "suspend sending before releasing the number", false);
      const req = cancelRequest(n.resource_id, ref("facts"), CR);
      // an open cancellation appears (inserted as a fixture: the real path is gated by this very approval)
      replica(`insert into public.studio_sms_provider_cancel_ops (resource_id, legal_entity_id, studio_id, status, decided_by, approval_ref, ref_norm, reason, irreversible_ack, authorized_by)
        values ('${n.resource_id}', '${w.entity}', '${w.studio}', 'authorized', 'owner_written', 'fixture approval reference ${RUN}', 'fixture approval reference ${RUN}', 'fixture reason for the open cancellation', true, '${P}');`);
      expect(call("tw4_rfl_dual_approve", req.request_id, P2, NOTE)).toMatchObject({ status: "invalidated" });
      expect(reqStatus(req.request_id)).toBe("invalidated");
    });

    it("a changed reason or reference is a new binding: the open request is superseded", () => {
      const w = world();
      const n = register(w, "number");
      const approval = ref("rebind");
      const first = cancelRequest(n.resource_id, approval, CR);
      expect(cancelRequest(n.resource_id, approval, CR, P3)).toMatchObject({ request_id: first.request_id, replayed: true });
      const second = cancelRequest(n.resource_id, approval, CR + " v2");
      expect(second.request_id).not.toBe(first.request_id);
      expect(reqStatus(first.request_id)).toBe("invalidated");
      const third = cancelRequest(n.resource_id, ref("rebind-2"), CR + " v2");
      expect(third.request_id).not.toBe(second.request_id);
      expect(reqStatus(second.request_id)).toBe("invalidated");
    });

    it("the immediate safety suspension of sending never waits for dual approval, and no dual-control call moves a ledger", () => {
      const w = world();
      const n = register(w, "number");
      replica(`insert into public.studio_sms_billed_senders (id, legal_entity_id, studio_id, account_sid, messaging_service_sid, sender_e164, status, set_by, reason, campaign_sid, phone_number_sid)
        values ('${randomUUID()}', '${w.entity}', '${w.studio}', '${w.account}', '${sid("MG")}', '${n.e164}', 'approved', '${P}', 'fixture sender', null, '${n.sid}');`);
      expect(psql(`select public._tw4rfl_df_sending('${w.studio}')::text`)).toBe("true");
      const money0 = money(w);
      const out = call<{ df_sending: boolean; provider_resources_unchanged: boolean }>("tw4_rfl_suspend_df", w.studio, P, "safety suspension: investigating an abuse report", false);
      expect(out).toMatchObject({ df_sending: false, provider_resources_unchanged: true });
      expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where legal_entity_id = '${w.entity}'`)).toBe(0);
      expect(psql(`select provider_state from public.studio_sms_provider_resources where id = '${n.resource_id}'`)).toBe("active");
      // number cancellation is now possible (the sender is revoked) but STILL needs approval
      expect(hasCode(authorizeNum(n.resource_id, ref("after-suspend"), CR), "TW042")).toBe(true);
      expect(money(w)).toBe(money0);
    });
  });

  describe("ConfiDance (pilot) rules stay intact", () => {
    it("tw4_rfl_pilot_cover is unchanged (no approval flow), no standing authorization exists, and dual control never releases or replenishes the cumulative ceiling", () => {
      const w = pilotWorld();
      const used = () => num(`select coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured')`);
      const n = register(w, "number");
      const cover = call<{ cover_id: string; replayed: boolean }>("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, n.resource_id, psql(`select to_char(now() at time zone 'UTC', 'YYYY-MM')`), ref("pilot-cover"), P));
      expect(cover.replayed).toBe(false);
      const afterCover = used();
      expect(afterCover).toBe(PRICE.number);
      expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where legal_entity_id = '${w.entity}' and studio_id = '${w.studio}'`)).toBe(0);
      expect(hasCode(callErr("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null), "TW011")).toBe(true);
      // absorbing a pilot exposure and releasing a pilot number are both gated like any other business
      age(n.resource_id, 100);
      replica(`update public.studio_sms_provider_cover set period_key = to_char((now() at time zone 'UTC') + interval '1 month', 'YYYY-MM') where resource_id = '${n.resource_id}';`); // leave the previous period uncovered
      scan(w);
      const key = prevKey();
      expect(exposureOf(n.resource_id, key)).toMatchObject({ state: "open" });
      expect(hasCode(dispose(n.resource_id, key, REASON), "TW042")).toBe(true);
      const req = absorbRequest(n.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      expect(dispose(n.resource_id, key, REASON)).toBe("");
      const approval = ref("pilot-number");
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", n.resource_id, P, approval, "founder_written", "The founder approved releasing this number in writing", true), "TW042")).toBe(true);
      const creq = cancelRequest(n.resource_id, approval, "The founder approved releasing this number in writing", P, "founder_written");
      call("tw4_rfl_dual_approve", creq.request_id, P3, NOTE);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", n.resource_id, P, approval, "founder_written", "The founder approved releasing this number in writing", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      expect(used()).toBe(afterCover); // the ceiling is never released or replenished automatically (D4)
      expect(num(`select ceiling_cents from public.studio_sms_pilot_exceptions where legal_entity_id = '${w.entity}'`)).toBe(15000);
    });
  });

  describe("privileges, vocabularies and what the new objects never touch", () => {
    const NEW_FNS = ["tw4_rfl_switch_enabled(text)", "tw4_rfl_set_switch(text, boolean, uuid, text)", "tw4_rfl_scan_begin(text, integer)", "tw4_rfl_scan_finish(uuid, text, jsonb, text)", "tw4_rfl_health(uuid)",
      "tw4_rfl_exposure_report(uuid)", "tw4_rfl_variance_report(uuid)", "tw4_rfl_variance_ack(uuid, uuid, text)", "tw4_rfl_alert_recipients(uuid)", "tw4_rfl_alert_delivery_record(uuid, uuid, text, text, text)",
      "tw4_rfl_escalate_delivery()", "tw4_rfl_dual_request(uuid, text, uuid, text, text, text, text)", "tw4_rfl_dual_approve(uuid, uuid, text)", "tw4_rfl_dual_reject(uuid, uuid, text)", "tw4_rfl_dual_list(uuid)", "tw4_rfl_alert_release(uuid, uuid)"];
    const REPLACED = ["tw4_rfl_alerts_claim(integer)", "tw4_rfl_scan_entity(uuid)", "tw4_rfl_exposure_dispose(uuid, text, uuid, text, text)", "tw4_rfl_cancel_authorize(uuid, uuid, text, text, text, boolean)"];
    // one query for every function (the machine running the real-schema suites can be slow: a call per function and role would time out)
    const privs = (fns: string[]) => {
      const out = rows<{ f: string; role: string; ok: boolean; secdef: boolean; cfg: string | null }>(
        `select f, r as role, has_function_privilege(r, 'public.' || f, 'execute') as ok, p.prosecdef as secdef, array_to_string(p.proconfig, ',') as cfg
           from unnest(array[${fns.map((x) => `'${x}'`).join(",")}]) f cross join unnest(array['service_role','anon','authenticated','public']) r join pg_proc p on p.oid = ('public.' || f)::regprocedure`);
      const byFn = new Map<string, Record<string, boolean>>();
      for (const o of out) byFn.set(o.f, { ...(byFn.get(o.f) ?? {}), [o.role]: o.ok, secdef: o.secdef, cfg: o.cfg === "search_path=pg_catalog, public, pg_temp" } as Record<string, boolean>);
      return byFn;
    };

    it("new functions: service role only (never public / anon / authenticated), security definer with a pinned search_path; replaced functions keep their grants", () => {
      const all = privs([...NEW_FNS, ...REPLACED]);
      expect(all.size).toBe(NEW_FNS.length + REPLACED.length);
      for (const [fn, p] of all) expect(p, fn).toEqual({ service_role: true, anon: false, authenticated: false, public: false, secdef: true, cfg: true });
      const inner = privs(["_tw4rflops_guard()", "_tw4rflops_request_insert()", "_tw4rflops_epoch()", "_tw4rflops_demotion()", "_tw4rflops_lock_parties(text, uuid, text)", "_tw4rflops_facts(text, uuid, text, text, text, text)", "_tw4rflops_consume(text, public.studio_sms_provider_resources, text, text, text, text, uuid)"]);
      for (const [fn, p] of inner) expect(p, fn).toMatchObject({ service_role: false, anon: false, authenticated: false, public: false });
    });

    it("every new table has RLS on and no privilege for any API role", () => {
      for (const t of ["studio_sms_rfl_switch_log", "studio_sms_rfl_runs", "studio_sms_rfl_alert_deliveries", "studio_sms_provider_variance_acks", "studio_sms_rfl_dual_requests", "studio_sms_rfl_fact_epochs"]) {
        expect(psql(`select relrowsecurity::text from pg_class where oid = 'public.${t}'::regclass`), t).toBe("true");
        for (const role of ["anon", "authenticated", "service_role"]) {
          expect(psql(`select (has_table_privilege('${role}', 'public.${t}', 'select') or has_table_privilege('${role}', 'public.${t}', 'insert') or has_table_privilege('${role}', 'public.${t}', 'update')
            or has_table_privilege('${role}', 'public.${t}', 'delete'))::text`), `${t}/${role}`).toBe("false");
        }
      }
    });

    it("the audit vocabulary and the alert kinds were EXTENDED from their live lists: old values survive, new ones are accepted, unknown ones are refused", () => {
      const audit = psql(`select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.studio_sms_onboarding_audit'::regclass and pg_get_constraintdef(oid) like '%rfl_registered%'`);
      for (const a of ["state_changed", "recurring_charged", "rfl_registered", "rfl_cancel_authorized", "rfl_exposure_disposed", "rfl_switch_set", "rfl_variance_acked", "rfl_dual_requested", "rfl_dual_approved",
        "rfl_dual_rejected", "rfl_dual_invalidated", "rfl_dual_consumed", "rfl_alert_delivery"]) expect(audit).toContain(a);
      const kinds = psql(`select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.studio_sms_provider_alerts'::regclass and pg_get_constraintdef(oid) like '%authorization_expiring%'`);
      for (const k of ["authorization_expiring", "next_period_uncovered", "exposure_open", "released_resource_active", "owner_notice_second", "owner_unresponsive", "alert_delivery_exhausted"]) expect(kinds).toContain(k);
      const w = world();
      expect(psqlError(`insert into public.studio_sms_provider_alerts (legal_entity_id, kind, dedupe_key, audience, severity, summary) values ('${w.entity}', 'made_up_kind', 'x:${randomUUID()}', 'admin', 'info', 'fixture');`)).toMatch(/violates check/);
      expect(psqlError(`insert into public.studio_sms_provider_alerts (legal_entity_id, kind, dedupe_key, audience, severity, summary) values ('${w.entity}', 'owner_notice_second', 'x:${randomUUID()}', 'admin', 'info', 'fixture');`)).toBe("");
    });

    it("the new functions never call Twilio, post to a credit ledger, create or extend an authorization, or touch a recurring charge", () => {
      const forbidden = /_tw4c_post|studio_sms_credit_ledger|studio_sms_credit_reservations|studio_sms_credit_accounts|tw4_credit_|tw4_recurring_|tw4_spend_|insert into public\.studio_sms_recurring|update public\.studio_sms_recurring|http|net\.|twilio\.com/i;
      for (const fn of NEW_FNS) {
        const src = psql(`select p.prosrc from pg_proc p where p.oid = 'public.${fn}'::regprocedure`);
        expect(src, fn).not.toMatch(forbidden);
      }
      for (const fn of ["_tw4rflops_facts(text, uuid, text, text, text, text)", "_tw4rflops_consume(text, public.studio_sms_provider_resources, text, text, text, text, uuid)"]) {
        expect(psql(`select p.prosrc from pg_proc p where p.oid = 'public.${fn}'::regprocedure`), fn).not.toMatch(forbidden);
      }
    });

    it("every other lifecycle function is byte-identical to 20261209 (only the four replaced bodies changed, and they match this migration's text)", () => {
      const dir = join(process.cwd(), "src/lib/supabase/migrations");
      const prosrcOf = (text: string, name: string) => {
        const start = text.indexOf(`create or replace function public.${name}(`);
        expect(start, name).toBeGreaterThanOrEqual(0);
        const bodyStart = text.indexOf("as $$", start) + "as $$".length;
        return text.slice(bodyStart, text.indexOf("$$;", bodyStart));
      };
      const md5 = (v: string) => createHash("md5").update(v).digest("hex");
      const dbMd5 = (name: string) => psql(`select md5(replace(p.prosrc, chr(13), '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '${name}'`);
      const prev = readFileSync(join(dir, "20261209090000_twilio_recurring_fee_lifecycle.sql"), "utf8");
      const ops = readFileSync(join(dir, "20261211090000_twilio_rfl_ops.sql"), "utf8");
      // 20261217 (R2b integration) replaces tw4_rfl_register and tw4_recurring_charge: on a database that carries it they must match THAT text, otherwise 20261209's
      const integrated = psql(`select to_regprocedure('public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)') is not null`) === "t";
      const integration = integrated ? readFileSync(join(dir, "20261217090000_twilio_r2b_rfl_lifecycle_integration.sql"), "utf8") : "";
      // 20261225 (D5 cover rule) replaces tw4_rfl_pilot_cover and _tw4rfl_cover: on a database that carries it they must match THAT text
      const d5 = psql(`select exists (select 1 from pg_attribute where attrelid = 'public.studio_sms_provider_cover'::regclass and attname = 'superseded_at' and not attisdropped)`) === "t";
      // 20261229 (pilot evidence) replaces tw4_rfl_pilot_cover again (eleven arguments): on a database that carries it the body must match THAT text
      const evid = evidenceApplied(psql);
      const d5text = d5 ? readFileSync(join(dir, "20261225090000_twilio_rfl_d5_cover.sql"), "utf8") : "";
      const evidtext = evid ? readFileSync(join(dir, "20261229090000_twilio_rfl_pilot_evidence.sql"), "utf8") : "";
      for (const n of ["tw4_rfl_suspend_df", "tw4_rfl_pilot_cover", "tw4_rfl_register", "tw4_rfl_cancel_withdraw", "tw4_rfl_cancel_begin", "tw4_rfl_cancel_finish", "tw4_rfl_cancel_resolve",
        "tw4_rfl_observe_provider_bill", "tw4_rfl_alert_finish", "tw4_rfl_inventory_gaps", "tw4_rfl_studio_ready", "tw4_rfl_scan_entities", "_tw4rc_service_state", "tw4_recurring_charge",
        "_tw4rfl_cover", "_tw4rfl_gate_suspended", "_tw4rfl_alert", "_tw4rfl_lock"]) {
        const replaced = integrated && (n === "tw4_rfl_register" || n === "tw4_recurring_charge");
        const d5replaced = d5 && (n === "tw4_rfl_pilot_cover" || n === "_tw4rfl_cover");
        expect(dbMd5(n), n).toBe(md5(prosrcOf(evid && n === "tw4_rfl_pilot_cover" ? evidtext : d5replaced ? d5text : replaced ? integration : prev, n)));
      }
      for (const n of ["tw4_rfl_alerts_claim", "tw4_rfl_scan_entity", "tw4_rfl_exposure_dispose", "tw4_rfl_cancel_authorize", "tw4_rfl_admin_overview"]) {
        expect(dbMd5(n), n).toBe(md5(prosrcOf(ops, n)));
        expect(dbMd5(n), n).not.toBe(md5(prosrcOf(prev, n)));
      }
    });
  });

  describe("review hardening: permanent invalidation, bound decision type, requester standing, deterministic switches, outbound privacy, UI contract", () => {
    const epochOf = (resourceId: string) => num(`select coalesce((select epoch from public.studio_sms_rfl_fact_epochs where resource_id = '${resourceId}'), 0)`);
    const flagged = (sql: string) => psql(`begin; select set_config('tw4.rfl_write', 'on', true); ${sql} select set_config('tw4.rfl_write', 'off', true); commit;`);

    it("F1 a cancellation that is opened and WITHDRAWN never revives an earlier approval: refused, and the next non-raising path invalidates it for good", () => {
      const w = world();
      const { res, key } = exposed(w, "campaign");
      const req = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      const e0 = epochOf(res.resource_id);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", res.resource_id, P, ref("f1-open"), "owner_written", "The owner asked us in writing to cancel the campaign", true);
      call("tw4_rfl_cancel_withdraw", op.operation_id, P, "withdrawn: the owner changed their mind");
      expect(epochOf(res.resource_id)).toBeGreaterThan(e0);
      // the open cancellation is gone, every visible fact is back to what it was, and the approval is STILL unusable
      expect(num(`select count(*) from public.studio_sms_provider_cancel_ops where resource_id = '${res.resource_id}' and status in ('authorized', 'in_flight', 'unknown_outcome')`)).toBe(0);
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open" });
      expect(reqStatus(req.request_id)).toBe("approved"); // the refusal rolled back: nothing persisted yet
      const listed = call<Array<{ request_id: string }>>("tw4_rfl_dual_list", P3);
      expect(listed.some((r) => r.request_id === req.request_id)).toBe(false);
      expect(reqStatus(req.request_id)).toBe("invalidated"); // the non-raising path made it permanent
      expect(audit(w, "rfl_dual_invalidated")).toBe(1);
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      const again = absorbRequest(res.resource_id, key, REASON);
      expect(again.request_id).not.toBe(req.request_id);
      call("tw4_rfl_dual_approve", again.request_id, P3, NOTE);
      expect(dispose(res.resource_id, key, REASON)).toBe("");
    });

    it("F1 an exposure that is covered (closed) and REOPENED never revives an earlier approval, approved or still pending; a scan's last-detected touch never moves the epoch", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const before = epochOf(res.resource_id);
      scan(w);
      scan(w);
      expect(epochOf(res.resource_id)).toBe(before); // scans touch last_detected_at / reason only
      const approved = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", approved.request_id, P2, NOTE);
      const hasPrev = exposureOf(res.resource_id, keyAdd(key, -1)) !== undefined;
      const pending = hasPrev ? absorbRequest(res.resource_id, keyAdd(key, -1), REASON) : null;
      // covered, then reopened: the visible state ends up exactly where it began
      flagged(`update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = 'covered_by_charge' where resource_id = '${res.resource_id}' and period_key = '${key}';`);
      flagged(`update public.studio_sms_provider_exposure set state = 'open', closed_at = null, disposition = null where resource_id = '${res.resource_id}' and period_key = '${key}';`);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open", disposition: null });
      expect(epochOf(res.resource_id)).toBeGreaterThan(before);
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open" });
      // a still-PENDING request for the same resource is invalidated at approval, not approved
      if (pending) expect(call("tw4_rfl_dual_approve", pending.request_id, P3, NOTE)).toMatchObject({ status: "invalidated" });
      // approving the first one again is refused too (it is still approved, but unusable), and a fresh request works
      const fresh = absorbRequest(res.resource_id, key, REASON, P3);
      expect(fresh.request_id).not.toBe(approved.request_id);
      expect(reqStatus(approved.request_id)).toBe("invalidated");
      call("tw4_rfl_dual_approve", fresh.request_id, P2, NOTE);
      expect(dispose(res.resource_id, key, REASON)).toBe("");
    });

    it("F1 a changed reason is a different binding, and the epoch is part of the hash (the same facts at a later epoch hash differently)", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const first = absorbRequest(res.resource_id, key, REASON);
      flagged(`update public.studio_sms_provider_exposure set expected_provider_cents = expected_provider_cents + 1 where resource_id = '${res.resource_id}' and period_key = '${key}';`);
      flagged(`update public.studio_sms_provider_exposure set expected_provider_cents = expected_provider_cents - 1 where resource_id = '${res.resource_id}' and period_key = '${key}';`);
      const second = absorbRequest(res.resource_id, key, REASON);
      expect(second.request_id).not.toBe(first.request_id); // same visible facts, later epoch: the old request was invalidated
      expect(second.facts_hash).not.toBe(first.facts_hash);
      expect(reqStatus(first.request_id)).toBe("invalidated");
      expect(psqlError(`begin; update public.studio_sms_rfl_fact_epochs set epoch = 1 where resource_id = '${res.resource_id}'; commit;`)).toMatch(/only increases/);
      expect(psqlError(`delete from public.studio_sms_rfl_fact_epochs where resource_id = '${res.resource_id}';`)).toMatch(/never deleted/);
    });

    it("F2 a number-cancellation approval is bound to the decision type: another type is refused (TW042) and consumes nothing; policy_lapse and a missing type cannot be requested; absorb takes none; the 6-argument form still works for absorb", () => {
      const w = world();
      const n = register(w, "number");
      const approval = ref("f2");
      const CR = "The owner asked us in writing to release this number";
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", n.resource_id, null, CR, approval), "22023")).toBe(true); // no decision type (6-argument form)
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", n.resource_id, null, CR, approval, "policy_lapse"), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "cancel_number", n.resource_id, null, CR, approval, "robot"), "22023")).toBe(true);
      const { res, key } = exposed(world(), "number");
      expect(hasCode(callErr("tw4_rfl_dual_request", P, "absorb_exposure", res.resource_id, key, REASON, null, "owner_written"), "22023")).toBe(true);
      expect(callErr("tw4_rfl_dual_request", P, "absorb_exposure", res.resource_id, key, REASON, null)).toBe(""); // the old 6-argument call form
      const req = cancelRequest(n.resource_id, approval, CR, P, "owner_written");
      expect(psql(`select cancel_decided_by from public.studio_sms_rfl_dual_requests where id = '${req.request_id}'`)).toBe("owner_written");
      call("tw4_rfl_dual_approve", req.request_id, P2, NOTE);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", n.resource_id, P3, approval, "founder_written", CR, true), "TW042")).toBe(true);
      expect(reqStatus(req.request_id)).toBe("approved");
      expect(num(`select count(*) from public.studio_sms_provider_cancel_ops where resource_id = '${n.resource_id}'`)).toBe(0);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", n.resource_id, P3, approval, "policy_lapse", CR, true), "TW042")).toBe(true);
      expect(callErr("tw4_rfl_cancel_authorize", n.resource_id, P3, approval, "owner_written", CR, true)).toBe("");
      expect(reqStatus(req.request_id)).toBe("consumed");
      // a different decision type is a different binding for the open request
      const w2 = world();
      const n2 = register(w2, "number");
      const a = cancelRequest(n2.resource_id, ref("f2b"), CR, P, "owner_written");
      const b = cancelRequest(n2.resource_id, psql(`select approval_ref from public.studio_sms_rfl_dual_requests where id = '${a.request_id}'`), CR, P3, "founder_written");
      expect(b.request_id).not.toBe(a.request_id);
      expect(reqStatus(a.request_id)).toBe("invalidated");
    });

    it("F3 a request is BORN pending and undecided: an owner-level insert cannot fabricate an approved or consumed row", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const base = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_reject", base.request_id, P2, "closing the base request before the direct insert");
      const id = randomUUID();
      psql(`insert into public.studio_sms_rfl_dual_requests (id, action, legal_entity_id, studio_id, resource_id, period_key, reason, facts_hash, status, requested_by, requested_at, expires_at,
          decided_by, decided_at, decision_note, consumed_at, consumed_by)
        values ('${id}', 'absorb_exposure', '${w.entity}', '${w.studio}', '${res.resource_id}', '${key}', '${REASON}', '${digest()}', 'consumed', '${P}', now(), now() + interval '1 hour',
          '${P2}', now(), '${NOTE}', now(), '${P2}');`);
      expect(rows<{ status: string; decided_by: string | null; decided_at: string | null; decision_note: string | null; consumed_at: string | null; consumed_by: string | null }>(
        `select status, decided_by, decided_at, decision_note, consumed_at, consumed_by from public.studio_sms_rfl_dual_requests where id = '${id}'`)[0]).toEqual({
        status: "pending", decided_by: null, decided_at: null, decision_note: null, consumed_at: null, consumed_by: null });
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true); // a pending row authorizes nothing
    });

    it("F5 the REQUESTER must still be a platform administrator: a demoted requester's request is invalidated at approval, and an approved one stops working", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const x = mkUser({ confirmed: true, admin: true });
      const demote = (u: string) => replica(`update public.profiles set platform_role = null where id = '${u}';`);
      const r1 = absorbRequest(res.resource_id, key, REASON, x);
      demote(x);
      expect(call("tw4_rfl_dual_approve", r1.request_id, P2, NOTE)).toMatchObject({ status: "invalidated" });
      expect(reqStatus(r1.request_id)).toBe("invalidated");
      // approved first, demoted afterwards: unusable
      const y = mkUser({ confirmed: true, admin: true });
      const r2 = absorbRequest(res.resource_id, key, REASON, y);
      call("tw4_rfl_dual_approve", r2.request_id, P2, NOTE);
      demote(y);
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open" });
      expect(reqStatus(r2.request_id)).toBe("approved");
      expect(call<Array<{ request_id: string }>>("tw4_rfl_dual_list", P).some((r) => r.request_id === r2.request_id)).toBe(false);
      expect(reqStatus(r2.request_id)).toBe("invalidated");
      // and a fresh request by an administrator in good standing works
      const r3 = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", r3.request_id, P3, NOTE);
      expect(dispose(res.resource_id, key, REASON)).toBe("");
    });

    it("F5 expiry is judged against the real clock inside a transaction: an approval that expires between request and use is refused", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const r = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", r.request_id, P2, NOTE);
      replica(`update public.studio_sms_rfl_dual_requests set requested_at = now() - interval '1 hour', expires_at = clock_timestamp() + interval '3 seconds' where id = '${r.request_id}';`);
      // one transaction that outlives the expiry: now() is frozen at the start, clock_timestamp() is not
      const err = psqlError(`begin; select pg_sleep(4); select public.tw4_rfl_exposure_dispose('${res.resource_id}'::uuid, '${key}', '${P}'::uuid, 'absorbed', '${REASON}'); commit;`);
      expect(hasCode(err, "TW042")).toBe(true);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open" });
    });

    it("F4 the escalation texts are truthful (no claim that two notices were delivered) and keep their dedupe keys", () => {
      const w = world();
      register(w, "number");
      const auth = authFixture(w, "number", { startsDaysAgo: 5, expiresInDays: 10 });
      scan(w);
      const second = alertsOf(w, "owner_notice_second")[0];
      const esc = alertsOf(w, "owner_unresponsive")[0];
      expect(second.dedupe_key).toBe(`auth2:${auth}`);
      expect(esc.dedupe_key).toBe(`auth:${auth}:escalate`);
      expect(second.summary).toMatch(/has not yet been renewed/);
      expect(esc.summary).toMatch(/has not yet been renewed; reminders were queued/);
      expect(esc.summary + second.summary).not.toMatch(/two notices|Second notice|after two/i);
    });

    it("F7 switch ordering is deterministic on equal timestamps (sequence tie-break), and an expired lease is closed as failed even while the scan switch is off", () => {
      const tie = (first: boolean, second: boolean) => psql(`begin;
        insert into public.studio_sms_rfl_switch_log (switch, enabled, changed_by, reason, changed_at) values ('scan', ${first}, '${P}', 'tie-break fixture one', now() + interval '1 year');
        insert into public.studio_sms_rfl_switch_log (switch, enabled, changed_by, reason, changed_at) values ('scan', ${second}, '${P}', 'tie-break fixture two', now() + interval '1 year');
        select public.tw4_rfl_switch_enabled('scan')::text; rollback;`);
      expect(tie(true, false)).toBe("false");
      expect(tie(false, true)).toBe("true");
      // lease expiry while off
      replica(`update public.studio_sms_rfl_runs set status = 'failed', finished_at = now(), error = 'closed by the ops suite' where status = 'running';`);
      setSwitch("scan", true);
      const run = call<{ run_id: string }>("tw4_rfl_scan_begin", "crashed-runner", 60);
      replica(`update public.studio_sms_rfl_runs set lease_expires_at = now() - interval '1 second' where id = '${run.run_id}';`);
      setSwitch("scan", false);
      expect(call("tw4_rfl_scan_begin", "ops-runner", 600)).toEqual({ ran: false, reason: "switched_off", run_id: null });
      expect(psql(`select status || ':' || error from public.studio_sms_rfl_runs where id = '${run.run_id}'`)).toBe("failed:lease expired before the run finished");
      expect(call<Record<string, unknown>>("tw4_rfl_health", P).last_status).not.toBe("running");
    });

    it("NEW A one RESTRICTIVE policy hides admin-addressed emails (platform_rfl_admin_*) from every API persona; everything else is visible exactly as before; near-miss prefixes stay visible; service role and the owner still read all", () => {
      const w = world();
      const other = world();
      const personas: Record<string, string | null> = { owner: w.owner, studio_admin: mkUser({ confirmed: true }), front_desk: mkUser({ confirmed: true }), instructor: mkUser({ confirmed: true }),
        inactive: mkUser({ confirmed: true }), other_studio_owner: other.owner, anon: null };
      addRole(personas.studio_admin as string, w.studio, "studio_admin");
      addRole(personas.front_desk as string, w.studio, "front_desk");
      addRole(personas.instructor as string, w.studio, "instructor");
      addRole(personas.inactive as string, w.studio, "front_desk", false);
      const ins = (template: string) => {
        const id = randomUUID();
        psql(`insert into public.outbound_deliveries (id, studio_id, channel, template_key, recipient_email, subject, status) values ('${id}', '${w.studio}', 'email', '${template}', 'x@example.test', 'ops fixture subject', 'queued');`);
        return id;
      };
      const adminRow = ins("platform_rfl_admin_exposure_open");
      const visibleRows = [ins("platform_rfl_alert_exposure_open"), ins("booking_confirmation"), ins("platform_rfl_adminx_exposure_open"), ins("platform_rfl_admin"), ins("Platform_rfl_admin_exposure_open"),
        ins("platform-rfl-admin-exposure_open"), ins("xplatform_rfl_admin_exposure_open")];
      const read = (role: string, sub: string | null, withoutPolicy: boolean) => {
        const out = psql(`begin; ${withoutPolicy ? "drop policy rfl_admin_alerts_not_staff_visible on public.outbound_deliveries;" : ""} set local role ${role};
          ${sub ? `select set_config('request.jwt.claims', '{"sub":"${sub}"}', true);` : ""}
          select coalesce(string_agg(id::text, ',' order by id), '') from public.outbound_deliveries where studio_id = '${w.studio}'; rollback;`);
        const last = out.split("\n").pop() ?? "";
        return last === "" ? [] : last.split(",");
      };
      for (const [name, sub] of Object.entries(personas)) {
        const role = sub ? "authenticated" : "anon";
        const before = read(role, sub, true); // the same transaction with the policy dropped (rolled back)
        const after = read(role, sub, false);
        expect(after, name).toEqual(before.filter((id) => id !== adminRow));
        expect(after, name).not.toContain(adminRow);
        if (["owner", "studio_admin", "front_desk", "instructor"].includes(name)) {
          expect(before, name).toContain(adminRow); // this is what the policy is for: they COULD read it before
          expect(after, name).toEqual(expect.arrayContaining(visibleRows));
        }
      }
      expect(read("service_role", null, false)).toEqual(expect.arrayContaining([adminRow, ...visibleRows]));
      expect(psql(`select count(*) from public.outbound_deliveries where id = '${adminRow}'`)).toBe("1"); // the table owner
      // a permissive policy ADDED AFTER the migration (FOR ALL to authenticated, SELECT to public, with a subselect) cannot expose administrator rows
      const withLater = psql(`begin;
        create policy rfl_later_all on public.outbound_deliveries as permissive for all to authenticated using (true) with check (true);
        create policy rfl_later_public on public.outbound_deliveries as permissive for select to public using (exists (select 1 from public.user_studio_roles usr where usr.studio_id = outbound_deliveries.studio_id));
        set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${personas.front_desk}"}', true);
        select coalesce(string_agg(id::text, ',' order by id), '') from public.outbound_deliveries where studio_id = '${w.studio}'; rollback;`).split("\n").pop() ?? "";
      expect(withLater.split(",")).not.toContain(adminRow);
      expect(withLater.split(",")).toEqual(expect.arrayContaining(visibleRows));
      // the policy does not change WRITE behaviour for other rows: the same statements succeed or fail identically with and without it (as a platform administrator, who may update)
      const writes = (withoutPolicy: boolean) => {
        const sub = P;
        const script = `begin; ${withoutPolicy ? "drop policy rfl_admin_alerts_not_staff_visible on public.outbound_deliveries;" : ""} set local role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${sub}"}', true);
          with u as (update public.outbound_deliveries set status = 'queued' where id = '${visibleRows[1]}' returning 1) select 'upd=' || count(*) from u;
          with d as (delete from public.outbound_deliveries where id = '${visibleRows[2]}' returning 1) select 'del=' || count(*) from d;
          with ua as (update public.outbound_deliveries set status = 'queued' where id = '${adminRow}' returning 1) select 'updadmin=' || count(*) from ua;
          rollback;`;
        return { out: psqlError(script) === "" ? psql(script).split("\n").filter((l) => /^(upd|del|updadmin)=/.test(l)) : ["error"] };
      };
      const wBefore = writes(true).out;
      const wAfter = writes(false).out;
      expect(wAfter.filter((l) => !l.startsWith("updadmin"))).toEqual(wBefore.filter((l) => !l.startsWith("updadmin")));
      expect(wAfter.find((l) => l.startsWith("updadmin"))).toBe("updadmin=0"); // a studio-level reader cannot even update an administrator row
    });

    it("NEW B tw4_rfl_admin_overview returns open_cancel_operation_id next to open_cancel_operation (every existing key kept); tw4_rfl_dual_list keeps approval_ref and resource_kind", () => {
      const w = world();
      const camp = register(w, "campaign");
      const num1 = register(w, "number");
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("overview"), "owner_written", "The owner asked us in writing to cancel the campaign", true);
      const overview = call<{ resources: Array<Record<string, unknown>> }>("tw4_rfl_admin_overview", P);
      const mineOf = (id: string) => overview.resources.find((r) => r.resource_id === id)!;
      for (const k of ["resource_id", "legal_entity_id", "studio_id", "kind", "fee_kind", "provider_state", "df_sending", "current_period", "next_period", "open_cancel_operation", "open_cancel_operation_id"]) {
        expect(Object.keys(mineOf(camp.resource_id)), k).toContain(k);
      }
      expect(mineOf(camp.resource_id)).toMatchObject({ open_cancel_operation: "authorized", open_cancel_operation_id: op.operation_id });
      expect(mineOf(num1.resource_id)).toMatchObject({ open_cancel_operation: null, open_cancel_operation_id: null });
      expect(Object.keys(overview as Record<string, unknown>).sort()).toEqual(["alerts_waiting", "cancel_operations_open", "open_exposure", "open_exposure_billed_cents", "open_exposure_expected_cents", "resources"]);
      const approval = ref("list-keys");
      const req = cancelRequest(num1.resource_id, approval, "The owner asked us in writing to release this number", P, "founder_written");
      const entry = call<Array<Record<string, unknown>>>("tw4_rfl_dual_list", P2).find((r) => r.request_id === req.request_id)!;
      expect(entry).toMatchObject({ approval_ref: approval, resource_kind: "number", action: "cancel_number", cancel_decided_by: "founder_written", decided_by: "founder_written" });
    });
  });

  describe("review round 2: policy shapes, approver standing, sequence privileges", () => {

    it("the policy's rollback is exact (pg_policy digest, comments included, identical to the pre-migration digest); the migration refuses atomically when RLS is off", () => {
      const dir = join(process.cwd(), "src/lib/supabase/migrations");
      const opsSql = readFileSync(join(dir, "20261211090000_twilio_rfl_ops.sql"), "utf8");
      const rollbackSql = readFileSync(join(dir, "rollback/20261211090000_twilio_rfl_ops_rollback.sql"), "utf8");
      const scratch = `${DB}_pol_${RUN}`;
      const sh = (cmd: string) => execFileSync("docker", ["exec", PG, "sh", "-c", cmd], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      const run = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", scratch, "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      const runErr = (sql: string) => {
        try {
          run(sql);
          return "";
        } catch (e) {
          return String((e as { stderr?: Buffer | string }).stderr ?? e);
        }
      };
      try {
        sh(`psql -U postgres -q -c 'create database ${scratch}'`);
        sh(`pg_dump -U postgres -s --no-owner ${DB} | psql -U postgres -d ${scratch} -q > /dev/null 2>&1; true`);
        run(rollbackSql); // the pre-ops state (the copy carries no evidence)
        expect(run(`select count(*) from pg_policy where polname = 'rfl_admin_alerts_not_staff_visible'`)).toBe("0");
        const pol = run(`select polname from pg_policy where polrelid = 'public.outbound_deliveries'::regclass and polname = 'outbound_deliveries_select'`);
        expect(pol).toBe("outbound_deliveries_select");
        run(`comment on policy outbound_deliveries_select on public.outbound_deliveries is 'ops suite comment that must survive'`);
        const digest = `select md5(string_agg(polname::text || polcmd::text || polroles::text || polpermissive::text || coalesce(pg_get_expr(polqual, polrelid), '-') || coalesce(pg_get_expr(polwithcheck, polrelid), '-')
          || coalesce(obj_description(oid, 'pg_policy'), '-'), '|' order by polname)) from pg_policy where polrelid = 'public.outbound_deliveries'::regclass`;
        const d0 = run(digest);
        run(opsSql);
        expect(run(`select count(*) from pg_policy where polname = 'rfl_admin_alerts_not_staff_visible' and not polpermissive and polcmd = 'r'`)).toBe("1");
        expect(run(digest)).not.toBe(d0);
        run(rollbackSql);
        expect(run(digest)).toBe(d0);
        // RLS off: refused, nothing applied
        run(`alter table public.outbound_deliveries disable row level security;`);
        const err = runErr(opsSql);
        expect(err).toMatch(/row level security is not enabled/);
        expect(run(`select to_regclass('public.studio_sms_rfl_switch_log') is null and to_regclass('public.studio_sms_rfl_dual_requests') is null`)).toBe("t");
        expect(run(`select count(*) from pg_policy where polname = 'rfl_admin_alerts_not_staff_visible'`)).toBe("0");
      } finally {
        try {
          sh(`psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${scratch}'" -c 'drop database if exists ${scratch}'`);
        } catch {
          // best effort
        }
      }
    }, 600_000);

    it("P2-2 the APPROVER must still be a platform administrator: demotion invalidates at once and for good (re-promotion does not revive it); a demotion made with triggers disabled is caught and persisted by the next look", () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const a = mkUser({ confirmed: true, admin: true });
      const b = mkUser({ confirmed: true, admin: true });
      const setRole = (u: string, role: string | null) => psql(`update public.profiles set platform_role = ${role ? `'${role}'` : "null"} where id = '${u}';`);
      // A requests, B approves, B is demoted (triggers fire), A executes
      const r1 = absorbRequest(res.resource_id, key, REASON, a);
      call("tw4_rfl_dual_approve", r1.request_id, b, NOTE);
      setRole(b, null);
      expect(reqStatus(r1.request_id)).toBe("invalidated");
      expect(audit(w, "rfl_dual_invalidated")).toBeGreaterThanOrEqual(1);
      expect(hasCode(dispose(res.resource_id, key, REASON, a), "TW042")).toBe(true);
      setRole(b, "platform_admin"); // re-promotion revives nothing
      expect(reqStatus(r1.request_id)).toBe("invalidated");
      expect(hasCode(dispose(res.resource_id, key, REASON, a), "TW042")).toBe(true);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open" });
      // a demoted REQUESTER loses a pending request at once, too
      const r2 = absorbRequest(res.resource_id, key, REASON, a);
      expect(r2.request_id).not.toBe(r1.request_id);
      setRole(a, null);
      expect(reqStatus(r2.request_id)).toBe("invalidated");
      setRole(a, "platform_admin");
      expect(call("tw4_rfl_dual_approve", r2.request_id, b, NOTE)).toMatchObject({ status: "invalidated", replayed: true });
      // demotion with triggers disabled: refused at execution, persisted by the list, and re-promotion afterwards does not revive it
      const c = mkUser({ confirmed: true, admin: true });
      const d = mkUser({ confirmed: true, admin: true });
      const r3 = absorbRequest(res.resource_id, key, REASON, c);
      call("tw4_rfl_dual_approve", r3.request_id, d, NOTE);
      replica(`update public.profiles set platform_role = null where id = '${d}';`);
      expect(reqStatus(r3.request_id)).toBe("approved");
      expect(hasCode(dispose(res.resource_id, key, REASON, c), "TW042")).toBe(true);
      expect(call<Array<{ request_id: string }>>("tw4_rfl_dual_list", P).some((r) => r.request_id === r3.request_id)).toBe(false);
      expect(reqStatus(r3.request_id)).toBe("invalidated");
      replica(`update public.profiles set platform_role = 'platform_admin' where id = '${d}';`);
      expect(hasCode(dispose(res.resource_id, key, REASON, c), "TW042")).toBe(true);
      // a fresh request by administrators in good standing works
      const r4 = absorbRequest(res.resource_id, key, REASON);
      call("tw4_rfl_dual_approve", r4.request_id, P3, NOTE);
      expect(dispose(res.resource_id, key, REASON)).toBe("");
      expect(psql(`select count(*) from pg_trigger where tgname like 'profiles_90_rflops_demotion%'`)).toBe("2");
    });

    it("P2-4 the switch log's identity sequence (and any other sequence this migration owns) has no grant for any API role", () => {
      const seqs = rows<{ name: string }>(`select s.relname as name from pg_class s join pg_depend d on d.objid = s.oid and d.deptype = 'a' join pg_class t on t.oid = d.refobjid
        where s.relkind = 'S' and (t.relname like 'studio\\_sms\\_rfl\\_%' or t.relname = 'studio_sms_provider_variance_acks')`);
      expect(seqs.map((s) => s.name)).toContain("studio_sms_rfl_switch_log_seq_seq");
      for (const s of seqs) {
        for (const role of ["anon", "authenticated", "service_role", "public"]) {
          for (const priv of ["usage", "select", "update"]) {
            expect(psql(`select has_sequence_privilege('${role}', 'public.${s.name}', '${priv}')::text`), `${s.name}/${role}/${priv}`).toBe("false");
          }
        }
      }
      // the owner-definer functions still draw from it
      expect(call("tw4_rfl_set_switch", "scan", swState("scan"), P, "fixture: unchanged scan state, drawing from the sequence")).toMatchObject({ switch: "scan" });
    });
  });

  describe("review round 3: alert release, profile locks", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const alertRow = (id: string) => rows<Record<string, unknown>>(`select * from public.studio_sms_provider_alerts where id = '${id}'`)[0];

    it("tw4_rfl_alert_release gives the CURRENT claim back (attempts unchanged overall, nothing else changed); wrong token, delivered, failed and replays are {released:false}; ten claim/release cycles never exhaust or escalate it", () => {
      const w = world();
      const alert = mkAlert(w, { audience: "admin" });
      isolateAlerts([alert]);
      setSwitch("delivery", true);
      const base = alertRow(alert);
      const strip = (r: Record<string, unknown>) => {
        const { status, attempts, claim_token, claimed_at, ...rest } = r;
        void status; void attempts; void claim_token; void claimed_at;
        return rest;
      };
      for (let i = 0; i < 10; i++) {
        const claimed = claimAll().find((c) => c.alert_id === alert);
        expect(claimed, `cycle ${i}`).toBeTruthy();
        expect(alertRow(alert)).toMatchObject({ status: "sending", attempts: 1 });
        expect(call("tw4_rfl_alert_release", alert, randomUUID())).toEqual({ released: false }); // another token
        expect(alertRow(alert)).toMatchObject({ status: "sending", attempts: 1 });
        expect(call("tw4_rfl_alert_release", alert, claimed!.claim_token)).toEqual({ released: true });
        expect(call("tw4_rfl_alert_release", alert, claimed!.claim_token)).toEqual({ released: false }); // replay
        expect(alertRow(alert)).toMatchObject({ status: "pending", attempts: 0, claim_token: null, claimed_at: null });
        expect(strip(alertRow(alert))).toEqual(strip(base));
      }
      expect(call<{ escalated: number }>("tw4_rfl_escalate_delivery").escalated).toBeGreaterThanOrEqual(0);
      expect(alertsOf(w, "alert_delivery_exhausted").filter((a) => a.dedupe_key === `exhausted:${alert}`)).toHaveLength(0);
      // failed and delivered alerts cannot be released
      const claimed = claimAll().find((c) => c.alert_id === alert)!;
      call("tw4_rfl_alert_finish", alert, claimed.claim_token, false, "smtp refused");
      expect(call("tw4_rfl_alert_release", alert, claimed.claim_token)).toEqual({ released: false });
      expect(alertRow(alert)).toMatchObject({ status: "failed", attempts: 1 });
      const again = claimAll().find((c) => c.alert_id === alert)!;
      call("tw4_rfl_alert_finish", alert, again.claim_token, true, null);
      expect(call("tw4_rfl_alert_release", alert, again.claim_token)).toEqual({ released: false });
      expect(alertRow(alert)).toMatchObject({ status: "delivered" });
      expect(call("tw4_rfl_alert_release", randomUUID(), randomUUID())).toEqual({ released: false });
      expect(call("tw4_rfl_alert_release", alert, null)).toEqual({ released: false });
      // the guard still refuses every other way of lowering attempts
      const w2 = world();
      const other = mkAlert(w2, { audience: "admin" });
      replica(`update public.studio_sms_provider_alerts set status = 'sending', attempts = 3, claim_token = '${randomUUID()}', claimed_at = now() where id = '${other}';`);
      expect(psqlError(`update public.studio_sms_provider_alerts set attempts = 2 where id = '${other}';`)).toMatch(/only delivery fields change/);
      expect(psqlError(`update public.studio_sms_provider_alerts set status = 'pending', attempts = 1, claim_token = null where id = '${other}';`)).toMatch(/only delivery fields change/);
      expect(psqlError(`begin; select set_config('tw4.rflops_write', 'on', true); update public.studio_sms_provider_alerts set status = 'failed', attempts = 2 where id = '${other}'; commit;`)).toMatch(/only delivery fields change/);
    });

    it("C approve versus demotion, in real concurrent sessions: no deadlock, and both orders end invalidated (requester demoted while an approval is open; approver demoted while their approval is open, re-promoted, then consumed => TW042)", async () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      const x = mkUser({ confirmed: true, admin: true }); // requester
      const y = mkUser({ confirmed: true, admin: true }); // approver
      const roleSql = (u: string, role: string | null) => `update public.profiles set platform_role = ${role ? `'${role}'` : "null"} where id = '${u}';`;
      // 1. the approval transaction is open (holds the share locks) while the REQUESTER is demoted and re-promoted
      const r1 = absorbRequest(res.resource_id, key, REASON, x);
      const approve = psqlAsync(`begin; select public.tw4_rfl_dual_approve('${r1.request_id}'::uuid, '${y}'::uuid, '${NOTE}'); select pg_sleep(4); commit;`);
      await sleep(1500);
      const t0 = Date.now();
      const demote = psqlAsync(`${roleSql(x, null)} ${roleSql(x, "platform_admin")}`);
      const [a1, d1] = await Promise.all([approve, demote]);
      expect(a1.err).not.toMatch(/40P01|deadlock/);
      expect(d1.err).toBe("");
      expect(a1.err).toBe("");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1500); // the demotion waited for the open approval
      expect(reqStatus(r1.request_id)).toBe("invalidated");
      expect(hasCode(dispose(res.resource_id, key, REASON), "TW042")).toBe(true);
      // 2. the APPROVER's approval transaction is open; the approver is demoted (waits), re-promoted, then the approval is consumed
      const r2 = absorbRequest(res.resource_id, key, REASON, x);
      const approve2 = psqlAsync(`begin; select public.tw4_rfl_dual_approve('${r2.request_id}'::uuid, '${y}'::uuid, '${NOTE}'); select pg_sleep(4); commit;`);
      await sleep(1500);
      const demote2 = psqlAsync(`${roleSql(y, null)} ${roleSql(y, "platform_admin")}`);
      const [a2, d2] = await Promise.all([approve2, demote2]);
      expect(a2.err).toBe("");
      expect(d2.err).toBe("");
      expect(reqStatus(r2.request_id)).toBe("invalidated");
      expect(hasCode(dispose(res.resource_id, key, REASON, x), "TW042")).toBe(true);
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "open" });
      // 3. a demotion committed BEFORE the approval is refused (the approver is no longer an administrator)
      const r3 = absorbRequest(res.resource_id, key, REASON, x);
      psql(roleSql(y, null));
      expect(hasCode(callErr("tw4_rfl_dual_approve", r3.request_id, y, NOTE), "42501")).toBe(true);
      psql(roleSql(y, "platform_admin"));
      // 4. execution holds the share locks too: a demotion that arrives during a disposition waits, and the consumed approval stays consumed
      const r4 = absorbRequest(res.resource_id, key, REASON, x);
      call("tw4_rfl_dual_approve", r4.request_id, y, NOTE);
      const run = psqlAsync(`begin; select public.tw4_rfl_exposure_dispose('${res.resource_id}'::uuid, '${key}', '${x}'::uuid, 'absorbed', '${REASON}'); select pg_sleep(4); commit;`);
      await sleep(1500);
      const demote4 = psqlAsync(`${roleSql(y, null)} ${roleSql(y, "platform_admin")}`);
      const [a4, d4] = await Promise.all([run, demote4]);
      expect(a4.err).toBe("");
      expect(d4.err).toBe("");
      expect(a4.err + d4.err).not.toMatch(/40P01|deadlock/);
      expect(reqStatus(r4.request_id)).toBe("consumed");
      expect(exposureOf(res.resource_id, key)).toMatchObject({ state: "closed", disposition: "absorbed" });
    });
  });
});
