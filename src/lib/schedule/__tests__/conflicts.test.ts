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
};

function emptyFilters(): Filters {
  return { eq: [], neq: [], in: [], lt: [], gt: [] };
}

function matches(row: Row, filters: Filters): boolean {
  return (
    filters.eq.every(([c, v]) => row[c] === v) &&
    filters.neq.every(([c, v]) => row[c] !== v) &&
    filters.in.every(([c, v]) => (v as unknown[]).includes(row[c])) &&
    filters.lt.every(([c, v]) => (row[c] as string) < (v as string)) &&
    filters.gt.every(([c, v]) => (row[c] as string) > (v as string))
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
    then(
      onFulfilled: (value: FakeResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      const matched = rows.filter((row) => matches(row, filters));
      const result: FakeResult = { count: matched.length, error: null };
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
 * (`appointments`, `instructor_schedule_blocks`, or a caller-supplied
 * partial set for the "missing table" tests). Any other table name --
 * including the old, incorrect `"schedule_blocks"` -- resolves as a
 * PostgREST "relation does not exist" error, mirroring real behavior.
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

  it("3. detects an overlapping room appointment", async () => {
    currentClient = fakeConflictClient({
      appointments: [overlappingAppointment({ instructor_id: "someone-else" })],
      instructor_schedule_blocks: [],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      roomId: ROOM_ID,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.message).toMatch(/room/i);
  });

  it("4. detects an overlapping room schedule block via instructor_schedule_blocks", async () => {
    currentClient = fakeConflictClient({
      appointments: [],
      instructor_schedule_blocks: [
        overlappingBlock({ room_id: ROOM_ID, instructor_id: "some-other-instructor" }),
      ],
    });

    const result = await detectAppointmentConflicts({
      studioId: STUDIO_ID,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      roomId: ROOM_ID,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.message).toMatch(/room.*schedule block/i);
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
