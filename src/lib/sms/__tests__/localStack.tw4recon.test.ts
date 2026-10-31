/**
 * TW-4F scheduled SMS usage reconciliation against a REAL schema (migrations through 20261205090000): stale-reservation release, identity-checked
 * evidence settlement, bounded evidence retries, escalation, run leases and fencing, inbound recovery with the webhook's rules, checkpoints, monitoring
 * and the rollback refusal. Nothing reaches Twilio: the provider is the in-memory fake. LOCAL QA STACK ONLY (skipped unless the variables point at a
 * loopback Supabase stack). Run serially (--no-file-parallelism): the run lease is one per job for the whole database.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ownerReactivate, seedPrice } from "../twilioIsv/__tests__/priceFixture";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 1_000_000 });

import { FakeBilledSmsProvider, type InboundMessageEvidence } from "@/lib/sms/usageProvider";
import { reconcileSmsUsage, recoverInboundUsage, runScheduledUsageReconciliation } from "@/lib/sms/usageReconciler";
import { SupabaseCreditStore } from "@/lib/sms/twilioIsv/creditStore";
import { LOCAL_QA_MARKER, newSenderIds, reconcilerReadySql, readySender } from "./senderFixtures";

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

const SA = "a6e00000-0000-4000-8000-00000000000a"; // business A (ordinary)
const SB = "a6e00000-0000-4000-8000-00000000000c"; // business B (pilot checks run inside a rolled-back transaction)
const EA = "e6e00000-0000-4000-8000-0000000000e1";
const EB = "e6e00000-0000-4000-8000-0000000000e2";
const U = { owner_a: "a6e00000-0000-4000-8000-000000000101", padmin: "a6e00000-0000-4000-8000-000000000401" };
const ACC_A = `AC${"a6".repeat(16)}`;
const ACC_B = `AC${"b6".repeat(16)}`;
const NUM_A = "+15125550301";
const NUM_B = "+15125550302";
const PHONE = "+15125550142";
const RUN = randomBytes(3).toString("hex");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};

const ENTITIES = `'${EA}', '${EB}'`;
const STUDIOS = `'${SA}', '${SB}'`;
const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_inbound_recoveries where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_inbound_unresolved where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_inbound_scan_cursors where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_reconcile_runs where runner like 'tw4recon:%';
delete from public.studio_sms_inbound_usage where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_inbound_exposure_ceilings where legal_entity_id in (${ENTITIES});
delete from public.sms_webhook_receipts where account_sid in ('${ACC_A}', '${ACC_B}');
delete from public.studio_sms_usage_attempt_events where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_usage_attempts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_sender_verifications where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_provisioning_steps where studio_id in (${STUDIOS});
delete from public.studio_sms_approval_refs where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_billed_senders where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_usage_switch_log where changed_by = '${U.padmin}';
delete from public.sms_message_logs where studio_id in (${STUDIOS});
delete from public.sms_consent_history where studio_id in (${STUDIOS});
delete from public.sms_contact_permissions where studio_id in (${STUDIOS});
delete from public.studio_sms_monthly_limits where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_timezones where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_ledger where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_reservations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES}));
delete from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_pilot_exceptions where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_twilio_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_studios where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_legal_entities where id in (${ENTITIES});
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in (${Object.values(U).map((u) => `'${u}'`).join(", ")});
delete from auth.users where email like '%@tw4recon-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4recon-e2e.test', now(), now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.padmin}', 'platform_admin') on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values ('${SA}', 'TW4RECON A', 'tw4recon-a', null, 'UTC'), ('${SB}', 'TW4RECON B', 'tw4recon-b', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${U.owner_a}', '${SA}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'REC Alpha LLC', '6551', 15000, '${U.padmin}'), ('${EB}', 'REC Beta LLC', '6552', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${SA}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A', now() - interval '2 days'),
  ('${SB}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B', now() - interval '2 days');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by, created_at) values
  ('${EA}', '${ACC_A}', 'df:test:${EA}', 'test', 'active', '${U.padmin}', now() - interval '3 days'), ('${EB}', '${ACC_B}', 'df:test:${EB}', 'test', 'active', '${U.padmin}', now() - interval '3 days');
commit;`;

describe.skipIf(!enabled)("TW-4F scheduled usage reconciliation (real schema, fake provider)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let snapshotActivePrices: string[] = [];
  let n = 0;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const balance = (e: string) => Number(psql(`select coalesce((select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${e}'), 0)`));
  const reserved = (e: string) => Number(psql(`select coalesce((select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${e}'), 0)`));
  const gaps = () => psql("select public._tw4us_reconciliation_gaps() + public._tw4in_reconciliation_gaps()");
  const state = (id: string) => psql(`select state from public.studio_sms_usage_attempts where id = '${id}'`);
  const att = (id: string) => JSON.parse(psql(`select row_to_json(a)::text from public.studio_sms_usage_attempts a where a.id = '${id}'`)) as Record<string, unknown>;
  const usageCharges = (id: string) => Number(psql(`select count(*) from public.studio_sms_credit_ledger where idempotency_key = 'usage:sms:${id}'`));
  const sid = () => `SM${randomBytes(16).toString("hex")}`;
  const price = () => Number(psql("select customer_price_cents from public.studio_sms_price_list where kind = 'sms_usage' and active"));
  const fund = async (e: string, studio: string, pack: number) => {
    n += 1;
    const ref = `cs_rec_${RUN}_${n}`;
    await credits.topupPending(e, studio, ref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(e, studio, ref, pack, `evt_rec_${RUN}_${n}`, `pi_rec_${RUN}_${n}`, true);
  };
  const resetMoney = (e: string) =>
    aged(`delete from public.studio_sms_inbound_unresolved where legal_entity_id = '${e}'; delete from public.studio_sms_inbound_recoveries where legal_entity_id = '${e}'; delete from public.studio_sms_inbound_usage where legal_entity_id = '${e}';
          delete from public.studio_sms_inbound_scan_cursors where legal_entity_id = '${e}';
          delete from public.studio_sms_usage_attempt_events where legal_entity_id = '${e}'; delete from public.studio_sms_usage_attempts where legal_entity_id = '${e}'; delete from public.sms_message_logs where studio_id in (select studio_id from public.studio_sms_entity_studios where legal_entity_id = '${e}');
          delete from public.studio_sms_credit_ledger where legal_entity_id = '${e}'; delete from public.studio_sms_credit_reservations where legal_entity_id = '${e}';
          delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id = '${e}');
          delete from public.studio_sms_credit_topups where legal_entity_id = '${e}'; delete from public.studio_sms_credit_accounts where legal_entity_id = '${e}'`);
  const ready = async (e: string, studio: string, funds = 5_000) => {
    resetMoney(e);
    if (funds > 0) await fund(e, studio, funds);
    expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: e, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly texting limit" })).error).toBeNull();
    aged(reconcilerReadySql(`tw4recon:ready:${RUN}`)); // cleaned with the suite's runs (runner tw4recon:%)
    expect((await rpc("tw4_usage_set_switch", { p_enabled: true, p_actor: U.padmin, p_reason: "fixture: switch on for tests" })).error).toBeNull();
  };
  const begun = async (studio: string, body = "Your lesson is tomorrow at 6pm. Reply STOP to opt out.") => {
    const r = await rpc("tw4_usage_begin", {
      p_source_kind: "manual", p_source_id: randomUUID(), p_studio_id: studio, p_client_id: null, p_phone_e164: PHONE, p_body: body,
      p_message_type: "manual", p_related_table: null, p_related_id: null, p_sent_by: null,
    });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return r.data as { attempt_id: string; amount_cents: number; account_sid: string; messaging_service_sid: string; sender_e164: string };
  };
  const marked = async (studio: string) => {
    const b = await begun(studio);
    expect((await rpc("tw4_usage_dispatching", { p_attempt_id: b.attempt_id })).data).toMatchObject({ dispatch: true });
    return b;
  };
  const submitted = async (studio: string) => {
    const b = await marked(studio);
    const s = sid();
    expect((await rpc("tw4_usage_submitted", { p_attempt_id: b.attempt_id, p_provider_sid: s })).error).toBeNull();
    return { ...b, sid: s };
  };
  /** evidence exactly as the provider seam builds it for THIS text (identity + time), with overrides */
  const ev = (a: { attempt_id: string; sid: string; account_sid: string; messaging_service_sid: string; sender_e164: string }, over: Record<string, unknown> = {}) => ({
    sid: a.sid, account_sid: a.account_sid, status: "delivered", num_segments: "1", num_media: "0", price: "-0.00790", price_unit: "USD",
    direction: "outbound-api", messaging_service_sid: a.messaging_service_sid, from: a.sender_e164, to: PHONE, date_created: new Date().toISOString(), date_sent: null, error_code: null, ...over,
  });
  const settle = (attemptId: string, evidence: Record<string, unknown>) => rpc("tw4_usage_settle", { p_attempt_id: attemptId, p_evidence: evidence });
  const closeRuns = () => aged("update public.studio_sms_reconcile_runs set status = 'failed', finished_at = clock_timestamp(), error = 'test cleanup' where status = 'running'");
  const runBegin = async (runner = `tw4recon:${RUN}`, lease = 300) => {
    const r = await rpc("tw4_reconcile_run_begin", { p_job: "usage_reconcile", p_runner: runner, p_lease_seconds: lease });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return r.data as { acquired: boolean; run_id?: string; reason?: string };
  };
  const withRun = async <T,>(fn: (runId: string) => Promise<T>): Promise<T> => {
    closeRuns();
    const lease = await runBegin();
    expect(lease.acquired).toBe(true);
    try {
      return await fn(lease.run_id as string);
    } finally {
      await rpc("tw4_reconcile_run_finish", { p_run_id: lease.run_id, p_status: "completed", p_summary: {}, p_error: null });
    }
  };
  const inboundMsg = (over: Partial<InboundMessageEvidence> = {}): InboundMessageEvidence => ({
    sid: sid(), account_sid: ACC_A, direction: "inbound", to: NUM_A, from: "+15125550142", messaging_service_sid: null, num_segments: "2", num_media: "0",
    date_created: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), date_sent: null, body: "Running ten minutes late, sorry", ...over,
  });
  const recover = (runId: string, m: InboundMessageEvidence, classification = "ordinary", keyword = false, account = ACC_A) =>
    rpc("tw4_inbound_recover", { p_run_id: runId, p_account_sid: account, p_evidence: { ...m, body: undefined, classification, keyword } });
  /** only this suite's subaccounts are listed: any other (another suite's leftovers) fails, so its checkpoint is never touched */
  const ownLister = (fake: FakeBilledSmsProvider) => ({
    listInbound: (account: string, window: { since: Date; until: Date; maxPages: number }) =>
      account === ACC_A || account === ACC_B ? fake.listInbound(account, window) : Promise.reject(new Error("usage_evidence_unreadable")),
  });

  beforeAll(async () => {
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
    psqlFile(LOCAL_QA_MARKER);
    closeRuns();
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    for (const [kind, cents] of [["sms_usage", 3], ["sms_inbound", 2]] as const) {
      seedPrice(psql, { kind: kind, customer: cents, provider: 1, description: `fixture ${kind} price`, approver: U.padmin });
    }
    await readySender(rpc, (sql) => aged(sql), { studio: SA, account: ACC_A, actor: U.padmin, ids: newSenderIds(NUM_A) });
    await readySender(rpc, (sql) => aged(sql), { studio: SB, account: ACC_B, actor: U.padmin, ids: newSenderIds(NUM_B) });
  });
  afterAll(() => {
    try {
      closeRuns();
      psqlFile(CLEANUP);
      aged(`delete from public.studio_sms_price_list where created_by = '${U.padmin}'`);
      ownerReactivate(psql, `id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
  });

  it("S17a (database side) privileges: new tables unreachable by API roles; actions service-role only; helpers callable by nobody; history is append-only / forward-only", () => {
    for (const table of ["studio_sms_reconcile_runs", "studio_sms_inbound_scan_cursors", "studio_sms_inbound_recoveries"]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_table_privilege('${role}', 'public.${table}', 'select,insert,update,delete')`), `${role} ${table}`).toBe("f");
    }
    for (const fn of [
      "tw4_reconcile_run_begin(text, text, int)", "tw4_reconcile_run_finish(uuid, text, jsonb, text)", "tw4_usage_release_stale(uuid, int)", "tw4_usage_settle(uuid, jsonb)",
      "tw4_usage_evidence_failed(uuid, text, boolean)", "tw4_usage_due(int)", "tw4_usage_escalate(uuid, int)", "tw4_inbound_scan_targets(int)",
      "tw4_inbound_recover(uuid, text, jsonb)", "tw4_inbound_scan_advance(uuid, text, timestamptz)", "tw4_usage_reconcile_overview(uuid, int)",
    ]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    for (const fn of ["_tw4ur_fence(uuid, text)", "_tw4ur_account_of(uuid, text)", "_tw4ur_instant(text)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("f");
    }
    expect(psqlError("truncate public.studio_sms_inbound_recoveries")).toContain("never truncated");
    expect(psqlError("delete from public.studio_sms_reconcile_runs")).toBe(""); // no rows touched is fine; rows are refused (QA-05)
  });

  it("S01 stale reservations: only attempts with NO dispatch marker, older than 10 minutes, are released; a transient prepare failure is among them", async () => {
    await ready(EA, SA);
    const before = balance(EA);
    const old = await begun(SA);
    const fresh = await begun(SA);
    const transient = await begun(SA); // the delivery path kept it reserved after credentials_unavailable and never retried
    const markedOld = await marked(SA);
    aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '11 minutes', submitting_at = case when state = 'submitting' then now() - interval '11 minutes' end
           where id in ('${old.attempt_id}', '${transient.attempt_id}', '${markedOld.attempt_id}')`);
    const released = await withRun((runId) => rpc("tw4_usage_release_stale", { p_run_id: runId, p_limit: 200 }));
    expect(released.error).toBeNull();
    expect([state(old.attempt_id), state(transient.attempt_id), state(fresh.attempt_id), state(markedOld.attempt_id)]).toEqual(["released", "released", "reserved", "submitting"]);
    expect(att(old.attempt_id).submit_error_code).toBe("stale_unmarked");
    expect(reserved(EA)).toBe(fresh.amount_cents + markedOld.amount_cents);
    expect(balance(EA)).toBe(before); // a release never moves the balance
    // a replay of the released source reads 'released' and the marker refuses it: nothing can be sent after the release
    expect((await rpc("tw4_usage_dispatching", { p_attempt_id: old.attempt_id })).data).toMatchObject({ dispatch: false, state: "released" });
    expect(gaps()).toBe("0");
  });

  it("S02 a marked or unknown attempt with no SID is NEVER released by a timer, however old; it is escalated after 15 minutes for a written admin resolution", async () => {
    await ready(EA, SA);
    const sub = await marked(SA);
    const unk = await marked(SA);
    expect((await rpc("tw4_usage_uncertain", { p_attempt_id: unk.attempt_id, p_error_code: "timeout" })).error).toBeNull();
    aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '30 days', submitting_at = now() - interval '30 days' where id in ('${sub.attempt_id}', '${unk.attempt_id}')`);
    const escalated = await withRun(async (runId) => {
      await rpc("tw4_usage_release_stale", { p_run_id: runId, p_limit: 500 });
      return rpc("tw4_usage_escalate", { p_run_id: runId, p_limit: 500 });
    });
    expect(escalated.error).toBeNull();
    expect([state(sub.attempt_id), state(unk.attempt_id)]).toEqual(["submitting", "unknown"]);
    expect(att(sub.attempt_id).escalated_at).not.toBeNull();
    expect(reserved(EA)).toBe(sub.amount_cents + unk.amount_cents); // still held
    // a late SID still binds after escalation (the state was kept for exactly this)
    const late = sid();
    expect((await rpc("tw4_usage_submitted", { p_attempt_id: unk.attempt_id, p_provider_sid: late })).error).toBeNull();
    expect(state(unk.attempt_id)).toBe("submitted");
    // the written admin resolution closes the other one: platform admin only, a written reason, audited immutably, and final
    const resolve = (actor: string, reason: string) => rpc("tw4_usage_resolve", { p_attempt_id: sub.attempt_id, p_actor: actor, p_outcome: "released", p_segments: null, p_reason: reason });
    expect((await resolve(U.owner_a, "fixture: confirmed in Twilio console not sent")).error?.code).toBe("42501"); // a studio owner is not a platform admin
    expect((await resolve(U.padmin, "too short")).error?.code).toBe("22023"); // a written reason (10+ characters) is required
    expect(state(sub.attempt_id)).toBe("submitting");
    expect((await resolve(U.padmin, "fixture: confirmed in Twilio console not sent")).error).toBeNull();
    expect(state(sub.attempt_id)).toBe("released");
    expect(psql(`select count(*) from public.studio_sms_onboarding_audit where action = 'usage_resolved' and actor_user_id = '${U.padmin}' and note like 'attempt=${sub.attempt_id};outcome=released;%confirmed in Twilio console%'`)).toBe("1");
    expect(psql(`select facts->>'resolved_by' || ':' || (facts->>'resolved_outcome') from public.studio_sms_usage_attempt_events where attempt_id = '${sub.attempt_id}' and to_state = 'released'`)).toBe(`${U.padmin}:released`);
    expect(psqlError(`update public.studio_sms_onboarding_audit set note = 'x' where action = 'usage_resolved' and actor_user_id = '${U.padmin}'`)).toContain("append-only");
    expect((await resolve(U.padmin, "fixture: a retried admin action must not apply twice")).error?.code).toBe("22023"); // retried: refused, nothing moves
    expect(psql(`select count(*) from public.studio_sms_credit_ledger where idempotency_key like 'release:sms:${sub.attempt_id}'`)).toBe("1");
    expect(gaps()).toBe("0");
  });

  it("S10a verified evidence settles exactly once: reservation released, one usage charge, the log updated; repeated settles are replays", async () => {
    await ready(EA, SA);
    const before = balance(EA);
    const s = await submitted(SA);
    const r = await settle(s.attempt_id, ev(s));
    expect(r.data).toMatchObject({ outcome: "settled", charged_cents: price(), replayed: false });
    expect((await settle(s.attempt_id, ev(s))).data).toMatchObject({ outcome: "settled", replayed: true });
    expect(usageCharges(s.attempt_id)).toBe(1);
    expect(balance(EA)).toBe(before - price());
    expect(reserved(EA)).toBe(0);
    expect(gaps()).toBe("0");
  });

  it("S05a runs: one lease per job; an overlapping begin is busy; an expired lease is closed as failed; finished runs are final", async () => {
    closeRuns();
    const first = await runBegin(`tw4recon:${RUN}:a`, 60);
    expect(first.acquired).toBe(true);
    expect(await runBegin(`tw4recon:${RUN}:b`)).toEqual({ acquired: false, reason: "busy" });
    aged(`update public.studio_sms_reconcile_runs set lease_expires_at = clock_timestamp() - interval '1 second' where id = '${first.run_id}'`); // crashed run
    const second = await runBegin(`tw4recon:${RUN}:c`);
    expect(second.acquired).toBe(true);
    expect(psql(`select status || ':' || coalesce(error, '') from public.studio_sms_reconcile_runs where id = '${first.run_id}'`)).toBe("failed:lease expired before the run finished");
    // the crashed run's writes are now refused (fenced), with a custom errcode (not 40001, which PostgREST would retry)
    expect((await rpc("tw4_usage_release_stale", { p_run_id: first.run_id, p_limit: 10 })).error?.code).toBe("TW023");
    expect((await rpc("tw4_reconcile_run_finish", { p_run_id: second.run_id, p_status: "completed", p_summary: { settled: 1 }, p_error: null })).data).toMatchObject({ replayed: false });
    expect((await rpc("tw4_reconcile_run_finish", { p_run_id: second.run_id, p_status: "failed", p_summary: null, p_error: "x" })).data).toMatchObject({ status: "completed", replayed: true });
    expect(psqlError(`delete from public.studio_sms_reconcile_runs where id = '${second.run_id}'`)).toContain("append-only");
    expect(psqlError(`update public.studio_sms_reconcile_runs set status = 'running', finished_at = null where id = '${second.run_id}'`)).toContain("final");
    for (const bad of [{ p_job: "other", p_runner: "tw4recon:x", p_lease_seconds: 300 }, { p_job: "usage_reconcile", p_runner: "x", p_lease_seconds: 300 }, { p_job: "usage_reconcile", p_runner: "tw4recon:x", p_lease_seconds: 5 }]) {
      expect((await rpc("tw4_reconcile_run_begin", bad)).error?.code).toBe("22023");
    }
  });

  it("S20a identity mismatches go to review, never charge and never release (even a 'failed' status)", async () => {
    await ready(EA, SA);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ direction: "inbound" }, "evidence is not an outbound API message"],
      [{ messaging_service_sid: `MG${"0".repeat(32)}` }, "evidence names another Messaging Service"],
      [{ to: "+15125550999" }, "evidence names another destination"],
      [{ from: "+15125550998" }, "evidence names another sender number"],
      [{ from: null }, "evidence has no sender number"],
      [{ date_created: null }, "evidence has no creation time"],
      [{ date_created: "Tue, 20 Oct 2026 12:00:00 +0000" }, "evidence has no creation time"], // not ISO: never parsed loosely
      [{ date_created: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }, "evidence was created outside the send window"],
      [{ status: "failed", to: "+15125550999" }, "evidence names another destination"],
    ];
    for (const [over, reason] of cases) {
      const s = await submitted(SA);
      const r = await settle(s.attempt_id, ev(s, over));
      expect(r.data, JSON.stringify(over)).toMatchObject({ outcome: "review", reason });
      expect(state(s.attempt_id)).toBe("review");
      expect(usageCharges(s.attempt_id)).toBe(0);
      expect(psql(`select r.status from public.studio_sms_credit_reservations r join public.studio_sms_usage_attempts a on a.reservation_id = r.id where a.id = '${s.attempt_id}'`)).toBe("reserved");
    }
    // pending with no sender number yet (messaging service still choosing) is pending, not review
    const p = await submitted(SA);
    expect((await settle(p.attempt_id, ev(p, { status: "queued", from: null }))).data).toMatchObject({ outcome: "pending" });
    expect(gaps()).toBe("0");
  });

  it("S09a evidence naming another message or account is refused; the reconciler records it as a definite failure (review)", async () => {
    await ready(EA, SA);
    const s = await submitted(SA);
    expect((await settle(s.attempt_id, ev(s, { sid: sid() }))).error?.code).toBe("42501");
    expect((await settle(s.attempt_id, ev(s, { account_sid: ACC_B }))).error?.code).toBe("42501");
    const fake = new FakeBilledSmsProvider().setEvidence(s.sid, { account_sid: ACC_B });
    aged(`update public.studio_sms_usage_attempts set last_reconciled_at = null where id = '${s.attempt_id}'`);
    const summary = await reconcileSmsUsage(admin, fake, {});
    expect(summary.review).toBeGreaterThanOrEqual(1);
    expect(att(s.attempt_id)).toMatchObject({ state: "review", evidence_error_code: "usage_settle_refused" });
    expect(usageCharges(s.attempt_id)).toBe(0);
  });

  it("S09b cross-tenant: an attempt whose frozen account is not its business's subaccount is never read; escalation sends it to review", async () => {
    await ready(EA, SA);
    const s = await submitted(SA);
    aged(`update public.studio_sms_usage_attempts set account_sid = '${ACC_B}' where id = '${s.attempt_id}'`); // impossible through the functions: a corrupted row
    const due = (await rpc("tw4_usage_due", { p_limit: 500 })).data as Array<{ attempt_id: string }>;
    expect(due.some((d) => d.attempt_id === s.attempt_id)).toBe(false);
    await withRun((runId) => rpc("tw4_usage_escalate", { p_run_id: runId, p_limit: 500 }));
    expect(att(s.attempt_id)).toMatchObject({ state: "review", review_reason: "the subaccount does not belong to the business" });
    expect(usageCharges(s.attempt_id)).toBe(0);
    resetMoney(EA);
  });

  it("S07a transient read failures back off and are bounded: not due until the retry time, review after 12 failures AND 24 hours, never released", async () => {
    await ready(EA, SA);
    const s = await submitted(SA);
    const first = await rpc("tw4_usage_evidence_failed", { p_attempt_id: s.attempt_id, p_code: "usage_evidence_timeout", p_definite: false });
    expect(first.data).toMatchObject({ outcome: "retry", failures: 1 });
    const due = (await rpc("tw4_usage_due", { p_limit: 500 })).data as Array<{ attempt_id: string }>;
    expect(due.some((d) => d.attempt_id === s.attempt_id)).toBe(false);
    const next = Date.parse(String(att(s.attempt_id).evidence_next_at));
    expect(next - Date.now()).toBeGreaterThan(4 * 60_000);
    for (let i = 2; i <= 12; i += 1) await rpc("tw4_usage_evidence_failed", { p_attempt_id: s.attempt_id, p_code: "usage_evidence_timeout", p_definite: false });
    expect(att(s.attempt_id)).toMatchObject({ state: "submitted", evidence_failures: 12 }); // young: still retrying
    expect(Date.parse(String(att(s.attempt_id).evidence_next_at)) - Date.now()).toBeLessThanOrEqual(6 * 60 * 60_000 + 5_000); // capped at 6 h
    aged(`update public.studio_sms_usage_attempts set submitted_at = now() - interval '25 hours' where id = '${s.attempt_id}'`);
    expect((await rpc("tw4_usage_evidence_failed", { p_attempt_id: s.attempt_id, p_code: "usage_evidence_timeout", p_definite: false })).data).toMatchObject({ outcome: "review" });
    expect(att(s.attempt_id)).toMatchObject({ state: "review", review_reason: "evidence unavailable: usage_evidence_timeout" });
    expect(reserved(EA)).toBe(s.amount_cents);
    for (const bad of ["", "Bad Code", "x".repeat(70)]) expect((await rpc("tw4_usage_evidence_failed", { p_attempt_id: s.attempt_id, p_code: bad, p_definite: false })).error?.code).toBe("22023");
  });

  it("S20b a definite read failure (404) goes to review at once; a failure recorded after settlement changes nothing", async () => {
    await ready(EA, SA);
    const s = await submitted(SA);
    aged(`update public.studio_sms_usage_attempts set submitted_at = now() - interval '20 minutes' where id = '${s.attempt_id}'`); // past the young-404 window (R2)
    expect((await rpc("tw4_usage_evidence_failed", { p_attempt_id: s.attempt_id, p_code: "usage_evidence_http_404", p_definite: true })).data).toMatchObject({ outcome: "review" });
    const t = await submitted(SA);
    await settle(t.attempt_id, ev(t));
    expect((await rpc("tw4_usage_evidence_failed", { p_attempt_id: t.attempt_id, p_code: "usage_evidence_timeout", p_definite: true })).data).toMatchObject({ outcome: "skipped", state: "settled" });
    expect(gaps()).toBe("0");
  });

  it("S03b pending status: retried while recent, review after 7 days without a final status; 'sent' after 72 h is charged", async () => {
    await ready(EA, SA);
    const p = await submitted(SA);
    expect((await settle(p.attempt_id, ev(p, { status: "sending" }))).data).toMatchObject({ outcome: "pending" });
    aged(`update public.studio_sms_usage_attempts set submitted_at = now() - interval '8 days', submitting_at = now() - interval '8 days', created_at = now() - interval '8 days' where id = '${p.attempt_id}'`);
    expect((await settle(p.attempt_id, ev(p, { status: "queued", date_created: new Date(Date.now() - 8 * 86_400_000).toISOString() }))).data).toMatchObject({ outcome: "review", reason: "no final status after 7 days" });
    const q = await submitted(SA);
    aged(`update public.studio_sms_usage_attempts set submitted_at = now() - interval '73 hours', submitting_at = now() - interval '73 hours', created_at = now() - interval '73 hours' where id = '${q.attempt_id}'`);
    expect((await settle(q.attempt_id, ev(q, { status: "sent", date_created: new Date(Date.now() - 73 * 3_600_000).toISOString() }))).data).toMatchObject({ outcome: "settled", charged_cents: price() });
  });

  it("S11a price and segment sanity: a provider price far above the expected cost, too many segments, or MMS go to review", async () => {
    await ready(EA, SA);
    const a = await submitted(SA);
    expect((await settle(a.attempt_id, ev(a, { price: "-0.90000" }))).data).toMatchObject({ outcome: "review", reason: "provider price far above the expected cost" });
    const b = await submitted(SA);
    expect((await settle(b.attempt_id, ev(b, { num_segments: "9" }))).data).toMatchObject({ outcome: "review", reason: "segment count outside the expected range" });
    const c = await submitted(SA);
    expect((await settle(c.attempt_id, ev(c, { num_media: "1" }))).data).toMatchObject({ outcome: "review", reason: "multimedia message" });
    const d = await submitted(SA);
    expect((await settle(d.attempt_id, ev(d, { price_unit: "EUR" }))).data).toMatchObject({ outcome: "review", reason: "price not in USD" });
    const e = await submitted(SA);
    expect((await settle(e.attempt_id, ev(e, { price: null }))).data).toMatchObject({ outcome: "settled" }); // price is cost evidence, never a gate
  });

  it("S04a webhook races: a callback binds the SID of an uncertain send, settles once; a late callback after settlement changes nothing; concurrent settles charge once", async () => {
    await ready(EA, SA);
    const u = await marked(SA);
    await rpc("tw4_usage_uncertain", { p_attempt_id: u.attempt_id, p_error_code: "timeout" });
    const bound = sid();
    expect((await rpc("tw4_usage_record_callback", { p_attempt_id: u.attempt_id, p_provider_sid: bound, p_signer_account: ACC_A, p_status: "delivered", p_error_code: null })).error).toBeNull();
    const evidence = ev({ ...u, sid: bound });
    const results = await Promise.all([settle(u.attempt_id, evidence), settle(u.attempt_id, evidence), settle(u.attempt_id, evidence)]);
    expect(results.filter((r) => (r.data as { replayed?: boolean }).replayed === false)).toHaveLength(1);
    expect(usageCharges(u.attempt_id)).toBe(1);
    expect((await rpc("tw4_usage_record_callback", { p_attempt_id: u.attempt_id, p_provider_sid: bound, p_signer_account: ACC_A, p_status: "undelivered", p_error_code: null })).data).toMatchObject({ needs_reconcile: false });
    // nothing reverses a settled outcome: later 'failed' evidence is a replay, a failure note is skipped, an admin cannot resolve it, a direct write is refused
    const charged = att(u.attempt_id).charged_cents;
    expect((await settle(u.attempt_id, { ...evidence, status: "failed" })).data).toMatchObject({ outcome: "settled", replayed: true, charged_cents: charged });
    expect((await rpc("tw4_usage_evidence_failed", { p_attempt_id: u.attempt_id, p_code: "usage_evidence_http_404", p_definite: true })).data).toMatchObject({ outcome: "skipped" });
    aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '1 hour', submitting_at = now() - interval '1 hour' where id = '${u.attempt_id}'`);
    expect((await rpc("tw4_usage_resolve", { p_attempt_id: u.attempt_id, p_actor: U.padmin, p_outcome: "not_charged", p_segments: null, p_reason: "fixture: trying to undo a settled charge" })).error?.code).toBe("22023");
    expect(psqlError(`begin; select set_config('tw4.usage_write', 'on', true); update public.studio_sms_usage_attempts set charged_cents = 0 where id = '${u.attempt_id}'; rollback;`)).toContain("final");
    expect(att(u.attempt_id)).toMatchObject({ state: "settled", charged_cents: charged });
    expect(usageCharges(u.attempt_id)).toBe(1);
    // a callback signed by another business's subaccount is refused
    const v = await submitted(SA);
    expect((await rpc("tw4_usage_record_callback", { p_attempt_id: v.attempt_id, p_provider_sid: v.sid, p_signer_account: ACC_B, p_status: "delivered", p_error_code: null })).error?.code).toBe("42501");
    expect(gaps()).toBe("0");
  });

  it("S11b 'failed' / 'canceled' evidence with matching identity releases with no charge", async () => {
    await ready(EA, SA);
    const before = balance(EA);
    for (const status of ["failed", "canceled"]) {
      const s = await submitted(SA);
      expect((await settle(s.attempt_id, ev(s, { status }))).data).toMatchObject({ outcome: "settled", charged_cents: 0 });
    }
    expect(balance(EA)).toBe(before);
    expect(reserved(EA)).toBe(0);
    expect(gaps()).toBe("0");
  });

  it("S05b/S07b the full scheduled run end to end (fake provider): releases, settles, retries, escalates, records the run; an overlapping run is busy", async () => {
    await ready(EA, SA);
    closeRuns();
    const stale = await begun(SA);
    aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '11 minutes' where id = '${stale.attempt_id}'`);
    const fake = new FakeBilledSmsProvider();
    const good = await submitted(SA);
    const broken = await submitted(SA);
    fake.failFetch(broken.sid);
    // the fake only knows identity for texts it sent itself: give it this text's identity
    fake.setEvidence(good.sid, ev(good));
    const lister = ownLister(new FakeBilledSmsProvider());
    const provider = Object.assign(fake, { listInbound: lister.listInbound });
    const outcome = await runScheduledUsageReconciliation(admin, provider, { runner: `tw4recon:${RUN}:e2e`, budgetMs: 30_000 });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;
    expect(outcome.failed).toBe(false);
    expect([state(stale.attempt_id), state(good.attempt_id), state(broken.attempt_id)]).toEqual(["released", "settled", "submitted"]);
    expect(att(broken.attempt_id)).toMatchObject({ evidence_failures: 1, evidence_error_code: "usage_evidence_unreadable" });
    const run = JSON.parse(psql(`select row_to_json(r)::text from public.studio_sms_reconcile_runs r where r.id = '${outcome.runId}'`)) as { status: string; summary: Record<string, unknown> };
    expect(run.status).toBe("completed");
    expect(run.summary).toMatchObject({ evidence_read: true });
    expect(Number(run.summary.released_unsent)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(run.summary)).not.toMatch(/SM[0-9a-f]{32}|\+1[0-9]{10}/); // counts only
    // overlap: while a run holds the lease another invocation does nothing
    const held = await runBegin(`tw4recon:${RUN}:hold`);
    expect(held.acquired).toBe(true);
    expect(await runScheduledUsageReconciliation(admin, provider, { runner: `tw4recon:${RUN}:2` })).toEqual({ ran: false, reason: "busy" });
    closeRuns();
    expect(gaps()).toBe("0");
  });

  it("S12 inbound recovery: a missed ordinary text is recorded once from evidence, charged at the inbound price; a webhook-recorded one is 'already_recorded'", async () => {
    await ready(EA, SA);
    const before = balance(EA);
    const m = inboundMsg({ num_segments: "2" });
    const r = await withRun((runId) => recover(runId, m));
    expect(r.data).toMatchObject({ outcome: "recovered", classification: "ordinary", basis: "ordinary", webhook_seen: false, charged_cents: 4 });
    expect(psql(`select source || ':' || classification || ':' || segments || ':' || charged_cents from public.studio_sms_inbound_usage where provider_sid = '${m.sid}'`)).toBe("reconciler:ordinary:2:4");
    expect(Date.parse(psql(`select received_at from public.studio_sms_inbound_usage where provider_sid = '${m.sid}'`).replace(" ", "T").replace(/\+00$/, "Z"))).toBeCloseTo(Date.parse(String(m.date_created)), -4);
    expect(balance(EA)).toBe(before - 4);
    expect((await withRun((runId) => recover(runId, m))).data).toMatchObject({ outcome: "already_recorded" });
    // the webhook recorded this one first: recovery is a replay and never re-charges or re-classifies
    const w = inboundMsg();
    expect((await rpc("tw4_inbound_record", { p_studio_id: SA, p_signer_account: ACC_A, p_provider_sid: w.sid, p_segments: 1, p_media: 0, p_classification: "compliance", p_reply_body: null, p_received_at: null, p_source: "webhook" })).error).toBeNull();
    expect((await withRun((runId) => recover(runId, w, "ordinary"))).data).toMatchObject({ outcome: "already_recorded" });
    expect(psql(`select classification from public.studio_sms_inbound_usage where provider_sid = '${w.sid}'`)).toBe("compliance");
    expect(balance(EA)).toBe(before - 4);
    expect(gaps()).toBe("0");
  });

  it("S20c inbound classification fails safe: keyword, uncertain and incomplete evidence are compliance (never charged); an unseen keyword is flagged", async () => {
    await ready(EA, SA);
    const before = balance(EA);
    const kw = inboundMsg();
    aged(`insert into public.sms_webhook_receipts (kind, event_key, account_sid) values ('inbound', '${kw.sid}', '${ACC_A}')`);
    const rows = await withRun(async (runId) => [
      await recover(runId, kw, "compliance", true),                       // webhook seen
      await recover(runId, inboundMsg(), "compliance", true),            // webhook never saw it
      await recover(runId, inboundMsg(), "uncertain", false),
      await recover(runId, inboundMsg({ num_segments: null }), "ordinary"),
      await recover(runId, inboundMsg({ date_created: null }), "ordinary"),
      await recover(runId, inboundMsg({ num_media: "abc" }), "ordinary"),
    ]);
    expect(rows.map((r) => [(r.data as { basis: string }).basis, (r.data as { classification: string }).classification])).toEqual([
      ["keyword", "compliance"], ["keyword", "compliance"], ["uncertain", "compliance"], ["incomplete", "compliance"], ["incomplete", "compliance"], ["incomplete", "compliance"],
    ]);
    expect((rows[0].data as { webhook_seen: boolean }).webhook_seen).toBe(true);
    expect((rows[1].data as { webhook_seen: boolean }).webhook_seen).toBe(false);
    expect(balance(EA)).toBe(before);
    const overview = (await rpc("tw4_usage_reconcile_overview", { p_actor: U.padmin, p_limit: 50 })).data as { inbound: { keywords_unseen: Array<{ studio_id: string }> } };
    // both keyword recoveries are listed (the webhook may have stopped after its receipt), each with whether the webhook was seen
    expect(overview.inbound.keywords_unseen.filter((k) => k.studio_id === SA).map((k) => (k as { webhook_seen?: boolean }).webhook_seen).sort()).toEqual([false, true]);
  });

  it("S15a/S16 inbound recovery keeps the webhook's money rules: the $10 negative-balance ceiling, and no debt for the pilot business", async () => {
    await ready(EA, SA, 0); // no credit at all
    // the business's negative-balance ceiling (the D1 rule; $10 by default) lowered to 50c so three 40c texts cross it
    expect((await rpc("tw4_inbound_exposure_set", { p_entity_id: EA, p_actor: U.padmin, p_cents: 50, p_reason: "fixture: small inbound ceiling" })).error).toBeNull();
    const results = await withRun(async (runId) => {
      const out = [];
      for (let i = 0; i < 3; i += 1) out.push((await recover(runId, inboundMsg({ num_segments: "20" }))).data as { charged_cents: number; uncollected_cents: number });
      return out;
    });
    expect(results.map((r) => r.charged_cents)).toEqual([40, 10, 0]); // charged only down to -50c; the text is never refused
    expect(results.map((r) => r.uncollected_cents)).toEqual([0, 30, 40]);
    expect(balance(EA)).toBe(-50);
    aged(`delete from public.studio_sms_inbound_exposure_ceilings where legal_entity_id = '${EA}'`);
    // pilot business: inside a rolled-back transaction, a recovered ordinary text charges nothing below zero
    const out = execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], {
      input: `begin; set local session_replication_role = replica;
        insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${EB}', 15000, 'fixture approval reference text ${RUN}', '${U.padmin}');
        update public.studio_sms_reconcile_runs set status = 'failed', finished_at = clock_timestamp() where status = 'running';
        reset session_replication_role;
        select (public.tw4_inbound_recover((public.tw4_reconcile_run_begin('usage_reconcile', 'tw4recon:pilot', 120)->>'run_id')::uuid, '${ACC_B}',
          jsonb_build_object('sid', 'SM${randomBytes(16).toString("hex")}', 'account_sid', '${ACC_B}', 'direction', 'inbound', 'to', '${NUM_B}', 'num_segments', '3', 'num_media', '0',
                             'date_created', to_char((now() - interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'classification', 'ordinary', 'keyword', false)))->>'charged_cents';
        rollback;`,
      encoding: "utf8",
    }).trim().split("\n");
    expect(out.filter((l) => /^[0-9]+$/.test(l))).toEqual(["0"]);
  });

  it("S09c/S13a inbound tenancy and checkpoints: another business's number is unrouted, a foreign account is refused, checkpoints are fenced and only move forward", async () => {
    await ready(EA, SA);
    const result = await withRun(async (runId) => ({
      foreignNumber: await recover(runId, inboundMsg({ to: NUM_B })),                         // B's number on A's account
      mismatched: await recover(runId, inboundMsg({ account_sid: ACC_B })),                   // evidence of another account
      unknownAccount: await recover(runId, inboundMsg({ account_sid: `AC${"cd".repeat(16)}` }), "ordinary", false, `AC${"cd".repeat(16)}`),
      outbound: await recover(runId, inboundMsg({ direction: "outbound-api" })),
      advance: await rpc("tw4_inbound_scan_advance", { p_run_id: runId, p_account_sid: ACC_A, p_through: new Date(Date.now() - 60 * 60_000).toISOString() }),
      backwards: await rpc("tw4_inbound_scan_advance", { p_run_id: runId, p_account_sid: ACC_A, p_through: new Date(Date.now() - 5 * 60 * 60_000).toISOString() }),
      future: await rpc("tw4_inbound_scan_advance", { p_run_id: runId, p_account_sid: ACC_A, p_through: new Date().toISOString() }),
    }));
    expect(result.foreignNumber.data).toMatchObject({ outcome: "unrouted" });
    expect(result.mismatched.error?.code).toBe("42501");
    expect(result.unknownAccount.error?.code).toBe("42501");
    expect(result.outbound.data).toMatchObject({ outcome: "skipped", reason: "not_inbound" });
    expect(result.advance.error).toBeNull();
    const through = Date.parse(String((result.advance.data as { scanned_through: string }).scanned_through));
    expect(Date.parse(String((result.backwards.data as { scanned_through: string }).scanned_through))).toBe(through); // never backwards
    expect(result.future.error?.code).toBe("22023");
    expect(psqlError(`update public.studio_sms_inbound_scan_cursors set scanned_through = now() - interval '9 days' where account_sid = '${ACC_A}'`)).toContain("only moves forward");
    // no live run: fenced
    closeRuns();
    expect((await rpc("tw4_inbound_scan_advance", { p_run_id: randomUUID(), p_account_sid: ACC_A, p_through: new Date(Date.now() - 60 * 60_000).toISOString() })).error?.code).toBe("TW023");
    expect((await recover(randomUUID(), inboundMsg())).error?.code).toBe("TW023");
    // the library pass: lists this suite's subaccounts, recovers, advances only complete scans
    resetMoney(EA);
    aged(`delete from public.studio_sms_inbound_scan_cursors where account_sid = '${ACC_B}'`);
    // a first scan starts two days back and covers at most 24 hours per run: these texts are 36 hours old
    const old = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const fake = new FakeBilledSmsProvider().setInbound(ACC_A, [inboundMsg({ date_created: old }), inboundMsg({ body: "STOP", date_created: old })]).failList(ACC_B);
    const summary = await withRun((runId) => recoverInboundUsage(admin, ownLister(fake), { runId }));
    expect(summary.recovered).toBe(2);
    expect(psql(`select count(*) from public.studio_sms_inbound_scan_cursors where account_sid = '${ACC_A}'`)).toBe("1");
    expect(psql(`select count(*) from public.studio_sms_inbound_scan_cursors where account_sid = '${ACC_B}'`)).toBe("0"); // its list failed: not advanced
    expect(gaps()).toBe("0");
  });

  it("S18 monitoring is platform-admin only and shows runs, alerts and exceptions without bodies or client numbers; the rollback refuses once evidence exists", async () => {
    await ready(EA, SA);
    const u = await marked(SA);
    aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '1 hour', submitting_at = now() - interval '1 hour' where id = '${u.attempt_id}'`);
    await withRun((runId) => rpc("tw4_usage_escalate", { p_run_id: runId, p_limit: 500 }));
    expect((await rpc("tw4_usage_reconcile_overview", { p_actor: U.owner_a, p_limit: 10 })).error?.code).toBe("42501");
    const o = (await rpc("tw4_usage_reconcile_overview", { p_actor: U.padmin, p_limit: 200 })).data as Record<string, unknown>;
    expect(o).toMatchObject({ switch_on: true, usage_gaps: 0, inbound_gaps: 0 });
    expect(typeof o.stale).toBe("boolean");
    const ex = (o.exceptions as Array<Record<string, unknown>>).find((x) => x.attempt_id === u.attempt_id);
    expect(ex).toMatchObject({ state: "submitting", has_provider_message: false, reserved_cents: u.amount_cents });
    expect(JSON.stringify(o)).not.toContain(PHONE);
    expect(JSON.stringify(o)).not.toContain("Your lesson");
    // the switch on, no completed run for 30 minutes -> stale alert
    aged("update public.studio_sms_reconcile_runs set finished_at = clock_timestamp() - interval '2 hours', started_at = clock_timestamp() - interval '2 hours' where job = 'usage_reconcile' and status <> 'running'");
    expect(((await rpc("tw4_usage_reconcile_overview", { p_actor: U.padmin, p_limit: 1 })).data as { stale: boolean }).stale).toBe(true);
    // rollback: refused now (runs and evidence exist); the statement runs inside a transaction that is rolled back either way
    const rollback = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261205090000_twilio_usage_reconciliation_rollback.sql"), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    expect(psqlError(`begin;\n${rollback}\nrollback;`)).toContain("rollback refused: reconciliation evidence exists");
    expect(psql("select to_regclass('public.studio_sms_reconcile_runs') is not null")).toBe("t");
  });

  it("S03 an accepted message whose callback never arrives is settled from the provider's evidence by the reconciler; the transition history records it", async () => {
    await ready(EA, SA);
    const s = await submitted(SA);
    const fake = new FakeBilledSmsProvider().setEvidence(s.sid, ev(s));
    await reconcileSmsUsage(admin, fake, {});
    expect(att(s.attempt_id)).toMatchObject({ state: "settled", charged_cents: price(), callback_status: null });
    const history = psql(`select string_agg(coalesce(from_state, '-') || '>' || to_state, ',' order by id) from public.studio_sms_usage_attempt_events where attempt_id = '${s.attempt_id}'`);
    expect(history).toBe("->reserved,reserved>submitting,submitting>submitted,submitted>submitted,submitted>settled"); // the evidence write, then the settlement
    expect(psql(`select facts->>'evidence_status' || ':' || (facts->>'charged_cents') from public.studio_sms_usage_attempt_events where attempt_id = '${s.attempt_id}' and to_state = 'settled'`)).toBe(`delivered:${price()}`);
    expect(psql(`select count(*) from public.studio_sms_usage_attempt_events where attempt_id = '${s.attempt_id}' and facts::text ~ '[+]1[0-9]{10}'`)).toBe("0");
    expect(psqlError(`delete from public.studio_sms_usage_attempt_events where attempt_id = '${s.attempt_id}'`)).toContain("append-only");
  });

  it("S04 a delayed callback arriving DURING reconciliation: callback and settlement race on the row lock; one charge, nothing lost", async () => {
    await ready(EA, SA);
    for (let i = 0; i < 5; i += 1) {
      const s = await submitted(SA);
      const [cb, st] = await Promise.all([
        rpc("tw4_usage_record_callback", { p_attempt_id: s.attempt_id, p_provider_sid: s.sid, p_signer_account: ACC_A, p_status: "delivered", p_error_code: null }),
        settle(s.attempt_id, ev(s)),
      ]);
      expect(cb.error).toBeNull();
      expect(st.data).toMatchObject({ outcome: "settled" });
      expect(usageCharges(s.attempt_id)).toBe(1);
    }
    // an uncertain send has no SID to read; the late callback binds it and the next read settles it
    const u = await marked(SA);
    await rpc("tw4_usage_uncertain", { p_attempt_id: u.attempt_id, p_error_code: "timeout" });
    const late = sid();
    const due = (await rpc("tw4_usage_due", { p_limit: 500 })).data as Array<{ attempt_id: string }>;
    expect(due.some((d) => d.attempt_id === u.attempt_id)).toBe(false);
    await rpc("tw4_usage_record_callback", { p_attempt_id: u.attempt_id, p_provider_sid: late, p_signer_account: ACC_A, p_status: "sent", p_error_code: null });
    expect((await settle(u.attempt_id, ev({ ...u, sid: late }))).data).toMatchObject({ outcome: "settled" });
    expect(gaps()).toBe("0");
  });

  it("S06 concurrent reconciliation workers (lease bypassed on purpose): every text is charged exactly once", async () => {
    await ready(EA, SA);
    const texts = [];
    for (let i = 0; i < 6; i += 1) texts.push(await submitted(SA));
    const fake = new FakeBilledSmsProvider();
    for (const t of texts) fake.setEvidence(t.sid, ev(t));
    const before = balance(EA);
    const [a, b, c] = await Promise.all([reconcileSmsUsage(admin, fake, {}), reconcileSmsUsage(admin, fake, {}), reconcileSmsUsage(admin, fake, {})]);
    for (const t of texts) {
      expect(state(t.attempt_id)).toBe("settled");
      expect(usageCharges(t.attempt_id)).toBe(1);
    }
    expect(a.chargedCents + b.chargedCents + c.chargedCents).toBe(6 * price()); // replays are not counted twice
    expect(balance(EA)).toBe(before - 6 * price());
    expect(gaps()).toBe("0");
  });

  it("S08 subaccount token rotation: rejected / unavailable credentials are a TRANSIENT evidence failure (retained, retried), then settle once the token works", async () => {
    await ready(EA, SA);
    const s = await submitted(SA);
    let rotated = false;
    const working = new FakeBilledSmsProvider().setEvidence(s.sid, ev(s));
    const provider = {
      fetchMessage: async (account: string, messageSid: string) => {
        if (!rotated) throw new Error("usage_evidence_credentials_rejected");
        return working.fetchMessage(account, messageSid);
      },
    };
    expect(await reconcileSmsUsage(admin, provider, {})).toMatchObject({ retrying: 1 });
    expect(att(s.attempt_id)).toMatchObject({ state: "submitted", evidence_error_code: "usage_evidence_credentials_rejected", evidence_failures: 1 });
    expect(reserved(EA)).toBe(s.amount_cents);
    rotated = true;
    aged(`update public.studio_sms_usage_attempts set evidence_next_at = now() - interval '1 second', last_reconciled_at = now() - interval '11 minutes' where id = '${s.attempt_id}'`);
    await reconcileSmsUsage(admin, provider, {});
    expect(att(s.attempt_id)).toMatchObject({ state: "settled", evidence_failures: 0, evidence_error_code: null });
  });

  it("S13 duplicate inbound recovery attempts (concurrent and repeated) record and charge a text once", async () => {
    await ready(EA, SA);
    const before = balance(EA);
    const m = inboundMsg({ num_segments: "3" });
    const results = await withRun((runId) => Promise.all([recover(runId, m), recover(runId, m), recover(runId, m), recover(runId, m)]));
    expect(results.filter((r) => (r.data as { outcome: string }).outcome === "recovered")).toHaveLength(1);
    expect(results.filter((r) => (r.data as { outcome: string }).outcome === "already_recorded")).toHaveLength(3);
    expect(psql(`select count(*) from public.studio_sms_credit_ledger where idempotency_key = 'usage:in:${m.sid}'`)).toBe("1");
    expect(psql(`select count(*) from public.studio_sms_inbound_recoveries where provider_sid = '${m.sid}'`)).toBe("1");
    expect(balance(EA)).toBe(before - 6);
    expect(gaps()).toBe("0");
  });

  it("S14 holds and suspension: a text that went out is still settled from evidence; new sends stay refused; a suspended subaccount's inbound is still recovered", async () => {
    await ready(EA, SA);
    const s = await submitted(SA);
    expect((await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: true, p_reason: "fixture: hold during reconciliation", p_actor: U.padmin })).error).toBeNull();
    aged(`update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = '${EA}'`);
    try {
      const due = (await rpc("tw4_usage_due", { p_limit: 500 })).data as Array<{ attempt_id: string }>;
      expect(due.some((d) => d.attempt_id === s.attempt_id)).toBe(true); // evidence is read through the attempt's own account, whatever its status
      expect((await settle(s.attempt_id, ev(s))).data).toMatchObject({ outcome: "settled", charged_cents: price() });
      const refused = await rpc("tw4_usage_begin", {
        p_source_kind: "manual", p_source_id: randomUUID(), p_studio_id: SA, p_client_id: null, p_phone_e164: PHONE, p_body: "hello there",
        p_message_type: "manual", p_related_table: null, p_related_id: null, p_sent_by: null,
      });
      expect(["TW007", "TW015"]).toContain(refused.error?.code);
      const targets = (await rpc("tw4_inbound_scan_targets", { p_limit: 200 })).data as Array<{ account_sid: string }>;
      expect(targets.some((t) => t.account_sid === ACC_A)).toBe(true);
      expect((await withRun((runId) => recover(runId, inboundMsg()))).data).toMatchObject({ outcome: "recovered" }); // a received text is never refused
      // a CLOSED subaccount is not scanned, and recovery for it is refused
      aged(`update public.studio_sms_twilio_accounts set status = 'closed' where legal_entity_id = '${EA}'`);
      expect(((await rpc("tw4_inbound_scan_targets", { p_limit: 200 })).data as Array<{ account_sid: string }>).some((t) => t.account_sid === ACC_A)).toBe(false);
      expect((await withRun((runId) => recover(runId, inboundMsg()))).error?.code).toBe("42501");
    } finally {
      aged(`update public.studio_sms_twilio_accounts set status = 'active' where legal_entity_id = '${EA}'`);
      await rpc("tw4_credit_set_hold", { p_entity_id: EA, p_hold: false, p_reason: "fixture: release the hold", p_actor: U.padmin });
    }
    expect(gaps()).toBe("0");
  });

  it("S15 monthly limit and recurring-fee protection: a recurring set-aside means NO inbound debt; recovered inbound counts in the month it was received", async () => {
    await ready(EA, SA, 2_500);
    const free = balance(EA) - reserved(EA);
    // a first month set aside for a recurring fee (fixture: the reservation and the account's reserved total, as tw4_recurring_authorize leaves them)
    aged(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
           values ('${EA}', '${SA}', 'monthly', ${free - 10}, 'credit', 'commit:fixture-${RUN}');
          update public.studio_sms_credit_accounts set reserved_cents = reserved_cents + ${free - 10} where legal_entity_id = '${EA}'`);
    try {
      const out = await withRun(async (runId) => [
        (await recover(runId, inboundMsg({ num_segments: "4" }))).data as { charged_cents: number; uncollected_cents: number },
        (await recover(runId, inboundMsg({ num_segments: "4" }))).data as { charged_cents: number; uncollected_cents: number },
      ]);
      expect(out.map((o) => o.charged_cents)).toEqual([8, 2]); // only the 10c free of the set-aside; never below it
      expect(out.map((o) => o.uncollected_cents)).toEqual([0, 6]);
      expect(balance(EA) - reserved(EA)).toBe(0);
    } finally {
      aged(`delete from public.studio_sms_credit_reservations where reservation_key = 'commit:fixture-${RUN}';
            update public.studio_sms_credit_accounts set reserved_cents = 0 where legal_entity_id = '${EA}'`);
    }
    // month attribution: a text received last month counts in last month, by its own time
    resetMoney(EA);
    await fund(EA, SA, 2_500);
    const lastMonth = psql(`select to_char((date_trunc('month', now() at time zone 'UTC') - interval '1 hour'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
    expect((await withRun((runId) => recover(runId, inboundMsg({ date_created: lastMonth, num_segments: "5" })))).data).toMatchObject({ outcome: "recovered" });
    const prevKey = psql(`select public._tw4ml_key_add(public._tw4ml_month_key('${EA}', now()), -1)`);
    expect(Number(psql(`select public._tw4ml_month_parts('${EA}', '${prevKey}')->>'inbound_cents'`))).toBe(10);
    expect(Number(psql(`select public._tw4ml_month_parts('${EA}', public._tw4ml_month_key('${EA}', now()))->>'inbound_cents'`))).toBe(0);
  });

  it("S19 recovery after worker interruption: a run that died mid-way is closed as failed, its writes are fenced, the next run finishes the work without double-charging", async () => {
    await ready(EA, SA);
    closeRuns();
    const texts = [await submitted(SA), await submitted(SA), await submitted(SA)];
    const fake = new FakeBilledSmsProvider();
    for (const t of texts) fake.setEvidence(t.sid, ev(t));
    // worker A takes the lease, settles one text, then dies (no finish)
    const a = await runBegin(`tw4recon:${RUN}:dies`, 60);
    expect((await settle(texts[0].attempt_id, ev(texts[0]))).data).toMatchObject({ outcome: "settled" });
    aged(`update public.studio_sms_reconcile_runs set lease_expires_at = clock_timestamp() - interval '1 second' where id = '${a.run_id}'`);
    const lister = ownLister(new FakeBilledSmsProvider());
    const outcome = await runScheduledUsageReconciliation(admin, Object.assign(fake, { listInbound: lister.listInbound }), { runner: `tw4recon:${RUN}:next` });
    expect(outcome.ran).toBe(true);
    expect(psql(`select status from public.studio_sms_reconcile_runs where id = '${a.run_id}'`)).toBe("failed");
    expect((await rpc("tw4_usage_escalate", { p_run_id: a.run_id, p_limit: 1 })).error?.code).toBe("TW023");
    for (const t of texts) {
      expect(state(t.attempt_id)).toBe("settled");
      expect(usageCharges(t.attempt_id)).toBe(1);
    }
    expect(gaps()).toBe("0");
  });

  it("S20d ambiguous evidence never moves money: an unknown status, missing segments or an empty status go to review; no evidence at all is refused", async () => {
    await ready(EA, SA);
    const a = await submitted(SA);
    expect((await settle(a.attempt_id, ev(a, { status: "partially_delivered" }))).data).toMatchObject({ outcome: "review", reason: "unrecognized provider status" });
    const b = await submitted(SA);
    expect((await settle(b.attempt_id, ev(b, { num_segments: null }))).data).toMatchObject({ outcome: "review", reason: "segment count outside the expected range" });
    const c = await submitted(SA);
    expect((await settle(c.attempt_id, ev(c, { status: "" }))).data).toMatchObject({ outcome: "review" });
    const d = await submitted(SA);
    expect((await settle(d.attempt_id, null as unknown as Record<string, unknown>)).error?.code).toBe("22023");
    for (const t of [a, b, c, d]) expect(usageCharges(t.attempt_id)).toBe(0);
    expect(reserved(EA)).toBe(a.amount_cents + b.amount_cents + c.amount_cents + d.amount_cents);
  });

  describe("fixes from the independent review", () => {
    it("R1 a text that went out after an admin released it can still go to review (failures and escalation), so retries stay bounded", async () => {
      await ready(EA, SA);
      const u = await marked(SA);
      aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '1 hour', submitting_at = now() - interval '1 hour' where id = '${u.attempt_id}'`);
      expect((await rpc("tw4_usage_resolve", { p_attempt_id: u.attempt_id, p_actor: U.padmin, p_outcome: "released", p_segments: null, p_reason: "fixture: believed not sent at the time" })).error).toBeNull();
      const late = sid();
      expect((await rpc("tw4_usage_submitted", { p_attempt_id: u.attempt_id, p_provider_sid: late })).error).toBeNull();
      expect(att(u.attempt_id)).toMatchObject({ state: "submitted", resolved_outcome: "released" });
      aged(`update public.studio_sms_usage_attempts set submitted_at = now() - interval '1 hour' where id = '${u.attempt_id}'`);
      const r = await rpc("tw4_usage_evidence_failed", { p_attempt_id: u.attempt_id, p_code: "usage_evidence_http_404", p_definite: true });
      expect(r.error, JSON.stringify(r.error)).toBeNull();
      expect(att(u.attempt_id)).toMatchObject({ state: "review", closed_at: null });
      // the same through escalation (the attempt's account no longer the business's)
      const v = await marked(SA);
      aged(`update public.studio_sms_usage_attempts set created_at = now() - interval '1 hour', submitting_at = now() - interval '1 hour' where id = '${v.attempt_id}'`);
      await rpc("tw4_usage_resolve", { p_attempt_id: v.attempt_id, p_actor: U.padmin, p_outcome: "released", p_segments: null, p_reason: "fixture: believed not sent at the time" });
      await rpc("tw4_usage_submitted", { p_attempt_id: v.attempt_id, p_provider_sid: sid() });
      aged(`update public.studio_sms_usage_attempts set account_sid = '${ACC_B}' where id = '${v.attempt_id}'`);
      const esc = await withRun((runId) => rpc("tw4_usage_escalate", { p_run_id: runId, p_limit: 500 }));
      expect(esc.error, JSON.stringify(esc.error)).toBeNull();
      expect(state(v.attempt_id)).toBe("review");
      resetMoney(EA);
    });

    it("R2 a 404 within 15 minutes of the send is transient (the message may not be readable yet); an older one is definite", async () => {
      await ready(EA, SA);
      const s = await submitted(SA);
      expect((await rpc("tw4_usage_evidence_failed", { p_attempt_id: s.attempt_id, p_code: "usage_evidence_http_404", p_definite: true })).data).toMatchObject({ outcome: "retry" });
      aged(`update public.studio_sms_usage_attempts set submitted_at = now() - interval '20 minutes' where id = '${s.attempt_id}'`);
      expect((await rpc("tw4_usage_evidence_failed", { p_attempt_id: s.attempt_id, p_code: "usage_evidence_http_404", p_definite: true })).data).toMatchObject({ outcome: "review" });
    });

    it("R3 a text already recorded is a replay even if its number now routes elsewhere; unroutable and refused texts are kept as unresolved evidence and never block the checkpoint", async () => {
      await ready(EA, SA);
      const moved = inboundMsg();
      expect((await rpc("tw4_inbound_record", { p_studio_id: SA, p_signer_account: ACC_A, p_provider_sid: moved.sid, p_segments: 1, p_media: 0, p_classification: "ordinary", p_reply_body: null, p_received_at: null, p_source: "webhook" })).error).toBeNull();
      expect((await withRun((runId) => recover(runId, { ...moved, to: "+15125550399" }))).data).toMatchObject({ outcome: "already_recorded" });
      const stray = inboundMsg({ to: "+15125550398" });
      expect((await withRun((runId) => recover(runId, stray))).data).toMatchObject({ outcome: "unrouted" });
      expect(psql(`select reason from public.studio_sms_inbound_unresolved where provider_sid = '${stray.sid}'`)).toBe("unrouted");
      // the library pass: a refused text is noted and the checkpoint still moves
      aged(`delete from public.studio_sms_inbound_scan_cursors where account_sid in ('${ACC_A}', '${ACC_B}')`);
      const old = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
      const refusedMsg = inboundMsg({ account_sid: ACC_B, date_created: old });
      const fine = inboundMsg({ date_created: old });
      const fake = new FakeBilledSmsProvider().setInbound(ACC_A, [refusedMsg, fine]).setInbound(ACC_B, []);
      const summary = await withRun((runId) => recoverInboundUsage(admin, ownLister(fake), { runId }));
      expect(summary).toMatchObject({ refused: 1, recovered: 1 });
      expect(psql(`select reason || ':' || code from public.studio_sms_inbound_unresolved where provider_sid = '${refusedMsg.sid}'`)).toBe("refused:42501");
      expect(psql(`select count(*) from public.studio_sms_inbound_scan_cursors where account_sid = '${ACC_A}'`)).toBe("1");
      const o = (await rpc("tw4_usage_reconcile_overview", { p_actor: U.padmin, p_limit: 200 })).data as { inbound: { unresolved_7d: Record<string, number> } };
      expect(o.inbound.unresolved_7d.refused).toBeGreaterThanOrEqual(1);
      expect(o.inbound.unresolved_7d.unrouted).toBeGreaterThanOrEqual(1);
      expect(psqlError(`delete from public.studio_sms_inbound_unresolved where provider_sid = '${stray.sid}'`)).toContain("append-only");
      expect((await rpc("tw4_inbound_unrecorded", { p_account_sid: ACC_A, p_sids: [fine.sid, sid(), "junk"] })).data).toHaveLength(1);
    });

    it("R5 consent fails CLOSED: a recovered opt-out applies the canonical STOP (every send path then refuses the number); a recovered START never restores consent", async () => {
      await ready(EA, SA);
      const texter = "+15125550177";
      aged(`delete from public.sms_consent_history where studio_id = '${SA}'; delete from public.sms_contact_permissions where studio_id = '${SA}'`);
      const consent = () => psql(`select coalesce(string_agg(consent_status || ':' || coalesce(opted_out_source, '-'), ',' order by consent_status), 'none') from public.sms_contact_permissions where studio_id = '${SA}' and phone_e164 = '${texter}'`);
      expect(consent()).toBe("none");
      const stop = inboundMsg({ body: "Stop!!" });
      const r = await withRun((runId) => rpc("tw4_inbound_recover", { p_run_id: runId, p_account_sid: ACC_A, p_evidence: { ...stop, body: undefined, classification: "compliance", keyword: true, keyword_kind: "stop", from: texter } }));
      expect(r.data).toMatchObject({ outcome: "recovered", basis: "keyword", keyword_kind: "stop", consent_applied: true, classification: "compliance" });
      expect(consent()).toBe("opted_out:twilio_inbound_stop"); // the studio+phone block both send paths honour (resolveEffectiveSmsConsent: blocked_by_text_stop)
      expect(psql(`select count(*) from public.sms_consent_history where studio_id = '${SA}' and phone_e164 = '${texter}'`)).not.toBe("0");
      // a recovered START is recorded (never charged) but NEVER applied: consent stays blocked until the person texts START again
      const start = inboundMsg({ body: "START" });
      const s2 = await withRun((runId) => rpc("tw4_inbound_recover", { p_run_id: runId, p_account_sid: ACC_A, p_evidence: { ...start, body: undefined, classification: "compliance", keyword: true, keyword_kind: "start", from: texter } }));
      expect(s2.data).toMatchObject({ outcome: "recovered", keyword_kind: "start", consent_applied: null });
      expect(consent()).toBe("opted_out:twilio_inbound_stop");
      // an opt-out whose sender number is unusable cannot be applied: it is listed for a person (Twilio Advanced Opt-Out still blocks at the carrier)
      const blind = inboundMsg({ body: "STOP", from: null });
      const s3 = await withRun((runId) => rpc("tw4_inbound_recover", { p_run_id: runId, p_account_sid: ACC_A, p_evidence: { ...blind, body: undefined, classification: "compliance", keyword: true, keyword_kind: "stop" } }));
      expect(s3.data).toMatchObject({ consent_applied: false });
      const o = (await rpc("tw4_usage_reconcile_overview", { p_actor: U.padmin, p_limit: 200 })).data as { inbound: { keywords_unseen: Array<{ provider_sid: string; consent_applied: boolean | null }> } };
      expect(o.inbound.keywords_unseen.find((k) => k.provider_sid === blind.sid)?.consent_applied).toBe(false);
      expect(JSON.stringify(o)).not.toContain(texter);
      expect(psql(`select count(*) from public.studio_sms_inbound_recoveries where studio_id = '${SA}' and row_to_json(studio_sms_inbound_recoveries)::text like '%${texter}%'`)).toBe("0");
      // end to end through the library: the provider's record ("STOP 🛑" from the texter) blocks the number
      aged(`delete from public.sms_consent_history where studio_id = '${SA}'; delete from public.sms_contact_permissions where studio_id = '${SA}'; delete from public.studio_sms_inbound_scan_cursors where account_sid in ('${ACC_A}', '${ACC_B}')`);
      const old = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
      const fake = new FakeBilledSmsProvider().setInbound(ACC_A, [inboundMsg({ body: "STOP 🛑", from: texter, date_created: old })]).setInbound(ACC_B, []);
      const summary = await withRun((runId) => recoverInboundUsage(admin, ownLister(fake), { runId }));
      expect(summary).toMatchObject({ recovered: 1, optOutsApplied: 1 });
      expect(consent()).toBe("opted_out:twilio_inbound_stop");
      expect(psql(`select count(*) from public.studio_sms_inbound_usage where studio_id = '${SA}' and classification = 'compliance' and charged_cents > 0`)).toBe("0");
    });

    it("R6 a recovered STOP followed by a later START from the same texter (by Twilio's own times) is not applied, even when that START changed nothing in DanceFlow", async () => {
      await ready(EA, SA);
      const texter = "+15125550178";
      aged(`delete from public.sms_consent_history where studio_id = '${SA}'; delete from public.sms_contact_permissions where studio_id = '${SA}'; delete from public.studio_sms_inbound_scan_cursors where account_sid in ('${ACC_A}', '${ACC_B}')`);
      const stops = () => Number(psql(`select count(*) from public.sms_consent_history where studio_id = '${SA}' and phone_e164 = '${texter}' and event_type in ('inbound_stop', 'unknown_phone_stop')`));
      // the webhook missed the STOP, so DanceFlow never blocked the number; the person's later START was processed by the webhook and changed NOTHING
      // (no history row: nothing was opted out). Only Twilio's record shows the order.
      const stopAt = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
      const startAt = new Date(Date.now() - 35 * 60 * 60 * 1000).toISOString();
      const stop = inboundMsg({ body: "STOP", from: texter, date_created: stopAt });
      const start = inboundMsg({ body: "START", from: texter, date_created: startAt });
      expect((await rpc("tw4_inbound_record", { p_studio_id: SA, p_signer_account: ACC_A, p_provider_sid: start.sid, p_segments: 1, p_media: 0, p_classification: "compliance", p_reply_body: null, p_received_at: null, p_source: "webhook" })).error).toBeNull();
      const fake = new FakeBilledSmsProvider().setInbound(ACC_A, [stop, start]).setInbound(ACC_B, []);
      const summary = await withRun((runId) => recoverInboundUsage(admin, ownLister(fake), { runId }));
      expect(summary).toMatchObject({ recovered: 1, optOutsApplied: 0 });
      expect(psql(`select consent_note || ':' || consent_applied from public.studio_sms_inbound_recoveries where provider_sid = '${stop.sid}'`)).toBe("not_applied_newer_start:false");
      expect(stops()).toBe(0);
      // a text with an opt-out word inside a longer text: compliance (never charged), no consent change, listed for a person
      const vague = inboundMsg({ body: "please stop texting me" });
      const v = await withRun((runId) => rpc("tw4_inbound_recover", { p_run_id: runId, p_account_sid: ACC_A, p_evidence: { ...vague, body: undefined, classification: "uncertain", keyword: false, possible_opt_out: true } }));
      expect(v.data).toMatchObject({ outcome: "recovered", classification: "compliance", basis: "uncertain" });
      const o = (await rpc("tw4_usage_reconcile_overview", { p_actor: U.padmin, p_limit: 200 })).data as { inbound: { possible_opt_outs: Array<{ provider_sid: string }> } };
      expect(o.inbound.possible_opt_outs.some((x) => x.provider_sid === vague.sid)).toBe(true);
    });

    it("R7 consent order: staff / public opt-ins never override a texted STOP; a later STOP or none applies; anything unproven applies (fail closed) and is listed", async () => {
      await ready(EA, SA);
      const texter = "+15125550179";
      const stops = () => Number(psql(`select count(*) from public.sms_consent_history where studio_id = '${SA}' and phone_e164 = '${texter}' and event_type in ('inbound_stop', 'unknown_phone_stop')`));
      const reset = () => aged(`delete from public.sms_consent_history where studio_id = '${SA}'; delete from public.sms_contact_permissions where studio_id = '${SA}'`);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const recoverStop = async (later: string | undefined, dateCreated: string | null = twoHoursAgo) =>
        ((await withRun((runId) => rpc("tw4_inbound_recover", {
          p_run_id: runId, p_account_sid: ACC_A,
          p_evidence: { ...inboundMsg({ body: "STOP", date_created: dateCreated }), body: undefined, classification: "compliance", keyword: true, keyword_kind: "stop", from: texter,
                        ...(later ? { later_keyword: later } : {}) },
        }))).data ?? {}) as { consent_applied?: boolean; consent_note?: string };

      // a staff or public opt-in recorded after the STOP's time does NOT keep the number sendable (TW-2: only the contact can resubscribe)
      for (const eventType of ["public_opt_in", "staff_opt_in", "staff_consent_update"]) {
        reset();
        aged(`insert into public.sms_consent_history (studio_id, phone_e164, previous_consent_status, new_consent_status, event_type, changed_at)
              values ('${SA}', '${texter}', 'unknown', 'opted_in', '${eventType}', now() - interval '30 minutes')`);
        expect(await recoverStop("none"), eventType).toMatchObject({ consent_applied: true, consent_note: "applied" });
        expect(stops(), eventType).toBe(1);
      }
      reset();
      expect(await recoverStop("stop")).toMatchObject({ consent_applied: true, consent_note: "applied" });   // a later STOP: the opt-out stands
      reset();
      expect(await recoverStop("start")).toMatchObject({ consent_applied: false, consent_note: "not_applied_newer_start" });
      expect(stops()).toBe(0);
      // unproven order: the lookup failed or tied, no lookup at all, or the STOP's own time is missing / implausible / not ISO -> applied (fail closed), listed
      for (const [later, when] of [["unknown", twoHoursAgo], [undefined, twoHoursAgo], ["start", null], ["none", new Date(Date.now() + 60 * 60 * 1000).toISOString()], ["none", "Tue, 20 Oct 2026 12:00:00 +0000"]] as const) {
        reset();
        expect(await recoverStop(later, when), `${later} ${when}`).toMatchObject({ consent_applied: true, consent_note: "applied_order_unverified" });
        expect(stops()).toBe(1);
      }
      // the stored decision cannot contradict itself
      expect(psqlError(`insert into public.studio_sms_inbound_recoveries (provider_sid, account_sid, legal_entity_id, studio_id, run_id, classification, basis, webhook_seen, consent_applied, consent_note, charged_cents)
                        select 'SM${randomBytes(16).toString("hex")}', '${ACC_A}', '${EA}', '${SA}', id, 'compliance', 'keyword', false, true, 'not_applied_newer_start', 0 from public.studio_sms_reconcile_runs limit 1`)).toContain("studio_sms_inbound_recoveries_consent");
      const o = (await rpc("tw4_usage_reconcile_overview", { p_actor: U.padmin, p_limit: 200 })).data as { inbound: { keywords_unseen: Array<{ consent_note: string | null }> } };
      expect(o.inbound.keywords_unseen.some((k) => k.consent_note === "applied_order_unverified")).toBe(true);
      expect(JSON.stringify(o)).not.toContain(texter);
    });

    it("R8 DanceFlow's own record of a contact-originated START also suppresses an older recovered STOP (custom opt-in keywords the provider lookup cannot read)", async () => {
      await ready(EA, SA);
      const texter = "+15125550180";
      const reset = () => aged(`delete from public.sms_consent_history where studio_id = '${SA}'; delete from public.sms_contact_permissions where studio_id = '${SA}'; delete from public.sms_message_logs where studio_id = '${SA}' and direction = 'inbound'`);
      const stops = () => Number(psql(`select count(*) from public.sms_consent_history where studio_id = '${SA}' and phone_e164 = '${texter}' and event_type in ('inbound_stop', 'unknown_phone_stop')`));
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const recoverStop = async () =>
        ((await withRun((runId) => rpc("tw4_inbound_recover", {
          p_run_id: runId, p_account_sid: ACC_A,
          p_evidence: { ...inboundMsg({ body: "STOP", date_created: twoHoursAgo }), body: undefined, classification: "compliance", keyword: true, keyword_kind: "stop", from: texter, later_keyword: "none" },
        }))).data ?? {}) as { consent_applied?: boolean; consent_note?: string };
      // the webhook handled a custom Advanced Opt-Out opt-in (OptOutType START) an hour later: it logged an inbound 'start' message for the contact
      reset();
      aged(`insert into public.sms_message_logs (studio_id, phone_e164, direction, message_type, body, segment_count, status, provider, sent_at)
            values ('${SA}', '${texter}', 'inbound', 'start', 'REJOINDRE', 1, 'received', 'twilio', now() - interval '1 hour')`);
      expect(await recoverStop()).toMatchObject({ consent_applied: false, consent_note: "not_applied_newer_start" });
      expect(stops()).toBe(0);
      // an inbound START in the consent history after the STOP: same
      reset();
      aged(`insert into public.sms_consent_history (studio_id, phone_e164, previous_consent_status, new_consent_status, event_type, changed_at)
            values ('${SA}', '${texter}', 'opted_out', 'opted_in', 'inbound_start', now() - interval '1 hour')`);
      expect(await recoverStop()).toMatchObject({ consent_note: "not_applied_newer_start" });
      // within 2 minutes of the STOP's own time: not provable -> applied, listed
      reset();
      aged(`insert into public.sms_message_logs (studio_id, phone_e164, direction, message_type, body, segment_count, status, provider, sent_at)
            values ('${SA}', '${texter}', 'inbound', 'start', 'START', 1, 'received', 'twilio', '${twoHoursAgo}'::timestamptz + interval '60 seconds')`);
      expect(await recoverStop()).toMatchObject({ consent_applied: true, consent_note: "applied_order_unverified" });
      // a START logged BEFORE the STOP does not suppress it
      reset();
      aged(`insert into public.sms_message_logs (studio_id, phone_e164, direction, message_type, body, segment_count, status, provider, sent_at)
            values ('${SA}', '${texter}', 'inbound', 'start', 'START', 1, 'received', 'twilio', now() - interval '5 hours')`);
      expect(await recoverStop()).toMatchObject({ consent_applied: true, consent_note: "applied" });
      // another studio's START never counts
      reset();
      aged(`insert into public.sms_consent_history (studio_id, phone_e164, previous_consent_status, new_consent_status, event_type, changed_at)
            values ('${SB}', '${texter}', 'opted_out', 'opted_in', 'inbound_start', now() - interval '1 hour')`);
      expect(await recoverStop()).toMatchObject({ consent_note: "applied" });
      aged(`delete from public.sms_consent_history where studio_id = '${SB}'`);
    });

    it("R4 a repeated read that learns nothing new adds no history row", async () => {
      await ready(EA, SA);
      const s = await submitted(SA);
      for (let i = 0; i < 3; i += 1) expect((await settle(s.attempt_id, ev(s, { status: "sent" }))).data).toMatchObject({ outcome: "pending" });
      expect(psql(`select count(*) from public.studio_sms_usage_attempt_events where attempt_id = '${s.attempt_id}' and from_state = 'submitted' and to_state = 'submitted'`)).toBe("1");
    });
  });
});
