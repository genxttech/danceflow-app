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

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// R3-3: the digest must check an EXPECTED list of guard triggers (name, table, function, ENABLE ALWAYS) for this migration, D4-1 (dual control) and the D4-2 authorization migration
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const EXPECTED: { grp: "own" | "dual" | "authz"; tbl: string; trg: string; fn: string }[] = [
  ["own", "studio_sms_price_monitor_evidence", "studio_sms_price_monitor_evidence_immutable", "_tw4pricemon_immutable"],
  ["own", "studio_sms_price_monitor_evidence", "studio_sms_price_monitor_evidence_truncate", "_tw4pricemon_immutable"],
  ["own", "studio_sms_price_security_events", "studio_sms_price_security_events_immutable", "_tw4pricemon_immutable"],
  ["own", "studio_sms_price_security_events", "studio_sms_price_security_events_truncate", "_tw4pricemon_immutable"],
  ["own", "studio_sms_price_security_events", "studio_sms_price_security_events_00_fill", "_tw4pricemon_event_fill"],
  ["dual", "studio_sms_price_list", "studio_sms_price_list_00_activation", "_tw4price_activation_guard"],
  ["dual", "studio_sms_price_list", "studio_sms_price_list_00_truncate", "_tw4price_truncate_guard"],
  ["dual", "studio_sms_price_change_requests", "studio_sms_price_change_requests_guard", "_tw4pricedual_guard"],
  ["dual", "studio_sms_price_change_requests", "studio_sms_price_change_requests_truncate", "_tw4c_truncate_guard"],
  ["dual", "studio_sms_price_approvers", "studio_sms_price_approvers_guard", "_tw4price_registry_guard"],
  ["dual", "studio_sms_price_approvers", "studio_sms_price_approvers_truncate", "_tw4c_truncate_guard"],
  ...["auth_config", "credentials", "auth_challenges", "credential_changes", "audit", "emit_acks"].flatMap((n) => [
    ["authz", `studio_sms_price_${n}`, `studio_sms_price_${n}_guard`, "_tw4priceauth_guard"],
    ["authz", `studio_sms_price_${n}`, `studio_sms_price_${n}_truncate`, "_tw4c_truncate_guard"],
  ]),
  ["authz", "studio_sms_price_approvers", "studio_sms_price_approvers_emit", "_tw4price_registry_emit"],
].map(([grp, tbl, trg, fn]) => ({ grp, tbl, trg, fn })) as never;

const digestIn = (sql: string): Record<string, unknown> => JSON.parse(psql(`begin; ${sql} set local role service_role; select public.tw4_price_monitor_digest()::text; rollback;`).split("\n").filter((l) => l.startsWith("{")).pop()!);
const AUTHZ_TABLES = ["auth_config", "credentials", "auth_challenges", "credential_changes", "audit", "emit_acks"].map((n) => `studio_sms_price_${n}`);
const DROP_AUTHZ = `drop table if exists ${AUTHZ_TABLES.map((x) => `public.${x}`).join(", ")} cascade;`;
const DROP_ALL = `${DROP_AUTHZ} drop table if exists public.studio_sms_price_change_requests, public.studio_sms_price_approvers, public.studio_sms_price_limits cascade;`;
const exists = (tbl: string) => psql(`select to_regclass('public.${tbl}') is not null`) === "t";

/** Inside a transaction (rolled back): make the D4-1 / authorization tables, trigger functions and triggers exist as stubs where the chain lacks them, so every class can be exercised on any chain. */
function stubSql(groups: string[]): string {
  const rows = EXPECTED.filter((e) => groups.includes(e.grp));
  const tables = [...new Set(rows.map((r) => r.tbl))].filter((t2) => t2 !== "studio_sms_price_list");
  const extra = groups.includes("dual") ? ["studio_sms_price_limits"] : [];
  const fns = [...new Set(rows.map((r) => r.fn))];
  return [
    ...[...tables, ...extra].map((tb) => `create table if not exists public.${tb} (id int);`),
    ...fns.map((f) => `create or replace function public.${f}() returns trigger language plpgsql as $s$ begin return null; end $s$;`),
    ...rows.map((r) => `drop trigger if exists ${r.trg} on public.${r.tbl}; create trigger ${r.trg} ${r.trg.endsWith("_truncate") ? "before truncate" : r.trg.endsWith("_emit") ? "after insert or update" : "before insert or update or delete"} on public.${r.tbl} for each ${r.trg.endsWith("_truncate") ? "statement" : "row"} execute function public.${r.fn}(); alter table public.${r.tbl} enable always trigger ${r.trg};`),
  ].join("\n");
}

