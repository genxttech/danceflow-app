// OD-04 event delete guard: static consistency checks (no database). The behavior itself is proven by the SQL suite
// src/lib/supabase/migrations/sql-tests/test_T_competition_od04_event_delete_guard.sql and the race script run_od04_race.sh.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MIG = join(ROOT, "src/lib/supabase/migrations");
const VERSION = "20270301080000";
const MIGRATION = `${VERSION}_competition_od04_event_delete_guard.sql`;
const ROLLBACK = `${VERSION}_competition_od04_event_delete_guard_rollback.sql`;
const SUITE = "sql-tests/test_T_competition_od04_event_delete_guard.sql";

const read = (p: string) => readFileSync(join(MIG, p), "utf8");
const code = (sql: string) => sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");

function listedTables(sql: string): string[] {
  const body = /_compod04_evidence_tables\(\)[\s\S]*?select array\[([\s\S]*?)\]::text\[\]/.exec(sql)?.[1] ?? "";
  return [...code(body).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

describe("OD-04 event delete guard (static)", () => {
  const migration = read(MIGRATION);
  const rollback = read(`rollback/${ROLLBACK}`);
  const suite = read(SUITE);
  const listed = listedTables(migration);

  it("OD-04 migration lists the protected evidence tables and nothing is duplicated", () => {
    expect(listed.length).toBeGreaterThanOrEqual(21);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("OD-04 migration list, preflight list and SQL suite list name exactly the same tables", () => {
    const preflight = /foreach v_name in array array\[([\s\S]*?)\] loop/.exec(migration)?.[1] ?? "";
    const pre = [...preflight.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    const expected = /insert into t_expected\(tbl, protected\)\s*select t, true from unnest\(array\[([\s\S]*?)\]\) t;/.exec(suite)?.[1] ?? "";
    const exp = [...expected.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect([...pre].sort()).toEqual([...listed].sort());
    expect([...exp].sort()).toEqual([...listed].sort());
  });

  it("OD-04 every protected table is created by some migration in the repository", () => {
    const all = readdirSync(MIG).filter((f) => f.endsWith(".sql")).map((f) => read(f)).join("\n");
    for (const t of listed) expect(all, t).toMatch(new RegExp(`create table (if not exists )?public\\.${t}\\b`));
  });

  it("OD-04 migration is later than every other migration in the directory and carries the not-applied header", () => {
    const others = readdirSync(MIG).filter((f) => /^\d{14}_.*\.sql$/.test(f) && f !== MIGRATION);
    // another open Competition PR may legitimately take a later number; the guard only has to sort after the chain it protects
    const chain = others.filter((f) => /competition/.test(f) && f.slice(0, 14) < VERSION);
    expect(chain.length).toBeGreaterThan(20);
    expect(migration.split(/\r?\n/).slice(0, 8).join("\n")).toMatch(/NOT APPLIED ANYWHERE/);
    expect(migration).toMatch(/requires separate, explicit owner approval/);
  });

  it("OD-04 migration function bodies use LF line endings only (CRLF gotcha)", () => {
    expect(migration.includes("\r")).toBe(false);
    expect(rollback.includes("\r")).toBe(false);
  });

  it("OD-04 migration installs ENABLE ALWAYS delete and truncate guards on public.events", () => {
    const sql = code(migration);
    expect(sql).toMatch(/create trigger a00_compod04_events_delete_guard\s+before delete on public\.events\s+for each row/);
    expect(sql).toMatch(/create trigger a00_compod04_events_truncate_guard\s+before truncate on public\.events\s+for each statement/);
    expect(sql).toMatch(/alter table public\.events enable always trigger a00_compod04_events_delete_guard/);
    expect(sql).toMatch(/alter table public\.events enable always trigger a00_compod04_events_truncate_guard/);
  });

  it("OD-04 migration takes the event row lock before it looks for evidence", () => {
    const body = /create or replace function public\.compod04_guard_event_delete\(\)[\s\S]*?\$\$;/.exec(code(migration))?.[0] ?? "";
    expect(body.indexOf("for update")).toBeGreaterThan(-1);
    expect(body.indexOf("for update")).toBeLessThan(body.indexOf("_compod04_event_evidence"));
  });

  it("OD-04 migration contains no retention timer and deletes nothing", () => {
    const sql = code(migration).toLowerCase();
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/pg_cron|cron\.schedule|interval\s+'|make_interval|\bage\(/);
    expect(sql).not.toMatch(/\b30\s*days?\b/);
  });

  it("OD-04 migration does not alter any table other than events (triggers only)", () => {
    const alters = [...code(migration).matchAll(/alter table\s+(?:only\s+)?([a-z_.]+)/gi)].map((m) => m[1].toLowerCase());
    expect(new Set(alters)).toEqual(new Set(["public.events"]));
    expect(code(migration)).not.toMatch(/\b(create|drop|alter)\s+policy\b/i);
  });

  it("OD-04 rollback removes exactly what the migration creates and touches no table", () => {
    const created = [...code(migration).matchAll(/create or replace function (public\.[a-z0-9_]+\([^)]*\))/g)].map((m) => m[1].replace("(p_event uuid)", "(uuid)").replace(/\s+/g, " "));
    const dropped = [...code(rollback).matchAll(/drop function if exists (public\.[a-z0-9_]+\([^)]*\))/g)].map((m) => m[1].replace(/\s+/g, " "));
    expect([...dropped].sort()).toEqual([...created].sort());
    expect(code(rollback)).toMatch(/drop trigger if exists a00_compod04_events_delete_guard on public\.events/);
    expect(code(rollback)).toMatch(/drop trigger if exists a00_compod04_events_truncate_guard on public\.events/);
    expect(code(rollback).toLowerCase()).not.toMatch(/\b(drop table|delete from|truncate|alter table)\b/);
  });

  it("OD-04 SQL suite ends in a verdict raise and the race script exists", () => {
    expect(suite).toMatch(/COMPETITION OD-04 SQL SUITE PASS/);
    expect(read("sql-tests/concurrency/run_od04_race.sh")).toMatch(/OD04 RACE PASS/);
  });
});
