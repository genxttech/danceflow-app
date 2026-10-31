/**
 * TW-4F F3 usage-reconciler readiness gate against a REAL schema (migrations through 20261218090000): public._tw4usage_reconciler_ready(), the switch-on refusal,
 * the tw4_usage_begin refusal (TW024), replay, privileges and the apply -> rollback -> re-apply fingerprint round trip. Nothing reaches Twilio. LOCAL QA STACK ONLY
 * (skipped unless the variables point at a loopback Supabase stack). Needs a DEDICATED database (readiness reads every usage_reconcile run, and the suite rolls the
 * migration back and re-applies it): run it on an isolated stack, serially (--no-file-parallelism).
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:<kong>  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=<dedicated db container>
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

import { SupabaseCreditStore } from "@/lib/sms/twilioIsv/creditStore";
import { LOCAL_QA_MARKER, newSenderIds, readySender } from "./senderFixtures";

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

const SA = "a7e00000-0000-4000-8000-00000000000a";
const EA = "e7e00000-0000-4000-8000-0000000000e1";
const U = { padmin: "a7e00000-0000-4000-8000-000000000401" };
const ACC_A = `AC${"a7".repeat(16)}`;
const NUM_A = "+15125550371";
const PHONE = "+15125550143";
const RUNNER = "tw4f3recon:fixture";
const RUN = randomBytes(3).toString("hex");
const MIGRATION = join(process.cwd(), "src/lib/supabase/migrations/20261218090000_twilio_usage_reconciler_readiness.sql");
const ROLLBACK = join(process.cwd(), "src/lib/supabase/migrations/rollback/20261218090000_twilio_usage_reconciler_readiness_rollback.sql");
const BEGIN_SIG = "public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)";
const SWITCH_SIG = "public.tw4_usage_set_switch(boolean,uuid,text)";

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
const fp = (sig: string) => psql(`select left(md5(replace(p.prosrc, chr(13), '')), 8) from pg_proc p where p.oid = to_regprocedure('${sig}')`);

const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_reconcile_runs where runner like 'tw4f3recon:%';
delete from public.studio_sms_usage_attempt_events where legal_entity_id = '${EA}';
delete from public.studio_sms_usage_attempts where legal_entity_id = '${EA}';
delete from public.studio_sms_sender_verifications where legal_entity_id = '${EA}';
delete from public.studio_sms_provisioning_steps where studio_id = '${SA}';
delete from public.studio_sms_approval_refs where legal_entity_id = '${EA}';
delete from public.studio_sms_billed_senders where legal_entity_id = '${EA}';
delete from public.studio_sms_usage_switch_log where changed_by = '${U.padmin}';
delete from public.sms_message_logs where studio_id = '${SA}';
delete from public.studio_sms_monthly_limits where legal_entity_id = '${EA}';
delete from public.studio_sms_entity_timezones where legal_entity_id = '${EA}';
delete from public.studio_sms_credit_ledger where legal_entity_id = '${EA}';
delete from public.studio_sms_credit_reservations where legal_entity_id = '${EA}';
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id = '${EA}');
delete from public.studio_sms_credit_topups where legal_entity_id = '${EA}';
delete from public.studio_sms_credit_accounts where legal_entity_id = '${EA}';
delete from public.studio_sms_twilio_accounts where legal_entity_id = '${EA}';
delete from public.studio_sms_entity_studios where legal_entity_id = '${EA}';
delete from public.studio_sms_legal_entities where id = '${EA}';
delete from public.studio_sms_onboarding_audit where studio_id = '${SA}';
delete from public.studios where id = '${SA}';
delete from public.profiles where id = '${U.padmin}';
delete from auth.users where email like '%@tw4f3recon-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${U.padmin}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin@tw4f3recon-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${U.padmin}', 'platform_admin') on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values ('${SA}', 'TW4F3RECON A', 'tw4f3recon-a', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${EA}', 'F3R Alpha LLC', '7551', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at)
  values ('${SA}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A', now() - interval '2 days');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by, created_at)
  values ('${EA}', '${ACC_A}', 'df:test:${EA}', 'test', 'active', '${U.padmin}', now() - interval '3 days');
commit;`;

type Ready = { ok: boolean; detail: string; last_success_at: string | null };

describe.skipIf(!enabled)("TW-4F F3 usage-reconciler readiness gate (real schema)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let snapshotActivePrices: string[] = [];
  let n = 0;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const readiness = () => JSON.parse(psql("select public._tw4usage_reconciler_ready()::text")) as Ready;
  const switchOn = () => psql("select public._tw4us_switch_on()") === "t";
  const setSwitch = (on: boolean) => rpc("tw4_usage_set_switch", { p_enabled: on, p_actor: U.padmin, p_reason: `f3 fixture: switch ${on ? "on" : "off"}` });
  /** forces the switch row directly (the readiness check is what is under test, not the switch history) */
  const forceSwitch = (on: boolean) =>
    aged(`insert into public.studio_sms_usage_switch_log (enabled, changed_by, reason, changed_at) values (${on}, '${U.padmin}', 'f3 fixture: forced switch row', clock_timestamp())`);
  const clearRuns = () => aged("delete from public.studio_sms_reconcile_runs where runner like 'tw4f3recon:%'");
  /** a run row with explicit times (minutes relative to now; negative = past) */
  const addRun = (o: { status: "completed" | "failed" | "running"; startedMin: number; finishedMin?: number; leaseMin: number; evidenceRead?: boolean | null; counts?: Record<string, number> }) =>
    aged(`insert into public.studio_sms_reconcile_runs (job, runner, status, started_at, lease_expires_at, finished_at, summary) values (
            'usage_reconcile', '${RUNNER}', '${o.status}', clock_timestamp() + interval '${o.startedMin} minutes', clock_timestamp() + interval '${o.leaseMin} minutes',
            ${o.status === "running" ? "null" : `clock_timestamp() + interval '${o.finishedMin ?? 0} minutes'`},
            ${o.evidenceRead === null ? "null" : `'${JSON.stringify({ evidence_read: o.evidenceRead ?? true, released_unsent: 0, ...(o.counts ?? { due: 0 }) })}'::jsonb`})`);
  const freshRun = () => addRun({ status: "completed", startedMin: -2, finishedMin: -1, leaseMin: 1 });
  const begin = (sourceId: string = randomUUID()) =>
    rpc("tw4_usage_begin", {
      p_source_kind: "manual", p_source_id: sourceId, p_studio_id: SA, p_client_id: null, p_phone_e164: PHONE, p_body: "Your lesson is tomorrow at 6pm. Reply STOP to opt out.",
      p_message_type: "manual", p_related_table: null, p_related_id: null, p_sent_by: null,
    });
  const counts = () => psql(`select (select count(*) from public.studio_sms_usage_attempts where legal_entity_id = '${EA}') || '|' ||
                                    (select count(*) from public.sms_message_logs where studio_id = '${SA}') || '|' ||
                                    (select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EA}') || '|' ||
                                    (select coalesce(sum(reserved_cents), 0) from public.studio_sms_credit_accounts where legal_entity_id = '${EA}')`);

  beforeAll(async () => {
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
    psqlFile(LOCAL_QA_MARKER);
    // readiness reads EVERY usage_reconcile run: anything not ours means this is not a dedicated database
    expect(psql("select count(*) from public.studio_sms_reconcile_runs where job = 'usage_reconcile' and runner not like 'tw4f3recon:%'"), "needs a dedicated database").toBe("0");
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    seedPrice(psql, { kind: "sms_usage", customer: 3, provider: 1, description: "fixture sms_usage price", approver: U.padmin });
    await readySender(rpc, (sql) => aged(sql), { studio: SA, account: ACC_A, actor: U.padmin, ids: newSenderIds(NUM_A) });
    n += 1;
    await credits.topupPending(EA, SA, `cs_f3r_${RUN}_${n}`, 5_000, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(EA, SA, `cs_f3r_${RUN}_${n}`, 5_000, `evt_f3r_${RUN}_${n}`, `pi_f3r_${RUN}_${n}`, true);
    expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: EA, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly texting limit" })).error).toBeNull();
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
      aged(`delete from public.studio_sms_price_list where created_by = '${U.padmin}'`);
      ownerReactivate(psql, `id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
  });

  it("F3-01 privileges: the helper is internal (no anon / authenticated), service-role readable; the replaced actions keep service-role-only grants; definer with a pinned search_path", async () => {
    for (const fn of ["_tw4usage_reconciler_ready()", "tw4_usage_set_switch(boolean, uuid, text)", "tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid)"]) {
      // checked, never called as anon (calling a revoked function as anon crashes the local QA image)
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('public', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    expect(psql("select p.prosecdef::text || '|' || array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'public._tw4usage_reconciler_ready()'::regprocedure")).toBe("true|search_path=pg_catalog, public, pg_temp");
    expect(psql("select pg_get_function_result('public._tw4usage_reconciler_ready()'::regprocedure) || '|' || pg_get_function_identity_arguments('public._tw4usage_reconciler_ready()'::regprocedure)")).toBe("jsonb|");
    clearRuns();
    freshRun();
    const viaService = await rpc("_tw4usage_reconciler_ready");
    expect(viaService.error).toBeNull();
    expect(Object.keys(viaService.data as object).sort()).toEqual(["detail", "last_success_at", "ok"]);
    expect((viaService.data as Ready).ok).toBe(true);
  });

  it("F3-02 (a) with no reconcile run, enabling billed texting is refused (TW024) and nothing is written; switching OFF is always allowed", async () => {
    clearRuns();
    forceSwitch(false);
    expect(readiness()).toEqual({ ok: false, detail: "no_completed_run", last_success_at: null });
    const logBefore = psql(`select count(*) from public.studio_sms_usage_switch_log`);
    const r = await setSwitch(true);
    expect(r.error?.code).toBe("TW024");
    expect(r.error?.message).toContain("no_completed_run");
    expect(switchOn()).toBe(false);
    expect(psql(`select count(*) from public.studio_sms_usage_switch_log`)).toBe(logBefore);
    expect((await setSwitch(false)).error).toBeNull();
    // failed and still-running runs are not a success
    addRun({ status: "failed", startedMin: -3, finishedMin: -2, leaseMin: -1 });
    addRun({ status: "running", startedMin: -1, leaseMin: 1 });
    expect(readiness().detail).toBe("no_completed_run");
    expect((await setSwitch(true)).error?.code).toBe("TW024");
  });

  it("F3-03 a completed run that read no provider evidence settles nothing: not ready (no_evidence_reads)", async () => {
    clearRuns();
    forceSwitch(false);
    addRun({ status: "completed", startedMin: -2, finishedMin: -1, leaseMin: 1, evidenceRead: false });
    addRun({ status: "completed", startedMin: -4, finishedMin: -3, leaseMin: 1, evidenceRead: null });
    expect(readiness()).toEqual({ ok: false, detail: "no_evidence_reads", last_success_at: null });
    expect((await setSwitch(true)).error?.code).toBe("TW024");
    // a later run without reads does not hide an earlier one that read (still within the window)
    freshRun();
    addRun({ status: "completed", startedMin: -1, finishedMin: 0, leaseMin: 1, evidenceRead: false });
    expect(readiness().ok).toBe(true);
  });

  it("F3-03b evidence failing: completed runs that read evidence but settled / read nothing of what was due (every read failed) never count", async () => {
    clearRuns();
    forceSwitch(false);
    addRun({ status: "completed", startedMin: -40, finishedMin: -39, leaseMin: -38, counts: { due: 0 } }); // an old proved run
    addRun({ status: "completed", startedMin: -3, finishedMin: -2, leaseMin: 1, counts: { due: 4, settled: 0, pending: 0, review: 0, retrying: 4, errors: 4 } });
    const r = readiness();
    expect(r).toMatchObject({ ok: false, detail: "evidence_failing" });
    expect(r.last_success_at).toBe(psql(`select to_json(min(finished_at))#>>'{}' from public.studio_sms_reconcile_runs where runner = '${RUNNER}'`));
    expect((await setSwitch(true)).error?.code).toBe("TW024");
    // reads that only sent texts to review prove nothing either; a non-numeric count is ignored (fail closed)
    addRun({ status: "completed", startedMin: -2, finishedMin: -1, leaseMin: 1, counts: { due: 2, settled: 0, pending: 0, review: 2 } });
    expect(readiness().detail).toBe("evidence_failing");
    aged(`insert into public.studio_sms_reconcile_runs (job, runner, status, started_at, lease_expires_at, finished_at, summary) values ('usage_reconcile', '${RUNNER}', 'completed',
           clock_timestamp() - interval '2 minutes', clock_timestamp() + interval '1 minute', clock_timestamp() - interval '30 seconds', '{"evidence_read": true, "due": 3, "settled": "3"}'::jsonb)`);
    expect(readiness().detail).toBe("evidence_failing");
    // never proved at all (only failing runs): still evidence_failing, no last success
    clearRuns();
    addRun({ status: "completed", startedMin: -3, finishedMin: -2, leaseMin: 1, counts: { due: 1, settled: 0, pending: 0 } });
    expect(readiness()).toEqual({ ok: false, detail: "evidence_failing", last_success_at: null });
    // one settled text, or one read pending status, proves the run
    addRun({ status: "completed", startedMin: -2, finishedMin: -1, leaseMin: 1, counts: { due: 5, settled: 1, pending: 0, errors: 4 } });
    expect(readiness().ok).toBe(true);
    clearRuns();
    addRun({ status: "completed", startedMin: -2, finishedMin: -1, leaseMin: 1, counts: { due: 1, settled: 0, pending: 1 } });
    expect(readiness().ok).toBe(true);
    // backoff masking: a failed read backs its text off, so the NEXT run is idle (due 0). That idle run must not hide the failing one.
    clearRuns();
    addRun({ status: "completed", startedMin: -12, finishedMin: -11, leaseMin: -10, counts: { due: 3, settled: 0, pending: 0, retrying: 3, errors: 3 } });
    addRun({ status: "completed", startedMin: -7, finishedMin: -6, leaseMin: -5, counts: { due: 0 } });
    addRun({ status: "completed", startedMin: -2, finishedMin: -1, leaseMin: 1, counts: { due: 0 } });
    const masked = readiness();
    expect(masked).toMatchObject({ ok: false, detail: "evidence_failing" });
    expect(masked.last_success_at).toBe(psql(`select to_json(max(finished_at))#>>'{}' from public.studio_sms_reconcile_runs where runner = '${RUNNER}'`));
    // a later run that reads and settles the backed-off texts clears it; a failing run older than the 30-minute window no longer counts
    addRun({ status: "completed", startedMin: -1, finishedMin: 0, leaseMin: 1, counts: { due: 3, settled: 3, pending: 0 } });
    expect(readiness().ok).toBe(true);
    clearRuns();
    addRun({ status: "completed", startedMin: -40, finishedMin: -39, leaseMin: -38, counts: { due: 3, settled: 0, pending: 0 } });
    freshRun();
    expect(readiness().ok).toBe(true);
  });

  it("F3-04 (c) a fresh completed run makes the switch and tw4_usage_begin succeed; last_success_at is that run's finish", async () => {
    clearRuns();
    forceSwitch(false);
    freshRun();
    const ready = readiness();
    expect(ready.ok).toBe(true);
    expect(ready.detail).toBe("ready");
    expect(ready.last_success_at).toBe(psql(`select to_json(max(finished_at))#>>'{}' from public.studio_sms_reconcile_runs where runner = '${RUNNER}'`));
    expect((await setSwitch(true)).error).toBeNull();
    expect(switchOn()).toBe(true);
    const r = await begin();
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.data).toMatchObject({ decision: "send", state: "reserved" });
    // a live (unexpired) lease of the next run does not change anything
    addRun({ status: "running", startedMin: 0, leaseMin: 2 });
    expect(readiness().ok).toBe(true);
  });

  it("F3-05 (b) stale: the last successful run is older than 30 minutes -> begin refuses with TW024 and writes nothing; a replay still answers; re-enabling is refused", async () => {
    clearRuns();
    freshRun();
    forceSwitch(true);
    const source = randomUUID();
    const first = await begin(source);
    expect(first.error).toBeNull();
    clearRuns();
    addRun({ status: "completed", startedMin: -33, finishedMin: -31, leaseMin: -30 });
    const r = readiness();
    expect(r).toMatchObject({ ok: false, detail: "stale" });
    expect(r.last_success_at).not.toBeNull();
    const before = counts();
    const refused = await begin();
    expect(refused.error?.code).toBe("TW024");
    expect(refused.error?.message).toContain("stale");
    expect(counts()).toBe(before); // no log, no attempt, no reservation, nothing reserved
    // the same source is a replay of the text already reserved, never a refusal or a second reservation
    const replay = await begin(source);
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ decision: "replay", attempt_id: (first.data as { attempt_id: string }).attempt_id });
    expect(counts()).toBe(before);
    expect((await setSwitch(true)).error?.code).toBe("TW024");
    expect((await setSwitch(false)).error).toBeNull();
    // the boundary: 29 minutes old is still ready
    clearRuns();
    addRun({ status: "completed", startedMin: -31, finishedMin: -29, leaseMin: -29 });
    expect(readiness().ok).toBe(true);
  });

  it("F3-06 stuck lease: an expired lease left unclosed for 10+ minutes means the schedule stopped -> not ready; a recently expired one is the normal gap; the next run_begin clears it", async () => {
    clearRuns();
    freshRun();
    forceSwitch(true);
    addRun({ status: "running", startedMin: -14, leaseMin: -11 });
    expect(readiness()).toMatchObject({ ok: false, detail: "stuck_lease" });
    expect(readiness().last_success_at).not.toBeNull();
    const before = counts();
    const refused = await begin();
    expect(refused.error?.code).toBe("TW024");
    expect(refused.error?.message).toContain("stuck_lease");
    expect(counts()).toBe(before);
    forceSwitch(false);
    expect((await setSwitch(true)).error?.code).toBe("TW024");
    // the next scheduled begin closes the expired lease as failed: ready again (the fresh completed run still counts)
    const lease = await rpc("tw4_reconcile_run_begin", { p_job: "usage_reconcile", p_runner: "tw4f3recon:runner", p_lease_seconds: 120 });
    expect(lease.data).toMatchObject({ acquired: true });
    expect(readiness().ok).toBe(true);
    await rpc("tw4_reconcile_run_finish", { p_run_id: (lease.data as { run_id: string }).run_id, p_status: "failed", p_summary: {}, p_error: null });
    clearRuns();
    freshRun();
    addRun({ status: "running", startedMin: -6, leaseMin: -4 });
    expect(readiness().ok).toBe(true);
  });

  it("F3-07 the scheduled run itself produces a ready state (run_begin -> run_finish completed with evidence_read)", async () => {
    clearRuns();
    forceSwitch(false);
    const lease = await rpc("tw4_reconcile_run_begin", { p_job: "usage_reconcile", p_runner: "tw4f3recon:runner", p_lease_seconds: 120 });
    expect(readiness().detail).toBe("no_completed_run");
    await rpc("tw4_reconcile_run_finish", { p_run_id: (lease.data as { run_id: string }).run_id, p_status: "completed", p_summary: { evidence_read: true, released_unsent: 0, due: 0, settled: 0, pending: 0, errors: 0 }, p_error: null });
    expect(readiness()).toMatchObject({ ok: true, detail: "ready" });
    expect((await setSwitch(true)).error).toBeNull();
    expect((await setSwitch(false)).error).toBeNull();
  });

  it("F3-08 enabling is refused while the usage ledger has reconciliation gaps, even with a healthy reconciler", () => {
    clearRuns();
    freshRun();
    forceSwitch(false);
    // a text reservation with no attempt is a gap; inserted and checked inside one transaction that is rolled back
    const err = psqlError(`begin;
      set local session_replication_role = replica;
      insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key) values ('${EA}', '${SA}', 'sms_usage', 3, 'credit', 'sms:' || gen_random_uuid());
      set local session_replication_role = origin;
      select public.tw4_usage_set_switch(true, '${U.padmin}', 'f3 fixture: switch on with a gap');
      rollback;`);
    expect(err).toContain("reconciliation gaps");
    expect(psql("select public._tw4us_reconciliation_gaps()")).toBe("0");
    expect(switchOn()).toBe(false);
  });

  const EXPECTED_LATER_CALLER = "_tw4act_items(uuid)";
  const externalCallers = () => psql(`select coalesce(string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text), '') from pg_proc p
    where (p.prosrc like '%\_tw4usage\_reconciler\_ready%' or p.prosrc like '%\_tw4usage\_run\_proved%')
      and p.oid not in ('public._tw4usage_reconciler_ready()'::regprocedure, '${BEGIN_SIG}'::regprocedure, '${SWITCH_SIG}'::regprocedure)`);

  it("F3-09 (d) rollback: refused while billed texting is on or another function calls the helper (a true dependency of later migrations)", () => {
    const migration = readFileSync(MIGRATION, "utf8");
    const rollback = readFileSync(ROLLBACK, "utf8");
    expect([fp(BEGIN_SIG), fp(SWITCH_SIG), fp("public._tw4usage_reconciler_ready()")]).toEqual(["7e85d636", "8adf296c", "39b0ad11"]);
    expect(psqlError(migration)).toContain("already applied");

    forceSwitch(true);
    expect(psqlError(rollback)).toContain("billed texting is switched on");
    forceSwitch(false);
    psqlFile("create function public.tw4f3recon_probe() returns jsonb language sql as $$ select public._tw4usage_reconciler_ready() $$; revoke all on function public.tw4f3recon_probe() from public, anon, authenticated, service_role;");
    try {
      expect(psqlError(rollback)).toContain("another function calls");
    } finally {
      psqlFile("drop function public.tw4f3recon_probe()");
    }
    expect(fp("public._tw4usage_reconciler_ready()")).toBe("39b0ad11");
    // The refusal is a TRUE dependency on a stack with later migrations: 20261219 and 20261226 replace public._tw4act_items(uuid), which calls the helper (dynamic SQL).
    // On such a stack the real caller must be exactly that set, and the rollback must refuse because of it with nothing changed; the clean-rollback leg then cannot run
    // (the next test then runs the clean rollback with that one caller stubbed inside a rolled-back transaction).
    const callers = externalCallers();
    expect(["", EXPECTED_LATER_CALLER]).toContain(callers);
    if (callers !== "") {
      expect(psqlError(rollback)).toContain("another function calls");
      expect([fp(BEGIN_SIG), fp(SWITCH_SIG), fp("public._tw4usage_reconciler_ready()")]).toEqual(["7e85d636", "8adf296c", "39b0ad11"]);
      expect(psql("select to_regprocedure('public._tw4usage_run_proved(jsonb)') is not null")).toBe("t");
    }
  });

  it("F3-09 (d2) rollback once nothing else calls the helper: restores the exact main fingerprints; re-apply is clean (one transaction, rolled back)", () => {
    const migration = readFileSync(MIGRATION, "utf8");
    const rollback = readFileSync(ROLLBACK, "utf8");
    const strip = (t: string) => t.replace(/^begin;/m, "").replace(/^commit;/m, "");
    // On a stack with later migrations the only external caller is public._tw4act_items(uuid) (asserted above). Rolling those layers back first is what removes it;
    // inside this rolled-back transaction it is replaced by an inert stub with the same signature, which is exactly the state after those layers are gone.
    const stub = externalCallers() === "" ? "" : "create or replace function public._tw4act_items(p_studio_id uuid) returns jsonb language sql as $stub$ select '[]'::jsonb $stub$;";
    const line = (label: string, sig: string) => `select '${label}=' || coalesce((select left(md5(replace(p.prosrc, chr(13), '')), 8) from pg_proc p where p.oid = to_regprocedure('${sig}')), '');`;
    const fps = (tag: string) => [line(`${tag}.begin`, BEGIN_SIG), line(`${tag}.switch`, SWITCH_SIG), line(`${tag}.ready`, "public._tw4usage_reconciler_ready()")].join(" ");
    const aclSql = (tag: string) => `select '${tag}.acl=' || (select string_agg(p.proname || ':' || array_to_string(p.proacl, ','), ' ' order by p.proname) from pg_proc p where p.oid in ('${BEGIN_SIG}'::regprocedure, '${SWITCH_SIG}'::regprocedure));`;
    const anonSql = "select 'anon=' || (has_function_privilege('anon', 'public._tw4usage_reconciler_ready()', 'execute') or has_function_privilege('authenticated', 'public._tw4usage_reconciler_ready()', 'execute'))::text;";
    const gone = "select 'gone=' || (to_regprocedure('public._tw4usage_run_proved(jsonb)') is null and to_regclass('public.studio_sms_reconcile_runs_completed') is null)::text;";
    const out = psqlFile(`begin; ${stub}
      ${aclSql("before")}
      ${strip(rollback)}
      ${fps("rolled")} ${aclSql("rolled")} ${gone}
      ${strip(migration)}
      ${fps("reapplied")} ${aclSql("reapplied")} ${anonSql}
      rollback;`).split(String.fromCharCode(10)).filter((l) => /^(before|rolled|reapplied|gone|anon)/.test(l));
    const v = (k: string) => out.find((l) => l.startsWith(k + "="))?.slice(k.length + 1);
    expect([v("rolled.begin"), v("rolled.switch"), v("rolled.ready")]).toEqual(["3013c006", "90813ea0", ""]);
    expect(v("rolled.acl")).toBe(v("before.acl"));
    expect(v("gone")).toBe("true");
    expect([v("reapplied.begin"), v("reapplied.switch"), v("reapplied.ready")]).toEqual(["7e85d636", "8adf296c", "39b0ad11"]);
    expect(v("reapplied.acl")).toBe(v("before.acl"));
    expect(v("anon")).toBe("false");
    // a second rollback in the same state is refused as not applied
    expect(psqlError(`begin; ${stub} ${strip(rollback)} ${strip(rollback)} rollback;`)).toContain("the migration is not applied");
    // nothing leaked out of the rolled-back transaction
    expect([fp(BEGIN_SIG), fp(SWITCH_SIG), fp("public._tw4usage_reconciler_ready()")]).toEqual(["7e85d636", "8adf296c", "39b0ad11"]);
  });
});
