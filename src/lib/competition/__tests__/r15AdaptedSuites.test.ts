import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.join(process.cwd(), "src/lib/supabase/migrations/sql-tests/adapted");
const lines = readFileSync(path.join(dir, "r15-u18-u18s-jc1-clearance-hook.patch"), "utf8").replace(/\r\n/g, "\n").split("\n");

const HOOK = [
  "-- S4/R-15: the seeded couples get an organizer determination through set_competition_entry_eligibility before they are placed (fixtures/r15_clear_entries.sql).",
  "do $r15$",
  "begin",
  "  if to_regprocedure('pg_temp.r15_clear_entries(uuid)') is not null then",
  "    perform pg_temp.r15_clear_entries();",
  "  end if;",
  "end $r15$;",
];

describe("R-15 adapted copies of the pinned U18 / U18-S / JC1 suites", () => {
  it("touches exactly the three released suites", () => {
    const files = lines.filter((line) => line.startsWith("+++ ")).map((line) => path.basename(line.slice(4)));
    expect(files.sort()).toEqual([
      "test_T_competition_jc1_inactive_judge_absent.sql",
      "test_T_competition_u18_heat_entry_status_guard.sql",
      "test_T_competition_u18s_heat_entry_scratch_audit.sql",
    ]);
  });

  it("removes nothing and adds only the clearance block, four times", () => {
    expect(lines.filter((line) => line.startsWith("-") && !line.startsWith("--- "))).toEqual([]);
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).map((line) => line.slice(1));
    expect(added).toEqual([...HOOK, ...HOOK, ...HOOK, ...HOOK]);
  });
});
