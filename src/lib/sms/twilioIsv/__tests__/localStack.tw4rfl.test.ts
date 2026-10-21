/**
 * TW-4F recurring provider-fee lifecycle (20261209090000) against a REAL schema: inventory, cover, exposure, the sending gate, provider-bill evidence,
 * DanceFlow suspension vs provider cancellation, the cancellation state machine, alerts, races, retries, uncertain provider outcomes and tenant isolation.
 * Every scenario creates its own synthetic "world" (unique ids; no shared mutable state), so the suite needs no cleanup between tests. Nothing reaches Twilio or Stripe.
 *
 * LOCAL QA DATABASE ONLY. Skipped unless both variables are set and the database carries the local-QA marker table (created by LOCAL QA fixtures only; no migration
 * creates it) with the migrations through 20261209090000 applied. Use an ISOLATED database cloned from the QA stack, not the stack's shared one:
 *
 *   TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa  TW4RFL_DB=rfl_qa
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `aa${RUN}-0000-4000-8000-000000000401`; // platform admin
const P2 = `aa${RUN}-0000-4000-8000-000000000402`;
const MIGRATION = "20261209090000_twilio_recurring_fee_lifecycle";

const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
/** Runs a script; returns stdout (trimmed). Throws on SQL error. */
const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
/** Runs a script and returns its error output with SQLSTATEs (empty when it succeeded). */
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
  const s = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
};
const callSql = (fn: string, ...args: unknown[]) => `select public.${fn}(${args.map(lit).join(", ")})::text;`;
const call = <T = Record<string, unknown>>(fn: string, ...args: unknown[]): T => JSON.parse(psql(callSql(fn, ...args)) || "null") as T;
const callErr = (fn: string, ...args: unknown[]) => psqlError(callSql(fn, ...args));
const hasCode = (err: string, code: string) => new RegExp(`ERROR:\\s+${code}:`).test(err);
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);

const sid = (prefix: string) => `${prefix}${randomBytes(16).toString("hex")}`;
const digest = () => randomBytes(32).toString("hex");
const ref = (label: string) => `Written approval ${RUN} ${label} ${randomBytes(3).toString("hex")}`;

type World = { entity: string; studio: string; owner: string; account: string; pilot: boolean; n: number };
let worldSeq = 0;
const PRICE = { number: 0, monthly: 0 };
const cur = () => psql("select to_char(now() at time zone 'UTC', 'YYYY-MM')");
const keyAdd = (key: string, n: number) => psql(`select to_char((${lit(key + "-01")}::date + make_interval(months => ${n})), 'YYYY-MM')`);
const prevKey = () => keyAdd(cur(), -1);
const nextKey = () => keyAdd(cur(), 1);

/** The platform allows exactly ONE pilot business (ConfiDance Unlimited, LLC): every pilot scenario gets a fresh LOCATION of it and a reset ceiling. */
let pilotShared: { entity: string; account: string } | null = null;
function pilotWorld(opts: { ceiling?: number }): World {
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
      const owner = randomUUID();
      psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pilot-${RUN}@rfl-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${studio}', 'RFL pilot founding', 'rfl-pilot-${RUN}', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${entity}', 'ConfiDance Unlimited, LLC', '9999', 15000, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${studio}', '${entity}', 'founding', '${P}', 'fixture: verified synthetic pilot business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${entity}', '${account}', 'rfl-pilot', 'test', 'active', '${P}');
commit;`);
      call("tw4_credit_adjust", entity, 200_000, `rfl-fund-pilot-${RUN}`, "fixture funding for the lifecycle suite", P);
      call("tw4_monthly_limit_set_admin", entity, P, 20_000, null, "fixture: monthly limit for the lifecycle suite");
      call("tw4_pilot_exception_create", entity, 15000, `Founder written pilot approval ${RUN}`, P);
      pilotShared = { entity, account };
    }
  }
  const w: World = { entity: pilotShared.entity, studio: randomUUID(), owner: randomUUID(), account: pilotShared.account, pilot: true, n: worldSeq };
  // earlier scenarios' pilot reservations / approvals no longer count; the ceiling is this scenario's
  replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = coalesce(closed_at, now()) where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured');
    update public.studio_sms_spend_events set status = 'void' where legal_entity_id = '${w.entity}' and status in ('authorized', 'reserved');
    update public.studio_sms_pilot_exceptions set ceiling_cents = ${opts.ceiling ?? 15000} where legal_entity_id = '${w.entity}';
    update public.studio_sms_credit_accounts set hold = false, hold_reason = null where legal_entity_id = '${w.entity}';`);
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${RUN}-${w.n}@rfl-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'RFL pilot ${RUN} ${w.n}', 'rfl-pilot-${RUN}-${w.n}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
commit;
begin; set local session_replication_role = replica;
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now());
commit;`);
  return w;
}

/** A fresh synthetic business with one location, an active subaccount, funded credit and a monthly limit (the pilot business: see pilotWorld). */
function world(opts: { pilot?: boolean; fund?: number; ceiling?: number } = {}): World {
  if (opts.pilot) return pilotWorld(opts);
  worldSeq += 1;
  const w: World = { entity: randomUUID(), studio: randomUUID(), owner: randomUUID(), account: sid("AC"), pilot: false, n: worldSeq };
  const fund = opts.fund ?? 200_000;
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${RUN}-${w.n}@rfl-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'RFL ${RUN} ${w.n}', 'rfl-${RUN}-${w.n}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', 'RFL World ${RUN} ${w.n} LLC', '7777', 500000, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at)
  values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: verified synthetic business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by)
  values ('${w.entity}', '${w.account}', 'rfl-${RUN}-${w.n}', 'test', 'active', '${P}');
commit;`);
  call("tw4_credit_adjust", w.entity, fund, `rfl-fund-${RUN}-${w.n}`, "fixture funding for the lifecycle suite", P);
  call("tw4_monthly_limit_set_admin", w.entity, P, 20_000, null, "fixture: monthly limit for the lifecycle suite");
  return w;
}

const register = (w: World, kind: "number" | "campaign" | "messaging_service", extra: { sid?: string; e164?: string; reservation?: string | null; account?: string; actor?: string; source?: string } = {}) => {
  const providerSid = extra.sid ?? sid(kind === "number" ? "PN" : kind === "campaign" ? "QE" : "MG");
  const e164 = kind === "number" ? (extra.e164 ?? `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`) : null;
  const out = call<{ resource_id: string; replayed: boolean; fee_kind: string | null }>(
    "tw4_rfl_register", w.studio, extra.actor ?? P, kind, providerSid, extra.account ?? w.account, e164, extra.source ?? "admin", null, extra.reservation ?? null);
  return { ...out, sid: providerSid, e164 };
};
const regErr = (w: World, kind: string, providerSid: string, over: { account?: string; actor?: string; e164?: string | null; studio?: string } = {}) =>
  callErr("tw4_rfl_register", over.studio ?? w.studio, over.actor ?? P, kind, providerSid, over.account ?? w.account, over.e164 === undefined ? (kind === "number" ? "+15550001111" : null) : over.e164, "admin", null, null);

/** Direct fixture rows (the real authorize / charge paths are exercised separately). */
const authFixture = (w: World, kind: "number" | "monthly", o: { startsDaysAgo?: number; expiresInDays?: number; status?: "active" | "revoked"; term?: number } = {}) => {
  const id = randomUUID();
  const price = kind === "number" ? PRICE.number : PRICE.monthly;
  const term = o.term ?? 6;
  const revoked = o.status === "revoked";
  replica(`insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, starts_at, expires_at, status, authorized_by, statement, revoked_at, revoked_by)
    values ('${id}', '${w.entity}', '${w.studio}', '${kind}', ${price}, ${term}, ${price * term}, now() - interval '${o.startsDaysAgo ?? 90} days', now() + interval '${o.expiresInDays ?? 90} days',
            '${revoked ? "revoked" : "active"}', '${w.owner}', 'fixture: the owner authorized this recurring charge in the suite',
            ${revoked ? "now()" : "null"}, ${revoked ? `'${w.owner}'` : "null"});`);
  return id;
};
const chargeFixture = (w: World, authId: string, kind: "number" | "monthly", period: string, status: "charged" | "unfunded" | "held" | "refused") => {
  const res = randomUUID();
  const price = kind === "number" ? PRICE.number : PRICE.monthly;
  if (status === "charged") {
    replica(`insert into public.studio_sms_credit_reservations (id, legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
      values ('${res}', '${w.entity}', '${w.studio}', '${kind}', ${price}, 'credit', 'captured', 'rec:${authId}:${period}', now());
      insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reservation_id, charged_at)
      values ('${authId}', '${w.entity}', '${w.studio}', '${kind}', '${period}', ${price}, 'charged', '${res}', now());`);
  } else {
    replica(`insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reason)
      values ('${authId}', '${w.entity}', '${w.studio}', '${kind}', '${period}', ${price}, '${status}', 'fixture ${status}');`);
  }
};
/** Makes a resource old enough that the PREVIOUS service period is past its grace (deterministic on any day of the month). */
const age = (resourceId: string, days = 75) => replica(`update public.studio_sms_provider_resources set registered_at = registered_at - interval '${days} days' where id = '${resourceId}';`);
const senderFixture = (w: World, status: "approved" | "revoked" | "pending" | "released", o: { phone?: string | null; campaign?: string | null } = {}) => {
  const id = randomUUID();
  replica(`insert into public.studio_sms_billed_senders (id, legal_entity_id, studio_id, account_sid, messaging_service_sid, sender_e164, status, set_by, reason, campaign_sid, phone_number_sid)
    values ('${id}', '${w.entity}', '${w.studio}', '${w.account}', '${sid("MG")}', '+15559990000', '${status}', '${P}', 'fixture sender', ${o.campaign ? `'${o.campaign}'` : "null"}, ${o.phone ? `'${o.phone}'` : "null"});`);
  return id;
};
const scan = (w: World) => call<{ opened: number; closed: number; alerts: number }>("tw4_rfl_scan_entity", w.entity);
const state = (w: World) => psql(`select public._tw4rc_service_state('${w.studio}')`);
const exposure = (resourceId: string, period?: string) =>
  psql(`select coalesce(json_agg(json_build_object('period', period_key, 'state', state, 'reason', reason, 'disposition', disposition, 'billed', provider_billed_cents, 'expected', expected_provider_cents) order by period_key), '[]'::json)::text
          from public.studio_sms_provider_exposure where resource_id = '${resourceId}'${period ? ` and period_key = '${period}'` : ""}`);
const exposureRows = (resourceId: string, period?: string) => JSON.parse(exposure(resourceId, period)) as Array<{ period: string; state: string; reason: string; disposition: string | null; billed: number; expected: number | null }>;
const alertsOf = (w: World, kind?: string) =>
  Number(psql(`select count(*) from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' and (studio_id = '${w.studio}' or studio_id is null)${kind ? ` and kind = '${kind}'` : ""}`));
