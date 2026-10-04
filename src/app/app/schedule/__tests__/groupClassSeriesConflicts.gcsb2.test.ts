import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-S1B B2: the series actions against the REAL conflict engine
 * (src/lib/schedule/conflicts.ts) with a fake database. Proves the engine is
 * reused as-is for group classes (client_id is NULL for a class; no client
 * query is issued), that existing canonical class rows count as conflicts, and
 * that every category the engine supports surfaces as safe, mapped copy.
 */

type Row = Record<string, unknown>;
type Filters = { eq: [string, unknown][]; neq: [string, unknown][]; in: [string, unknown[]][]; lt: [string, unknown][]; gt: [string, unknown][] };

const queriedFilters: { table: string; eq: string[] }[] = [];
let tables: Record<string, Row[]> = {};

function matches(row: Row, f: Filters) {
  return (
    f.eq.every(([c, v]) => row[c] === v) &&
    f.neq.every(([c, v]) => row[c] !== v) &&
    f.in.every(([c, v]) => v.includes(row[c])) &&
    f.lt.every(([c, v]) => (row[c] as string) < (v as string)) &&
    f.gt.every(([c, v]) => (row[c] as string) > (v as string))
  );
}

function chainFor(table: string) {
  const f: Filters = { eq: [], neq: [], in: [], lt: [], gt: [] };
  const rows = tables[table] ?? [];
  const chain = {
    eq(c: string, v: unknown) { f.eq.push([c, v]); return chain; },
    neq(c: string, v: unknown) { f.neq.push([c, v]); return chain; },
    in(c: string, v: unknown[]) { f.in.push([c, v]); return chain; },
    lt(c: string, v: unknown) { f.lt.push([c, v]); return chain; },
    gt(c: string, v: unknown) { f.gt.push([c, v]); return chain; },
    async maybeSingle() {
      queriedFilters.push({ table, eq: f.eq.map(([c]) => c) });
      return { data: rows.filter((r) => matches(r, f))[0] ?? null, error: null };
    },
    then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
      queriedFilters.push({ table, eq: f.eq.map(([c]) => c) });
      const matched = rows.filter((r) => matches(r, f));
      return Promise.resolve({ count: matched.length, data: matched, error: null }).then(ok, bad);
    },
  };
  return chain;
}

const rpcRows = vi.fn();
const fakeClient = {
  from: (table: string) => ({ select: () => chainFor(table) }),
  rpc: async (name: string) => (name === "preview_group_class_series" ? { data: rpcRows(), error: null } : { data: { series_id: "s1", materialized_count: 4, replay: false }, error: null }),
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: (error: unknown) => String((error as { digest?: string })?.digest ?? "").startsWith("NEXT_REDIRECT"),
}));
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: async () => ({
    supabase: fakeClient,
    studioId: "studio-1",
    user: { id: "user-1" },
    studioRole: "front_desk",
    isPlatformAdmin: false,
  }),
}));

const { previewGroupClassSeriesAction, createGroupClassSeriesAction } = await import("@/app/app/schedule/groupClassSeriesActions");

const STUDIO = "studio-1";
const INSTRUCTOR_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";

// Six occurrences, one every two days at 23:30Z for an hour.
function occurrence(index: number) {
  const start = new Date(Date.UTC(2027, 0, 12 + (index - 1) * 2, 23, 30));
  return {
    occurrence_index: index,
    local_date: start.toISOString().slice(0, 10),
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
    instructor_id: INSTRUCTOR_ID,
    room_id: ROOM_ID,
    location_name: null,
    roster_capacity: null,
    dst_note: null,
  };
}

