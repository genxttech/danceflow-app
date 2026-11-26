/**
 * TW-4F slice E (20270224100000) against a REAL schema: the DanceFlow traffic hold and the emergency subaccount suspension / reactivation, driven by the
 * real server-side runner (`runSubaccountStatusChange`) with the database reached through psql and the provider replaced by the in-memory FAKE.
 * Nothing here reaches Twilio, Stripe or any hosted system. Needs only the database container (not TW4A_LOCAL_URL / the API).
 * LOCAL QA ONLY, through the isolated harness (one suite per run):
 *
 *   ISO_QA_MARKER=1 ISO_QA_REF_MAIN=<branch or commit> node scripts/qa/iso-qa.mjs run numeric --no-api -- src/lib/sms/twilioIsv/__tests__/localStack.suspension.test.ts
 *   (or by hand: TW4A_LOCAL_DB_CONTAINER=<container> TW4RFL_DB=postgres npx vitest run --no-file-parallelism <this file>)
 *
 * Privileges are asserted from the catalog; revoked functions are never called as anon through PostgREST.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runSubaccountStatusChange, runSubaccountVerification, type ChangeInput } from "../suspension";
import { FakeSubaccountStatusProvider } from "../suspensionFake";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "postgres";
const enabled = Boolean(PG);

const RUN = randomBytes(3).toString("hex");
const hex = (n: number) => randomBytes(n).toString("hex");
const uid = (n: number) => `5e${RUN}-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;
const ADMIN = uid(1);
const NOT_ADMIN = uid(2);
const UNREGISTERED_ADMIN = uid(3);
const ADMIN2 = uid(4);
const PARENT = `AC${"f".repeat(32)}`;
const MIG = join(__dirname, "../../../supabase/migrations");
const MIGRATION = "20270224100000_twilio_emergency_subaccount_suspension.sql";
const NL = String.fromCharCode(10);

const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", sqlArgs, { input: `\\set VERBOSITY verbose${NL}${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const psqlAsync = (sql: string) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile("docker", sqlArgs, { encoding: "utf8" }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}${NL}${stderr}`)) : resolve(String(stdout).trim())));
    child.stdin?.end(sql);
  });
const count = (sql: string) => Number(psql(`select count(*) from (${sql}) q`));
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const t = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${t}'::uuid` : `'${t}'`;
};

const nowS = () => Math.floor(Date.now() / 1000);
type Claims = Record<string, unknown>;
const claims = (sub: string, over: Claims = {}): Claims => ({ sub, role: "authenticated", aal: "aal2", exp: nowS() + 3600, amr: [{ method: "totp", timestamp: nowS() - 30 }], ...over });
const asAuth = (c: Claims | null, sql: string) =>
  `begin; set local role authenticated; ${c ? `select set_config('request.jwt.claims', '${JSON.stringify(c).replace(/'/g, "''")}', true);` : ""} ${sql} commit;`;
const asService = (sql: string) => `begin; set local role service_role; ${sql} commit;`;

/** an rpc client over psql, shaped like supabase-js: { data, error: { code } } (the SQLSTATE comes from VERBOSITY verbose) */
function rpcClient(wrap: (sql: string) => string) {
  const calls: string[] = [];
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push(fn);
      const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(", ");
      const sql = wrap(`select public.${fn}(${named})::text;`);
      const err = psqlError(sql);
      if (err) {
        const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(err);
        return { data: null, error: { code: m ? m[1] : "unknown", message: err.slice(0, 300) } };
      }
      const out = psql(sql).split(NL).filter(Boolean).pop() ?? "null";
      return { data: JSON.parse(out) as unknown, error: null };
    },
  };
}
const userDb = (c: Claims | null) => rpcClient((sql) => asAuth(c, sql));
const serviceDb = () => rpcClient(asService);
const begin = (c: Claims | null, args: { studio: string; action?: string; name?: string; tail?: string; ref?: string | null; reason?: string | null; key?: string }) =>
  userDb(c).rpc("tw4susp_begin", {
    p_studio_id: args.studio, p_action: args.action ?? "suspend", p_studio_name: args.name ?? null, p_sid_tail: args.tail ?? null,
    p_authorization_ref: args.ref === undefined ? "owner written authorization 2026-11-26" : args.ref, p_reason: args.reason === undefined ? "emergency: traffic DanceFlow did not originate" : args.reason,
    p_idempotency_key: args.key ?? `key-${hex(10)}`,
  });