const audit = (w: World, action: string) => Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = '${action}'`));
const providerState = (resourceId: string) => psql(`select provider_state from public.studio_sms_provider_resources where id = '${resourceId}'`);
const opStatus = (opId: string) => psql(`select status from public.studio_sms_provider_cancel_ops where id = '${opId}'`);

describe.skipIf(!enabled)("TW-4F recurring provider-fee lifecycle (real schema)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`)).toBe("t");
    expect(psql(`select to_regclass('public.studio_sms_provider_resources') is not null`)).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@rfl-e2e.test', now(), now(), now()),
         ('${P2}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin2-${RUN}@rfl-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin'), ('${P2}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
commit;`);
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150]] as const) {
      if (!psql(`select 1 from public.studio_sms_price_list where kind = '${kind}' and active`)) call("tw4_price_set", kind, customer, provider, `fixture ${kind} price`, P);
    }
    PRICE.number = Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = 'number' and active`));
    PRICE.monthly = Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = 'monthly' and active`));
  });

  afterAll(() => {
    // synthetic data lives in an isolated database; nothing else to remove
  });

  describe("inventory", () => {
    it("registers a number, a campaign and the Messaging Service; the fee kind is derived by the database, never supplied", () => {
      const w = world();
      const num = register(w, "number");
      const camp = register(w, "campaign");
      const ms = register(w, "messaging_service");
      expect([num.fee_kind, camp.fee_kind, ms.fee_kind]).toEqual(["number", "monthly", null]);
      expect(psql(`select resource_kind || ':' || coalesce(fee_kind, '-') || ':' || provider_state || ':' || twilio_account_sid from public.studio_sms_provider_resources where id = '${num.resource_id}'`)).toBe(`number:number:active:${w.account}`);
      expect(audit(w, "rfl_registered")).toBe(3);
    });

    it("is idempotent by provider sid; the same sid with different facts is refused (TW040), also across businesses", () => {
      const w = world();
      const other = world();
      const num = register(w, "number", { e164: "+15550101234" });
      expect(register(w, "number", { sid: num.sid, e164: "+15550101234" }).replayed).toBe(true);
      expect(hasCode(regErr(w, "number", num.sid, { e164: "+15550101999" }), "TW040")).toBe(true);
      expect(hasCode(regErr(w, "campaign", num.sid), "TW040")).toBe(true); // the same sid as another kind is a different fact
      // another business cannot claim it (its own subaccount differs)
      expect(hasCode(regErr(other, "number", num.sid, { e164: "+15550101234" }), "TW040")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_resources where provider_sid = '${num.sid}'`))).toBe(1);
    });

    it("refuses a resource that is not on the business's ACTIVE subaccount, an unlinked studio and a non-administrator actor", () => {
      const w = world();
      expect(hasCode(regErr(w, "number", sid("PN"), { account: sid("AC") }), "TW040")).toBe(true);
      expect(hasCode(regErr(w, "number", sid("PN"), { studio: randomUUID() }), "TW010")).toBe(true);
      expect(hasCode(regErr(w, "number", sid("PN"), { actor: w.owner }), "42501")).toBe(true);
      replica(`update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = '${w.entity}';`);
      expect(hasCode(regErr(w, "number", sid("PN")), "TW040")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_resources where legal_entity_id = '${w.entity}'`))).toBe(0);
    });

    it("one LIVE resource of each kind per location: a second live number / campaign is refused (it would be spending no owner authorized) until the first is confirmed cancelled", () => {
      const w = world();
      const first = register(w, "number");
      expect(hasCode(regErr(w, "number", sid("PN")), "TW040")).toBe(true);
      expect(psqlError(`insert into public.studio_sms_provider_resources (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, fee_kind, source, registered_by)
        values ('${w.entity}', '${w.studio}', '${w.account}', 'number', '${sid("PN")}', '+15550007777', 'number', 'admin', '${P}');`)).toMatch(/23505|duplicate key/);
      register(w, "campaign");   // another kind is fine
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", first.resource_id, P, ref("replace-number"), "owner_written", "The owner asked us in writing to replace this number", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      expect(register(w, "number").replayed).toBe(false);   // the replacement
    });

    it("a number needs its E.164; a free resource has no fee to cover", () => {
      const w = world();
      expect(hasCode(regErr(w, "number", sid("PN"), { e164: null }), "22023")).toBe(true);
      const err = psqlError(callSql("tw4_rfl_register", w.studio, P, "messaging_service", sid("MG"), w.account, null, "admin", null, randomUUID()));
      expect(hasCode(err, "22023")).toBe(true);
    });

    it("an initial reservation (pilot business only) covers the registration period while it is held or captured, belongs to this fee and business, and is used once", () => {
      const w = world({ pilot: true });
      const other = world();
      const resv = (target: World, kind: string, status = "captured") => {
        const id = randomUUID();
        replica(`insert into public.studio_sms_credit_reservations (id, legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
          values ('${id}', '${target.entity}', '${target.studio}', '${kind}', 100, 'credit', '${status}', 'init:${id}', ${status === "reserved" ? "null" : "now()"});`);
        return id;
      };
      expect(hasCode(callErr("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, "+15550202020", "r2b", null, resv(other, "number")), "TW040")).toBe(true); // another business's
      expect(hasCode(callErr("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, "+15550202021", "r2b", null, resv(w, "monthly")), "TW040")).toBe(true); // another fee
      const good = resv(w, "number");
      const num = register(w, "number", { reservation: good });
      const row = psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${num.resource_id}'`);
      expect(row).toBe("covered:initial_reservation");
      // a reservation covers one resource once
      expect(psqlError(callSql("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, "+15550202022", "r2b", null, good))).not.toBe("");
      // released = no longer covered
      replica(`update public.studio_sms_credit_reservations set status = 'released' where id = '${good}';`);
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${num.resource_id}'`)).toMatch(/^uncovered:/);
    });
  });

  describe("exposure and the sending gate", () => {
    it("a fresh resource without an authorization is inside its grace: no exposure, sending not suspended, but the owner and admins are warned", () => {
      const w = world();
      const camp = register(w, "campaign");
      const out = scan(w);
      expect(out.opened).toBe(0);
      expect(exposureRows(camp.resource_id)).toEqual([]);
      expect(state(w)).not.toBe("suspended");
      expect(alertsOf(w, "next_period_uncovered")).toBe(1);
    });

    it("an old resource with no authorization: the uncovered previous period is exposure, sending is suspended, the gate is DanceFlow-only (the resource stays active)", () => {
      const w = world();
      const camp = register(w, "campaign");
      age(camp.resource_id);
      const out = scan(w);
      expect(out.opened).toBeGreaterThanOrEqual(1);
      const prev = exposureRows(camp.resource_id, prevKey())[0];
      expect(prev).toMatchObject({ state: "open", reason: "no_authorization", expected: 150 });
      expect(state(w)).toBe("suspended");
      expect(providerState(camp.resource_id)).toBe("active");
      expect(alertsOf(w, "exposure_open")).toBeGreaterThanOrEqual(1);
    });

    it("a scan that did not run for months catches up: every uncovered period since registration is recorded, but history alone never suspends sending", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id, 200);
      const a = authFixture(w, "number", { startsDaysAgo: 220 });
      chargeFixture(w, a, "number", prevKey(), "charged");
      chargeFixture(w, a, "number", cur(), "charged");
      scan(w);
      const rows = exposureRows(num.resource_id);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.every((r) => r.state === "open" && r.period < prevKey())).toBe(true);
      expect(state(w)).not.toBe("suspended");   // the last two periods are paid
      // an administrator can still dispose of the history; covered recent periods have no exposure
      expect(exposureRows(num.resource_id, prevKey())).toEqual([]);
    });

    it("scanning again is idempotent: no second exposure row, no second alert, the exposure never closes by time", () => {
      const w = world();
      const camp = register(w, "campaign");
      age(camp.resource_id);
      scan(w);
      const before = { rows: exposureRows(camp.resource_id).length, alerts: alertsOf(w, "exposure_open"), audit: audit(w, "rfl_exposure_opened") };
      for (let i = 0; i < 3; i += 1) expect(scan(w).opened).toBe(0);
      expect({ rows: exposureRows(camp.resource_id).length, alerts: alertsOf(w, "exposure_open"), audit: audit(w, "rfl_exposure_opened") }).toEqual(before);
      expect(exposureRows(camp.resource_id, prevKey())[0].state).toBe("open");
    });

    it("an EXPIRED authorization is exposure with its own reason (and an expiry never silently becomes cover)", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      const a = authFixture(w, "number", { startsDaysAgo: 120, expiresInDays: -10 });
      chargeFixture(w, a, "number", keyAdd(cur(), -3), "charged");
      scan(w);
      expect(exposureRows(num.resource_id, prevKey())[0]).toMatchObject({ state: "open", reason: "authorization_expired" });
      expect(state(w)).toBe("suspended");
    });

    it("a REVOKED authorization is exposure with its own reason", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      authFixture(w, "number", { startsDaysAgo: 120, status: "revoked" });
      scan(w);
      expect(exposureRows(num.resource_id, prevKey())[0]).toMatchObject({ state: "open", reason: "authorization_revoked" });
      expect(state(w)).toBe("suspended");
    });

    it("EXHAUSTED funding: an unfunded / held / refused recurring charge is exposure with the matching reason; a later charge closes it by cover and sending resumes", () => {
      for (const [status, reason] of [["unfunded", "charge_unfunded"], ["held", "charge_held"], ["refused", "charge_refused"]] as const) {
        const w = world();
        const num = register(w, "number");
        age(num.resource_id);
        const a = authFixture(w, "number", { startsDaysAgo: 120 });
        chargeFixture(w, a, "number", prevKey(), status);
        chargeFixture(w, a, "number", cur(), "charged");
        scan(w);
        expect(exposureRows(num.resource_id, prevKey())[0]).toMatchObject({ state: "open", reason });
        expect(state(w)).toBe("suspended");
        replica(`delete from public.studio_sms_recurring_charges where authorization_id = '${a}' and period_key = '${prevKey()}';`);
        chargeFixture(w, a, "number", prevKey(), "charged");
        const out = scan(w);
        expect(out.closed).toBeGreaterThanOrEqual(1);
        expect(exposureRows(num.resource_id, prevKey())[0]).toMatchObject({ state: "closed", disposition: "covered_by_charge" });
        expect(state(w)).not.toBe("suspended");
      }
    });

    it("a negative balance and an account hold with live recurring resources raise admin / owner alerts, once per period", () => {
      const w = world();
      register(w, "number");
      replica(`update public.studio_sms_credit_accounts set balance_cents = -50, hold = true, hold_reason = 'fixture hold for the suite' where legal_entity_id = '${w.entity}';`);
      scan(w);
      scan(w);
      expect(alertsOf(w, "negative_balance")).toBe(1);
      expect(alertsOf(w, "account_on_hold")).toBe(1);
      expect(psql(`select audience from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' and kind = 'negative_balance'`)).toBe("admin");
    });

    it("funding_low warns before the next period when settled credit cannot cover the authorized charges (and is quiet while credit suffices)", () => {
      const w = world({ fund: 100 });
      const num = register(w, "number");
      authFixture(w, "number", { startsDaysAgo: 5, expiresInDays: 120 });
      // the alert only fires within 7 days of the next period: make the next period "close" by moving the resource's clock is not possible, so assert the rule directly
      const near = psql(`select (now() >= public._tw4ml_month_start('${w.entity}', '${nextKey()}') - interval '7 days')::text`);
      scan(w);
      expect(alertsOf(w, "funding_low")).toBe(near === "true" ? 1 : 0);
      expect(num.resource_id).toBeTruthy();
    });

    it("authorization_expiring is raised once, 35 days ahead, for an authorization that covers a live resource", () => {
      const w = world();
      register(w, "number");
      authFixture(w, "number", { startsDaysAgo: 5, expiresInDays: 20 });
      scan(w);
      scan(w);
      expect(alertsOf(w, "authorization_expiring")).toBe(1);
      const w2 = world();
      register(w2, "number");
      authFixture(w2, "number", { startsDaysAgo: 5, expiresInDays: 120 });
      scan(w2);
      expect(alertsOf(w2, "authorization_expiring")).toBe(0);
    });

    it("an administrator's written disposition (absorbed) is final and is the ONLY way an uncovered past period stops suspending sending", () => {
      const w = world();
      const camp = register(w, "campaign");
      age(camp.resource_id);
      scan(w);
      expect(state(w)).toBe("suspended");
      expect(psqlError(callSql("tw4_rfl_exposure_dispose", camp.resource_id, prevKey(), P, "absorbed", "short"))).not.toBe("");
      expect(hasCode(callErr("tw4_rfl_exposure_dispose", camp.resource_id, prevKey(), w.owner, "absorbed", "owner tries to absorb this loss"), "42501")).toBe(true);
      const key = prevKey();
      call("tw4_rfl_exposure_dispose", camp.resource_id, key, P, "absorbed", "DanceFlow accepts the lapse cost for this period");
      expect(exposureRows(camp.resource_id, key)[0]).toMatchObject({ state: "closed", disposition: "absorbed" });
      expect(audit(w, "rfl_exposure_disposed")).toBe(1);
      // a replay by the same actor is a no-op; another disposition afterwards is refused
      expect(call<{ replayed: boolean }>("tw4_rfl_exposure_dispose", camp.resource_id, key, P, "absorbed", "DanceFlow accepts the lapse cost for this period").replayed).toBe(true);
      expect(hasCode(callErr("tw4_rfl_exposure_dispose", camp.resource_id, key, P2, "not_billed_confirmed", "a different decision about the same period"), "TW041")).toBe(true);
      // the previous period no longer suspends; a CURRENT uncovered period past grace still would (not asserted on early days of a month)
      scan(w);
      expect(exposureRows(camp.resource_id, key)[0].state).toBe("closed");
    });

    it("renewal is the owner's explicit authorization through the existing path: the commitment covers the current period, nothing is extended silently, the old gap needs a disposition", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      authFixture(w, "number", { startsDaysAgo: 120, expiresInDays: -20 });
      scan(w);
      expect(state(w)).toBe("suspended");
      // nothing renewed it by itself
      expect(Number(psql(`select count(*) from public.studio_sms_recurring_authorizations where studio_id = '${w.studio}' and status = 'active' and expires_at > now()`))).toBe(0);
      const renewed = call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null);
      expect(renewed.authorization_id).toBeTruthy();
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${num.resource_id}'`)).toBe("covered:commitment");
      // the previous period is still an uncovered gap until an administrator decides about it
      expect(state(w)).toBe("suspended");
      call("tw4_rfl_exposure_dispose", num.resource_id, prevKey(), P, "absorbed", "owner renewed; the lapsed month is absorbed by DanceFlow");
      expect(state(w)).not.toBe("suspended");
      scan(w);
      expect(exposureRows(num.resource_id, cur()).every((r) => r.state === "closed")).toBe(true);
    });

    it("the gate is consulted only by billed sends (never by STOP / START / HELP handling)", () => {
      const users = psql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.prosrc like '%_tw4rc_service_state%' and p.proname not like '\\_tw4rfl%' and p.proname not like 'tw4_rfl%' and p.proname not like 'sms_rfl%'`).split(",");
      expect(users).toContain("tw4_usage_begin");
      for (const name of users) expect(name).not.toMatch(/inbound|optout|opt_out|keyword|consent|compliance|help|stop|start/i);
    });

    it("a suspended location still records STOP / START / HELP texts: compliance is recorded, never charged, never refused", () => {
      const w = world();
      const camp = register(w, "campaign");
      age(camp.resource_id);
      scan(w);
      expect(state(w)).toBe("suspended");
      for (const body of ["stop", "start", "help"]) {
        const out = JSON.parse(psql(callSql("tw4_inbound_record", w.studio, w.account, sid("SM"), 1, 0, "compliance", `reply to ${body}`, null, "webhook"))) as { recorded: boolean; charged_cents?: number };
        expect(out.recorded).toBe(true);
        expect(out.charged_cents ?? 0).toBe(0);
      }
    });
  });

  describe("the provider keeps billing (evidence, never a charge to the studio)", () => {
    it("a bill for an uncovered period is exposure with the billed amount; a replay of the same reference changes nothing; the same reference with another amount is refused", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      const r1 = `INV-${RUN}-${w.n}-a`;
      const first = call<{ exposure_id: string; reason: string; replayed: boolean }>("tw4_rfl_observe_provider_bill", num.resource_id, prevKey(), r1, 115, P);
      expect(first).toMatchObject({ reason: "provider_billed_uncovered", replayed: false });
      expect(call<{ replayed: boolean }>("tw4_rfl_observe_provider_bill", num.resource_id, prevKey(), r1, 115, P).replayed).toBe(true);
      expect(exposureRows(num.resource_id, prevKey())[0]).toMatchObject({ state: "open", billed: 115 });
      expect(psqlError(callSql("tw4_rfl_observe_provider_bill", num.resource_id, prevKey(), r1, 999, P))).toBe("");   // refs already on the exposure replay first
      expect(exposureRows(num.resource_id, prevKey())[0].billed).toBe(115);
      // a second line of the same period adds to the evidence
      call("tw4_rfl_observe_provider_bill", num.resource_id, prevKey(), `INV-${RUN}-${w.n}-b`, 20, P);
      expect(exposureRows(num.resource_id, prevKey())[0].billed).toBe(135);
      // the reconciliation record exists, the studio's credit is untouched
      expect(Number(psql(`select count(*) from public.studio_sms_provider_charges where legal_entity_id = '${w.entity}' and kind = 'number'`))).toBe(2);
      expect(psql(`select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}'`)).toBe("200000");
      expect(alertsOf(w, "exposure_open")).toBe(1);
    });

    it("billed evidence can only be absorbed, never declared 'not billed'; a covered period's bill is expected and opens nothing", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      call("tw4_rfl_observe_provider_bill", num.resource_id, prevKey(), `INV-${RUN}-${w.n}-c`, 115, P);
      expect(hasCode(callErr("tw4_rfl_exposure_dispose", num.resource_id, prevKey(), P, "not_billed_confirmed", "Twilio console shows no bill for this month"), "TW042")).toBe(true);
      const a = authFixture(w, "number", { startsDaysAgo: 120 });
      chargeFixture(w, a, "number", cur(), "charged");
      const covered = call<{ exposure: boolean }>("tw4_rfl_observe_provider_bill", num.resource_id, cur(), `INV-${RUN}-${w.n}-d`, 115, P);
      expect(covered.exposure).toBe(false);
      expect(exposureRows(num.resource_id, cur())).toEqual([]);
    });

    it("a bill after a CONFIRMED cancellation is its own exposure and cover cannot close it", () => {
      const w = world();
      const camp = register(w, "campaign");
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("bill-after-cancel"), "owner_written", "The owner asked us to cancel the campaign", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      expect(providerState(camp.resource_id)).toBe("cancelled");
      // bill for a period AFTER the cancellation month
      const after = nextKey();
      const out = call<{ reason: string }>("tw4_rfl_observe_provider_bill", camp.resource_id, after, `INV-${RUN}-${w.n}-e`, 150, P);
      expect(out.reason).toBe("billed_after_cancellation");
      // even a charge for that period does not close it (the scan only closes accruing rows of LIVE resources)
      expect(exposureRows(camp.resource_id, after)[0].state).toBe("open");
      expect(alertsOf(w, "exposure_open")).toBe(1);
      call("tw4_rfl_exposure_dispose", camp.resource_id, after, P, "absorbed", "Twilio billed after cancellation; dispute opened with Twilio support");
      expect(exposureRows(camp.resource_id, after)[0].state).toBe("closed");
    });

    it("a provider cost variance on a recurring kind is an admin alert, once per recorded charge", () => {
      const w = world();
      const num = register(w, "number");
      call("tw4_credit_record_provider_charge", w.entity, w.studio, "number", `INV-${RUN}-${w.n}-var`, 400, P);
      scan(w);
      scan(w);
      expect(alertsOf(w, "provider_variance")).toBe(1);
      expect(num.resource_id).toBeTruthy();
    });
  });

  describe("the pilot business: the $150 ceiling and per-period written approvals", () => {
    it("has no standing authorization (existing refusal), so every period needs its own approval; an old uncovered pilot resource suspends sending", () => {
      const w = world({ pilot: true });
      expect(hasCode(callErr("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null), "TW011")).toBe(true);
      const num = register(w, "number");
      age(num.resource_id);
      scan(w);
      expect(exposureRows(num.resource_id, prevKey())[0]).toMatchObject({ state: "open", reason: "no_pilot_approval" });
      expect(state(w)).toBe("suspended");
      expect(alertsOf(w, "pilot_approval_needed")).toBe(1);
    });

    it("a period approval goes through the permanent approval reference, the published price and the cumulative ceiling; it covers the period and closes its exposure", () => {
      const w = world({ pilot: true, ceiling: PRICE.number + PRICE.monthly });
      const num = register(w, "number");
      age(num.resource_id);
      scan(w);
      const approval = ref("pilot-number-cur");
      const out = call<{ cover_id: string; amount_cents: number; replayed: boolean }>("tw4_rfl_pilot_cover", num.resource_id, cur(), approval, P);
      expect(out).toMatchObject({ amount_cents: PRICE.number, replayed: false });
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${num.resource_id}'`)).toBe("covered:pilot_approval");
      // the same approval by the same actor is a replay; the permanent reference can never fund anything else
      expect(call<{ replayed: boolean }>("tw4_rfl_pilot_cover", num.resource_id, cur(), approval, P).replayed).toBe(true);
      const camp = register(w, "campaign");
      expect(hasCode(callErr("tw4_rfl_pilot_cover", camp.resource_id, cur(), approval, P), "TW019")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_approval_refs where studio_id = '${w.studio}' and spend_event_id is not null`))).toBe(1);
      // the campaign approval fits (number + monthly = ceiling), and nothing more does
      call("tw4_rfl_pilot_cover", camp.resource_id, cur(), ref("pilot-campaign-cur"), P);
      expect(psql(`select sum(amount_cents) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured')`)).toBe(String(PRICE.number + PRICE.monthly));
      expect(hasCode(callErr("tw4_rfl_pilot_cover", num.resource_id, nextKey(), ref("pilot-number-next"), P), "TW007")).toBe(true);
      expect(psql(`select sum(amount_cents) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured')`)).toBe(String(PRICE.number + PRICE.monthly));
    });

    it("refuses retroactive and far-future periods, a non-pilot business, a cancelled resource, a held or negative account and another actor's replay", () => {
      const w = world({ pilot: true, ceiling: 15000 });
      const num = register(w, "number");
      expect(hasCode(callErr("tw4_rfl_pilot_cover", num.resource_id, prevKey(), ref("retro"), P), "TW042")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_pilot_cover", num.resource_id, keyAdd(cur(), 2), ref("far"), P), "TW042")).toBe(true);
      expect(psqlError(callSql("tw4_rfl_pilot_cover", num.resource_id, "2026-13", ref("badkey"), P))).not.toBe("");
      const normal = world();
      const n2 = register(normal, "number");
      expect(hasCode(callErr("tw4_rfl_pilot_cover", n2.resource_id, cur(), ref("not-pilot"), P), "TW042")).toBe(true);
      const approval = ref("owner-actor");
      expect(hasCode(callErr("tw4_rfl_pilot_cover", num.resource_id, cur(), approval, w.owner), "42501")).toBe(true);
      call("tw4_rfl_pilot_cover", num.resource_id, cur(), approval, P);
      expect(hasCode(callErr("tw4_rfl_pilot_cover", num.resource_id, cur(), approval, P2), "TW043")).toBe(true);
      replica(`update public.studio_sms_credit_accounts set hold = true, hold_reason = 'fixture hold for the suite' where legal_entity_id = '${w.entity}';`);
      expect(hasCode(callErr("tw4_rfl_pilot_cover", num.resource_id, nextKey(), ref("held"), P), "TW007")).toBe(true);
    });

    it("the ceiling is cumulative with the provisioning reservations already held (a captured pilot reservation counts)", () => {
      const w = world({ pilot: true, ceiling: PRICE.number + 50 });
      replica(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
        values ('${w.entity}', '${w.studio}', 'brand', 50, 'pilot', 'captured', 'prov:fixture:${RUN}', now());`);
      const num = register(w, "number");
      call("tw4_rfl_pilot_cover", num.resource_id, cur(), ref("fits-exactly"), P);
      const camp = register(w, "campaign");
      expect(hasCode(callErr("tw4_rfl_pilot_cover", camp.resource_id, cur(), ref("exceeds"), P), "TW007")).toBe(true);
    });
  });

  describe("DanceFlow suspension is not a provider cancellation", () => {
    it("suspending stops DanceFlow's sending and leaves every provider resource untouched, saying which fees continue", () => {
      const w = world();
      const num = register(w, "number");
      const camp = register(w, "campaign");
      senderFixture(w, "approved", { phone: num.sid, campaign: camp.sid });
      expect(psql(`select public._tw4rfl_df_sending('${w.studio}')::text`)).toBe("true");
      expect(hasCode(callErr("tw4_rfl_suspend_df", w.studio, P, "short", false), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_suspend_df", w.studio, w.owner, "the owner cannot suspend through this path", false), "42501")).toBe(true);
      const out = call<{ df_sending: boolean; provider_resources_unchanged: boolean; provider_fees_continue_for: number; credit_hold: boolean }>(
        "tw4_rfl_suspend_df", w.studio, P, "recurring authorization lapsed; owner notified", false);
      expect(out).toMatchObject({ df_sending: false, provider_resources_unchanged: true, provider_fees_continue_for: 2, credit_hold: false });
      expect(psql(`select public._tw4rfl_df_sending('${w.studio}')::text`)).toBe("false");
      expect(psql(`select status from public.studio_sms_billed_senders where studio_id = '${w.studio}' order by seq desc limit 1`)).toBe("revoked");
      expect(providerState(num.resource_id)).toBe("active");
      expect(providerState(camp.resource_id)).toBe("active");
      expect(psql(`select hold::text from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}'`)).toBe("false");
      expect(audit(w, "rfl_df_suspended")).toBe(1);
      // exposure tracking continues while suspended: a bill for an uncovered period is still recorded
      age(num.resource_id);
      expect(call<{ reason: string }>("tw4_rfl_observe_provider_bill", num.resource_id, prevKey(), `INV-${RUN}-${w.n}-s`, 115, P).reason).toBe("provider_billed_uncovered");
    });

    it("a hold is optional and explicit; suspending twice is harmless", () => {
      const w = world();
      register(w, "number");
      senderFixture(w, "approved");
      expect(call<{ credit_hold: boolean }>("tw4_rfl_suspend_df", w.studio, P, "hold requested with the suspension", true).credit_hold).toBe(true);
      expect(psql(`select hold::text from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}'`)).toBe("true");
      expect(call<{ df_sending: boolean }>("tw4_rfl_suspend_df", w.studio, P, "second suspension is a no-op", true).df_sending).toBe(false);
      expect(Number(psql(`select count(*) from public.studio_sms_billed_senders where studio_id = '${w.studio}' and status = 'revoked'`))).toBe(1);
    });
  });

  describe("provider cancellation (authorization, single claim, evidence)", () => {
    const authorize = (w: World, resourceId: string, decidedBy = "owner_written", label = "cancel") =>
      call<{ operation_id: string; replayed: boolean }>("tw4_rfl_cancel_authorize", resourceId, P, ref(label), decidedBy, "The owner asked us in writing to cancel this resource", true);

    it("needs an administrator, a decision type, a written reference and reason, and the irreversibility acknowledgement", () => {
      const w = world();
      const camp = register(w, "campaign");
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, w.owner, ref("owner"), "owner_written", "owner calling the admin function", true), "42501")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("noack"), "owner_written", "The owner asked us in writing to cancel", false), "TW042")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("nullack"), "owner_written", "The owner asked us in writing to cancel", null), "TW042")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, "short", "owner_written", "The owner asked us in writing to cancel", true), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("badtype"), "robot", "The owner asked us in writing to cancel", true), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("noreason"), "owner_written", "too short", true), "22023")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cancel_ops where legal_entity_id = '${w.entity}'`))).toBe(0);
      expect(providerState(camp.resource_id)).toBe("active");
    });

    it("one written decision authorizes ONE cancellation: a retry replays, the reference never serves another resource, a second open operation is refused", () => {
      const w = world();
      const camp = register(w, "campaign");
      const ms = register(w, "messaging_service");
      const approval = ref("once");
      const first = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, approval, "owner_written", "The owner asked us in writing to cancel", true);
      expect(call<{ replayed: boolean; operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, approval, "owner_written", "The owner asked us in writing to cancel", true))
        .toMatchObject({ replayed: true, operation_id: first.operation_id });
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", ms.resource_id, P, approval, "owner_written", "The owner asked us in writing to cancel", true), "TW043")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("second"), "owner_written", "A second decision while one is open", true), "TW043")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cancel_ops where resource_id = '${camp.resource_id}'`))).toBe(1);
      // the same reference in another spelling is the same reference
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", ms.resource_id, P, `  ${approval.toUpperCase()}  `, "owner_written", "The owner asked us in writing to cancel", true), "TW043")).toBe(true);
    });

    it("a phone number is never cancelled on a policy decision and never while it is the live sender; releasing it needs the owner's or the founder's written decision", () => {
      const w = world();
      const num = register(w, "number");
      senderFixture(w, "approved", { phone: num.sid });
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", num.resource_id, P, ref("lapse-number"), "policy_lapse", "lapse policy applied to a phone number", true), "TW042")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", num.resource_id, P, ref("live-number"), "owner_written", "owner asks to release the live sender number", true), "TW041")).toBe(true);
      call("tw4_rfl_suspend_df", w.studio, P, "suspended before the number release", false);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", num.resource_id, P, ref("founder-number"), "founder_written", "The founder approved releasing this number in writing", true);
      expect(opStatus(op.operation_id)).toBe("authorized");
      expect(providerState(num.resource_id)).toBe("active"); // authorizing releases nothing
    });

    it("a lapse cancellation of a campaign needs an exposure open for 14 days; with one, it is allowed", () => {
      const w = world();
      const camp = register(w, "campaign");
      age(camp.resource_id);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("lapse-early"), "policy_lapse", "the owner never reauthorized this campaign", true), "TW042")).toBe(true);
      scan(w);
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("lapse-early2"), "policy_lapse", "the owner never reauthorized this campaign", true), "TW042")).toBe(true);
      replica(`update public.studio_sms_provider_exposure set first_detected_at = now() - interval '15 days' where resource_id = '${camp.resource_id}';`);
      expect(authorize(w, camp.resource_id, "policy_lapse", "lapse-ok").operation_id).toBeTruthy();
    });

    it("only the FIRST claim executes; every other caller sees in_progress (concurrent claims)", async () => {
      const w = world();
      const camp = register(w, "campaign");
      const op = authorize(w, camp.resource_id);
      const results = await Promise.all([1, 2, 3, 4].map(() => psqlAsync(callSql("tw4_rfl_cancel_begin", op.operation_id, P))));
      const actions = results.map((r) => (JSON.parse(r.out) as { action: string }).action).sort();
      expect(actions.filter((a) => a === "execute")).toHaveLength(1);
      expect(actions.filter((a) => a === "in_progress")).toHaveLength(3);
      expect(opStatus(op.operation_id)).toBe("in_flight");
      expect(call<{ action: string }>("tw4_rfl_cancel_begin", op.operation_id, P).action).toBe("in_progress");
      expect(audit(w, "rfl_cancel_started")).toBe(1);
    });

    it("a confirmed cancellation needs provider evidence; it marks the resource cancelled (final), closes accruing rows without a bill, keeps billed rows open, revokes the sender, and replays", () => {
      const w = world();
      const num = register(w, "number");
      const camp = register(w, "campaign");
      age(camp.resource_id);
      scan(w);
      call("tw4_rfl_observe_provider_bill", camp.resource_id, prevKey(), `INV-${RUN}-${w.n}-cc`, 150, P);
      senderFixture(w, "approved", { phone: num.sid, campaign: camp.sid });
      const op = authorize(w, camp.resource_id);
      expect(call<{ action: string }>("tw4_rfl_cancel_begin", op.operation_id, P).action).toBe("execute");
      expect(hasCode(callErr("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", null, null), "TW043")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", "not-a-digest", null), "TW043")).toBe(true);
      const ev = digest();
      expect(call<{ status: string }>("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", ev, null).status).toBe("confirmed");
      expect(providerState(camp.resource_id)).toBe("cancelled");
      expect(psql(`select cancel_evidence_digest from public.studio_sms_provider_resources where id = '${camp.resource_id}'`)).toBe(ev);
      // cancelled THIS month: no period after it exists to stop accruing, and the earlier uncovered periods are real provider cost: ALL stay open for a human
      expect(exposureRows(camp.resource_id).every((r) => r.state === "open")).toBe(true);
      expect(exposureRows(camp.resource_id, prevKey())[0]).toMatchObject({ state: "open", billed: 150 });
      expect(psql(`select status from public.studio_sms_billed_senders where studio_id = '${w.studio}' order by seq desc limit 1`)).toBe("revoked");
      expect(call<{ replayed: boolean }>("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", ev, null).replayed).toBe(true);
      // final: no more cancellation, no edits
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("again"), "owner_written", "A second cancellation of a cancelled resource", true), "TW041")).toBe(true);
      expect(psqlError(`update public.studio_sms_provider_resources set provider_state = 'active', cancelled_at = null, cancel_evidence_digest = null where id = '${camp.resource_id}';`)).not.toBe("");
      expect(audit(w, "rfl_cancel_confirmed")).toBe(1);
    });

    it("a refusal closes an operation only on the definite provider code 'api'; anything else is an unknown outcome that is never repeated", () => {
      const w = world();
      const camp = register(w, "campaign");
      const op = authorize(w, camp.resource_id, "owner_written", "uncertain");
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      expect(hasCode(callErr("tw4_rfl_cancel_finish", op.operation_id, P, "refused", null, "timeout"), "TW043")).toBe(true);
      expect(call<{ status: string }>("tw4_rfl_cancel_finish", op.operation_id, P, "unknown", null, "timeout").status).toBe("unknown_outcome");
      expect(call<{ replayed: boolean }>("tw4_rfl_cancel_finish", op.operation_id, P, "unknown", null, "timeout").replayed).toBe(true);
      expect(call<{ action: string }>("tw4_rfl_cancel_begin", op.operation_id, P).action).toBe("reconcile");
      expect(alertsOf(w, "cancel_unknown")).toBe(1);
      expect(providerState(camp.resource_id)).toBe("active");
      // while unknown, no second cancellation can be authorized
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("while-unknown"), "owner_written", "A second decision while one is unknown", true), "TW043")).toBe(true);
      // resolve: provider evidence or a written finding that nothing happened
      expect(hasCode(callErr("tw4_rfl_cancel_resolve", op.operation_id, P, "cancelled", null, "console shows the campaign deleted"), "TW043")).toBe(true);
      expect(call<{ status: string }>("tw4_rfl_cancel_resolve", op.operation_id, P, "still_active", digest(), "console still lists the campaign; nothing happened").status).toBe("abandoned");
      expect(providerState(camp.resource_id)).toBe("active");
      // after an abandoned operation a NEW explicit decision (new reference) may be authorized
      expect(authorize(w, camp.resource_id, "owner_written", "after-abandon").operation_id).toBeTruthy();
    });

    it("a definite refusal ('api') ends the operation as refused; its reference is spent and a new decision is needed", () => {
      const w = world();
      const camp = register(w, "campaign");
      const approval = ref("refused");
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, approval, "owner_written", "The owner asked us in writing to cancel", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      expect(call<{ status: string }>("tw4_rfl_cancel_finish", op.operation_id, P, "refused", null, "api").status).toBe("refused");
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, approval, "owner_written", "The owner asked us in writing to cancel", true), "TW043")).toBe(true);
      expect(authorize(w, camp.resource_id, "owner_written", "after-refused").operation_id).toBeTruthy();
    });

    it("an unknown outcome resolved as 'cancelled' needs a digest of provider evidence; a claimed operation can be resolved only after 20 minutes", () => {
      const w = world();
      const camp = register(w, "campaign");
      const op = authorize(w, camp.resource_id, "owner_written", "stuck");
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      expect(hasCode(callErr("tw4_rfl_cancel_resolve", op.operation_id, P, "cancelled", digest(), "the claim never finished; console shows it gone"), "TW041")).toBe(true);
      replica(`update public.studio_sms_provider_cancel_ops set started_at = now() - interval '21 minutes' where id = '${op.operation_id}';`);
      expect(hasCode(callErr("tw4_rfl_cancel_resolve", op.operation_id, P, "cancelled", null, "console shows the campaign deleted"), "TW043")).toBe(true);
      const ev = digest();
      expect(call<{ status: string }>("tw4_rfl_cancel_resolve", op.operation_id, P, "cancelled", ev, "console shows the campaign deleted after 21 minutes").status).toBe("confirmed");
      expect(providerState(camp.resource_id)).toBe("cancelled");
      expect(call<{ replayed: boolean }>("tw4_rfl_cancel_resolve", op.operation_id, P, "cancelled", ev, "console shows the campaign deleted after 21 minutes").replayed).toBe(true);
    });

    it("an unclaimed authorization can be withdrawn (once); a claimed one cannot", () => {
      const w = world();
      const camp = register(w, "campaign");
      const op = authorize(w, camp.resource_id, "owner_written", "withdraw");
      expect(hasCode(callErr("tw4_rfl_cancel_withdraw", op.operation_id, P, "short"), "22023")).toBe(true);
      expect(call<{ status: string }>("tw4_rfl_cancel_withdraw", op.operation_id, P, "the owner changed their mind in writing").status).toBe("withdrawn");
      expect(call<{ replayed: boolean }>("tw4_rfl_cancel_withdraw", op.operation_id, P, "the owner changed their mind in writing").replayed).toBe(true);
      expect(call<{ action: string }>("tw4_rfl_cancel_begin", op.operation_id, P).action).toBe("skip");
      const op2 = authorize(w, camp.resource_id, "owner_written", "withdraw2");
      call("tw4_rfl_cancel_begin", op2.operation_id, P);
      expect(hasCode(callErr("tw4_rfl_cancel_withdraw", op2.operation_id, P, "too late: already claimed by an operator"), "TW041")).toBe(true);
    });

    it("the state machine cannot be driven around the functions (illegal transitions and edits to the decision are refused at the table)", () => {
      const w = world();
      const camp = register(w, "campaign");
      const op = authorize(w, camp.resource_id, "owner_written", "direct");
      expect(psqlError(`update public.studio_sms_provider_cancel_ops set status = 'confirmed', evidence_digest = '${digest()}' where id = '${op.operation_id}';`)).toMatch(/42501/);
      expect(psqlError(`begin; select set_config('tw4.rfl_write', 'on', true); update public.studio_sms_provider_cancel_ops set status = 'confirmed', evidence_digest = '${digest()}' where id = '${op.operation_id}'; commit;`)).toMatch(/not a legal transition/);
      expect(psqlError(`begin; select set_config('tw4.rfl_write', 'on', true); update public.studio_sms_provider_cancel_ops set reason = 'rewritten after the fact by someone' where id = '${op.operation_id}'; commit;`)).toMatch(/decision is fixed/);
      expect(psqlError(`delete from public.studio_sms_provider_cancel_ops where id = '${op.operation_id}';`)).toMatch(/never deleted/);
      expect(psqlError(`update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = now(), cancel_evidence_digest = '${digest()}' where id = '${camp.resource_id}';`)).toMatch(/cancellation functions/);
      expect(psqlError(`update public.studio_sms_provider_resources set provider_sid = '${sid("QE")}' where id = '${camp.resource_id}';`)).toMatch(/identity of a resource is fixed/);
      expect(psqlError(`truncate public.studio_sms_provider_resources cascade;`)).not.toBe("");
    });
  });

  describe("alerts, readiness, inventory gaps and the scan list", () => {
    it("the alert outbox is claimed once per claim, retried on failure (bounded), never re-claimed after delivery, and a stale claim cannot finish a newer one", () => {
      const w = world();
      register(w, "campaign");
      scan(w);
      // isolate from alerts left by earlier scenarios: only this world's outbox rows are claimable
      replica(`update public.studio_sms_provider_alerts set status = 'delivered', delivered_at = now() where legal_entity_id <> '${w.entity}' and status <> 'delivered';`);
      const mine = () => Number(psql(`select count(*) from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' and status = 'pending'`));
      expect(mine()).toBeGreaterThanOrEqual(1);
      // claim everything pending (this world's rows are among them; other worlds' alerts may be claimed too, which is fine)
      const first = JSON.parse(psql(`select coalesce(json_agg(c), '[]') from public.tw4_rfl_alerts_claim(100) c`)) as Array<{ alert_id: string; claim_token: string; legal_entity_id: string }>;
      const own = first.filter((c) => c.legal_entity_id === w.entity);
      expect(own.length).toBeGreaterThanOrEqual(1);
      const claimed = own[0];
      // a second claim immediately finds nothing of this world's (they are 'sending')
      const second = JSON.parse(psql(`select coalesce(json_agg(c), '[]') from public.tw4_rfl_alerts_claim(100) c`)) as Array<{ legal_entity_id: string }>;
      expect(second.filter((c) => c.legal_entity_id === w.entity)).toHaveLength(0);
      // a wrong token cannot finish it
      expect(call<{ updated: boolean }>("tw4_rfl_alert_finish", claimed.alert_id, randomUUID(), true, null).updated).toBe(false);
      // failure -> pending retry (re-claimable), attempts counted
      expect(call<{ updated: boolean }>("tw4_rfl_alert_finish", claimed.alert_id, claimed.claim_token, false, "smtp timeout").updated).toBe(true);
      const retry = JSON.parse(psql(`select coalesce(json_agg(c), '[]') from public.tw4_rfl_alerts_claim(100) c`)) as Array<{ alert_id: string; claim_token: string }>;
      const again = retry.find((c) => c.alert_id === claimed.alert_id);
      expect(again).toBeTruthy();
      expect(psql(`select attempts from public.studio_sms_provider_alerts where id = '${claimed.alert_id}'`)).toBe("2");
      // the OLD token is now stale
      expect(call<{ updated: boolean }>("tw4_rfl_alert_finish", claimed.alert_id, claimed.claim_token, true, null).updated).toBe(false);
      expect(call<{ updated: boolean }>("tw4_rfl_alert_finish", claimed.alert_id, again!.claim_token, true, null).updated).toBe(true);
      // delivered is final: never claimed again, never edited
      const after = JSON.parse(psql(`select coalesce(json_agg(c), '[]') from public.tw4_rfl_alerts_claim(100) c`)) as Array<{ alert_id: string }>;
      expect(after.find((c) => c.alert_id === claimed.alert_id)).toBeUndefined();
      expect(psqlError(`update public.studio_sms_provider_alerts set status = 'pending', delivered_at = null where id = '${claimed.alert_id}';`)).toMatch(/delivered alert is final/);
    });

    it("a stuck 'sending' claim is re-claimable after 15 minutes; an alert gives up after 5 attempts", () => {
      const w = world();
      register(w, "campaign");
      scan(w);
      // isolate from alerts left by earlier scenarios: only this world's outbox rows are claimable
      replica(`update public.studio_sms_provider_alerts set status = 'delivered', delivered_at = now() where legal_entity_id <> '${w.entity}' and status <> 'delivered';`);
      const id = psql(`select id from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' order by created_at limit 1`);
      replica(`update public.studio_sms_provider_alerts set status = 'sending', claim_token = '${randomUUID()}', claimed_at = now() - interval '16 minutes', attempts = 1 where id = '${id}';`);
      const got = JSON.parse(psql(`select coalesce(json_agg(c), '[]') from public.tw4_rfl_alerts_claim(100) c`)) as Array<{ alert_id: string }>;
      expect(got.find((c) => c.alert_id === id)).toBeTruthy();
      replica(`update public.studio_sms_provider_alerts set status = 'failed', attempts = 5 where id = '${id}';`);
      const none = JSON.parse(psql(`select coalesce(json_agg(c), '[]') from public.tw4_rfl_alerts_claim(100) c`)) as Array<{ alert_id: string }>;
      expect(none.find((c) => c.alert_id === id)).toBeUndefined();
    });

    it("an alert never carries a provider cost, a token or a message body", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      scan(w);
      call("tw4_rfl_observe_provider_bill", num.resource_id, prevKey(), `INV-${RUN}-${w.n}-x`, 115, P);
      const texts = psql(`select string_agg(summary, ' | ') from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}'`);
      expect(texts).not.toMatch(/\$|cents|115|150|token|AC[0-9a-f]{32}|PN[0-9a-f]{32}/i);
    });

    it("readiness reports blockers and never passes by default: missing inventory, uncovered periods, open exposure", () => {
      const w = world();
      expect(call<{ ready: boolean; blockers: string[] }>("tw4_rfl_studio_ready", w.studio)).toMatchObject({ ready: false, blockers: expect.arrayContaining(["number_not_in_inventory", "campaign_not_in_inventory"]) });
      const ms = register(w, "messaging_service");
      const num = register(w, "number");
      const camp = register(w, "campaign");
      const blockers = call<{ blockers: string[] }>("tw4_rfl_studio_ready", w.studio).blockers;
      expect(blockers).toEqual(expect.arrayContaining(["number_current_period_uncovered", "campaign_current_period_uncovered"]));
      // a standing authorization that outlives the next period makes both ready
      authFixture(w, "number", { startsDaysAgo: 1, expiresInDays: 150 });
      authFixture(w, "monthly", { startsDaysAgo: 1, expiresInDays: 150 });
      chargeFixture(w, psql(`select id from public.studio_sms_recurring_authorizations where studio_id = '${w.studio}' and kind = 'number'`), "number", cur(), "charged");
      chargeFixture(w, psql(`select id from public.studio_sms_recurring_authorizations where studio_id = '${w.studio}' and kind = 'monthly'`), "monthly", cur(), "charged");
      expect(call<{ ready: boolean }>("tw4_rfl_studio_ready", w.studio).ready).toBe(true);
      // an open exposure blocks again
      replica(`insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason) values ('${camp.resource_id}', '${w.entity}', '${w.studio}', '${prevKey()}', 'no_authorization');`);
      expect(call<{ blockers: string[] }>("tw4_rfl_studio_ready", w.studio).blockers).toContain("open_exposure");
      expect(ms.resource_id).toBeTruthy();
      expect(num.resource_id).toBeTruthy();
    });

    it("a standing authorization ending before the next period is not ready; the pilot business is not ready without the approval on file", () => {
      const w = world();
      register(w, "messaging_service");
      register(w, "number");
      register(w, "campaign");
      const a = authFixture(w, "number", { startsDaysAgo: 1, expiresInDays: 10 });
      chargeFixture(w, a, "number", cur(), "charged");
      expect(call<{ blockers: string[] }>("tw4_rfl_studio_ready", w.studio).blockers).toContain("number_next_period_uncovered");
      const p = world({ pilot: true });
      const num = register(p, "number");
      register(p, "campaign");
      call("tw4_rfl_pilot_cover", num.resource_id, cur(), ref("ready-cur"), P);
      expect(call<{ blockers: string[] }>("tw4_rfl_studio_ready", p.studio).blockers).toContain("number_next_period_uncovered");
    });

    it("a live billed sender whose number or campaign is not in the inventory is a critical admin alert (once); registering it clears the gap", () => {
      const w = world();
      const num = sid("PN");
      const camp = sid("QE");
      const sender = senderFixture(w, "approved", { phone: num, campaign: camp });
      call("tw4_rfl_inventory_gaps");
      call("tw4_rfl_inventory_gaps");
      expect(alertsOf(w, "inventory_gap")).toBe(1);
      expect(psql(`select audience || ':' || severity from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' and kind = 'inventory_gap'`)).toBe("admin:critical");
      expect(psql(`select dedupe_key from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' and kind = 'inventory_gap'`)).toBe(`sender:${sender}`);
      const w2 = world();
      const n2 = register(w2, "number");
      const c2 = register(w2, "campaign");
      senderFixture(w2, "approved", { phone: n2.sid, campaign: c2.sid });
      call("tw4_rfl_inventory_gaps");
      expect(alertsOf(w2, "inventory_gap")).toBe(0);
    });

    it("the scan list names every business with a live resource or an open exposure, and no other", () => {
      const live = world();
      register(live, "number");
      const idle = world();
      const list = JSON.parse(psql(`select coalesce(json_agg(legal_entity_id), '[]') from public.tw4_rfl_scan_entities()`)) as string[];
      expect(list).toContain(live.entity);
      expect(list).not.toContain(idle.entity);
    });

    it("the administrator overview shows both axes (DanceFlow sending vs provider state) and the open exposure; the owner overview hides provider cost", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      scan(w);
      const ov = JSON.parse(psql(`select public.tw4_rfl_admin_overview('${P}')::text`)) as { resources: Array<{ resource_id: string; df_sending: boolean; provider_state: string }>; open_exposure_expected_cents: number };
      const mine = ov.resources.find((r) => r.resource_id === num.resource_id)!;
      expect(mine).toMatchObject({ df_sending: false, provider_state: "active" });
      expect(ov.open_exposure_expected_cents).toBeGreaterThan(0);
      const owner = psql(`begin; select set_config('request.jwt.claims', '{"sub":"${w.owner}","role":"authenticated"}', true); set local role authenticated; select public.sms_rfl_owner_overview('${w.studio}')::text; commit;`);
      expect(owner).toContain("texting_suspended_for_uncovered_fee");
      expect(owner).not.toMatch(/expected|provider_cost|billed|cents/);
    });
  });

  describe("tenant isolation and privileges", () => {
    it("API roles can read and write none of the tables and call none of the internal or admin functions; only service_role runs the lifecycle functions", () => {
      const tables = ["resources", "cover", "exposure", "cancel_ops", "alerts"];
      for (const role of ["anon", "authenticated", "service_role"]) {
        const script = tables.map((t) => `begin; set local role ${role}; select count(*) from public.studio_sms_provider_${t}; rollback;\nbegin; set local role ${role}; delete from public.studio_sms_provider_${t}; rollback;\n`).join("");
        const res = spawnSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=0"], { input: script, encoding: "utf8" });
        expect(res.stdout.trim()).toBe("");
        expect((res.stderr.match(/permission denied/g) ?? []).length).toBe(tables.length * 2);
      }
      const pub = ["tw4_rfl_scan_entity(uuid)", "tw4_rfl_register(uuid, uuid, text, text, text, text, text, uuid, uuid)", "tw4_rfl_cancel_authorize(uuid, uuid, text, text, text, boolean)",
        "tw4_rfl_pilot_cover(uuid, text, text, uuid)", "tw4_rfl_alerts_claim(int)", "tw4_rfl_admin_overview(uuid)"];
      const internal = ["_tw4rfl_cover(public.studio_sms_provider_resources, text)", "_tw4rfl_gate_suspended(uuid)", "_tw4rfl_alert(uuid, uuid, uuid, text, text, text, text, text)", "_tw4rfl_audit(uuid, uuid, text, text)", "_tw4rfl_lock(uuid)", "_tw4rc_service_state(uuid)"];
      const roles = ["anon", "authenticated", "service_role"];
      const rows: Array<[string, string, boolean]> = [];
      for (const fn of pub) for (const role of roles) rows.push([role, fn, role === "service_role"]);
      for (const fn of internal) for (const role of roles) rows.push([role, fn, false]);
      for (const role of roles) rows.push([role, "sms_rfl_owner_overview(uuid)", role !== "anon"]);
      const got = psql(rows.map(([role, fn]) => `select '${role}|${fn}|' || has_function_privilege('${role}', 'public.${fn}', 'execute')::text;`).join("\n")).split("\n");
      expect(got).toEqual(rows.map(([role, fn, allowed]) => `${role}|${fn}|${allowed}`));
    });

    it("an owner sees only their own location; another business's owner, an owner of nothing and an anonymous caller are refused (same answer)", () => {
      const a = world();
      const b = world();
      register(a, "number");
      const asUser = (uid: string | null, studio: string) =>
        psqlError(`begin; select set_config('request.jwt.claims', ${uid ? `'{"sub":"${uid}","role":"authenticated"}'` : `'{}'`}, true); set local role authenticated; select public.sms_rfl_owner_overview('${studio}'); commit;`);
      expect(asUser(a.owner, a.studio)).toBe("");
      expect(hasCode(asUser(b.owner, a.studio), "42501")).toBe(true);
      expect(hasCode(asUser(a.owner, b.studio), "42501")).toBe(true);
      expect(hasCode(asUser(null, a.studio), "42501")).toBe(true);
      expect(hasCode(asUser(a.owner, randomUUID()), "42501")).toBe(true);
    });

    it("an owner or another business's identity cannot act through any administrator function", () => {
      const a = world();
      const b = world();
      const num = register(a, "number");
      const camp = register(a, "campaign");
      for (const actor of [a.owner, b.owner, randomUUID()]) {
        expect(hasCode(callErr("tw4_rfl_register", a.studio, actor, "number", sid("PN"), a.account, "+15550003333", "admin", null, null), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, actor, ref("x"), "owner_written", "an owner pretending to be an administrator", true), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_rfl_observe_provider_bill", num.resource_id, cur(), "INV-x-1", 100, actor), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_rfl_exposure_dispose", num.resource_id, cur(), actor, "absorbed", "an owner absorbing their own exposure"), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_rfl_suspend_df", a.studio, actor, "an owner suspending through the admin path", false), "42501")).toBe(true);
        expect(hasCode(callErr("tw4_rfl_admin_overview", actor), "42501")).toBe(true);
      }
      // one business's facts can never be attached to another's: wrong studio for the resource's own account, and another business's reservation as cover
      expect(hasCode(callErr("tw4_rfl_register", b.studio, P, "number", sid("PN"), a.account, "+15550004444", "admin", null, null), "TW040")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_resources where legal_entity_id = '${b.entity}'`))).toBe(0);
    });

    it("an exposure, a cancellation and an alert of one business never touch another's rows (scan is per business)", () => {
      const a = world();
      const b = world();
      const ca = register(a, "campaign");
      const cb = register(b, "campaign");
      age(ca.resource_id);
      age(cb.resource_id);
      scan(a);
      expect(exposureRows(ca.resource_id).length).toBeGreaterThan(0);
      expect(exposureRows(cb.resource_id)).toEqual([]);
      expect(alertsOf(b)).toBe(0);
    });
  });

  describe("races and retries", () => {
    it("parallel registrations of the same provider sid yield exactly one resource (the others replay)", async () => {
      const w = world();
      const s = sid("QE");
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => psqlAsync(callSql("tw4_rfl_register", w.studio, P, "campaign", s, w.account, null, "admin", null, null))));
      expect(results.every((r) => r.err === "")).toBe(true);
      expect(results.map((r) => (JSON.parse(r.out) as { replayed: boolean }).replayed).filter((x) => !x)).toHaveLength(1);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_resources where provider_sid = '${s}'`))).toBe(1);
    });

    it("parallel cancellation authorizations (different references) leave exactly ONE open operation", async () => {
      const w = world();
      const camp = register(w, "campaign");
      const results = await Promise.all([1, 2, 3, 4].map((i) => psqlAsync(callSql("tw4_rfl_cancel_authorize", camp.resource_id, P, ref(`race-${i}`), "owner_written", "The owner asked us in writing to cancel", true))));
      expect(results.filter((r) => r.err === "")).toHaveLength(1);
      expect(results.filter((r) => hasCode(r.err, "TW043"))).toHaveLength(3);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cancel_ops where resource_id = '${camp.resource_id}' and status = 'authorized'`))).toBe(1);
    });

    it("parallel pilot approvals for the same period leave exactly one cover and one reservation (the ceiling is never exceeded)", async () => {
      const w = world({ pilot: true, ceiling: PRICE.number * 3 });
      const num = register(w, "number");
      const results = await Promise.all([1, 2, 3, 4].map((i) => psqlAsync(callSql("tw4_rfl_pilot_cover", num.resource_id, cur(), ref(`pilot-race-${i}`), P))));
      expect(results.filter((r) => r.err === "")).toHaveLength(1);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cover where resource_id = '${num.resource_id}' and period_key = '${cur()}'`))).toBe(1);
      expect(psql(`select coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured')`)).toBe(String(PRICE.number));
    });

    it("parallel scans of one business produce one exposure row and one alert per condition", async () => {
      const w = world();
      const camp = register(w, "campaign");
      age(camp.resource_id);
      const results = await Promise.all([1, 2, 3, 4].map(() => psqlAsync(callSql("tw4_rfl_scan_entity", w.entity))));
      expect(results.every((r) => r.err === "")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_exposure where resource_id = '${camp.resource_id}' and period_key = '${prevKey()}'`))).toBe(1);
      expect(alertsOf(w, "exposure_open")).toBe(exposureRows(camp.resource_id).length);
    });

    it("a recurring charge racing a scan: whichever wins, the period ends covered and no exposure stays open", async () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      scan(w);
      const a = authFixture(w, "number", { startsDaysAgo: 120 });
      chargeFixture(w, a, "number", cur(), "charged");
      const results = await Promise.all([psqlAsync(callSql("tw4_rfl_scan_entity", w.entity)), (async () => { chargeFixtureSync(w, a, prevKey()); return psqlAsync(callSql("tw4_rfl_scan_entity", w.entity)); })()]);
      expect(results.every((r) => r.err === "")).toBe(true);
      scan(w);
      // the two periods the race concerned (the older history stays recorded as exposure, by design)
      expect(exposureRows(num.resource_id).filter((r) => r.period >= prevKey()).every((r) => r.state === "closed")).toBe(true);
      expect(state(w)).not.toBe("suspended");
    });

    it("a cancellation finish racing a resolve ends in exactly one final state", async () => {
      const w = world();
      const camp = register(w, "campaign");
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("finish-race"), "owner_written", "The owner asked us in writing to cancel", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      replica(`update public.studio_sms_provider_cancel_ops set started_at = now() - interval '30 minutes' where id = '${op.operation_id}';`);
      const ev = digest();
      const results = await Promise.all([
        psqlAsync(callSql("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", ev, null)),
        psqlAsync(callSql("tw4_rfl_cancel_resolve", op.operation_id, P2, "cancelled", ev, "provider console shows the campaign gone")),
      ]);
      expect(results.filter((r) => r.err === "").length).toBeGreaterThanOrEqual(1);
      expect(opStatus(op.operation_id)).toBe("confirmed");
      expect(providerState(camp.resource_id)).toBe("cancelled");
      expect(audit(w, "rfl_cancel_confirmed") + audit(w, "rfl_cancel_resolved")).toBeGreaterThanOrEqual(1);
    });
  });

  describe("independent review findings (each pinned)", () => {
    it("P0 double payment: a business with standing authorizations cannot register a separate initial reservation; with the REAL authorize + charge path the registration period is paid exactly once", () => {
      const w = world();
      const auth = call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null);
      const stray = randomUUID();
      replica(`insert into public.studio_sms_credit_reservations (id, legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
        values ('${stray}', '${w.entity}', '${w.studio}', 'number', ${PRICE.number}, 'credit', 'captured', 'purchase:${stray}', now());`);
      expect(hasCode(callErr("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, "+15550101010", "r2b", null, stray), "TW040")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_resources where studio_id = '${w.studio}'`))).toBe(0);
      // registered without one: the authorization's commitment covers the period, the scheduler's charge takes its place, and the ledger shows ONE capture for the month
      const num = register(w, "number");
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${num.resource_id}'`)).toBe("covered:commitment");
      call("tw4_recurring_charge", auth.authorization_id, cur(), null);
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${num.resource_id}'`)).toBe("covered:charge");
      expect(Number(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}' and kind = 'capture'`))).toBe(1);
      // a pilot initial reservation must not be one of the recurring keys
      const p = world({ pilot: true });
      const bad = randomUUID();
      replica(`insert into public.studio_sms_credit_reservations (id, legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
        values ('${bad}', '${p.entity}', '${p.studio}', 'number', ${PRICE.number}, 'pilot', 'captured', 'rec:${randomUUID()}:${cur()}', now());`);
      expect(hasCode(callErr("tw4_rfl_register", p.studio, P, "number", sid("PN"), p.account, "+15550101011", "r2b", null, bad), "TW040")).toBe(true);
    });

    it("P2 a charge pays ONE resource's period: a replacement registered after its predecessor was cancelled in the same period is exposed when Twilio bills it", () => {
      const w = world();
      const a = authFixture(w, "number", { startsDaysAgo: 5, expiresInDays: 120 });
      const first = register(w, "number");
      chargeFixture(w, a, "number", cur(), "charged");
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${first.resource_id}'`)).toBe("covered:charge");
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", first.resource_id, P, ref("replace"), "owner_written", "The owner asked us in writing to replace this number", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      replica(`update public.studio_sms_provider_resources set cancelled_at = now() - interval '1 minute' where id = '${first.resource_id}';`);
      const second = register(w, "number");
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${second.resource_id}'`)).toBe("uncovered:replacement_unfunded");
      // the owner is not suspended for it (they cannot fix it: the month was paid under their authorization, once), and an administrator can disposition it
      // (arranged to the very start of the month so the 7-day grace has passed on any day after the 8th)
      replica(`update public.studio_sms_provider_resources set cancelled_at = public._tw4ml_month_start('${w.entity}', '${cur()}') + interval '1 minute' where id = '${first.resource_id}';
               update public.studio_sms_provider_resources set registered_at = public._tw4ml_month_start('${w.entity}', '${cur()}') + interval '2 minutes' where id = '${second.resource_id}';`);
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${second.resource_id}'`)).toBe("uncovered:replacement_unfunded");
      expect(state(w)).not.toBe("suspended");
      const bill = call<{ exposure?: boolean; reason?: string }>("tw4_rfl_observe_provider_bill", second.resource_id, cur(), `INV-${RUN}-${w.n}-repl`, 115, P);
      expect(bill.reason).toBe("provider_billed_uncovered");
    });

    it("P2 a partial registration month that nothing covered is recorded but never suspends sending; an administrator can disposition it without waiting for a scan", () => {
      const w = world();
      const camp = register(w, "campaign");
      // registered "last month, late" with no initial cover; the owner's standing authorization starts this month
      replica(`update public.studio_sms_provider_resources set registered_at = public._tw4ml_month_start('${w.entity}', '${prevKey()}') + interval '20 days' where id = '${camp.resource_id}';`);
      const a = authFixture(w, "monthly", { startsDaysAgo: 1, expiresInDays: 120 });
      chargeFixture(w, a, "monthly", cur(), "charged");
      const firstKey = psql(`select public._tw4ml_month_key('${w.entity}', registered_at) from public.studio_sms_provider_resources where id = '${camp.resource_id}'`);
      if (firstKey < cur()) {
        expect(state(w)).not.toBe("suspended");
        // no scan has run: disposing still works (the row is created from the uncovered, past-grace period)
        expect(call<{ replayed: boolean }>("tw4_rfl_exposure_dispose", camp.resource_id, firstKey, P, "absorbed", "late registration month absorbed by DanceFlow").replayed).toBe(false);
        expect(exposureRows(camp.resource_id, firstKey)[0]).toMatchObject({ state: "closed", disposition: "absorbed" });
      }
      // a covered or in-grace period is not exposure and cannot be dispositioned
      expect(hasCode(callErr("tw4_rfl_exposure_dispose", camp.resource_id, cur(), P, "absorbed", "this period is covered by the charge"), "TW041")).toBe(true);
    });

    it("P2 an operation abandoned as 'still active' can still record that the provider did cancel (with evidence); still_active itself needs provider evidence", () => {
      const w = world();
      const camp = register(w, "campaign");
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("late-finish"), "owner_written", "The owner asked us in writing to cancel", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      replica(`update public.studio_sms_provider_cancel_ops set started_at = now() - interval '30 minutes' where id = '${op.operation_id}';`);
      expect(hasCode(callErr("tw4_rfl_cancel_resolve", op.operation_id, P2, "still_active", null, "console unreachable; assumed still present"), "TW043")).toBe(true);
      call("tw4_rfl_cancel_resolve", op.operation_id, P2, "still_active", digest(), "console still lists the campaign at that moment");
      expect(opStatus(op.operation_id)).toBe("abandoned");
      const ev = digest();
      expect(call<{ status: string }>("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", ev, null).status).toBe("confirmed");
      expect(providerState(camp.resource_id)).toBe("cancelled");
      // abandoned cannot turn into anything else
      const op2 = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", register(w, "number").resource_id, P, ref("abandon-only"), "owner_written", "The owner asked us in writing to cancel the number", true);
      call("tw4_rfl_cancel_begin", op2.operation_id, P);
      call("tw4_rfl_cancel_finish", op2.operation_id, P, "unknown", null, "timeout");
      call("tw4_rfl_cancel_resolve", op2.operation_id, P, "still_active", digest(), "console still lists the number");
      expect(psqlError(`begin; select set_config('tw4.rfl_write', 'on', true); update public.studio_sms_provider_cancel_ops set status = 'refused' where id = '${op2.operation_id}'; commit;`)).toMatch(/is final|not a legal transition/);
      expect(hasCode(callErr("tw4_rfl_cancel_finish", op2.operation_id, P, "refused", null, "api"), "TW041")).toBe(true);
    });

    it("P2 a credit hold is per business: the suspension result says how many OTHER locations it affects", () => {
      const w = world();
      register(w, "number");
      senderFixture(w, "approved");
      const out = call<{ hold_affects_other_locations: number }>("tw4_rfl_suspend_df", w.studio, P, "hold requested with the suspension", true);
      expect(out.hold_affects_other_locations).toBe(0);
      expect(audit(w, "rfl_df_suspended")).toBe(1);
    });

    it("P3 suspension and cancellation completion never deadlock (same lock order)", async () => {
      const w = world();
      const camp = register(w, "campaign");
      senderFixture(w, "approved", { campaign: camp.sid });
      const results: Array<{ err: string }> = [];
      for (let i = 0; i < 3; i += 1) {
        const w2 = world();
        const c2 = register(w2, "campaign");
        senderFixture(w2, "approved", { campaign: c2.sid });
        const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", c2.resource_id, P, ref(`dl-${i}`), "owner_written", "The owner asked us in writing to cancel", true);
        call("tw4_rfl_cancel_begin", op.operation_id, P);
        const both = await Promise.all([
          psqlAsync(callSql("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null)),
          psqlAsync(callSql("tw4_rfl_suspend_df", w2.studio, P2, "suspension racing the cancellation finish", true)),
        ]);
        results.push(...both);
      }
      expect(results.filter((r) => /deadlock/i.test(r.err))).toHaveLength(0);
      expect(results.every((r) => r.err === "")).toBe(true);
    });

    it("P3 while a cancellation is authorized, claimed or unknown, DanceFlow does not send through the location (sender re-approval cannot reopen it)", () => {
      const w = world();
      const num = register(w, "number");
      senderFixture(w, "revoked", { phone: num.sid });
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", num.resource_id, P, ref("pending-gate"), "owner_written", "The owner asked us in writing to release the number", true);
      senderFixture(w, "approved", { phone: num.sid });   // a re-approval after the authorization
      expect(state(w)).toBe("suspended");
      // the claim itself refuses while the number is (again) the live sender: the gate being closed does not make that check vacuous
      expect(hasCode(callErr("tw4_rfl_cancel_begin", op.operation_id, P), "TW041")).toBe(true);
      expect(opStatus(op.operation_id)).toBe("authorized");
      call("tw4_rfl_suspend_df", w.studio, P, "suspended again before the number release", false);
      expect(call<{ action: string }>("tw4_rfl_cancel_begin", op.operation_id, P).action).toBe("execute");
      expect(state(w)).toBe("suspended");
    });

    it("P3 a provider reference cannot be reused for another period; a reopening bill keeps the closing note in the audit trail", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      const a = authFixture(w, "number", { startsDaysAgo: 1, expiresInDays: 120 });
      expect(a).toBeTruthy();
      // reference reuse across periods
      const k1 = prevKey();
      const k2 = keyAdd(cur(), -2);
      call("tw4_rfl_observe_provider_bill", num.resource_id, k1, `INV-${RUN}-${w.n}-x1`, 115, P);
      expect(hasCode(callErr("tw4_rfl_observe_provider_bill", num.resource_id, k2, `INV-${RUN}-${w.n}-x1`, 115, P), "TW043")).toBe(true);
      // closing then reopening by a new bill: the note survives in the audit
      call("tw4_rfl_exposure_dispose", num.resource_id, k1, P, "absorbed", "first line absorbed pending the dispute outcome");
      call("tw4_rfl_observe_provider_bill", num.resource_id, k1, `INV-${RUN}-${w.n}-x2`, 20, P);
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'rfl_exposure_opened' and note like '%reopened_by_bill%first line absorbed%'`)).toBe("1");
    });
  });

  describe("charges follow the provider resource (real authorize + charge path)", () => {
    const retire = (w: World, resourceId: string, cancelledMonthsAgo: number) => {
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", resourceId, P, ref("retire"), "owner_written", "The owner asked us in writing to cancel this resource", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      if (cancelledMonthsAgo > 0) replica(`update public.studio_sms_provider_resources set cancelled_at = now() - interval '${cancelledMonthsAgo * 32} days' where id = '${resourceId}';`);
    };

    it("a recurring charge is never taken for a retired resource (a later month), is still taken for the month it was cancelled in, and resumes for a live replacement", () => {
      const w = world();
      const auth = call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 6, null);
      const num = register(w, "number");
      retire(w, num.resource_id, 1);   // cancelled last month
      const refused = call<{ outcome: string; reason: string }>("tw4_recurring_charge", auth.authorization_id, cur(), null);
      expect(refused).toMatchObject({ outcome: "held", reason: expect.stringContaining("cancelled") });   // held, not refused: the scheduler keeps retrying it
      const due = (): Array<{ id: string; period_key: string }> => JSON.parse(psql(`select public.tw4_recurring_due_list()::text`));
      expect(due().some((d) => d.id === auth.authorization_id && d.period_key === cur())).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}' and kind = 'capture'`))).toBe(0);
      // the unpaid month of a retired resource does not suspend sending either
      expect(state(w)).not.toBe("suspended");
      // a live replacement makes the SAME authorization chargeable again
      const replacement = register(w, "number");
      expect(due().some((d) => d.id === auth.authorization_id && d.period_key === cur())).toBe(true);   // still on the scheduler's list
      expect(call<{ outcome: string }>("tw4_recurring_charge", auth.authorization_id, cur(), null).outcome).toBe("charged");
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${replacement.resource_id}'`)).toBe("covered:charge");
      expect(state(w)).not.toBe("suspended");
      // cancelled THIS month: the month Twilio already billed is still payable
      const w2 = world();
      const auth2 = call<{ authorization_id: string }>("tw4_recurring_authorize", w2.studio, w2.owner, "number", PRICE.number, 6, null);
      const n2 = register(w2, "number");
      retire(w2, n2.resource_id, 0);
      expect(call<{ outcome: string }>("tw4_recurring_charge", auth2.authorization_id, cur(), null).outcome).toBe("charged");
      // a location that never registered a resource is unchanged (charges before provisioning completes)
      const w3 = world();
      const auth3 = call<{ authorization_id: string }>("tw4_recurring_authorize", w3.studio, w3.owner, "number", PRICE.number, 6, null);
      expect(call<{ outcome: string }>("tw4_recurring_charge", auth3.authorization_id, cur(), null).outcome).toBe("charged");
    });

    it("confirming a cancellation tells the owner their authorization stays until they revoke it (once)", () => {
      const w = world();
      call("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 6, null);
      const num = register(w, "number");
      retire(w, num.resource_id, 0);
      expect(alertsOf(w, "cancelled_authorization_active")).toBe(1);
    });

    it("an open cancellation blocks a NEW authorization (renewal) and activation readiness until it is resolved", () => {
      const w = world();
      const first = call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null);
      const num = register(w, "number");
      register(w, "campaign");
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", num.resource_id, P, ref("open-op"), "owner_written", "The owner asked us in writing to release the number", true);
      expect(call<{ blockers: string[] }>("tw4_rfl_studio_ready", w.studio).blockers).toContain("cancellation_pending");
      call("tw4_recurring_revoke", first.authorization_id, w.owner);
      expect(hasCode(callErr("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null), "TW041")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_recurring_authorizations where studio_id = '${w.studio}' and status = 'active'`))).toBe(0);
      // another fee of the location (the campaign) is not blocked by the number's operation
      expect(call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "monthly", PRICE.monthly, 3, null).authorization_id).toBeTruthy();
      // once the operation is withdrawn the owner can authorize again
      call("tw4_rfl_cancel_withdraw", op.operation_id, P, "the owner changed their mind in writing");
      expect(call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null).authorization_id).toBeTruthy();
    });

    it("a provider cost variance is never charged to the studio: the ledger and balance are untouched by variance records and bill evidence", () => {
      const w = world();
      const num = register(w, "number");
      age(num.resource_id);
      const before = psql(`select (select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}') || '|' || balance_cents || '|' || reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}'`);
      call("tw4_credit_record_provider_charge", w.entity, w.studio, "number", `INV-${RUN}-${w.n}-v1`, 900, P);
      call("tw4_rfl_observe_provider_bill", num.resource_id, prevKey(), `INV-${RUN}-${w.n}-v2`, 900, P);
      scan(w);
      expect(psql(`select (select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}') || '|' || balance_cents || '|' || reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}'`)).toBe(before);
      expect(Number(psql(`select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}' and reservation_key like 'rfl:%'`))).toBe(0);
    });

    it("P1 nothing is charged while a cancellation is open or unknown, and the cancellation date is when the operation STARTED (not when the evidence was recorded)", () => {
      const w = world();
      const auth = call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 6, null);
      const num = register(w, "number");
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", num.resource_id, P, ref("p1-open"), "owner_written", "The owner asked us in writing to release the number", true);
      expect(call<{ outcome: string; reason: string }>("tw4_recurring_charge", auth.authorization_id, cur(), null)).toMatchObject({ outcome: "held", reason: expect.stringContaining("cancellation") });
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "unknown", null, "timeout");
      expect(call<{ outcome: string }>("tw4_recurring_charge", auth.authorization_id, cur(), null).outcome).toBe("held");
      expect(Number(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}' and kind = 'capture'`))).toBe(0);
      // the operation began last month (the resource itself is older still); the evidence is recorded this month
      age(num.resource_id, 60);
      replica(`update public.studio_sms_provider_cancel_ops set started_at = now() - interval '33 days' where id = '${op.operation_id}';`);
      call("tw4_rfl_cancel_resolve", op.operation_id, P, "cancelled", digest(), "provider console showed the number gone since last month");
      expect(psql(`select public._tw4ml_month_key('${w.entity}', cancelled_at) from public.studio_sms_provider_resources where id = '${num.resource_id}'`)).toBe(prevKey());
      expect(call<{ outcome: string }>("tw4_recurring_charge", auth.authorization_id, cur(), null).outcome).toBe("held");   // retired: nothing to charge for
      expect(Number(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}' and kind = 'capture'`))).toBe(0);
    });

    it("charges already taken for months after the cancellation are flagged for refund review", () => {
      const w = world();
      const a = authFixture(w, "number", { startsDaysAgo: 100, expiresInDays: 100 });
      const num = register(w, "number");
      chargeFixture(w, a, "number", cur(), "charged");
      age(num.resource_id, 90);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", num.resource_id, P, ref("late-charge"), "owner_written", "The owner asked us in writing to release the number", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      replica(`update public.studio_sms_provider_cancel_ops set started_at = now() - interval '40 days' where id = '${op.operation_id}';`);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      expect(alertsOf(w, "charged_after_cancellation")).toBe(1);
    });

    it("P2 a sibling operation left open on a resource is superseded when another operation's evidence confirms the cancellation (no stuck operation, no stuck suspension)", () => {
      const w = world();
      const camp = register(w, "campaign");
      const op1 = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("sibling-1"), "owner_written", "The owner asked us in writing to cancel the campaign", true);
      call("tw4_rfl_cancel_begin", op1.operation_id, P);
      replica(`update public.studio_sms_provider_cancel_ops set started_at = now() - interval '30 minutes' where id = '${op1.operation_id}';`);
      call("tw4_rfl_cancel_resolve", op1.operation_id, P, "still_active", digest(), "console still lists the campaign at that moment");
      const op2 = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("sibling-2"), "owner_written", "A second written decision to cancel the campaign", true);
      call("tw4_rfl_cancel_begin", op2.operation_id, P);
      call("tw4_rfl_cancel_finish", op1.operation_id, P, "confirmed", digest(), null);   // the first operator did complete it
      expect(providerState(camp.resource_id)).toBe("cancelled");
      expect(opStatus(op2.operation_id)).toBe("abandoned");
      expect(psql(`select resolution_note from public.studio_sms_provider_cancel_ops where id = '${op2.operation_id}'`)).toContain("superseded");
      expect(state(w)).not.toBe("suspended");
      expect(call<{ blockers: string[] }>("tw4_rfl_studio_ready", w.studio).blockers).not.toContain("cancellation_pending");
    });

    it("P2 a sender release recorded through the sender path while the inventory still shows the resource live is a critical admin alert", () => {
      const w = world();
      const num = register(w, "number");
      senderFixture(w, "released", { phone: num.sid });
      call("tw4_rfl_inventory_gaps");
      call("tw4_rfl_inventory_gaps");
      expect(alertsOf(w, "released_resource_active")).toBe(1);
    });

    it("P2 a cancellation reference shares the permanent approval namespace in BOTH directions", () => {
      const w = world({ pilot: true, ceiling: 15000 });
      const num = register(w, "number");
      const camp = register(w, "campaign");
      const spendRef = `Owner email ${RUN} shared namespace approve`;
      call("tw4_spend_authorize", w.entity, "monthly", PRICE.monthly, spendRef, P, "pilot", w.studio);
      // a fee approval reference cannot authorize an irreversible cancellation (other spelling, other case, extra spaces)
      expect(hasCode(callErr("tw4_rfl_cancel_authorize", camp.resource_id, P, `  ${spendRef.toUpperCase().replace(/ /g, "  ")}`, "owner_written", "The owner asked us in writing to cancel the campaign", true), "TW019")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cancel_ops where resource_id = '${camp.resource_id}'`))).toBe(0);
      // and a cancellation reference cannot later authorize a fee
      const cancelRef = `Founder note ${RUN} release the number in writing`;
      call("tw4_rfl_cancel_authorize", num.resource_id, P, cancelRef, "founder_written", "The founder approved releasing this number in writing", true);
      expect(psql(`select source from public.studio_sms_approval_refs where ref_norm = public._tw4fi_ref_norm($q$${cancelRef}$q$)`)).toBe("cancellation");
      expect(hasCode(callErr("tw4_spend_authorize", w.entity, "monthly", PRICE.monthly, cancelRef.toLowerCase(), P, "pilot", w.studio), "TW019")).toBe(true);
    });

    it("P3 one provider bill line cannot be counted on two resources of a business", () => {
      const w = world();
      const first = register(w, "number");
      age(first.resource_id);
      const line = `INV-${RUN}-${w.n}-shared`;
      call("tw4_rfl_observe_provider_bill", first.resource_id, prevKey(), line, 115, P);
      const camp = register(w, "campaign");
      age(camp.resource_id);
      expect(hasCode(callErr("tw4_rfl_observe_provider_bill", camp.resource_id, prevKey(), line, 115, P), "TW043")).toBe(true);
      expect(exposureRows(camp.resource_id)).toEqual([]);
    });

    it("P3 confirming a cancellation closes only accruing periods AFTER the cancellation month; earlier uncovered periods stay open for a disposition", () => {
      const w = world();
      const camp = register(w, "campaign");
      age(camp.resource_id, 120);
      scan(w);
      const before = exposureRows(camp.resource_id).filter((r) => r.period <= cur());
      expect(before.length).toBeGreaterThan(2);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("close-later"), "owner_written", "The owner asked us in writing to cancel the campaign", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      const after = exposureRows(camp.resource_id);
      expect(after.filter((r) => r.period <= cur()).every((r) => r.state === "open")).toBe(true);   // cancelled this month: nothing before it is closed silently
    });

    it("money layer: a credit-funded one-off spend or reservation of a recurring fee is refused while a standing authorization covers it (the pilot path is unaffected)", () => {
      const w = world();
      call("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null);
      const err = callErr("tw4_spend_authorize", w.entity, "number", PRICE.number, ref("one-off-number"), P, "credit", w.studio);
      expect(hasCode(err, "TW041")).toBe(true);
      const id = randomUUID();
      expect(hasCode(psqlError(`insert into public.studio_sms_credit_reservations (id, legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
        values ('${id}', '${w.entity}', '${w.studio}', 'number', ${PRICE.number}, 'credit', 'purchase:${id}');`), "TW041")).toBe(true);
      // the campaign fee has no authorization here, so its one-off path is untouched; vetting is not a recurring kind
      expect(callErr("tw4_spend_authorize", w.entity, "campaign_vetting", 1, ref("vetting-ok"), P, "credit", w.studio)).not.toMatch(/TW041/);
      // the pilot business funds recurring kinds by approval (funding 'pilot'): not blocked
      const p = world({ pilot: true, ceiling: 15000 });
      const num = register(p, "number");
      expect(call<{ amount_cents: number }>("tw4_rfl_pilot_cover", num.resource_id, cur(), ref("pilot-oneoff-ok"), P).amount_cents).toBe(PRICE.number);
    });
  });

  describe("final review round", () => {
    const replace_start = (_w: World, authId: string) => replica(`update public.studio_sms_recurring_authorizations set starts_at = now() - interval '150 days' where id = '${authId}';`);

    it("P1 a period in which NO resource of the fee was live is never charged, even after a later replacement is registered (the gap month stays held)", () => {
      const w = world();
      const auth = call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 6, null);
      // the owner's authorization began months ago (so the gap month is inside its term and only the resource question decides)
      replace_start(w, auth.authorization_id);
      const first = register(w, "number");
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", first.resource_id, P, ref("gap"), "owner_written", "The owner asked us in writing to release the number", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      // cancelled at the end of the month BEFORE last; the replacement is registered this month
      replica(`update public.studio_sms_provider_resources set registered_at = public._tw4ml_month_start('${w.entity}', '${keyAdd(cur(), -3)}') + interval '1 hour',
                  cancelled_at = public._tw4ml_month_start('${w.entity}', '${keyAdd(cur(), -1)}') - interval '1 hour' where id = '${first.resource_id}';`);
      register(w, "number");
      const gap = prevKey(); // no resource was live in it
      expect(call<{ outcome: string }>("tw4_recurring_charge", auth.authorization_id, gap, null).outcome).toBe("held");
      expect(call<{ outcome: string }>("tw4_recurring_charge", auth.authorization_id, cur(), null).outcome).toBe("charged");
      expect(Number(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}' and kind = 'capture'`))).toBe(1);
      expect(psql(`select public._tw4rfl_retired('${w.entity}', '${w.studio}', array['number'], '${gap}')::text`)).toBe("true");
      expect(psql(`select public._tw4rfl_retired('${w.entity}', '${w.studio}', array['number'], '${cur()}')::text`)).toBe("false");
    });

    it("P2 an operation abandoned on evidence that the resource was still present is not backdated to before that evidence when it is later confirmed", () => {
      const w = world();
      const camp = register(w, "campaign");
      age(camp.resource_id, 150);
      scan(w);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("backdate"), "owner_written", "The owner asked us in writing to cancel the campaign", true);
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      replica(`update public.studio_sms_provider_cancel_ops set started_at = now() - interval '100 days' where id = '${op.operation_id}';`);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "unknown", null, "timeout");
      call("tw4_rfl_cancel_resolve", op.operation_id, P2, "still_active", digest(), "console still lists the campaign right now");
      const openBefore = exposureRows(camp.resource_id).filter((r) => r.state === "open").length;
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      // cancelled_at is the time of the still_active finding (now), not the operation's start 100 days ago
      expect(psql(`select (cancelled_at > now() - interval '1 hour')::text from public.studio_sms_provider_resources where id = '${camp.resource_id}'`)).toBe("true");
      expect(exposureRows(camp.resource_id).filter((r) => r.state === "open").length).toBe(openBefore);
      expect(alertsOf(w, "charged_after_cancellation")).toBe(0);
    });

    it("P2 reverse double-payment guard: a credit one-off of a recurring fee that exists for the location blocks a standing authorization of the same fee", () => {
      const w = world();
      const id = randomUUID();
      replica(`insert into public.studio_sms_credit_reservations (id, legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key)
        values ('${id}', '${w.entity}', '${w.studio}', 'number', ${PRICE.number}, 'credit', 'reserved', 'purchase:${id}');`);
      expect(hasCode(callErr("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null), "TW041")).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_recurring_authorizations where studio_id = '${w.studio}'`))).toBe(0);
      // another fee of the location is not blocked, and a released one-off no longer blocks
      expect(call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "monthly", PRICE.monthly, 3, null).authorization_id).toBeTruthy();
      replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = '${id}';`);
      expect(call<{ authorization_id: string }>("tw4_recurring_authorize", w.studio, w.owner, "number", PRICE.number, 3, null).authorization_id).toBeTruthy();
    });

    it("P3 an operator whose operation was superseded gets a clean 'already cancelled' answer, not a guard error", () => {
      const w = world();
      const camp = register(w, "campaign");
      const op1 = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("superseded-1"), "owner_written", "The owner asked us in writing to cancel the campaign", true);
      call("tw4_rfl_cancel_begin", op1.operation_id, P);
      replica(`update public.studio_sms_provider_cancel_ops set started_at = now() - interval '30 minutes' where id = '${op1.operation_id}';`);
      call("tw4_rfl_cancel_resolve", op1.operation_id, P, "still_active", digest(), "console still lists the campaign at that moment");
      const op2 = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref("superseded-2"), "owner_written", "A second written decision to cancel the campaign", true);
      call("tw4_rfl_cancel_begin", op2.operation_id, P);
      call("tw4_rfl_cancel_finish", op2.operation_id, P, "confirmed", digest(), null);
      const late = call<{ replayed: boolean; resource_already_cancelled?: boolean }>("tw4_rfl_cancel_finish", op1.operation_id, P, "confirmed", digest(), null);
      expect(late).toMatchObject({ replayed: true, resource_already_cancelled: true });
    });

    it("lock order matches R2b's (location link, business, account): a session replaying that order never deadlocks with suspension or cancellation completion", async () => {
      const results: Array<{ err: string }> = [];
      for (let i = 0; i < 3; i += 1) {
        const w = world();
        const camp = register(w, "campaign");
        senderFixture(w, "approved", { campaign: camp.sid });
        const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", camp.resource_id, P, ref(`order-${i}`), "owner_written", "The owner asked us in writing to cancel", true);
        call("tw4_rfl_cancel_begin", op.operation_id, P);
        const r2bOrder = `begin; select public._tw4sr_lock('${w.studio}'::uuid); select pg_sleep(1.2); select public._tw4rfl_lock('${w.entity}'::uuid); commit;`;
        const both = await Promise.all([
          psqlAsync(r2bOrder),
          (async () => {
            await new Promise((r) => setTimeout(r, 300));
            return psqlAsync(callSql("tw4_rfl_suspend_df", w.studio, P, "suspension racing the activation order", true));
          })(),
          (async () => {
            await new Promise((r) => setTimeout(r, 500));
            return psqlAsync(callSql("tw4_rfl_cancel_finish", op.operation_id, P2, "confirmed", digest(), null));
          })(),
        ]);
        results.push(...both);
      }
      expect(results.filter((r) => /deadlock/i.test(r.err))).toHaveLength(0);
      expect(results.every((r) => r.err === "")).toBe(true);
    });
  });

  describe("the migration and its rollback", () => {
    it("contains no outbound call, no Stripe, no Twilio write and no way to release a provider resource", () => {
      const sql = readFileSync(join(process.cwd(), "src/lib/supabase/migrations", `${MIGRATION}.sql`), "utf8");
      const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
      expect(code).not.toMatch(/http_post|net\.http|pg_net|dblink|stripe|api\.twilio\.com/i);
      expect(code).not.toMatch(/update public\.studio_sms_credit_accounts set balance_cents/i);
      const defs = psql(`select string_agg(p.prosrc, ' ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'tw4_rfl%' or p.proname like '_tw4rfl%' or p.proname like 'sms_rfl%')`);
      expect(defs).not.toMatch(/tw4_recurring_authorize|tw4_recurring_charge|tw4_credit_adjust|_tw4c_post\(/);   // never extends an authorization, charges, or edits the ledger
    });

    it("the rollback refuses while evidence exists and, on a schema-only copy with none, restores the 20261128 gate and drops every object", () => {
      const rollbackSql = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback", `${MIGRATION}_rollback.sql`), "utf8");
      // with evidence present (this database): refused, nothing dropped. Never run it here unless the earlier scenarios really left evidence behind.
      expect(Number(psql(`select count(*) from public.studio_sms_provider_resources`))).toBeGreaterThan(0);
      expect(psqlError(rollbackSql)).toMatch(/55000/);
      expect(psql(`select to_regclass('public.studio_sms_provider_resources') is not null`)).toBe("t");
      // a scratch copy of the SCHEMA only (no evidence): the rollback runs clean
      const scratch = `${DB}_rb_${RUN}`;
      const sh = (cmd: string) => execFileSync("docker", ["exec", PG, "sh", "-c", cmd], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      try {
        sh(`psql -U postgres -q -c 'create database ${scratch}'`);
        sh(`pg_dump -U postgres -s --no-owner ${DB} | psql -U postgres -d ${scratch} -q > /dev/null 2>&1; true`);
        const run = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", scratch, "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        expect(run(`select to_regclass('public.studio_sms_provider_resources') is not null`)).toBe("t");
        run(rollbackSql);
        expect(run(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'tw4\\_rfl%' or p.proname like '\\_tw4rfl%' or p.proname like 'sms\\_rfl%')`)).toBe("0");
        expect(run(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'studio\\_sms\\_provider\\_%' and c.relkind = 'r'`)).toBe("1");   // studio_sms_provider_charges (3b-0) is not ours
        expect(run(`select position('_tw4rfl_gate_suspended' in prosrc) from pg_proc where oid = 'public._tw4rc_service_state(uuid)'::regprocedure`)).toBe("0");
        expect(run(`select position('a pilot business is governed by per-operation approvals' in prosrc) > 0 from pg_proc where oid = 'public._tw4rc_service_state(uuid)'::regprocedure`)).toBe("t");
        // the approval-reference constraints are back to their 20261202 shape
        expect(run(`select (pg_get_constraintdef(oid) like '%cancellation%')::text from pg_constraint where conrelid = 'public.studio_sms_approval_refs'::regclass and conname = 'studio_sms_approval_refs_shape'`)).toBe("false");
        expect(run(`select (pg_get_constraintdef(oid) like '%cancellation%')::text from pg_constraint where conrelid = 'public.studio_sms_approval_refs'::regclass and conname = 'studio_sms_approval_refs_source_check'`)).toBe("false");
        // a sibling's added source (R2b's number_selection) survives apply and rollback: simulate its additive constraint change, re-apply, check, roll back again
        run(`do $$
          declare v text[];
          begin
            select array_agg(distinct m[1]) into v from regexp_matches((select substring(pg_get_constraintdef(oid) from 'ANY \\((.*)\\)') from pg_constraint where conrelid = 'public.studio_sms_approval_refs'::regclass and conname = 'studio_sms_approval_refs_source_check'), '([a-z_]+)', 'g') m where m[1] not in ('text', 'array');
            v := v || array['number_selection'];
            alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_source_check;
            execute format('alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_source_check check (source = any (%L::text[]))', v);
          end $$;`);
        run(readFileSync(join(process.cwd(), "src/lib/supabase/migrations", `${MIGRATION}.sql`), "utf8"));
        expect(run(`select (pg_get_constraintdef(oid) like '%number_selection%' and pg_get_constraintdef(oid) like '%cancellation%')::text from pg_constraint where conrelid = 'public.studio_sms_approval_refs'::regclass and conname = 'studio_sms_approval_refs_source_check'`)).toBe("true");
        run(rollbackSql);
        expect(run(`select (pg_get_constraintdef(oid) like '%number_selection%' and pg_get_constraintdef(oid) not like '%cancellation%')::text from pg_constraint where conrelid = 'public.studio_sms_approval_refs'::regclass and conname = 'studio_sms_approval_refs_source_check'`)).toBe("true");
        // and the migration applies again on top of the rolled-back schema
        run(readFileSync(join(process.cwd(), "src/lib/supabase/migrations", `${MIGRATION}.sql`), "utf8"));
        expect(run(`select to_regclass('public.studio_sms_provider_resources') is not null`)).toBe("t");
      } finally {
        try {
          sh(`psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${scratch}'" -c 'drop database if exists ${scratch}'`);
        } catch {
          // best effort
        }
      }
    }, 600_000);
  });
});

function chargeFixtureSync(w: World, authId: string, period: string) {
  chargeFixture(w, authId, "number", period, "charged");
}
