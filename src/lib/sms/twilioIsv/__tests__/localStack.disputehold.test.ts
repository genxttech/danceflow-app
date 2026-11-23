/**
 * Stripe dispute hold, dispute alert, DanceFlow-borne dispute fee record and the negative-available-credit alert (20270221090100) against a REAL schema.
 * Covers: dark default (no hold while the switch is off), the automatic hold reusing the EXISTING account hold, one alert per dispute (replays and redeliveries
 * add nothing), the fee recorded as DanceFlow-borne without any studio charge or ledger entry, won / lost outcomes, the administrator release (note, idempotent,
 * audited, wrong business refused), concurrent disputes, the manual-hold interplay, the negative-credit alert per transition, what the hold blocks (fee-bearing
 * spending, checkout, top-up) and what it never blocks (STOP/START/HELP inbound recording, compliance replies), privileges from the catalog, and the rollback.
 * Synthetic fixtures; no Stripe, no Twilio, no email. Needs only the database container (it does not use TW4A_LOCAL_URL / the API).
 * LOCAL QA ONLY, through the isolated harness (one suite per run):
 *
 *   ISO_QA_MARKER=1 node scripts/qa/iso-qa.mjs run numeric --no-api -- src/lib/sms/twilioIsv/__tests__/localStack.disputehold.test.ts
 *   (or by hand: TW4A_LOCAL_DB_CONTAINER=<container> TW4DH_DB=postgres npx vitest run --no-file-parallelism <this file>)
 */
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4DH_DB ?? "postgres";
const enabled = Boolean(PG);

const RUN = randomBytes(3).toString("hex");
const hex = (n: number) => randomBytes(n).toString("hex");
const uid = (n: number) => `1d${RUN}-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;
const ADMIN = uid(1);
const NOT_ADMIN = uid(2);
const MIG = join(__dirname, "../../../supabase/migrations");
const MIGRATION = "20270221090100_twilio_dispute_negative_balance_holds.sql";

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
/** the same statement in its own psql process, without waiting: used to race two sessions */
const psqlAsync = (sql: string) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile("docker", sqlArgs, { encoding: "utf8" }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(String(stdout).trim())));
    child.stdin?.end(sql);
  });
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);
const count = (sql: string) => Number(psql(`select count(*) from (${sql}) q`));
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const t = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${t}'::uuid` : `'${t}'`;
};
const callSql = (fn: string, ...args: unknown[]) => `select public.${fn}(${args.map(lit).join(", ")})::text;`;
const call = <T = Record<string, unknown>>(fn: string, ...args: unknown[]) => JSON.parse(psql(callSql(fn, ...args))) as T;
const callError = (fn: string, ...args: unknown[]) => psqlError(callSql(fn, ...args));

type World = { entity: string; studios: string[]; owner: string; account: string };
const WORLDS: World[] = [];

function world(): World {
  const w: World = { entity: randomUUID(), studios: [randomUUID(), randomUUID()], owner: randomUUID(), account: `AC${hex(16)}` };
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-${hex(4)}@disputehold-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studios[0]}', 'DH ${hex(3)}', 'dh-${hex(4)}', null, 'UTC'), ('${w.studios[1]}', 'DH ${hex(3)}', 'dh-${hex(4)}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studios[0]}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', 'DH World ${hex(3)} LLC', '7771', 500000, '${ADMIN}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${w.studios[0]}', '${w.entity}', 'founding', '${ADMIN}', 'fixture: earliest location', now() - interval '2 days'),
  ('${w.studios[1]}', '${w.entity}', 'founding', '${ADMIN}', 'fixture: later location', now() - interval '1 day');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${w.entity}', '${w.account}', 'dh-${hex(3)}', 'test', 'active', '${ADMIN}');
commit;`);
  WORLDS.push(w);
  return w;
}

/** A settled Stripe credit purchase (pending checkout, then settlement with its PaymentIntent), exactly as the webhook records it. */
function pay(w: World, cents: 2500 | 5000 | 10000) {
  const cs = `cs_dh_${hex(8)}`;
  const pi = `pi_dh_${hex(8)}`;
  call("tw4_credit_topup_pending", w.entity, w.studios[0], cs, cents, null);
  psql(`select public.tw4_credit_settle_topup('${w.entity}', '${w.studios[0]}', '${cs}', ${cents}, 'evt_${hex(6)}', '${pi}', true)::text;`);
  return { cs, pi };
}
/** settled usage (fixture: the ledger primitive the usage settlement posts through; the monthly spending limit is not what this suite tests) */
const spend = (w: World, cents: number) =>
  psql(`select public._tw4c_post('${w.entity}', '${w.studios[1]}', 'usage_charge', ${-cents}, 0, 'usage:dh-${hex(6)}', null, 'fixture usage', null, null)::text;`);
/** the spend guard every fee-bearing reservation and chargeable outbound text goes through passes (no hold, funds available) */
const canSpend = (w: World, cents: number) =>
  psql(`select public._tw4c_require_funds(a, ${cents}) from public.studio_sms_credit_accounts a where a.legal_entity_id = '${w.entity}';`);
const dispute = (pi: string, disputeId: string, cents: number, action: "withdrawn" | "reinstated", eventId = `evt_${hex(6)}`) =>
  call<{ replayed?: boolean; capped_to_zero?: boolean; entry_id?: string }>("tw4_credit_apply_dispute", pi, disputeId, cents, action, eventId);
const acct = (w: World) =>
  JSON.parse(psql(`select json_build_object('balance', balance_cents, 'reserved', reserved_cents, 'hold', hold, 'reason', hold_reason)::text from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}'`)) as {
    balance: number; reserved: number; hold: boolean; reason: string | null;
  };
