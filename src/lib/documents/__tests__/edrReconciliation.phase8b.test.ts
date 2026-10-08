import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 8B: 20261030 is a verification-only reconciliation for the baseline-originated event_document_requirements
 * table. The live behaviour is proven by the SQL suite (test_T_phase8b_event_document_requirements_history.sql, run on
 * DEV and on a disposable baseline+forward rebuild); these checks keep that suite honest and the migration DDL-free.
 */

const MIGRATIONS = path.join(process.cwd(), "src/lib/supabase/migrations");
const migration = readFileSync(
  path.join(MIGRATIONS, "20261030090000_reconcile_event_document_requirements_schema_history.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
const sqlTest = readFileSync(
  path.join(MIGRATIONS, "sql-tests/test_T_phase8b_event_document_requirements_history.sql"),
  "utf8",
).replace(/\r\n/g, "\n");

const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

function migrationVerifyBody() {
  const match = /\ndo \$\$\n([\s\S]*?)\n\$\$;\n/.exec(migration);
  if (!match) throw new Error("migration DO block not found");
  return match[1];
}

function sqlTestVerifyBody() {
  const match = /as \$verify\$\n([\s\S]*?)\n\$verify\$;/.exec(sqlTest);
  if (!match) throw new Error("pg_temp.p8b_verify body not found");
  return match[1];
}

describe("20261030 event_document_requirements reconciliation (verification only)", () => {
  it("the SQL suite exercises the migration's verification body verbatim", () => {
    expect(sqlTestVerifyBody()).toBe(migrationVerifyBody());
  });

  it("fails closed when the baseline table is absent", () => {
    const body = migrationVerifyBody();
    expect(body).toMatch(
      /if to_regclass\('public\.event_document_requirements'\) is null then\s+raise exception 'Phase 8B: public\.event_document_requirements is missing\./,
    );
  });

  it("verifies the exact reviewed fingerprint under a pinned search_path", () => {
    expect(migrationVerifyBody()).toContain("if v_fp is distinct from '7426ac2d0aa74eccba5ff5098c0398e7' then\n    raise exception");
    expect(migration).toContain("\nset local search_path to pg_catalog, public;\n");
  });

  it("performs no DDL and no data change", () => {
    const sql = withoutComments(migration).toLowerCase();
    expect(sql).not.toMatch(/\b(create|alter|drop|grant|revoke|comment\s+on)\b/);
    expect(sql).not.toMatch(/\b(insert\s+into|update\s+\w|delete\s+from|truncate)\b/);
  });
});
