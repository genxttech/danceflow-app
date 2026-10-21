/**
 * TW-4F R2c-I1 against a REAL schema (R2a, 20261207090000 applied): the ledger wrapper and the resolution command driven through the real
 * `tw4_prov_status` / `tw4_prov_resolve` / `tw4_prov_reopen`. Synthetic fixtures with their own id block, removed afterwards. No provider is involved.
 * LOCAL QA STACK ONLY (skipped unless the variables point at a loopback stack):
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 *   npx vitest run --no-file-parallelism src/lib/sms/provisioning/__tests__/localStack.r2ci1.test.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

import { LedgerError, ProvisioningLedgerStore } from "../provisionLedger";
import { CONFIRM_PHRASE, FEE_RELEASE_MESSAGE, resolveOperation, reopenProvisioning } from "../provisionCommands";

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

const S1 = "a1c10000-0000-4000-8000-00000000000a";
const S2 = "a1c10000-0000-4000-8000-00000000000b";
const E1 = "e1c10000-0000-4000-8000-0000000000a1";
const E2 = "e1c10000-0000-4000-8000-0000000000b1";
const O1 = "01c10000-0000-4000-8000-0000000000a1";
const O2 = "01c10000-0000-4000-8000-0000000000b1";
const OP1 = "c1c10000-0000-4000-8000-0000000000a1"; // studio 1, free, unknown, old
const OP1_FRESH = "c1c10000-0000-4000-8000-0000000000a2"; // studio 1, campaign (fee), unknown, just now
const OP2 = "c1c10000-0000-4000-8000-0000000000b1"; // studio 2, free, unknown, old
const OP2_FEE = "c1c10000-0000-4000-8000-0000000000b2"; // studio 2, campaign (fee), unknown, old: past every 20-minute rule
const ADMIN = "a1c10000-0000-4000-8000-000000000401";
const PLAIN = "a1c10000-0000-4000-8000-000000000101";
const ACC = { 1: `AC${"a1".repeat(16)}`, 2: `AC${"b1".repeat(16)}` };
const DIGEST = "ab".repeat(32);
const STUDIOS = `'${S1}', '${S2}'`;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });

const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_prov_resources where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_operations where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_access where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding where studio_id in (${STUDIOS});
delete from public.studio_sms_twilio_accounts where legal_entity_id in ('${E1}', '${E2}');
delete from public.studio_sms_entity_studios where legal_entity_id in ('${E1}', '${E2}');
delete from public.studio_sms_legal_entities where id in ('${E1}', '${E2}');
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in ('${ADMIN}', '${PLAIN}');
delete from auth.users where email like '%@tw4r2ci1-e2e.test';
commit;`;

const op = (id: string, onboarding: string, studio: string, entity: string, account: string, kind: string, attempt: number, fee: boolean, startedAgo: string) =>
  `('${id}', '${onboarding}', '${studio}', '${entity}', '${account}', '${kind}', ${attempt}, 1, 'unknown_outcome', 'df:fixture:${id.slice(-4)}', '${DIGEST}', ${fee ? "true" : "false"}, ${fee ? "array['campaign_vetting']" : "'{}'::text[]"}, '${ADMIN}', now() - interval '${startedAgo}', 'timeout')`;

const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4r2ci1-e2e.test', now(), now(), now()
    from (values ('${ADMIN}'::uuid, 'padmin'), ('${PLAIN}', 'plain')) u(id, n);
insert into public.profiles (id, platform_role) values ('${ADMIN}', 'platform_admin'), ('${PLAIN}', null) on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values ('${S1}', 'R2CI1 One', 'r2ci1-one', null, 'UTC'), ('${S2}', 'R2CI1 Two', 'r2ci1-two', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${E1}', 'R2CI1 One LLC', '7771', 50000, '${ADMIN}'), ('${E2}', 'R2CI1 Two LLC', '7772', 50000, '${ADMIN}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${S1}', '${E1}', 'founding', '${ADMIN}', 'fixture: business one', now()), ('${S2}', '${E2}', 'founding', '${ADMIN}', 'fixture: business two', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${E1}', '${ACC[1]}', 'df:test:${E1}', 'test', 'active', '${ADMIN}'), ('${E2}', '${ACC[2]}', 'df:test:${E2}', 'test', 'active', '${ADMIN}');
insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) values ('${S1}', true, 'fixture: ledger tests', '${ADMIN}'), ('${S2}', true, 'fixture: ledger tests', '${ADMIN}');
commit;
begin;
set local session_replication_role = replica;
insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at) values
  ('${O1}', '${S1}', 'service_setup', 'R2CI1 One LLC', 'llc', '7771', 1, now()), ('${O2}', '${S2}', 'service_setup', 'R2CI1 Two LLC', 'llc', '7772', 1, now());
insert into public.studio_sms_prov_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, fee_bearing, fee_kinds, started_by, started_at, error_code) values
  ${op(OP1, O1, S1, E1, ACC[1], "messaging_service", 1, false, "3 hours")},
  ${op(OP1_FRESH, O1, S1, E1, ACC[1], "campaign", 1, true, "1 minute")},
  ${op(OP2, O2, S2, E2, ACC[2], "messaging_service", 1, false, "3 hours")},
  ${op(OP2_FEE, O2, S2, E2, ACC[2], "campaign", 1, true, "3 hours")};
commit;`;

describe.skipIf(!enabled)("TW-4F R2c-I1: ledger wrapper and resolution against the real R2a schema", () => {
  let client: SupabaseClient;
  let store: ProvisioningLedgerStore;
  const status = (id: string) => psql(`select status from public.studio_sms_prov_operations where id = '${id}'`);
  const form = (v: Record<string, string>) => {
    const f = new FormData();
    for (const [k, val] of Object.entries(v)) f.set(k, val);
    return f;
  };

  beforeAll(() => {
    expect(psql(`select to_regclass('public.studio_sms_prov_operations') is not null`)).toBe("t");
    psqlFile(FIXTURES);
    client = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    store = new ProvisioningLedgerStore(client);
  });
  afterAll(() => {
    if (enabled) psqlFile(CLEANUP);
  });

  it("platform admin reads only the requested studio's ledger (tenant isolation), parsed from the real function", async () => {
    const one = (await store.status(S1, ADMIN))!;
    expect(one.operations.map((o) => o.id).sort()).toEqual([OP1, OP1_FRESH].sort());
    expect(one.operations.every((o) => o.status === "unknown_outcome")).toBe(true);
    expect(one.operations.find((o) => o.id === OP1_FRESH)).toMatchObject({ feeBearing: true, feeKinds: ["campaign_vetting"] });
    const two = (await store.status(S2, ADMIN))!;
    expect(two.operations.map((o) => o.id).sort()).toEqual([OP2, OP2_FEE].sort());
    expect(await store.status("a1c10000-0000-4000-8000-0000000000ff", ADMIN)).toBeNull();
  });

  it("a non-admin actor is refused by the database for every function (42501), so a wrong session id can never read or write", async () => {
    await expect(store.status(S1, PLAIN)).rejects.toMatchObject({ code: "42501" });
    await expect(store.resolve({ studioId: S1, operationId: OP1, actorId: PLAIN, resolution: "not_created", providerSid: null, note: "attempted by a non admin" })).rejects.toBeInstanceOf(LedgerError);
    await expect(store.reopen(S1, PLAIN, "attempted by a non admin")).rejects.toMatchObject({ code: "42501" });
    expect(status(OP1)).toBe("unknown_outcome");
  });

  it("loadLedgers-style failure: an unknown actor id is refused, not an empty ledger", async () => {
    await expect(store.status(S1, "a1c10000-0000-4000-8000-0000000000fe")).rejects.toMatchObject({ code: "42501" });
  });

  it("cross-studio operation id: studio 1's form naming studio 2's operation is refused and studio 2 is untouched", async () => {
    const r = await resolveOperation(store, ADMIN, form({ studioId: S1, operationId: OP2, resolution: "not_created", note: "Checked the Twilio console: nothing there", confirm: "on" }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not part of this studio/);
    expect(status(OP2)).toBe("unknown_outcome");
  });

  it("a fee operation younger than 20 minutes cannot be declared not created: refused before and (independently) by the database", async () => {
    const r = await resolveOperation(store, ADMIN, form({ studioId: S1, operationId: OP1_FRESH, resolution: "not_created", note: "Checked the Twilio console: nothing there", confirm: "on", phrase: CONFIRM_PHRASE }));
    expect(r.ok).toBe(false);
    // the wrapper refuses a fee release before the database (see the FEE RELEASE test); the database's own 20-minute rule is proven by calling it directly
    const raw = await client.rpc("tw4_prov_resolve", { p_operation_id: OP1_FRESH, p_actor: ADMIN, p_resolution: "not_created", p_provider_sid: null, p_note: "bypassing the pre-check on purpose" });
    expect(raw.error?.code).toBe("22023");
    expect(status(OP1_FRESH)).toBe("unknown_outcome");
  });

  it("FEE RELEASE IS OFF against the real schema: an old fee-bearing unknown operation cannot be released through the command or the wrapper; it stays unknown and its row is untouched", async () => {
    const before = psql(`select status || ':' || coalesce(resolved_by::text, '-') || ':' || fee_bearing::text from public.studio_sms_prov_operations where id = '${OP2_FEE}'`);
    expect(before).toBe("unknown_outcome:-:true");
    const r = await resolveOperation(store, ADMIN, form({ studioId: S2, operationId: OP2_FEE, resolution: "not_created", note: "Checked the Twilio console: nothing there", confirm: "on", phrase: CONFIRM_PHRASE }));
    expect(r).toEqual({ ok: false, message: FEE_RELEASE_MESSAGE });
    await expect(store.resolve({ studioId: S2, operationId: OP2_FEE, actorId: ADMIN, resolution: "not_created", providerSid: null, note: "attempt via the wrapper directly" })).rejects.toMatchObject({ code: "fee_release_disabled" });
    expect(psql(`select status || ':' || coalesce(resolved_by::text, '-') || ':' || fee_bearing::text from public.studio_sms_prov_operations where id = '${OP2_FEE}'`)).toBe(before);
    expect(Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${S2}' and action = 'prov_resolved'`))).toBe(0);
  });

  it("created needs the provider's SID shape; a wrong-kind SID is refused by the command and by the database", async () => {
    const wrong = `MG${"c".repeat(32)}`.replace("MG", "QE"); // a campaign-shaped SID for a Messaging Service operation
    const r = await resolveOperation(store, ADMIN, form({ studioId: S1, operationId: OP1, resolution: "created", providerSid: wrong, note: "Found it in the Twilio console", confirm: "on" }));
    expect(r.ok).toBe(false);
    await expect(store.resolve({ studioId: S1, operationId: OP1, actorId: ADMIN, resolution: "created", providerSid: wrong, note: "bypassing the pre-check on purpose" })).rejects.toMatchObject({ code: "22023" });
    expect(status(OP1)).toBe("unknown_outcome");
  });

  it("a free operation resolved 'not created' closes as abandoned (never 'failed'), is audited, and a replay is refused", async () => {
    const r = await resolveOperation(store, ADMIN, form({ studioId: S1, operationId: OP1, resolution: "not_created", note: "Checked the Twilio console: no service exists", confirm: "on" }));
    expect(r).toMatchObject({ ok: true });
    expect(status(OP1)).toBe("abandoned");
    expect(psql(`select resolved_by::text || ':' || resolution_note from public.studio_sms_prov_operations where id = '${OP1}'`)).toBe(`${ADMIN}:Checked the Twilio console: no service exists`);
    expect(Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${S1}' and action = 'prov_resolved'`))).toBe(1);
    const again = await resolveOperation(store, ADMIN, form({ studioId: S1, operationId: OP1, resolution: "not_created", note: "Checked the Twilio console: no service exists", confirm: "on" }));
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already resolved/);
    expect(Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${S1}' and action = 'prov_resolved'`))).toBe(1);
  });

  it("created on a Messaging Service records the typed SID as a claim and captures nothing", async () => {
    const sid = `MG${"d".repeat(32)}`;
    const r = await resolveOperation(store, ADMIN, form({ studioId: S2, operationId: OP2, resolution: "created", providerSid: sid, note: "Found it in the Twilio console", confirm: "on" }));
    expect(r).toMatchObject({ ok: true });
    expect(psql(`select status || ':' || provider_sid from public.studio_sms_prov_operations where id = '${OP2}'`)).toBe(`succeeded:${sid}`);
  });

  it("reopen is refused (fixed copy) when the onboarding is not in a provisioning exception", async () => {
    const r = await reopenProvisioning(store, ADMIN, form({ studioId: S2, reason: "Corrected and reviewed everything", confirm: "on" }));
    expect(r.ok).toBe(false);
    await expect(store.reopen(S2, ADMIN, "bypassing the pre-check on purpose")).rejects.toMatchObject({ code: "TW030" });
  });
});
