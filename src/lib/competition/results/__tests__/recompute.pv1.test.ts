import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESULT_ERROR_CODES } from "../contract";
import { resultErrorMessage } from "../messages";

/**
 * PV-1 (owner decision 2026-11-10): calculate_competition_round recomputes the result in the database and refuses rows that differ
 * (COMP_RESULT_RECOMPUTE_MISMATCH) or a round its own calculation cannot verify (COMP_RESULT_RECOMPUTE_UNSUPPORTED). The app path is unchanged except
 * that both codes read as plain messages, never as a raw database error.
 */
describe("PV-1 recompute refusal copy", () => {
  it("both codes are known result codes with plain, specific copy", () => {
    for (const code of ["COMP_RESULT_RECOMPUTE_MISMATCH", "COMP_RESULT_RECOMPUTE_UNSUPPORTED"]) {
      expect(RESULT_ERROR_CODES as readonly string[]).toContain(code);
      const raw = `${code}: the submitted result differs from the database's own calculation of the locked ballots; nothing was saved.`;
      const text = resultErrorMessage(raw);
      expect(text, code).not.toMatch(/COMP_|database's own|::|SQL/i);
      expect(text, code).not.toBe(resultErrorMessage("COMP_SOMETHING_UNKNOWN: x"));
    }
  });

  it("the migration raises exactly these codes and the calculate RPC calls the verifier before any write", () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, "../../../supabase/migrations/20270215090000_competition_pv1_result_recompute.sql"), "utf8");
    expect(sql).toContain("raise exception 'COMP_RESULT_RECOMPUTE_MISMATCH:");
    expect(sql).toContain("raise exception 'COMP_RESULT_RECOMPUTE_UNSUPPORTED:");
    const insert = sql.indexOf("perform public._comppv1_verify(v_evidence, p_rows, v_warnings);");
    const nextVersion = sql.indexOf("select coalesce(max(v.version), 0) + 1 into v_next", insert);
    expect(insert).toBeGreaterThan(-1);
    expect(nextVersion).toBeGreaterThan(insert);
  });
});
