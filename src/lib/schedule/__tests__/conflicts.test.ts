import { describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for Schedule Stabilization Slice 0: `detectAppointmentConflicts`
 * previously queried a non-existent table, `"schedule_blocks"`, for both the
 * instructor-block and room-block conflict checks -- the real table is
 * `instructor_schedule_blocks`. That mismatch made every conflict check that
 * supplied an `instructorId` or `roomId` throw a "relation does not exist"
 * error, breaking staff appointment create/edit, instructor block create/edit,
 * booking-request approval, and self-service booking wherever an instructor
 * was involved.
 *
 * These tests use a purpose-built fake Supabase client that only knows about
 * the real tables (`appointments`, `instructor_schedule_blocks`) -- querying
 * any other table name (e.g. the old `schedule_blocks`) resolves with a
 * PostgREST-shaped "relation does not exist" error, the same way a real
 * Supabase project would respond. This means the schedule-block tests below
 * only pass if the implementation queries the correct table: they would have
 * failed (via an unexpected thrown error) against the pre-fix code.
 */

type Row = Record<string, unknown>;
type FakeResult = { count: number; error: { message: string } | null };

type Filters = {
  eq: [string, unknown][];
  neq: [string, unknown][];
  in: [string, unknown[]][];
  lt: [string, unknown][];
  gt: [string, unknown][];
  isNull: string[];
};

function emptyFilters(): Filters {
  return { eq: [], neq: [], in: [], lt: [], gt: [], isNull: [] };
}

function matches(row: Row, filters: Filters): boolean {
  return (
    filters.eq.every(([c, v]) => row[c] === v) &&
    filters.neq.every(([c, v]) => row[c] !== v) &&
    filters.in.every(([c, v]) => (v as unknown[]).includes(row[c])) &&
    filters.lt.every(([c, v]) => (row[c] as string) < (v as string)) &&
    filters.gt.every(([c, v]) => (row[c] as string) > (v as string)) &&
    filters.isNull.every((c) => row[c] === null || row[c] === undefined)
  );
}

function buildRowsChain(rows: Row[]) {
  const filters = emptyFilters();
  const chain = {
    eq(col: string, val: unknown) {
      filters.eq.push([col, val]);
      return chain;
    },
    neq(col: string, val: unknown) {
      filters.neq.push([col, val]);
      return chain;
    },
    in(col: string, vals: unknown[]) {
      filters.in.push([col, vals]);
      return chain;
    },
    lt(col: string, val: unknown) {
      filters.lt.push([col, val]);
      return chain;
    },
    gt(col: string, val: unknown) {
      filters.gt.push([col, val]);
      return chain;
    },
    is(col: string, val: unknown) {
      if (val === null) filters.isNull.push(col);
      return chain;
    },
    async maybeSingle() {
      const matched = rows.filter((row) => matches(row, filters));
      return { data: matched[0] ?? null, error: null };
    },
    then(
      onFulfilled: (value: FakeResult & { data: Row[] }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      const matched = rows.filter((row) => matches(row, filters));
      const result = { count: matched.length, error: null, data: matched };
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

function buildErrorChain(message: string) {
  const chain = {
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    lt: () => chain,
    gt: () => chain,
    is: () => chain,
    async maybeSingle() {
      return { data: null, error: { message } };
    },
    then(
      onFulfilled: (value: FakeResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      const result: FakeResult = { count: 0, error: { message } };
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

/**
 * Only registers the tables a real Supabase project actually has
 * (`appointments`, `instructor_schedule_blocks`, `rooms`, or a
 * caller-supplied partial set for the "missing table" tests). Any other
 * table name -- including the old, incorrect `"schedule_blocks"` --
 * resolves as a PostgREST "relation does not exist" error, mirroring real
 * behavior. Tests that reach the room branch with at least one other
 * occupant must supply a `rooms` entry (capacity is looked up only when
 * occupants exist -- see conflicts.ts).
 */
function fakeConflictClient(tables: Partial<Record<string, Row[]>>) {
  return {
    from(table: string) {
      const rows = tables[table];
      if (!rows) {
        return { select: () => buildErrorChain(`relation "${table}" does not exist`) };
      }
      return { select: () => buildRowsChain(rows) };
    },
  };
}

let currentClient: ReturnType<typeof fakeConflictClient>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient,
}));

const { detectAppointmentConflicts } = await import("@/lib/schedule/conflicts");

const STUDIO_ID = "studio-1";
const INSTRUCTOR_ID = "instructor-1";
const ROOM_ID = "room-1";
const CLIENT_ID = "client-1";

const SLOT_START = "2026-09-01T10:00:00.000Z";
const SLOT_END = "2026-09-01T11:00:00.000Z";

function overlappingAppointment(overrides: Row = {}): Row {
  return {
    id: "appt-existing",
    studio_id: STUDIO_ID,
    instructor_id: INSTRUCTOR_ID,
    room_id: ROOM_ID,
    client_id: CLIENT_ID,
    status: "scheduled",
    starts_at: "2026-09-01T10:30:00.000Z",
    ends_at: "2026-09-01T11:30:00.000Z",
    ...overrides,
  };
}

function overlappingBlock(overrides: Row = {}): Row {
  return {
    id: "block-existing",
    studio_id: STUDIO_ID,
    instructor_id: INSTRUCTOR_ID,
    room_id: null,
    starts_at: "2026-09-01T10:15:00.000Z",
    ends_at: "2026-09-01T10:45:00.000Z",
    ...overrides,
  };
}

describe("detectAppointmentConflicts", () => {
  it("1. detects an overlapping instructor appointment", async () => {
    currentClient = fakeConflictClient({
      appointments: [overlappingAppointment()],
      instructor_schedule_blocks: [],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      instructorId: INSTRUCTOR_ID,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.message).toMatch(/instructor/i);
  });

  it("2. detects an overlapping instructor schedule block via instructor_schedule_blocks (regression guard for the schedule_blocks table-name bug)", async () => {
    currentClient = fakeConflictClient({
      appointments: [],
      instructor_schedule_blocks: [overlappingBlock()],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      instructorId: INSTRUCTOR_ID,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.message).toMatch(/schedule block/i);
  });

  it("3. FC-1B3: an ordinary (non-exclusive) overlapping room appointment does NOT conflict -- rooms may be shared", async () => {
    currentClient = fakeConflictClient({
      appointments: [
        overlappingAppointment({ instructor_id: "someone-else", exclusive_room_use: false }),
      ],
      instructor_schedule_blocks: [],
      rooms: [{ id: ROOM_ID, max_simultaneous_bookings: null }],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      roomId: ROOM_ID,
    });

    expect(result).toEqual({ hasConflict: false });
  });

  it("4. FC-1B3: an instructor's personal schedule block in a room does NOT make the room unavailable to others (corrects prior room-wide conflation)", async () => {
    currentClient = fakeConflictClient({
      appointments: [],
      instructor_schedule_blocks: [
        overlappingBlock({ room_id: ROOM_ID, instructor_id: "some-other-instructor" }),
      ],
      rooms: [{ id: ROOM_ID, max_simultaneous_bookings: null }],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      roomId: ROOM_ID,
    });

    expect(result).toEqual({ hasConflict: false });
  });

  it("5. returns no conflict for a non-overlapping appointment", async () => {
    currentClient = fakeConflictClient({
      appointments: [
        overlappingAppointment({
          starts_at: "2026-09-01T12:00:00.000Z",
          ends_at: "2026-09-01T13:00:00.000Z",
        }),
      ],
      instructor_schedule_blocks: [],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      instructorId: INSTRUCTOR_ID,
      roomId: ROOM_ID,
      clientId: CLIENT_ID,
    });

    expect(result).toEqual({ hasConflict: false });
  });

  it("6. a cancelled appointment does not block an otherwise-overlapping slot", async () => {
    currentClient = fakeConflictClient({
      appointments: [overlappingAppointment({ status: "cancelled" })],
      instructor_schedule_blocks: [],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      instructorId: INSTRUCTOR_ID,
      roomId: ROOM_ID,
      clientId: CLIENT_ID,
    });

    expect(result.hasConflict).toBe(false);
  });

  it("6b. a no_show appointment does not block an otherwise-overlapping slot", async () => {
    currentClient = fakeConflictClient({
      appointments: [overlappingAppointment({ status: "no_show" })],
      instructor_schedule_blocks: [],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      instructorId: INSTRUCTOR_ID,
    });

    expect(result.hasConflict).toBe(false);
  });

  it("7. a database lookup failure fails closed with a thrown error, not a false negative", async () => {
    // Simulates a genuine DB-level failure the same way a missing/renamed
    // table would surface -- the "appointments" table itself is absent from
    // the fake schema, so the query resolves with an error, exactly as the
    // pre-fix code's "schedule_blocks" queries did in production.
    currentClient = fakeConflictClient({
      instructor_schedule_blocks: [],
    });

    await expect(
      detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        instructorId: INSTRUCTOR_ID,
      }),
    ).rejects.toThrow(/conflict check failed/i);
  });

  it("8. a client that only knows the old, nonexistent schedule_blocks table fails closed (regression guard) -- demonstrates the pre-fix failure mode directly", async () => {
    // A fake schema shaped like the pre-fix world: "appointments" exists and
    // is empty (so the appointment check passes cleanly), but the block
    // table is registered under the OLD, wrong name ("schedule_blocks")
    // instead of the real "instructor_schedule_blocks". If the
    // implementation queries the correct table name (post-fix), this must
    // throw a "relation does not exist"-shaped error -- exactly the failure
    // every affected caller hit in production. This is the same mechanism
    // that makes test 2 above an effective regression guard: it only passes
    // when the implementation queries the right table.
    currentClient = {
      from(table: string) {
        if (table === "appointments") return { select: () => buildRowsChain([]) };
        if (table === "schedule_blocks") return { select: () => buildRowsChain([overlappingBlock()]) };
        return { select: () => buildErrorChain(`relation "${table}" does not exist`) };
      },
    };

    await expect(
      detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        instructorId: INSTRUCTOR_ID,
      }),
    ).rejects.toThrow(/instructor schedule block check failed/i);
  });

  it("excludes the appointment/block ids passed via excludeAppointmentId/excludeScheduleBlockId", async () => {
    currentClient = fakeConflictClient({
      appointments: [overlappingAppointment({ id: "appt-being-edited" })],
      instructor_schedule_blocks: [overlappingBlock({ id: "block-being-edited" })],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      instructorId: INSTRUCTOR_ID,
      excludeAppointmentId: "appt-being-edited",
      excludeScheduleBlockId: "block-being-edited",
    });

    expect(result).toEqual({ hasConflict: false });
  });
});

/**
 * FC-1B3 Room Resource Model Foundation.
 *
 * Rooms may be shared: overlapping room_id + time is NOT itself a
 * conflict. A room booking is rejected only when the room is unavailable
 * (room_unavailable), an exclusive booking is involved, or configured
 * simultaneous-booking capacity (rooms.max_simultaneous_bookings) would be
 * exceeded. This suite exercises the room branch directly against a fake
 * Supabase client with genuine row filtering -- not a stand-in -- so the
 * sweep-based capacity algorithm (computeMaxConcurrentOccupancy) is
 * proven correct, not merely assumed.
 */
describe("detectAppointmentConflicts -- FC-1B3 Room Resource Model", () => {
  const OTHER_ROOM_ID = "room-2";

  function roomAppointment(overrides: Row = {}): Row {
    return {
      id: `appt-${Math.random().toString(36).slice(2)}`,
      studio_id: STUDIO_ID,
      instructor_id: null,
      client_id: "some-client",
      room_id: ROOM_ID,
      appointment_type: "private_lesson",
      status: "scheduled",
      exclusive_room_use: false,
      starts_at: SLOT_START,
      ends_at: SLOT_END,
      ...overrides,
    };
  }

  function roomUnavailableRow(overrides: Row = {}): Row {
    return roomAppointment({
      appointment_type: "room_unavailable",
      client_id: null,
      exclusive_room_use: false,
      ...overrides,
    });
  }

  function unlimitedRoom(id = ROOM_ID): Row {
    return { id, max_simultaneous_bookings: null };
  }

  describe("shared usage", () => {
    it("1. two non-exclusive independent-instructor rentals may overlap in the same room", async () => {
      currentClient = fakeConflictClient({
        appointments: [
          roomAppointment({
            client_id: "instructor-a-client",
            appointment_type: "floor_space_rental",
            exclusive_room_use: false,
          }),
        ],
        instructor_schedule_blocks: [],
        rooms: [unlimitedRoom()],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
        clientId: "instructor-b-client",
        requestExclusiveRoomUse: false,
      });

      expect(result).toEqual({ hasConflict: false });
    });

    it("2. a non-exclusive rental may overlap an ordinary non-exclusive studio lesson", async () => {
      currentClient = fakeConflictClient({
        appointments: [
          roomAppointment({ appointment_type: "private_lesson", exclusive_room_use: false }),
        ],
        instructor_schedule_blocks: [],
        rooms: [unlimitedRoom()],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
        requestExclusiveRoomUse: false,
      });

      expect(result).toEqual({ hasConflict: false });
    });

    it("3. same-time usage in a different room succeeds", async () => {
      currentClient = fakeConflictClient({
        appointments: [roomAppointment({ room_id: OTHER_ROOM_ID })],
        instructor_schedule_blocks: [],
        rooms: [unlimitedRoom(ROOM_ID)],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
      });

      expect(result).toEqual({ hasConflict: false });
    });
  });

  describe("availability", () => {
    it("4. a room-specific room_unavailable block rejects", async () => {
      currentClient = fakeConflictClient({
        appointments: [roomUnavailableRow()],
        instructor_schedule_blocks: [],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
      });

      expect(result.hasConflict).toBe(true);
    });

    it("5. (studio-wide unavailable block) -- verified at the floor-space call-site layer, not detectAppointmentConflicts", () => {
      // detectAppointmentConflicts only matches an exact roomId; it cannot
      // express "room_id IS NULL blocks every room". That case is handled
      // explicitly by checkFloorSpaceBookingConflict
      // (src/app/portal/[studioSlug]/floor-space/actions.ts) and covered
      // by floorSpaceRentalConflicts.test.ts's studio-wide-closure test.
      expect(true).toBe(true);
    });
  });

  describe("exclusivity", () => {
    it("6. an existing exclusive booking blocks a new non-exclusive booking", async () => {
      currentClient = fakeConflictClient({
        appointments: [roomAppointment({ exclusive_room_use: true })],
        instructor_schedule_blocks: [],
        rooms: [unlimitedRoom()],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
        requestExclusiveRoomUse: false,
      });

      expect(result.hasConflict).toBe(true);
    });

    it("7. a new exclusive booking is rejected when any normal (non-exclusive) occupant overlaps", async () => {
      currentClient = fakeConflictClient({
        appointments: [roomAppointment({ exclusive_room_use: false })],
        instructor_schedule_blocks: [],
        rooms: [unlimitedRoom()],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
        requestExclusiveRoomUse: true,
      });

      expect(result.hasConflict).toBe(true);
    });

    it("8. two exclusive bookings cannot overlap", async () => {
      currentClient = fakeConflictClient({
        appointments: [roomAppointment({ exclusive_room_use: true })],
        instructor_schedule_blocks: [],
        rooms: [unlimitedRoom()],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
        requestExclusiveRoomUse: true,
      });

      expect(result.hasConflict).toBe(true);
    });

    it("9. back-to-back exclusive and non-exclusive bookings are allowed", async () => {
      currentClient = fakeConflictClient({
        appointments: [
          roomAppointment({
            exclusive_room_use: true,
            starts_at: "2026-09-01T09:00:00.000Z",
            ends_at: SLOT_START, // ends exactly when the requested slot starts
          }),
        ],
        instructor_schedule_blocks: [],
        rooms: [unlimitedRoom()],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
        requestExclusiveRoomUse: true,
      });

      expect(result).toEqual({ hasConflict: false });
    });
  });

  describe("capacity", () => {
    it("10. NULL capacity allows multiple simultaneous non-exclusive bookings", async () => {
      currentClient = fakeConflictClient({
        appointments: [
          roomAppointment(),
          roomAppointment({ id: "appt-2" }),
          roomAppointment({ id: "appt-3" }),
        ],
        instructor_schedule_blocks: [],
        rooms: [unlimitedRoom()],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
      });

      expect(result).toEqual({ hasConflict: false });
    });

    it("11. capacity 1 rejects a second simultaneous booking", async () => {
      currentClient = fakeConflictClient({
        appointments: [roomAppointment()],
        instructor_schedule_blocks: [],
        rooms: [{ id: ROOM_ID, max_simultaneous_bookings: 1 }],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
      });

      expect(result.hasConflict).toBe(true);
    });

    it("12. capacity 2 allows a second simultaneous booking", async () => {
      currentClient = fakeConflictClient({
        appointments: [roomAppointment()],
        instructor_schedule_blocks: [],
        rooms: [{ id: ROOM_ID, max_simultaneous_bookings: 2 }],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
      });

      expect(result).toEqual({ hasConflict: false });
    });

    it("13. capacity 2 rejects a third simultaneous booking", async () => {
      currentClient = fakeConflictClient({
        appointments: [roomAppointment(), roomAppointment({ id: "appt-2" })],
        instructor_schedule_blocks: [],
        rooms: [{ id: ROOM_ID, max_simultaneous_bookings: 2 }],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
      });

      expect(result.hasConflict).toBe(true);
    });

    it("14. capacity evaluation uses maximum simultaneous occupancy, not a naive count of every row touching the interval", async () => {
      // Existing A and B are back-to-back (A ends exactly when B starts) --
      // they are NEVER concurrent with each other, even though both touch
      // the requested window. A naive "count every row overlapping the
      // window" implementation would see 2 existing rows and, with
      // capacity 2, incorrectly reject (2 existing + 1 new = 3 > 2). The
      // correct answer: at any single instant at most 1 of {A,B} is
      // present, so peak concurrency is 1 existing + 1 new = 2, which
      // fits exactly within capacity 2.
      const windowStart = "2026-09-01T10:00:00.000Z";
      const windowEnd = "2026-09-01T11:00:00.000Z";
      const midpoint = "2026-09-01T10:30:00.000Z";

      currentClient = fakeConflictClient({
        appointments: [
          roomAppointment({ id: "appt-first-half", starts_at: windowStart, ends_at: midpoint }),
          roomAppointment({ id: "appt-second-half", starts_at: midpoint, ends_at: windowEnd }),
        ],
        instructor_schedule_blocks: [],
        rooms: [{ id: ROOM_ID, max_simultaneous_bookings: 2 }],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: windowStart,
        endsAt: windowEnd,
        roomId: ROOM_ID,
      });

      expect(result).toEqual({ hasConflict: false });
    });

    it("15. cancelled/no-show rows do not consume capacity", async () => {
      currentClient = fakeConflictClient({
        appointments: [
          roomAppointment({ status: "cancelled" }),
          roomAppointment({ id: "appt-2", status: "no_show" }),
        ],
        instructor_schedule_blocks: [],
        rooms: [{ id: ROOM_ID, max_simultaneous_bookings: 1 }],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
      });

      expect(result).toEqual({ hasConflict: false });
    });
  });

  describe("update self-exclusion", () => {
    it("19. update does not count the appointment being edited toward its own capacity/exclusivity", async () => {
      currentClient = fakeConflictClient({
        appointments: [roomAppointment({ id: "appt-being-edited", exclusive_room_use: true })],
        instructor_schedule_blocks: [],
        rooms: [{ id: ROOM_ID, max_simultaneous_bookings: 1 }],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
        excludeAppointmentId: "appt-being-edited",
      });

      expect(result).toEqual({ hasConflict: false });
    });

    it("20. update still respects capacity/exclusivity of OTHER rows", async () => {
      currentClient = fakeConflictClient({
        appointments: [
          roomAppointment({ id: "appt-being-edited" }),
          roomAppointment({ id: "appt-other", exclusive_room_use: true }),
        ],
        instructor_schedule_blocks: [],
        rooms: [unlimitedRoom()],
      });

      const result = await detectAppointmentConflicts({
        studioId: STUDIO_ID,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: ROOM_ID,
        excludeAppointmentId: "appt-being-edited",
      });

      expect(result.hasConflict).toBe(true);
    });
  });
});