type World = { entity: string; studios: string[]; names: string[]; account: string; owner: string };
function world(status: "active" | "suspended" | "closed" = "active"): World {
  const w: World = { entity: randomUUID(), studios: [randomUUID(), randomUUID()], names: [`Susp Studio ${hex(3)}`, `Susp Second ${hex(3)}`], account: `AC${hex(16)}`, owner: randomUUID() };
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-${hex(4)}@suspension-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studios[0]}', '${w.names[0]}', 'susp-${hex(4)}', null, 'UTC'), ('${w.studios[1]}', '${w.names[1]}', 'susp-${hex(4)}', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', 'Susp World ${hex(3)} LLC', '7772', 500000, '${ADMIN}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${w.studios[0]}', '${w.entity}', 'founding', '${ADMIN}', 'fixture: earliest location', now() - interval '2 days'),
  ('${w.studios[1]}', '${w.entity}', 'founding', '${ADMIN}', 'fixture: later location', now() - interval '1 day');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${w.entity}', '${w.account}', 'susp-${hex(3)}', 'test', '${status}', '${ADMIN}');
commit;`);
  return w;
}
const acctStatus = (w: World) => psql(`select status from public.studio_sms_twilio_accounts where legal_entity_id = '${w.entity}'`);
const held = (studio: string) => psql(`select public._tw4susp_held('${studio}')`) === "t";
const switchSet = (on: boolean) => psql(`select public.tw4susp_switch_set(${on}, '${ADMIN}', 'fixture: suspension switch ${on ? "on" : "off"} for local QA')::text`);
const fake = (w: World, status = "active", owner = PARENT) => new FakeSubaccountStatusProvider().add({ sid: w.account, ownerAccountSid: owner, status });
const input = (w: World, over: Partial<ChangeInput> = {}): ChangeInput => ({
  studioId: w.studios[0], action: "suspend", studioName: w.names[0], sidTail: w.account.slice(-6), authorizationRef: "owner written authorization 2026-11-26",
  reason: "emergency: traffic DanceFlow did not originate", idempotencyKey: `key-${hex(10)}`, ...over,
});
const run = (w: World, provider: FakeSubaccountStatusProvider, over: Partial<ChangeInput> = {}, c: Claims = claims(ADMIN), parentSid = PARENT) =>
  runSubaccountStatusChange({ user: userDb(c), admin: serviceDb(), provider, parentSid }, input(w, over));
const attempts = (w: World) =>
  JSON.parse(psql(`select coalesce(json_agg(json_build_object('action', action, 'state', state, 'outcome', outcome, 'before', provider_state_before, 'after', provider_state_after) order by created_at), '[]'::json)::text from public.studio_sms_suspension_attempts where legal_entity_id = '${w.entity}'`)) as Array<Record<string, string | null>>;
const auditEvents = (w: World) => psql(`select string_agg(event || ':' || coalesce(outcome, '') || ':' || coalesce(code, ''), ',' order by seq) from public.studio_sms_suspension_audit where legal_entity_id = '${w.entity}' or studio_id in ('${w.studios[0]}', '${w.studios[1]}')`);
/** owner-level: a billed usage attempt row with every other check bypassed EXCEPT the traffic-hold trigger (transaction rolled back, nothing persists) */
const usageInsertSql = (w: World) => `begin;
alter table public.studio_sms_usage_attempts enable always trigger studio_sms_usage_attempts_traffic_hold;
set local session_replication_role = replica;
insert into public.studio_sms_usage_attempts (id, legal_entity_id, studio_id, source_kind, source_id, message_log_id, account_sid, messaging_service_sid, estimated_segments, unit_price_cents,
  unit_provider_cost_cents, price_list_id, reserved_cents, reservation_id, state)
