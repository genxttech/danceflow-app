import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Marketing M-0: the stage-1 migration's authorization precondition and the read-only PROD preflight must check the same
 * seven tables against the same known pre-M-0 signatures, computed by the same expression. Otherwise an operator could
 * see "MATCH" in the preflight for a state the migration would refuse (or the reverse).
 */
const DIR = join(process.cwd(), "src/lib/supabase/migrations");
const migration = readFileSync(join(DIR, "20261117090000_m0_marketing_send_integrity.sql"), "utf8");
const preflight = readFileSync(join(DIR, "sql-tests/m0_prod_preflight_readonly.sql"), "utf8");

const TABLES = [
  "marketing_campaign_recipients",
  "organizer_marketing_campaign_recipients",
  "marketing_unsubscribes",
  "organizer_marketing_unsubscribes",
  "marketing_campaigns",
  "organizer_marketing_campaigns",
  "outbound_deliveries",
];

function migrationSignatures() {
  const block = migration.slice(migration.indexOf("M0-AUTH-SIGNATURES (begin)"), migration.indexOf("M0-AUTH-SIGNATURES (end)"));
  return Object.fromEntries(
    [...block.matchAll(/\('([a-z_]+)', array\['([0-9a-f]{32})', '([0-9a-f]{32})'\]\)/g)].map((m) => [m[1], { pre: m[2], s1: m[3] }]),
  );
}

function preflightSignatures() {
  const block = preflight.slice(preflight.indexOf("select 'A8 '"), preflight.indexOf("-- A9"));
  return Object.fromEntries([...block.matchAll(/\('([a-z_]+)', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]));
}

function signatureExpression(text: string, start: string, ref: string) {
  const from = text.indexOf("md5(\n", text.indexOf(start));
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1).replaceAll(ref, "<name>").replace(/\s+/g, " ");
    }
  }
  throw new Error("unterminated signature expression");
}

describe("M-0 stage-1 precondition and PROD preflight parity", () => {
  it("the migration checks exactly the seven affected tables, each with a pre-M-0 and a stage-1 signature", () => {
    expect(Object.keys(migrationSignatures()).sort()).toEqual([...TABLES].sort());
  });

  it("the preflight expects the same pre-M-0 signature for every table", () => {
    const m = migrationSignatures();
    const p = preflightSignatures();
    expect(Object.keys(p).sort()).toEqual([...TABLES].sort());
    for (const table of TABLES) expect(p[table]).toBe(m[table].pre);
  });

  it("both compute the signature with the identical expression (RLS flags, policies with roles, grants)", () => {
    const inMigration = signatureExpression(migration, "M0-AUTH-SIGNATURES (begin)", "k.name");
    const inPreflight = signatureExpression(preflight, "select 'A8 '", "v.name");
    expect(inPreflight).toBe(inMigration);
    expect(inMigration).toContain("relforcerowsecurity");
    expect(inMigration).toContain("unnest(p.roles)");
    expect(inMigration).toContain("role_table_grants");
  });

  it("only this migration's own policies are excluded from the signature, by exact name", () => {
    const expression = signatureExpression(migration, "M0-AUTH-SIGNATURES (begin)", "k.name");
    expect(expression).toContain("p.policyname not in (");
    expect(expression).not.toMatch(/like 'm0 %'/);
  });
});
