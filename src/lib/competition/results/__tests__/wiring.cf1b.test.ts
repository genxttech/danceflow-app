import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = join(__dirname, "..", "..", "..", "..", "app", "app", "events", "[id]", "competition");
const read = (...parts: string[]) => readFileSync(join(app, ...parts), "utf8");

describe("CF1 B: action wiring (static)", () => {
  const results = read("results", "actions.ts");

  it("every results action reaches the database through the retry-once wrapper and maps errors with the shared copy", () => {
    expect(results).toMatch(/rpc: withRetryOnce\(/);
    expect(results).not.toMatch(/resultErrorMessage\(error\.message\)/);
  });

  it("calls the A0 / A5 / A6 RPCs by their contract names and argument names", () => {
    expect(results).toContain('"apply_competition_round_advancement"');
    expect(results).toMatch(/p_round_id: roundId,\s*p_result_version_id: versionId,\s*p_request_id: requestId/);
    expect(results).toContain('"request_round_exclusion"');
    expect(results).toMatch(/p_reason_kind: kind/);
    expect(results).toContain('"cosign_round_exclusion"');
    expect(results).toContain('p_decision_id: decisionId');
    expect(results).toContain('"request_round_exclusion_reversal"');
    expect(results).toContain('"cosign_round_exclusion_reversal"');
    expect(results).toContain('"withdraw_advanced_entry_from_final"');
    expect(results).toContain('"reinstate_withdrawn_entry_to_final"');
    expect(results).toContain('"cosign_final_withdrawal_request"');
  });

  it("every new action passes a request id from the form and a reason where the contract requires one", () => {
    for (const name of ["applyAdvancementAction", "requestExclusionAction", "cosignExclusionAction", "requestExclusionReversalAction", "cosignExclusionReversalAction", "requestFinalWithdrawalAction", "cosignFinalWithdrawalAction"]) {
      const body = results.slice(results.indexOf(`export async function ${name}`));
      const end = body.indexOf("\nexport async function", 10);
      expect(body.slice(0, end === -1 ? undefined : end), name).toMatch(/uuid\(formData, "requestId"\)/);
    }
    expect(results).toMatch(/validateExclusionReason/);
    expect(results).toMatch(/withdrawalReasonLooksSubstantive/);
  });

  it("the ballots actions (lock-ballots among them) retry once and use the CF1 copy for codes the ballot map does not know", () => {
    const ballots = read("ballots", "actions.ts");
    expect(ballots).toMatch(/withRetryOnce\(/);
    expect(ballots).toMatch(/actionErrorMessage\(result\.error\)/);
    expect(ballots).toContain('"lock_competition_round_ballots"');
  });

  it("the schedule capacity action uses the reasoned RPC (the two-argument form always refuses) and the schedule form asks for a reason", () => {
    const schedule = read("schedule", "actions.ts");
    expect(schedule).toContain('"set_competition_round_heat_capacity"');
    expect(schedule).toMatch(/p_reason: reason,\s*p_request_id: requestId/);
    expect(schedule).toMatch(/withRetryOnce\(/);
    expect(read("schedule", "page.tsx")).toMatch(/name="reason"/);
  });

  it("the round page only reads CF1 data for a manager and shows the review's excluded section to everyone", () => {
    const page = read("results", "[roundId]", "page.tsx");
    expect(page).toMatch(/isManager\s*\?\s*await Promise\.all/);
    expect(page).toContain("<ExcludedSection excluded={excluded} />");
    expect(page).toMatch(/isManager && isCallbackPreliminary/);
    expect(page).toMatch(/isManager && isCallbackFinal/);
  });
});