function form(overrides: Record<string, string | string[]> = {}) {
  const values: Record<string, string | string[]> = {
    title: "Salsa 1",
    instructorId: INSTRUCTOR_ID,
    roomId: ROOM_ID,
    weekdays: ["2", "4"],
    startsOn: "2027-01-12",
    startTime: "18:30",
    endTime: "19:30",
    endMode: "count",
    occurrenceCount: "6",
    clientRequestId: "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9",
    ...overrides,
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  return fd;
}

const base = { studio_id: STUDIO, status: "scheduled", client_id: null };

beforeEach(() => {
  queriedFilters.length = 0;
  rpcRows.mockReturnValue([1, 2, 3, 4, 5, 6].map(occurrence));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  tables = { appointments: [], instructor_schedule_blocks: [], rooms: [{ id: ROOM_ID, max_simultaneous_bookings: 1 }] };
});

describe("series preview with the real conflict engine", () => {
  it("is clean when nothing overlaps, and never issues a client_id query (class client_id is NULL)", async () => {
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    if (state.status !== "preview") throw new Error("expected preview");
    expect(state.conflictCount).toBe(0);
    expect(queriedFilters.length).toBeGreaterThan(0);
    expect(queriedFilters.every((q) => !q.eq.includes("client_id"))).toBe(true);
  });

  it("surfaces every supported category, mapped to safe copy", async () => {
    tables.appointments = [
      // occurrence 1: an existing CANONICAL class (client_id NULL) by the same instructor
      { ...base, id: "a1", instructor_id: INSTRUCTOR_ID, room_id: null, appointment_type: "group_class", starts_at: "2027-01-12T23:45:00.000Z", ends_at: "2027-01-13T00:45:00.000Z", notes: "private notes" },
      // occurrence 3: the room is closed (room_unavailable block)
      { ...base, id: "a3", instructor_id: null, room_id: ROOM_ID, appointment_type: "room_unavailable", starts_at: "2027-01-16T23:00:00.000Z", ends_at: "2027-01-17T01:00:00.000Z" },
      // occurrence 4: an exclusive room occupant
      { ...base, id: "a4", instructor_id: "someone-else", room_id: ROOM_ID, appointment_type: "private_lesson", exclusive_room_use: true, client_id: "client-secret", starts_at: "2027-01-18T23:00:00.000Z", ends_at: "2027-01-19T01:00:00.000Z" },
    ];
    // occurrence 2: the instructor has a personal block
    tables.instructor_schedule_blocks = [
      { id: "b2", studio_id: STUDIO, instructor_id: INSTRUCTOR_ID, starts_at: "2027-01-14T23:00:00.000Z", ends_at: "2027-01-15T00:00:00.000Z" },
    ];

    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    if (state.status !== "preview") throw new Error("expected preview");
    expect(state.occurrences.map((o) => [o.index, o.conflict?.category ?? null])).toEqual([
      [1, "instructor_overlap"],
      [2, "instructor_block"],
      [3, "room_unavailable"],
      [4, "room_booked"],
      [5, null],
      [6, null],
    ]);
    expect(state.conflictCount).toBe(4);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/client-secret|private notes|someone-else|a1|a3|a4/);
  });

  it("room capacity (max simultaneous bookings) is enforced through the same engine", async () => {
    tables.appointments = [
      { ...base, id: "occ", instructor_id: "other", room_id: ROOM_ID, appointment_type: "group_class", starts_at: "2027-01-20T23:00:00.000Z", ends_at: "2027-01-21T01:00:00.000Z" },
    ];
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    if (state.status !== "preview") throw new Error("expected preview");
    expect(state.occurrences.map((o) => o.conflict?.category ?? null)).toEqual([null, null, null, null, "room_booked", null]);
  });

  it("does not look at another studio's bookings", async () => {
    tables.appointments = [
      { ...base, studio_id: "other-studio", id: "x", instructor_id: INSTRUCTOR_ID, room_id: ROOM_ID, appointment_type: "group_class", starts_at: "2027-01-12T23:00:00.000Z", ends_at: "2027-01-13T01:00:00.000Z" },
    ];
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    if (state.status !== "preview") throw new Error("expected preview");
    expect(state.conflictCount).toBe(0);
  });
});

describe("series create with the real conflict engine", () => {
  it("blocks on a real conflict and creates once the conflicting occurrence is explicitly skipped", async () => {
    tables.appointments = [
      { ...base, id: "a2", instructor_id: INSTRUCTOR_ID, room_id: null, appointment_type: "group_class", starts_at: "2027-01-14T23:00:00.000Z", ends_at: "2027-01-15T01:00:00.000Z" },
    ];

    const blocked = await createGroupClassSeriesAction({ status: "idle" }, form());
    if (blocked.status !== "conflict") throw new Error("expected conflict");
    expect(blocked.conflicts.map((c) => [c.index, c.conflict.category])).toEqual([[2, "instructor_overlap"]]);

    await expect(createGroupClassSeriesAction({ status: "idle" }, form({ skipIndices: ["2"] }))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });
});
