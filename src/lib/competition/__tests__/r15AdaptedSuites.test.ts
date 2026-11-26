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

const sqlTests = path.join(process.cwd(), "src/lib/supabase/migrations/sql-tests");
const sql = (name: string) => readFileSync(path.join(sqlTests, name), "utf8").replace(/\r\n/g, "\n");

describe("R-15 clearance seeding in suites on a Competition chain", () => {
  it("the shared publish helper seeds clearance for either owner role the suite runners use", () => {
    expect(sql("fixtures/competition_round_ready.sql")).toContain("current_user in ('postgres', 'supabase_admin')");
  });

  it("adapted suites obtain clearance only through the helper or the audited RPC, never by writing a determination or disabling a gate", () => {
    for (const name of [
      "test_T_competition_o1_day_of.sql",
      "test_T_competition_r2_entry_refunds.sql",
      "test_T_competition_r2_refund_write_gate.sql",
      "test_T_phase10d_floor_schedule.sql",
    ]) {
      const text = sql(name);
      expect(text).toContain("perform pg_temp.r15_clear_entries();");
      expect(text).not.toContain("event_competition_eligibility_determinations");
      expect(text).not.toMatch(/disable trigger r15_/i);
      // S5's date-of-birth fixture line is preserved
      expect(text).toContain("set date_of_birth = date '1985-06-15' where date_of_birth is null");
    }
  });

  it("the floor-schedule suite proves an unverified couple blocks publication before the organizer decides it", () => {
    const text = sql("test_T_phase10d_floor_schedule.sql");
    expect(text.indexOf("COMP_R15_PROVISIONAL_ASSIGNMENT")).toBeGreaterThan(0);
    expect(text.indexOf("COMP_R15_PROVISIONAL_ASSIGNMENT")).toBeLessThan(text.indexOf("perform public.set_competition_entry_eligibility(pg_temp.u('008002')"));
  });
});

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
