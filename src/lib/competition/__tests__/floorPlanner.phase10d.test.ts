import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeFloorSchedule,
  buildFloorPlan,
  checkScoringHeatMove,
  DEFAULT_SCORING_HEAT_CAPACITY,
  EXCLUSIVE_CONTEST_TYPES,
  isSchedulableEntry,
  musicKeyFor,
  toApplyPayload,
  type PlannerInput,
} from "@/lib/competition/floorPlanner";
import { activeNavKey } from "@/lib/competition/workspaceNav";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const MIGRATION = read("src/lib/supabase/migrations/20261111090000_phase10d_heats_floor_schedule.sql");

/** A small competition: ProAm (per dance), Couples (per dance), ProPro, Team, J&J, Showcase. */
function fixture(): PlannerInput {
  const contests = [
    { id: "cProAm", name: "ProAm", contest_type: "single_dance", sort_order: 1 },
    { id: "cCouples", name: "Couples", contest_type: "single_dance", sort_order: 2 },
    { id: "cProPro", name: "ProPro", contest_type: "single_dance", sort_order: 3 },
    { id: "cTeam", name: "Team", contest_type: "team", sort_order: 4 },
    { id: "cJJ", name: "Jack and Jill", contest_type: "jack_and_jill", sort_order: 5 },
    { id: "cShow", name: "Showcase", contest_type: "showdance", sort_order: 6 },
  ];
  const rules = [
    { contest_id: "cProAm", dance_selection_mode: "individual" },
    { contest_id: "cCouples", dance_selection_mode: "individual" },
    { contest_id: "cProPro", dance_selection_mode: "individual" },
    { contest_id: "cTeam", dance_selection_mode: "routine" },
    { contest_id: "cJJ", dance_selection_mode: "prescribed_set" },
    { contest_id: "cShow", dance_selection_mode: "routine" },
  ];
  const divisions = [
    { id: "dNew", name: "Newcomer ProAm", contest_id: "cProAm", program_id: "p", sort_order: 1 },
    { id: "dInt", name: "Intermediate ProAm", contest_id: "cProAm", program_id: "p", sort_order: 2 },
    { id: "dBronze", name: "Bronze Couples", contest_id: "cCouples", program_id: "p", sort_order: 1 },
    { id: "dPP", name: "ProPro I", contest_id: "cProPro", program_id: "p", sort_order: 1 },
    { id: "dTeam", name: "Team Open", contest_id: "cTeam", program_id: "p", sort_order: 1 },
    { id: "dJJ", name: "J&J Novice", contest_id: "cJJ", program_id: "p", sort_order: 1 },
    { id: "dShow", name: "Showcase Open", contest_id: "cShow", program_id: "p", sort_order: 1 },
  ];
  const rounds = divisions.map((division) => ({ id: `r-${division.id}`, division_id: division.id, sequence_number: 1, round_type: "final", configuration: {} }));
  const dances = [
    { id: "nTwo", dance_key: "two_step", name: "Two Step" },
    { id: "nWaltz", dance_key: "waltz", name: "Waltz" },
    { id: "nWcs", dance_key: "west_coast_swing", name: "West Coast Swing" },
  ];
  const offerings = [
    { id: "oNewTwo", division_id: "dNew", dance_id: "nTwo", sort_order: 1 },
    { id: "oNewWaltz", division_id: "dNew", dance_id: "nWaltz", sort_order: 2 },
    { id: "oIntTwo", division_id: "dInt", dance_id: "nTwo", sort_order: 1 },
    { id: "oBronzeTwo", division_id: "dBronze", dance_id: "nTwo", sort_order: 1 },
    { id: "oPPTwo", division_id: "dPP", dance_id: "nTwo", sort_order: 1 },
    { id: "oJJ", division_id: "dJJ", dance_id: "nWcs", sort_order: 1 },
  ];
  const entry = (id: string, division: string, name: string, number: string, status = "confirmed", eligibility = "eligible") => ({
    id, division_id: division, display_name: name, entry_number: number, status, eligibility_status: eligibility,
  });
  const entries = [
    entry("e1", "dNew", "Sam / Pat", "101"),
    entry("e2", "dInt", "Sue / Pat", "102"),
    entry("e3", "dBronze", "Alex / Bo", "103"),
    entry("e12", "dBronze", "Alex / Cal", "112"),
    entry("e4", "dPP", "Quinn / Ivy", "104"),
    entry("e5", "dPP", "Rae / Ivy", "105"),
    entry("e6", "dTeam", "Spinners", "106"),
    entry("e7", "dJJ", "Jo", "107"),
    entry("e8", "dShow", "Cy", "108"),
    entry("e9", "dNew", "Withdrawn", "109", "withdrawn"),
    entry("e10", "dNew", "Ineligible", "110", "confirmed", "ineligible"),
    entry("e11", "dBronze", "Pending", "111", "pending", "unverified"),
    entry("e13", "dNew", "Waitlisted", "113", "waitlisted"),
  ];
  const twoStep = { dNew: "oNewTwo", dInt: "oIntTwo", dBronze: "oBronzeTwo", dPP: "oPPTwo" } as Record<string, string>;
  const entryDances = entries.filter((item) => twoStep[item.division_id]).map((item) => ({ entry_id: item.id, division_dance_id: twoStep[item.division_id], status: "registered" }));
  const p = (entryId: string, competitorId: string, name: string) => ({ entry_id: entryId, competitor_id: competitorId, display_name: name });
  const participants = [
    p("e1", "kSam", "Sam One"), p("e1", "kPat", "Pat Pro"),
    p("e2", "kSue", "Sue Two"), p("e2", "kPat", "Pat Pro"),
    p("e3", "kAlex", "Alex Morgan"), p("e3", "kBo", "Bo Bee"),
    p("e12", "kAlex", "Alex Morgan"), p("e12", "kCal", "Cal Cee"),
    p("e4", "kQuinn", "Quinn Pro"), p("e4", "kIvy", "Ivy Instructor"),
    p("e5", "kRae", "Rae Pro"), p("e5", "kIvy", "Ivy Instructor"),
    p("e6", "kTom", "Tom Team"), p("e6", "kAlex", "Alex Morgan"),
    p("e7", "kJo", "Jo Jill"),
    p("e8", "kCy", "Cy Solo"),
    p("e9", "kCal", "Cal Cee"), p("e10", "kCal", "Cal Cee"), p("e11", "kCal", "Cal Cee"), p("e13", "kCal", "Cal Cee"),
  ];
  return { contests, rules, divisions, rounds, dances, offerings, entries, entryDances, participants };
}

