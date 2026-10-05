import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GC-S1C-1: occurrence edit safety for canonical group classes.
 *
 * Drives the real updateAppointmentAction / deleteAppointmentAction with the
 * role-guard entry points mocked (the repo's established convention) and a
 * fake Supabase client that records every write. The database-side override
 * tracking itself is the released S1A trigger (covered by its SQL suite);
 * here we prove the action never writes series identity or override state
 * and leaves that tracking to the trigger.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  isRedirectError: (error: unknown) =>
    typeof (error as { digest?: string })?.digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
}));
vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: (error: unknown) =>
    typeof (error as { digest?: string })?.digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const detectConflictsMock = vi.fn();
vi.mock("@/lib/schedule/conflicts", () => ({
  detectAppointmentConflicts: (...args: unknown[]) => detectConflictsMock(...args),
}));
vi.mock("@/lib/compensation/earnings", () => ({
  stageInstructorEarningForAppointment: vi.fn().mockResolvedValue({ staged: false }),
}));
vi.mock("@/lib/packages/lifecycle", () => ({
  reconcileClientPackageLifecycle: vi.fn().mockResolvedValue({ completedPackageIds: [] }),
}));
vi.mock("@/lib/instructors/assignability", () => ({
  isInstructionalAppointmentType: () => true,
  validateAssignableInstructor: vi.fn().mockResolvedValue(null),
  assignmentRelationshipChanged: () => true,
}));
vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: vi.fn().mockResolvedValue(undefined),
  sendGroupClassCancellationPush: vi.fn().mockResolvedValue(undefined),
}));

const requireFloorRentalAppointmentAccessMock = vi.fn();
const requireAppointmentDeleteAccessMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...a: unknown[]) => requireFloorRentalAppointmentAccessMock(...a),
  requireAppointmentEditAccess: vi.fn(),
  requireAppointmentDeleteAccess: (...a: unknown[]) => requireAppointmentDeleteAccessMock(...a),
  requireAppointmentPaymentAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));
const requireRelationshipMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...a: unknown[]) => requireRelationshipMock(...a),
}));

const { updateAppointmentAction, deleteAppointmentAction } = await import("../actions");
const {
  parseRosterCapacityInput,
  capacityBelowBooked,
  capacityBelowBookedMessage,
  conflictSensitiveFieldsChanged,
  describeOverriddenFields,
  seriesOccurrenceLabel,
} = await import("@/lib/schedule/groupClassOccurrenceEdit");
const { default: GroupClassSeriesContext } = await import("../[id]/edit/GroupClassSeriesContext");

const STUDIO = "studio-1";
const APPT = "appt-1";

const CURRENT = {
  id: APPT,
  studio_id: STUDIO,
  client_id: null,
  instructor_id: "inst-1",
  room_id: "room-1",
  starts_at: "2026-11-02T23:00:00.000Z",
  ends_at: "2026-11-03T00:00:00.000Z",
  appointment_type: "group_class",
  roster_capacity: 10,
};

type Setup = {
  booked?: number | null;
  bookedError?: boolean;
  roomExists?: boolean;
  updateError?: boolean;
  updateErrorMessage?: string;
  deleteRow?: Record<string, unknown>;
};

function makeSupabase(setup: Setup = {}) {
  const writes: Array<{ table: string; payload: unknown }> = [];
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const deletes: string[] = [];
  const supabase = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let result: unknown = { data: null, error: null };
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = (_c?: string, opts?: { head?: boolean }) => {
        if (table === "appointment_attendees" && opts?.head) {
          result = setup.bookedError
            ? { count: null, error: { message: "raw db failure" } }
            : { count: setup.booked ?? 0, error: null };
        } else if (table === "rooms") {
          result =
            setup.roomExists === false
              ? { data: null, error: null }
              : { data: { id: "room-2" }, error: null };
        } else if (table === "appointments") {
          result = {
            data:
              setup.deleteRow ?? {
                id: APPT,
                client_id: null,
                appointment_type: "group_class",
                status: "scheduled",
                group_class_series_id: null,
              },
            error: null,
          };
        }
        return chain;
      };
      chain.eq = (col: string, val: unknown) => {
        filters.push([col, val]);
        return chain;
      };
      chain.order = self;
      chain.limit = self;
      chain.single = () => Promise.resolve(result);
      chain.maybeSingle = () => {
        reads.push({ table, filters });
        return Promise.resolve(result);
      };
      chain.update = (payload: unknown) => {
        writes.push({ table, payload });
        result = {
          error: setup.updateErrorMessage
            ? { message: setup.updateErrorMessage }
            : setup.updateError
              ? { message: "raw db update failure" }
              : null,
        };
        return chain;
      };
      chain.delete = () => {
        deletes.push(table);
        result = { error: null };
        return chain;
      };
      chain.then = (resolve: (v: unknown) => void) => {
        reads.push({ table, filters });
        return resolve(result);
      };
      return chain;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { supabase, writes, reads, deletes };
}

