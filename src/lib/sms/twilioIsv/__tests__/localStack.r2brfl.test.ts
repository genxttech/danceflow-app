/**
 * TW-4F R2b / recurring-fee-lifecycle integration (20261217090000) against a REAL schema: the number registers in the lifecycle inventory in the same transaction as the
 * provider-ownership observation (from the number ledger's own rows), number rent follows the ledger's provider-confirmed basis, a confirmed number cancellation retires
 * the ledger, and none of it moves the pilot ceiling or charges twice. Synthetic fixtures with fresh ids; fake provider evidence only (no Twilio, no SMS, no Stripe).
 * LOCAL QA ONLY: a DEDICATED Postgres with migrations 20261207090000 .. 20261217090000 applied and the local-QA marker table (public.tw4_local_qa_only) present:
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4RFL_DB=postgres
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.r2brfl.test.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `bb${RUN}-0000-4000-8000-000000000401`;
const P2 = `bb${RUN}-0000-4000-8000-000000000402`;
const OUTSIDER = `bb${RUN}-0000-4000-8000-000000000999`;
const MIG = join(__dirname, "../../../supabase/migrations");

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

const hex = (n: number) => randomBytes(n).toString("hex");
const sid = (prefix: string) => `${prefix}${hex(16)}`;
const digest = () => hex(32);
const ref = (label: string) => `Written approval ${RUN} ${label} ${hex(3)}`;
const e164 = () => `+12${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

type World = { entity: string; studio: string; owner: string; account: string; pilot: boolean };
const cur = () => psql("select to_char(now() at time zone 'UTC', 'YYYY-MM')");

/** A synthetic business (or the one pilot business) with one location, an active subaccount, funded credit and a monthly limit. */
function world(opts: { pilot?: boolean } = {}): World {
  const w: World = { entity: randomUUID(), studio: randomUUID(), owner: randomUUID(), account: sid("AC"), pilot: Boolean(opts.pilot) };
  if (w.pilot) {
    // the platform allows exactly ONE pilot business: later pilot scenarios get a fresh LOCATION of it
    const existing = psql(`select y.legal_entity_id || '|' || t.twilio_account_sid from public.studio_sms_pilot_exceptions y join public.studio_sms_twilio_accounts t on t.legal_entity_id = y.legal_entity_id and t.status = 'active'`);
    if (existing) {
      [w.entity, w.account] = existing.split("|");
      psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${hex(4)}@r2brfl-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'R2BRFL pilot ${hex(3)}', 'r2brfl-p-${hex(4)}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
commit;
begin; set local session_replication_role = replica;
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now());
commit;`);
      return w;
    }
  }
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${hex(4)}@r2brfl-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'R2BRFL ${hex(3)}', 'r2brfl-${hex(4)}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', '${w.pilot ? "ConfiDance Unlimited, LLC" : `R2BRFL World ${hex(3)} LLC`}', '7777', ${w.pilot ? 15000 : 500000}, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: verified synthetic business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${w.entity}', '${w.account}', 'r2brfl-${hex(3)}', 'test', 'active', '${P}');
commit;`);
  call("tw4_credit_adjust", w.entity, 200_000, `r2brfl-fund-${hex(4)}`, "fixture funding for the integration suite", P);
  call("tw4_monthly_limit_set_admin", w.entity, P, 20_000, null, "fixture: monthly limit for the integration suite");
  if (w.pilot) call("tw4_pilot_exception_create", w.entity, 15000, `Founder written pilot approval ${RUN}`, P);
  return w;
}