function placementOf(plan: ReturnType<typeof buildFloorPlan>) {
  const where = new Map<string, number>();
  for (const floor of plan.floorHeats) for (const heat of floor.scoringHeats) for (const entryId of heat.entryIds) where.set(entryId, floor.number);
  return where;
}

describe("10D floor plan generation", () => {
  it("only confirmed, not-ineligible entries are scheduled (withdrawn, pending, waitlisted, ineligible excluded)", () => {
    expect(isSchedulableEntry({ status: "confirmed", eligibility_status: "eligible" })).toBe(true);
    expect(isSchedulableEntry({ status: "confirmed", eligibility_status: "unverified" })).toBe(true);
    for (const status of ["pending", "waitlisted", "withdrawn", "disqualified", "complete"]) {
      expect(isSchedulableEntry({ status, eligibility_status: "eligible" })).toBe(false);
    }
    expect(isSchedulableEntry({ status: "confirmed", eligibility_status: "ineligible" })).toBe(false);
    const placed = placementOf(buildFloorPlan(fixture()));
    for (const id of ["e9", "e10", "e11", "e13"]) expect(placed.has(id)).toBe(false);
    expect(buildFloorPlan(fixture()).skippedEntryCount).toBe(4);
  });

  it("a final-only division generates a scoring heat in its final round", () => {
    const plan = buildFloorPlan(fixture());
    const newcomer = plan.floorHeats.flatMap((floor) => floor.scoringHeats).find((heat) => heat.divisionId === "dNew")!;
    expect(newcomer).toMatchObject({ roundId: "r-dNew", heatNumber: 1, danceIds: ["nTwo"], entryIds: ["e1"], musicKey: "dance:two_step" });
  });

  it("same-dance divisions share a floor heat; different dances and own-music items never do", () => {
    const plan = buildFloorPlan(fixture());
    for (const floor of plan.floorHeats) {
      expect(new Set(floor.scoringHeats.map((heat) => heat.musicKey)).size).toBe(1);
      if (floor.musicKey.startsWith("exclusive:")) expect(floor.scoringHeats).toHaveLength(1);
    }
    const twoStepFloors = plan.floorHeats.filter((floor) => floor.musicKey === "dance:two_step");
    expect(twoStepFloors.some((floor) => floor.scoringHeats.length > 1)).toBe(true);
    expect(plan.floorHeats.find((floor) => floor.musicKey === "dance:west_coast_swing")!.scoringHeats.map((heat) => heat.divisionId)).toEqual(["dJJ"]);
  });

  it("nobody is on the floor twice: shared ProAm professional, ProPro instructor, couples dancer, team member", () => {
    const input = fixture();
    const plan = buildFloorPlan(input);
    const placed = placementOf(plan);
    expect(placed.get("e1")).not.toBe(placed.get("e2")); // Pat Pro in two ProAm divisions
    expect(placed.get("e4")).not.toBe(placed.get("e5")); // Ivy instructs two ProPro entries
    expect(placed.get("e3")).not.toBe(placed.get("e12")); // Alex in two Bronze Couples entries
    expect(placed.get("e6")).not.toBe(placed.get("e3")); // Alex is also on the team
    const summaries = analyzeFloorSchedule({
      floorHeats: plan.floorHeats.map((floor) => ({ id: `f${floor.number}`, heat_number: floor.number, planned_start_at: null })),
      scoringHeats: plan.floorHeats.flatMap((floor) => floor.scoringHeats.map((heat, index) => ({ id: `f${floor.number}-${index}`, floor_heat_id: `f${floor.number}`, division_id: heat.divisionId, name: heat.name, musicKey: heat.musicKey, musicLabel: heat.musicLabel }))),
      heatEntries: plan.floorHeats.flatMap((floor) => floor.scoringHeats.flatMap((heat, index) => heat.entryIds.map((entryId) => ({ heat_id: `f${floor.number}-${index}`, entry_id: entryId, status: "scheduled" })))),
      participants: input.participants,
    });
    expect(summaries.flatMap((summary) => summary.problems)).toEqual([]);
  });

  it("splits a division into scoring heats by capacity (default 8, editable per round) without double-booking", () => {
    const input = fixture();
    input.entries = Array.from({ length: 9 }, (_, index) => ({ id: `x${index}`, division_id: "dBronze", display_name: `Couple ${index}`, entry_number: String(200 + index), status: "confirmed", eligibility_status: "eligible" }));
    input.entryDances = input.entries.map((entry) => ({ entry_id: entry.id, division_dance_id: "oBronzeTwo", status: "registered" }));
    input.participants = input.entries.flatMap((entry, index) => [{ entry_id: entry.id, competitor_id: `lead${index}`, display_name: `Lead ${index}` }, { entry_id: entry.id, competitor_id: `follow${index}`, display_name: `Follow ${index}` }]);
    expect(DEFAULT_SCORING_HEAT_CAPACITY).toBe(8);
    const sizes = (plan: ReturnType<typeof buildFloorPlan>) => plan.floorHeats.flatMap((floor) => floor.scoringHeats).map((heat) => heat.entryIds.length);
    expect(sizes(buildFloorPlan(input))).toEqual([8, 1]);
    input.rounds = input.rounds.map((round) => (round.division_id === "dBronze" ? { ...round, configuration: { max_entries_per_heat: 4 } } : round));
    expect(sizes(buildFloorPlan(input))).toEqual([4, 4, 1]);
    const names = buildFloorPlan(input).floorHeats.flatMap((floor) => floor.scoringHeats).map((heat) => heat.name);
    expect(names).toEqual(["Bronze Couples — Two Step (1 of 3)", "Bronze Couples — Two Step (2 of 3)", "Bronze Couples — Two Step (3 of 3)"]);
  });

  it("Jack & Jill entries stay one-person entries placed in their round (no stored pairs)", () => {
    const plan = buildFloorPlan(fixture());
    const jj = plan.floorHeats.flatMap((floor) => floor.scoringHeats).find((heat) => heat.divisionId === "dJJ")!;
    expect(jj.entryIds).toEqual(["e7"]);
    expect(JSON.stringify(toApplyPayload(plan))).not.toMatch(/pair/i);
  });

  it("empty divisions and divisions without entries produce nothing; missing rounds are explained", () => {
    const input = fixture();
    input.entries = input.entries.filter((entry) => entry.division_id !== "dInt");
    expect(buildFloorPlan(input).floorHeats.flatMap((floor) => floor.scoringHeats).some((heat) => heat.divisionId === "dInt")).toBe(false);
    input.rounds = input.rounds.filter((round) => round.division_id !== "dShow");
    expect(buildFloorPlan(input).notes).toContain("Showcase Open has no round yet, so its entries were not scheduled.");
    expect(buildFloorPlan({ ...fixture(), entries: [] }).floorHeats).toEqual([]);
  });

  it("is deterministic and independent of input order", () => {
    const one = buildFloorPlan(fixture());
    const shuffled = fixture();
    shuffled.entries.reverse();
    shuffled.participants.reverse();
    shuffled.divisions.reverse();
    shuffled.offerings.reverse();
    expect(buildFloorPlan(shuffled)).toEqual(one);
    expect(buildFloorPlan(fixture())).toEqual(one);
  });

  it("numbers floor heats 1..n and produces the apply payload shape", () => {
    const plan = buildFloorPlan(fixture());
    expect(plan.floorHeats.map((floor) => floor.number)).toEqual(plan.floorHeats.map((_, index) => index + 1));
    const payload = toApplyPayload(plan);
    expect(Object.keys(payload.floorHeats[0].scoringHeats[0]).sort()).toEqual(["danceIds", "divisionId", "entryIds", "heatNumber", "name", "roundId"]);
  });
});

