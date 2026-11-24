// OD-28 (owner decision 2026-11-23, Option B): team offerings are DanceFlow Studio/Custom formats.
// Relabelling must not change identifiers, team size, pricing, registration shape or scoring selection.
import { describe, expect, it } from "vitest";
import { STUDIO_CUSTOM_V3_DEFAULTS as P } from "../studioCustomV3";
import { STUDIO_CUSTOM_DISPLAY, withStudioCustomDisplayLabels } from "../studioCustomDisplay";
import { chooseAdjudication, chooseStyle, choosePurpose, deriveDraft, initialAnswers, updateFormat, setPricing } from "../draft";
import { allowedRolesForFormat, participantShapeErrors } from "../../participantRoles";
import { LEGACY_SCORING_MAP, resolveLegacyScoringMethod } from "../../scoring/registry";
import { TEST_EVENT, withDivisions, withOfferings } from "./divisionTestHelpers";

const D = withStudioCustomDisplayLabels(P);
const TEAM_KEYS = ["team", "ndca_formation", "ndca_team_match", "studio_team"];
const BODY_NAMES = /\b(NDCA|UCWDC|WSDC|WDC|USDC)\b|Formation Teams/i;
const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 3, requestKey: "request-key-0001" };

describe("OD-28 team offerings read as DanceFlow Studio/Custom", () => {
  it("labels carry no governing-body name and keep the persisted ids", () => {
    expect(Object.keys(D.categoryTypes)).toEqual(Object.keys(P.categoryTypes));
    expect(D.categoryTypes.ndca_formation.label).toBe("Studio/Custom: Formation team");
    expect(D.categoryTypes.ndca_team_match.label).toBe("Studio/Custom: Team match");
    expect(D.categoryTypes.team.label).toBe("Studio/Custom: Team");
    expect(D.categoryTypes.studio_team.label).toBe("Studio/Custom: Team");
    for (const key of TEAM_KEYS) {
      expect(D.categoryTypes[key].label).toMatch(/^Studio\/Custom: /);
      expect(`${D.categoryTypes[key].label} ${D.categoryTypes[key].description} ${D.categoryTypes[key].eligibility_note ?? ""}`).not.toMatch(BODY_NAMES);
      expect(STUDIO_CUSTOM_DISPLAY[key].entryFormat).toBe("team");
    }
    // The old names are what this removes.
    expect(P.categoryTypes.ndca_formation.label).toBe("Formation");
  });

  it("team size 2 to 100, roles, pairing, pricing models and every non-display field are unchanged", () => {
    for (const key of TEAM_KEYS) {
      const { label: _l, description: _d, ...before } = P.categoryTypes[key];
      const { label: _l2, description: _d2, ...after } = D.categoryTypes[key];
      expect(after, key).toEqual(before);
      expect(D.categoryTypes[key]).toMatchObject({ entry_format: "team", minimum_participants: 2, maximum_participants: 100, participant_roles: ["team_member"], dance_roles: "none", pairing_mode: "team", pricing_models: ["per_entry", "included", "free", "later"], default_pricing: "per_entry" });
    }
    expect(D.categoryTypes.ndca_formation.contest_type).toBe("formation");
    expect(D.categoryTypes.ndca_team_match.kind).toBe("regular");
  });

  it("registration shape rules are the generic team rules (no body restriction added)", () => {
    expect(allowedRolesForFormat("team")).toEqual(["team_member"]);
    // 2 and 100 members pass the shape check; the team format never takes lead/follow.
    expect(participantShapeErrors("team", "formation", ["team_member", "team_member"], ["", ""])).toEqual([]);
    expect(participantShapeErrors("team", "formation", Array(100).fill("team_member"), Array(100).fill(""))).toEqual([]);
    expect(participantShapeErrors("team", "formation", ["team_member", "team_member"], ["leader", "follower"]).length).toBeGreaterThan(0);
  });

  it("pricing derives identically and the payload carries ids only", () => {
    let answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, TEST_EVENT), P, "competition_showcase"), P, "ballroom"), "ballroom", "adjudicated");
    answers = withOfferings(answers, P, "ballroom", ["ndca_formation", "ndca_team_match"]);
    answers = updateFormat(answers, "ballroom", "ndca_formation", { amount: "150" });
    answers = setPricing(answers, P, "ballroom", "ndca_team_match", "free");
    const draft = deriveDraft(withDivisions(answers, P), P, CONTEXT);
    expect(draft.errors).toEqual({});
    const cats = draft.payload?.programs[0].categories ?? [];
    expect(cats.map((c) => [c.type, c.pricing])).toEqual([
      ["ndca_formation", { model: "per_entry", amount: 150 }],
      ["ndca_team_match", { model: "free", amount: null }],
    ]);
    expect(draft.programs[0].categories.map((c) => c.label)).toEqual(["Studio/Custom: Formation team", "Studio/Custom: Team match"]);
    expect(JSON.stringify(draft.payload)).not.toMatch(/Studio\/Custom:|Formation Teams/);
  });
});

describe("OD-28 scoring capability trace (findings pinned; no capability is added)", () => {
  const roundScoring = (judging: string) => (P.judging as Record<string, { rounds: Array<{ scoring_method: string }> }>)[judging].rounds[0].scoring_method;

  it("team offerings are never given their own scoring: they inherit the style's judging method", () => {
    for (const key of TEAM_KEYS) expect(P.categoryTypes[key].adjudication_override).toBe(false);
    expect(P.programs.ballroom.judging_options).toEqual(["placements"]);
    expect(P.programs.country.judging_options).toEqual(["medal_marks"]);
    expect(P.programs.custom.judging_options).toEqual(["placements", "ratings"]);
  });

  it("Formation and Team Match (Ballroom, Placements) resolve to the Studio ordinal majority engine, not an NDCA cumulative-point system", () => {
    expect(roundScoring("placements")).toBe("ordinal_majority");
    const resolved = resolveLegacyScoringMethod("ordinal_majority");
    expect(resolved.ok).toBe(true);
    expect(LEGACY_SCORING_MAP.ordinal_majority.key).toBe("studio_ordinal_majority");
  });

  it("Country Team (Medal Marks) and a Studio team scored with Ratings fail closed: no result can be calculated", () => {
    expect(roundScoring("medal_marks")).toBe("custom");
    expect(resolveLegacyScoringMethod("custom")).toMatchObject({ ok: false, code: "COMP_METHOD_LEGACY_UNMAPPED" });
    expect(roundScoring("ratings")).toBe("proficiency_rating");
    expect(resolveLegacyScoringMethod("proficiency_rating")).toMatchObject({ ok: false, code: "COMP_ENGINE_NOT_AVAILABLE" });
  });
});