type Ledger = { onboarding: string; op: string; pn: string; number: string };
/** The number ledger for a location: an onboarding with a live lease, a consumed selection and a purchase operation in the given status. */
function ledger(w: World, o: { status?: "succeeded" | "in_flight" | "unknown_outcome"; account?: string; pilotReservation?: boolean } = {}): Ledger {
  const l: Ledger = { onboarding: randomUUID(), op: randomUUID(), pn: sid("PN"), number: e164() };
  const selection = randomUUID();
  const status = o.status ?? "succeeded";
  const account = o.account ?? w.account;
  replica(`insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at, lease_owner, lease_expires_at)
    values ('${l.onboarding}', '${w.studio}', 'campaign_pending', 'R2BRFL LLC', 'llc', '7777', 1, now(), 'lc', now() + interval '2 hours');
  insert into public.studio_sms_number_selections (id, offer_id, studio_id, legal_entity_id, twilio_account_sid, e164, price_cents, funding_mode, approver_user, approver_role, approval_ref, statement, expires_at, status, consumed_at, consumed_by_operation)
    values ('${selection}', '${randomUUID()}', '${w.studio}', '${w.entity}', '${account}', '${l.number}', 200, '${w.pilot ? "pilot" : "credit_recurring"}', '${w.owner}', 'studio_owner', '${ref("selection")}',
            'fixture: the owner approved this single number for purchase in the integration suite', now() + interval '1 day', 'consumed', now(), '${l.op}');
  insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, selection_id, e164, friendly_name, request_digest, params,
                                                 provider_sid, fee_bearing, fee_kinds, started_by, finished_at)
    values ('${l.op}', '${l.onboarding}', '${w.studio}', '${w.entity}', '${account}', 'number_purchase', 1, 1, '${status}', '${selection}', '${l.number}', 'fixture number', '${digest()}',
            '{"funding_mode":"${w.pilot ? "pilot" : "credit"}"}'::jsonb, ${status === "succeeded" ? `'${l.pn}'` : "null"}, true, array['number'], '${P}', ${status === "succeeded" ? "now()" : "null"});`);
  if (o.pilotReservation) {
    replica(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
      values ('${w.entity}', '${w.studio}', 'number', 200, 'pilot', 'captured', 'prov:${l.op}:number', now());`);
  }
  return l;
}
const facts = (w: World, l: Ledger, over: Record<string, unknown> = {}) => ({ sid: l.pn, account_sid: w.account, phone_number: l.number, sms_capable: true, ...over });
const observe = (w: World, l: Ledger, over: Record<string, unknown> = {}) =>
  call<{ status: string; code: string | null }>("tw4_num_observe", l.onboarding, "lc", l.op, facts(w, l, over), "fake", digest());
const resourcesOf = (w: World) => JSON.parse(psql(`select coalesce(json_agg(json_build_object('id', id, 'kind', resource_kind, 'sid', provider_sid, 'e164', e164, 'source', source, 'op', source_operation_id, 'by', registered_by, 'state', provider_state, 'fee', fee_kind)), '[]'::json)::text
  from public.studio_sms_provider_resources where studio_id = '${w.studio}'`)) as Array<{ id: string; kind: string; sid: string; e164: string; source: string; op: string; by: string; state: string; fee: string }>;
const alerts = (w: World, kind: string) => Number(psql(`select count(*) from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' and kind = '${kind}'`));
const priceNumber = () => Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = 'number' and active`));
const authFixture = (w: World, kind = "number") => {
  const id = randomUUID();
  const price = priceNumber();
  replica(`insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, starts_at, expires_at, status, authorized_by, statement)
    values ('${id}', '${w.entity}', '${w.studio}', '${kind}', ${price}, 6, ${price * 6}, now() - interval '5 days', now() + interval '170 days', 'active', '${w.owner}', 'fixture: the owner authorized this recurring charge in the suite');`);
  return id;
};
const charge = (auth: string, period = cur()) => call<{ outcome: string; reason?: string; replayed: boolean }>("tw4_recurring_charge", auth, period, null);
const capturedCount = (auth: string) => Number(psql(`select count(*) from public.studio_sms_recurring_charges where authorization_id = '${auth}' and status = 'charged'`));
const pilotUsed = (w: World) => Number(psql(`select coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured')`));
const reservationCount = (w: World) => Number(psql(`select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}'`));

const authorizeCancel = (resourceId: string, approval: string) => {
  const reason = "the owner asked in writing to release this number";
  const req = call<{ request_id: string }>("tw4_rfl_dual_request", P, "cancel_number", resourceId, null, reason, approval, "owner_written");
  call("tw4_rfl_dual_approve", req.request_id, P2, "second administrator approves this number cancellation");
  return call<{ operation_id: string }>("tw4_rfl_cancel_authorize", resourceId, P, approval, "owner_written", reason, true);
};

describe.skipIf(!enabled)("TW-4F R2b/RFL integration (real schema, fake provider evidence)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`)).toBe("t");
    expect(psql(`select to_regprocedure('public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)') is not null`)).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@r2brfl-e2e.test', now(), now(), now()),
         ('${P2}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin2-${RUN}@r2brfl-e2e.test', now(), now(), now()),
         ('${OUTSIDER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'out-${RUN}@r2brfl-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin'), ('${P2}', 'platform_admin'), ('${OUTSIDER}', null) on conflict (id) do update set platform_role = excluded.platform_role;
commit;`);
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150]] as const) {
      if (!psql(`select 1 from public.studio_sms_price_list where kind = '${kind}' and active`)) call("tw4_price_set", kind, customer, provider, `fixture ${kind} price`, P);
    }
  });

  describe("registration happens with the ownership observation, from the ledger", () => {
    it("a provider-confirmed purchase is registered in the same transaction, with the ledger's own sid, number, account and operation", () => {
      const w = world();
      const l = ledger(w);
      expect(resourcesOf(w)).toHaveLength(0);
      expect(observe(w, l).status).toBe("owned");
      const rs = resourcesOf(w);
      expect(rs).toHaveLength(1);
      expect(rs[0]).toMatchObject({ kind: "number", sid: l.pn, e164: l.number, source: "r2b", op: l.op, by: P, state: "active", fee: "number" });
      // no cover row for a credit business: its standing authorization pays the registration month, and no credit moves
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cover where resource_id = '${rs[0].id}'`))).toBe(0);
      expect(psql(`select actor_type from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'rfl_registered'`)).toBe("system");
      // actor provenance: the registering actor is the administrator who started the purchase (a ledger fact), the execution is recorded as the system
      expect(psql(`select note from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'rfl_registered'`)).toContain(`initiated_by=${P}`);
    });

    it("a replayed observation registers nothing twice, and a concurrent pair leaves exactly one resource", async () => {
      const w = world();
      const l = ledger(w);
      const run = () => psqlAsync(callSql("tw4_num_observe", l.onboarding, "lc", l.op, facts(w, l), "fake", digest()));
      const [a, b] = await Promise.all([run(), run()]);
      expect(a.err + b.err).toBe("");
      expect(observe(w, l).status).toBe("owned");
      expect(resourcesOf(w)).toHaveLength(1);
    });

    it("an attach observation or a provider mismatch registers nothing", () => {
      const w = world();
      const l = ledger(w);
      expect(observe(w, l, { sid: sid("PN") }).status).toBe("mismatch");
      expect(resourcesOf(w)).toHaveLength(0);
    });

    it("an administrator cannot register a different identifier, a different source or a different operation for a ledger-managed number", () => {
      const w = world();
      const l = ledger(w);
      observe(w, l);
      const bad = (over: { sid?: string; e164?: string; account?: string; source?: string; op?: string | null; reservation?: string | null }) =>
        callErr("tw4_rfl_register", w.studio, P, "number", over.sid ?? l.pn, over.account ?? w.account, over.e164 ?? l.number, over.source ?? "r2b", over.op === undefined ? l.op : over.op, over.reservation ?? null);
      expect(hasCode(bad({ sid: sid("PN") }), "TW040")).toBe(true);
      expect(hasCode(bad({ e164: "+12025559999" }), "TW040")).toBe(true);
      expect(hasCode(bad({ source: "admin" }), "TW040")).toBe(true);
      expect(hasCode(bad({ op: null }), "TW040")).toBe(true);
      expect(hasCode(bad({ reservation: randomUUID() }), "TW040")).toBe(true);
      // the ledger's own values are a harmless replay
      expect(call<{ replayed: boolean }>("tw4_rfl_register", w.studio, P, "number", l.pn, w.account, l.number, "r2b", l.op, null).replayed).toBe(true);
      expect(resourcesOf(w)).toHaveLength(1);
    });

    it("a location the number ledger has never touched keeps the administrator registration path (legacy numbers)", () => {
      const w = world();
      const out = call<{ replayed: boolean }>("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, e164(), "admin", null, null);
      expect(out.replayed).toBe(false);
    });

    it("a registration that cannot be made never discards the provider evidence: it is alerted, listed as a gap, held and retryable", () => {
      const w = world();
      // a legacy number is already live in the inventory, so the ledger's number cannot register beside it
      call("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, e164(), "admin", null, null);
      const l = ledger(w);
      expect(observe(w, l).status).toBe("owned");
      expect(psql(`select status from public.studio_sms_num_resources where operation_id = '${l.op}'`)).toBe("owned");
      expect(resourcesOf(w).filter((r) => r.sid === l.pn)).toHaveLength(0);
      expect(alerts(w, "inventory_gap")).toBe(1);
      expect(psql(`select note from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'num_observed'`)).toMatch(/registration_failed=TW040/);
      const gaps = call<Array<{ operation_id: string }>>("tw4_num_registration_gaps", P);
      expect(gaps.map((g) => g.operation_id)).toContain(l.op);
      expect(callErr("tw4_num_registration_gaps", OUTSIDER)).not.toBe("");
      // a retry does not silently succeed while the cause remains
      expect(hasCode(callErr("tw4_num_registration_retry", w.studio, P), "TW040")).toBe(true);
      // rent is held while the owned number is not registered
      const auth = authFixture(w);
      const held = charge(auth);
      expect(held.outcome).toBe("held");
      expect(held.reason).toMatch(/not registered/);
      expect(capturedCount(auth)).toBe(0);
    });

    it("a retry registers from the ledger once the cause is gone, and takes no identifiers", () => {
      const w = world();
      const legacy = call<{ resource_id: string }>("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, e164(), "admin", null, null);
      const l = ledger(w);
      observe(w, l);
      // cancel the legacy number with evidence, then retry
      const op = authorizeCancel(legacy.resource_id, ref("legacy-cancel"));
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      const out = call<{ resource_id: string }>("tw4_num_registration_retry", w.studio, P);
      expect(out.resource_id).toBeTruthy();
      expect(resourcesOf(w).filter((r) => r.sid === l.pn && r.state === "active")).toHaveLength(1);
      expect(call<unknown[]>("tw4_num_registration_gaps", P).map((g) => (g as { operation_id: string }).operation_id)).not.toContain(l.op);
    });
  });

  describe("number rent follows the provider-confirmed basis", () => {
    it("an unknown purchase outcome is held and visible, never charged", () => {
      const w = world();
      ledger(w, { status: "unknown_outcome" });
      const auth = authFixture(w);
      const out = charge(auth);
      expect(out.outcome).toBe("held");
      expect(out.reason).toMatch(/purchase_outcome_unknown/);
      expect(capturedCount(auth)).toBe(0);
    });

    it("a confirmed, registered number is charged once (and a replay never charges twice)", () => {
      const w = world();
      const l = ledger(w);
      observe(w, l);
      const auth = authFixture(w);
      const before = reservationCount(w);
      expect(charge(auth)).toMatchObject({ outcome: "charged", replayed: false });
      expect(charge(auth)).toMatchObject({ outcome: "charged", replayed: true });
      expect(capturedCount(auth)).toBe(1);
      expect(reservationCount(w)).toBe(before + 1);
    });

    it("a held charge is retried and charged once the basis is confirmed (no retroactive extra charge)", () => {
      const w = world();
      const l = ledger(w, { status: "unknown_outcome" });
      const auth = authFixture(w);
      expect(charge(auth).outcome).toBe("held");
      replica(`update public.studio_sms_num_operations set status = 'succeeded', provider_sid = '${l.pn}', finished_at = now() where id = '${l.op}';`);
      observe(w, l);
      expect(charge(auth).outcome).toBe("charged");
      expect(capturedCount(auth)).toBe(1);
    });

    it("a subaccount that is no longer the active one makes the basis indeterminate: held", () => {
      const w = world();
      const l = ledger(w);
      observe(w, l);
      replica(`update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = '${w.entity}';`);
      const out = charge(authFixture(w));
      expect(out.outcome).toBe("held");
      expect(out.reason).toMatch(/subaccount_not_active/);
    });

    it("a location the ledger has never touched is charged as before (legacy behavior is unchanged)", () => {
      const w = world();
      expect(charge(authFixture(w)).outcome).toBe("charged");
    });

    it("the monthly campaign fee is untouched by the number basis", () => {
      const w = world();
      ledger(w, { status: "unknown_outcome" });
      const price = Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = 'monthly' and active`));
      const id = randomUUID();
      replica(`insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, starts_at, expires_at, status, authorized_by, statement)
        values ('${id}', '${w.entity}', '${w.studio}', 'monthly', ${price}, 6, ${price * 6}, now() - interval '5 days', now() + interval '170 days', 'active', '${w.owner}', 'fixture: the owner authorized this recurring charge in the suite');`);
      expect(charge(id).outcome).not.toBe("held");
    });
  });

  describe("cancellation retires the ledger; a note alone does not", () => {
    it("a confirmed number cancellation supersedes the purchase in the same transaction, and the number can no longer be retired by note", () => {
      const w = world();
      const l = ledger(w);
      observe(w, l);
      const [res] = resourcesOf(w);
      const op = authorizeCancel(res.id, ref("cancel"));
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      call("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null);
      expect(resourcesOf(w)[0].state).toBe("cancelled");
      expect(psql(`select superseded_at is not null from public.studio_sms_num_operations where id = '${l.op}'`)).toBe("t");
      expect(psql(`select public.tw4_num_rent_basis('${w.studio}')::jsonb ->> 'state'`)).toBe("not_billable");
      replica(`update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where studio_id = '${w.studio}';`);
      expect(hasCode(callErr("tw4_num_retire", w.studio, P, "Released at the provider console, confirmed by the owner"), "22023")).toBe(true);
      // replaying the hook is harmless
      expect(psql(`select public._tw4num_on_number_cancelled('${w.studio}', '${l.pn}', '${op.operation_id}', '${P}')`)).toBe("");
    });

    it("an owned, unregistered number is not retired on an administrator's sentence", () => {
      const w = world();
      call("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, e164(), "admin", null, null);
      const l = ledger(w);
      observe(w, l);
      replica(`update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = now(), cancel_evidence_digest = '${digest()}' where studio_id = '${w.studio}' and provider_sid <> '${l.pn}';`);
      // the owned number could not register beside the legacy one: it is exposure, not a number an administrator may declare gone
      replica(`update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where studio_id = '${w.studio}';`);
      const err = callErr("tw4_num_retire", w.studio, P, "I am sure that this number was released at the provider");
      expect(hasCode(err, "TW034")).toBe(true);
      expect(psql(`select superseded_at is null from public.studio_sms_num_operations where id = '${l.op}'`)).toBe("t");
    });

    it("a number the provider's read still shows as ours (not SMS-capable) is not retired on a note", () => {
      const w = world();
      call("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, e164(), "admin", null, null);
      const l = ledger(w);
      expect(observe(w, l, { sms_capable: false }).code).toBe("not_sms_capable");
      replica(`update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = now(), cancel_evidence_digest = '${digest()}' where studio_id = '${w.studio}';
               update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where id = '${l.onboarding}';`);
      expect(hasCode(callErr("tw4_num_retire", w.studio, P, "I am sure that this number was released at the provider"), "TW034")).toBe(true);
    });

    it("a cancellation confirmed while a runner holds the onboarding and operation rows never waits: the ledger retirement is deferred, alerted, and rent stays held", async () => {
      const w = world();
      const l = ledger(w);
      observe(w, l);
      const [res] = resourcesOf(w);
      const op = authorizeCancel(res.id, ref("cancel-deferred"));
      call("tw4_rfl_cancel_begin", op.operation_id, P);
      const holder = psqlAsync(`begin; select 1 from public.studio_sms_onboarding where id = '${l.onboarding}' for update; select 1 from public.studio_sms_num_operations where id = '${l.op}' for update; select pg_sleep(6); commit;`);
      await new Promise((r) => setTimeout(r, 1500));
      const started = Date.now();
      const done = await psqlAsync(callSql("tw4_rfl_cancel_finish", op.operation_id, P, "confirmed", digest(), null));
      expect(done.err).toBe("");
      expect(Date.now() - started).toBeLessThan(4500);
      await holder;
      expect(resourcesOf(w)[0].state).toBe("cancelled");
      expect(psql(`select superseded_at is null from public.studio_sms_num_operations where id = '${l.op}'`)).toBe("t");
      expect(alerts(w, "inventory_gap")).toBe(1);
      expect(charge(authFixture(w)).outcome).toBe("held");
    });

    it("an unregistered number the provider's own read contradicted may be retired", () => {
      const w = world();
      call("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, e164(), "admin", null, null);
      const l = ledger(w);
      observe(w, l);
      observe(w, l, { sid: sid("PN") });   // the provider's read now names a different number: ownership lost
      replica(`update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = now(), cancel_evidence_digest = '${digest()}' where studio_id = '${w.studio}';
               update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where id = '${l.onboarding}';`);
      expect(call<{ retired: string }>("tw4_num_retire", w.studio, P, "The provider read shows this number is no longer ours").retired).toBe(l.pn);
    });
  });

  describe("the ConfiDance pilot ceiling is untouched", () => {
    it("registration binds the purchase's own pilot reservation as the first period's cover and moves no money", () => {
      const w = world({ pilot: true });
      const l = ledger(w, { pilotReservation: true });
      const used = pilotUsed(w);
      const reservations = reservationCount(w);
      observe(w, l);
      const [res] = resourcesOf(w);
      expect(res.kind).toBe("number");
      const covers = JSON.parse(psql(`select coalesce(json_agg(json_build_object('basis', basis, 'reservation', reservation_id)), '[]'::json)::text from public.studio_sms_provider_cover where resource_id = '${res.id}'`)) as Array<{ basis: string; reservation: string }>;
      expect(covers).toHaveLength(1);
      expect(covers[0].basis).toBe("initial_reservation");
      expect(pilotUsed(w)).toBe(used);
      expect(reservationCount(w)).toBe(reservations);
    });

    it("a pilot purchase from an EARLIER month does not cover the month a late registration happens in, and a released reservation pays nothing (the number still registers)", () => {
      const early = world({ pilot: true });
      const le = ledger(early, { pilotReservation: true });
      replica(`update public.studio_sms_num_operations set started_at = started_at - interval '40 days' where id = '${le.op}';`);
      observe(early, le);
      const [r1] = resourcesOf(early);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cover where resource_id = '${r1.id}'`))).toBe(0);
      const released = world({ pilot: true });
      const lr = ledger(released, { pilotReservation: true });
      replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where reservation_key = 'prov:${lr.op}:number';`);
      observe(released, lr);
      const [r2] = resourcesOf(released);
      expect(r2.kind).toBe("number");
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cover where resource_id = '${r2.id}'`))).toBe(0);
    });

    it("a pilot number is refused by the schedule exactly as before (the rent hold never turns that into a charge)", () => {
      const w = world();
      const pilotEntity = psql("select legal_entity_id from public.studio_sms_pilot_exceptions");
      const studio = psql(`select studio_id from public.studio_sms_entity_studios where legal_entity_id = '${pilotEntity}' limit 1`);
      const auth = randomUUID();
      const price = priceNumber();
      replica(`insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, starts_at, expires_at, status, authorized_by, statement)
        values ('${auth}', '${pilotEntity}', '${studio}', 'number', ${price}, 6, ${price * 6}, now() - interval '5 days', now() + interval '170 days', 'active', '${w.owner}', 'fixture: made before the pilot exception existed');`);
      const out = charge(auth);
      expect(out.outcome).toBe("refused");
      expect(out.reason).toMatch(/pilot business/);
    });
  });

  describe("lock order and privileges", () => {
    it("observe, retire and a registration retry running at once never deadlock", async () => {
      for (let i = 0; i < 4; i += 1) {
        const w = world();
        const l = ledger(w);
        observe(w, l);
        const results = await Promise.all([
          psqlAsync(callSql("tw4_num_observe", l.onboarding, "lc", l.op, facts(w, l), "fake", digest())),
          psqlAsync(callSql("tw4_num_retire", w.studio, P, "Released at the provider console, per the owner")),
          psqlAsync(callSql("tw4_num_registration_retry", w.studio, P)),
          psqlAsync(callSql("tw4_num_observe", l.onboarding, "lc", l.op, facts(w, l, { sid: sid("PN") }), "fake", digest())),
        ]);
        for (const r of results) expect(r.err).not.toMatch(/deadlock detected|40P01/);
      }
    });

    it("the system registration core and the new internals are not executable by any API role; only the two admin reads/retries are, by the service role", () => {
      const roles = ["anon", "authenticated", "service_role"];
      const internal = [
        "public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)", "public._tw4num_register_owned(uuid)", "public._tw4num_rent_hold(uuid,uuid)",
        "public._tw4num_on_number_cancelled(uuid,text,uuid,uuid)", "public._tw4num_ledger_active(uuid)", "public._tw4num_ledger_reservation(uuid)",
      ];
      for (const fn of internal) for (const role of roles) expect(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
      for (const fn of ["public.tw4_num_registration_retry(uuid,uuid)", "public.tw4_num_registration_gaps(uuid)"]) {
        expect(psql(`select has_function_privilege('service_role', '${fn}', 'execute')`)).toBe("t");
        for (const role of ["anon", "authenticated"]) expect(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`)).toBe("f");
      }
    });

    it("the number runner and registration entry points that carry an actor are not callable by the browser roles (the actor cannot be supplied or forged)", () => {
      for (const fn of ["public.tw4_num_observe(uuid,text,uuid,jsonb,text,text)", "public.tw4_num_begin(uuid,text,text,text,text,jsonb,uuid)", "public.tw4_num_retire(uuid,uuid,text)", "public.tw4_rfl_register(uuid,uuid,text,text,text,text,text,uuid,uuid)", "public.tw4_num_registration_retry(uuid,uuid)", "public.tw4_num_registration_gaps(uuid)"]) {
        for (const role of ["anon", "authenticated"]) expect(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
      }
    });

    it("a non-administrator cannot retry a registration", () => {
      const w = world();
      expect(callErr("tw4_num_registration_retry", w.studio, OUTSIDER)).not.toBe("");
    });
  });

  describe("migration shape and rollback", () => {
    const file = (name: string) => readFileSync(join(MIG, name), "utf8").replace(/\r/g, "");
    it("guards the five replaced bodies by fingerprint on apply, and the rollback restores and re-checks them", () => {
      const fwd = file("20261217090000_twilio_r2b_rfl_lifecycle_integration.sql");
      const rb = file("rollback/20261217090000_twilio_r2b_rfl_lifecycle_integration_rollback.sql");
      expect((fwd.match(/left\(md5\(replace\(/g) ?? []).length).toBe(5);
      expect((rb.match(/left\(md5\(replace\(/g) ?? []).length).toBe(5);
      expect(rb).toMatch(/was not restored byte-exactly/);
      // no API role is granted the system core
      expect(fwd).not.toMatch(/grant execute on function public\._tw4rfl_register_core/);
    });

    it("the rollback restores the previous behavior inside a transaction that is always rolled back, and this database keeps the migration", () => {
      const rb = file("rollback/20261217090000_twilio_r2b_rfl_lifecycle_integration_rollback.sql").split("\n").filter((line) => !/^(begin|commit);$/.test(line)).join("\n");
      const out = psql(`begin;\n${rb}\nselect to_regprocedure('public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)') is null;\nrollback;`);
      expect(out.split("\n").pop()).toBe("t");
      expect(psql(`select to_regprocedure('public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)') is not null`)).toBe("t");
    });
  });
});
