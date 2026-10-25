/**
 * TW-4F automated sender re-verification against a REAL schema (migrations through 20261206090000): the 24-hour trust window, the scheduled run under the
 * shared lease, definitive vs transient outcomes, backoff, fencing, no automatic recovery of a failed sender, dispatch and reservation effects, health,
 * privileges and the rollback refusal. Nothing reaches Twilio: the read provider is the scripted in-memory fake (fake evidence is accepted only where the
 * local-QA marker table exists). LOCAL QA STACK ONLY; run serially (--no-file-parallelism): the run lease is one per job for the whole database.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 1_000_000 });

import { FakeSenderReadProvider, SenderReadError, runScheduledSenderReverify, reverifyDueSenders, type SenderReadProvider } from "@/lib/sms/senderVerification";
import { SupabaseCreditStore } from "@/lib/sms/twilioIsv/creditStore";
import { LOCAL_QA_MARKER, newSenderIds, reconcilerReadySql, readySender, type SenderIds } from "./senderFixtures";

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

const SA = "a7e00000-0000-4000-8000-00000000000a"; // business A
const SB = "a7e00000-0000-4000-8000-00000000000c"; // business B
const EA = "e7e00000-0000-4000-8000-0000000000e1";
const EB = "e7e00000-0000-4000-8000-0000000000e2";
const U = { owner_a: "a7e00000-0000-4000-8000-000000000101", padmin: "a7e00000-0000-4000-8000-000000000401" };
const ACC_A = `AC${"a7".repeat(16)}`;
const ACC_B = `AC${"b7".repeat(16)}`;
const NUM_A = "+15125550401";
const NUM_B = "+15125550402";
const PHONE = "+15125550142";
const INBOUND = "https://app.example.test/api/sms/twilio/inbound";
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
delete from public.studio_sms_reconcile_runs where runner like 'tw4rv:%';
delete from public.studio_sms_usage_attempt_events where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_usage_attempts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_sender_verifications where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_provisioning_steps where studio_id in (${STUDIOS});
delete from public.studio_sms_approval_refs where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_billed_senders where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_usage_switch_log where changed_by = '${U.padmin}';
delete from public.sms_message_logs where studio_id in (${STUDIOS});
delete from public.studio_sms_monthly_limits where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_timezones where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_ledger where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_reservations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES}));
delete from public.studio_sms_credit_topups where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_twilio_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_studios where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_legal_entities where id in (${ENTITIES});
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in (${Object.values(U).map((u) => `'${u}'`).join(", ")});
delete from auth.users where email like '%@tw4rv-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4rv-e2e.test', now(), now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.padmin}', 'platform_admin') on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values ('${SA}', 'TW4RV A', 'tw4rv-a', null, 'UTC'), ('${SB}', 'TW4RV B', 'tw4rv-b', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${U.owner_a}', '${SA}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'RV Alpha LLC', '7551', 15000, '${U.padmin}'), ('${EB}', 'RV Beta LLC', '7552', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${SA}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A', now() - interval '2 days'),
  ('${SB}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B', now() - interval '2 days');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${EA}', '${ACC_A}', 'df:test:${EA}', 'test', 'active', '${U.padmin}'), ('${EB}', '${ACC_B}', 'df:test:${EB}', 'test', 'active', '${U.padmin}');
commit;`;

describe.skipIf(!enabled)("TW-4F automated sender re-verification (real schema, fake provider)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let snapshotActivePrices: string[] = [];
  let n = 0;
  const ids: Record<string, SenderIds> = {};
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const closeRuns = () => aged("update public.studio_sms_reconcile_runs set status = 'failed', finished_at = clock_timestamp(), error = 'test cleanup' where status = 'running'");
  const ready = (studio: string) => psql(`select coalesce((public._tw4sr_ready('${studio}')).id::text, 'none')`) !== "none";
  const latest = (studio: string) => JSON.parse(psql(`select row_to_json(s)::text from public.studio_sms_billed_senders s where s.studio_id = '${studio}' order by s.seq desc limit 1`)) as { id: string; status: string };
  const verifications = (studio: string) => psql(`select string_agg(outcome || ':' || coalesce(failure_code, '-'), ',' order by seq) from public.studio_sms_sender_verifications where studio_id = '${studio}'`);
  /** the last success (and every later attempt) moved back in time */
  const ageVerification = (studio: string, hours: number) =>
    aged(`update public.studio_sms_sender_verifications set created_at = created_at - interval '${hours} hours' where studio_id = '${studio}'`);
  const accountFor = (studio: string) => (studio === SB ? ACC_B : ACC_A);
  /** a fresh, ready sender for the studio (record + admin verification with fake evidence and the Advanced Opt-Out attestation) */
  const freshSender = async (studio: string) => {
    aged(`delete from public.studio_sms_usage_attempt_events where attempt_id in (select id from public.studio_sms_usage_attempts where studio_id = '${studio}');
          delete from public.studio_sms_usage_attempts where studio_id = '${studio}'; delete from public.sms_message_logs where studio_id = '${studio}';
          delete from public.studio_sms_sender_verifications where studio_id = '${studio}'; delete from public.studio_sms_billed_senders where studio_id = '${studio}';
          delete from public.studio_sms_provisioning_steps where studio_id = '${studio}'; delete from public.studio_sms_onboarding_audit where studio_id = '${studio}'`);
    ids[studio] = newSenderIds(studio === SB ? NUM_B : NUM_A);
    await readySender(rpc, (sql) => aged(sql), { studio, account: accountFor(studio), actor: U.padmin, ids: ids[studio] });
    expect(ready(studio)).toBe(true);
    return ids[studio];
  };
  /** a read provider that answers like Twilio for this sender (scriptable per resource) */
  const healthy = (studio: string, over: Partial<Record<"account" | "service" | "campaign" | "brand" | "number" | "service_number", unknown>> = {}) => {
    const i = ids[studio];
    const account = accountFor(studio);
    const fake = new FakeSenderReadProvider()
      .script("account", account, over.account ?? { sid: account, status: "active" })
      .script("service", i.mg, over.service ?? { sid: i.mg, account_sid: account, us_app_to_person_registered: true, inbound_request_url: INBOUND, use_inbound_webhook_on_number: false })
      .script("campaign", i.qe, over.campaign ?? { sid: i.qe, account_sid: account, messaging_service_sid: i.mg, campaign_status: "VERIFIED", mock: false, brand_registration_sid: i.bn, us_app_to_person_usecase: "MIXED" })
      .script("brand", i.bn, over.brand ?? { sid: i.bn, status: "APPROVED", mock: false })
      .script("number", i.pn, over.number ?? { sid: i.pn, account_sid: account, phone_number: i.e164, sms_capable: true, status: "in-use", sms_url: null })
      .script("service_number", i.pn, over.service_number ?? { sid: i.pn, service_sid: i.mg, account_sid: account });
    return fake;
  };
  const scheduled = (provider: SenderReadProvider | null, runner = `tw4rv:${RUN}`) => runScheduledSenderReverify(admin, provider, { runner, inboundUrl: INBOUND, budgetMs: 30_000 });
  const begin = (studio: string) =>
    rpc("tw4_usage_begin", {
      p_source_kind: "manual", p_source_id: randomUUID(), p_studio_id: studio, p_client_id: null, p_phone_e164: PHONE, p_body: "Your lesson is tomorrow at 6pm.",
      p_message_type: "manual", p_related_table: null, p_related_id: null, p_sent_by: null,
    });
  const fundAndOpen = async (e: string, studio: string) => {
    n += 1;
    const ref = `cs_rv_${RUN}_${n}`;
    await credits.topupPending(e, studio, ref, 2_500, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(e, studio, ref, 2_500, `evt_rv_${RUN}_${n}`, `pi_rv_${RUN}_${n}`, true);
    expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: e, p_actor: U.padmin, p_limit_cents: 5_000, p_effective_month: null, p_reason: "fixture: monthly texting limit" })).error).toBeNull();
    aged(reconcilerReadySql(`tw4rv:ready:${RUN}`)); // 20261218: switching on (and every begin) needs a fresh reconcile run; cleaned with tw4rv:% runs
    expect((await rpc("tw4_usage_set_switch", { p_enabled: true, p_actor: U.padmin, p_reason: "fixture: switch on for tests" })).error).toBeNull();
  };

  beforeAll(async () => {
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
    psqlFile(LOCAL_QA_MARKER);
    closeRuns();
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    expect((await rpc("tw4_price_set", { p_kind: "sms_usage", p_customer_cents: 3, p_provider_cents: 1, p_description: "fixture sms_usage price", p_actor: U.padmin })).error).toBeNull();
    await fundAndOpen(EA, SA);
  });
  afterAll(() => {
    try {
      closeRuns();
      psqlFile(CLEANUP);
      aged(`delete from public.studio_sms_price_list where created_by = '${U.padmin}'; update public.studio_sms_price_list set active = true where id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
  });

  it("RV-01 healthy sender: the scheduled run re-verifies it (due after 20 h), it stays ready with a fresh 24 h window, audited, run recorded", async () => {
    await freshSender(SA);
    closeRuns();
    expect((await scheduled(healthy(SA))).ran).toBe(true);
    expect(verifications(SA)).toBe("verified:-"); // not due yet: only the admin verification exists
    ageVerification(SA, 21);
    const before = latest(SA).id;
    const outcome = await scheduled(healthy(SA));
    expect(outcome.ran && outcome.summary).toMatchObject({ due: 1, verified: 1, failed: 0, errors: 0 });
    expect(verifications(SA)).toBe("verified:-,verified:-");
    expect(latest(SA).id).not.toBe(before);   // a new approved row carrying the new verification
    expect(ready(SA)).toBe(true);
    expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${SA}' and action = 'sender_verified' and actor_type = 'system'`)).toBe("1");
    const h = (await rpc("tw4_sender_health", { p_actor: U.padmin })).data as { senders: Array<Record<string, unknown>>; scheduler: Record<string, unknown> };
    const row = h.senders.find((x) => x.studio_id === SA)!;
    expect(row).toMatchObject({ state: "ready", blocked: false, decisive_outcome: "verified" });
    expect(Date.parse(String(row.expires_at)) - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(h.scheduler.last_completed_at).not.toBeNull();
    expect(h.scheduler.stale).toBe(false);
  });

  const definitive: Array<[string, (studio: string) => FakeSenderReadProvider, string]> = [
    ["RV-02 campaign revoked / rejected", (st) => healthy(st, { campaign: { ...{ sid: ids[st].qe, account_sid: accountFor(st), messaging_service_sid: ids[st].mg, mock: false, brand_registration_sid: ids[st].bn, us_app_to_person_usecase: "MIXED" }, campaign_status: "FAILED" } }), "campaign_not_verified"],
    ["RV-03 number removed from the Messaging Service", (st) => healthy(st, { service_number: new SenderReadError("not_found") }), "read_not_found:service_number"],
    ["RV-04 number transferred to another account", (st) => healthy(st, { number: { sid: ids[st].pn, account_sid: ACC_B, phone_number: ids[st].e164, sms_capable: true, status: "in-use", sms_url: null } }), "number_not_ready"],
    ["RV-05 wrong legal-business subaccount (service on another account)", (st) => healthy(st, { service: { sid: ids[st].mg, account_sid: ACC_B, us_app_to_person_registered: true, inbound_request_url: INBOUND, use_inbound_webhook_on_number: false } }), "service_not_on_account"],
    ["RV-10 provider evidence mismatch (another number on the same SID)", (st) => healthy(st, { number: { sid: ids[st].pn, account_sid: accountFor(st), phone_number: "+15125550999", sms_capable: true, status: "in-use", sms_url: null } }), "number_not_ready"],
  ];
  for (const [title, provider, code] of definitive) {
    it(`${title}: definitive failure invalidates readiness at once and blocks new reservations`, async () => {
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 21);
      const outcome = await scheduled(provider(SA));
      expect(outcome.ran && outcome.summary).toMatchObject({ failed: 1, verified: 0 });
      expect(verifications(SA)).toBe(`verified:-,failed:${code}`);
      expect(ready(SA)).toBe(false);
      expect((await begin(SA)).error?.code).toBe("TW015");
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${SA}' and action = 'sender_verify_failed' and note like '%code=${code}%'`)).toBe("1");
      const h = (await rpc("tw4_sender_health", { p_actor: U.padmin })).data as { senders: Array<Record<string, unknown>> };
      expect(h.senders.find((x) => x.studio_id === SA)).toMatchObject({ state: "failed", blocked: true, decisive_code: code });
    });
  }

  it("RV-06 stale evidence: a success older than 24 h is not trusted (sending refused) and is listed expired, still due", async () => {
    await freshSender(SA);
    ageVerification(SA, 25);
    expect(ready(SA)).toBe(false);
    expect((await begin(SA)).error?.code).toBe("TW015");
    const h = (await rpc("tw4_sender_health", { p_actor: U.padmin })).data as { senders: Array<Record<string, unknown>>; scheduler: Record<string, unknown> };
    expect(h.senders.find((x) => x.studio_id === SA)).toMatchObject({ state: "expired", blocked: true });
    expect(Number(h.scheduler.expired)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify((await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data)).toContain(latest(SA).id);
  });

  for (const [title, kind] of [["RV-07 provider timeout / outage", "timeout"], ["RV-08 Twilio rate limiting", "rate_limited"], ["RV-09 subaccount token unavailable during rotation", "credentials_unavailable"], ["RV-07b provider 5xx", "server"]] as const) {
    it(`${title}: transient, so the last success is kept (not revoked), audited, backed off, and trust is NOT extended`, async () => {
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 21);
      const before = latest(SA).id;
      const outcome = await scheduled(healthy(SA, { campaign: new SenderReadError(kind) }));
      expect(outcome.ran && outcome.summary).toMatchObject({ inconclusive: 1, failed: 0 });
      expect(verifications(SA)).toBe(`verified:-,inconclusive:read_${kind}:campaign`);
      expect(latest(SA)).toMatchObject({ id: before, status: "approved" });
      expect(ready(SA)).toBe(true);   // still inside its original 24 hours
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${SA}' and action = 'sender_reverify_inconclusive'`)).toBe("1");
      // backed off: not due again right away
      expect(JSON.stringify((await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data)).not.toContain(before);
      aged(`update public.studio_sms_sender_verifications set created_at = created_at - interval '6 minutes' where studio_id = '${SA}' and outcome = 'inconclusive'`);
      expect(JSON.stringify((await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data)).toContain(before);
      // the window keeps running from the last SUCCESS: 3 more hours of outage and it expires
      ageVerification(SA, 3);
      expect(ready(SA)).toBe(false);
    });
  }

  it("RV-11 concurrent scheduler executions: one takes the lease, the other is busy and reads nothing", async () => {
    await freshSender(SA);
    closeRuns();
    ageVerification(SA, 21);
    const slow = healthy(SA);
    const [a, b] = await Promise.all([scheduled(slow, `tw4rv:${RUN}:a`), scheduled(healthy(SA), `tw4rv:${RUN}:b`)]);
    expect([a, b].filter((o) => !o.ran)).toEqual([{ ran: false, reason: "busy" }]);
    expect(verifications(SA)).toBe("verified:-,verified:-");
  });

  it("RV-12 duplicate verification attempts for one sender: serialized on the studio lock; the second is skipped (the sender row moved on)", async () => {
    await freshSender(SA);
    closeRuns();
    ageVerification(SA, 21);
    const lease = (await rpc("tw4_reconcile_run_begin", { p_job: "sender_reverify", p_runner: `tw4rv:${RUN}:dup`, p_lease_seconds: 120 })).data as { run_id: string };
    const due = (await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data as Array<{ studio_id: string; sender_id: string }>;
    const item = due.find((d) => d.studio_id === SA)!;
    const evidence = { account: { sid: ACC_A, status: "active" } };   // shape irrelevant for the second call: it must not be judged at all
    const { evidenceFor } = await import("./senderFixtures");
    const good = evidenceFor(ACC_A, ids[SA]);
    const results = await Promise.all([1, 2, 3].map(() => rpc("tw4_sender_reverify_run", { p_run_id: lease.run_id, p_studio_id: SA, p_sender_id: item.sender_id, p_evidence: good, p_source: "fake" })));
    expect(results.map((r) => (r.data as { outcome: string }).outcome).sort()).toEqual(["skipped", "skipped", "verified"]);
    expect(verifications(SA)).toBe("verified:-,verified:-");
    expect((await rpc("tw4_sender_reverify_run", { p_run_id: lease.run_id, p_studio_id: SA, p_sender_id: item.sender_id, p_evidence: evidence, p_source: "fake" })).data).toMatchObject({ outcome: "skipped" });
    closeRuns();
  });

  it("RV-13 worker interruption: a crashed run is closed as failed, its writes are fenced, the next run finishes the work", async () => {
    await freshSender(SA);
    closeRuns();
    ageVerification(SA, 21);
    const dead = (await rpc("tw4_reconcile_run_begin", { p_job: "sender_reverify", p_runner: `tw4rv:${RUN}:dies`, p_lease_seconds: 60 })).data as { run_id: string };
    aged(`update public.studio_sms_reconcile_runs set lease_expires_at = clock_timestamp() - interval '1 second' where id = '${dead.run_id}'`);
    const { evidenceFor } = await import("./senderFixtures");
    expect((await rpc("tw4_sender_reverify_run", { p_run_id: dead.run_id, p_studio_id: SA, p_sender_id: latest(SA).id, p_evidence: evidenceFor(ACC_A, ids[SA]), p_source: "fake" })).error?.code).toBe("TW023");
    const next = await scheduled(healthy(SA));
    expect(next.ran && next.summary).toMatchObject({ verified: 1 });
    expect(psql(`select status from public.studio_sms_reconcile_runs where id = '${dead.run_id}'`)).toBe("failed");
    // with the lease lost mid-run, the run stops and is recorded failed with a fixed message
    ageVerification(SA, 21);
    const lost = await reverifyDueSenders(admin, healthy(SA), { runId: dead.run_id, inboundUrl: INBOUND }).catch((e: Error) => e.message);
    expect(lost).toBe("sender reverify: the run lost its lease");
  });

  it("RV-14 expired readiness during an outage: retries never extend trust; once Twilio answers again a success restores it (expiry is not a revocation)", async () => {
    await freshSender(SA);
    closeRuns();
    ageVerification(SA, 23);
    for (let i = 0; i < 3; i += 1) {
      await scheduled(healthy(SA, { account: new SenderReadError("timeout") }));
      aged(`update public.studio_sms_sender_verifications set created_at = created_at - interval '2 hours' where studio_id = '${SA}'`);   // past the longer backoff of an expired sender
    }
    expect(ready(SA)).toBe(false);   // 23 h + 6 h of outage: expired
    expect((await begin(SA)).error?.code).toBe("TW015");
    const h = (await rpc("tw4_sender_health", { p_actor: U.padmin })).data as { senders: Array<Record<string, unknown>> };
    expect(h.senders.find((x) => x.studio_id === SA)).toMatchObject({ state: "expired", blocked: true, last_attempt_outcome: "inconclusive" });
    expect(Number(h.senders.find((x) => x.studio_id === SA)!.retries_since_success)).toBe(3);
    const back = await scheduled(healthy(SA));
    expect(back.ran && back.summary).toMatchObject({ verified: 1 });
    expect(ready(SA)).toBe(true);
  });

  it("RV-15 / RV-19 a definitive revocation blocks dispatch: an unmarked reservation is released at the marker (never sent); a marked one is kept for reconciliation", async () => {
    await freshSender(SA);
    closeRuns();
    const unmarked = (await begin(SA)).data as { attempt_id: string; amount_cents: number };
    const marked = (await begin(SA)).data as { attempt_id: string };
    expect((await rpc("tw4_usage_dispatching", { p_attempt_id: marked.attempt_id })).data).toMatchObject({ dispatch: true });
    ageVerification(SA, 21);
    await scheduled(healthy(SA, { campaign: { sid: ids[SA].qe, account_sid: ACC_A, messaging_service_sid: ids[SA].mg, campaign_status: "SUSPENDED", mock: false, brand_registration_sid: ids[SA].bn, us_app_to_person_usecase: "MIXED" } }));
    expect(ready(SA)).toBe(false);
    expect((await rpc("tw4_usage_dispatching", { p_attempt_id: unmarked.attempt_id })).data).toMatchObject({ dispatch: false, state: "released", reason: "sender_not_ready" });
    expect(psql(`select state from public.studio_sms_usage_attempts where id = '${marked.attempt_id}'`)).toBe("submitting");   // possibly dispatched: never released here
    expect(psql(`select r.status from public.studio_sms_credit_reservations r join public.studio_sms_usage_attempts a on a.reservation_id = r.id where a.id = '${marked.attempt_id}'`)).toBe("reserved");
    expect((await begin(SA)).error?.code).toBe("TW015");
  });

  it("RV-16 no automatic recovery of a failed sender: not due, the scheduled path skips it even with healthy evidence; only a platform admin restores it", async () => {
    await freshSender(SA);
    closeRuns();
    ageVerification(SA, 21);
    await scheduled(healthy(SA, { brand: { sid: ids[SA].bn, status: "SUSPENDED", mock: false } }));
    expect(ready(SA)).toBe(false);
    expect(JSON.stringify((await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data)).not.toContain(latest(SA).id);
    const lease = (await rpc("tw4_reconcile_run_begin", { p_job: "sender_reverify", p_runner: `tw4rv:${RUN}:skip`, p_lease_seconds: 120 })).data as { run_id: string };
    const { evidenceFor } = await import("./senderFixtures");
    expect((await rpc("tw4_sender_reverify_run", { p_run_id: lease.run_id, p_studio_id: SA, p_sender_id: latest(SA).id, p_evidence: evidenceFor(ACC_A, ids[SA]), p_source: "fake" })).data).toMatchObject({ outcome: "skipped" });
    closeRuns();
    expect(ready(SA)).toBe(false);
    // a 30034 callback flag is not restored by the scheduler either (source 'callback' is never trusted for readiness)
    expect((await rpc("tw4_sender_verify", { p_studio_id: SA, p_sender_id: latest(SA).id, p_actor: U.padmin, p_evidence: evidenceFor(ACC_A, ids[SA]), p_attested_opt_out: true, p_source: "fake" })).data).toMatchObject({ outcome: "verified" });
    expect(ready(SA)).toBe(true);
  });

  it("RV-17 manual re-verification is platform-admin only, needs the Advanced Opt-Out attestation, and the health read is admin-only", async () => {
    await freshSender(SA);
    const { evidenceFor } = await import("./senderFixtures");
    expect((await rpc("tw4_sender_verify", { p_studio_id: SA, p_sender_id: latest(SA).id, p_actor: U.owner_a, p_evidence: evidenceFor(ACC_A, ids[SA]), p_attested_opt_out: true, p_source: "fake" })).error?.code).toBe("42501");
    expect((await rpc("tw4_sender_verify", { p_studio_id: SA, p_sender_id: latest(SA).id, p_actor: U.padmin, p_evidence: evidenceFor(ACC_A, ids[SA]), p_attested_opt_out: false, p_source: "fake" })).data).toMatchObject({ outcome: "failed", code: "advanced_opt_out_not_attested" });
    expect(ready(SA)).toBe(false);
    expect((await rpc("tw4_sender_health", { p_actor: U.owner_a })).error?.code).toBe("42501");
  });

  it("RV-18 tenant isolation and least privilege: API roles reach nothing; the scheduler path is fenced; another business's identity never verifies a sender", async () => {
    for (const fn of ["tw4_sender_reverify_run(uuid, uuid, uuid, jsonb, text)", "tw4_sender_health(uuid)", "tw4_sender_due_reverify(int)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    await freshSender(SA);
    await freshSender(SB);
    closeRuns();
    ageVerification(SA, 21);
    // business B's real, healthy resources presented for A's sender: every identity check fails (wrong account / service / number)
    const lease = (await rpc("tw4_reconcile_run_begin", { p_job: "sender_reverify", p_runner: `tw4rv:${RUN}:iso`, p_lease_seconds: 120 })).data as { run_id: string };
    const { evidenceFor } = await import("./senderFixtures");
    const r = await rpc("tw4_sender_reverify_run", { p_run_id: lease.run_id, p_studio_id: SA, p_sender_id: latest(SA).id, p_evidence: evidenceFor(ACC_B, ids[SB]), p_source: "fake" });
    expect(r.data).toMatchObject({ outcome: "failed" });
    expect(ready(SA)).toBe(false);
    expect(ready(SB)).toBe(true);
    closeRuns();
    // the due list carries the account from the database's own sender row
    const due = (await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data as Array<{ studio_id: string; account_sid: string }>;
    for (const d of due.filter((x) => x.studio_id === SA || x.studio_id === SB)) expect(d.account_sid).toBe(accountFor(d.studio_id));
  });

  it("RV-20 inbound routing and usage reconciliation are unaffected: a failed sender's number still maps STOP to its studio; the reconcile lease is independent", async () => {
    await freshSender(SA);
    closeRuns();
    ageVerification(SA, 21);
    await scheduled(healthy(SA, { number: new SenderReadError("not_found") }));
    expect(ready(SA)).toBe(false);
    expect(psql(`select public.tw4_inbound_studio_for('${ACC_A}', null, '${NUM_A}')`)).toBe(SA);   // STOP / START / HELP still reach the studio
    const usageLease = (await rpc("tw4_reconcile_run_begin", { p_job: "usage_reconcile", p_runner: `tw4rv:${RUN}:usage`, p_lease_seconds: 120 })).data as { acquired: boolean };
    const senderLease = (await rpc("tw4_reconcile_run_begin", { p_job: "sender_reverify", p_runner: `tw4rv:${RUN}:sender`, p_lease_seconds: 120 })).data as { acquired: boolean };
    expect([usageLease.acquired, senderLease.acquired]).toEqual([true, true]);
    closeRuns();
  });

  it("RV-21 no read provider (reads switched off): the run is recorded failed and changes nothing; trust lapses on its own", async () => {
    await freshSender(SA);
    closeRuns();
    ageVerification(SA, 21);
    const outcome = await scheduled(null);
    expect(outcome.ran && outcome.summary).toMatchObject({ reads_available: false, due: 0 });
    expect(verifications(SA)).toBe("verified:-");
    ageVerification(SA, 4);
    expect(ready(SA)).toBe(false);
  });

  it("RV-22 the scheduler stale alert, and the rollback refuses once re-verification evidence exists (tested inside a rolled-back transaction)", async () => {
    await freshSender(SA);
    aged("update public.studio_sms_reconcile_runs set finished_at = clock_timestamp() - interval '3 hours', started_at = clock_timestamp() - interval '3 hours' where job = 'sender_reverify' and status <> 'running'");
    const h = (await rpc("tw4_sender_health", { p_actor: U.padmin })).data as { scheduler: { stale: boolean } };
    expect(h.scheduler.stale).toBe(true);
    const rollback = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261206090000_twilio_sender_reverification_rollback.sql"), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    expect(psqlError(`begin;\n${rollback}\nrollback;`)).toContain("rollback refused: re-verification evidence exists");
    expect(psql("select to_regprocedure('public.tw4_sender_reverify_run(uuid,uuid,uuid,jsonb,text)') is not null")).toBe("t");
  });

  describe("fixes from the independent security review", () => {
    it("R1 a definitive failure on one resource wins over a transient error on another (a 429 never hides a campaign that is no longer VERIFIED)", async () => {
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 21);
      const out = await scheduled(healthy(SA, {
        campaign: { sid: ids[SA].qe, account_sid: ACC_A, messaging_service_sid: ids[SA].mg, campaign_status: "FAILED", mock: false, brand_registration_sid: ids[SA].bn, us_app_to_person_usecase: "MIXED" },
        number: new SenderReadError("rate_limited"),
      }));
      expect(out.ran && out.summary).toMatchObject({ failed: 1, inconclusive: 0 });
      expect(verifications(SA)).toBe("verified:-,failed:campaign_not_verified");
      expect(ready(SA)).toBe(false);
      // a definitive READ error (404) on one resource also beats a transient one on another
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 21);
      await scheduled(healthy(SA, { account: new SenderReadError("timeout"), service_number: new SenderReadError("not_found") }));
      expect(verifications(SA)).toBe("verified:-,failed:read_not_found:service_number");
      // everything that was read is fine and one read was transient: inconclusive (kept, not revoked)
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 21);
      await scheduled(healthy(SA, { brand: new SenderReadError("server") }));
      expect(verifications(SA)).toBe("verified:-,inconclusive:read_server:brand");
      expect(ready(SA)).toBe(true);
    });

    it("R2 still-trusted senders are checked first, nearest deadline first, so unreachable expired senders cannot starve them; expired ones back off longer", async () => {
      await freshSender(SA);
      await freshSender(SB);
      ageVerification(SA, 30);   // expired
      ageVerification(SB, 21);   // still trusted, due
      const order = ((await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data as Array<{ studio_id: string }>).map((d) => d.studio_id).filter((x) => x === SA || x === SB);
      expect(order).toEqual([SB, SA]);
      // an expired sender with one inconclusive read waits 30 minutes (a trusted one 5)
      closeRuns();
      await scheduled(healthy(SA, { account: new SenderReadError("timeout") }), `tw4rv:${RUN}:bo`);
      aged(`update public.studio_sms_sender_verifications set created_at = created_at - interval '10 minutes' where studio_id = '${SA}' and outcome = 'inconclusive'`);
      expect(JSON.stringify((await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data)).not.toContain(latest(SA).id);
      aged(`update public.studio_sms_sender_verifications set created_at = created_at - interval '25 minutes' where studio_id = '${SA}' and outcome = 'inconclusive'`);
      expect(JSON.stringify((await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data)).toContain(latest(SA).id);
    });

    it("R3 trust lapsed more than 72 hours ago is never restored by the scheduler; a restore after a shorter lapse is audited separately", async () => {
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 80);
      expect(JSON.stringify((await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data)).not.toContain(latest(SA).id);
      const lease = (await rpc("tw4_reconcile_run_begin", { p_job: "sender_reverify", p_runner: `tw4rv:${RUN}:old`, p_lease_seconds: 120 })).data as { run_id: string };
      const { evidenceFor } = await import("./senderFixtures");
      expect((await rpc("tw4_sender_reverify_run", { p_run_id: lease.run_id, p_studio_id: SA, p_sender_id: latest(SA).id, p_evidence: evidenceFor(ACC_A, ids[SA]), p_source: "fake" })).data).toMatchObject({ outcome: "skipped", code: "lapsed_needs_admin" });
      closeRuns();
      expect(ready(SA)).toBe(false);
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 30);
      expect((await scheduled(healthy(SA))).ran).toBe(true);
      expect(ready(SA)).toBe(true);
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${SA}' and action = 'sender_reverify_restored'`)).toBe("1");
      // a routine renewal inside the window is not a "restore"
      ageVerification(SA, 21);
      await scheduled(healthy(SA));
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${SA}' and action = 'sender_reverify_restored'`)).toBe("1");
    });

    it("R4 the scheduled re-verify refuses outside a scheduler run (no direct path around the lease), and a run whose lease expired is not shown as running", async () => {
      await freshSender(SA);
      const { evidenceFor } = await import("./senderFixtures");
      expect((await rpc("tw4_sender_reverify", { p_studio_id: SA, p_sender_id: latest(SA).id, p_evidence: evidenceFor(ACC_A, ids[SA]), p_source: "fake" })).error?.code).toBe("42501");
      closeRuns();
      const lease = (await rpc("tw4_reconcile_run_begin", { p_job: "sender_reverify", p_runner: `tw4rv:${RUN}:ghost`, p_lease_seconds: 60 })).data as { run_id: string };
      aged(`update public.studio_sms_reconcile_runs set lease_expires_at = clock_timestamp() - interval '1 second' where id = '${lease.run_id}'`);
      const h = (await rpc("tw4_sender_health", { p_actor: U.padmin })).data as { scheduler: { running: unknown } };
      expect(h.scheduler.running).toBeNull();
      closeRuns();
    });

    it("R6 a per-number inbound webhook whose number read fails transiently is inconclusive (kept), never a definite inbound-routing failure", async () => {
      const perNumber = (st: string, numberAnswer: unknown) => healthy(st, {
        service: { sid: ids[st].mg, account_sid: accountFor(st), us_app_to_person_registered: true, inbound_request_url: null, use_inbound_webhook_on_number: true },
        number: numberAnswer,
      });
      // healthy per-number routing verifies
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 21);
      await scheduled(perNumber(SA, { sid: ids[SA].pn, account_sid: ACC_A, phone_number: ids[SA].e164, sms_capable: true, status: "in-use", sms_url: INBOUND }));
      expect(verifications(SA)).toBe("verified:-,verified:-");
      // the number read is rate limited: the routing cannot be known -> inconclusive, the sender stays approved and ready
      for (const kind of ["rate_limited", "timeout", "server"] as const) {
        await freshSender(SA);
        closeRuns();
        ageVerification(SA, 21);
        await scheduled(perNumber(SA, new SenderReadError(kind)));
        expect(verifications(SA), kind).toBe(`verified:-,inconclusive:read_${kind}:number`);
        expect(ready(SA), kind).toBe(true);
        expect(latest(SA).status).toBe("approved");
      }
      // definitive answers still fail: the number is gone (404), or it routes inbound somewhere else
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 21);
      await scheduled(perNumber(SA, new SenderReadError("not_found")));
      expect(verifications(SA)).toBe("verified:-,failed:read_not_found:number");
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 21);
      await scheduled(perNumber(SA, { sid: ids[SA].pn, account_sid: ACC_A, phone_number: ids[SA].e164, sms_capable: true, status: "in-use", sms_url: "https://elsewhere.example/hook" }));
      expect(verifications(SA)).toBe("verified:-,failed:inbound_not_routed_to_danceflow");
      // a transient error elsewhere never hides a definite misroute that WAS read
      await freshSender(SA);
      closeRuns();
      ageVerification(SA, 21);
      await scheduled(healthy(SA, {
        service: { sid: ids[SA].mg, account_sid: ACC_A, us_app_to_person_registered: true, inbound_request_url: null, use_inbound_webhook_on_number: true },
        number: { sid: ids[SA].pn, account_sid: ACC_A, phone_number: ids[SA].e164, sms_capable: true, status: "in-use", sms_url: "https://elsewhere.example/hook" },
        brand: new SenderReadError("server"),
      }));
      expect(verifications(SA)).toBe("verified:-,failed:inbound_not_routed_to_danceflow");
    });

    it("R5 a run that can read nothing is recorded FAILED, so the stale alert fires instead of a healthy-looking completed run", async () => {
      await freshSender(SA);
      closeRuns();
      aged("update public.studio_sms_reconcile_runs set finished_at = clock_timestamp() - interval '3 hours', started_at = clock_timestamp() - interval '3 hours' where job = 'sender_reverify' and status <> 'running'");
      const out = await scheduled(null);
      expect(out.ran && out.failed).toBe(true);
      const h = (await rpc("tw4_sender_health", { p_actor: U.padmin })).data as { scheduler: { stale: boolean } };
      expect(h.scheduler.stale).toBe(true);
    });
  });
});
