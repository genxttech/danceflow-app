/**
 * D4-2 security audit of migration 20270205090000 against a REAL schema (failing-first: each test below was written before the fix it pins).
 * LOCAL QA ONLY (dedicated Postgres, public.tw4_local_qa_only):
 *   node scripts/qa/tw4f/run-chain.mjs suites --suite localStack.d42audit --extra-branch claude/d4-2-price-monitoring --env ISO_QA_MARKER=1 --env TW4RFL_DB=postgres
 * Each suite runs on a fresh clone of the applied chain, so the evidence and event tables start empty.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, appendEvidence } from "../evidence";
import type { PriceMonitorDb } from "../types";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);
const args = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", args, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const tryPsql = (sql: string): { ok: boolean; out: string } => {
  try { return { ok: true, out: psql(sql) }; } catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) }; }
};
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const asService = (sql: string): string => psql(`begin; set local role service_role; ${sql} commit;`);

const FUNCTIONS = [
  "tw4_price_monitor_digest()", "tw4_price_monitor_events(bigint)", "tw4_price_monitor_evidence_list(integer,bigint)",
  "tw4_price_monitor_evidence_append(bigint,text,text,uuid,text,timestamptz,text)", "tw4_price_monitor_status(integer)",
];
const OWNER_ONLY = ["_tw4pricemon_emit_event(text,uuid,jsonb)", "_tw4pricemon_immutable()", "_tw4pricemon_event_fill()"];

describe.skipIf(!enabled)("D4-2 migration security audit", () => {
  it("ACL matrix: no table ACL entry for any API role or PUBLIC; only service_role executes the five reader/appender functions; helpers are owner-only", () => {
    for (const t of ["studio_sms_price_monitor_evidence", "studio_sms_price_security_events"]) {
      expect(psql(`select count(*) from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid = 'public.${t}'::regclass and a.grantee <> c.relowner`)).toBe("0");
    }
    for (const f of [...FUNCTIONS, ...OWNER_ONLY]) {
      const row = psql(`select has_function_privilege('anon','public.${f}','execute'), has_function_privilege('authenticated','public.${f}','execute'), has_function_privilege('service_role','public.${f}','execute'), exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = 'public.${f}'::regprocedure and a.grantee = 0)`);
      expect(row, f).toBe(FUNCTIONS.includes(f) ? "f|f|t|f" : "f|f|f|f");
    }
    // nothing else of this feature is executable by an API role
    expect(psql("select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'tw4_price_monitor%' or p.proname like '_tw4pricemon%')")).toBe(String(FUNCTIONS.length + OWNER_ONLY.length));
  });

  it("every function pins search_path; the security-definer ones are owned by the table owner", () => {
    expect(psql("select count(*) from pg_proc p where (p.proname like 'tw4_price_monitor%' or p.proname like '_tw4pricemon%') and not coalesce(p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%', false)")).toBe("0");
    expect(psql("select count(distinct pg_get_userbyid(proowner)) from pg_proc where proname like 'tw4_price_monitor%' or proname like '_tw4pricemon%'")).toBe("1");
  });

  it("service_role cannot write, alter or delete events, cannot call the emitter, cannot forge a security event any way", () => {
    expect(tryPsql("begin; set local role service_role; insert into public.studio_sms_price_security_events (kind) values ('pricing_resumed');").ok).toBe(false);
    expect(tryPsql("begin; set local role service_role; update public.studio_sms_price_security_events set kind = 'x_y_z';").ok).toBe(false);
    expect(tryPsql("begin; set local role service_role; delete from public.studio_sms_price_security_events;").ok).toBe(false);
    expect(tryPsql("begin; set local role service_role; select public._tw4pricemon_emit_event('pricing_resumed', null, '{}'::jsonb);").out).toContain("permission denied");
    expect(tryPsql("begin; set local role authenticated; select public._tw4pricemon_emit_event('pricing_resumed', null, '{}'::jsonb);").ok).toBe(false);
  });

  it("the owner-level emitter validates the kind and stores a monitor-readable row; timestamps are database-assigned and cannot be backdated", () => {
    expect(tryPsql("select public._tw4pricemon_emit_event('Not A Kind', null, '{}'::jsonb);").ok).toBe(false);
    psql("select public._tw4pricemon_emit_event('credential_compromise_reported', null, '{\"n\":1}'::jsonb);");
    // a direct owner insert that tries to backdate both timestamps and to choose its own seq
    psql("insert into public.studio_sms_price_security_events (seq, kind, occurred_at, recorded_at, detail) values (1, 'credential_replaced', '2020-01-01', '2020-01-01', '{}');");
    expect(psql("select count(*) from public.studio_sms_price_security_events where occurred_at < now() - interval '1 minute' or recorded_at < now() - interval '1 minute'")).toBe("0");
    // the same under replica mode (triggers must be ENABLE ALWAYS)
    psql("begin; set local session_replication_role = replica; insert into public.studio_sms_price_security_events (seq, kind, occurred_at, recorded_at, detail) values (99, 'credential_replaced', '2020-01-01', '2020-01-01', '{}'); commit;");
    expect(psql("select count(*) from public.studio_sms_price_security_events where occurred_at < now() - interval '1 minute' or recorded_at < now() - interval '1 minute'")).toBe("0");
    expect(psql("select string_agg(seq::text, ',' order by seq) from public.studio_sms_price_security_events")).toBe("1,2,3");
  });

  it("event seq is gapless and commit-ordered: a rolled-back emit leaves no gap (so a cursor reader can never skip an event)", () => {
    psql("begin; select public._tw4pricemon_emit_event('credential_replaced', null, '{}'::jsonb); rollback;");
    psql("select public._tw4pricemon_emit_event('credential_replaced', null, '{}'::jsonb);");
    expect(psql("select max(seq) - count(*) from public.studio_sms_price_security_events")).toBe("0");
  });

  it("events cannot be deleted, edited, reordered or truncated, by the owner, also in replica mode", () => {
    for (const stmt of ["update public.studio_sms_price_security_events set seq = seq + 100", "update public.studio_sms_price_security_events set kind = 'pricing_resumed'", "delete from public.studio_sms_price_security_events", "truncate public.studio_sms_price_security_events"]) {
      expect(tryPsql(`${stmt};`).ok, stmt).toBe(false);
      expect(tryPsql(`begin; set local session_replication_role = replica; ${stmt}; commit;`).ok, stmt).toBe(false);
    }
  });

  it("evidence append refuses a recorded_at far from the database clock (a forged future or past timestamp cannot keep the watchdog quiet)", () => {
    const r = JSON.parse(asService(`select public.tw4_price_monitor_evidence_append(1, ${lit(GENESIS_HASH)}, ${lit("a".repeat(64))}, gen_random_uuid(), 'run', now() + interval '2 days', '{}')::text;`).split("\n").filter((l) => l.startsWith("{")).pop()!);
    expect(r).toMatchObject({ appended: false, reason: "recorded_at_out_of_range" });
    expect(psql("select count(*) from public.studio_sms_price_monitor_evidence")).toBe("0");
  });

  it("guard status: disabling an append-only trigger shows up in the digest function (guards_ok false) until re-enabled", () => {
    const read = () => JSON.parse(asService("select public.tw4_price_monitor_digest()::text;").split("\n").filter((l) => l.startsWith("{")).pop()!);
    expect(read().guards_ok).toBe(true);
    psql("alter table public.studio_sms_price_monitor_evidence disable trigger studio_sms_price_monitor_evidence_immutable;");
    const bad = read();
    psql("alter table public.studio_sms_price_monitor_evidence enable always trigger studio_sms_price_monitor_evidence_immutable;");
    expect(bad.guards_ok).toBe(false);
    expect(bad.guards_bad).toContain("studio_sms_price_monitor_evidence_immutable");
    expect(read().guards_ok).toBe(true);
  });

  it("status function for the pricing side: never / ok / stale from the DATABASE clock, informational only", async () => {
    const st = (maxAge: number) => JSON.parse(asService(`select public.tw4_price_monitor_status(${maxAge})::text;`).split("\n").filter((l) => l.startsWith("{")).pop()!);
    expect(st(2700)).toMatchObject({ state: "never", monitoring_expected: false });
    const db = { evidenceAppend: async (r: unknown) => JSON.parse(asService(`select public.tw4_price_monitor_evidence_append(${(r as { seq: number }).seq}, ${lit((r as { prev_hash: string }).prev_hash)}, ${lit((r as { entry_hash: string }).entry_hash)}, ${lit((r as { run_id: string }).run_id)}::uuid, 'run', ${lit((r as { recorded_at: string }).recorded_at)}::timestamptz, ${lit((r as { payload: string }).payload)})::text;`).split("\n").filter((l) => l.startsWith("{")).pop()!) } as unknown as PriceMonitorDb;
    const res = await appendEvidence(db, { seq: 0, hash: GENESIS_HASH }, { kind: "run", payload: { v: 1 }, now: new Date() });
    expect(res.appended).toBe(true);
    expect(st(2700)).toMatchObject({ state: "ok", monitoring_expected: true });
    expect(st(0)).toMatchObject({ state: "stale", monitoring_expected: true });
    expect(tryPsql("begin; set local role authenticated; select public.tw4_price_monitor_status(60);").ok).toBe(false);
  });
});
