/**
 * TW-4F-1b against a REAL schema: the database-enforced authorization of the irreversible submissions (S11 / T6) and the durable evaluation
 * evidence, using the real `tw4_runner_*` SQL functions (service role, through PostgREST), the real runner and the FAKE Twilio adapter.
 * LOCAL QA STACK ONLY (skipped unless the variables below point at a loopback Supabase stack that has TW-4A, 4A.1, R1, R1.1 and the
 * TW-4F-1b migration applied). Synthetic fixtures with their own ids; no Twilio call is possible.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { saveOnboardingDraft, setPilotAccess, storeEinCiphertext, submitOnboarding } from "@/lib/sms/onboarding/client";
import { encryptEin } from "@/lib/sms/onboarding/ein";
import { validateDraftFields } from "@/lib/sms/onboarding/fields";
import type { IsvConfig } from "../config";
import { FakeIsvAdapter } from "../fake";
import { checkRegistrationStatus, runBrandSubmission, type RunResult } from "../runner";
import { RunnerStoreError, SupabaseRunnerStore } from "../store";
import { LegacyAccountStore } from "./legacyAccountStore";

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

const A = "a5e50000-0000-4000-8000-00000000000a";
const B = "a5e50000-0000-4000-8000-00000000000b";
const C = "a5e50000-0000-4000-8000-00000000000c";
const U = {
  owner_a: "a5e50000-0000-4000-8000-000000000101",
  owner_b: "a5e50000-0000-4000-8000-000000000201",
  owner_c: "a5e50000-0000-4000-8000-000000000301",
  padmin: "a5e50000-0000-4000-8000-000000000401",
};
const PRIMARY = `BU${"e".repeat(32)}`;
const PRIMARY_POLICY = `RN${"4".repeat(32)}`;
const config: IsvConfig = {
  accountSid: `AC${"1".repeat(32)}`, authToken: "t", primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY, secondaryProfilePolicySid: `RN${"2".repeat(32)}`,
  a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
};
const fakeAdapter = () => new FakeIsvAdapter(PRIMARY, { captureSensitive: true, primaryPolicySid: PRIMARY_POLICY });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp: 1983812996 }) : "");
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const userToken = (sub: string) => sign({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
function client(token: string | null, key = anonKey()): SupabaseClient {
  return createClient(URL_, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: token ? { Authorization: `Bearer ${token}` } : {} } });
}
const as = (who: keyof typeof U) => client(userToken(U[who]));
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
/** Runs a statement that is EXPECTED to fail and returns psql's error text (never throws). */
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};

const FIELDS: Record<string, string> = {
  legal_name: "F1B Dance Studio LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: "",
  address_line1: "12 Harbor Way", address_line2: "", city: "Portland", region: "OR", postal_code: "97201",
  rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@tw4f1b-e2e.test", rep_phone: "(503) 555-0123", preferred_area_code: "503",
};

const FIXTURES = `
begin;
delete from public.studio_sms_registrations where studio_id in ('${A}', '${B}', '${C}');
delete from public.studios where id in ('${A}', '${B}', '${C}');
delete from auth.users where email like '%@tw4f1b-e2e.test';
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('${U.owner_a}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_a@tw4f1b-e2e.test', now(), now()),
  ('${U.owner_b}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_b@tw4f1b-e2e.test', now(), now()),
  ('${U.owner_c}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner_c@tw4f1b-e2e.test', now(), now()),
  ('${U.padmin}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin@tw4f1b-e2e.test', now(), now());
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.owner_b}', null), ('${U.owner_c}', null), ('${U.padmin}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  ('${A}', 'TW4F1B E2E Studio A', 'tw4f1b-e2e-a', 'F1B Harbor Dance'), ('${B}', 'TW4F1B E2E Studio B', 'tw4f1b-e2e-b', null), ('${C}', 'TW4F1B E2E Studio C', 'tw4f1b-e2e-c', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${A}', 'studio_owner', true), ('${U.owner_b}', '${B}', 'studio_owner', true), ('${U.owner_c}', '${C}', 'studio_owner', true);
commit;`;
const CLEANUP = `
begin;
delete from public.studio_sms_registrations where studio_id in ('${A}', '${B}', '${C}');
delete from public.studios where id in ('${A}', '${B}', '${C}');
delete from auth.users where email like '%@tw4f1b-e2e.test';
commit;`;