function form(fields: Record<string, string>) {
  const fd = new FormData();
  fd.set("appointmentId", APPT);
  fd.set("appointmentType", "group_class");
  fd.set("title", "Salsa");
  fd.set("instructorId", "inst-1");
  fd.set("roomId", "room-1");
  fd.set("startsAt", "2026-11-02T18:00");
  fd.set("endsAt", "2026-11-02T19:00");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function arrange(
  setup: Setup = {},
  current: Record<string, unknown> = CURRENT,
  role = "studio_owner",
) {
  const made = makeSupabase(setup);
  requireFloorRentalAppointmentAccessMock.mockResolvedValue({
    supabase: made.supabase,
    studioId: STUDIO,
    user: { id: "u1" },
    studioRole: role,
    isPlatformAdmin: false,
  });
  requireAppointmentDeleteAccessMock.mockResolvedValue({
    supabase: made.supabase,
    studioId: STUDIO,
  });
  requireRelationshipMock.mockResolvedValue({ ok: true, scope: "studio", appointment: current });
  return made;
}

async function run(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}
const redirectUrl = (e: unknown) =>
  ((e as { digest?: string })?.digest ?? "").split(";")[2] ?? "";

beforeEach(() => {
  detectConflictsMock.mockReset().mockResolvedValue({ hasConflict: false });
  requireFloorRentalAppointmentAccessMock.mockReset();
  requireAppointmentDeleteAccessMock.mockReset();
  requireRelationshipMock.mockReset();
});

describe("S1C-1 pure rules", () => {
  it("parses capacity: missing = untouched, blank = no limit, whole number >= 1 only", () => {
    expect(parseRosterCapacityInput(null)).toEqual({ ok: true, present: false });
    expect(parseRosterCapacityInput("")).toEqual({ ok: true, present: true, value: null });
    expect(parseRosterCapacityInput("  ")).toEqual({ ok: true, present: true, value: null });
    expect(parseRosterCapacityInput("8")).toEqual({ ok: true, present: true, value: 8 });
    for (const bad of ["0", "-1", "2.5", "abc", "1e3", "10001", "+3"]) {
      expect(parseRosterCapacityInput(bad)).toEqual({ ok: false });
    }
  });

  it("floor: equal ok, above ok, below fails, null (unlimited) ok", () => {
    expect(capacityBelowBooked(8, 8)).toBe(false);
    expect(capacityBelowBooked(9, 8)).toBe(false);
    expect(capacityBelowBooked(7, 8)).toBe(true);
    expect(capacityBelowBooked(null, 8)).toBe(false);
    expect(capacityBelowBookedMessage(8)).toBe(
      "This class already has 8 students booked. Capacity cannot be set below 8.",
    );
    expect(capacityBelowBookedMessage(1)).toContain("1 student booked");
  });

  it("detects only conflict-sensitive changes, comparing instants", () => {
    const cur = {
      instructor_id: "i",
      room_id: "r",
      starts_at: "2026-11-02T23:00:00+00:00",
      ends_at: "2026-11-03T00:00:00Z",
    };
    const same = {
      instructorId: "i",
      roomId: "r",
      startsAt: "2026-11-02T23:00:00.000Z",
      endsAt: "2026-11-03T00:00:00.000Z",
    };
    expect(conflictSensitiveFieldsChanged(cur, same)).toBe(false);
    expect(conflictSensitiveFieldsChanged(cur, { ...same, instructorId: "j" })).toBe(true);
    expect(conflictSensitiveFieldsChanged(cur, { ...same, roomId: null })).toBe(true);
    expect(
      conflictSensitiveFieldsChanged(cur, { ...same, endsAt: "2026-11-03T00:30:00.000Z" }),
    ).toBe(true);
  });

  it("describes overrides in plain language only", () => {
    expect(describeOverriddenFields(["time", "title", "bogus"])).toEqual(["Title", "Date and time"]);
    expect(describeOverriddenFields(null)).toEqual([]);
    expect(seriesOccurrenceLabel(3)).toBe("Class 3 in the series");
    expect(seriesOccurrenceLabel(null)).toBeNull();
    expect(seriesOccurrenceLabel(0)).toBeNull();
  });
});

describe("S1C-1 update action: series identity and override tracking", () => {
  it("never writes series identity or override state; the S1A trigger owns tracking", async () => {
    const { writes } = arrange({}, { ...CURRENT, group_class_series_id: "series-1" });
    const evil = form({
      title: "New title",
      groupClassSeriesId: "other-series",
      group_class_series_id: "other-series",
      seriesOccurrenceIndex: "99",
      series_occurrence_index: "99",
      occurrenceOriginalStart: "2020-01-01T00:00:00Z",
      occurrence_original_start: "2020-01-01T00:00:00Z",
      seriesOverriddenFields: "[]",
      series_overridden_fields: "{}",
      studioId: "studio-2",
      studio_id: "studio-2",
    });
    const err = await run(updateAppointmentAction({}, evil));
    expect(redirectUrl(err)).toBe(`/app/schedule/${APPT}`);
    expect(writes).toHaveLength(1);
    const payload = writes[0].payload as Record<string, unknown>;
    for (const key of [
      "group_class_series_id",
      "series_occurrence_index",
      "occurrence_original_start",
      "series_overridden_fields",
      "studio_id",
      "appointment_type",
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it("authorizes against the authenticated studio, not a client-supplied one", async () => {
    arrange();
    await run(updateAppointmentAction({}, form({ studioId: "studio-2" })));
    expect(requireRelationshipMock.mock.calls[0][0]).toMatchObject({ studioId: STUDIO });
  });

  it("sends the tracked fields as plain values (title, instructor, room, location, capacity, time)", async () => {
    const { writes } = arrange({ booked: 0, roomExists: true });
    await run(
      updateAppointmentAction(
        {},
        form({
          title: "T2",
          instructorId: "inst-2",
          roomId: "room-2",
          locationName: "Annex",
          rosterCapacity: "12",
          startsAt: "2026-11-02T19:00",
          endsAt: "2026-11-02T20:00",
        }),
      ),
    );
    expect(writes[0].payload).toMatchObject({
      title: "T2",
      instructor_id: "inst-2",
      room_id: "room-2",
      location_name: "Annex",
      roster_capacity: 12,
    });
  });

  it("the released S1A trigger tracks exactly these six fields and is the only tracker", () => {
    const sql = readFileSync(
      "src/lib/supabase/migrations/20261014090000_gcs1a_group_class_series_foundation.sql",
      "utf8",
    );
    for (const f of ["'title'", "'instructor'", "'room'", "'location'", "'capacity'", "'time'"]) {
      expect(sql).toContain(`v_fields || ${f}::text`);
    }
    const action = readFileSync("src/app/app/schedule/actions.ts", "utf8");
    const edit = action.slice(action.indexOf("export async function updateAppointmentAction"));
    const classBranch = edit
      .slice(0, edit.indexOf("const clientId = getString(formData"))
      .replace(/^\s*\/\/.*$/gm, "");
    expect(classBranch).not.toContain("series_overridden_fields");
    expect(classBranch).not.toContain("group_class_series_id");
  });
});

describe("S1C-1 update action: conflicts", () => {
  it("excludes itself and blocks an instructor conflict with safe copy", async () => {
    detectConflictsMock.mockResolvedValue({
      hasConflict: true,
      message: "That instructor is already booked during this time.",
    });
    const { writes } = arrange();
    const res = (await updateAppointmentAction({}, form({ instructorId: "inst-2" }))) as {
      error: string;
    };
    expect(res.error).toBe("The instructor is already booked at this time.");
    expect(writes).toHaveLength(0);
    expect(detectConflictsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        studioId: STUDIO,
        excludeAppointmentId: APPT,
        instructorId: "inst-2",
        roomId: "room-1",
      }),
    );
  });

  it("blocks an instructor schedule block", async () => {
    detectConflictsMock.mockResolvedValue({
      hasConflict: true,
      message: "That instructor has a schedule block during this time.",
    });
    arrange();
    const res = (await updateAppointmentAction({}, form({ instructorId: "inst-2" }))) as {
      error: string;
    };
    expect(res.error).toBe("The instructor has a schedule block at this time.");
  });

  it("blocks a room conflict", async () => {
    detectConflictsMock.mockResolvedValue({
      hasConflict: true,
      message: "That room is already booked during this time.",
    });
    const { writes } = arrange({ roomExists: true });
    const res = (await updateAppointmentAction({}, form({ roomId: "room-2" }))) as {
      error: string;
    };
    expect(res.error).toBe("The room is already booked at this time.");
    expect(writes).toHaveLength(0);
  });

  it("an unknown engine message degrades to generic safe copy, never raw text", async () => {
    detectConflictsMock.mockResolvedValue({
      hasConflict: true,
      message: "Client Jane Doe is booked (note: private)",
    });
    arrange();
    const res = (await updateAppointmentAction({}, form({ instructorId: "inst-2" }))) as {
      error: string;
    };
    expect(res.error).toBe("This time conflicts with an existing booking.");
    expect(JSON.stringify(res)).not.toContain("Jane");
  });

  it("a time move rechecks and a clean edit succeeds", async () => {
    const { writes } = arrange();
    const err = await run(
      updateAppointmentAction({}, form({ startsAt: "2026-11-03T18:00", endsAt: "2026-11-03T19:00" })),
    );
    expect(detectConflictsMock).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    expect(redirectUrl(err)).toBe(`/app/schedule/${APPT}`);
  });

  it("conflict-engine failure fails closed and saves nothing", async () => {
    detectConflictsMock.mockRejectedValue(new Error("Instructor conflict check failed: raw detail"));
    const { writes } = arrange();
    const res = (await updateAppointmentAction({}, form({ instructorId: "inst-2" }))) as {
      error: string;
    };
    expect(res.error).toBe("We couldn't check the schedule for conflicts. Please try again.");
    expect(res.error).not.toContain("raw detail");
    expect(writes).toHaveLength(0);
  });

  it("a non-conflict-sensitive edit does no conflict work (instants compared, not strings)", async () => {
    // Studio timezone default is America/New_York: 18:00 local on 2026-11-02 = 23:00Z.
    const { writes } = arrange();
    const err = await run(
      updateAppointmentAction(
        {},
        form({ title: "Just a rename", locationName: "Annex", rosterCapacity: "10" }),
      ),
    );
    expect(detectConflictsMock).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(redirectUrl(err)).toBe(`/app/schedule/${APPT}`);
  });

  it("decides from the server-loaded row, not from any client 'changed' hint", async () => {
    arrange();
    await run(updateAppointmentAction({}, form({ conflictRecheck: "false", instructorId: "inst-2" })));
    expect(detectConflictsMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a room that is not an active room of this studio", async () => {
    const { writes, reads } = arrange({ roomExists: false });
    const res = (await updateAppointmentAction({}, form({ roomId: "room-other-studio" }))) as {
      error: string;
    };
    expect(res.error).toBe("Choose an active room from this studio.");
    expect(writes).toHaveLength(0);
    const roomRead = reads.find((r) => r.table === "rooms");
    expect(roomRead?.filters).toEqual(
      expect.arrayContaining([
        ["studio_id", STUDIO],
        ["active", true],
      ]),
    );
    expect(detectConflictsMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid time with safe copy", async () => {
    arrange();
    const res = (await updateAppointmentAction(
      {},
      form({ startsAt: "2026-11-02T19:00", endsAt: "2026-11-02T18:00" }),
    )) as { error: string };
    expect(res.error).toContain("Date, start time, and end time");
  });
});

describe("S1C-1 update action: capacity", () => {
  it("allows capacity above and equal to booked", async () => {
    for (const cap of ["9", "8"]) {
      const { writes } = arrange({ booked: 8 });
      await run(updateAppointmentAction({}, form({ rosterCapacity: cap })));
      expect(writes[0].payload).toMatchObject({ roster_capacity: Number(cap) });
    }
  });

  it("rejects capacity below booked with the owner-facing message and no write", async () => {
    const { writes, reads } = arrange({ booked: 8 });
    const res = (await updateAppointmentAction({}, form({ rosterCapacity: "7" }))) as {
      error: string;
    };
    expect(res.error).toBe(
      "This class already has 8 students booked. Capacity cannot be set below 8.",
    );
    expect(writes).toHaveLength(0);
    const countRead = reads.find((r) => r.table === "appointment_attendees");
    expect(countRead?.filters).toEqual(
      expect.arrayContaining([
        ["studio_id", STUDIO],
        ["appointment_id", APPT],
        ["status", "booked"],
      ]),
    );
  });

  it("rejects zero, negative and non-numeric capacity before touching the roster", async () => {
    for (const bad of ["0", "-3", "abc", "2.5"]) {
      const { writes, reads } = arrange({ booked: 0 });
      const res = (await updateAppointmentAction({}, form({ rosterCapacity: bad }))) as {
        error: string;
      };
      expect(res.error).toContain("whole number of 1 or more");
      expect(writes).toHaveLength(0);
      expect(reads.find((r) => r.table === "appointment_attendees")).toBeUndefined();
    }
  });

  it("blank capacity means no limit (null) without a roster count", async () => {
    const { writes, reads } = arrange({ booked: 8 });
    await run(updateAppointmentAction({}, form({ rosterCapacity: "" })));
    expect(writes[0].payload).toMatchObject({ roster_capacity: null });
    expect(reads.find((r) => r.table === "appointment_attendees")).toBeUndefined();
  });

  it("an absent capacity field leaves capacity untouched", async () => {
    const { writes } = arrange();
    await run(updateAppointmentAction({}, form({})));
    expect(writes[0].payload).not.toHaveProperty("roster_capacity");
  });

  it("an unchanged capacity does no roster count", async () => {
    const { reads } = arrange({ booked: 50 });
    await run(updateAppointmentAction({}, form({ rosterCapacity: "10" })));
    expect(reads.find((r) => r.table === "appointment_attendees")).toBeUndefined();
  });

  it("fails closed when the booked count cannot be read, without leaking raw text", async () => {
    const { writes } = arrange({ bookedError: true });
    const res = (await updateAppointmentAction({}, form({ rosterCapacity: "5" }))) as {
      error: string;
    };
    expect(res.error).toBe("We couldn't check how many students are booked. Please try again.");
    expect(res.error).not.toContain("raw db");
    expect(writes).toHaveLength(0);
  });

  it("never touches attendee rows", async () => {
    const { writes } = arrange({ booked: 2 });
    await run(updateAppointmentAction({}, form({ rosterCapacity: "5" })));
    expect(writes.every((w) => w.table === "appointments")).toBe(true);
  });

  it("maps a database update failure to generic copy", async () => {
    arrange({ updateError: true });
    const res = (await updateAppointmentAction({}, form({}))) as { error: string };
    expect(res.error).toBe("Could not update the class. Please try again.");
  });

  it("GC-S1E-3: a conflict the database refuses after the app check maps to the same safe copy, never raw text", async () => {
    arrange({ updateErrorMessage: "GCSE3_CONFLICT: reason=instructor" });
    const res = (await updateAppointmentAction(
      {},
      form({ startsAt: "2026-11-03T18:00", endsAt: "2026-11-03T19:00" }),
    )) as { error: string };
    expect(res.error).toBe("The instructor is already booked at this time.");
    expect(res.error).not.toContain("GCSE3");
  });

  it("GC-S1E-3: each database conflict reason maps to its category copy", async () => {
    const cases: Array<[string, string]> = [
      ["instructor_block", "The instructor has a schedule block at this time."],
      ["room_unavailable", "The room is unavailable at this time."],
      ["room_busy", "The room is already booked at this time."],
      ["something_new", "This time conflicts with an existing booking."],
    ];
    for (const [reason, copy] of cases) {
      arrange({ updateErrorMessage: `GCSE3_CONFLICT: reason=${reason}` });
      const res = (await updateAppointmentAction(
        {},
        form({ startsAt: "2026-11-03T18:00", endsAt: "2026-11-03T19:00" }),
      )) as { error: string };
      expect(res.error).toBe(copy);
    }
  });
});

describe("S1C-1 update action: authority and compatibility", () => {
  it("own-floor-rental scope stays denied", async () => {
    const made = makeSupabase();
    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase: made.supabase,
      studioId: STUDIO,
      user: { id: "u" },
      studioRole: "independent_instructor",
      isPlatformAdmin: false,
    });
    requireRelationshipMock.mockResolvedValue({
      ok: true,
      scope: "own-floor-rental",
      appointment: CURRENT,
    });
    const res = (await updateAppointmentAction({}, form({}))) as { error: string };
    expect(res.error).toContain("do not have permission");
    expect(made.writes).toHaveLength(0);
  });

  it("a denied relationship returns its reason and writes nothing", async () => {
    const made = makeSupabase();
    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase: made.supabase,
      studioId: STUDIO,
      user: { id: "u" },
      studioRole: "instructor",
      isPlatformAdmin: false,
    });
    requireRelationshipMock.mockResolvedValue({
      ok: false,
      reason: "You do not have access to this appointment.",
    });
    const res = (await updateAppointmentAction({}, form({}))) as { error: string };
    expect(res.error).toBe("You do not have access to this appointment.");
    expect(made.writes).toHaveLength(0);
  });

  it("a standalone class edit uses the same flow and the same payload (no series fields)", async () => {
    const { writes } = arrange({}, { ...CURRENT, group_class_series_id: null });
    await run(updateAppointmentAction({}, form({ instructorId: "inst-2" })));
    expect(detectConflictsMock).toHaveBeenCalledTimes(1);
    expect(
      Object.keys(writes[0].payload as object).some((k) => k.includes("series")),
    ).toBe(false);
  });

  it("does not run the class branch logic for other appointment types", () => {
    const action = readFileSync("src/app/app/schedule/actions.ts", "utf8");
    const edit = action.slice(action.indexOf("export async function updateAppointmentAction"));
    const start = edit.indexOf("const clientId = getString(formData");
    const lessonBranch = edit.slice(start, start + 6000);
    expect(lessonBranch).not.toContain("rosterCapacity");
    expect(lessonBranch).not.toContain("conflictSensitiveFieldsChanged");
  });
});

describe("S1C-1 delete guard", () => {
  it("refuses to hard-delete a series occurrence and points to cancellation", async () => {
    const { deletes } = arrange({
      deleteRow: {
        id: APPT,
        client_id: null,
        appointment_type: "group_class",
        status: "scheduled",
        group_class_series_id: "series-1",
      },
    });
    const fd = new FormData();
    fd.set("appointmentId", APPT);
    fd.set("confirmDeleteAppointment", "DELETE");
    const err = await run(deleteAppointmentAction(fd));
    expect(redirectUrl(err)).toContain("series_occurrence_delete_blocked");
    expect(deletes).toHaveLength(0);
  });

  it("keeps existing delete semantics for standalone appointments", async () => {
    const { deletes } = arrange();
    const fd = new FormData();
    fd.set("appointmentId", APPT);
    fd.set("confirmDeleteAppointment", "DELETE");
    const err = await run(deleteAppointmentAction(fd));
    expect(redirectUrl(err)).not.toContain("series_occurrence_delete_blocked");
    expect(deletes.length).toBeGreaterThan(0);
  });
});

describe("S1C-1 UI and boundaries", () => {
  it("shows restrained series context with plain-language overrides", () => {
    const html = renderToStaticMarkup(
      createElement(GroupClassSeriesContext, {
        occurrenceIndex: 3,
        overriddenFields: ["time", "room"],
      }),
    );
    expect(html).toContain("Part of a class series");
    expect(html).toContain("Class 3 in the series");
    expect(html).toContain("Customized for this class");
    expect(html).toContain("Room, Date and time");
    expect(html).not.toContain("series_overridden_fields");
    expect(html).not.toMatch(/weekday|interval|ends_on/i);
  });

  it("shows no customization disclosure when nothing is overridden", () => {
    const html = renderToStaticMarkup(
      createElement(GroupClassSeriesContext, { occurrenceIndex: 1, overriddenFields: [] }),
    );
    expect(html).not.toContain("Customized for this class");
  });

  it("the edit form exposes capacity and never submits series identity or overrides", () => {
    const src = readFileSync("src/app/app/schedule/[id]/edit/AppointmentEditForm.tsx", "utf8");
    expect(src).toContain('name="rosterCapacity"');
    expect(src).toContain("Maximum students");
    for (const forbidden of [
      "group_class_series_id",
      "series_occurrence_index",
      "occurrence_original_start",
      "series_overridden_fields",
    ]) {
      expect(src).not.toContain(`name="${forbidden}"`);
    }
  });

  it("uses no admin/service-role client and never touches Events", () => {
    const helper = readFileSync("src/lib/schedule/groupClassOccurrenceEdit.ts", "utf8");
    expect(helper).not.toMatch(/createAdminClient|service_role|from\("events"\)/);
    const ctx = readFileSync("src/app/app/schedule/[id]/edit/GroupClassSeriesContext.tsx", "utf8");
    expect(ctx).not.toMatch(/createAdminClient|service_role/);
  });
});
