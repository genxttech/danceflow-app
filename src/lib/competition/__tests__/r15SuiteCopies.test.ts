import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sqlTests = path.join(process.cwd(), "src/lib/supabase/migrations/sql-tests");
const sql = (name: string) => readFileSync(path.join(sqlTests, name), "utf8").replace(/\r\n/g, "\n");
const blob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

// Labelled copies of released suites for a chain with R-15: [source, source blob, copy, source is on this branch].
const COPIES = [
  ["test_T_competition_cf1_a5_exclusion.sql", "bf0e2ce896b11ea7f8f96631bc7968128b59c848", "test_T_competition_cf1_a5_exclusion_with_r15.sql", true],
  ["test_T_competition_cf1_a5_concurrency.sh", "287fff40ea019b72a4e7776a8b6c8a15b1dcbdcb", "test_T_competition_cf1_a5_concurrency_with_r15.sh", true],
  ["test_T_competition_cf1_a5_concurrency_with_s6.sh", "446a681269651922ee45a5227006a22764d70d00", "test_T_competition_cf1_a5_concurrency_with_s6_with_r15.sh", false],
  ["test_T_competition_cf1_callback_final_advancement.sql", "8b44c385cb875fc38287ca32748969e5ce3dc3d1", "test_T_competition_cf1_callback_final_advancement_with_r15.sql", false],
  ["test_T_competition_cf1_rb3r_reconciliation.sql", "6ee17b31901da4f5825426d520db61388ce42ab9", "test_T_competition_cf1_rb3r_reconciliation_with_r15.sql", true],
  ["test_T_competition_cf1_rb3r_concurrency.sh", "9e101e805d239f9a5b1dde9bce57e204ddaeef43", "test_T_competition_cf1_rb3r_concurrency_with_r15.sh", true],
  ["test_T_phase10a_competition_foundation.sql", "491b091b37dc540ffe01a7e5faa9019e3f1b8ed6", "test_T_phase10a_competition_foundation_with_r15.sql", true],
] as const;

const VERDICT = /SUITE (PASS|FAIL)|CONCURRENCY (PASS|FAIL)|CONCURRENCY TALLY: \$pass/;
// The only source lines a copy may replace, besides its verdict lines (Phase 10A's direct eligibility write).
const REPLACED = [
  "select pg_temp.expect_ok('manager direct entry update still audits',",
  "  $q$update public.event_competition_entries set eligibility_status = 'needs_review' where id = '00000000-0000-0000-0000-0a10a0007003'$q$);",
  "select pg_temp.chk('direct entry update produced eligibility history',",
];

describe("R-15 labelled suite copies", () => {
  const readme = sql("adapted/README.md");

  it.each(COPIES)("%s has a labelled copy, listed with both blobs", (source, sourceBlob, copy) => {
    const text = sql(copy);
    expect(text).toContain("ADAPTED COPY for R-15");
    expect(text).toContain(sourceBlob);
    expect(text).toContain("ADAPTED COPY R-15: ");
    expect(text).not.toMatch(/disable trigger r15_/i);
    expect(text).not.toMatch(/insert into public\.event_competition_eligibility_determinations/i);
    expect(readme).toContain(`| \`${source}\` | \`${sourceBlob}\` | \`${copy}\` | \`${blob(text)}\` |`);
  });

  it.each(COPIES.filter((entry) => entry[3]))("%s is unchanged and its lines are all still in the copy, in order", (source, sourceBlob, copy) => {
    const original = sql(source);
    expect(blob(original)).toBe(sourceBlob);
    const target = sql(copy).split("\n");
    const missing: string[] = [];
    let at = 0;
    for (const line of original.split("\n")) {
      if (REPLACED.includes(line) || (VERDICT.test(line) && !/^(--|#)/.test(line))) continue;
      const found = target.indexOf(line, at);
      if (found < 0) missing.push(line);
      else at = found + 1;
    }
    expect(missing).toEqual([]);
  });
});
