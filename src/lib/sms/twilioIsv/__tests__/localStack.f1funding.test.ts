/**
 * TW-4F F1 (20261219090000) against a REAL schema: the ConfiDance pilot's funding continuity is judged from per-period written approvals (tw4_rfl_pilot_cover) inside the
 * cumulative ceiling, the activation checklist requires healthy usage reconciliation, and tw4_act_mark_ready / activate / suspend take their locks in the order
 * tw4_num_retire and tw4_num_observe take them (no deadlock abort). Synthetic fixtures with fresh ids; fake provider evidence only (no Twilio, no SMS, no Stripe).
 * LOCAL QA ONLY: a DEDICATED Postgres with migrations ..20261217090000 (+ 20261218090000 when slice F3 is present) and 20261219090000 applied:
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4RFL_DB=postgres
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.f1funding.test.ts
 *
 * The last block rolls the migration back (committed), proves the old lock order deadlocks, and re-applies it: run it on a database nothing else is using.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `f1${RUN}-0000-4000-8000-000000000401`;
const OUTSIDER = `f1${RUN}-0000-4000-8000-000000000999`;
const MIG = join(__dirname, "../../../supabase/migrations");
const FWD = "20261219090000_twilio_act_pilot_funding_lock_order.sql";
const RB = "rollback/20261219090000_twilio_act_pilot_funding_lock_order_rollback.sql";
const FWD1226 = "20261226090000_twilio_act_console_gates.sql";
const RB1226 = "rollback/20261226090000_twilio_act_console_gates_rollback.sql";

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
const file = (name: string) => readFileSync(join(MIG, name), "utf8").replace(/\r/g, "");

const hex = (n: number) => randomBytes(n).toString("hex");
const sid = (prefix: string) => `${prefix}${hex(16)}`;
const digest = () => hex(32);
const ref = (label: string) => `Written approval ${RUN} ${label} ${hex(3)}`;
const e164 = () => `+12${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const NOTE = "documented reason for this activation step in the F1 suite";

type World = { entity: string; studio: string; owner: string; account: string; pilot: boolean };
// the business's own month (the key tw4_rfl_pilot_cover and the funding check use), never the UTC month
const cur = () => psql(`select public._tw4ml_month_key((select y.legal_entity_id from public.studio_sms_pilot_exceptions y limit 1), now())`);
const keyAdd = (k: string, n: number) => psql(`select public._tw4ml_key_add('${k}', ${n})`);

/** A synthetic business (or another location of the one pilot business) with an active subaccount, funded credit and onboarding access enabled. */
function world(opts: { pilot?: boolean } = {}): World {
  const w: World = { entity: randomUUID(), studio: randomUUID(), owner: randomUUID(), account: sid("AC"), pilot: Boolean(opts.pilot) };
  const people = `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${hex(4)}@f1funding-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'F1 ${hex(3)}', 'f1-${hex(4)}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);`;
  const access = `insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) values ('${w.studio}', true, 'fixture: F1 suite', '${P}');`;
  if (w.pilot) {
    // the platform allows exactly ONE pilot business: later pilot scenarios get a fresh LOCATION of it
    const existing = psql(`select y.legal_entity_id || '|' || t.twilio_account_sid from public.studio_sms_pilot_exceptions y join public.studio_sms_twilio_accounts t on t.legal_entity_id = y.legal_entity_id and t.status = 'active'`);
    if (existing) {
      [w.entity, w.account] = existing.split("|");
      psql(`begin; ${people} commit;`);
      replica(`insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now()); ${access}`);
      return w;
    }
  }
  psql(`begin; ${people}
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', '${w.pilot ? "ConfiDance Unlimited, LLC" : `F1 World ${hex(3)} LLC`}', '7777', ${w.pilot ? 15000 : 500000}, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: verified synthetic business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${w.entity}', '${w.account}', 'f1-${hex(3)}', 'test', 'active', '${P}');
commit;`);
  replica(access);
  call("tw4_credit_adjust", w.entity, 200_000, `f1-fund-${hex(4)}`, "fixture funding for the F1 suite", P);
  call("tw4_monthly_limit_set_admin", w.entity, P, 20_000, null, "fixture: monthly limit for the F1 suite");
  if (w.pilot) call("tw4_pilot_exception_create", w.entity, 15000, `Founder written pilot approval ${RUN}`, P);
  return w;
}

type Loc = World & { onboarding: string; op: string; pn: string; number: string; mg: string; qe: string };
/**
 * A location as R2a and R2b leave it: a verified Messaging Service and campaign (seeded provider truth), a provider-confirmed number purchase (observed, so it is
 * registered in the recurring-fee inventory in the same transaction) and, unless told otherwise, the campaign registered too.
 */
