import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STUDIO_CUSTOM_V2_DEFAULTS as P } from "../studioCustomV2";
import { feedbackModesFor, feedbackOutputs, officialResultOutputs, offeringOutputs } from "../evaluation";
import { judgingSummary } from "../draft";

/** 10C.5: competitive adjudication, evaluator feedback and the official result are independent. */

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const COMPETITIVE = ["placement", "medal_threshold", "advancement_ranking", "registry_points", "team_placement", "rating"];

describe("feedback is independent of adjudication", () => {
  it("Non-Adjudicated does not imply no feedback", () => {
    expect(P.judging.non_adjudicated.official_result).toBe(false);
    expect(feedbackModesFor(P, "non_adjudicated")).toEqual(["none", "written", "written_plus_grade", "written_plus_score"]);
    expect(P.feedback.default).toBe("none");
  });

  it("all four Non-Adjudicated combinations produce feedback only, never an official result", () => {
    expect(offeringOutputs(P, "non_adjudicated", "none")).toEqual({ official: [], feedback: [] });
    expect(offeringOutputs(P, "non_adjudicated", "written")).toEqual({ official: [], feedback: [{ type: "critique_text", official: false }] });
    expect(offeringOutputs(P, "non_adjudicated", "written_plus_grade").feedback).toEqual([
      { type: "critique_text", official: false },
      { type: "grade", official: false },
    ]);
    expect(offeringOutputs(P, "non_adjudicated", "written_plus_score").feedback).toEqual([
      { type: "critique_text", official: false },
      { type: "numeric_score", official: false },
    ]);
    for (const mode of ["none", "written", "written_plus_grade", "written_plus_score"] as const) {
      expect(offeringOutputs(P, "non_adjudicated", mode).official).toEqual([]);
    }
  });

  it("a feedback grade or score is never a placement, ranking, advancement, medal threshold or official result", () => {
    for (const option of P.feedback.options) {
      for (const output of feedbackOutputs(P, option.key)) {
        expect(output.official).toBe(false);
        expect(COMPETITIVE).not.toContain(output.type);
      }
    }
    expect(P.feedback.note).toContain("never becomes a placement, ranking, advancement, medal threshold or official result");
  });

  it("Adjudicated offerings produce an official result and may also carry feedback", () => {
    expect(offeringOutputs(P, "placements", "none")).toEqual({ official: [{ type: "placement", primary: true, official: true }], feedback: [] });
    expect(offeringOutputs(P, "medal_marks", "written")).toEqual({
      official: [{ type: "placement", primary: true, official: true }],
      feedback: [{ type: "critique_text", official: false }],
    });
    expect(officialResultOutputs(P.judging.ratings)).toEqual([{ type: "rating", primary: true, official: true }]);
  });

  it("existing Medal Marks / Placements / ratings semantics are unchanged", () => {
    expect(judgingSummary(P.judging.medal_marks)).toBe("Adjudicated · Judge input: Medal Marks · Final result: Placement");
    expect(judgingSummary(P.judging.placements)).toBe("Adjudicated · Placements");
    expect(judgingSummary(P.judging.ratings)).toBe("Adjudicated · Gold / Silver / Bronze ratings");
    expect(judgingSummary(P.judging.non_adjudicated)).toBe("Non-Adjudicated · Performance / exhibition · No official competitive result");
    for (const key of ["medal_marks", "placements", "ratings"]) expect(P.judging[key].official_result).toBe(true);
  });

  it("organizer wording centers on the official result, not on whether anyone evaluates", () => {
    expect(P.adjudication.non_adjudicated.description).toBe("No official competitive placement or result. Dancers can still receive feedback from an evaluator.");
    expect(P.judging.non_adjudicated.description).not.toMatch(/without formal judging/i);
    const wizard = readFileSync(join(ROOT, "src/app/app/events/[id]/competition/new/CompetitionSetupWizard.tsx"), "utf8");
    expect(wizard).toContain("Will this produce an official competitive result?");
    expect(wizard).not.toMatch(/Will judges evaluate|Is it adjudicated\?/);
    expect(wizard).toContain("never becomes an official result");
  });
});
