import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.join(process.cwd(), "src/lib/supabase/migrations");
const read = (name: string) => readFileSync(path.join(dir, name), "utf8");

const CORE = "20270301110000_competition_r15_eligibility_clearance_core";
const GATES = "20270301130000_competition_r15_executable_gates";
const GUARD = "20270301131000_competition_r15_eligibility_write_guard";
const S5_SLOT = "20270301120000";

describe("R-15 (S4) migration order and rollback safety", () => {
  it("timestamp order equals release order: S4 core < S5 < S4 gates < S4 guard", () => {
    const ts = [CORE, S5_SLOT, GATES, GUARD].map((name) => name.slice(0, 14));
    expect([...ts].sort()).toEqual(ts);
    for (const name of [CORE, GATES, GUARD]) {
      expect(existsSync(path.join(dir, `${name}.sql`))).toBe(true);
      expect(existsSync(path.join(dir, "rollback", `${name}_rollback.sql`))).toBe(true);
    }
  });

  it("no migration of this slice ships an S5 stub", () => {
    for (const name of [CORE, GATES, GUARD]) {
      expect(read(`${name}.sql`)).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\._comp_participant_age_clearance/i);
    }
  });

  it("the gates preflight requires S5 and the core calls S5 through the guarded, owner-checked bridge", () => {
    expect(read(`${GATES}.sql`)).toContain("_comp_participant_age_clearance(uuid)");
    expect(read(`${GATES}.sql`)).toMatch(/S5 age predicate \(20270301120000\) is not applied/);
    const core = read(`${CORE}.sql`);
    expect(core).toContain("proowner");
    expect(core).toMatch(/if not v_have or v_p\.competitor_id is null then\s+v_unknown := true;/);
  });

  it("the core rollback refuses while the gates or the write guard are installed (reverse release order)", () => {
    const rb = read(`rollback/${CORE}_rollback.sql`);
    for (const trigger of ["r15_guard_round_start", "r15_guard_heat_status", "r15_guard_heat_entry_clearance", "r15_guard_version_publish", "r15_guard_entry_eligibility_write"]) {
      expect(rb).toContain(trigger);
    }
    expect(rb).toContain("roll back 20270301130000 first");
    expect(rb).toMatch(/refused: eligibility determinations exist/);
  });

  it("the gates rollback restores the lenient predicate and refuses to patch ambiguously", () => {
    const rb = read(`rollback/${GATES}_rollback.sql`);
    expect(rb).toContain("_cf1_entry_refund_evidence_reason");
    expect(rb).toMatch(/rollback refused: cf1_od17_guard_heat_entry does not contain exactly one/);
  });

  it("no migration of this slice converts or deletes existing rows", () => {
    for (const name of [CORE, GATES, GUARD]) {
      const sql = read(`${name}.sql`);
      expect(sql).not.toMatch(/\bupdate\s+public\.event_competition_entries\b(?![\s\S]{0,40}where id = p_entry_id)/i);
      expect(sql).not.toMatch(/\bdelete\s+from\b/i);
      expect(sql).not.toMatch(/\btruncate\b/i);
    }
  });
});
