import { describe, expect, it } from "vitest";
import { correctionCosignPanel, parseCorrectionState, WAITING_FOR_COSIGN_TEXT } from "../correction";
import { hasResultMessage, resultErrorMessage } from "../messages";
import { errorText } from "../advancement";

const OPENER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const CAUSE = "00000000-0000-4000-8000-0000000000c1";

const open = (over: Record<string, unknown> = {}) => ({
  round_id: "r", correction_open: true, restricted: false, cosign: null,
  cause: { id: CAUSE, cause: "judge_entry_error", opened_by: OPENER },
  ...over,
});

describe("CF1 A7: correction co-sign panel", () => {
  it("is hidden when nothing is open, malformed, or the cause is an exclusion", () => {
    expect(correctionCosignPanel(parseCorrectionState(null), OPENER).kind).toBe("hidden");
    expect(correctionCosignPanel(parseCorrectionState({ correction_open: false, cause: null }), OPENER).kind).toBe("hidden");
    expect(correctionCosignPanel(parseCorrectionState(open({ correction_open: false })), OTHER).kind).toBe("hidden");
    expect(correctionCosignPanel(parseCorrectionState(open({ cause: { id: CAUSE, cause: "entry_exclusion", opened_by: OPENER } })), OTHER).kind).toBe("hidden");
    expect(correctionCosignPanel(parseCorrectionState(open({ restricted: true })), OTHER).kind).toBe("hidden");
  });
  it("tells the opener to wait", () => {
    expect(correctionCosignPanel(parseCorrectionState(open()), OPENER)).toEqual({ kind: "waiting", text: WAITING_FOR_COSIGN_TEXT });
  });
  it("offers the button to another manager or chair, carrying the cause id", () => {
    expect(correctionCosignPanel(parseCorrectionState(open()), OTHER)).toEqual({ kind: "can_cosign", causeId: CAUSE });
  });
  it("shows a confirmation with the co-signer role once co-signed", () => {
    const cosign = { id: "s1", cosigned_by: OTHER, role: "chair", at: "2026-11-01T00:00:00Z" };
    const mine = correctionCosignPanel(parseCorrectionState(open({ cosign })), OTHER);
    const theirs = correctionCosignPanel(parseCorrectionState(open({ cosign })), OPENER);
    expect(mine).toMatchObject({ kind: "cosigned" });
    expect((mine as { text: string }).text).toContain("you, as chair");
    expect((theirs as { text: string }).text).toContain("a different person, as chair");
  });
});

describe("CF1 A7: co-sign error copy", () => {
  it.each([
    "COMP_CORRECTION_COSIGN_REQUIRED", "COMP_CORRECTION_COSIGN_SAME_PERSON", "COMP_CORRECTION_COSIGN_NOT_REQUIRED",
    "COMP_CORRECTION_ALREADY_COSIGNED", "COMP_CORRECTION_NOT_OPEN", "COMP_CORRECTION_COSIGNER_FILED_BALLOT", "COMP_CORRECTION_COSIGNER_CONFLICT",
  ])("explains %s", (code) => {
    expect(hasResultMessage(code)).toBe(true);
    expect(resultErrorMessage(`${code}: raw`)).not.toMatch(/Reload the page and try again\.$/);
    expect(errorText({ message: `${code}: raw database text` })).not.toContain("raw database text");
  });
});
