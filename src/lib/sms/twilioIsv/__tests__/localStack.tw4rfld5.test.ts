/**
 * TW-4F RFL decision D5 (20261225090000) against a REAL schema: a resource's own pilot reservation covers the REGISTRATION period only while it is reserved/captured AND
 * was made in the registration month (cr.created_at); otherwise the resource registers with no cover and the period needs its own written approval, which may SUPERSEDE a
 * registration-time cover that no longer counts (never a counting cover, never a written approval). Readiness and _tw4rfl_cover agree. Synthetic fixtures with fresh ids;
 * nothing reaches Twilio, Stripe or any SMS path.
 *
 * LOCAL QA ONLY: a DEDICATED Postgres with migrations 20261207090000 .. 20261217090000 and 20261225090000 applied and the local-QA marker table (public.tw4_local_qa_only):
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4RFL_DB=<database>
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.tw4rfld5.test.ts
 *
 * Run it SERIALLY with the other RFL suites (one pilot business, one shared switch state); never against a shared stack.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { evidenceApplied, pilotCoverArgs, pilotExceptionArgs } from "./rflEvidenceHelper";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `ad${RUN}-0000-4000-8000-000000000501`; // platform admin
const P2 = `ad${RUN}-0000-4000-8000-000000000502`;

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

type World = { entity: string; studio: string; owner: string; account: string; n: number };
let worldSeq = 0;
const PRICE = { number: 0 };
const cur = () => psql("select to_char(now() at time zone 'UTC', 'YYYY-MM')");
const keyAdd = (key: string, n: number) => psql(`select to_char((${lit(key + "-01")}::date + make_interval(months => ${n})), 'YYYY-MM')`);

/** The platform allows exactly ONE pilot business: every scenario gets a fresh LOCATION of it, a reset ceiling and an account without a hold. */
let pilotShared: { entity: string; account: string } | null = null;
function pilotWorld(opts: { ceiling?: number } = {}): World {
  worldSeq += 1;
  if (!pilotShared) {
    const existing = psql(`select y.legal_entity_id || '|' || t.twilio_account_sid from public.studio_sms_pilot_exceptions y join public.studio_sms_twilio_accounts t on t.legal_entity_id = y.legal_entity_id and t.status = 'active'`);
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
  values ('${owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pilot-${RUN}@d5-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${studio}', 'D5 pilot founding', 'd5-pilot-${RUN}', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${entity}', 'ConfiDance Unlimited, LLC', '9999', 15000, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${studio}', '${entity}', 'founding', '${P}', 'fixture: verified synthetic pilot business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${entity}', '${account}', 'd5-pilot', 'test', 'active', '${P}');
commit;`);
      call("tw4_credit_adjust", entity, 200_000, `d5-fund-pilot-${RUN}`, "fixture funding for the D5 suite", P);
      call("tw4_monthly_limit_set_admin", entity, P, 20_000, null, "fixture: monthly limit for the D5 suite");
      call("tw4_pilot_exception_create", ...pilotExceptionArgs(psql, entity, 15000, `Founder written pilot approval ${RUN}`, P));
      pilotShared = { entity, account };
    }
  }
  const w: World = { entity: pilotShared.entity, studio: randomUUID(), owner: randomUUID(), account: pilotShared.account, n: worldSeq };
  replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = coalesce(closed_at, now()) where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured');
    update public.studio_sms_spend_events set status = 'void' where legal_entity_id = '${w.entity}' and status in ('authorized', 'reserved');
    update public.studio_sms_pilot_exceptions set ceiling_cents = ${opts.ceiling ?? 15000} where legal_entity_id = '${w.entity}';
    update public.studio_sms_credit_accounts set hold = false, hold_reason = null, balance_cents = greatest(balance_cents, 100000) where legal_entity_id = '${w.entity}';`);
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${RUN}-${w.n}@d5-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'D5 pilot ${RUN} ${w.n}', 'd5-pilot-${RUN}-${w.n}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
commit;
begin; set local session_replication_role = replica;
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now());
commit;`);
  return w;
}

/** A pilot-funded reservation for a resource's fee, made `ageDays` ago (a fixture row: the real reservation paths are exercised elsewhere). */
const resv = (w: World, o: { ageDays?: number; status?: "reserved" | "captured" | "released"; kind?: string; funding?: "pilot" | "credit" } = {}): string => {
  const id = randomUUID();
  const status = o.status ?? "captured";
  replica(`insert into public.studio_sms_credit_reservations (id, legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at, created_at)
    values ('${id}', '${w.entity}', '${w.studio}', '${o.kind ?? "number"}', 100, '${o.funding ?? "pilot"}', '${status}', 'init:${id}', ${status === "reserved" ? "null" : "now()"}, now() - interval '${o.ageDays ?? 0} days');`);
  return id;
};
const registerNumber = (w: World, reservation: string | null = null) => {
  const providerSid = sid("PN");
  const out = call<{ resource_id: string; replayed: boolean; fee_kind: string; initial_cover_skipped?: string }>(
    "tw4_rfl_register", w.studio, P, "number", providerSid, w.account, e164(), "admin", null, reservation);
  return { ...out, sid: providerSid };
};
const coverOf = (resourceId: string, key = cur()) => psql(`select public._tw4rfl_cover(r, '${key}') from public.studio_sms_provider_resources r where r.id = '${resourceId}'`);
type CoverRow = { id: string; basis: string; period: string; reservation: string; sup: boolean; reason: string | null; by: string | null; by_cover: string | null; ref: string | null };
const rows = (resourceId: string) =>
  JSON.parse(psql(`select coalesce(json_agg(json_build_object('id', id, 'basis', basis, 'period', period_key, 'reservation', reservation_id, 'sup', superseded_at is not null, 'reason', superseded_reason,
    'by', superseded_by, 'by_cover', superseded_by_cover_id, 'ref', approval_ref) order by created_at), '[]'::json)::text from public.studio_sms_provider_cover where resource_id = '${resourceId}'`)) as CoverRow[];
const audit = (w: World, action: string) => Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = '${action}'`));
const blockers = (w: World) => call<{ blockers: string[] }>("tw4_rfl_studio_ready", w.studio).blockers;
const pilotCover = (resourceId: string, key: string, approval: string, actor = P) => call<{ cover_id: string; replayed: boolean }>("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, resourceId, key, approval, actor));
const pilotCoverErr = (resourceId: string, key: string, approval: string, actor = P) => callErr("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, resourceId, key, approval, actor));
/** Makes a registration-time cover that no longer counts, the two ways the rule defines: released reservation (bound while valid), or a cross-month row left by the old rule. */
const releasedBound = (w: World) => {
  const rv = resv(w);
  const num = registerNumber(w, rv);
  expect(coverOf(num.resource_id)).toBe("covered:initial_reservation");
  replica(`update public.studio_sms_credit_reservations set status = 'released' where id = '${rv}';`);
  return { num, rv };
};
const legacyCrossMonth = (w: World) => {
  const num = registerNumber(w, null);
  const rv = resv(w, { ageDays: 40 });
  replica(`insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, recorded_by)
    values ('${num.resource_id}', '${w.entity}', '${w.studio}', '${cur()}', 'initial_reservation', '${rv}', '${P}');`);
  return { num, rv };
};

describe.skipIf(!enabled)("TW-4F RFL D5: registration cover month rule and supersede path (real schema)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`)).toBe("t");
    expect(psql(`select to_regclass('public.studio_sms_provider_resources') is not null`)).toBe("t");
    expect(psql(`select exists (select 1 from pg_attribute where attrelid = 'public.studio_sms_provider_cover'::regclass and attname = 'superseded_at' and not attisdropped)`)).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@d5-e2e.test', now(), now(), now()),
         ('${P2}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin2-${RUN}@d5-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin'), ('${P2}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
commit;`);
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150]] as const) {
      if (!psql(`select 1 from public.studio_sms_price_list where kind = '${kind}' and active`)) call("tw4_price_set", kind, customer, provider, `fixture ${kind} price`, P);
    }
    PRICE.number = Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = 'number' and active`));
  });

  describe("registration", () => {
    it("same-month reservation: the cover binds and counts; readiness and _tw4rfl_cover agree", () => {
      const w = pilotWorld();
      const num = registerNumber(w, resv(w));
      expect(num.initial_cover_skipped).toBeUndefined();
      expect(rows(num.resource_id).map((r) => [r.basis, r.period, r.sup])).toEqual([["initial_reservation", cur(), false]]);
      expect(coverOf(num.resource_id)).toBe("covered:initial_reservation");
      expect(blockers(w)).not.toContain("number_current_period_uncovered");
      expect(audit(w, "rfl_initial_cover_skipped")).toBe(0);
      expect(psql(`select note like '%initial_cover=true%' from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'rfl_registered'`)).toBe("t");
    });

    it("cross-month reservation through the admin path: the resource registers, NO cover binds, the skip is audited, readiness agrees, and the written approval then succeeds", () => {
      const w = pilotWorld();
      const num = registerNumber(w, resv(w, { ageDays: 40 }));
      expect(num.replayed).toBe(false);
      expect(num.initial_cover_skipped).toBe("month_mismatch");
      expect(rows(num.resource_id)).toHaveLength(0);
      expect(audit(w, "rfl_initial_cover_skipped")).toBe(1);
      expect(psql(`select note from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'rfl_initial_cover_skipped'`)).toContain("reason=reservation_month_differs_from_registration_month");
      expect(psql(`select note like '%initial_cover=false%' from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'rfl_registered'`)).toBe("t");
      expect(coverOf(num.resource_id)).toMatch(/^uncovered:/);
      expect(blockers(w)).toContain("number_current_period_uncovered");
      const out = pilotCover(num.resource_id, cur(), ref("after-cross-month"));
      expect(out.replayed).toBe(false);
      expect(coverOf(num.resource_id)).toBe("covered:pilot_approval");
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(0);
      expect(blockers(w)).not.toContain("number_current_period_uncovered");
    });

    it("a released reservation or the wrong fee or business is still refused at registration (TW040), as before", () => {
      const w = pilotWorld();
      expect(hasCode(callErr("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, e164(), "admin", null, resv(w, { status: "released" })), "TW040")).toBe(true);
      expect(hasCode(callErr("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, e164(), "admin", null, resv(w, { kind: "monthly" })), "TW040")).toBe(true);
    });

    it("a CREDIT-funded reservation is never cover: registration succeeds without it (audited as not pilot-funded), readiness agrees, and the written approval then succeeds", () => {
      const w = pilotWorld();
      const num = registerNumber(w, resv(w, { funding: "credit" }));
      expect(num.initial_cover_skipped).toBe("not_pilot_funded");
      expect(rows(num.resource_id)).toHaveLength(0);
      expect(audit(w, "rfl_initial_cover_skipped")).toBe(1);
      expect(psql(`select note from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'rfl_initial_cover_skipped'`)).toContain("reason=reservation_not_pilot_funded");
      expect(coverOf(num.resource_id)).toMatch(/^uncovered:/);
      expect(blockers(w)).toContain("number_current_period_uncovered");
      pilotCover(num.resource_id, cur(), ref("after-credit-funded"));
      expect(coverOf(num.resource_id)).toBe("covered:pilot_approval");
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(0);
    });

    it("a pilot-funded same-month reservation of this business, location and fee still binds and counts", () => {
      const w = pilotWorld();
      const num = registerNumber(w, resv(w, { funding: "pilot", status: "reserved" }));
      expect(num.initial_cover_skipped).toBeUndefined();
      expect(coverOf(num.resource_id)).toBe("covered:initial_reservation");
      expect(blockers(w)).not.toContain("number_current_period_uncovered");
    });

    it("the ledger straddle: the operation's started_at is in the current month but the reservation's created_at is not; the RFL rule keys on cr.created_at (a non-counting cover that the supersede path handles)", () => {
      const w = pilotWorld();
      const onboarding = randomUUID();
      const op = randomUUID();
      const selection = randomUUID();
      const pn = sid("PN");
      const number = e164();
      replica(`insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at, lease_owner, lease_expires_at)
        values ('${onboarding}', '${w.studio}', 'campaign_pending', 'D5 LLC', 'llc', '7777', 1, now(), 'lc', now() + interval '2 hours');
      insert into public.studio_sms_number_selections (id, offer_id, studio_id, legal_entity_id, twilio_account_sid, e164, price_cents, funding_mode, approver_user, approver_role, approval_ref, statement, expires_at, status, consumed_at, consumed_by_operation)
        values ('${selection}', '${randomUUID()}', '${w.studio}', '${w.entity}', '${w.account}', '${number}', 200, 'pilot', '${w.owner}', 'studio_owner', '${ref("selection")}',
                'fixture: the owner approved this single number for purchase in the D5 suite', now() + interval '1 day', 'consumed', now(), '${op}');
      insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, selection_id, e164, friendly_name, request_digest, params,
                                                     provider_sid, fee_bearing, fee_kinds, started_by, finished_at)
        values ('${op}', '${onboarding}', '${w.studio}', '${w.entity}', '${w.account}', 'number_purchase', 1, 1, 'succeeded', '${selection}', '${number}', 'fixture number', '${digest()}',
                '{"funding_mode":"pilot"}'::jsonb, '${pn}', true, array['number'], '${P}', now());
      insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at, created_at)
        values ('${w.entity}', '${w.studio}', 'number', 200, 'pilot', 'captured', 'prov:${op}:number', now(), now() - interval '40 days');`);
      // R2b's helper keys the month on the operation's started_at (current month): it returns the reservation ...
      expect(psql(`select public._tw4num_ledger_reservation('${op}') is not null`)).toBe("t");
      // ... and the RFL core keys on the reservation's own created_at: no cover binds (the purchase's money was set aside in another month)
      call("tw4_num_observe", onboarding, "lc", op, JSON.stringify({ sid: pn, account_sid: w.account, phone_number: number, sms_capable: true }), "fake", digest());
      const res = psql(`select id from public.studio_sms_provider_resources where studio_id = '${w.studio}' and resource_kind = 'number'`);
      expect(res).not.toBe("");
      expect(rows(res)).toHaveLength(0);
      expect(audit(w, "rfl_initial_cover_skipped")).toBe(1);
      expect(coverOf(res)).toMatch(/^uncovered:/);
      // the supersede path handles the same shape when an old-rule cover row exists for it
      const rv = psql(`select id from public.studio_sms_credit_reservations where reservation_key = 'prov:${op}:number'`);
      replica(`insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, recorded_by)
        values ('${res}', '${w.entity}', '${w.studio}', '${cur()}', 'initial_reservation', '${rv}', '${P}');`);
      expect(coverOf(res)).toMatch(/^uncovered:/);
      pilotCover(res, cur(), ref("straddle"));
      expect(rows(res).map((r) => [r.basis, r.sup, r.reason])).toEqual([["initial_reservation", true, "reservation_month_differs"], ["pilot_approval", false, null]]);
      // and the reverse straddle: an operation from an earlier month yields no ledger reservation at all (R2b's own rule), so nothing binds either
      replica(`update public.studio_sms_num_operations set started_at = started_at - interval '40 days' where id = '${op}';`);
      expect(psql(`select public._tw4num_ledger_reservation('${op}') is null`)).toBe("t");
    });
  });

  describe("supersede", () => {
    it("a bound cover whose reservation was released is not coverage, then a written approval supersedes it: old row preserved, evidence and audit written, replay-safe", () => {
      const w = pilotWorld();
      const { num, rv } = releasedBound(w);
      expect(coverOf(num.resource_id)).toMatch(/^uncovered:/); // not covered in between
      expect(blockers(w)).toContain("number_current_period_uncovered");
      const approval = ref("supersede-released");
      const out = pilotCover(num.resource_id, cur(), approval);
      expect(out.replayed).toBe(false);
      const all = rows(num.resource_id);
      expect(all).toHaveLength(2);
      const [old, fresh] = all;
      expect([old.basis, old.sup, old.reason, old.by, old.by_cover, old.reservation]).toEqual(["initial_reservation", true, "reservation_not_counting", P, out.cover_id, rv]);
      expect([fresh.id, fresh.basis, fresh.sup, fresh.ref]).toEqual([out.cover_id, "pilot_approval", false, approval.trim()]);
      expect(audit(w, "rfl_cover_superseded")).toBe(1);
      expect(audit(w, "rfl_cover_recorded")).toBe(1);
      expect(coverOf(num.resource_id)).toBe("covered:pilot_approval");
      expect(blockers(w)).not.toContain("number_current_period_uncovered");
      // replay: the same approval by the same actor changes nothing; another reference finds a counting approval (TW043)
      expect(pilotCover(num.resource_id, cur(), approval).replayed).toBe(true);
      expect(rows(num.resource_id)).toHaveLength(2);
      expect(audit(w, "rfl_cover_superseded")).toBe(1);
      expect(hasCode(pilotCoverErr(num.resource_id, cur(), ref("second")), "TW043")).toBe(true);
    });

    it("an old-rule cross-month row (counted by nothing now) is superseded with its own reason; the reservation stays captured and counts toward the ceiling", () => {
      const w = pilotWorld();
      const { num, rv } = legacyCrossMonth(w);
      expect(coverOf(num.resource_id)).toMatch(/^uncovered:/);
      expect(blockers(w)).toContain("number_current_period_uncovered");
      const out = pilotCover(num.resource_id, cur(), ref("supersede-cross-month"));
      const [old] = rows(num.resource_id);
      expect([old.sup, old.reason, old.reservation, old.by_cover]).toEqual([true, "reservation_month_differs", rv, out.cover_id]);
      expect(psql(`select status from public.studio_sms_credit_reservations where id = '${rv}'`)).toBe("captured");
      expect(coverOf(num.resource_id)).toBe("covered:pilot_approval");
    });

    it("a reservation that is released AND from another month is superseded too (the not-counting case wins)", () => {
      const w = pilotWorld();
      const { num, rv } = legacyCrossMonth(w);
      replica(`update public.studio_sms_credit_reservations set status = 'released' where id = '${rv}';`);
      pilotCover(num.resource_id, cur(), ref("both"));
      expect(rows(num.resource_id)[0].reason).toBe("reservation_not_counting");
    });

    it("a pre-existing credit-funded initial_reservation cover row is not coverage and is superseded by a written approval (reason: not pilot-funded); the reservation is left as it was", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const rv = resv(w, { funding: "credit" });
      replica(`insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, recorded_by)
        values ('${num.resource_id}', '${w.entity}', '${w.studio}', '${cur()}', 'initial_reservation', '${rv}', '${P}');`);
      expect(coverOf(num.resource_id)).toMatch(/^uncovered:/);
      expect(blockers(w)).toContain("number_current_period_uncovered");
      const out = pilotCover(num.resource_id, cur(), ref("supersede-credit-funded"));
      const [old, fresh] = rows(num.resource_id);
      expect([old.sup, old.reason, old.reservation, old.by_cover, fresh.id]).toEqual([true, "reservation_not_pilot_funded", rv, out.cover_id, out.cover_id]);
      expect(psql(`select status || ':' || funding from public.studio_sms_credit_reservations where id = '${rv}'`)).toBe("captured:credit");
      expect(coverOf(num.resource_id)).toBe("covered:pilot_approval");
    });

    it("a valid counting initial_reservation cover is never superseded: TW043, nothing changes", () => {
      const w = pilotWorld();
      const num = registerNumber(w, resv(w));
      expect(hasCode(pilotCoverErr(num.resource_id, cur(), ref("counting")), "TW043")).toBe(true);
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(0);
      expect(rows(num.resource_id)).toHaveLength(1);
      expect(coverOf(num.resource_id)).toBe("covered:initial_reservation");
      // a still-RESERVED (not captured) same-month reservation counts too
      const w2 = pilotWorld();
      const n2 = registerNumber(w2, resv(w2, { status: "reserved" }));
      expect(hasCode(pilotCoverErr(n2.resource_id, cur(), ref("reserved")), "TW043")).toBe(true);
    });

    it("a pilot_approval cover is never superseded, even when its own reservation was released: TW043", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const out = pilotCover(num.resource_id, cur(), ref("first-approval"));
      expect(hasCode(pilotCoverErr(num.resource_id, cur(), ref("other-approval")), "TW043")).toBe(true);
      replica(`update public.studio_sms_credit_reservations set status = 'released' where id = (select reservation_id from public.studio_sms_provider_cover where id = '${out.cover_id}');`);
      expect(coverOf(num.resource_id)).toMatch(/^uncovered:/); // a released approval reservation is not coverage ...
      expect(hasCode(pilotCoverErr(num.resource_id, cur(), ref("third-approval")), "TW043")).toBe(true); // ... and the written approval cannot be replaced by another
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(0);
    });

    it("the cumulative ceiling is enforced on a superseding approval (TW007), and a refusal leaves the old row unsuperseded", () => {
      const w = pilotWorld({ ceiling: PRICE.number - 1 });
      const { num } = releasedBound(w);
      expect(hasCode(pilotCoverErr(num.resource_id, cur(), ref("over-ceiling")), "TW007")).toBe(true);
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(0);
      expect(rows(num.resource_id)).toHaveLength(1);
      expect(audit(w, "rfl_cover_superseded")).toBe(0);
    });

    it("on-hold and negative-balance accounts are refused (TW007) without superseding anything", () => {
      const w = pilotWorld();
      const { num } = releasedBound(w);
      replica(`update public.studio_sms_credit_accounts set hold = true, hold_reason = 'fixture hold for the D5 suite' where legal_entity_id = '${w.entity}';`);
      expect(hasCode(pilotCoverErr(num.resource_id, cur(), ref("held")), "TW007")).toBe(true);
      replica(`update public.studio_sms_credit_accounts set hold = false, hold_reason = null, balance_cents = -1 where legal_entity_id = '${w.entity}';`);
      expect(hasCode(pilotCoverErr(num.resource_id, cur(), ref("negative")), "TW007")).toBe(true);
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(0);
      replica(`update public.studio_sms_credit_accounts set balance_cents = 100000 where legal_entity_id = '${w.entity}';`);
    });

    it("current or next period only: retroactive and beyond-next approvals are refused (TW042) and never supersede", () => {
      const w = pilotWorld();
      const { num } = releasedBound(w);
      expect(hasCode(pilotCoverErr(num.resource_id, keyAdd(cur(), -1), ref("retro")), "TW042")).toBe(true);
      expect(hasCode(pilotCoverErr(num.resource_id, keyAdd(cur(), 2), ref("far")), "TW042")).toBe(true);
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(0);
      // the NEXT period has no cover row: an ordinary approval, nothing superseded
      pilotCover(num.resource_id, keyAdd(cur(), 1), ref("next"));
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(0);
    });

    it("admin only: a studio owner cannot supersede (42501) and a single approval reference cannot be reused for another supersede", () => {
      const w = pilotWorld();
      const { num } = releasedBound(w);
      expect(hasCode(pilotCoverErr(num.resource_id, cur(), ref("owner"), w.owner), "42501")).toBe(true);
      const approval = ref("single-use");
      pilotCover(num.resource_id, cur(), approval);
      const w2 = pilotWorld();
      const other = releasedBound(w2);
      expect(psqlError(callSql("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, other.num.resource_id, cur(), approval, P)))).not.toBe("");
      expect(rows(other.num.resource_id).filter((r) => r.sup)).toHaveLength(0);
    });

    it("the evidence guard: cover rows are never deleted or edited, except the supersede mark on a non-counting initial_reservation row under the write flag", () => {
      const w = pilotWorld();
      const { num } = releasedBound(w);
      const out = pilotCover(num.resource_id, cur(), ref("guard"));
      const [old, fresh] = rows(num.resource_id);
      expect(psqlError(`delete from public.studio_sms_provider_cover where id = '${old.id}';`)).toMatch(/42501/);
      expect(psqlError(`update public.studio_sms_provider_cover set superseded_reason = 'reservation_month_differs' where id = '${old.id}';`)).toMatch(/42501/);
      expect(psqlError(`update public.studio_sms_provider_cover set approval_ref = 'x' where id = '${old.id}';`)).toMatch(/42501/);
      // the approval row can never carry a supersede mark, flag or not
      expect(psqlError(`begin; select set_config('tw4.rfl_write', 'on', true);
        update public.studio_sms_provider_cover set superseded_at = now(), superseded_by = '${P}', superseded_reason = 'reservation_not_counting', superseded_by_cover_id = '${old.id}' where id = '${fresh.id}'; commit;`)).toMatch(/42501|check/);
      // a live row cannot be marked without the flag, and a mark cannot change another column
      const w2 = pilotWorld();
      const other = releasedBound(w2);
      expect(psqlError(`update public.studio_sms_provider_cover set superseded_at = now(), superseded_by = '${P}', superseded_reason = 'reservation_not_counting', superseded_by_cover_id = '${randomUUID()}'
        where resource_id = '${other.num.resource_id}';`)).toMatch(/42501/);
      expect(psqlError(`begin; select set_config('tw4.rfl_write', 'on', true);
        update public.studio_sms_provider_cover set superseded_at = now(), superseded_by = '${P}', superseded_reason = 'reservation_not_counting', superseded_by_cover_id = '${randomUUID()}', recorded_by = '${P2}'
        where resource_id = '${other.num.resource_id}'; commit;`)).toMatch(/42501/);
      expect(out.cover_id).toBe(fresh.id);
    });

    it("one LIVE cover per period: a second live row is refused (23505), a superseded row does not block", () => {
      const w = pilotWorld();
      const { num } = releasedBound(w);
      pilotCover(num.resource_id, cur(), ref("unique"));
      expect(psqlError(`insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, recorded_by)
        values ('${num.resource_id}', '${w.entity}', '${w.studio}', '${cur()}', 'initial_reservation', '${resv(w)}', '${P}');`)).toMatch(/23505|duplicate key/);
      expect(rows(num.resource_id)).toHaveLength(2);
    });

    it("two administrators racing to approve the same non-counting period: exactly one wins, the other gets TW043, one superseded row, one new approval reservation", async () => {
      const w = pilotWorld();
      const { num } = releasedBound(w);
      const results = await Promise.all([1, 2, 3].map((i) => psqlAsync(callSql("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, cur(), ref(`race-${i}`), i % 2 ? P : P2)))));
      const ok = results.filter((r) => r.err === "");
      const lost = results.filter((r) => r.err !== "");
      expect(ok).toHaveLength(1);
      expect(lost.every((r) => hasCode(r.err, "TW043"))).toBe(true);
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(1);
      expect(rows(num.resource_id)).toHaveLength(2);
      expect(Number(psql(`select count(*) from public.studio_sms_credit_reservations where reservation_key = 'rfl:${num.resource_id}:${cur()}'`))).toBe(1);
      expect(coverOf(num.resource_id)).toBe("covered:pilot_approval");
    });
  });

  describe("consistency", () => {
    it("every reader of cover agrees across the four states: counting bound, released bound, cross-month, superseded-and-approved", () => {
      const w = pilotWorld();
      const good = registerNumber(w, resv(w));
      expect([coverOf(good.resource_id), blockers(w).includes("number_current_period_uncovered")]).toEqual(["covered:initial_reservation", false]);
      const w2 = pilotWorld();
      const rel = releasedBound(w2);
      expect([coverOf(rel.num.resource_id), blockers(w2).includes("number_current_period_uncovered")]).toEqual([expect.stringMatching(/^uncovered:/), true]);
      const w3 = pilotWorld();
      const x = legacyCrossMonth(w3);
      expect([coverOf(x.num.resource_id), blockers(w3).includes("number_current_period_uncovered")]).toEqual([expect.stringMatching(/^uncovered:/), true]);
      pilotCover(x.num.resource_id, cur(), ref("agree"));
      expect([coverOf(x.num.resource_id), blockers(w3).includes("number_current_period_uncovered")]).toEqual(["covered:pilot_approval", false]);
      // the scan agrees with the cover: a non-counting period opens exposure (after grace) and an approval closes it
      const w4 = pilotWorld();
      const late = releasedBound(w4);
      replica(`update public.studio_sms_provider_resources set registered_at = registered_at - interval '75 days' where id = '${late.num.resource_id}';`);
      call("tw4_rfl_scan_entity", w4.entity);
      expect(psql(`select count(*) from public.studio_sms_provider_exposure where resource_id = '${late.num.resource_id}' and period_key = '${cur()}' and state = 'open'`)).toBe("1");
      pilotCover(late.num.resource_id, cur(), ref("close-exposure"));
      expect(psql(`select count(*) from public.studio_sms_provider_exposure where resource_id = '${late.num.resource_id}' and period_key = '${cur()}' and state = 'open'`)).toBe("0");
    });

    it("no API role can execute the replaced internals (grants unchanged)", () => {
      for (const fn of ["public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)", "public._tw4rfl_cover(public.studio_sms_provider_resources,text)", "public._tw4rfl_guard()"]) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          expect(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`)).toBe("f");
        }
      }
      for (const role of ["anon", "authenticated"]) {
        expect(psql(`select has_function_privilege('${role}', '${evidenceApplied(psql) ? "public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)" : "public.tw4_rfl_pilot_cover(uuid,text,text,uuid)"}', 'execute')`)).toBe("f");
      }
    });
  });
});
