import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  callbackTargetReport,
  isCallbackRound,
  parseCallbackTarget,
  type CallbackDivisionRow,
  type CallbackRoundRow,
} from "@/lib/competition/callbackTarget";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const round = (over: Partial<CallbackRoundRow>): CallbackRoundRow => ({
  id: "r1",
  division_id: "d1",
  name: "Callback round",
  round_type: "preliminary",
  scoring_method: "callback_tally",
  target_advancement_count: null,
  ...over,
});
const divisions: CallbackDivisionRow[] = [
  { id: "d1", name: "Gold", program_id: "p1" },
  { id: "d2", name: "Silver", program_id: "p1" },
];

describe("parseCallbackTarget", () => {
  it("accepts a positive integer", () => {
    expect(parseCallbackTarget("5", 0)).toEqual({ ok: true, value: 5 });
    expect(parseCallbackTarget(" 12 ", 20)).toEqual({ ok: true, value: 12 });
  });

  it("treats blank as clearing the target (it then blocks readiness again)", () => {
    expect(parseCallbackTarget("", 10)).toEqual({ ok: true, value: null });
    expect(parseCallbackTarget("   ", 10)).toEqual({ ok: true, value: null });
  });

  it("rejects zero, negatives, decimals and junk", () => {
    for (const bad of ["0", "1", "-1", "2.5", "abc", "1e3", "1234567"]) {
      expect(parseCallbackTarget(bad, 0).ok).toBe(false);
    }
  });

  it("requires the target to be strictly below the entry count once entries exist", () => {
    expect(parseCallbackTarget("9", 10)).toEqual({ ok: true, value: 9 });
    expect(parseCallbackTarget("10", 10).ok).toBe(false);
    expect(parseCallbackTarget("11", 10).ok).toBe(false);
  });

  it("does not invent an upper bound when there are no entries yet", () => {
    expect(parseCallbackTarget("500", 0)).toEqual({ ok: true, value: 500 });
  });
});

describe("callbackTargetReport", () => {
  const base = { divisions, callbackProgramIds: new Set(["p1"]), entriesByDivision: new Map<string, number>() };

  it("blocks a callback round whose target is NULL (fail closed)", () => {
    const report = callbackTargetReport({ ...base, rounds: [round({})] });
    expect(report.unset).toHaveLength(1);
    expect(report.unset[0]).toMatchObject({ divisionName: "Gold", detail: "Callback target not set" });
  });

  it("does not block once an organizer-set target exists", () => {
    const report = callbackTargetReport({ ...base, rounds: [round({ target_advancement_count: 4 })] });
    expect(report.unset).toHaveLength(0);
  });

  it("ignores non-callback rounds with a NULL target", () => {
    const report = callbackTargetReport({
      ...base,
      rounds: [round({ round_type: "final", scoring_method: "ordinal_majority" }), round({ id: "r3", scoring_method: "wsdc_callback" })],
    });
    expect(report.unset).toHaveLength(0);
    expect(isCallbackRound({ scoring_method: "ordinal_majority" })).toBe(false);
  });

  it("warns, without blocking, when the target is not below the confirmed entries", () => {
    const report = callbackTargetReport({
      ...base,
      rounds: [round({ target_advancement_count: 6 })],
      entriesByDivision: new Map([["d1", 6]]),
    });
    expect(report.unset).toHaveLength(0);
    expect(report.notBelowEntries).toHaveLength(1);
  });

  it("warns about a pre-K1 Final scored none in a callback program, only when the division has no callback round", () => {
    const report = callbackTargetReport({
      ...base,
      rounds: [
        round({ id: "ra", division_id: "d1" }),
        round({ id: "rb", division_id: "d1", name: "Final", round_type: "final", scoring_method: "ordinal_majority" }),
        round({ id: "rc", division_id: "d2", name: "Final", round_type: "final", scoring_method: "none" }),
      ],
    });
    expect(report.unscoredFinals.map((item) => item.divisionName)).toEqual(["Silver"]);
  });

  it("never reports a none Final in a program that is not callback_tally", () => {
    const report = callbackTargetReport({
      divisions,
      callbackProgramIds: new Set(),
      entriesByDivision: new Map(),
      rounds: [round({ division_id: "d2", round_type: "final", scoring_method: "none" })],
    });
    expect(report.unscoredFinals).toHaveLength(0);
  });
});

describe("K1 source-level guards", () => {
  it("the callback target module never imports an engine or results code", () => {
    const source = read("src/lib/competition/callbackTarget.ts");
    expect(source).not.toMatch(/^import /m);
  });

  it("the action is manager-gated, restricted to callback rounds, and applies no default", () => {
    const actions = read("src/app/app/events/[id]/competition/actions.ts");
    const start = actions.indexOf("export async function updateCompetitionCallbackTargetAction");
    const body = actions.slice(start, actions.indexOf("export async function updateCompetitionContestRegistrationAction"));
    expect(body).toContain("requireEventManager(eventId)");
    expect(body).toContain("isCallbackRound(round)");
    expect(body).toContain("parseCallbackTarget(");
    expect(body).not.toMatch(/target_advancement_count:\s*\d/);
  });

  it("the readiness page counts callback targets as a blocking check and lists the blocker text", () => {
    const page = read("src/app/app/events/[id]/competition/readiness/page.tsx");
    expect(page).toContain("callbackTargetsReady,");
    expect(page).toContain("Callback target not set");
  });

  it("the migration touches only add_competition_division, pins prior bodies and keeps no numeric default", () => {
    const migration = read("src/lib/supabase/migrations/20270110090000_competition_k1_setup_fixes.sql");
    expect(migration.match(/create or replace function/g)).toHaveLength(1);
    expect(migration).toContain("public.add_competition_division(");
    expect(migration).toContain("38b617071133dabf87c3ac8249adde42");
    expect(migration).toContain("ba42ef12e5af6092d9c76949953f6b8d");
    expect(migration).toContain("when 'callback_tally' then 'ordinal_majority'");
    expect(migration).not.toMatch(/target_advancement_count\s*=/);
    const rollback = read("src/lib/supabase/migrations/rollback/20270110090000_competition_k1_setup_fixes_rollback.sql");
    expect(rollback).not.toContain("when 'callback_tally' then 'ordinal_majority'");
    expect(rollback).toContain("case when v_scoring in ('ordinal_majority', 'proficiency_rating') then v_scoring else 'none' end);");
  });
});