type HoldRow = { id: string; hold_state: string; claim_cents: number; withdrawn_cents: number; df_borne_fee_cents: number; fee_basis: string; account_already_held: boolean; not_held_reason: string | null; release_note: string | null };
const holds = (w: World) =>
  JSON.parse(psql(`select coalesce(json_agg(to_jsonb(h) order by h.created_at, h.id), '[]'::json)::text from public.studio_sms_credit_dispute_holds h where h.legal_entity_id = '${w.entity}'`)) as HoldRow[];
type AlertRow = { id: string; kind: string; dedupe_key: string; audience: string; severity: string; studio_id: string | null; summary: string };
const alertsOf = (w: World, kind?: string) =>
  JSON.parse(psql(`select coalesce(json_agg(json_build_object('id', id, 'kind', kind, 'dedupe_key', dedupe_key, 'audience', audience, 'severity', severity, 'studio_id', studio_id, 'summary', summary) order by created_at, id), '[]'::json)::text
    from public.studio_sms_provider_alerts where legal_entity_id = '${w.entity}' ${kind ? `and kind = '${kind}'` : ""}`)) as AlertRow[];
const ledgerFor = (w: World) =>
  JSON.parse(psql(`select coalesce(json_agg(json_build_object('kind', kind, 'delta', balance_delta_cents, 'key', idempotency_key) order by seq), '[]'::json)::text from public.studio_sms_credit_ledger where legal_entity_id = '${w.entity}'`)) as Array<{ kind: string; delta: number; key: string }>;
const audits = (w: World, like: string) => count(`select 1 from public.studio_sms_onboarding_audit where studio_id in ('${w.studios[0]}', '${w.studios[1]}') and action = 'credit_hold' and note like '${like}'`);
const recordSet = (on: boolean) => call("tw4_dispute_record_switch_set", on, ADMIN, on ? "fixture: dispute record on" : "fixture: dispute record off");
/** the automatic hold needs the record switch ON (enforced by the database), so turning the hold on turns the record on first */
const switchSet = (on: boolean) => {
  if (on) recordSet(true);
  return call("tw4_dispute_hold_switch_set", on, ADMIN, on ? "fixture: automatic dispute hold on" : "fixture: automatic dispute hold off");
};
const release = (w: World, holdId: string, note = "Reviewed with the owner; dispute closed, account cleared.", actor = ADMIN) =>
  call<{ state: string; replayed: boolean; account_hold_cleared?: boolean; account_on_hold: boolean }>("tw4_credit_dispute_hold_release", w.entity, holdId, actor, note);
const verify = (w: World) => call<{ ok: boolean }>("tw4_credit_verify", w.entity).ok;

