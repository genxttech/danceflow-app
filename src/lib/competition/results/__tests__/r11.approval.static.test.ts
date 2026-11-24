import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R-11 (static, no database; reads migration text): result approval controls. These tests do NOT execute SQL; the SQL suites that do
 * (test_T_competition_f2_results.sql, a4_minimum_integration, a5_exclusion, a6_withdrawal) are listed in the R-11 report.
 */
const mig = path.resolve(__dirname, "../../../supabase/migrations");
const f2 = fs.readFileSync(path.join(mig, "20270114090000_competition_f2_results_lifecycle.sql"), "utf8");
const start = f2.indexOf("function public.approve_competition_round_result");
const body = f2.slice(start, f2.indexOf("$$;", start + 50));

describe("R-11: approve_competition_round_result", () => {
  it("is manager-only (a chair, scorer or judge is refused)", () => {
    expect(body).toMatch(/v_role is distinct from 'manager'/);
  });

  it("refuses a stale result BEFORE the override branch, so an override reason can never approve a stale result", () => {
    const stale = body.lastIndexOf("COMP_RESULT_STALE");
    const override = body.indexOf("v_override :=");
    expect(stale).toBeGreaterThan(0);
    expect(override).toBeGreaterThan(stale);
  });

  it("the calculator may approve only with a reason of 1-500 characters; otherwise COMP_SECOND_APPROVER_REQUIRED", () => {
    expect(body).toMatch(/v_override := v_ver\.calculated_by = v_uid/);
    expect(body).toMatch(/COMP_SECOND_APPROVER_REQUIRED/);
    expect(body).toMatch(/length\(v_reason\) > 500/);
  });

  it("has no parameter or branch that overrides the minimum-two-couples rule, the withdrawal window or exclusion co-sign", () => {
    expect(body).not.toMatch(/COMP_ADVANCEMENT_BELOW_MINIMUM/);
    const a5 = fs.readFileSync(path.join(mig, "20270120094000_competition_cf1_a5_exclusion_action.sql"), "utf8");
    expect(a5).toMatch(/COMP_EXCLUSION_COSIGN_SAME_PERSON/);
    expect(a5).not.toMatch(/p_override/i);
  });

  it("is not executable by anon or public (service_role is NOT revoked here: see the R-11 report, flag 1)", () => {
    expect(f2).toMatch(/revoke all on function public\.approve_competition_round_result\(uuid, uuid, text, uuid\) from public, anon/i);
  });
});

/**
 * R-11 extension (owner 2026-11-24): D3 self-approval is retained for INITIAL approval only. These are static characterizations of the
 * CURRENT migration text; the two `it.fails` markers record release blockers (the tests PASS while the gap exists and will start failing, prompting removal of
 * the marker, once approve distinguishes initial from corrected results or requires a substantive reason). No SQL is executed.
 */
describe("R-11 extension: override scope, reason rules and audit", () => {
  it("the override is audited under its own event kind with actor, version, input hash and reason", () => {
    expect(body).toMatch(/'result_approval_override'/);
    expect(body).toMatch(/_compf2_event\([\s\S]*?v_uid[\s\S]*?v_reason/);
    expect(body).toMatch(/insert into public\.event_competition_result_approvals[\s\S]*?override_reason/);
  });

  it("the approvals row ties an override reason to approver = calculator by a CHECK constraint, and the table is insert-only", () => {
    expect(f2).toMatch(/event_competition_result_approvals_override_check/);
    expect(f2).toMatch(/'event_competition_result_approvals', 'event_competition_result_events'\] loop/);
  });

  it("the reason rule today is only: trimmed, non-blank, at most 500 characters (a 1-character reason is accepted)", () => {
    expect(body).toMatch(/v_reason text := nullif\(btrim\(coalesce\(p_override_reason, ''\)\), ''\)/);
    expect(body).not.toMatch(/_cf1_reason_is_substantive/);
  });

  // Both markers read only the F2 file; a later exact-text patch of approve would not flip them (see R-11 report section 10).
  it.fails("KNOWN BLOCKER RB-11.1: approve requires a SUBSTANTIVE override reason (as A5/A6 do via _cf1_reason_is_substantive)", () => {
    expect(body).toMatch(/if not public._cf1_reason_is_substantive(v_reason)/);
  });

  it.fails("KNOWN BLOCKER RB-11.2: approve distinguishes INITIAL approval from a corrected/recalculated result, so self-approval cannot be used after a correction", () => {
    expect(body).toMatch(/(if|and|or)[^;
]*(correction_open|result_invalidated)/i);
  });
});
