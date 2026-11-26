import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TW-4F slice E: a cheap static check (runs in CI, no database) that the migration and its rollback have intact PL/pgSQL dollar quoting. A shell or
 * string-replace edit once collapsed `$$` into a lone `$`, which only a database apply would otherwise reveal. Every `$tag$` delimiter must be paired, and
 * no `$` may remain outside a delimiter except as a regular-expression end anchor inside a string literal (`$'`). No CR characters either.
 */

const MIG = join(__dirname, "../../../supabase/migrations");
const FILES = [
  "20270224100000_twilio_emergency_subaccount_suspension.sql",
  "rollback/20270224100000_twilio_emergency_subaccount_suspension_rollback.sql",
];

export function dollarQuotingProblems(sql: string): string[] {
  const problems: string[] = [];
  const tags = sql.match(/\$[A-Za-z_]*\$/g) ?? [];
  const counts = new Map<string, number>();
  for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [t, n] of counts) if (n % 2 !== 0) problems.push(`unpaired delimiter ${t} (${n})`);
  sql.split("\n").forEach((line, i) => {
    const rest = line.replace(/\$[A-Za-z_]*\$/g, "").replace(/\$'/g, "");
    if (rest.includes("$")) problems.push(`line ${i + 1}: lone $ in: ${line.trim().slice(0, 80)}`);
  });
  return problems;
}

describe("20270224100000 dollar quoting", () => {
  for (const f of FILES) {
    it(`${f} has paired $$ delimiters, no lone $ and no CR`, () => {
      const sql = readFileSync(join(MIG, f), "utf8");
      expect(sql).not.toMatch(/\r/);
      expect(dollarQuotingProblems(sql)).toEqual([]);
    });
  }

  it("the checker catches the defect it exists for", () => {
    expect(dollarQuotingProblems("create function f() returns int language sql\nas $\n  select 1;\n$;\n").length).toBeGreaterThan(0);
    expect(dollarQuotingProblems("as $$ select 1; $$;\ndo $q$ begin end $q$;\ncheck (x ~ '^a$')\n")).toEqual([]);
    expect(dollarQuotingProblems("as $$\nselect 1;\nend $;\n").length).toBeGreaterThan(0);
  });
});