describe.skipIf(!enabled)("D4-2 digest guard inventory (R3-3)", () => {
  it("standalone chain: only this migration's guards are expected, none absent, guards_ok true", () => {
    if (exists("studio_sms_price_change_requests")) return; // covered by the full-chain test below
    const d = digestIn("");
    expect(d).toMatchObject({ guards_ok: true, guards_missing: [], guards_disabled: [], expected_but_absent: [], groups_active: ["own"] });
  });

  it("with the D4-1 and authorization guards present (stubs where the chain lacks them) the inventory is complete and ok", () => {
    const d = digestIn(stubSql(["dual", "authz"]));
    expect(d.groups_active).toEqual(["authz", "dual", "own"]);
    expect(d).toMatchObject({ guards_ok: true, guards_missing: [], guards_disabled: [], guards_wrong_function: [], expected_but_absent: [] });
    expect(Object.keys(d.guards as object).length).toBe(EXPECTED.length);
  });

  it("every expected guard class: DROPPED is reported missing and guards_ok false (price-list activation, truncate, request, registry, authorization tables, emit, evidence, events)", () => {
    for (const e of EXPECTED) {
      const d = digestIn(`${stubSql(["dual", "authz"])} drop trigger ${e.trg} on public.${e.tbl};`);
      expect(d.guards_ok, e.trg).toBe(false);
      expect(d.guards_missing, e.trg).toEqual([e.trg]);
    }
  });

  it("every expected guard class: DISABLED or merely ENABLED (not ALWAYS) is reported and guards_ok false", () => {
    for (const e of EXPECTED) {
      for (const mode of ["disable trigger", "enable trigger", "enable replica trigger"]) {
        const d = digestIn(`${stubSql(["dual", "authz"])} alter table public.${e.tbl} ${mode} ${e.trg};`);
        expect(d.guards_ok, `${e.trg} ${mode}`).toBe(false);
        expect(d.guards_disabled, `${e.trg} ${mode}`).toEqual([e.trg]);
      }
    }
  });

  it("a guard re-created with a different (no-op) function is reported as wrong_function", () => {
    const e = EXPECTED.find((x) => x.trg === "studio_sms_price_list_00_activation")!;
    const d = digestIn(`${stubSql(["dual", "authz"])} create or replace function public.d42_noop() returns trigger language plpgsql as $s$ begin return null; end $s$;
      drop trigger ${e.trg} on public.${e.tbl}; create trigger ${e.trg} before insert or update or delete on public.${e.tbl} for each row execute function public.d42_noop(); alter table public.${e.tbl} enable always trigger ${e.trg};`);
    expect(d.guards_ok).toBe(false);
    expect(d.guards_wrong_function).toEqual([e.trg]);
  });

  it("partial pricing migrations: some tables of an active group missing is reported as expected_but_absent, loudly", () => {
    // authorization group present with one table only
    const d = digestIn(`${DROP_ALL} ${stubSql(["dual"])} create table if not exists public.studio_sms_price_audit (id int);`);
    expect(d.guards_ok).toBe(false);
    expect(d.expected_but_absent).toEqual(expect.arrayContaining(["studio_sms_price_auth_config", "studio_sms_price_credentials", "studio_sms_price_emit_acks"]));
    // D4-1 group with the registry only
    const d2 = digestIn(`${DROP_ALL} create table public.studio_sms_price_approvers (id int);`);
    expect(d2.guards_ok).toBe(false);
    expect(d2.expected_but_absent).toEqual(expect.arrayContaining(["studio_sms_price_change_requests", "studio_sms_price_limits"]));
  });

  it("D4-1 alone (no authorization migration) is ok and does not report the authorization tables as absent", () => {
    const d = digestIn(`${DROP_AUTHZ} ${stubSql(["dual"])}`);
    expect(d).toMatchObject({ guards_ok: true, expected_but_absent: [] });
    expect(d.groups_active).toEqual(["dual", "own"]);
  });
});