values (gen_random_uuid(), '${w.entity}', '${w.studios[0]}', 'manual', gen_random_uuid(), gen_random_uuid(), '${w.account}', 'MG${"0".repeat(32)}', 1, 2, 1, gen_random_uuid(), 2, gen_random_uuid(), 'reserved')
returning id;`;

describe.skipIf(!enabled)("TW-4F slice E: traffic hold and emergency subaccount suspension (20270224100000, real schema, fake provider)", () => {
  beforeAll(() => {
    expect(psql("select to_regclass('public.tw4_local_qa_only') is not null")).toBe("t");
    expect(psql("select to_regprocedure('public.tw4susp_begin(uuid,text,text,text,text,text,text)') is not null")).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@suspension-e2e.test', now(), now(), now()),
  ('${NOT_ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nobody-${RUN}@suspension-e2e.test', now(), now(), now()),
  ('${UNREGISTERED_ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unreg-${RUN}@suspension-e2e.test', now(), now(), now()),
  ('${ADMIN2}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin2-${RUN}@suspension-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${ADMIN}', 'platform_admin'), ('${NOT_ADMIN}', null), ('${UNREGISTERED_ADMIN}', 'platform_admin'), ('${ADMIN2}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studio_sms_price_approvers (user_id, added_note) values ('${ADMIN}', 'local QA registered administrator (suspension suite)'), ('${ADMIN2}', 'local QA registered administrator 2 (suspension suite)') on conflict (user_id) do nothing;
commit;`);
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------
  describe("migration hygiene, rollback round trip, privileges (catalog) and dark defaults", () => {
    it("files carry no CR, the security definer functions pin search_path, and the rollback refuses once evidence exists", () => {
      const fwd = readFileSync(join(MIG, MIGRATION), "utf8");
      const rb = readFileSync(join(MIG, "rollback", MIGRATION.replace(".sql", "_rollback.sql")), "utf8");
      expect(fwd).not.toMatch(/\r/);
      expect(rb).not.toMatch(/\r/);
      expect(count(`select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like '%tw4susp%' or p.proname like 'tw4_traffic_hold%')
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=pg_catalog, public, pg_temp')`)).toBe(0);
    });

    it("a clean rollback (no evidence yet) removes everything, and the migration re-applies", () => {
      if (count("select 1 from public.studio_sms_suspension_audit") > 0) return; // another run's evidence: forward-fix only (asserted below)
      const rb = readFileSync(join(MIG, "rollback", MIGRATION.replace(".sql", "_rollback.sql")), "utf8");
      expect(psqlError(rb)).toBe("");
      expect(psql("select to_regclass('public.studio_sms_suspension_audit') is null and not exists (select 1 from pg_trigger where tgname = 'studio_sms_usage_attempts_traffic_hold')")).toBe("t");
      expect(psqlError(readFileSync(join(MIG, MIGRATION), "utf8"))).toBe("");
      expect(psql("select to_regprocedure('public.tw4susp_begin(uuid,text,text,text,text,text,text)') is not null")).toBe("t");
    });

    it("dark by default: the switch is off and a well-formed request is refused (recorded) with no attempt and no hold", async () => {
      expect(psql("select enabled from public.studio_sms_suspension_switch")).toBe("f");
      const w = world();
      const p = fake(w);
      const r = await run(w, p);
      expect(r).toEqual({ kind: "refused", code: "switched_off" });
      expect(p.reads.length + p.writes.length).toBe(0);
      expect(attempts(w)).toEqual([]);
      expect(held(w.studios[0])).toBe(false);
      expect(auditEvents(w)).toBe("refused:refused:switched_off");
    });

    it("privileges: anon has nothing; authenticated only the two begin functions; the switch setter is reachable by NO API role; tables have no API grants", () => {
      const can = (role: string, fn: string) => psql(`select has_function_privilege('${role}', '${fn}', 'execute')`);
      const BEGIN = "public.tw4susp_begin(uuid,text,text,text,text,text,text)";
      const VERIFY = "public.tw4susp_verify_begin(uuid,text)";
      const RECORD = "public.tw4susp_record(uuid,text,text,text,text,text,text,text)";
      const SETTER = "public.tw4susp_switch_set(boolean,uuid,text)";
      const HOLD = "public.tw4_traffic_hold_set(uuid,boolean,uuid,text)";
      for (const fn of [BEGIN, VERIFY, RECORD, SETTER, HOLD, "public.tw4_traffic_hold_for_account(text)", "public.tw4susp_overview(uuid)", "public._tw4susp_held(uuid)"]) expect(can("anon", fn), fn).toBe("f");
      expect([can("authenticated", BEGIN), can("authenticated", VERIFY), can("authenticated", RECORD), can("authenticated", SETTER), can("authenticated", HOLD)]).toEqual(["t", "t", "f", "f", "f"]);
      expect([can("service_role", RECORD), can("service_role", HOLD), can("service_role", SETTER), can("service_role", BEGIN)]).toEqual(["t", "t", "f", "f"]);
      for (const t of ["studio_sms_traffic_hold_events", "studio_sms_suspension_switch", "studio_sms_suspension_attempts", "studio_sms_suspension_audit"]) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          expect(psql(`select has_table_privilege('${role}', 'public.${t}', 'select') or has_table_privilege('${role}', 'public.${t}', 'insert') or has_table_privilege('${role}', 'public.${t}', 'update') or has_table_privilege('${role}', 'public.${t}', 'delete')`), `${role} ${t}`).toBe("f");
        }
        expect(psql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`)).toBe("t");
      }
    });

    it("the switch setter is audited and refuses a non-admin", () => {
      expect(psqlError(`select public.tw4susp_switch_set(true, '${NOT_ADMIN}', 'a non-admin tries to turn it on')`)).toMatch(/42501/);
      switchSet(true);
      switchSet(false);
      expect(count(`select 1 from public.studio_sms_suspension_audit where event = 'switch' and actor = '${ADMIN}'`)).toBeGreaterThanOrEqual(2);
      expect(psqlError(`update public.studio_sms_suspension_switch set enabled = true`)).toMatch(/changes only through the tw4susp functions/);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------
  describe("authorization: registered administrator in a fresh second-factor session (from the caller's own token)", () => {
    beforeAll(() => switchSet(true));

    it("refuses: no token, a non-admin, an admin with aal1, without TOTP, with a stale TOTP, an expired token, an ended session, and an unregistered admin", async () => {
      const w = world();
      const cases: Array<[string, Claims | null]> = [
        ["no token", null],
        ["service-role claims", { role: "service_role" }],
        ["non-admin", claims(NOT_ADMIN)],
        ["aal1", claims(ADMIN, { aal: "aal1" })],
        ["no totp", claims(ADMIN, { amr: [{ method: "password", timestamp: nowS() - 10 }] })],
        ["stale totp", claims(ADMIN, { amr: [{ method: "totp", timestamp: nowS() - 3600 }] })],
        ["expired session id", claims(ADMIN, { session_id: randomUUID() })],
        ["registered? no", claims(UNREGISTERED_ADMIN)],
      ];
      for (const [label, c] of cases) {
        const res = await begin(c, { studio: w.studios[0], name: w.names[0], tail: w.account.slice(-6) });
        expect(res.error?.code, label).toBe("42501");
      }
      expect(attempts(w)).toEqual([]);
      expect(held(w.studios[0])).toBe(false);
    });

    it("an administrator cannot write a provider outcome with their own token (record is service role only)", async () => {
      const w = world();
      const r = await userDb(claims(ADMIN)).rpc("tw4susp_record", { p_attempt_id: randomUUID(), p_account_sid: w.account, p_step: "outcome", p_state_before: "active", p_state_after: "suspended", p_outcome: "succeeded", p_code: null, p_detail: null });
      expect(r.error?.code).toBe("42501");
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------
  describe("identity and confirmation (every refusal recorded, nothing called)", () => {
    beforeAll(() => switchSet(true));

    it("wrong studio name, wrong SID tail, another studio's SID tail, missing reason or authorization reference", async () => {
      const w = world();
      const other = world();
      const cases: Array<[Partial<ChangeInput>, string]> = [
        [{ studioName: w.names[0].toUpperCase() }, "wrong_studio_name"],
        [{ studioName: w.names[1] }, "wrong_studio_name"],
        [{ sidTail: "000000" }, "wrong_sid_tail"],
        [{ sidTail: other.account.slice(-6) }, "wrong_sid_tail"],
        [{ reason: "short" }, "missing_reason_or_authorization"],
        [{ authorizationRef: "x" }, "missing_reason_or_authorization"],
      ];
      for (const [over, code] of cases) {
        const p = fake(w);
        expect(await run(w, p, over), code).toEqual({ kind: "refused", code });
        expect(p.reads.length + p.writes.length).toBe(0);
      }
      expect(attempts(w)).toEqual([]);
      expect(count(`select 1 from public.studio_sms_suspension_audit where studio_id = '${w.studios[0]}' and event = 'refused'`)).toBe(cases.length);
      // evidence keeps only the RECORDED sid's last 6 characters, never what was typed
      expect(count(`select 1 from public.studio_sms_suspension_audit where studio_id = '${w.studios[0]}' and sid_tail is distinct from '${w.account.slice(-6).toLowerCase()}'`)).toBe(0);
    });

    it("a location with no legal business or no subaccount, and a CLOSED subaccount, are refused", async () => {
      const lone = randomUUID();
      psql(`insert into public.studios (id, name, slug, public_name, timezone) values ('${lone}', 'Susp Lone ${hex(3)}', 'susp-${hex(4)}', null, 'UTC')`);
      expect((await begin(claims(ADMIN), { studio: lone, name: "x", tail: "000000" })).data).toEqual({ decision: "refused", code: "no_legal_business" });
      const closed = world("closed");
      expect(await run(closed, fake(closed, "closed"))).toEqual({ kind: "refused", code: "closed" });
      expect(await run(closed, fake(closed, "closed"), { action: "reactivate" })).toEqual({ kind: "refused", code: "closed" });
    });

    it("the PARENT account is never targeted: begin returns the recorded SID, the server refuses it before any provider call and records it", async () => {
      const w = world();
      const p = fake(w, "active", w.account);
      const r = await run(w, p, {}, claims(ADMIN), w.account); // the deployment's parent is (mis)recorded as this business's subaccount
      expect(r).toMatchObject({ kind: "done", outcome: "refused", code: "parent_account", recorded: true });
      expect(p.reads.length + p.writes.length).toBe(0);
      expect(attempts(w)).toEqual([{ action: "suspend", state: "closed", outcome: "refused", before: "not_called", after: null }]);
      expect(acctStatus(w)).toBe("active");
    });

    it("an account the provider does not report as owned by the parent is refused; the record step refuses another studio's SID", async () => {
      const w = world();
      const other = world();
      const p = fake(w, "active", `AC${"9".repeat(32)}`);
      expect(await run(w, p)).toMatchObject({ outcome: "refused", code: "not_owned_by_parent" });
      expect(p.writes).toEqual([]);
      expect(acctStatus(w)).toBe("active");
      // an open attempt cannot be recorded against another business's subaccount
      const b = await begin(claims(ADMIN), { studio: other.studios[0], name: other.names[0], tail: other.account.slice(-6) });
      const attemptId = (b.data as { attempt_id: string }).attempt_id;
      const wrong = await serviceDb().rpc("tw4susp_record", { p_attempt_id: attemptId, p_account_sid: w.account, p_step: "outcome", p_state_before: "active", p_state_after: "suspended", p_outcome: "succeeded", p_code: null, p_detail: null });
      expect(wrong.error?.code).toBe("42501");
      // and a success is only accepted with the target state read back
      const noReadback = await serviceDb().rpc("tw4susp_record", { p_attempt_id: attemptId, p_account_sid: other.account, p_step: "outcome", p_state_before: "active", p_state_after: "active", p_outcome: "succeeded", p_code: null, p_detail: null });
      expect(noReadback.error?.code).toBe("22023");
      await serviceDb().rpc("tw4susp_record", { p_attempt_id: attemptId, p_account_sid: other.account, p_step: "outcome", p_state_before: "active", p_state_after: "active", p_outcome: "failed", p_code: "fixture", p_detail: null });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------
  describe("suspension, reactivation, idempotency, concurrency, provider failures", () => {
    beforeAll(() => switchSet(true));

    it("suspend: every location is put on the traffic hold BEFORE the provider call; success records before/after and marks the subaccount suspended", async () => {
      const w = world();
      const p = fake(w);
      const r = await run(w, p);
      expect(r).toMatchObject({ kind: "done", outcome: "succeeded", stateBefore: "active", stateAfter: "suspended", recorded: true });
      expect(p.writes).toEqual([{ sid: w.account, status: "suspended" }]);
      expect(acctStatus(w)).toBe("suspended");
      expect(held(w.studios[0]) && held(w.studios[1])).toBe(true);
      expect(attempts(w)).toEqual([{ action: "suspend", state: "closed", outcome: "succeeded", before: "active", after: "suspended" }]);
      expect(auditEvents(w)).toBe("requested:pending:,precheck::,outcome:succeeded:");
      // reactivation: written as active, the hold is NOT lifted (opt-out reconciliation comes first)
      const p2 = fake(w, "suspended");
      expect(await run(w, p2, { action: "reactivate" })).toMatchObject({ outcome: "succeeded", stateAfter: "active" });
      expect(p2.writes).toEqual([{ sid: w.account, status: "active" }]);
      expect(acctStatus(w)).toBe("active");
      expect(held(w.studios[0]) && held(w.studios[1])).toBe(true);
    });

    it("reactivate without a confirmed suspension is refused (also when DanceFlow's record says suspended for another reason)", async () => {
      const w = world();
      expect(await run(w, fake(w), { action: "reactivate" })).toEqual({ kind: "refused", code: "not_suspended" });
      const s = world("suspended");
      expect(await run(s, fake(s, "suspended"), { action: "reactivate" })).toEqual({ kind: "refused", code: "not_suspended" });
    });

    it("replay of the same key returns the stored result and calls the provider exactly once; the key cannot be reused for another request", async () => {
      const w = world();
      const p = fake(w);
      const key = `key-${hex(10)}`;
      await run(w, p, { idempotencyKey: key });
      const again = await run(w, p, { idempotencyKey: key });
      expect(again).toEqual({ kind: "replay", state: "closed", outcome: "succeeded", providerStateAfter: "suspended" });
      expect(p.writes).toHaveLength(1);
      expect((await begin(claims(ADMIN2), { studio: w.studios[0], name: w.names[0], tail: w.account.slice(-6), key })).data).toEqual({ decision: "refused", code: "key_conflict" });
      expect((await begin(claims(ADMIN), { studio: w.studios[0], action: "reactivate", name: w.names[0], tail: w.account.slice(-6), key })).data).toEqual({ decision: "refused", code: "key_conflict" });
      expect(count(`select 1 from public.studio_sms_suspension_attempts where idempotency_key = '${key}'`)).toBe(1);
    });

    it("concurrent duplicates: two requests for the same business (different keys, or the same key) yield exactly one attempt", async () => {
      const w = world();
      const sql = (key: string) => asAuth(claims(ADMIN), `select public.tw4susp_begin('${w.studios[0]}', 'suspend', ${lit(w.names[0])}, '${w.account.slice(-6)}', 'owner written authorization 2026-11-26', 'emergency: traffic DanceFlow did not originate', '${key}')::text;`);
      const outs = await Promise.all([psqlAsync(sql(`key-${hex(10)}`)), psqlAsync(sql(`key-${hex(10)}`))]);
      const decisions = outs.map((o) => (JSON.parse(o.split(NL).filter(Boolean).pop()!) as { decision: string; code?: string })).map((d) => d.code ?? d.decision).sort();
      expect(decisions).toEqual(["attempt_open", "proceed"]);
      const v = world();
      const k = `key-${hex(10)}`;
      const sql2 = asAuth(claims(ADMIN), `select public.tw4susp_begin('${v.studios[0]}', 'suspend', ${lit(v.names[0])}, '${v.account.slice(-6)}', 'owner written authorization 2026-11-26', 'emergency: traffic DanceFlow did not originate', '${k}')::text;`);
      const outs2 = await Promise.all([psqlAsync(sql2), psqlAsync(sql2)]);
      expect(outs2.map((o) => (JSON.parse(o.split(NL).filter(Boolean).pop()!) as { decision: string }).decision).sort()).toEqual(["proceed", "replay"]);
      expect(count(`select 1 from public.studio_sms_suspension_attempts where legal_entity_id in ('${w.entity}', '${v.entity}')`)).toBe(2);
    });

    it("provider error (definite): FAILED, subaccount status unchanged, the hold stays on (conservative)", async () => {
      const w = world();
      const p = fake(w).failNextWrite("definite");
      expect(await run(w, p)).toMatchObject({ outcome: "failed", stateAfter: "active" });
      expect(acctStatus(w)).toBe("active");
      expect(held(w.studios[0])).toBe(true);
      expect(attempts(w)[0]).toMatchObject({ state: "closed", outcome: "failed" });
    });

    it("provider UNKNOWN outcome: recorded unknown, the attempt stays open, nothing is retried or reversed; verification (GET only) closes it", async () => {
      const w = world();
      const p = fake(w).failNextWrite("silently_ignored");
      expect(await run(w, p)).toMatchObject({ outcome: "unknown" });
      expect(attempts(w)[0]).toMatchObject({ state: "unknown", outcome: "unknown" });
      // a new request (either direction) is refused until verified
      expect(await run(w, fake(w))).toEqual({ kind: "refused", code: "attempt_open" });
      expect(await run(w, fake(w, "suspended"), { action: "reactivate" })).toEqual({ kind: "refused", code: "attempt_open" });
      expect(p.writes).toHaveLength(1);
      // read-only verification records what the provider shows
      const vp = fake(w, "suspended");
      const v = await runSubaccountVerification({ user: userDb(claims(ADMIN)), admin: serviceDb(), provider: vp, parentSid: PARENT }, { studioId: w.studios[0], reason: "verify the unknown suspension outcome" });
      expect(v).toEqual({ kind: "verified", observed: "suspended", recorded: true });
      expect(vp.writes).toEqual([]);
      expect(attempts(w)[0]).toMatchObject({ state: "closed", outcome: "reconciled", after: "suspended" });
      expect(acctStatus(w)).toBe("suspended");
      // nothing ever reactivated it on its own
      expect(count(`select 1 from public.studio_sms_suspension_attempts where legal_entity_id = '${w.entity}' and action = 'reactivate'`)).toBe(0);
      // a suspension confirmed by verification counts as confirmed: an administrator may reactivate it (explicitly)
      const rp = fake(w, "suspended");
      expect(await run(w, rp, { action: "reactivate" })).toMatchObject({ outcome: "succeeded", stateAfter: "active" });
      expect(acctStatus(w)).toBe("active");
    });

    it("a hold placed by a suspension attempt cannot be lost to a concurrent release (per-location lock)", async () => {
      const w = world();
      psql(`select public.tw4_traffic_hold_set('${w.studios[0]}', true, '${ADMIN}', 'manual hold before the race test')`);
      const release = asService(`select public.tw4_traffic_hold_set('${w.studios[0]}', false, '${ADMIN}', 'concurrent release during the race test')::text, pg_sleep(1);`);
      const susp = asAuth(claims(ADMIN), `select public.tw4susp_begin('${w.studios[0]}', 'suspend', ${lit(w.names[0])}, '${w.account.slice(-6)}', 'owner written authorization 2026-11-26', 'emergency: traffic DanceFlow did not originate', 'key-${hex(10)}')::text;`);
      const first = psqlAsync(release);
      await new Promise((r) => setTimeout(r, 300));
      await Promise.all([first, psqlAsync(susp)]);
      expect(held(w.studios[0]) && held(w.studios[1])).toBe(true);
    });

    it("verification observing CLOSED records the fact without changing the account row; verification with nothing open is refused", async () => {
      const w = world();
      await run(w, fake(w).failNextWrite("transient"));
      const v = await runSubaccountVerification({ user: userDb(claims(ADMIN)), admin: serviceDb(), provider: fake(w, "closed"), parentSid: PARENT }, { studioId: w.studios[0], reason: "verify the unknown suspension outcome" });
      expect(v).toMatchObject({ kind: "verified", observed: "closed" });
      expect(acctStatus(w)).toBe("active");
      expect(await runSubaccountVerification({ user: userDb(claims(ADMIN)), admin: serviceDb(), provider: fake(w), parentSid: PARENT }, { studioId: w.studios[0], reason: "verify again with nothing open" })).toEqual({ kind: "refused", code: "nothing_to_verify" });
    });

    it("a provider that reports the account closed at the pre-check: refused and recorded, never written", async () => {
      const w = world();
      const p = fake(w, "closed");
      expect(await run(w, p)).toMatchObject({ outcome: "refused", code: "closed" });
      expect(p.writes).toEqual([]);
      expect(acctStatus(w)).toBe("active");
    });

    it("switching the database gate off stops new requests at once", async () => {
      const w = world();
      switchSet(false);
      try {
        expect(await run(w, fake(w))).toEqual({ kind: "refused", code: "switched_off" });
      } finally {
        switchSet(true);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------
  describe("evidence is immutable", () => {
    it("audit rows and hold events cannot be updated, deleted or truncated by ANY role (also with the replication role); attempts change only forward through the functions", () => {
      for (const t of ["studio_sms_suspension_audit", "studio_sms_traffic_hold_events"]) {
        expect(psqlError(`update public.${t} set created_at = now()`)).toMatch(/append-only/);
        expect(psqlError(`delete from public.${t}`)).toMatch(/append-only/);
        expect(psqlError(`truncate public.${t}`)).toMatch(/append-only/);
        expect(psqlError(`begin; set local session_replication_role = replica; delete from public.${t}; commit;`)).toMatch(/append-only/);
      }
      expect(psqlError(`update public.studio_sms_suspension_attempts set outcome = 'succeeded'`)).toMatch(/only through the tw4susp functions/);
      expect(psqlError(`delete from public.studio_sms_suspension_attempts`)).toMatch(/never removed/);
      expect(psqlError(`begin; set local tw4.susp_write = 'on'; update public.studio_sms_suspension_attempts set state = 'in_flight' where state = 'closed'; commit;`)).toMatch(/only moves forward/);
    });

    it("the rollback refuses while evidence exists (forward-fix only)", () => {
      const rb = readFileSync(join(MIG, "rollback", MIGRATION.replace(".sql", "_rollback.sql")), "utf8");
      expect(psqlError(rb)).toMatch(/forward-fix only/);
      expect(psql("select to_regclass('public.studio_sms_suspension_audit') is not null")).toBe("t");
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------
  describe("(a) DanceFlow traffic hold: what it blocks and what it never blocks", () => {
    it("hold set / release: admin only, reason required, idempotent, append-only history", () => {
      const w = world();
      expect(psqlError(`select public.tw4_traffic_hold_set('${w.studios[0]}', true, '${NOT_ADMIN}', 'a non-admin tries a hold')`)).toMatch(/42501/);
      expect(psqlError(`select public.tw4_traffic_hold_set('${w.studios[0]}', true, '${ADMIN}', 'short')`)).toMatch(/22023/);
      expect(JSON.parse(psql(asService(`select public.tw4_traffic_hold_set('${w.studios[0]}', true, '${ADMIN}', 'manual hold: unexplained traffic')::text;`)))).toEqual({ held: true, replayed: false });
      expect(JSON.parse(psql(asService(`select public.tw4_traffic_hold_set('${w.studios[0]}', true, '${ADMIN}', 'manual hold: unexplained traffic')::text;`)))).toEqual({ held: true, replayed: true });
      expect(held(w.studios[0])).toBe(true);
      expect(held(w.studios[1])).toBe(false); // per location
      expect(psql(asService(`select public.tw4_traffic_hold_for_account('${w.account}')::text;`))).toBe("true"); // the business's error replies stop
      psql(asService(`select public.tw4_traffic_hold_set('${w.studios[0]}', false, '${ADMIN}', 'released after review of the traffic')::text;`));
      expect(held(w.studios[0])).toBe(false);
      expect(count(`select 1 from public.studio_sms_traffic_hold_events where studio_id = '${w.studios[0]}'`)).toBe(2);
    });

    it("blocks a new billed attempt and the reserved -> submitting dispatch marker (TW080) only for the held location", () => {
      const w = world();
      // not held: the trigger lets the row in (the transaction is rolled back)
      expect(psqlError(`${usageInsertSql(w)} rollback;`)).toBe("");
      psql(`select public.tw4_traffic_hold_set('${w.studios[0]}', true, '${ADMIN}', 'manual hold for the usage trigger test')`);
      expect(psqlError(`${usageInsertSql(w)} rollback;`)).toMatch(/TW080/);
      // a row reserved before the hold cannot be dispatched after it
      psql(`select public.tw4_traffic_hold_set('${w.studios[0]}', false, '${ADMIN}', 'lift to reserve one before the hold')`);
      const dispatch = `${usageInsertSql(w).replace(/returning id;$/, "returning id \\gset")}
insert into public.studio_sms_traffic_hold_events (studio_id, legal_entity_id, hold, actor, reason) values ('${w.studios[0]}', '${w.entity}', true, '${ADMIN}', 'hold placed after the reservation');
update public.studio_sms_usage_attempts set state = 'submitting', submitting_at = now() where id = :'id';
rollback;`;
      expect(psqlError(dispatch)).toMatch(/TW080/);
    });

    it("STOP / START / HELP are processed under the hold: consent changes, pending opt-out, compliance recording and HELP / START confirmations", () => {
      const w = world();
      psql(`select public.tw4_traffic_hold_set('${w.studios[0]}', true, '${ADMIN}', 'hold for the compliance test')`);
      const phone = `+1555${String(Date.now()).slice(-7)}`;
      expect(psqlError(asService(`select public.record_sms_inbound_opt_event('${w.studios[0]}', '${phone}', 'stop')::text;`))).toBe("");
      expect(psqlError(asService(`select public.sms_pending_opt_out_record('${w.studios[0]}', '${phone}', 'SM${hex(16)}')::text;`))).toBe("");
      expect(psqlError(asService(`select public.record_sms_inbound_opt_event('${w.studios[0]}', '${phone}', 'start')::text;`))).toBe("");
      const rec = JSON.parse(psql(asService(`select public.tw4_inbound_record('${w.studios[0]}', '${w.account}', 'SM${hex(16)}', 1, 0, 'compliance', 'You are unsubscribed.', now(), 'webhook')::text;`)).split(NL).pop()!) as { recorded: boolean; charged_cents: number };
      expect(rec).toMatchObject({ recorded: true, charged_cents: 0 });
      const hash = createHash("sha256").update(`tw4-inbound:${phone}`).digest("hex");
      for (const kind of ["help", "start"]) {
        expect(psql(asService(`select public.tw4_inbound_reply_allowed('${w.account}', '${hash}', '${kind}', 5)::text;`)), kind).toBe("true");
      }
      // the only reply the hold affects is the optional error reply, which the application suppresses from this answer
      expect(psql(asService(`select public.tw4_traffic_hold_for_account('${w.account}')::text;`))).toBe("true");
    });

    it("lifting a hold never lifts the existing credit hold (the two are independent)", () => {
      const w = world();
      psql(`select public.tw4_credit_set_hold('${w.entity}', true, 'manual credit hold for the test', '${ADMIN}')`);
      psql(`select public.tw4_traffic_hold_set('${w.studios[0]}', true, '${ADMIN}', 'traffic hold for the independence test')`);
      psql(`select public.tw4_traffic_hold_set('${w.studios[0]}', false, '${ADMIN}', 'traffic hold lifted for the independence test')`);
      expect(psql(`select hold from public.studio_sms_credit_accounts where legal_entity_id = '${w.entity}'`)).toBe("t");
    });
  });
});
