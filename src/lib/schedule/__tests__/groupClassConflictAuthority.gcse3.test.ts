/**
 * GC-S1E-3: the database rule (_gcse3_schedule_conflict) is the authority for canonical group-class writes; the app's
 * detectAppointmentConflicts stays as the fast preflight. These tests keep the two definitions from drifting apart
 * (statuses, half-open boundaries, the peak-capacity comparison, the conflict categories) and pin the safe mapping of
 * the database refusal. Behavior of the rule itself is proven against live Postgres in
 * sql-tests/test_T_gcse3_group_class_conflict_authority.sql.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SERIES_CONFLICT_COPY,
  mapGroupClassConflictDbError,
  mapSeriesRpcError,
} from "@/lib/schedule/groupClassSeries";
import { mapOccurrenceUpdateDbError } from "@/lib/schedule/groupClassOccurrenceEdit";

const root = process.cwd();
const engine = readFileSync(join(root, "src/lib/schedule/conflicts.ts"), "utf8");
const migration = readFileSync(
  join(root, "src/lib/supabase/migrations/20261023090000_gcse3_group_class_conflict_authority.sql"),
  "utf8",
);
const rule = migration.slice(
  migration.indexOf("create function public._gcse3_schedule_conflict("),
  migration.indexOf("revoke all on function public._gcse3_schedule_conflict("),
);

describe("GC-S1E-3 rule parity (app preflight vs database authority)", () => {
  it("both treat exactly scheduled / confirmed / rescheduled / attended as active", () => {
    const engineStatuses = /const activeStatuses = \[([^\]]*)\]/.exec(engine)?.[1].match(/"(\w+)"/g)?.map((s) => s.slice(1, -1));
    const ruleStatuses = /v_active public\.appointment_status\[\] := array\[([^\]]*)\]/.exec(rule)?.[1].match(/'(\w+)'/g)?.map((s) => s.slice(1, -1));
    expect(engineStatuses).toEqual(["scheduled", "confirmed", "rescheduled", "attended"]);
    expect(ruleStatuses).toEqual(engineStatuses);
  });

  it("both use half-open overlap (back-to-back is not a conflict)", () => {
    expect(engine).toContain('.lt("starts_at", endsAt)');
    expect(engine).toContain('.gt("ends_at", startsAt)');
    expect(engine).not.toMatch(/\.(lte|gte)\("(starts_at|ends_at)"/);
    expect(rule).toContain("starts_at < p_ends_at and a.ends_at > p_starts_at");
    expect(rule).toContain("b.starts_at < p_ends_at and b.ends_at > p_starts_at");
    expect(rule).not.toMatch(/starts_at <= p_ends_at|ends_at >= p_starts_at/);
  });

  it("both refuse when the peak of the OTHER occupants plus this one exceeds the room's simultaneous limit", () => {
    expect(engine).toContain("peakOtherOccupancy + 1 > maxSimultaneousBookings");
    expect(rule).toContain("v_peak + 1 > v_cap");
    // departures before arrivals at the same instant (app) == an occupant ending exactly at the instant does not count (db)
    expect(engine).toContain("a.time - b.time || a.delta - b.delta");
    expect(rule).toContain("o2.s <= o1.s and o2.e > o1.s");
  });

  it("room_unavailable rows are an availability signal, never an occupant, in both", () => {
    expect(engine).toContain('.eq("appointment_type", "room_unavailable")');
    expect(engine).toContain('.neq("appointment_type", "room_unavailable")');
    expect(rule).toContain("a.appointment_type = 'room_unavailable'::public.appointment_type");
    expect(rule).toContain("a.appointment_type <> 'room_unavailable'::public.appointment_type");
  });

  it("the database rule has no client-overlap check (classes never had one)", () => {
    expect(rule).not.toMatch(/client_id/);
  });

  it("every database reason maps to the same category the app's engine message would", () => {
    const pairs: Array<[string, keyof typeof SERIES_CONFLICT_COPY]> = [
      ["instructor", "instructor_overlap"],
      ["instructor_block", "instructor_block"],
      ["room_unavailable", "room_unavailable"],
      ["room_busy", "room_booked"],
    ];
    for (const [reason, category] of pairs) {
      expect(rule).toContain(`return '${reason}'`);
      expect(mapGroupClassConflictDbError(`GCSE3_CONFLICT: reason=${reason}`)).toEqual({
        category,
        message: SERIES_CONFLICT_COPY[category],
      });
    }
  });
});

describe("GC-S1E-3 refusal mapping", () => {
  it("returns null for anything that is not the conflict refusal", () => {
    expect(mapGroupClassConflictDbError(null)).toBeNull();
    expect(mapGroupClassConflictDbError("GCSC3_CAPACITY_BELOW_BOOKED: x")).toBeNull();
    expect(mapGroupClassConflictDbError("raw failure")).toBeNull();
  });

  it("an unknown reason degrades to the generic conflict copy", () => {
    expect(mapGroupClassConflictDbError("GCSE3_CONFLICT: reason=weird")?.category).toBe("other");
  });

  it("the series create maps it to the conflict code, the occurrence edit to category copy", () => {
    expect(mapSeriesRpcError({ message: "GCSE3_CONFLICT: reason=room_busy index=3 count=2" })).toBe("conflict");
    expect(mapOccurrenceUpdateDbError("GCSE3_CONFLICT: reason=room_busy")).toBe(SERIES_CONFLICT_COPY.room_booked);
    // the released capacity-floor mapping is unchanged
    expect(mapOccurrenceUpdateDbError("GCSC3_CAPACITY_BELOW_BOOKED: lower than the 4 students already booked")).toBe(
      "This class already has 4 students booked. Capacity cannot be set below 4.",
    );
  });
});