describe("10D music/run compatibility mirrors the database", () => {
  it("routine modes, own-music contest types and unknown dances are exclusive", () => {
    expect(musicKeyFor({ heatKey: "h", contestType: "single_dance", selectionMode: "individual", danceKeys: ["Two_Step "] })).toBe("dance:two_step");
    expect(musicKeyFor({ heatKey: "h", contestType: "jack_and_jill", selectionMode: "prescribed_set", danceKeys: ["two_step", "waltz"] })).toBe("set:two_step,waltz");
    expect(musicKeyFor({ heatKey: "h", contestType: "single_dance", selectionMode: "routine", danceKeys: ["two_step"] })).toBe("exclusive:h");
    expect(musicKeyFor({ heatKey: "h", contestType: "spotlight", selectionMode: "prescribed_set", danceKeys: ["two_step"] })).toBe("exclusive:h");
    expect(musicKeyFor({ heatKey: "h", contestType: "single_dance", selectionMode: "individual", danceKeys: [] })).toBe("exclusive:h");
  });

  it("uses the same exclusive contest types and routine modes as the SQL helper", () => {
    expect(MIGRATION).toContain(`coalesce(c.contest_type, '') in (${EXCLUSIVE_CONTEST_TYPES.map((type) => `'${type}'`).join(", ")})`);
    expect(MIGRATION).toContain("coalesce(r.dance_selection_mode, '') in ('routine', 'none')");
    expect(MIGRATION).toContain("v_entry.status <> 'confirmed' or v_entry.eligibility_status = 'ineligible'");
    expect(MIGRATION).toContain("coalesce(nullif(v_round.configuration->>'max_entries_per_heat', '')::integer, 8)");
  });
});