describe.skipIf(!enabled)("TW-4F-1b gate evidence against the local QA stack (real SQL functions, fake Twilio)", () => {
  let store: SupabaseRunnerStore;
  let admin: SupabaseClient;
  let adapter: FakeIsvAdapter;
  let adapterCLast: FakeIsvAdapter | null = null;

  const onboardingId = (studio: string) => psql(`select id from public.studio_sms_onboarding where studio_id = '${studio}' and state <> 'cancelled'`);
  const stepRow = (studio: string, step: string, column: string) =>
    psql(`select coalesce(${column}::text, '') from public.studio_sms_provisioning_steps where studio_id = '${studio}' and step_key = '${step}' order by submission_seq desc limit 1`);
  const count = (sql: string) => Number(psql(sql));
  const confirmations = (studio: string, where = "true") => count(`select count(*) from public.studio_sms_submission_confirmations where studio_id = '${studio}' and ${where}`);
  const audit = (studio: string, action: string) => count(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${studio}' and action = '${action}'`);
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof RunnerStoreError ? error.code : `other:${String(error)}`;
    }
  };
  /** Takes the lease the way a run does, hands it to `fn`, and always releases it. */
  async function withLease<T>(studio: string, owner: string, fn: (id: string) => Promise<T>): Promise<T> {
    const claim = await store.claim(studio, U.padmin, owner, 120, "run");
    try {
      return await fn(claim.onboarding_id);
    } finally {
      await store.release(claim.onboarding_id, owner);
    }
  }
  const evaluateOnly = (studio: string) =>
    runBrandSubmission({ store, adapter, config, studioId: studio, actorId: U.padmin, confirmFee: true, stopAfter: "S10" });

  async function prepare(studio: string, owner: "owner_a" | "owner_b" | "owner_c") {
    await setPilotAccess(as("padmin") as never, studio, true, "F1B local e2e");
    await store.setWindow(studio, U.padmin, 24, "F1B local e2e");
    await saveOnboardingDraft(as(owner) as never, studio, validateDraftFields(FIELDS).fields);
    const encrypted = encryptEin(studio, { digits: "987654321", last4: "4321" });
    await storeEinCiphertext(admin as never, { studioId: studio, actorUserId: U[owner], ciphertext: encrypted.ciphertext, keyId: encrypted.keyId, last4: encrypted.last4 });
    const submitted = await submitOnboarding(as(owner) as never, studio, { authorized: true, accurate: true, opt_in_only: true, fees_terms: true });
    expect(submitted.submitted).toBe(true);
  }

  beforeAll(async () => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
    admin = client(null, serviceKey());
    store = new LegacyAccountStore(admin);
    adapter = fakeAdapter();
    psqlFile(FIXTURES);
    await prepare(A, "owner_a");
    await prepare(B, "owner_b");
    await prepare(C, "owner_c");
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
    } catch {
      /* best effort */
    }
    delete process.env.SMS_EIN_ENCRYPTION_KEY;
  });

  it("the new functions are service-role only and the confirmation table has no API privileges", async () => {
    for (const c of [client(null), as("owner_a"), as("padmin")]) {
      const confirm = await c.rpc("tw4_runner_confirm_submission", { p_onboarding_id: onboardingId(A), p_lease_owner: "x", p_step_key: "S11", p_actor: U.padmin });
      expect(confirm.error?.code).toBe("42501");
      const record = await c.rpc("tw4_runner_record_evaluation", { p_onboarding_id: onboardingId(A), p_lease_owner: "x", p_step_key: "S10", p_verdict: "compliant", p_context: "preverify" });
      expect(record.error?.code).toBe("42501");
      const table = await c.from("studio_sms_submission_confirmations").select("id").limit(1);
      expect(table.error).not.toBeNull();
    }
  });

  it("an evaluation step records its verdict on the ledger row and in the audit trail", async () => {
    const result = await evaluateOnly(A);
    expect(result.stepsRun).toContain("S10");
    expect(stepRow(A, "S10", "status")).toBe("succeeded");
    expect(stepRow(A, "S10", "evaluation_verdict")).toBe("compliant");
    expect(audit(A, "runner_evaluation")).toBeGreaterThanOrEqual(1);
    expect(count(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'runner_evaluation' and note like '%step=S10;verdict=compliant;context=step%'`)).toBe(1);
  });

  it("S11 cannot begin without a confirmation, whoever calls: the database refuses (TW003)", async () => {
    await withLease(A, "lease-1", async (id) => {
      expect(await code(store.beginStep(id, "lease-1", "S11", "df:x", false, null))).toBe("TW003");
      expect(await code(store.beginStep(id, "lease-1", "T6", "df:x", false, null))).toBe("TW003");
    });
    expect(stepRow(A, "S11", "status")).toBe("");
  });

  it("confirmation needs the lease, a platform admin, a submission step and a succeeded compliant evaluation", async () => {
    const id = onboardingId(A);
    expect(await code(store.confirmSubmission(id, "nobody", "S11", U.padmin))).toBe("55P03");
    await withLease(A, "lease-2", async (onb) => {
      expect(await code(store.confirmSubmission(onb, "lease-2", "S11", U.owner_a))).toBe("42501");
      expect(await code(store.confirmSubmission(onb, "lease-2", "S10" as never, U.padmin))).toBe("22023");
      expect(await code(store.confirmSubmission(onb, "lease-2", "T6", U.padmin))).toBe("TW002"); // T6 belongs to profile_review; T5 has not run
    });
    expect(confirmations(A)).toBe(0);
  });

  it("a row without a recorded compliant verdict (written before verdicts existed) cannot authorize a submission", async () => {
    psql(`set session_replication_role = replica; update public.studio_sms_provisioning_steps set evaluation_verdict = null where studio_id = '${A}' and step_key = 'S10'`);
    await withLease(A, "lease-3", async (onb) => {
      expect(await code(store.confirmSubmission(onb, "lease-3", "S11", U.padmin))).toBe("TW002");
    });
    psql(`set session_replication_role = replica; update public.studio_sms_provisioning_steps set evaluation_verdict = 'noncompliant' where studio_id = '${A}' and step_key = 'S10'`);
    await withLease(A, "lease-3", async (onb) => {
      expect(await code(store.confirmSubmission(onb, "lease-3", "S11", U.padmin))).toBe("TW002");
    });
    psql(`set session_replication_role = replica; update public.studio_sms_provisioning_steps set evaluation_verdict = 'compliant' where studio_id = '${A}' and step_key = 'S10'`);
    expect(confirmations(A)).toBe(0);
  });

  it("an evaluation followed by a needs_info / exception transition is stale: a new generation is required (TW002)", async () => {
    await evaluateOnly(B);
    expect(stepRow(B, "S10", "evaluation_verdict")).toBe("compliant");
    psql(`insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, action, from_state, to_state, note)
          values ('${B}', '${onboardingId(B)}', 'system', 'state_changed', 'submitted_for_checks', 'exception', 'test: sent back after the evaluation')`);
    await withLease(B, "lease-b", async (onb) => {
      expect(await code(store.confirmSubmission(onb, "lease-b", "S11", U.padmin))).toBe("TW002");
    });
    expect(confirmations(B)).toBe(0);
  });

  it("a confirmation is recorded with who and when, bound to its lease, usable once, and expires", async () => {
    await withLease(A, "lease-4", async (onb) => {
      expect(await code(store.confirmSubmission(onb, "lease-4", "S11", U.padmin))).toBe("ok");
    });
    expect(confirmations(A, "step_key = 'S11' and consumed_at is null")).toBe(1);
    expect(psql(`select confirmed_by from public.studio_sms_submission_confirmations where studio_id = '${A}' limit 1`)).toBe(U.padmin);
    expect(audit(A, "runner_submission_confirmed")).toBe(1);

    // another lease cannot use it
    await withLease(A, "lease-other", async (onb) => {
      expect(await code(store.beginStep(onb, "lease-other", "S11", "df:x", false, null))).toBe("TW003");
    });
    expect(confirmations(A, "consumed_at is null")).toBe(1);

    // the same lease uses it once (the step begins), and a second begin (reconcile / retry) needs a new confirmation
    await withLease(A, "lease-4", async (onb) => {
      expect(await code(store.beginStep(onb, "lease-4", "S11", "df:x", false, null))).toBe("ok");
      expect(await code(store.beginStep(onb, "lease-4", "S11", "df:x", false, null))).toBe("TW003");
      await store.finishStep(onb, "lease-4", "S11", { status: "failed", errorCode: "test" });
    });
    expect(confirmations(A, "consumed_at is not null")).toBe(1);

    // an old confirmation is useless: 15 minutes
    await withLease(A, "lease-5", async (onb) => {
      expect(await code(store.confirmSubmission(onb, "lease-5", "S11", U.padmin))).toBe("ok");
      psql(`set session_replication_role = replica; update public.studio_sms_submission_confirmations set confirmed_at = now() - interval '16 minutes' where studio_id = '${A}' and consumed_at is null`);
      expect(await code(store.beginStep(onb, "lease-5", "S11", "df:x", false, null))).toBe("TW003");
    });
  });

  it("evaluation records: only an open S10 / T5 row takes a verdict; values and contexts are checked; a re-check is audit-only", async () => {
    await withLease(A, "lease-6", async (onb) => {
      expect(await code(store.recordEvaluation(onb, "lease-6", "S10", "compliant", "step"))).toBe("22023"); // S10 is succeeded: closed
      expect(await code(store.recordEvaluation(onb, "lease-6", "T5", "compliant", "step"))).toBe("22023"); // T5 does not exist yet
      expect(await code(store.recordEvaluation(onb, "lease-6", "S10", "great" as never, "step"))).toBe("22023");
      expect(await code(store.recordEvaluation(onb, "lease-6", "S10", "compliant", "later" as never))).toBe("22023");
      expect(await code(store.recordEvaluation(onb, "lease-6", "S11" as never, "compliant", "preverify"))).toBe("22023");
      const before = audit(A, "runner_evaluation");
      expect(await code(store.recordEvaluation(onb, "lease-6", "S10", "noncompliant", "preverify"))).toBe("ok");
      expect(audit(A, "runner_evaluation")).toBe(before + 1);
      expect(stepRow(A, "S10", "evaluation_verdict")).toBe("compliant"); // a re-check never rewrites the step's own verdict
    });
  });

  it("confirmations are evidence: they cannot be edited, deleted or consumed twice", () => {
    expect(psqlError(`update public.studio_sms_submission_confirmations set confirmed_by = '${U.owner_a}' where studio_id = '${A}'`)).toContain("cannot be edited");
    expect(psqlError(`delete from public.studio_sms_submission_confirmations where studio_id = '${A}'`)).toContain("are not deleted");
    expect(psqlError(`update public.studio_sms_submission_confirmations set consumed_at = now() where studio_id = '${A}' and consumed_at is not null`)).toContain("consumed once");
    expect(psqlError(`update public.studio_sms_provisioning_steps set evaluation_verdict = 'compliant' where studio_id = '${A}' and step_key = 'S1'`)).toContain("verdict of a succeeded step cannot change");
    expect(psqlError(`set session_replication_role = replica; update public.studio_sms_provisioning_steps set evaluation_verdict = 'compliant' where studio_id = '${A}' and step_key = 'S1'`)).toContain("studio_sms_provisioning_steps_verdict_steps"); // only S10 / T5 can carry a verdict
  });

  it("the status function reports verdicts, confirmations and recent evaluation events to a platform admin only", async () => {
    const status = await store.status(A, U.padmin);
    expect(status?.steps.find((s) => s.step_key === "S10")).toMatchObject({ status: "succeeded", evaluation_verdict: "compliant" });
    expect(status?.confirmations?.length).toBeGreaterThanOrEqual(2);
    expect(status?.confirmations?.every((c) => typeof c.confirmed_by === "string" && typeof c.consumed === "boolean")).toBe(true);
    expect((status?.evaluations ?? []).some((e) => e.note.includes("step=S10;verdict=compliant;context=step"))).toBe(true);
    expect(await code(store.status(A, U.owner_a))).toBe("42501");
  });

  it("the admin journey through the real runner: evaluate, confirm the profile, confirm the trust product; the database holds the trail", async () => {
    const before = { conf: confirmations(A), preverify: count(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'runner_evaluation' and note like '%context=preverify%'`) };
    const pass = (confirmSubmit: ("S11" | "T6")[], confirmFee = true) =>
      runBrandSubmission({ store, adapter, config, studioId: A, actorId: U.padmin, confirmFee, confirmSubmit });
    const unconfirmed = await pass([]);
    expect(unconfirmed.detail).toBe("S11");
    expect(adapter.count("submitCustomerProfile")).toBe(0);
    const first = await pass(["S11"]);
    expect(first.detail).toBe("T6");
    expect(adapter.count("submitCustomerProfile")).toBe(1);
    expect(stepRow(A, "T5", "evaluation_verdict")).toBe("compliant");
    expect(adapter.count("submitTrustProduct")).toBe(0);
    const second = await pass(["T6"]);
    expect(second.outcome).toBe("brand_submitted");
    expect(adapter.count("submitTrustProduct")).toBe(1);
    expect(adapter.count("createBrand")).toBe(1);
    // two new confirmations (S11, T6), both consumed; re-checks audited
    expect(confirmations(A) - before.conf).toBe(2);
    expect(confirmations(A, "consumed_at is null and confirmed_at > now() - interval '15 minutes'")).toBe(0);
    expect(count(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'runner_evaluation' and note like '%context=preverify%'`) - before.preverify).toBe(2);
    expect(count(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${A}' and status = 'succeeded'`)).toBe(18);
  });

  it("a second studio (B), whose evaluation went stale, still cannot be submitted by the runner even when confirmed", async () => {
    const adapterB = fakeAdapter();
    const result = await runBrandSubmission({ store, adapter: adapterB, config, studioId: B, actorId: U.padmin, confirmFee: true, confirmSubmit: ["S11", "T6"] });
    expect(["exception", "needs_info", "not_runnable"]).toContain(result.outcome);
    expect(adapterB.count("submitCustomerProfile")).toBe(0);
    expect(confirmations(B)).toBe(0);
  });

  it("an evaluation step can only succeed with a compliant verdict; a re-begun step loses its old verdict; a succeeded verdict is frozen (studio C)", async () => {
    await withLease(C, "lease-c1", async (onb) => {
      expect(await code(store.beginStep(onb, "lease-c1", "S10", "df:c", false, null))).toBe("ok");
      const sid = `EL${"c".repeat(32)}`;
      expect(await code(store.finishStep(onb, "lease-c1", "S10", { status: "succeeded", providerSid: sid }))).toBe("22023"); // no verdict yet
      await store.recordEvaluation(onb, "lease-c1", "S10", "noncompliant", "step");
      expect(await code(store.finishStep(onb, "lease-c1", "S10", { status: "succeeded", providerSid: sid }))).toBe("22023"); // not compliant
      await store.finishStep(onb, "lease-c1", "S10", { status: "failed", errorCode: "noncompliant" });
      expect(stepRow(C, "S10", "evaluation_verdict")).toBe("noncompliant");
      expect(await code(store.beginStep(onb, "lease-c1", "S10", "df:c", false, null))).toBe("ok"); // begun again
      expect(stepRow(C, "S10", "evaluation_verdict")).toBe(""); // the old verdict is gone
      await store.recordEvaluation(onb, "lease-c1", "S10", "compliant", "step");
      expect(await code(store.finishStep(onb, "lease-c1", "S10", { status: "succeeded", providerSid: sid }))).toBe("ok");
    });
    expect(psqlError(`update public.studio_sms_provisioning_steps set evaluation_verdict = 'noncompliant' where studio_id = '${C}' and step_key = 'S10'`)).toContain("verdict of a succeeded step cannot change");
  });

  it("the submission state, a missing finish time and a verdict changed after the confirmation are all refused (studio C)", async () => {
    // wrong state: T6 belongs to profile_review (and T5 has not even run)
    await withLease(C, "lease-c2", async (onb) => {
      expect(await code(store.confirmSubmission(onb, "lease-c2", "T6", U.padmin))).toBe("TW002");
    });
    // a succeeded evaluation with no finish time is unverified
    psql(`set session_replication_role = replica; update public.studio_sms_provisioning_steps set finished_at = null where studio_id = '${C}' and step_key = 'S10'`);
    await withLease(C, "lease-c3", async (onb) => {
      expect(await code(store.confirmSubmission(onb, "lease-c3", "S11", U.padmin))).toBe("TW002");
    });
    psql(`set session_replication_role = replica; update public.studio_sms_provisioning_steps set finished_at = now() where studio_id = '${C}' and step_key = 'S10'`);
    // a valid confirmation, then the evidence disappears before the step begins: the database re-checks at begin and keeps the confirmation unused
    await withLease(C, "lease-c4", async (onb) => {
      expect(await code(store.confirmSubmission(onb, "lease-c4", "S11", U.padmin))).toBe("ok");
      psql(`set session_replication_role = replica; update public.studio_sms_provisioning_steps set evaluation_verdict = null where studio_id = '${C}' and step_key = 'S10'`);
      expect(await code(store.beginStep(onb, "lease-c4", "S11", "df:c", false, null))).toBe("TW002");
      psql(`set session_replication_role = replica; update public.studio_sms_provisioning_steps set evaluation_verdict = 'compliant' where studio_id = '${C}' and step_key = 'S10'`);
    });
    expect(confirmations(C, "consumed_at is null")).toBe(1);
    expect(stepRow(C, "S11", "status")).toBe("");
  });

  it("through the runner, a legacy evaluation sends the setup back to the owner; resubmitting starts a fresh generation that proceeds (studio C)", async () => {
    psql(`set session_replication_role = replica; update public.studio_sms_provisioning_steps set evaluation_verdict = null where studio_id = '${C}' and step_key = 'S10'`);
    const adapterC = fakeAdapter();
    const result = await runBrandSubmission({ store, adapter: adapterC, config, studioId: C, actorId: U.padmin, confirmFee: true, confirmSubmit: ["S11", "T6"] });
    expect(result.outcome).toBe("needs_info");
    expect(result.detail).toBe("S11:evaluation_stale");
    expect(adapterC.count("submitCustomerProfile")).toBe(0);
    expect(psql(`select state from public.studio_sms_onboarding where studio_id = '${C}' and state <> 'cancelled'`)).toBe("needs_info");
    // the owner presses submit again (nothing to edit): a new generation, a fresh evaluation, and the run stops for review
    const resubmitted = await submitOnboarding(as("owner_c") as never, C, { authorized: true, accurate: true, opt_in_only: true, fees_terms: true });
    expect(resubmitted.submitted).toBe(true);
    const adapterC2 = fakeAdapter();
    adapterCLast = adapterC2;
    const next = await runBrandSubmission({ store, adapter: adapterC2, config, studioId: C, actorId: U.padmin, confirmFee: true, confirmSubmit: ["S11", "T6"] });
    expect(next.detail).toBe("S11:review");
    expect(stepRow(C, "S10", "evaluation_verdict")).toBe("compliant");
    expect(adapterC2.count("submitCustomerProfile")).toBe(0);
  });

  it("the read-only status check against the real database: it observes, and a rejected profile sends the setup to a human (studio C)", async () => {
    expect(adapterCLast).not.toBeNull();
    const fake = adapterCLast as unknown as FakeIsvAdapter;
    const profileSid = stepRow(C, "S1", "provider_sid");
    const before = fake.calls.length;
    const observed = await checkRegistrationStatus({ store, adapter: fake, studioId: C, actorId: U.padmin });
    expect(observed.outcome).toBe("status_checked");
    expect(observed.detail).toBe("profile=draft");
    expect(fake.calls.slice(before).map((call) => call.method)).toEqual(["getCustomerProfile"]);
    expect(psql(`select state from public.studio_sms_onboarding where studio_id = '${C}' and state <> 'cancelled'`)).toBe("submitted_for_checks");
    fake.setProfileStatus(profileSid, "twilio-rejected");
    const rejected = await checkRegistrationStatus({ store, adapter: fake, studioId: C, actorId: U.padmin });
    expect(rejected.outcome).toBe("exception");
    expect(rejected.detail).toContain("profile_rejected");
    expect(psql(`select state || ':' || coalesce(last_error_code, '') from public.studio_sms_onboarding where studio_id = '${C}' and state <> 'cancelled'`)).toBe("exception:profile_rejected");
    expect(count(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${C}' and action = 'state_changed' and to_state = 'exception'`)).toBeGreaterThanOrEqual(1);
    expect(fake.count("submitCustomerProfile")).toBe(0);
  });

  it("the status shows only the current attempt's evaluation events; TRUNCATE and the older rollbacks are refused while this migration is applied", async () => {
    const status = await store.status(A, U.padmin);
    const seq = status!.submission_seq;
    psql(`insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, action, from_state, to_state, step_key, note)
          values ('${A}', '${onboardingId(A)}', 'system', 'runner_evaluation', 'x', 'x', 'S10', 'step=S10;verdict=compliant;context=step;seq=${seq + 99}')`);
    const again = await store.status(A, U.padmin);
    expect((again?.evaluations ?? []).every((e) => e.note.endsWith(`seq=${seq}`))).toBe(true);
    expect(psqlError("truncate public.studio_sms_submission_confirmations")).toContain("are not deleted");
    for (const file of ["20261119092100_twilio_tw4_r1_1_window_and_sid_guards_rollback.sql", "20261119092000_twilio_tw4_r1_brand_runner_rollback.sql"]) {
      const script = readFileSync(join(__dirname, "../../../supabase/migrations/rollback", file), "utf8");
      let error = "";
      try {
        psqlFile(script);
      } catch (e) {
        error = String((e as { stderr?: Buffer | string }).stderr ?? e);
      }
      expect(error, file).toContain("rollback refused: TW-4F-1b");
    }
    expect(count("select count(*) from pg_proc where proname like 'tw4_runner_%'")).toBe(14);
  });

  it("the rollback script refuses once confirmations or evaluation evidence exist, and drops nothing", () => {
    const rollback = readFileSync(join(__dirname, "../../../supabase/migrations/rollback/20261120090000_twilio_tw4f1b_gate_evidence_rollback.sql"), "utf8");
    let error = "";
    try {
      psqlFile(rollback);
    } catch (e) {
      error = String((e as { stderr?: Buffer | string }).stderr ?? e);
    }
    expect(error).toContain("rollback refused");
    expect(count("select count(*) from pg_proc where proname in ('tw4_runner_confirm_submission', 'tw4_runner_record_evaluation')")).toBe(2);
  });

  it("the run result type the journey relied on is the production one", () => {
    const sample: RunResult = { outcome: "waiting_submission_confirmation", stepsRun: [], detail: "S11" };
    expect(sample.outcome).toBe("waiting_submission_confirmation");
  });
});