describe.skipIf(!enabled)("dispute hold and negative-credit alert (20270221090100, real schema)", () => {
  beforeAll(() => {
    expect(psql("select to_regprocedure('public.tw4_credit_dispute_hold_release(uuid,uuid,uuid,text)') is not null")).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@disputehold-e2e.test', now(), now(), now()),
  ('${NOT_ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nobody-${RUN}@disputehold-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${ADMIN}', 'platform_admin'), ('${NOT_ADMIN}', null) on conflict (id) do update set platform_role = excluded.platform_role;
commit;`);
    expect(count("select 1 from public.studio_sms_dispute_hold_switch_log")).toBe(0);   // a fresh database: the switch has never been set
  });

  afterAll(() => {
    if (!enabled) return;
    psql(`update public.profiles set platform_role = null where id = '${ADMIN}';`);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("dark by default: with both switches off a dispute and a negative balance behave exactly as before this migration", () => {
    it("a studio that buys $100, spends it and disputes: balance goes negative, NO hold, NO row, NO audit, NO alert of either new kind", () => {
      expect(psql("select public._tw4dh_record_on() || ':' || public._tw4dh_auto_hold_on()")).toBe("false:false");
      const w = world();
      const { pi } = pay(w, 10000);
      spend(w, 9000);
      const before = ledgerFor(w).length;
      expect(dispute(pi, `dp_${hex(6)}`, 10000, "withdrawn").replayed).toBe(false);
      expect(acct(w)).toMatchObject({ balance: -9000, hold: false, reason: null });
      const ledger = ledgerFor(w);
      expect(ledger.length).toBe(before + 1);
      expect(ledger[ledger.length - 1]).toMatchObject({ kind: "topup_reversed", delta: -10000 });
      expect(verify(w)).toBe(true);
      expect(holds(w)).toHaveLength(0);
      expect(audits(w, "dispute_hold;%")).toBe(0);
      expect(alertsOf(w, "credit_dispute")).toHaveLength(0);
      expect(alertsOf(w, "credit_negative")).toHaveLength(0);
      expect(alertsOf(w)).toHaveLength(0);
      // a won dispute is quiet too, and a replay changes nothing
      const id = psql(`select dispute_id from public.studio_sms_credit_disputes where legal_entity_id = '${w.entity}'`);
      dispute(pi, id, 10000, "reinstated");
      expect(alertsOf(w)).toHaveLength(0);
      expect(holds(w)).toHaveLength(0);
    });

    it("the switches are platform-admin only, need a written reason, the hold needs the record, and the log is append-only", () => {
      for (const fn of ["tw4_dispute_hold_switch_set", "tw4_dispute_record_switch_set"]) {
        expect(callError(fn, true, NOT_ADMIN, "not an administrator trying")).toMatch(/42501/);
        expect(callError(fn, true, ADMIN, "short")).toMatch(/22023/);
      }
      expect(psql("select public._tw4dh_record_on() || ':' || public._tw4dh_auto_hold_on()")).toBe("false:false");
      expect(callError("tw4_dispute_hold_switch_set", true, ADMIN, "hold before the record is on")).toMatch(/55000/);   // an automatic hold is always recorded
      expect(psql("select public._tw4dh_auto_hold_on()")).toBe("f");
      recordSet(true);
      expect(psql("select public._tw4dh_record_on() || ':' || public._tw4dh_auto_hold_on()")).toBe("true:false");
      call("tw4_dispute_hold_switch_set", true, ADMIN, "fixture: hold on after record on");
      expect(psql("select public._tw4dh_auto_hold_on()")).toBe("t");
      expect(callError("tw4_dispute_record_switch_set", false, ADMIN, "record off while the hold is on")).toMatch(/55000/);
      call("tw4_dispute_hold_switch_set", false, ADMIN, "fixture: hold off again");
      expect(psql("select public._tw4dh_record_on() || ':' || public._tw4dh_auto_hold_on()")).toBe("true:false");
      expect(psqlError("update public.studio_sms_dispute_hold_switch_log set enabled = false;")).toMatch(/append-only/);
      expect(psqlError("delete from public.studio_sms_dispute_hold_switch_log;")).toMatch(/append-only/);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("record ON, hold OFF: the alert and the DanceFlow-borne fee record, still no hold", () => {
    beforeAll(() => recordSet(true));

    it("record ON, hold OFF: a studio that buys $100, spends it and disputes: balance goes negative, NO hold, one not_held row with the $15 fee as DanceFlow-borne, one dispute alert, one negative alert", () => {
      expect(psql("select public._tw4dh_auto_hold_on()")).toBe("f");
      const w = world();
      const { pi } = pay(w, 10000);
      spend(w, 9000);
      const before = ledgerFor(w).length;
      const out = dispute(pi, `dp_${hex(6)}`, 10000, "withdrawn");
      expect(out.replayed).toBe(false);
      expect(acct(w)).toMatchObject({ balance: -9000, hold: false, reason: null });
      // the fee is NOT charged to the studio: exactly one new ledger entry (the withdrawal itself), nothing for the fee
      const ledger = ledgerFor(w);
      expect(ledger.length).toBe(before + 1);
      expect(ledger[ledger.length - 1]).toMatchObject({ kind: "topup_reversed", delta: -10000 });
      expect(ledger.some((l) => l.delta === -1500 || /fee/i.test(l.key))).toBe(false);
      expect(verify(w)).toBe(true);
      const rows = holds(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ hold_state: "not_held", not_held_reason: "auto_hold_switch_off", claim_cents: 10000, withdrawn_cents: 10000, df_borne_fee_cents: 1500, fee_basis: "stripe_standard_fee_estimate", account_already_held: false });
      expect(audits(w, `dispute_hold;state=not_held;hold=${rows[0].id};%df_borne_dispute_fee_cents=1500;%studio_charged=0`)).toBe(1);
      const da = alertsOf(w, "credit_dispute");
      expect(da).toHaveLength(1);
      expect(da[0]).toMatchObject({ audience: "admin", severity: "critical", studio_id: null });
      expect(da[0].summary).toMatch(/switched off, so no hold was placed/);
      expect(da[0].summary).not.toMatch(/\$|\d{3,}|\bcents?\b|balance/i);
      expect(alertsOf(w, "credit_negative")).toHaveLength(1);
      // a not_held row has nothing to release
      expect(callError("tw4_credit_dispute_hold_release", w.entity, rows[0].id, ADMIN, "nothing to release here at all")).toMatch(/22023/);
    });

    it("the negative-credit trigger can NEVER fail the statement that moved the balance (a failing alert write is only a warning)", () => {
      const w = world();
      call("tw4_credit_adjust", w.entity, 500, `fund-${hex(4)}`, "fixture funding for trigger safety", ADMIN);
      expect(psql("select pg_get_functiondef('public._tw4dh_negative_alert()'::regprocedure) ~* 'exception\s+when others'")).toBe("t");
      psql("alter table public.studio_sms_provider_alerts add constraint tmp_dh_fail check (kind <> 'credit_negative') not valid;");
      try {
        // the alert insert is now impossible; the debit that crosses zero (the shape of an inbound STOP/HELP absorbed debit) must still succeed
        psql(`select public._tw4c_post('${w.entity}', '${w.studios[0]}', 'usage_charge', -800, 0, 'usage:dh-${hex(6)}', null, 'fixture inbound debit', null, null)::text;`);
      } finally {
        psql("alter table public.studio_sms_provider_alerts drop constraint tmp_dh_fail;");
      }
      expect(acct(w).balance).toBe(-300);
      expect(alertsOf(w, "credit_negative")).toHaveLength(0);
      expect(verify(w)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("switch on: the automatic hold reuses the existing account hold", () => {
    let w: World;
    let pi100: string;
    let disputeId: string;

    beforeAll(() => {
      switchSet(true);
      w = world();
      pi100 = pay(w, 10000).pi;
      pay(w, 5000);
    });

    it("a dispute places ONE hold (reason 'dispute'), ONE critical admin alert and ONE audited fee record; a still-positive account is held by the hold itself", () => {
      disputeId = `dp_${hex(6)}`;
      dispute(pi100, disputeId, 5000, "withdrawn");
      expect(acct(w)).toMatchObject({ balance: 10000, hold: true, reason: "dispute" });
      const rows = holds(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ hold_state: "held", withdrawn_cents: 5000, df_borne_fee_cents: 1500, account_already_held: false });
      const da = alertsOf(w, "credit_dispute");
      expect(da).toHaveLength(1);
      expect(da[0]).toMatchObject({ dedupe_key: expect.stringMatching(/^dispute:[0-9a-f-]{36}$/), audience: "admin", severity: "critical" });
      expect(da[0].summary).toMatch(/placed on hold and DanceFlow bears the dispute fee/);
      expect(alertsOf(w, "credit_negative")).toHaveLength(0);   // available credit stayed positive
      expect(audits(w, "dispute_hold;state=held;%")).toBe(1);
    });

    it("replays add nothing: the same event, a redelivery under a new event id, and created-then-funds_withdrawn", () => {
      const snap = () => JSON.stringify([acct(w), holds(w), alertsOf(w), ledgerFor(w).length]);
      const before = snap();
      expect(dispute(pi100, disputeId, 5000, "withdrawn", "evt_same_event")).toMatchObject({ replayed: true });
      expect(dispute(pi100, disputeId, 5000, "withdrawn", "evt_same_event")).toMatchObject({ replayed: true });
      expect(dispute(pi100, disputeId, 5000, "withdrawn")).toMatchObject({ replayed: true });
      expect(snap()).toBe(before);
      expect(audits(w, "dispute_hold;%")).toBe(1);
      // the hook itself is idempotent as well (called again for the same dispute row)
      const row = psql(`select id from public.studio_sms_credit_disputes where dispute_id = '${disputeId}'`);
      psql(`select public._tw4dh_on_withdrawn('${row}');`);
      expect(snap()).toBe(before);
    });

    it("the hold blocks new fee-bearing spending, checkout and top-up exactly like the existing hold (TW007)", () => {
      const e1 = callError("tw4_credit_debit_usage", w.entity, w.studios[0], 10, `dh-${hex(4)}`, "blocked usage");
      expect(e1).toMatch(/TW007/);
      expect(e1).toMatch(/on hold/);
      expect(callError("tw4_credit_checkout_context", w.studios[0], w.owner)).toMatch(/TW007/);
      expect(callError("tw4_credit_topup_pending", w.entity, w.studios[0], `cs_dh_${hex(6)}`, 2500, null)).toMatch(/TW007/);
      // outbound chargeable texts reserve through the same guard
      expect(psql("select bool_and(pg_get_functiondef(p.oid) like '%_tw4c_require_funds(%') from pg_proc p where p.proname = 'tw4_usage_begin' and p.pronamespace = 'public'::regnamespace")).toBe("t");
      // a payment that was already made still settles while held (the existing rule): the hook does not change it
      expect(acct(w).hold).toBe(true);
    });

    it("the hold never blocks STOP/START/HELP inbound recording or compliance and error replies", () => {
      for (const body of ["You are unsubscribed.", "You are subscribed again.", "Reply STOP to opt out."]) {
        const stopSid = `SM${hex(16)}`;
        const out = JSON.parse(psql(`select public.tw4_inbound_record('${w.studios[0]}'::uuid, '${w.account}', '${stopSid}', 1, 0, 'compliance', '${body}', null, 'webhook')::text`)) as Record<string, unknown>;
        expect(out).toMatchObject({ recorded: true, classification: "compliance", charged_cents: 0 });
        expect(count(`select 1 from public.studio_sms_inbound_usage where provider_sid = '${stopSid}'`)).toBe(1);
      }
      for (const kind of ["help", "start", "error_unavailable"]) {
        expect(psql(`select public.tw4_inbound_reply_allowed('${w.account}', '${hex(32)}', '${kind}', 5)`)).toBe("t");
      }
      for (const fn of ["tw4_inbound_record", "tw4_inbound_reply_allowed"]) {
        // neither reads the hold or the spend guard at all
        expect(psql(`select bool_or(pg_get_functiondef(p.oid) ~ '\\.hold\\M|hold_reason|_tw4c_require_funds') from pg_proc p where p.proname = '${fn}' and p.pronamespace = 'public'::regnamespace`)).toBe("f");
      }
      expect(acct(w).hold).toBe(true);
    });

    it("a hold cannot be cleared by the generic hold function while a dispute hold is held; 'dispute' is a reserved reason", () => {
      expect(callError("tw4_credit_set_hold", w.entity, false, null, ADMIN)).toMatch(/55000/);
      expect(callError("tw4_credit_set_hold", w.entity, true, "Dispute", ADMIN)).toMatch(/22023/);
      expect(acct(w)).toMatchObject({ hold: true, reason: "dispute" });
    });

    it("WIN: funds reinstated restores the credit, the hold stays, ONE informational alert; a replayed win adds nothing", () => {
      dispute(pi100, disputeId, 5000, "reinstated");
      expect(acct(w)).toMatchObject({ balance: 15000, hold: true, reason: "dispute" });
      const won = alertsOf(w, "credit_dispute").filter((a) => a.dedupe_key.endsWith(":won"));
      expect(won).toHaveLength(1);
      expect(won[0]).toMatchObject({ severity: "info", audience: "admin" });
      expect(dispute(pi100, disputeId, 5000, "reinstated")).toMatchObject({ replayed: true });
      expect(alertsOf(w, "credit_dispute")).toHaveLength(2);
      expect(holds(w)[0].hold_state).toBe("held");
      expect(verify(w)).toBe(true);
    });

    it("release: admin only, written note, right business only; clears the account hold; replay is a no-op; audited", () => {
      const h = holds(w)[0];
      const other = world();
      expect(callError("tw4_credit_dispute_hold_release", w.entity, h.id, NOT_ADMIN, "not an administrator here")).toMatch(/42501/);
      expect(callError("tw4_credit_dispute_hold_release", other.entity, h.id, ADMIN, "wrong business for this hold")).toMatch(/22023/);   // wrong tenant
      expect(callError("tw4_credit_dispute_hold_release", w.entity, randomUUID(), ADMIN, "no such hold anywhere")).toMatch(/22023/);
      expect(callError("tw4_credit_dispute_hold_release", w.entity, h.id, ADMIN, "short")).toMatch(/22023/);
      expect(acct(w).hold).toBe(true);
      const out = release(w, h.id);
      expect(out).toMatchObject({ state: "released", replayed: false, account_hold_cleared: true, account_on_hold: false });
      expect(acct(w)).toMatchObject({ hold: false, reason: null });
      expect(holds(w)[0]).toMatchObject({ hold_state: "released", release_note: "Reviewed with the owner; dispute closed, account cleared." });
      expect(release(w, h.id, "a different note on the replay")).toMatchObject({ replayed: true });
      expect(holds(w)[0].release_note).toBe("Reviewed with the owner; dispute closed, account cleared.");
      expect(audits(w, `dispute_hold_released;hold=${h.id};account_hold_cleared=true;%`)).toBe(1);
      expect(count(`select 1 from public.studio_sms_credit_accounts where legal_entity_id = '${other.entity}' and hold`)).toBe(0);   // the other business has no account row at all, never a hold
      canSpend(w, 100);                                                                // spending works again
      // a released hold is final
      expect(psqlError(`update public.studio_sms_credit_dispute_holds set hold_state = 'held' where id = '${h.id}';`)).toMatch(/held to released, once/);
      expect(psqlError(`delete from public.studio_sms_credit_dispute_holds where id = '${h.id}';`)).toMatch(/never deleted/);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("LOSE, refunded-then-disputed, concurrency and the manual-hold interplay", () => {
    beforeAll(() => switchSet(true));

    it("LOSE: no reinstatement; the hold stays; after release the negative balance still blocks spending (funding is required)", () => {
      const w = world();
      const { pi } = pay(w, 10000);
      spend(w, 9000);
      dispute(pi, `dp_${hex(6)}`, 10000, "withdrawn");
      expect(acct(w)).toMatchObject({ balance: -9000, hold: true, reason: "dispute" });
      expect(alertsOf(w, "credit_negative")).toHaveLength(1);
      expect(release(w, holds(w)[0].id, "Dispute lost; owner told to fund the account first.")).toMatchObject({ account_hold_cleared: true });
      const e = callError("tw4_credit_debit_usage", w.entity, w.studios[0], 10, `dh-${hex(4)}`, "still negative");
      expect(e).toMatch(/TW007/);
      expect(e).toMatch(/insufficient/);
    });

    it("a dispute of an already-refunded payment (nothing left to take back) still holds, alerts and records the fee", () => {
      const w = world();
      const { pi } = pay(w, 2500);
      call("tw4_credit_apply_refund", pi, 2500, `evt_${hex(6)}`, "fixture refund");
      expect(dispute(pi, `dp_${hex(6)}`, 2500, "withdrawn")).toMatchObject({ capped_to_zero: true });
      expect(holds(w)[0]).toMatchObject({ hold_state: "held", withdrawn_cents: 0, claim_cents: 2500, df_borne_fee_cents: 1500 });
      expect(acct(w).hold).toBe(true);
      expect(alertsOf(w, "credit_dispute")).toHaveLength(1);
    });

    it("CONCURRENT disputes of one business (two sessions at once): two hold rows, one account hold, two alerts; the hold goes only with the last release", async () => {
      const w = world();
      const p1 = pay(w, 5000).pi;
      const p2 = pay(w, 5000).pi;
      const [d1, d2] = [`dp_${hex(6)}`, `dp_${hex(6)}`];
      await Promise.all([
        psqlAsync(callSql("tw4_credit_apply_dispute", p1, d1, 5000, "withdrawn", `evt_${hex(6)}`)),
        psqlAsync(callSql("tw4_credit_apply_dispute", p2, d2, 5000, "withdrawn", `evt_${hex(6)}`)),
        psqlAsync(callSql("tw4_credit_apply_dispute", p1, d1, 5000, "withdrawn", `evt_${hex(6)}`)),   // a concurrent redelivery of the first
      ]);
      const rows = holds(w);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.hold_state)).toEqual(["held", "held"]);
      expect(rows.filter((r) => r.account_already_held)).toHaveLength(1);   // exactly one of them found the account already held
      expect(alertsOf(w, "credit_dispute")).toHaveLength(2);
      expect(acct(w)).toMatchObject({ balance: 0, hold: true, reason: "dispute" });
      expect(alertsOf(w, "credit_negative")).toHaveLength(0);              // reached zero, never below
      expect(release(w, rows[0].id)).toMatchObject({ account_hold_cleared: false, account_on_hold: true });
      expect(acct(w).hold).toBe(true);
      expect(release(w, rows[1].id)).toMatchObject({ account_hold_cleared: true, account_on_hold: false });
      expect(acct(w).hold).toBe(false);
      expect(verify(w)).toBe(true);
    });

    it("a MANUAL hold is never overwritten or cleared by the dispute machinery", () => {
      const w = world();
      const pA = pay(w, 5000).pi;
      const pB = pay(w, 5000).pi;
      call("tw4_credit_set_hold", w.entity, true, "manual review before dispute", ADMIN);
      dispute(pA, `dp_${hex(6)}`, 5000, "withdrawn");
      expect(acct(w)).toMatchObject({ hold: true, reason: "manual review before dispute" });
      expect(holds(w)[0]).toMatchObject({ hold_state: "held", account_already_held: true });
      // the alert says what actually happened: nothing was placed because the account was already on hold
      const already = alertsOf(w, "credit_dispute")[0].summary;
      expect(already).toMatch(/already on hold, so no new hold was placed/);
      expect(already).not.toMatch(/was placed on hold/);
      expect(release(w, holds(w)[0].id)).toMatchObject({ account_hold_cleared: false, account_on_hold: true });
      expect(acct(w)).toMatchObject({ hold: true, reason: "manual review before dispute" });
      call("tw4_credit_set_hold", w.entity, false, null, ADMIN);                       // no dispute hold left: the generic function works
      // a manual hold placed WHILE a dispute hold is held replaces the reason, and survives the dispute release
      dispute(pB, `dp_${hex(6)}`, 5000, "withdrawn");
      expect(acct(w)).toMatchObject({ hold: true, reason: "dispute" });
      call("tw4_credit_set_hold", w.entity, true, "manual hold during the dispute", ADMIN);
      const open = holds(w).find((r) => r.hold_state === "held")!;
      expect(release(w, open.id)).toMatchObject({ account_hold_cleared: false });
      expect(acct(w)).toMatchObject({ hold: true, reason: "manual hold during the dispute" });
    });

    it("a dispute of business A never touches business B", () => {
      const a = world();
      const b = world();
      const pa = pay(a, 5000).pi;
      pay(b, 5000);
      dispute(pa, `dp_${hex(6)}`, 5000, "withdrawn");
      expect(acct(a).hold).toBe(true);
      expect(acct(b)).toMatchObject({ balance: 5000, hold: false });
      expect(holds(b)).toHaveLength(0);
      expect(alertsOf(b)).toHaveLength(0);
      canSpend(b, 100);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("negative available credit: one alert per transition, whatever the cause", () => {
    const post = (w: World, delta: number, key = `neg-${hex(6)}`) =>
      psql(`select public._tw4c_post('${w.entity}', '${w.studios[0]}', '${delta < 0 ? "usage_charge" : "usage_refund"}', ${delta}, 0, '${key}', null, 'fixture settlement', null, null)::text;`);

    it("a settlement-style overdraw raises ONE alert; staying negative and replays add none; recovering and dipping again raises a new one", () => {
      const w = world();
      call("tw4_credit_adjust", w.entity, 300, `fund-${hex(4)}`, "fixture funding for negative test", ADMIN);
      post(w, -300);                                           // exactly zero: not below
      expect(alertsOf(w, "credit_negative")).toHaveLength(0);
      const key = `neg-${hex(6)}`;
      post(w, -50, key);                                       // 0 -> -50
      const first = alertsOf(w, "credit_negative");
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ audience: "admin", severity: "critical", studio_id: null });
      expect(first[0].summary).toMatch(/STOP, START and HELP are unaffected/);
      expect(first[0].summary).not.toMatch(/\$|\d{2,}|\bcents?\b|balance/i);
      post(w, -50, key);                                       // replay of the same entry: nothing moves
      post(w, -25);                                            // further below: same episode
      expect(alertsOf(w, "credit_negative")).toHaveLength(1);
      expect(acct(w).hold).toBe(false);                        // notification only: no hold
      post(w, 200);                                            // back to +125
      post(w, -200);                                           // a new dip
      expect(alertsOf(w, "credit_negative")).toHaveLength(2);
      expect(new Set(alertsOf(w, "credit_negative").map((a) => a.dedupe_key)).size).toBe(2);
    });

    it("available = settled minus reserved: an increase in reservations alone that would cross zero is still alerted (defence in depth)", () => {
      const w = world();
      call("tw4_credit_adjust", w.entity, 100, `fund-${hex(4)}`, "fixture funding for reserved test", ADMIN);
      replica(`update public.studio_sms_credit_accounts set reserved_cents = 0 where legal_entity_id = '${w.entity}';`);
      psql(`update public.studio_sms_credit_accounts set reserved_cents = 150 where legal_entity_id = '${w.entity}';`);   // a direct counter change (no function does this; it proves the trigger condition)
      expect(alertsOf(w, "credit_negative")).toHaveLength(1);
      replica(`update public.studio_sms_credit_accounts set reserved_cents = 0 where legal_entity_id = '${w.entity}';`);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  describe("privileges (from the catalog) and the rollback", () => {
    it("service role only for the entry points; helpers callable by no API role; tables have RLS and no API grants", () => {
      const can = (role: string, fn: string) => psql(`select has_function_privilege('${role}', '${fn}', 'execute')`);
      for (const fn of ["public.tw4_credit_dispute_hold_release(uuid, uuid, uuid, text)", "public.tw4_dispute_hold_switch_set(boolean, uuid, text)", "public.tw4_credit_dispute_holds_list(uuid, uuid)",
        "public.tw4_credit_apply_dispute(text, text, int, text, text)", "public.tw4_credit_set_hold(uuid, boolean, text, uuid)", "public.tw4_dispute_record_switch_set(boolean, uuid, text)"]) {
        expect(can("service_role", fn)).toBe("t");
        for (const role of ["anon", "authenticated"]) expect(can(role, fn)).toBe("f");
      }
      for (const fn of ["public._tw4dh_on_withdrawn(uuid)", "public._tw4dh_on_reinstated(uuid)", "public._tw4dh_auto_hold_on()", "public._tw4dh_record_on()", "public._tw4dh_switch_on(text)", "public._tw4dh_dispute_fee_cents()", "public._tw4dh_negative_alert()"]) {
        for (const role of ["anon", "authenticated", "service_role"]) expect(can(role, fn)).toBe("f");
      }
      for (const t of ["studio_sms_credit_dispute_holds", "studio_sms_dispute_hold_switch_log"]) {
        expect(psql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`)).toBe("t");
        for (const role of ["anon", "authenticated", "service_role"]) {
          expect(psql(`select has_table_privilege('${role}', 'public.${t}', 'select') or has_table_privilege('${role}', 'public.${t}', 'insert') or has_table_privilege('${role}', 'public.${t}', 'update')`)).toBe("f");
        }
      }
      for (const fn of ["_tw4dh_on_withdrawn", "_tw4dh_on_reinstated", "_tw4dh_auto_hold_on", "_tw4dh_record_on", "_tw4dh_switch_on", "_tw4dh_negative_alert", "tw4_dispute_record_switch_set", "tw4_credit_dispute_hold_release", "tw4_dispute_hold_switch_set", "tw4_credit_dispute_holds_list", "tw4_credit_apply_dispute", "tw4_credit_set_hold"]) {
        expect(psql(`select prosecdef and array_to_string(proconfig, ',') like '%search_path=pg_catalog, public, pg_temp%' from pg_proc where proname = '${fn}' and pronamespace = 'public'::regnamespace`)).toBe("t");
      }
    });

    it("the administrator list shows the cases (admin only) with the DanceFlow-borne fee", () => {
      expect(callError("tw4_credit_dispute_holds_list", NOT_ADMIN, null)).toMatch(/42501/);
      const list = call<Array<{ df_borne_fee_cents: number; hold_state: string }>>("tw4_credit_dispute_holds_list", ADMIN, null);
      expect(list.length).toBeGreaterThanOrEqual(6);
      expect(list.every((r) => r.df_borne_fee_cents === 1500)).toBe(true);
    });

    it("the migration file is LF-only and the fee constant is defined once", () => {
      const sql = readFileSync(join(MIG, MIGRATION), "utf8");
      expect(sql).not.toMatch(/\r/);
      expect(readFileSync(join(MIG, "rollback", MIGRATION.replace(".sql", "_rollback.sql")), "utf8")).not.toMatch(/\r/);
      expect(sql.replace(/--.*$/gm, "").match(/\b1500\b/g)).toHaveLength(1);
    });

    it("the rollback REFUSES while evidence exists; a clean rollback restores the previous bodies, and the migration re-applies", () => {
      const rollback = readFileSync(join(MIG, "rollback", MIGRATION.replace(".sql", "_rollback.sql")), "utf8");
      const bodyMd5 = (fn: string) => psql(`select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = '${fn}'::regprocedure`);
      const APPLY = "public.tw4_credit_apply_dispute(text,text,integer,text,text)";
      const SETHOLD = "public.tw4_credit_set_hold(uuid,boolean,text,uuid)";
      // the rollback's version guard names exactly the bodies this migration installed (a body edit here without updating the guard fails this test)
      expect(rollback).toContain(bodyMd5(APPLY));
      expect(rollback).toContain(bodyMd5(SETHOLD));
      // a function changed since the migration: the rollback refuses before touching anything
      for (const [fn, from, to] of [[APPLY, "invalid dispute event", "invalid dispute event!"], [SETHOLD, "a hold needs a reason", "a hold needs a reason!"]]) {
        const patch = (a: string, b: string) => psql(`select replace(pg_get_functiondef('${fn}'::regprocedure), '${a}', '${b}') \\gexec`);
        patch(from, to);
        try {
          const refused = psqlError(rollback);
          expect(refused).toMatch(/55000/);
          expect(refused).toMatch(/is no longer the version 20270221090100 installed/);
          expect(psql("select to_regclass('public.studio_sms_credit_dispute_holds') is not null")).toBe("t");   // nothing was dropped
        } finally {
          patch(to, from);
        }
        expect(rollback).toContain(bodyMd5(fn));
      }
      const err = psqlError(rollback);
      expect(err).toMatch(/dispute hold rollback refused/);
      expect(err).not.toMatch(/is no longer the version/);
      expect(err).toMatch(/55000/);
      expect(psql("select to_regclass('public.studio_sms_credit_dispute_holds') is not null")).toBe("t");
      // the test removes ONLY its own fixture evidence (the rollback itself never deletes history) to prove the clean path
      const mine = WORLDS.map((w) => `'${w.entity}'`).join(", ");
      replica(`delete from public.studio_sms_credit_dispute_holds where legal_entity_id in (${mine});
        delete from public.studio_sms_dispute_hold_switch_log;
        delete from public.studio_sms_provider_alerts where legal_entity_id in (${mine}) and kind in ('credit_dispute', 'credit_negative');
        update public.studio_sms_credit_accounts set hold = false, hold_reason = null where legal_entity_id in (${mine}) and hold_reason = 'dispute';`);
      expect(count("select 1 from public.studio_sms_credit_dispute_holds")).toBe(0);
      psql(rollback);
      // the restored bodies are the ones the guard accepts on a re-run
      expect(rollback).toContain(bodyMd5(APPLY));
      expect(rollback).toContain(bodyMd5(SETHOLD));
      expect(psql("select to_regclass('public.studio_sms_credit_dispute_holds') is null and to_regprocedure('public.tw4_credit_dispute_hold_release(uuid,uuid,uuid,text)') is null")).toBe("t");
      expect(psql("select pg_get_functiondef('public.tw4_credit_apply_dispute(text,text,integer,text,text)'::regprocedure) like '%_tw4dh_%'")).toBe("f");
      expect(psql("select pg_get_functiondef('public.tw4_credit_set_hold(uuid,boolean,text,uuid)'::regprocedure) like '%dispute%'")).toBe("f");
      expect(count("select 1 from pg_trigger where tgname = 'studio_sms_credit_accounts_negative_alert'")).toBe(0);
      expect(psql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_provider_alerts_kind_check'")).not.toMatch(/credit_dispute|credit_negative/);
      psql(rollback);                                                                   // re-runnable
      // a legacy MANUAL hold whose reason is literally 'dispute' would be mistaken for the automatic one: the migration refuses until it is given another reason
      replica(`update public.studio_sms_credit_accounts set hold = true, hold_reason = ' Dispute ' where legal_entity_id = '${WORLDS[0].entity}';`);
      expect(psqlError(readFileSync(join(MIG, MIGRATION), "utf8"))).toMatch(/manual hold whose reason is "dispute"/);
      expect(psql("select to_regclass('public.studio_sms_credit_dispute_holds') is null")).toBe("t");
      replica(`update public.studio_sms_credit_accounts set hold = false, hold_reason = null where legal_entity_id = '${WORLDS[0].entity}';`);
      psql(readFileSync(join(MIG, MIGRATION), "utf8"));                                // and the migration re-applies cleanly
      expect(psql("select public._tw4dh_dispute_fee_cents() || ':' || public._tw4dh_auto_hold_on()")).toBe("1500:false");
      expect(psql("select public._tw4dh_record_on()")).toBe("f");
    });
  });
});