describe("10D organizer moves", () => {
  const input = fixture();
  const floorHeats = [1, 2, 3].map((number) => ({ id: `f${number}`, heat_number: number, planned_start_at: null }));
  const scoringHeats = [
    { id: "hNew", floor_heat_id: "f1", division_id: "dNew", name: "Newcomer ProAm — Two Step", musicKey: "dance:two_step", musicLabel: "Two Step" },
    { id: "hInt", floor_heat_id: "f2", division_id: "dInt", name: "Intermediate ProAm — Two Step", musicKey: "dance:two_step", musicLabel: "Two Step" },
    { id: "hBronze", floor_heat_id: "f2", division_id: "dBronze", name: "Bronze Couples — Two Step", musicKey: "dance:two_step", musicLabel: "Two Step" },
    { id: "hJJ", floor_heat_id: "f3", division_id: "dJJ", name: "J&J Novice", musicKey: "dance:west_coast_swing", musicLabel: "West Coast Swing" },
  ];
  const heatEntries = [
    { heat_id: "hNew", entry_id: "e1", status: "scheduled" },
    { heat_id: "hInt", entry_id: "e2", status: "scheduled" },
    { heat_id: "hBronze", entry_id: "e3", status: "scheduled" },
    { heat_id: "hJJ", entry_id: "e7", status: "scheduled" },
  ];
  const move = (heatId: string, target: number, recommendation?: number) => checkScoringHeatMove({
    heat: scoringHeats.find((heat) => heat.id === heatId)!, target: floorHeats[target - 1], scoringHeats, heatEntries, participants: input.participants, floorRecommendation: recommendation,
  });

  it("blocks a competitor conflict with a plain explanation", () => {
    expect(move("hNew", 2)).toEqual({ ok: false, reason: "Pat Pro is already dancing in Heat 2." });
  });

  it("blocks incompatible music even if the organizer would accept a warning", () => {
    expect(move("hJJ", 2)).toEqual({ ok: false, reason: "Heat 2 is Two Step; West Coast Swing needs its own music." });
  });

  it("allows a compatible, conflict-free move and only warns about floor size", () => {
    expect(move("hBronze", 1)).toEqual({ ok: true });
    expect(move("hBronze", 1, 1)).toEqual({ ok: true, warning: "Heat 1 would have 2 entries on the floor (recommended 1)." });
  });

  it("explains saved conflicts in plain language", () => {
    const summaries = analyzeFloorSchedule({
      floorHeats,
      scoringHeats: [...scoringHeats.slice(0, 3).map((heat) => ({ ...heat, floor_heat_id: "f1" })), { ...scoringHeats[3], floor_heat_id: "f1" }],
      heatEntries,
      participants: input.participants,
    });
    const messages = summaries[0].problems.map((problem) => problem.message);
    expect(messages).toContain("Pat Pro is dancing in more than one entry in Heat 1.");
    expect(messages.some((message) => message.startsWith("Heat 1 mixes Two Step and West Coast Swing."))).toBe(true);
  });
});

