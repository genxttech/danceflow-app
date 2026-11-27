import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOT_CALLED_BACK_LABEL } from "../engines/studioCallbackTally";

/**
 * R-09 (static, no database): the "Semi-final" label is part of the callback result that PV-1 recomputes and compares. It is hardcoded
 * in the TypeScript engine and twice in the PV-1 SQL, so a display-only relabel must NOT change any of the three. Reads migration text only.
 */
const sql = fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/20270215090000_competition_pv1_result_recompute.sql"), "utf8");

describe("R-09: the not-called-back label is persisted engine output", () => {
  it("the SQL recompute port uses exactly the label the TypeScript engine emits", () => {
    const labels = [...sql.matchAll(/jsonb_build_object\('label',\s*'([^']+)'\)/g)].map((m) => m[1]);
    expect(labels.length).toBe(2);
    for (const l of labels) expect(l).toBe(NOT_CALLED_BACK_LABEL);
  });

  it("the verifier function body compares the rebuilt output object with is distinct from (presence check scoped to _comppv1_verify; not a behavioral proof)", () => {
    const s = sql.indexOf("function public._comppv1_verify");
    const end = sql.indexOf("$$;", s + 100);
    expect(s).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(s);
    const body = sql.slice(s, end);
    expect(body).toMatch(/COMP_RESULT_RECOMPUTE_MISMATCH/);
    expect(body).toMatch(/'output'/);
    expect(body).toMatch(/is distinct from/);
  });

  it("PV-1 helper functions are not callable by API roles", () => {
    expect(sql).toMatch(/revoke all on function %s from public, anon, authenticated, service_role/i);
  });
});