function location(o: { pilot?: boolean; purchaseReservation?: boolean; campaign?: boolean; registerCampaign?: boolean } = {}): Loc {
  const w = world({ pilot: o.pilot });
  const l: Loc = { ...w, onboarding: randomUUID(), op: randomUUID(), pn: sid("PN"), number: e164(), mg: sid("MG"), qe: sid("QE") };
  const selection = randomUUID();
  replica(`insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at, lease_owner, lease_expires_at)
    values ('${l.onboarding}', '${l.studio}', 'campaign_pending', 'F1 LLC', 'llc', '7777', 1, now(), 'lc', now() + interval '2 hours');
  insert into public.studio_sms_number_selections (id, offer_id, studio_id, legal_entity_id, twilio_account_sid, e164, price_cents, funding_mode, approver_user, approver_role, approval_ref, statement, expires_at, status, consumed_at, consumed_by_operation)
    values ('${selection}', '${randomUUID()}', '${l.studio}', '${l.entity}', '${l.account}', '${l.number}', 200, '${l.pilot ? "pilot" : "credit_recurring"}', '${l.owner}', 'studio_owner', '${ref("selection")}',
            'fixture: the owner approved this single number for purchase in the F1 suite', now() + interval '1 day', 'consumed', now(), '${l.op}');
  insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, selection_id, e164, friendly_name, request_digest, params,
                                                 provider_sid, fee_bearing, fee_kinds, started_by, finished_at)
    values ('${l.op}', '${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'number_purchase', 1, 1, 'succeeded', '${selection}', '${l.number}', 'fixture number', '${digest()}',
            '{"funding_mode":"${l.pilot ? "pilot" : "credit"}"}'::jsonb, '${l.pn}', true, array['number'], '${P}', now());`);
  if (o.purchaseReservation) {
    replica(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
      values ('${l.entity}', '${l.studio}', 'number', 200, 'pilot', 'captured', 'prov:${l.op}:number', now());`);
  }
  if (o.campaign !== false) {
    replica(`
    with ms as (insert into public.studio_sms_prov_operations (onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, provider_sid, started_by)
        values ('${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'messaging_service', 1, 1, 'succeeded', 'df:test:f1:ms', '${digest()}', '${l.mg}', '${P}') returning id),
         qe as (insert into public.studio_sms_prov_operations (onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, provider_sid,
                                                                fee_bearing, fee_kinds, started_by)
        values ('${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'campaign', 1, 1, 'succeeded', 'df:test:f1:c1', '${digest()}', '${l.qe}', true, array['campaign_vetting'], '${P}') returning id)
    insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, brand_sid, use_case, status, source, evidence_digest, verified_at)
      select ms.id, '${l.entity}'::uuid, '${l.studio}'::uuid, '${l.account}', 'messaging_service', '${l.mg}', null, null, null, 'ready', 'fake', '${digest()}', now() from ms
      union all select qe.id, '${l.entity}'::uuid, '${l.studio}'::uuid, '${l.account}', 'campaign', '${l.qe}', '${l.mg}', '${sid("BN")}', 'MIXED', 'verified', 'fake', '${digest()}', now() from qe;`);
  }
  const seen = call<{ status: string }>("tw4_num_observe", l.onboarding, "lc", l.op, { sid: l.pn, account_sid: l.account, phone_number: l.number, sms_capable: true }, "fake", digest());
  expect(seen.status).toBe("owned");
  if (o.campaign !== false && o.registerCampaign !== false) call("tw4_rfl_register", l.studio, P, "campaign", l.qe, l.account, null, "admin", null, null);
  return l;
}

const resource = (l: Loc, kind: "number" | "campaign") => psql(`select id from public.studio_sms_provider_resources where studio_id = '${l.studio}' and resource_kind = '${kind}' and provider_state = 'active'`);
const cover = (l: Loc, kind: "number" | "campaign", period: string) => call<{ cover_id: string; amount_cents: number }>("tw4_rfl_pilot_cover", resource(l, kind), period, ref(`${kind}-${period}`), P);
const coverErr = (l: Loc, kind: "number" | "campaign", period: string) => callErr("tw4_rfl_pilot_cover", resource(l, kind), period, ref(`${kind}-${period}`), P);
type Funding = { ok: boolean; detail: string; pilot?: boolean; period_key?: string; uncovered?: string[]; next_period_key?: string; next_period_needs_approval?: boolean; next_period_uncovered?: string[] };
const funding = (l: World) => call<Funding>("_tw4act_funding", l.studio);
type Item = { id: string; ok: boolean; detail: string };
const items = (l: World) => Object.fromEntries(call<Item[]>("_tw4act_items", l.studio).map((i) => [i.id, i])) as Record<string, Item>;
const pilotUsed = (w: World) => Number(psql(`select coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured')`));
const pilotCeiling = (w: World) => Number(psql(`select ceiling_cents from public.studio_sms_pilot_exceptions where legal_entity_id = '${w.entity}'`));
/** Puts the onboarding in a state the act_* functions accept, with no runner lease. */
const atState = (l: Loc, state: string) => replica(`update public.studio_sms_onboarding set state = '${state}', lease_owner = null, lease_expires_at = null where id = '${l.onboarding}';`);
/** Temporarily fills the pilot ceiling with a fixture reservation; returns a function that releases it again. */
const fillCeiling = (w: World, extraCents: number) => {
  const key = `f1-fill-${hex(4)}`;
  const amount = pilotCeiling(w) - pilotUsed(w) + extraCents;
  replica(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
    values ('${w.entity}', '${w.studio}', 'number', ${amount}, 'pilot', 'captured', '${key}', now());`);
  return () => replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where legal_entity_id = '${w.entity}' and reservation_key = '${key}';`);
};
/** Lets the pilot's ceiling room be reused between scenarios: releases this location's pilot reservations (fixture bookkeeping, not a product path). */
const releaseLocation = (w: World) =>
  replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where studio_id = '${w.studio}' and funding = 'pilot' and status <> 'released';`);

/** The main (20261208) body of _tw4act_funding, installed under another name inside a rolled-back transaction: the non-pilot path must answer exactly the same. */
const mainFundingBody = () => {
  const src = file("20261208090000_twilio_r2b_number_activation.sql").split("\n").slice(1588, 1622).join("\n");
  expect(src.startsWith("create or replace function public._tw4act_funding(p_studio_id uuid)")).toBe(true);
  return src.replace("public._tw4act_funding(p_studio_id uuid)", "public._f1_main_funding(p_studio_id uuid)");
};

/**
 * Deterministic lock interleave. Session A takes the onboarding row exactly as tw4_num_retire / tw4_num_observe take it first, waits, then runs the real function
 * (which takes the location link next). Session B runs the act_* function meanwhile. With one lock order B waits on the onboarding row holding nothing; with the
 * inverted order B holds the link and A's second lock closes a cycle (40P01).
 */
async function interleave(l: Loc, first: string, second: string) {
  const a = psqlAsync(`set application_name = 'f1-a-${RUN}';
begin;
select 1 from public.studio_sms_onboarding x where x.studio_id = '${l.studio}' and x.state <> 'cancelled' for update;
select pg_sleep(40);
${first}
commit;`);
  // every wait happens inside the database (docker exec latency on a loaded host is seconds): A holds the row and sleeps before B starts ...
  await psqlAsync(`do $$ begin for i in 1..1200 loop exit when exists (select 1 from pg_stat_activity where application_name = 'f1-a-${RUN}' and wait_event = 'PgSleep'); perform pg_sleep(0.05); perform pg_stat_clear_snapshot(); end loop; end $$;`);
  const b = psqlAsync(`set application_name = 'f1-b-${RUN}';\n${second}`);
  // ... and B is seen waiting on a lock before the link is probed: while B waits, nothing it took may block the location link
  const waiting = (await psqlAsync(`do $$ begin for i in 1..600 loop exit when exists (select 1 from pg_stat_activity where application_name = 'f1-b-${RUN}' and wait_event_type = 'Lock'); perform pg_sleep(0.05); perform pg_stat_clear_snapshot(); end loop; end $$;
select count(*) from pg_stat_activity where application_name = 'f1-b-${RUN}' and wait_event_type = 'Lock';`)).out;
  if (waiting !== "1") {
    const [ra, rb] = await Promise.all([a, b]);
    throw new Error(`B was not seen waiting on a lock while A slept: A=${JSON.stringify(ra)} B=${JSON.stringify(rb)}`);
  }
  const probe = psqlError(`begin; set local lock_timeout = '300ms'; select 1 from public.studio_sms_entity_studios es where es.studio_id = '${l.studio}' for no key update; rollback;`);
  const linkFree = probe === "" ? "free" : /55P03/.test(probe) ? "held" : `probe failed: ${probe}`;
  expect(psql(`select count(*) from pg_stat_activity where application_name = 'f1-a-${RUN}' and wait_event = 'PgSleep'`), "the probe must finish inside A's sleep").toBe("1");
  const [ra, rb] = await Promise.all([a, b]);
  return { a: ra, b: rb, linkFree };
}
const deadlocked = (r: { a: { err: string }; b: { err: string } }) => /deadlock detected|40P01/.test(r.a.err + r.b.err);

describe.skipIf(!enabled)("TW-4F F1: pilot funding continuity, reconciler gate and activation lock order (real schema)", () => {
  beforeAll(() => {
    psql(`create table if not exists public.tw4_local_qa_only (note text); revoke all on public.tw4_local_qa_only from public, anon, authenticated, service_role;`);
    expect(psql(`select to_regprocedure('public._tw4act_pilot_funding(uuid,uuid)') is not null`)).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@f1funding-e2e.test', now(), now(), now()),
         ('${OUTSIDER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'out-${RUN}@f1funding-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin'), ('${OUTSIDER}', null) on conflict (id) do update set platform_role = excluded.platform_role;
commit;`);
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150]] as const) {
      if (!psql(`select 1 from public.studio_sms_price_list where kind = '${kind}' and active`)) call("tw4_price_set", kind, customer, provider, `fixture ${kind} price`, P);
    }
  });

  describe("pilot funding continuity", () => {
    it("a pilot location with no period approval is blocked (fail closed, specific detail) and the check moves no money", () => {
      const l = location({ pilot: true });
      const before = pilotUsed(l);
      const f = funding(l);
      expect(f).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved", pilot: true, period_key: cur(), next_period_key: keyAdd(cur(), 1), next_period_needs_approval: true });
      expect(f.uncovered?.sort()).toEqual(["campaign", "number"]);
      expect(items(l).funding_continuity).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved" });
      // the old unconditional refusal is gone
      expect(JSON.stringify(f)).not.toContain("pilot_month_two_undefined");
      expect(pilotUsed(l)).toBe(before);
      releaseLocation(l);
    });

    it("written approvals for the CURRENT period of the number and the campaign pass; the next period is reported as still needing approval (not a pass)", () => {
      const l = location({ pilot: true });
      cover(l, "number", cur());
      expect(funding(l)).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved", uncovered: ["campaign"] });
      cover(l, "campaign", cur());
      const used = pilotUsed(l);
      const f = funding(l);
      expect(f).toMatchObject({ ok: true, detail: "ok", pilot: true, period_key: cur(), next_period_needs_approval: true });
      expect(f.next_period_uncovered?.sort()).toEqual(["campaign", "number"]);
      expect(items(l).funding_continuity).toMatchObject({ ok: true, detail: "ok" });
      // approving the next period clears the informational flag and is charged against the same cumulative ceiling (nothing is replenished)
      cover(l, "number", keyAdd(cur(), 1));
      cover(l, "campaign", keyAdd(cur(), 1));
      expect(funding(l)).toMatchObject({ ok: true, next_period_needs_approval: false, next_period_uncovered: [] });
      expect(pilotUsed(l)).toBe(used + 200 + 1000);
      releaseLocation(l);
    });

    it("an approval for the NEXT period only does not fund the current one", () => {
      const l = location({ pilot: true });
      cover(l, "number", keyAdd(cur(), 1));
      cover(l, "campaign", keyAdd(cur(), 1));
      const f = funding(l);
      expect(f).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved", next_period_needs_approval: false });
      expect(f.uncovered?.sort()).toEqual(["campaign", "number"]);
      releaseLocation(l);
    });

    it("the purchase's own first-period reservation covers the number's registration month; the campaign still needs its written approval", () => {
      const l = location({ pilot: true, purchaseReservation: true });
      expect(psql(`select basis from public.studio_sms_provider_cover where resource_id = '${resource(l, "number")}' and period_key = '${cur()}'`)).toBe("initial_reservation");
      expect(funding(l)).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved", uncovered: ["campaign"] });
      cover(l, "campaign", cur());
      expect(funding(l)).toMatchObject({ ok: true });
      releaseLocation(l);
    });

    it("a first-period reservation from an EARLIER month, bound at a late registration, funds nothing now (review P2); one from this month does", () => {
      const stale = location({ pilot: true, registerCampaign: false });
      cover(stale, "number", cur());
      const old = psql(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at, created_at)
        values ('${stale.entity}', '${stale.studio}', 'monthly', 1000, 'pilot', 'captured', 'prov:${randomUUID()}:monthly', now() - interval '40 days', now() - interval '40 days') returning id;`);
      call("tw4_rfl_register", stale.studio, P, "campaign", stale.qe, stale.account, null, "admin", null, old);
      // D5 (20261225): a cross-month reservation is not bound at registration, so no cover row exists; the funding check would not accept one either
      expect(psql(`select count(*) from public.studio_sms_provider_cover where resource_id = '${resource(stale, "campaign")}'`)).toBe("0");
      expect(funding(stale)).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved", uncovered: ["campaign"] });
      releaseLocation(stale);
      const fresh = location({ pilot: true, registerCampaign: false });
      cover(fresh, "number", cur());
      const now = psql(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
        values ('${fresh.entity}', '${fresh.studio}', 'monthly', 1000, 'pilot', 'captured', 'prov:${randomUUID()}:monthly', now()) returning id;`);
      call("tw4_rfl_register", fresh.studio, P, "campaign", fresh.qe, fresh.account, null, "admin", null, now);
      expect(funding(fresh)).toMatchObject({ ok: true });
      releaseLocation(fresh);
    });

    it("an expired period never counts (no retroactive approval is accepted; an earlier period's cover does not fund this one)", () => {
      const l = location({ pilot: true });
      const prev = keyAdd(cur(), -1);
      expect(hasCode(coverErr(l, "number", prev), "TW042")).toBe(true);
      // a cover row for the previous period (as an earlier month's approval leaves behind) funds nothing now
      for (const kind of ["number", "campaign"] as const) {
        replica(`with r as (insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
            values ('${l.entity}', '${l.studio}', '${kind === "number" ? "number" : "monthly"}', 100, 'pilot', 'captured', 'f1-prev-${hex(4)}', now()) returning id)
          insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, recorded_by)
          select '${resource(l, kind)}', '${l.entity}', '${l.studio}', '${prev}', 'initial_reservation', r.id, '${P}' from r;`);
      }
      expect(funding(l)).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved" });
      releaseLocation(l);
    });

    it("a released reservation, or one of another kind or location, funds nothing", () => {
      const l = location({ pilot: true });
      cover(l, "number", cur());
      cover(l, "campaign", cur());
      expect(funding(l).ok).toBe(true);
      const res = psql(`select reservation_id from public.studio_sms_provider_cover where resource_id = '${resource(l, "campaign")}' and period_key = '${cur()}'`);
      replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = '${res}';`);
      expect(funding(l)).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved", uncovered: ["campaign"] });
      // a cover pointing at a reservation of the wrong fee kind is not accepted
      replica(`update public.studio_sms_credit_reservations set status = 'captured', kind = 'brand' where id = '${res}';`);
      expect(funding(l)).toMatchObject({ ok: false, uncovered: ["campaign"] });
      replica(`update public.studio_sms_credit_reservations set kind = 'monthly' where id = '${res}';`);
      expect(funding(l).ok).toBe(true);
      releaseLocation(l);
    });

    it("at the ceiling the existing guard refuses the approval (TW007), no money moves, and activation funding stays blocked", () => {
      const l = location({ pilot: true });
      const restore = fillCeiling(l, 0);
      try {
        const used = pilotUsed(l);
        expect(used).toBe(pilotCeiling(l));
        expect(hasCode(coverErr(l, "number", cur()), "TW007")).toBe(true);
        expect(hasCode(coverErr(l, "campaign", cur()), "TW007")).toBe(true);
        expect(pilotUsed(l)).toBe(used);
        expect(funding(l)).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved" });
      } finally {
        restore();
      }
      releaseLocation(l);
    });

    it("a ceiling already exceeded (a defect elsewhere) blocks even fully covered periods", () => {
      const l = location({ pilot: true });
      cover(l, "number", cur());
      cover(l, "campaign", cur());
      const restore = fillCeiling(l, 1);
      try {
        expect(funding(l)).toMatchObject({ ok: false, detail: "pilot_ceiling_exceeded" });
      } finally {
        restore();
      }
      expect(funding(l).ok).toBe(true);
      releaseLocation(l);
    });

    it("a standing authorization for the pilot business (TW011 forbids it) or a credit hold blocks", () => {
      const l = location({ pilot: true });
      cover(l, "number", cur());
      cover(l, "campaign", cur());
      const auth = randomUUID();
      replica(`insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, starts_at, expires_at, status, authorized_by, statement)
        values ('${auth}', '${l.entity}', '${l.studio}', 'number', 200, 6, 1200, now() - interval '1 day', now() + interval '170 days', 'active', '${l.owner}', 'fixture: a standing authorization that must never exist for the pilot');`);
      try {
        expect(funding(l)).toMatchObject({ ok: false, detail: "pilot_standing_authorization_present" });
      } finally {
        replica(`delete from public.studio_sms_recurring_authorizations where id = '${auth}';`);
      }
      call("tw4_credit_set_hold", l.entity, true, "fixture: hold for the F1 suite", P);
      try {
        expect(funding(l)).toMatchObject({ ok: false, detail: "credit_on_hold" });
      } finally {
        call("tw4_credit_set_hold", l.entity, false, "fixture: hold lifted for the F1 suite", P);
      }
      expect(funding(l).ok).toBe(true);
      releaseLocation(l);
    });

    it("missing ledger facts or an unregistered resource fail closed with their own detail", () => {
      const noCampaign = location({ pilot: true, campaign: false });
      expect(funding(noCampaign)).toMatchObject({ ok: false, detail: "pilot_resources_unconfirmed" });
      const unregistered = location({ pilot: true, registerCampaign: false });
      expect(funding(unregistered)).toMatchObject({ ok: false, detail: "pilot_campaign_not_registered" });
      releaseLocation(noCampaign);
      releaseLocation(unregistered);
    });

    it("the funding exposure read lists an unfunded pilot location and drops it once the current period is approved", () => {
      const l = location({ pilot: true });
      atState(l, "ready_for_activation");
      const listed = () => call<Array<{ studio_id: string; reason: string }>>("tw4_act_exposure", P).filter((x) => x.studio_id === l.studio && x.reason === "funding_continuity").length;
      expect(listed()).toBe(1);
      cover(l, "number", cur());
      cover(l, "campaign", cur());
      expect(listed()).toBe(0);
      releaseLocation(l);
    });
  });

  describe("the non-pilot path is unchanged", () => {
    it("answers exactly as the 20261208 body for linked, unlinked, authorized, short, held and unfunded credit businesses", () => {
      const plain = location();
      const unlinked = randomUUID();
      const authorized = location();
      for (const kind of ["number", "monthly"]) {
        replica(`insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, starts_at, expires_at, status, authorized_by, statement)
          values ('${randomUUID()}', '${authorized.entity}', '${authorized.studio}', '${kind}', ${kind === "number" ? 200 : 1000}, 6, ${kind === "number" ? 1200 : 6000}, now() - interval '1 day', now() + interval '170 days', 'active', '${authorized.owner}', 'fixture: owner authorization for the F1 comparison');`);
      }
      const held = location();
      call("tw4_credit_set_hold", held.entity, true, "fixture: hold for the F1 comparison", P);
      const studios = [plain.studio, unlinked, authorized.studio, held.studio];
      const out = psql(`begin;
${mainFundingBody()}
select string_agg(public._f1_main_funding(s)::text || ' || ' || public._tw4act_funding(s)::text, E'\\n' order by ord) from unnest(array[${studios.map((s) => `'${s}'::uuid`).join(", ")}]) with ordinality as t(s, ord);
rollback;`);
      const rows = out.split("\n").filter((r) => r.includes(" || "));
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        const [main, now] = row.split(" || ");
        expect(JSON.parse(now)).toEqual(JSON.parse(main));
      }
      expect(JSON.parse(rows[1].split(" || ")[1])).toMatchObject({ ok: false, detail: "no_legal_entity" });
      expect(psql(`select to_regprocedure('public._f1_main_funding(uuid)') is null`)).toBe("t");
      call("tw4_credit_set_hold", held.entity, false, "fixture: hold lifted for the F1 comparison", P);
    });
  });

  describe("usage reconciliation is an activation condition", () => {
    // F3's helper may or may not be installed here: each case installs a stand-in inside a transaction that is always rolled back
    const withStub = (body: string, check: string) =>
      psql(`begin;
create or replace function public._tw4usage_reconciler_ready() returns jsonb language plpgsql stable as $$ begin ${body} end $$;
${check}
rollback;`).split("\n").pop() ?? "";
    const itemSql = (l: World) => `select (select i::text from jsonb_array_elements(public._tw4act_items('${l.studio}')) i where i ->> 'id' = 'usage_reconciler_ready');`;

    it("absent helper: the item fails closed", () => {
      const l = location({ pilot: true });
      if (psql(`select to_regprocedure('public._tw4usage_reconciler_ready()') is null`) === "t") {
        expect(items(l).usage_reconciler_ready).toEqual({ id: "usage_reconciler_ready", ok: false, detail: "reconciler_gate_not_installed" });
      } else {
        // F3 installed: hide it inside a rolled-back transaction
        const out = psql(`begin; alter function public._tw4usage_reconciler_ready() rename to _f1_hidden_reconciler_ready; ${itemSql(l)} rollback;`).split("\n").pop() ?? "";
        expect(JSON.parse(out)).toEqual({ id: "usage_reconciler_ready", ok: false, detail: "reconciler_gate_not_installed" });
      }
      releaseLocation(l);
    });

    it("with F3's real helper (20261218): no run blocks; a fresh completed evidence-reading run passes (seeded in a rolled-back transaction)", () => {
      if (psql(`select to_regprocedure('public._tw4usage_reconciler_ready()') is null`) === "t") return;   // F3 not applied on this database: covered by the case above
      const l = location({ pilot: true });
      expect(items(l).usage_reconciler_ready).toMatchObject({ ok: false, detail: "no_completed_run" });
      const out = psql(`begin;
insert into public.studio_sms_reconcile_runs (job, runner, status, started_at, lease_expires_at, finished_at, summary)
  values ('usage_reconcile', 'f1-${RUN}', 'completed', now() - interval '1 minute', now() + interval '4 minutes', now(), '{"evidence_read": true, "due": 0}'::jsonb);
${itemSql(l)}
rollback;`).split("\n").pop() ?? "";
      expect(JSON.parse(out)).toEqual({ id: "usage_reconciler_ready", ok: true, detail: "ok" });
      releaseLocation(l);
    });

    it("not ready, unreadable or malformed blocks; only a boolean ok=true passes", () => {
      const l = location({ pilot: true });
      expect(JSON.parse(withStub(`return jsonb_build_object('ok', false, 'detail', 'last_run_stale', 'last_success_at', now() - interval '3 days');`, itemSql(l)))).toEqual({ id: "usage_reconciler_ready", ok: false, detail: "last_run_stale" });
      expect(JSON.parse(withStub(`raise exception 'boom';`, itemSql(l)))).toEqual({ id: "usage_reconciler_ready", ok: false, detail: "reconciler_error" });
      expect(JSON.parse(withStub(`return jsonb_build_object('ok', 'true');`, itemSql(l)))).toMatchObject({ ok: false, detail: "reconciler_not_ready" });
      expect(JSON.parse(withStub(`return null;`, itemSql(l)))).toMatchObject({ ok: false, detail: "reconciler_not_ready" });
      expect(JSON.parse(withStub(`return jsonb_build_object('ok', true, 'detail', 'ok', 'last_success_at', now());`, itemSql(l)))).toEqual({ id: "usage_reconciler_ready", ok: true, detail: "ok" });
      releaseLocation(l);
    });

    it("activation and mark-ready are refused while reconciliation is not ready, and the refusal names it (and funding, until the period is approved)", () => {
      const l = location({ pilot: true });
      atState(l, "ready_for_activation");
      const err = psqlError(`begin;
create or replace function public._tw4usage_reconciler_ready() returns jsonb language plpgsql stable as $$ begin return jsonb_build_object('ok', false, 'detail', 'last_run_failed'); end $$;
select public.tw4_act_activate('${l.studio}', '${P}', '${NOTE}');
rollback;`);
      expect(hasCode(err, "TW042")).toBe(true);
      expect(err).toContain("usage_reconciler_ready:last_run_failed");
      expect(err).toContain("funding_continuity:pilot_current_period_unapproved");
      // once the period is approved, funding drops out of the refusal; reconciliation still blocks
      cover(l, "number", cur());
      cover(l, "campaign", cur());
      const err2 = psqlError(`begin;
create or replace function public._tw4usage_reconciler_ready() returns jsonb language plpgsql stable as $$ begin return jsonb_build_object('ok', false, 'detail', 'last_run_failed'); end $$;
select public.tw4_act_activate('${l.studio}', '${P}', '${NOTE}');
rollback;`);
      expect(hasCode(err2, "TW042")).toBe(true);
      expect(err2).toContain("usage_reconciler_ready:last_run_failed");
      expect(err2).not.toContain("funding_continuity");
      atState(l, "campaign_pending");
      const err3 = callErr("tw4_act_mark_ready", l.studio, P, NOTE);
      expect(hasCode(err3, "TW042")).toBe(true);
      // F3 absent: not installed; F3 present on a fresh database: no completed run yet
      expect(err3).toMatch(/usage_reconciler_ready:(reconciler_gate_not_installed|no_completed_run)(,|\n)/);
      expect(psql(`select state from public.studio_sms_onboarding where id = '${l.onboarding}'`)).toBe("campaign_pending");
      releaseLocation(l);
    });
  });

  describe("lock order: act_* versus tw4_num_retire / tw4_num_observe", () => {
    it("activate waits on the onboarding row holding nothing while retire holds it; retire then takes the link: no deadlock abort", async () => {
      const l = location();
      atState(l, "ready_for_activation");
      const r = await interleave(l, callSql("tw4_num_retire", l.studio, P, "Released at the provider console, per the owner"), callSql("tw4_act_activate", l.studio, P, NOTE));
      expect(deadlocked(r)).toBe(false);
      expect(r.linkFree).toBe("free");
      // each side ends on its own business answer, never a lock failure
      expect(hasCode(r.a.err, "TW034")).toBe(true);
      expect(hasCode(r.b.err, "TW042")).toBe(true);
    });

    it("mark-ready and suspend take the same order", async () => {
      const ready = location();
      atState(ready, "campaign_pending");
      const r1 = await interleave(ready, callSql("tw4_num_retire", ready.studio, P, "Released at the provider console, per the owner"), callSql("tw4_act_mark_ready", ready.studio, P, NOTE));
      expect(deadlocked(r1)).toBe(false);
      expect(r1.linkFree).toBe("free");
      const active = location();
      atState(active, "active");
      const r2 = await interleave(active, callSql("tw4_num_retire", active.studio, P, "Released at the provider console, per the owner"), callSql("tw4_act_suspend", active.studio, P, NOTE));
      expect(deadlocked(r2)).toBe(false);
      expect(r2.linkFree).toBe("free");
      expect(r2.b.err).toBe("");
      expect(psql(`select state from public.studio_sms_onboarding where id = '${active.onboarding}'`)).toBe("suspended");
    });

    it("suspend against an observe read-back mismatch (the observe branch that takes the link) does not deadlock", async () => {
      const l = location();
      atState(l, "active");
      replica(`update public.studio_sms_onboarding set lease_owner = 'lc', lease_expires_at = now() + interval '1 hour' where id = '${l.onboarding}';`);
      const r = await interleave(l, callSql("tw4_num_observe", l.onboarding, "lc", l.op, { sid: sid("PN"), account_sid: l.account, phone_number: l.number, sms_capable: true }, "fake", digest()),
        callSql("tw4_act_suspend", l.studio, P, NOTE));
      expect(deadlocked(r)).toBe(false);
      expect(r.linkFree).toBe("free");
      expect(r.a.err).toBe("");
      // observe moved the location to exception first; suspend then found nothing active to suspend
      expect(hasCode(r.b.err, "TW030")).toBe(true);
    });

    it("free-running pairs (no injected wait) never abort on a deadlock", async () => {
      for (let i = 0; i < 6; i += 1) {
        const l = location();
        atState(l, i % 2 === 0 ? "ready_for_activation" : "active");
        const results = await Promise.all([
          psqlAsync(callSql("tw4_num_retire", l.studio, P, "Released at the provider console, per the owner")),
          psqlAsync(callSql(i % 2 === 0 ? "tw4_act_activate" : "tw4_act_suspend", l.studio, P, NOTE)),
          psqlAsync(callSql("tw4_num_retire", l.studio, P, "Released at the provider console, per the owner")),
        ]);
        for (const r of results) expect(r.err).not.toMatch(/deadlock detected|40P01/);
      }
    });
  });

  describe("privileges", () => {
    it("the new helper has no API-role privilege; the act_* entry points keep exactly their service-role grant", () => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(psql(`select has_function_privilege('${role}', 'public._tw4act_pilot_funding(uuid,uuid)', 'execute')`), role).toBe("f");
        for (const fn of ["_tw4act_funding(uuid)", "_tw4act_items(uuid)"]) expect(psql(`select has_function_privilege('${role}', 'public.${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
      }
      for (const fn of ["tw4_act_mark_ready(uuid,uuid,text)", "tw4_act_activate(uuid,uuid,text)", "tw4_act_suspend(uuid,uuid,text)"]) {
        expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
        for (const role of ["anon", "authenticated"]) expect(psql(`select has_function_privilege('${role}', 'public.${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
      }
    });

    it("a non-administrator cannot activate, mark ready or suspend", () => {
      const l = location();
      for (const fn of ["tw4_act_activate", "tw4_act_mark_ready", "tw4_act_suspend"]) expect(hasCode(callErr(fn, l.studio, OUTSIDER, NOTE), "42501"), fn).toBe(true);
    });
  });

  describe("migration shape, rollback and the deadlock control", () => {
    it("guards the five replaced bodies by fingerprint on apply; the rollback re-checks them and restores the 20261208 bodies", () => {
      const fwd = file(FWD);
      const rb = file(RB);
      expect((fwd.match(/left\(md5\(replace\(/g) ?? []).length).toBe(5);
      expect((rb.match(/left\(md5\(replace\(/g) ?? []).length).toBe(11);
      expect(fwd).not.toMatch(/tw4_rfl_pilot_cover\(.*\)\s*returns/);   // the pilot approval path is not redefined (U-4)
      expect(fwd).not.toMatch(/function public\.tw4_num_(retire|observe)\(/);   // retire / observe are not touched (R2b / F4)
      expect(fwd).not.toMatch(/grant execute on function public\._tw4act_pilot_funding/);
    });

    it("rolled back (committed), the old act_* order deadlocks against retire; re-applied, it does not and the fingerprint returns", async () => {
      const fp = () => psql(`select md5(string_agg(p.oid::regprocedure::text || '|' || md5(replace(p.prosrc, chr(13), '')) || '|' || coalesce(array_to_string(p.proacl, ','), ''), E'\\n' order by p.oid::regprocedure::text))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
      const withMigration = fp();
      // J4's 20261226 replaces two 1219 bodies: while it is applied, 1219's rollback must refuse ("roll back the later migration first") and change nothing.
      // The control below then rolls 1226 back first and re-applies it last, so the database ends exactly as it started.
      const with1226 = psql(`select position('pilot_ki1_redecided' in p.prosrc) > 0 from pg_proc p where p.oid = 'public._tw4act_items(uuid)'::regprocedure`) === "t";
      if (with1226) {
        const refused = psqlError(file(RB));
        expect(hasCode(refused, "P0001")).toBe(true);
        expect(refused).toContain("roll back the later migration first");
        expect(fp()).toBe(withMigration);
        psql(file(RB1226));
      }
      psql(file(RB));
      try {
        expect(psql(`select to_regprocedure('public._tw4act_pilot_funding(uuid,uuid)') is null`)).toBe("t");
        const l = location({ pilot: true });
        expect(funding(l)).toEqual({ ok: false, detail: "pilot_month_two_undefined" });
        releaseLocation(l);
        const d = location();
        atState(d, "ready_for_activation");
        const r = await interleave(d, callSql("tw4_num_retire", d.studio, P, "Released at the provider console, per the owner"), callSql("tw4_act_activate", d.studio, P, NOTE));
        expect(r.linkFree).toBe("held");
        expect(deadlocked(r)).toBe(true);
      } finally {
        psql(file(FWD));
        if (with1226) psql(file(FWD1226));
      }
      expect(fp()).toBe(withMigration);
      expect(hasCode(psqlError(file(FWD)), "P0001")).toBe(true);   // already applied: refused
    });
  });
});
