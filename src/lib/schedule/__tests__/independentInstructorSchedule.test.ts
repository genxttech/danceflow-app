import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FC-1B5D2 D2C-0A: `getAnonymizedBusyOccupancy`'s `appointments` query now
 * runs on the admin (service-role) client rather than the caller's
 * session-scoped one, so this signal keeps working once appointment RLS is
 * tightened to scope an ordinary instructor's own session to only their own
 * assigned/linked rows (see src/lib/schedule/independentInstructorSchedule.ts).
 * The `instructor_schedule_blocks` query is unaffected and stays on the
 * session client -- proven directly below, not assumed.
 *
 * These tests use two INDEPENDENT fake Supabase clients (one for
 * `@/lib/supabase/server`'s `createClient`, one for `@/lib/supabase/admin`'s
 * `createAdminClient`) with genuinely different fixture data, so a passing
 * test can only be explained by the appointments query actually reaching the
 * admin fixture -- not by coincidence or a shared fake.
 */

type Row = Record<string, unknown>;
type Filters = {
  eq: [string, unknown][];
  lt: [string, unknown][];
  gt: [string, unknown][];
  // Columns required to be NOT NULL -- populated by `.not(col, "is", null)`,
  // which means "NOT (col IS NULL)", i.e. col IS NOT NULL.
  notNull: string[];
  notIn: { column: string; ids: string[] } | null;
};

function emptyFilters(): Filters {
  return { eq: [], lt: [], gt: [], notNull: [], notIn: null };
}

function matches(row: Row, filters: Filters): boolean {
  if (!filters.eq.every(([c, v]) => row[c] === v)) return false;
  if (!filters.lt.every(([c, v]) => (row[c] as string) < (v as string))) return false;
  if (!filters.gt.every(([c, v]) => (row[c] as string) > (v as string))) return false;
  if (!filters.notNull.every((c) => row[c] !== null && row[c] !== undefined)) return false;
  if (filters.notIn && filters.notIn.ids.includes(row.id as string)) return false;
  return true;
}

function buildChain(rows: Row[], capturedSelects: { table: string; columns: string }[], table: string, columns: string) {
  capturedSelects.push({ table, columns });
  const filters = emptyFilters();
  const chain = {
    eq(col: string, val: unknown) {
      filters.eq.push([col, val]);
      return chain;
    },
    in(col: string, vals: unknown[]) {
      const clausesHolder = filters as unknown as { inClauses?: [string, unknown[]][] };
      clausesHolder.inClauses ??= [];
      clausesHolder.inClauses.push([col, vals]);
      return chain;
    },
    not(col: string, op: string, val: unknown) {
      if (op === "is" && val === null) {
        filters.notNull.push(col);
      } else if (op === "in" && typeof val === "string") {
        const ids = val.replace(/^\(|\)$/g, "").split(",").filter(Boolean);
        filters.notIn = { column: col, ids };
      }
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
      onFulfilled: (value: { data: Row[]; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      const inClauses = (filters as unknown as { inClauses?: [string, unknown[]][] }).inClauses ?? [];
      const matched = rows.filter(
        (row) =>
          matches(row, filters) &&
          inClauses.every(([c, vals]) => (vals as unknown[]).includes(row[c])),
      );
      return Promise.resolve({ data: matched, error: null }).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

function fakeOccupancyClient(tables: Partial<Record<string, Row[]>>) {
  const capturedSelects: { table: string; columns: string }[] = [];
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      return {
        select(columns: string) {
          return buildChain(rows, capturedSelects, table, columns);
        },
      };
    },
    capturedSelects,
  };
  return client;
}

let currentSessionClient: ReturnType<typeof fakeOccupancyClient>;
let currentAdminClient: ReturnType<typeof fakeOccupancyClient>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSessionClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdminClient,
}));

const { getAnonymizedBusyOccupancy } = await import(
  "@/lib/schedule/independentInstructorSchedule"
);

const STUDIO_ID = "studio-1";
const ROOM_ID = "room-1";
const RANGE_START = "2026-09-01T00:00:00.000Z";
const RANGE_END = "2026-09-02T00:00:00.000Z";

function busyAppointmentRow(overrides: Row = {}): Row {
  return {
    id: `appt-${Math.random().toString(36).slice(2)}`,
    studio_id: STUDIO_ID,
    room_id: ROOM_ID,
    status: "scheduled",
    starts_at: "2026-09-01T10:00:00.000Z",
    ends_at: "2026-09-01T11:00:00.000Z",
    // Sensitive fields that must NEVER be requested by this query --
    // included here so a test can prove they'd be absent from the result
    // even if a future regression accidentally selected them.
    client_id: "some-client",
    instructor_id: "some-other-instructor",
    notes: "private lesson notes",
    price_amount: 5000,
    payment_status: "paid",
    title: "Private Lesson with Jane",
    rooms: { id: ROOM_ID, name: "Studio A" },
    ...overrides,
  };
}

