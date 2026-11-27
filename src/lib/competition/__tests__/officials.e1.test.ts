import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeNavKey, competitionNav } from "@/lib/competition/workspaceNav";
import {
  nextFreeJudgeLetter,
  normalizeJudgeLetter,
  officialErrorMessage,
  OFFICIAL_ERROR_COPY,
  panelEditable,
  panelStatusLabel,
  takesJudgeLetter,
} from "@/lib/competition/officials/contract";
import { groupJudgingAssignments, type JudgingAssignmentRow } from "@/lib/competition/officials/judging";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const MIGRATION = read("src/lib/supabase/migrations/20270101090000_competition_e1_officials.sql");
const EVENT = "11111111-1111-1111-1111-111111111111";

describe("E1 contract helpers", () => {
  it("panels are editable only while the round is draft or scheduled", () => {
    for (const status of ["draft", "scheduled"]) expect(panelEditable(status)).toBe(true);
    for (const status of ["active", "ballots_locked", "calculated", "approved", "published", "complete", "cancelled", "", null, undefined]) expect(panelEditable(status)).toBe(false);
  });

  it("judges and the chair take a letter, scorers do not", () => {
    expect(takesJudgeLetter("judge")).toBe(true);
    expect(takesJudgeLetter("chair")).toBe(true);
    expect(takesJudgeLetter("scorer")).toBe(false);
  });

  it("letters normalize to upper-case A-Z (max two characters)", () => {
    expect(normalizeJudgeLetter(" c ")).toBe("C");
    expect(normalizeJudgeLetter("ab")).toBe("AB");
    expect(normalizeJudgeLetter("1")).toBeNull();
    expect(normalizeJudgeLetter("abc")).toBeNull();
    expect(normalizeJudgeLetter("")).toBeNull();
  });

  it("picks the next free letter", () => {
    expect(nextFreeJudgeLetter([])).toBe("A");
    expect(nextFreeJudgeLetter(["A", "B", null, "D"])).toBe("C");
    expect(nextFreeJudgeLetter("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""))).toBeNull();
  });

  it("maps database codes to manager copy and never leaks raw SQL errors", () => {
    expect(officialErrorMessage("COMP_PANEL_FROZEN: the panel...")).toBe(OFFICIAL_ERROR_COPY.COMP_PANEL_FROZEN);
    expect(officialErrorMessage('duplicate key value violates unique constraint "x"')).toBe("The change could not be saved. Try again.");
    expect(officialErrorMessage(undefined)).toBe("The change could not be saved. Try again.");
  });

  it("describes panel readiness", () => {
    expect(panelStatusLabel({ ready: true, judge_count: 3 })).toBe("Panel ready (3 judges)");
    expect(panelStatusLabel({ ready: false, judge_count: 1, min_judges: 3 })).toBe("Needs 2 more judges");
    expect(panelStatusLabel(null)).toBe("Unknown");
  });
});

describe("E1 judging shell grouping", () => {
  const base: JudgingAssignmentRow = {
    event_id: "e1", event_name: "Spring", event_start_date: "2027-03-01", official_id: "o1", official_role: "judge",
    round_id: null, round_name: null, round_type: null, round_status: null, division_name: null, judge_letter: null,
  };
  it("shows an event with no rounds yet, and groups rounds under their event", () => {
    const grouped = groupJudgingAssignments([
      base,
      { ...base, event_id: "e2", event_name: "Fall", round_id: "r1", round_name: "Final", round_status: "scheduled", division_name: "Newcomer", judge_letter: "B" },
      { ...base, event_id: "e2", event_name: "Fall", round_id: "r2", round_name: "Semi", round_status: "draft", division_name: "Open", judge_letter: "A" },
    ]);
    expect(grouped.map((g) => [g.eventId, g.rounds.length])).toEqual([["e1", 0], ["e2", 2]]);
  });
});

describe("E1 navigation", () => {
  it("links Officials into the competition workspace and marks it active", () => {
    const item = competitionNav(EVENT).find((candidate) => candidate.key === "officials")!;
    expect(item.available).toBe(true);
    expect(item.href).toBe(`/app/events/${EVENT}/competition/officials`);
    expect(activeNavKey(EVENT, `/app/events/${EVENT}/competition/officials`)).toBe("officials");
  });
});

describe("E1 file ownership and surface", () => {
  it("does not touch the competition layout or access helper (CB-2)", () => {
    const layout = read("src/app/app/events/[id]/competition/layout.tsx");
    expect(layout).not.toMatch(/officials|judging/i);
    expect(read("src/lib/competition/access.ts")).not.toMatch(/official/i);
  });

  it("manager actions go through the workspace guard and RPCs, never direct table writes", () => {
    const actions = read("src/app/app/events/[id]/competition/officials/actions.ts");
    expect(actions).toContain("requireCompetitionWorkspace");
    expect(actions).not.toMatch(/\.from\(/);
    for (const rpc of ["add_competition_official", "deactivate_competition_official", "set_competition_chair", "clear_competition_chair", "assign_competition_panel_member", "unassign_competition_panel_member"]) {
      expect(actions).toContain(rpc);
    }
  });

  it("the judging shell reads only the own-assignments RPC (no table reads)", () => {
    const page = read("src/app/app/judging/page.tsx");
    expect(page).toContain("my_competition_judging_assignments");
    expect(page).not.toMatch(/\.from\(/);
  });
});

describe("E1 migration (static)", () => {
  it("every SECURITY DEFINER function pins its search_path", () => {
    const functions = MIGRATION.split(/create or replace function /i).slice(1);
    for (const body of functions) {
      const header = body.split("$$")[0];
      if (!/security definer/i.test(header)) continue;
      expect(header, body.slice(0, 60)).toMatch(/set search_path = public, pg_temp/);
    }
  });

  it("API roles get SELECT only, anon gets nothing, and RPC grants exclude anon", () => {
    expect(MIGRATION).toMatch(/revoke all on public\.event_competition_officials from public, anon, authenticated, service_role/);
    expect(MIGRATION).toMatch(/grant select on public\.event_competition_officials to authenticated, service_role/);
    expect(MIGRATION).not.toMatch(/grant (insert|update|delete)/i);
    expect(MIGRATION).not.toMatch(/to anon/);
  });

  it("identity is by user_id with the verified credential helper, never an email lookup", () => {
    expect(MIGRATION).toContain("verified_email_for_user");
    expect(MIGRATION).not.toMatch(/where[^;]*\bemail\s*=/i);
  });
});
