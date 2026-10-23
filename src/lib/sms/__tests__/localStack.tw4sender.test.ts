/**
 * Sender readiness and dispatch integrity against a REAL schema (migration 20261204090000): recording, database-judged verification evidence, readiness
 * (24-hour freshness, registration-failure flags), revocation that cannot fail open (begin, replay and the dispatch marker), uniqueness, inbound mapping
 * for subaccount senders, tenant isolation, the pilot business and the rollback. Synthetic: no Twilio. LOCAL QA STACK ONLY.
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

import { SupabaseCreditStore } from "@/lib/sms/twilioIsv/creditStore";
import { LOCAL_QA_MARKER, brandStepSql, evidenceFor, newSenderIds, readySender, sid, type SenderIds } from "./senderFixtures";

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

const PA1 = "a8e00000-0000-4000-8000-00000000000a";
const PA2 = "a8e00000-0000-4000-8000-00000000000b";
const PB1 = "a8e00000-0000-4000-8000-00000000000c";
const PL = "a8e00000-0000-4000-8000-00000000000d"; // legacy (no legal business)
const EA = "e8e00000-0000-4000-8000-0000000000e1";
const EB = "e8e00000-0000-4000-8000-0000000000e2";
const U = { owner_a: "a8e00000-0000-4000-8000-000000000101", padmin: "a8e00000-0000-4000-8000-000000000401" };
const ACC_A = `AC${"a8".repeat(16)}`;
const ACC_B = `AC${"b8".repeat(16)}`;
const PHONE = "+15125550188";
const RUN = randomBytes(3).toString("hex");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};

const ENTITIES = `'${EA}', '${EB}'`;
const STUDIOS = `'${PA1}', '${PA2}', '${PB1}', '${PL}'`;
const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_reconcile_runs where runner = 'tw4sender:test';
delete from public.studio_sms_sender_verifications where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_provisioning_steps where studio_id in (${STUDIOS});
delete from public.studio_sms_usage_attempts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_billed_senders where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_usage_switch_log where changed_by = '${U.padmin}';
delete from public.sms_message_logs where studio_id in (${STUDIOS});
delete from public.studio_sms_pilot_exceptions where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_approval_refs where legal_entity_id in (${ENTITIES});
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
delete from auth.users where email like '%@tw4sender-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
${LOCAL_QA_MARKER}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4sender-e2e.test', now(), now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.padmin}', 'platform_admin') on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values
  ('${PA1}', 'TW4SENDER A1', 'tw4sender-a1', null, 'UTC'), ('${PA2}', 'TW4SENDER A2', 'tw4sender-a2', null, 'UTC'),
  ('${PB1}', 'TW4SENDER B1', 'tw4sender-b1', null, 'UTC'), ('${PL}', 'TW4SENDER Legacy', 'tw4sender-legacy', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${U.owner_a}', '${PA1}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'SND Alpha LLC', '8881', 15000, '${U.padmin}'), ('${EB}', 'SND Beta LLC', '8882', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${PA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 1', now() - interval '2 days'),
  ('${PA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location 2', now() - interval '1 day'),
  ('${PB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${EA}', '${ACC_A}', 'df:test:${EA}', 'test', 'active', '${U.padmin}'), ('${EB}', '${ACC_B}', 'df:test:${EB}', 'test', 'active', '${U.padmin}');
commit;`;

describe.skipIf(!enabled)("sender readiness and dispatch integrity (real schema, synthetic evidence)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  let snapshotActivePrices: string[] = [];
  let n = 0;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const latest = (studio: string) => psql(`select status from public.studio_sms_billed_senders where studio_id = '${studio}' order by seq desc limit 1`);
  const ready = (studio: string) => psql(`select (public._tw4sr_ready('${studio}')).id is not null`) === "t";
  const reserved = (e: string) => Number(psql(`select coalesce((select reserved_cents from public.studio_sms_credit_accounts where legal_entity_id = '${e}'), 0)`));
  const e164 = (i: number) => `+1512555${String(1000 + ((i + Number.parseInt(RUN, 16)) % 9000)).padStart(4, "0")}`;
  let phoneSeq = 0;
  const ids = (shared: Partial<Pick<SenderIds, "mg" | "qe" | "bn">> = {}) => newSenderIds(e164(phoneSeq++), shared);
  const record = (studio: string, s: SenderIds, actor = U.padmin) =>
    rpc("tw4_sender_record", { p_studio_id: studio, p_actor: actor, p_messaging_service_sid: s.mg, p_campaign_sid: s.qe, p_phone_number_sid: s.pn, p_sender_e164: s.e164, p_reason: "fixture: subaccount sending identity" });
  const verify = (studio: string, senderId: string, ev: Record<string, unknown>, opts: { attested?: boolean; source?: string; actor?: string } = {}) =>
    rpc("tw4_sender_verify", { p_studio_id: studio, p_sender_id: senderId, p_actor: opts.actor ?? U.padmin, p_evidence: ev, p_attested_opt_out: opts.attested ?? true, p_source: opts.source ?? "fake" });
  const clearSenders = (studios: string[]) =>
    aged(`delete from public.studio_sms_sender_verifications where studio_id in (${studios.map((s) => `'${s}'`).join(", ")});
          delete from public.studio_sms_billed_senders where studio_id in (${studios.map((s) => `'${s}'`).join(", ")});
          delete from public.studio_sms_provisioning_steps where studio_id in (${studios.map((s) => `'${s}'`).join(", ")})`);
  const fund = async (e: string, studio: string, pack: number) => {
    n += 1;
    const ref = `cs_snd_${RUN}_${n}`;
    await credits.topupPending(e, studio, ref, pack, new Date(Date.now() + 20 * 60_000).toISOString());
    await credits.settleTopup(e, studio, ref, pack, `evt_snd_${RUN}_${n}`, `pi_snd_${RUN}_${n}`, true);
  };
  const begin = (studio: string, over: Record<string, unknown> = {}) =>
    rpc("tw4_usage_begin", {
      p_source_kind: "manual", p_source_id: randomUUID(), p_studio_id: studio, p_client_id: null, p_phone_e164: PHONE, p_body: "Your lesson is tomorrow. Reply STOP to opt out.",
      p_message_type: "manual", p_related_table: null, p_related_id: null, p_sent_by: null, ...over,
    });

  beforeAll(async () => {
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    expect((await rpc("tw4_price_set", { p_kind: "sms_usage", p_customer_cents: 3, p_provider_cents: 1, p_description: "fixture sms_usage price", p_actor: U.padmin })).error).toBeNull();
    expect((await rpc("tw4_usage_set_switch", { p_enabled: true, p_actor: U.padmin, p_reason: "fixture: billed texting on for tests" })).error).toBeNull();
    await fund(EA, PA1, 5_000);
    expect((await rpc("tw4_monthly_limit_set_admin", { p_entity_id: EA, p_actor: U.padmin, p_limit_cents: 10_000, p_effective_month: null, p_reason: "fixture: monthly texting limit" })).error).toBeNull();
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
      aged(`delete from public.studio_sms_price_list where created_by = '${U.padmin}'; update public.studio_sms_price_list set active = true where id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
  });

  it("privileges: the verification table is unreachable by API roles; actions are service-role only; helpers callable by no API role; the old setter is gone", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(psql(`select has_table_privilege('${role}', 'public.studio_sms_sender_verifications', 'select,insert,update,delete')`)).toBe("f");
    }
    for (const fn of ["tw4_sender_record(uuid, uuid, text, text, text, text, text)", "tw4_sender_verify(uuid, uuid, uuid, jsonb, boolean, text)", "tw4_sender_reverify(uuid, uuid, jsonb, text)", "tw4_sender_reverify_run(uuid, uuid, uuid, jsonb, text)",
      "tw4_sender_revoke(uuid, uuid, text, boolean)", "tw4_inbound_studio_for(text, text, text)", "tw4_sender_overview(uuid)", "tw4_sender_due_reverify(int)",
      "tw4_usage_release_unprepared(uuid, text)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
    }
    for (const fn of ["_tw4sr_ready(uuid)", "_tw4sr_judge(public.studio_sms_billed_senders, jsonb, boolean)", "_tw4sr_apply(uuid, uuid, uuid, jsonb, boolean, text)", "_tw4sr_flag(uuid, text, text, text, text)", "_tw4sr_lock(uuid)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute') or has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("f");
    }
    // readiness depends on seq order: no API role may use (setval / nextval) the history sequences
    for (const seq of ["studio_sms_billed_senders_seq_seq", "studio_sms_sender_verifications_seq_seq"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(psql(`select has_sequence_privilege('${role}', 'public.${seq}', 'usage,select,update')`), `${role} ${seq}`).toBe("f");
      }
    }
    expect(psql("select has_function_privilege('service_role', 'public.tw4_usage_billed_sender_set(uuid, uuid, text, text, text, text)', 'execute')")).toBe("f");
  });

  describe("recording", () => {
    it("platform admin only, every identifier well-formed, a reason; linked studio with an active subaccount; the row is pending and cannot send", async () => {
      clearSenders([PA1, PA2, PB1]);
      const s = ids();
      expect((await record(PA1, s, U.owner_a)).error?.code).toBe("42501");
      for (const bad of [{ mg: "MGbad" }, { qe: "QE1" }, { pn: "PN1" }, { e164: "+447700900123" }, { e164: "5125550100" }]) {
        expect((await record(PA1, { ...s, ...bad } as SenderIds)).error?.code, JSON.stringify(bad)).toBe("22023");
      }
      expect((await record(PL, s)).error?.code).toBe("TW010");
      aged(`update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = '${EA}'`);
      expect((await record(PA1, s)).error?.code).toBe("TW015");
      aged(`update public.studio_sms_twilio_accounts set status = 'active' where legal_entity_id = '${EA}'`);
      const rec = await record(PA1, s);
      expect(rec.error).toBeNull();
      expect(rec.data).toMatchObject({ status: "pending", account_sid: ACC_A });
      expect(ready(PA1)).toBe(false);
      expect((await begin(PA1)).error?.code).toBe("TW015");
      expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PA1}' and action = 'sender_recorded'`)).toBe("1");
    });

    it("a number belongs to one location (a revoked one keeps it until released); locations of one business may share the Messaging Service and campaign; another business may not", async () => {
      clearSenders([PA1, PA2, PB1]);
      const a1 = ids();
      expect((await record(PA1, a1)).error).toBeNull();
      expect((await record(PA2, { ...ids({ mg: a1.mg, qe: a1.qe }), pn: a1.pn })).error?.code).toBe("23505"); // same number SID
      expect((await record(PA2, { ...ids({ mg: a1.mg, qe: a1.qe }), e164: a1.e164 })).error?.code).toBe("23505"); // same E.164
      expect((await record(PA2, ids({ mg: a1.mg, qe: a1.qe }))).error).toBeNull(); // shared service + campaign, own number: allowed
      expect((await record(PB1, ids({ mg: a1.mg }))).error?.code).toBe("23505"); // another business's Messaging Service
      expect((await record(PB1, ids({ qe: a1.qe }))).error?.code).toBe("23505"); // another business's campaign
      expect((await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: revoke location 1", p_release: false })).error).toBeNull();
      clearSenders([PA2]);
      expect((await record(PA2, { ...ids(), pn: a1.pn, e164: a1.e164 })).error?.code).toBe("23505"); // revoked still holds the number
      expect((await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: release the number", p_release: true })).error).toBeNull();
      expect((await record(PA2, { ...ids(), pn: a1.pn, e164: a1.e164 })).error).toBeNull(); // released: free to move
    });

    it("a location changes its number only after releasing the current one (inbound must never lose an unreleased number); the same number may be re-recorded", async () => {
      clearSenders([PA1, PA2, PB1]);
      const first = await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      expect((await record(PA1, ids({ mg: first.ids.mg, qe: first.ids.qe }))).error?.code).toBe("TW022"); // approved, unreleased
      expect((await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: revoke, not yet released", p_release: false })).error).toBeNull();
      expect((await record(PA1, ids({ mg: first.ids.mg, qe: first.ids.qe }))).error?.code).toBe("TW022"); // revoked still holds it (STOP still maps)
      expect((await record(PA1, { ...first.ids, mg: sid("MG"), qe: sid("QE") })).error).toBeNull(); // the SAME number under a new service: allowed
      const map = async (to: string) => (await rpc("tw4_inbound_studio_for", { p_account_sid: ACC_A, p_messaging_service_sid: first.ids.mg, p_to_e164: to })).data;
      expect(await map(first.ids.e164)).toBe(PA1); // inbound via the OLD service still reaches the location: the number decides
      expect((await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: release the number now", p_release: true })).error).toBeNull();
      expect((await record(PA1, ids())).error).toBeNull(); // released: a new number may be recorded
      expect(await map(first.ids.e164)).toBeNull();
    });

    it("concurrency: two locations recording the same number at once: exactly one wins", async () => {
      clearSenders([PA1, PA2, PB1]);
      const s = ids();
      const results = await Promise.all([record(PA1, s), record(PA2, { ...ids(), pn: s.pn, e164: s.e164 }), record(PB1, { ...ids(), pn: s.pn, e164: s.e164 })]);
      expect(results.filter((r) => !r.error)).toHaveLength(1);
      expect(results.filter((r) => r.error?.code === "23505")).toHaveLength(2);
    });
  });

  describe("verification is judged by the database", () => {
    it("complete, consistent evidence approves the sender and makes it ready; every inconsistency fails with its own code and leaves it pending", async () => {
      clearSenders([PA1]);
      const s = ids();
      aged(brandStepSql(PA1, ACC_A, s.bn));
      const pendingId = ((await record(PA1, s)).data as { sender_id: string }).sender_id;
      const cases: [Record<string, Record<string, unknown> | unknown[]>, string][] = [
        [{ account: { status: "suspended" } }, "account_not_active"],
        [{ account: { sid: ACC_B } }, "account_not_active"],
        [{ service: { account_sid: ACC_B } }, "service_not_on_account"],
        [{ service: { us_app_to_person_registered: false } }, "service_not_a2p_registered"],
        [{ service: { inbound_route_ok: false } }, "inbound_not_routed_to_danceflow"],
        [{ campaign: { messaging_service_sid: sid("MG") } }, "campaign_not_on_service"],
        [{ campaign: { campaign_status: "IN_PROGRESS" } }, "campaign_not_verified"],
        [{ campaign: { campaign_status: "FAILED" } }, "campaign_not_verified"],
        [{ campaign: { campaign_status: "SUSPENDED" } }, "campaign_not_verified"],
        [{ campaign: { mock: true } }, "mock_registration"],
        [{ brand: { mock: true } }, "mock_registration"],
        [{ campaign: { us_app_to_person_usecase: "LOW_VOLUME" } }, "use_case_mismatch"],
        [{ brand: { status: "PENDING" } }, "brand_not_the_business"],
        [{ campaign: { brand_registration_sid: sid("BN") }, brand: { sid: "" } }, "brand_not_the_business"],
        [{ number: { phone_number: "+15125550000" } }, "number_not_ready"],
        [{ number: { sms_capable: false } }, "number_not_ready"],
        [{ number: { status: "released" } }, "number_not_ready"],
        [{ service_number: { service_sid: sid("MG") } }, "number_not_in_service"],
        [{ read_errors: [{ resource: "campaign", kind: "not_found" }] }, "read_not_found:campaign"],
      ];
      for (const [over, code] of cases) {
        const r = await verify(PA1, pendingId, evidenceFor(ACC_A, s, over));
        expect(r.error, JSON.stringify(over)).toBeNull();
        expect(r.data, JSON.stringify(over)).toMatchObject({ outcome: "failed", code });
        expect(latest(PA1)).toBe("pending");
      }
      // a brand that is not the business's own runner brand on this subaccount (no B1 step for it)
      const other = ids();
      aged(`update public.studio_sms_provisioning_steps set twilio_account_sid = '${ACC_B}' where studio_id = '${PA1}'`);
      expect((await verify(PA1, pendingId, evidenceFor(ACC_A, s))).data).toMatchObject({ outcome: "failed", code: "brand_not_the_business" });
      aged(`update public.studio_sms_provisioning_steps set twilio_account_sid = '${ACC_A}' where studio_id = '${PA1}'`);
      expect(other.mg).not.toBe(s.mg);
      // no attestation of Advanced Opt-Out
      expect((await verify(PA1, pendingId, evidenceFor(ACC_A, s), { attested: false })).data).toMatchObject({ outcome: "failed", code: "advanced_opt_out_not_attested" });
      // a transient read failure proves nothing: inconclusive, no change
      expect((await verify(PA1, pendingId, evidenceFor(ACC_A, s, { read_errors: [{ resource: "service", kind: "timeout" }] }))).data).toMatchObject({ outcome: "inconclusive" });
      expect(latest(PA1)).toBe("pending");
      const verifiedAudits = () => Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${PA1}' and action = 'sender_verified'`));
      const auditsBefore = verifiedAudits();
      const ok = await verify(PA1, pendingId, evidenceFor(ACC_A, s));
      expect(ok.data).toMatchObject({ outcome: "verified" });
      expect(latest(PA1)).toBe("approved");
      expect(ready(PA1)).toBe(true);
      expect(verifiedAudits()).toBe(auditsBefore + 1);
    });

    it("only the current row can be verified (a revoke or a newer record in between wins); only a platform admin; fake evidence only on a local-QA database", async () => {
      clearSenders([PA1]);
      const s = ids();
      aged(brandStepSql(PA1, ACC_A, s.bn));
      const pendingId = ((await record(PA1, s)).data as { sender_id: string }).sender_id;
      expect((await verify(PA1, pendingId, evidenceFor(ACC_A, s), { actor: U.owner_a })).error?.code).toBe("42501");
      expect((await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: revoke before the verify lands", p_release: false })).error).toBeNull();
      expect((await verify(PA1, pendingId, evidenceFor(ACC_A, s))).error?.code).toBe("TW021"); // the verify started before the revoke cannot bring it back // the verify started before the revoke cannot bring it back
      expect(latest(PA1)).toBe("revoked");
      clearSenders([PA1]);
      aged(brandStepSql(PA1, ACC_A, s.bn));
      const p2 = ((await record(PA1, s)).data as { sender_id: string }).sender_id;
      psql("alter table public.tw4_local_qa_only rename to tw4_local_qa_only_off");
      try {
        expect((await verify(PA1, p2, evidenceFor(ACC_A, s))).error?.code).toBe("42501"); // fake evidence refused without the local marker
      } finally {
        psql("alter table public.tw4_local_qa_only_off rename to tw4_local_qa_only");
      }
      expect((await verify(PA1, p2, evidenceFor(ACC_A, s), { source: "admin_says_ok" })).error?.code).toBe("22023");
    });
  });

  /** the scheduled re-verify as the scheduler makes it: inside a live 'sender_reverify' run (20261206) */
  const reverify = async (studio: string, senderId: string, evidence: unknown) => {
    psqlFile("begin; set local session_replication_role = replica; update public.studio_sms_reconcile_runs set status = 'failed', finished_at = clock_timestamp(), error = 'test' where job = 'sender_reverify' and status = 'running'; commit;");
    const lease = (await rpc("tw4_reconcile_run_begin", { p_job: "sender_reverify", p_runner: "tw4sender:test", p_lease_seconds: 60 })).data as { run_id: string };
    const r = await rpc("tw4_sender_reverify_run", { p_run_id: lease.run_id, p_studio_id: studio, p_sender_id: senderId, p_evidence: evidence, p_source: "fake" });
    await rpc("tw4_reconcile_run_finish", { p_run_id: lease.run_id, p_status: "completed", p_summary: {}, p_error: null });
    return r;
  };

  describe("readiness gates paid dispatch and revocation cannot fail open", () => {
    it("begin needs a ready sender and returns its number; readiness expires after 24 hours; a 30034 callback fails it at once; a re-verify restores it", async () => {
      clearSenders([PA1]);
      const { ids: s, senderId } = await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      const b = await begin(PA1);
      expect(b.error, JSON.stringify(b.error)).toBeNull();
      expect(b.data).toMatchObject({ decision: "send", account_sid: ACC_A, messaging_service_sid: s.mg, sender_e164: s.e164 });
      aged(`update public.studio_sms_sender_verifications set created_at = now() - interval '25 hours' where studio_id = '${PA1}'`);
      expect((await begin(PA1)).error?.code).toBe("TW015");
      expect(JSON.stringify((await rpc("tw4_sender_due_reverify", { p_limit: 100 })).data)).toContain(senderId);
      expect((await reverify(PA1, senderId, evidenceFor(ACC_A, s))).data).toMatchObject({ outcome: "verified" });
      expect((await begin(PA1)).error).toBeNull();
      // Twilio says the sender is not registered (30034) on a delivery callback: not ready at once
      const sub = (await begin(PA1)).data as { attempt_id: string };
      await rpc("tw4_usage_dispatching", { p_attempt_id: sub.attempt_id });
      const smSid = `SM${randomBytes(16).toString("hex")}`;
      await rpc("tw4_usage_submitted", { p_attempt_id: sub.attempt_id, p_provider_sid: smSid });
      expect((await rpc("tw4_usage_record_callback", { p_attempt_id: sub.attempt_id, p_provider_sid: smSid, p_signer_account: ACC_A, p_status: "undelivered", p_error_code: "30034" })).error).toBeNull();
      expect(ready(PA1)).toBe(false);
      expect((await begin(PA1)).error?.code).toBe("TW015");
      // a repeated 30034 adds nothing (already not ready)
      const flags = () => psql(`select count(*) from public.studio_sms_sender_verifications where studio_id = '${PA1}' and source = 'callback'`);
      expect(flags()).toBe("1");
      await rpc("tw4_usage_record_callback", { p_attempt_id: sub.attempt_id, p_provider_sid: smSid, p_signer_account: ACC_A, p_status: "undelivered", p_error_code: "30034" });
      expect(flags()).toBe("1");
      // the scheduler never restores a failed sender: it is not on the work list and a re-verify is skipped; an admin's verification restores it
      const current = psql(`select id from public.studio_sms_billed_senders where studio_id = '${PA1}' order by seq desc limit 1`);
      expect(JSON.stringify((await rpc("tw4_sender_due_reverify", { p_limit: 500 })).data)).not.toContain(current);
      expect((await reverify(PA1, current, evidenceFor(ACC_A, s))).data).toMatchObject({ outcome: "skipped" });
      expect(ready(PA1)).toBe(false);
      expect((await verify(PA1, current, evidenceFor(ACC_A, s))).data).toMatchObject({ outcome: "verified" });
      expect(ready(PA1)).toBe(true);
      // a re-verify with definite negative evidence makes it not ready; transient leaves it ready
      const now = psql(`select id from public.studio_sms_billed_senders where studio_id = '${PA1}' order by seq desc limit 1`);
      expect((await reverify(PA1, now, evidenceFor(ACC_A, s, { read_errors: [{ resource: "account", kind: "server" }] }))).data).toMatchObject({ outcome: "inconclusive" });
      expect(ready(PA1)).toBe(true);
      expect((await reverify(PA1, now, evidenceFor(ACC_A, s, { campaign: { campaign_status: "FAILED" } }))).data).toMatchObject({ outcome: "failed", code: "campaign_not_verified" });
      expect(ready(PA1)).toBe(false);
    });

    it("a late 30034 for a number the location no longer sends from flags nothing; readiness follows the location's CURRENT use case; fake evidence counts only on a local-QA database", async () => {
      clearSenders([PA1]);
      const first = await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      const old = (await begin(PA1)).data as { attempt_id: string };
      await rpc("tw4_usage_dispatching", { p_attempt_id: old.attempt_id });
      const smSid = `SM${randomBytes(16).toString("hex")}`;
      await rpc("tw4_usage_submitted", { p_attempt_id: old.attempt_id, p_provider_sid: smSid });
      expect((await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: release the first number", p_release: true })).error).toBeNull();
      await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids({ mg: first.ids.mg, qe: first.ids.qe, bn: first.ids.bn }), brandStep: false });
      expect((await rpc("tw4_usage_record_callback", { p_attempt_id: old.attempt_id, p_provider_sid: smSid, p_signer_account: ACC_A, p_status: "undelivered", p_error_code: "30034" })).error).toBeNull();
      expect(ready(PA1)).toBe(true); // the new number was not the one that failed
      expect(psql(`select count(*) from public.studio_sms_sender_verifications where studio_id = '${PA1}' and source = 'callback'`)).toBe("0");
      // the location's path now needs another use case than the one verified (e.g. Standard -> Low-Volume Standard): not ready until verified again
      const vid = psql(`select verification_id from public.studio_sms_billed_senders where studio_id = '${PA1}' order by seq desc limit 1`);
      aged(`update public.studio_sms_sender_verifications set evidence = jsonb_set(evidence, '{campaign,us_app_to_person_usecase}', '"LOW_VOLUME"') where id = '${vid}'`);
      expect(ready(PA1)).toBe(false);
      aged(`update public.studio_sms_sender_verifications set evidence = jsonb_set(evidence, '{campaign,us_app_to_person_usecase}', '"MIXED"') where id = '${vid}'`);
      expect(ready(PA1)).toBe(true);
      // fake evidence makes nothing ready where the local-QA marker is absent
      psql("alter table public.tw4_local_qa_only rename to tw4_local_qa_only_off");
      try {
        expect(ready(PA1)).toBe(false);
      } finally {
        psql("alter table public.tw4_local_qa_only_off rename to tw4_local_qa_only");
      }
      expect(ready(PA1)).toBe(true);
    });

    it("a send that cannot get ready before its marker releases its reservation at once; a marked attempt is never released this way", async () => {
      clearSenders([PA1]);
      await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      const before = reserved(EA);
      const source = randomUUID();
      const b = (await begin(PA1, { p_source_id: source })).data as { attempt_id: string; amount_cents: number };
      expect(reserved(EA)).toBe(before + b.amount_cents);
      expect((await rpc("tw4_usage_release_unprepared", { p_attempt_id: b.attempt_id, p_code: "Not A Code" })).error?.code).toBe("22023");
      expect((await rpc("tw4_usage_release_unprepared", { p_attempt_id: b.attempt_id, p_code: "not_prepared" })).data).toMatchObject({ released: true });
      expect(reserved(EA)).toBe(before);
      expect(psql(`select state || ':' || submit_error_code from public.studio_sms_usage_attempts where id = '${b.attempt_id}'`)).toBe("released:not_prepared");
      expect((await rpc("tw4_usage_release_unprepared", { p_attempt_id: b.attempt_id, p_code: "not_prepared" })).data).toMatchObject({ released: false, state: "released" });
      expect((await begin(PA1, { p_source_id: source })).data).toMatchObject({ decision: "replay", state: "released" }); // a retry of the source: not sent
      expect((await rpc("tw4_usage_dispatching", { p_attempt_id: b.attempt_id })).data).toMatchObject({ dispatch: false });
      // marked by another caller first: untouched
      const m = (await begin(PA1)).data as { attempt_id: string };
      expect((await rpc("tw4_usage_dispatching", { p_attempt_id: m.attempt_id })).data).toMatchObject({ dispatch: true });
      expect((await rpc("tw4_usage_release_unprepared", { p_attempt_id: m.attempt_id, p_code: "not_prepared" })).data).toMatchObject({ released: false, state: "submitting" });
    });

    it("a sender revoked or replaced after a reservation: the dispatch marker refuses, releases the reservation, nothing is sent (also for a replay of the same source)", async () => {
      clearSenders([PA1]);
      await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      const source = randomUUID();
      const b = (await begin(PA1, { p_source_id: source })).data as { attempt_id: string; amount_cents: number };
      const before = reserved(EA);
      expect((await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: campaign suspended at Twilio", p_release: false })).error).toBeNull();
      const replay = (await begin(PA1, { p_source_id: source })).data as { decision: string; state: string };
      expect(replay).toMatchObject({ decision: "replay", state: "reserved" }); // the app would now try the marker...
      expect((await rpc("tw4_usage_dispatching", { p_attempt_id: b.attempt_id })).data).toMatchObject({ dispatch: false, state: "released", reason: "sender_not_ready" });
      expect(reserved(EA)).toBe(before - b.amount_cents);
      expect(psql(`select state || ':' || submit_error_code from public.studio_sms_usage_attempts where id = '${b.attempt_id}'`)).toBe("released:sender_not_ready");
      // replaced: a NEW verified number for the location; an attempt reserved for the old one is not sent through the new one
      clearSenders([PA1]);
      const first = await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      const old = (await begin(PA1)).data as { attempt_id: string };
      expect((await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: release the old number", p_release: true })).error).toBeNull();
      await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids({ mg: first.ids.mg, qe: first.ids.qe, bn: first.ids.bn }), brandStep: false });
      expect((await rpc("tw4_usage_dispatching", { p_attempt_id: old.attempt_id })).data).toMatchObject({ dispatch: false, reason: "sender_not_ready" });
    });

    it("a subaccount suspended or replaced: not ready, and a re-verify records why", async () => {
      clearSenders([PA1]);
      const { ids: s, senderId } = await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      aged(`update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = '${EA}'`);
      expect(ready(PA1)).toBe(false);
      expect((await begin(PA1)).error?.code).toBe("TW015");
      expect((await reverify(PA1, senderId, evidenceFor(ACC_A, s))).data).toMatchObject({ outcome: "failed", code: "subaccount_not_active" });
      aged(`update public.studio_sms_twilio_accounts set status = 'active' where legal_entity_id = '${EA}'`);
      expect(ready(PA1)).toBe(false); // the failed verification is the latest decisive one: a fresh verify is required
    });

    it("concurrency: ten markers racing a revoke: every attempt ends either marked (it won the race) or released, and the money matches", async () => {
      clearSenders([PA1]);
      await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      const reservedBefore = reserved(EA);
      const begun = await Promise.all(Array.from({ length: 10 }, () => begin(PA1)));
      const attempts = begun.filter((r) => !r.error).map((r) => r.data as { attempt_id: string; amount_cents: number });
      expect(attempts.length).toBe(10);
      const [marks] = await Promise.all([
        Promise.all(attempts.map((a) => rpc("tw4_usage_dispatching", { p_attempt_id: a.attempt_id }))),
        rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: revoke racing the markers", p_release: false }),
      ]);
      const won = marks.map((m, i) => ((m.data as { dispatch: boolean }).dispatch === true ? attempts[i] : null)).filter((a): a is { attempt_id: string; amount_cents: number } => a !== null);
      const states = psql(`select string_agg(state, ',' order by state) from public.studio_sms_usage_attempts where id in (${attempts.map((a) => `'${a.attempt_id}'`).join(", ")})`).split(",");
      expect(states.every((s) => s === "submitting" || s === "released")).toBe(true);
      expect(states.filter((s) => s === "submitting")).toHaveLength(won.length);
      expect(reserved(EA)).toBe(reservedBefore + won.reduce((sum, a) => sum + a.amount_cents, 0)); // only the winners still hold money
      // after the revoke committed, no further marker is possible
      const late = (await begin(PA1)).error?.code;
      expect(late).toBe("TW015");
    });

    it("concurrency: ten reserved sends, then the sender is revoked: none reaches the provider marker after the revoke", async () => {
      clearSenders([PA1]);
      await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      const reservedBefore = reserved(EA);
      const begun = await Promise.all(Array.from({ length: 10 }, () => begin(PA1)));
      const attempts = begun.filter((r) => !r.error).map((r) => (r.data as { attempt_id: string }).attempt_id);
      expect(attempts.length).toBe(10);
      expect((await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: revoke during sends", p_release: false })).error).toBeNull();
      const marks = await Promise.all(attempts.map((id) => rpc("tw4_usage_dispatching", { p_attempt_id: id })));
      expect(marks.filter((m) => (m.data as { dispatch: boolean }).dispatch === true)).toHaveLength(0);
      expect(reserved(EA)).toBe(reservedBefore); // every reservation of these sends was released
    });
  });

  describe("inbound mapping, tenants, the pilot business, the rollback", () => {
    it("inbound to a subaccount number maps to exactly its location; another subaccount, an unknown number or a released one maps to nothing; a revoked one still maps (STOP)", async () => {
      clearSenders([PA1, PA2, PB1]);
      const a1 = await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      const a2 = await readySender(rpc, aged, { studio: PA2, account: ACC_A, actor: U.padmin, ids: ids({ mg: a1.ids.mg, qe: a1.ids.qe, bn: a1.ids.bn }), brandStep: false });
      const map = async (account: string, mg: string | null, to: string | null) => (await rpc("tw4_inbound_studio_for", { p_account_sid: account, p_messaging_service_sid: mg, p_to_e164: to })).data;
      expect(await map(ACC_A, a1.ids.mg, a1.ids.e164)).toBe(PA1);
      expect(await map(ACC_A, a1.ids.mg, a2.ids.e164)).toBe(PA2); // shared service: the number decides
      expect(await map(ACC_A, a1.ids.mg, null)).toBeNull(); // service only, shared by two locations: ambiguous
      expect(await map(ACC_B, a1.ids.mg, a1.ids.e164)).toBeNull(); // another subaccount
      expect(await map(ACC_A, sid("MG"), a1.ids.e164)).toBe(PA1); // the number decides (unique on the account); a re-recorded service never unroutes STOP      expect(await map(ACC_A, null, "+15125559999")).toBeNull();
      await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: revoked still receives STOP", p_release: false });
      expect(await map(ACC_A, a1.ids.mg, a1.ids.e164)).toBe(PA1);
      await rpc("tw4_sender_revoke", { p_studio_id: PA1, p_actor: U.padmin, p_reason: "fixture: released number no longer maps", p_release: true });
      expect(await map(ACC_A, a1.ids.mg, a1.ids.e164)).toBeNull();
    });

    it("each business's sender is its own: begin for business B never uses business A's sender; the overview is admin-only and shows readiness", async () => {
      clearSenders([PA1, PA2, PB1]);
      await readySender(rpc, aged, { studio: PA1, account: ACC_A, actor: U.padmin, ids: ids() });
      expect((await begin(PB1)).error?.code).toBe("TW015"); // B has no sender of its own
      const view = (await rpc("tw4_sender_overview", { p_actor: U.padmin })).data as Array<Record<string, unknown>>;
      expect(view.find((v) => v.studio_id === PA1)).toMatchObject({ status: "approved", ready: true, verification_outcome: "verified" });
      expect(view.find((v) => v.studio_id === PB1)).toMatchObject({ ready: false });
      expect((await rpc("tw4_sender_overview", { p_actor: U.owner_a })).error?.code).toBe("42501");
    });

    it("the pilot business sends through its verified sender from credit; the $150 pilot ceiling is never used", () => {
      const out = execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], {
        input: `begin; set local session_replication_role = replica; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${EA}', 15000, 'fixture approval reference text ${RUN}', '${U.padmin}'); reset session_replication_role;
                select (public.tw4_usage_begin('manual', gen_random_uuid(), '${PA1}', null, '${PHONE}', 'pilot text', 'manual', null, null, null))->>'decision';
                select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${EA}' and funding = 'pilot';
                rollback;`,
        encoding: "utf8",
      });
      expect(out.split("\n").filter((l) => /^[0-9a-z]+$/.test(l)).slice(-2)).toEqual(["send", "0"]);
    });

    it("the rollback refuses once sender evidence exists", () => {
      expect(Number(psql("select count(*) from public.studio_sms_sender_verifications"))).toBeGreaterThan(0);
      const rollback = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261204090000_twilio_sender_readiness_rollback.sql"), "utf8");
      expect(psqlError(rollback)).toContain("rollback refused");
    });
  });
});
