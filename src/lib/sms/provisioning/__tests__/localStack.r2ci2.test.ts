/**
 * TW-4F R2c-I2 (20261210090000) against a REAL schema: `get_studio_sms_provisioning`, called through PostgREST with real signed user JWTs (the same path the
 * app uses), for an owner, an admin, front desk, another studio's owner, an unrelated user, the anonymous role, the service role and a platform admin;
 * pilot switch off; every status mapping; redaction; and that no identifier ever leaves. Synthetic fixtures, removed afterwards. No provider is involved.
 * LOCAL QA STACK ONLY (skipped unless the variables point at a loopback stack with migrations through 20261210090000 applied).
 * NEVER call the function as anon/service_role here: on this local Postgres build a permission-denied call of a revoked function can segfault the whole server.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 *   npx vitest run --no-file-parallelism src/lib/sms/provisioning/__tests__/localStack.r2ci2.test.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

import { getOwnerProvisioning } from "../ownerRead";

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

const S1 = "a2c20000-0000-4000-8000-00000000000a"; // pilot on
const S2 = "a2c20000-0000-4000-8000-00000000000b"; // pilot on, another business
const S3 = "a2c20000-0000-4000-8000-00000000000c"; // pilot OFF
const E1 = "e2c20000-0000-4000-8000-0000000000a1";
const E2 = "e2c20000-0000-4000-8000-0000000000b1";
const O1 = "02c20000-0000-4000-8000-0000000000a1";
const O2 = "02c20000-0000-4000-8000-0000000000b1";
const U = {
  owner1: "a2c20000-0000-4000-8000-000000000101",
  admin1: "a2c20000-0000-4000-8000-000000000102",
  front1: "a2c20000-0000-4000-8000-000000000103",
  owner2: "a2c20000-0000-4000-8000-000000000201",
  owner3: "a2c20000-0000-4000-8000-000000000301",
  padmin: "a2c20000-0000-4000-8000-000000000401",
  plain: "a2c20000-0000-4000-8000-000000000501",
};
const ACC = { 1: `AC${"a2".repeat(16)}`, 2: `AC${"b2".repeat(16)}` };
const DIGEST = "cd".repeat(32);
const STUDIOS = `'${S1}', '${S2}', '${S3}'`;
const USERS = Object.values(U).map((u) => `'${u}'`).join(", ");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const exp = 1983812996;
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp }) : "");
const userKey = (id: string) => sign({ iss: "supabase-demo", sub: id, role: "authenticated", aud: "authenticated", exp });
const asUser = (id: string): SupabaseClient => createClient(URL_, anonKey(), { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${userKey(id)}` } } });
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
delete from public.profiles where id in (${USERS});
delete from auth.users where email like '%@tw4r2ci2-e2e.test';
commit;`;

const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4r2ci2-e2e.test', now(), now(), now()
    from (values ('${U.owner1}'::uuid, 'owner1'), ('${U.admin1}', 'admin1'), ('${U.front1}', 'front1'), ('${U.owner2}', 'owner2'), ('${U.owner3}', 'owner3'), ('${U.padmin}', 'padmin'), ('${U.plain}', 'plain')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner1}', null), ('${U.admin1}', null), ('${U.front1}', null), ('${U.owner2}', null), ('${U.owner3}', null), ('${U.padmin}', 'platform_admin'), ('${U.plain}', null)
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values ('${S1}', 'R2CI2 One', 'r2ci2-one', null, 'UTC'), ('${S2}', 'R2CI2 Two', 'r2ci2-two', null, 'UTC'), ('${S3}', 'R2CI2 Three', 'r2ci2-three', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner1}', '${S1}', 'studio_owner', true), ('${U.admin1}', '${S1}', 'studio_admin', true), ('${U.front1}', '${S1}', 'front_desk', true),
  ('${U.owner2}', '${S2}', 'studio_owner', true), ('${U.owner3}', '${S3}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${E1}', 'R2CI2 One LLC', '6661', 50000, '${U.padmin}'), ('${E2}', 'R2CI2 Two LLC', '6662', 50000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${S1}', '${E1}', 'founding', '${U.padmin}', 'fixture: business one', now()), ('${S2}', '${E2}', 'founding', '${U.padmin}', 'fixture: business two', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${E1}', '${ACC[1]}', 'df:test:${E1}', 'test', 'active', '${U.padmin}'), ('${E2}', '${ACC[2]}', 'df:test:${E2}', 'test', 'active', '${U.padmin}');
insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) values ('${S1}', true, 'fixture', '${U.padmin}'), ('${S2}', true, 'fixture', '${U.padmin}');
commit;
begin;
set local session_replication_role = replica;
insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at) values
  ('${O1}', '${S1}', 'campaign_pending', 'R2CI2 One LLC', 'llc', '6661', 1, now()), ('${O2}', '${S2}', 'campaign_pending', 'R2CI2 Two LLC', 'llc', '6662', 1, now());
commit;`;

let counter = 0;
type Scenario = { kind: "campaign" | "messaging_service"; op: string; res?: string | null; failure?: string; superseded?: boolean; attempt?: number };
function setOps(studio: string, onboarding: string, entity: string, account: string, scenarios: Scenario[]) {
  const rows = scenarios.map((s) => {
    counter += 1;
    const id = `c2c20000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    const sid = `${s.kind === "campaign" ? "QE" : "MG"}${counter.toString(16).padStart(32, "0")}`;
    const hasSid = s.op === "succeeded";
    const op = `('${id}', '${onboarding}', '${studio}', '${entity}', '${account}', '${s.kind}', ${s.attempt ?? 1}, 1, '${s.op}', 'df:fixture:${counter}', '${DIGEST}', ${s.kind === "campaign"}, ${s.kind === "campaign" ? "array['campaign_vetting']" : "'{}'::text[]"}, '${U.padmin}', now(), ${s.op === "unknown_outcome" ? "'timeout'" : "null"}, ${hasSid ? `'${sid}'` : "null"}, ${s.superseded ? "now()" : "null"}, 'internal-detail-must-not-leak')`;
    const res = s.res
      ? `('${id}', '${entity}', '${studio}', '${account}', '${s.kind}', '${sid}', ${s.res === "verified" || s.res === "pending" || s.res === "failed" ? "'MG" + "9".repeat(32) + "'" : "null"}, null, null, '${s.res}', null, 'IN_PROGRESS', ${s.failure ? `$q$${s.failure}$q$` : "null"}, 'provider_read', '${DIGEST}', now() - interval '5 minutes')`
      : null;
    return { op, res };
  });
  psqlFile(`begin; set local session_replication_role = replica;
    delete from public.studio_sms_prov_resources where studio_id = '${studio}'; delete from public.studio_sms_prov_operations where studio_id = '${studio}';
    ${rows.length ? `insert into public.studio_sms_prov_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, fee_bearing, fee_kinds, started_by, started_at, error_code, provider_sid, superseded_at, error_detail_sanitized) values ${rows.map((r) => r.op).join(", ")};` : ""}
    ${rows.filter((r) => r.res).length ? `insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, brand_sid, use_case, status, mismatch_code, provider_status, failure_reasons, source, evidence_digest, observed_at) values ${rows.filter((r) => r.res).map((r) => r.res).join(", ")};` : ""}
    commit;`);
}

describe.skipIf(!enabled)("TW-4F R2c-I2: get_studio_sms_provisioning (real schema, real JWTs)", () => {
  const call = async (client: SupabaseClient, studio: string) => (await client.rpc("get_studio_sms_provisioning", { p_studio_id: studio })) as { data: Record<string, unknown> | null; error: { code?: string } | null };
  const campaign = async (client: SupabaseClient, studio = S1) => ((await call(client, studio)).data as { campaign: { status: string; rejection_summary: string | null; checked_at: string | null }; messaging_service: { status: string } });

  beforeAll(() => {
    expect(psql(`select to_regprocedure('public.get_studio_sms_provisioning(uuid)') is not null`)).toBe("t");
    psqlFile(FIXTURES);
    setOps(S1, O1, E1, ACC[1], []);
  });
  afterAll(() => {
    if (enabled) psqlFile(CLEANUP);
  });

  it("authorization matrix: owner, admin and platform admin read; front desk, another studio's owner, an unrelated user and an identity-less token are refused", async () => {
    for (const ok of [U.owner1, U.admin1, U.padmin]) {
      const r = await call(asUser(ok), S1);
      expect(r.error, `user ${ok}`).toBeNull();
      expect(r.data).toMatchObject({ available: true });
    }
    for (const no of [U.front1, U.owner2, U.owner3, U.plain]) {
      const r = await call(asUser(no), S1);
      expect(r.error?.code, `user ${no}`).toBe("42501");
      expect(r.data).toBeNull();
    }
    // A signed-in role token without a user (no sub) has no identity: refused by the function itself. The anon and service roles are proven refused by the
    // privilege check in the last test, NOT by calling the function as those roles: calling a revoked function through PostgREST segfaults this local Postgres build
    // (known local-only quirk, see the R2c-I2 notes), which would take the shared QA database down for every other session.
    const noSub = createClient(URL_, anonKey(), { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${sign({ iss: "supabase-demo", role: "authenticated", aud: "authenticated", exp })}` } } });
    const n = await call(noSub, S1);
    expect(n.data).toBeNull();
    expect(n.error?.code).toBe("42501");
  });

  it("tenant isolation: an owner reads only their own studio; naming another studio (or a made-up one) is refused", async () => {
    const owner1 = asUser(U.owner1);
    expect((await call(owner1, S2)).error?.code).toBe("42501");
    expect((await call(owner1, "a2c20000-0000-4000-8000-0000000000ff")).error?.code).toBe("42501");
    expect((await call(asUser(U.owner2), S1)).error?.code).toBe("42501");
    expect((await call(asUser(U.owner2), S2)).error).toBeNull();
  });

  it("an inactive role grants nothing", async () => {
    psql(`update public.user_studio_roles set active = false where user_id = '${U.admin1}' and studio_id = '${S1}'`);
    try {
      expect((await call(asUser(U.admin1), S1)).error?.code).toBe("42501");
    } finally {
      psql(`update public.user_studio_roles set active = true where user_id = '${U.admin1}' and studio_id = '${S1}'`);
    }
  });

  it("pilot switch off: the page does not exist for the studio (available false, nothing else)", async () => {
    const r = await call(asUser(U.owner3), S3);
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ available: false });
  });

  it("no ledger rows: not started", async () => {
    setOps(S1, O1, E1, ACC[1], []);
    expect(await campaign(asUser(U.owner1))).toMatchObject({ campaign: { status: "not_started" }, messaging_service: { status: "not_started" } });
  });

  it("campaign mapping follows PROVIDER EVIDENCE: a submission response alone is never 'approved' or even 'submitted'", async () => {
    const owner = asUser(U.owner1);
    const status = async (s: Scenario[]) => {
      setOps(S1, O1, E1, ACC[1], s);
      return (await campaign(owner)).campaign.status;
    };
    expect(await status([{ kind: "campaign", op: "in_flight" }])).toBe("preparing");
    expect(await status([{ kind: "campaign", op: "unknown_outcome" }])).toBe("preparing");
    expect(await status([{ kind: "campaign", op: "succeeded", res: null }])).toBe("preparing"); // accepted response / admin claim, no provider read yet
    expect(await status([{ kind: "campaign", op: "succeeded", res: "pending" }])).toBe("pending");
    expect(await status([{ kind: "campaign", op: "succeeded", res: "verified" }])).toBe("approved");
    expect(await status([{ kind: "campaign", op: "succeeded", res: "failed", failure: "Opt-in unclear" }])).toBe("rejected");
    expect(await status([{ kind: "campaign", op: "succeeded", res: "mismatch" }])).toBe("attention");
    expect(await status([{ kind: "campaign", op: "failed" }])).toBe("attention");
    expect(await status([{ kind: "campaign", op: "abandoned" }])).toBe("attention");
  });

  it("a superseded attempt is ignored; the newest live attempt wins", async () => {
    setOps(S1, O1, E1, ACC[1], [
      { kind: "campaign", op: "succeeded", res: "failed", failure: "old problem", superseded: true, attempt: 1 },
      { kind: "campaign", op: "succeeded", res: "pending", attempt: 2 },
    ]);
    expect((await campaign(asUser(U.owner1))).campaign.status).toBe("pending");
  });

  it("Messaging Service mapping", async () => {
    const owner = asUser(U.owner1);
    const status = async (s: Scenario) => {
      setOps(S1, O1, E1, ACC[1], [s]);
      return (await campaign(owner)).messaging_service.status;
    };
    expect(await status({ kind: "messaging_service", op: "in_flight" })).toBe("in_progress");
    expect(await status({ kind: "messaging_service", op: "unknown_outcome" })).toBe("in_progress");
    expect(await status({ kind: "messaging_service", op: "succeeded", res: null })).toBe("in_progress");
    expect(await status({ kind: "messaging_service", op: "succeeded", res: "ready" })).toBe("ready");
    expect(await status({ kind: "messaging_service", op: "succeeded", res: "mismatch" })).toBe("attention");
    expect(await status({ kind: "messaging_service", op: "failed" })).toBe("attention");
  });

  it("rejection text is redacted and bounded in the database; checked_at only when a provider read exists", async () => {
    const dirty = `Rejected: see QE${"a".repeat(32)} at https://console.twilio.test/x contact a.b@c.io or 5035550123. ${"z".repeat(300)}`; // the table allows 500 characters; the function returns at most 200
    setOps(S1, O1, E1, ACC[1], [{ kind: "campaign", op: "succeeded", res: "failed", failure: dirty }]);
    const c = (await campaign(asUser(U.owner1))).campaign;
    expect(c.rejection_summary).not.toMatch(/QE[0-9a-f]{32}|https|@|5035550123/);
    expect(c.rejection_summary).toContain("[id]");
    expect(c.rejection_summary!.length).toBeLessThanOrEqual(200);
    expect(c.checked_at).not.toBeNull();
    setOps(S1, O1, E1, ACC[1], [{ kind: "campaign", op: "unknown_outcome" }]);
    expect((await campaign(asUser(U.owner1))).campaign).toMatchObject({ rejection_summary: null, checked_at: null });
  });

  it("nothing identifying ever leaves: no SID, account, operation id, error code or detail, in any state", async () => {
    const states: Scenario[][] = [
      [{ kind: "campaign", op: "unknown_outcome" }],
      [{ kind: "campaign", op: "succeeded", res: "verified" }, { kind: "messaging_service", op: "succeeded", res: "ready" }],
      [{ kind: "campaign", op: "succeeded", res: "failed", failure: `bad QE${"a".repeat(32)}` }],
      [{ kind: "campaign", op: "failed" }],
    ];
    for (const s of states) {
      setOps(S1, O1, E1, ACC[1], s);
      const raw = JSON.stringify((await call(asUser(U.owner1), S1)).data);
      expect(raw).not.toMatch(/\b(AC|MG|QE|BN|PN)[0-9a-fA-F]{32}\b/);
      expect(raw).not.toMatch(/c2c20000-|internal-detail|timeout|error|fee|vetting|account/i);
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["available", "campaign", "messaging_service"]);
    }
  });

  it("another studio's rows never appear in this studio's answer", async () => {
    setOps(S2, O2, E2, ACC[2], [{ kind: "campaign", op: "succeeded", res: "verified" }]);
    setOps(S1, O1, E1, ACC[1], []);
    expect((await campaign(asUser(U.owner1), S1)).campaign.status).toBe("not_started");
    expect((await campaign(asUser(U.owner2), S2)).campaign.status).toBe("approved");
  });

  it("a cancelled onboarding's old operations are not shown for a new one", async () => {
    setOps(S1, O1, E1, ACC[1], [{ kind: "campaign", op: "succeeded", res: "verified" }]);
    psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_onboarding set state = 'cancelled' where id = '${O1}'; commit;`);
    try {
      expect((await campaign(asUser(U.owner1))).campaign.status).toBe("not_started");
    } finally {
      psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_onboarding set state = 'campaign_pending' where id = '${O1}'; commit;`);
    }
  });

  it("the app wrapper returns parsed facts from the real answer, and null for a refused caller", async () => {
    setOps(S1, O1, E1, ACC[1], [{ kind: "campaign", op: "succeeded", res: "pending" }, { kind: "messaging_service", op: "succeeded", res: "ready" }]);
    expect(await getOwnerProvisioning(asUser(U.owner1), S1)).toEqual({ campaign: { status: "pending", rejectionSummary: null }, messagingService: { status: "ready" } });
    expect(await getOwnerProvisioning(asUser(U.owner2), S1)).toBeNull();
    expect(await getOwnerProvisioning(asUser(U.front1), S1)).toBeNull();
  });

  it("privileges: only the authenticated role can execute; the function is a security-definer read", () => {
    expect(psql(`select has_function_privilege('anon','public.get_studio_sms_provisioning(uuid)','EXECUTE')::text || ',' || has_function_privilege('service_role','public.get_studio_sms_provisioning(uuid)','EXECUTE')::text || ',' || has_function_privilege('authenticated','public.get_studio_sms_provisioning(uuid)','EXECUTE')::text`)).toBe("false,false,true");
    expect(psql(`select prosecdef::text || ',' || provolatile::text from pg_proc where oid = 'public.get_studio_sms_provisioning(uuid)'::regprocedure`)).toBe("true,s");
  });

  it("it writes nothing: row counts of the ledger tables and the audit are unchanged by reads", async () => {
    const count = () => psql(`select (select count(*) from public.studio_sms_prov_operations) || ',' || (select count(*) from public.studio_sms_prov_resources) || ',' || (select count(*) from public.studio_sms_onboarding_audit)`);
    const before = count();
    await call(asUser(U.owner1), S1);
    await call(asUser(U.padmin), S1);
    expect(count()).toBe(before);
  });
});