beforeEach(() => {
  currentSessionClient = fakeOccupancyClient({});
  currentAdminClient = fakeOccupancyClient({});
});

describe("getAnonymizedBusyOccupancy -- FC-1B5D2 D2C-0A admin-client isolation", () => {
  it("another instructor's busy room/time still appears via the admin client even when the session client would see nothing", async () => {
    currentSessionClient = fakeOccupancyClient({
      appointments: [], // session client: nothing visible (simulates tightened RLS hiding a colleague's row)
      instructor_schedule_blocks: [],
    });
    currentAdminClient = fakeOccupancyClient({
      appointments: [busyAppointmentRow()],
    });

    const result = await getAnonymizedBusyOccupancy({
      supabase: currentSessionClient as never,
      studioId: STUDIO_ID,
      excludeAppointmentIds: [],
      rangeStartIso: RANGE_START,
      rangeEndIso: RANGE_END,
    });

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("In use");
    expect(result[0].room_id).toBe(ROOM_ID);
  });

  it("returned objects are exactly anonymized -- only key/room_id/room_name/starts_at/ends_at/label, nothing else", async () => {
    currentAdminClient = fakeOccupancyClient({
      appointments: [busyAppointmentRow()],
    });

    const result = await getAnonymizedBusyOccupancy({
      supabase: currentSessionClient as never,
      studioId: STUDIO_ID,
      excludeAppointmentIds: [],
      rangeStartIso: RANGE_START,
      rangeEndIso: RANGE_END,
    });

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0]).sort()).toEqual(
      ["ends_at", "key", "label", "room_id", "room_name", "starts_at"].sort(),
    );
  });

  it("no client/instructor/notes/payment/package/membership field is ever requested by the admin query, even though the fixture row has them", async () => {
    currentAdminClient = fakeOccupancyClient({
      appointments: [busyAppointmentRow()],
    });

    await getAnonymizedBusyOccupancy({
      supabase: currentSessionClient as never,
      studioId: STUDIO_ID,
      excludeAppointmentIds: [],
      rangeStartIso: RANGE_START,
      rangeEndIso: RANGE_END,
    });

    const appointmentsSelect = currentAdminClient.capturedSelects.find(
      (c) => c.table === "appointments",
    );
    expect(appointmentsSelect?.columns).toBe("starts_at, ends_at, rooms ( id, name )");

    const forbiddenFieldPattern =
      /client_id|instructor_id|notes|price|payment|title|created_by|package|membership/i;
    expect(appointmentsSelect?.columns).not.toMatch(forbiddenFieldPattern);
  });

  it("existing instructor_schedule_blocks behavior is unchanged -- stays on the session client, unaffected by an admin-only fixture", async () => {
    currentSessionClient = fakeOccupancyClient({
      appointments: [],
      instructor_schedule_blocks: [
        {
          studio_id: STUDIO_ID,
          starts_at: "2026-09-01T14:00:00.000Z",
          ends_at: "2026-09-01T15:00:00.000Z",
          room_id: ROOM_ID,
          rooms: { id: ROOM_ID, name: "Studio B" },
        },
      ],
    });
    // Admin fixture deliberately has no matching instructor_schedule_blocks
    // data -- if this query were ever accidentally switched to admin, the
    // "Unavailable" block below would go missing.
    currentAdminClient = fakeOccupancyClient({ appointments: [] });

    const result = await getAnonymizedBusyOccupancy({
      supabase: currentSessionClient as never,
      studioId: STUDIO_ID,
      excludeAppointmentIds: [],
      rangeStartIso: RANGE_START,
      rangeEndIso: RANGE_END,
    });

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Unavailable");
    expect(result[0].room_name).toBe("Studio B");
  });

  it("excludeAppointmentIds still excludes the caller's own already-shown rentals from the admin-sourced occupancy", async () => {
    const ownRentalId = "own-rental-appt";
    currentAdminClient = fakeOccupancyClient({
      appointments: [
        busyAppointmentRow({ id: ownRentalId }),
        busyAppointmentRow({ id: "someone-elses-appt" }),
      ],
    });

    const result = await getAnonymizedBusyOccupancy({
      supabase: currentSessionClient as never,
      studioId: STUDIO_ID,
      excludeAppointmentIds: [ownRentalId],
      rangeStartIso: RANGE_START,
      rangeEndIso: RANGE_END,
    });

    expect(result).toHaveLength(1);
  });

  it("out-of-range appointments do not appear", async () => {
    currentAdminClient = fakeOccupancyClient({
      appointments: [
        busyAppointmentRow({
          starts_at: "2026-09-05T10:00:00.000Z",
          ends_at: "2026-09-05T11:00:00.000Z",
        }),
      ],
    });

    const result = await getAnonymizedBusyOccupancy({
      supabase: currentSessionClient as never,
      studioId: STUDIO_ID,
      excludeAppointmentIds: [],
      rangeStartIso: RANGE_START,
      rangeEndIso: RANGE_END,
    });

    expect(result).toHaveLength(0);
  });
});