describe("10D Schedule & Heats wiring", () => {
  it("the advanced time-block planner stays under Schedule & Heats navigation", () => {
    expect(activeNavKey("e1", "/app/events/e1/competition/schedule")).toBe("schedule");
    expect(activeNavKey("e1", "/app/events/e1/competition/advanced/schedule")).toBe("schedule");
    expect(activeNavKey("e1", "/app/events/e1/competition/advanced")).toBe("settings");
  });

  it("every organizer action calls a database operation defined by the migration", () => {
    const actions = read("src/app/app/events/[id]/competition/schedule/actions.ts");
    for (const rpc of ["apply_competition_floor_plan", "clear_competition_floor_plan", "move_competition_scoring_heat", "move_competition_scoring_heat_to_new_floor_heat",
      "move_competition_floor_heat", "insert_competition_floor_heat", "delete_competition_floor_heat", "set_competition_round_heat_capacity"]) {
      expect(actions).toContain(`"${rpc}"`);
      expect(MIGRATION).toContain(`create function public.${rpc}(`);
    }
    expect(actions).toContain('"publish_competition_schedule_version"');
    expect(actions).not.toMatch(/\.from\("event_competition_(floor_heats|heats|heat_entries)"\)\.(insert|update|delete)/);
  });

  it("the June planner page moved under Advanced and still links back", () => {
    const advanced = read("src/app/app/events/[id]/competition/advanced/schedule/page.tsx");
    expect(advanced).toContain("Advanced scheduling");
    expect(read("src/app/app/events/[id]/competition/schedule/page.tsx")).toContain("/competition/advanced/schedule");
  });
});
