import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B3: Real Room Conflict / Double-Booking Prevention.
 *
 * Root cause: createFloorSpaceRentalAction previously only checked (a)
 * staff-authored room_unavailable blocks and (b) the requesting client's
 * own overlapping appointments -- never another renter's, or the studio's
 * own, real appointment in the same room. Two unrelated users could each
 * book the same room/time. This suite drives the real action end to end
 * (not a stand-in) against a fake Supabase client with genuine row
 * filtering, proving the actual room-overlap semantics now enforced via
 * detectAppointmentConflicts (the same engine the staff schedule already
 * uses) -- not just that some query fired.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const resolvePortalRelationshipMock = vi.fn();

vi.mock("@/lib/student-identity/portal-context", () => ({
  resolvePortalRelationship: (...args: unknown[]) =>
    resolvePortalRelationshipMock(...args),
}));

type Row = Record<string, unknown>;

const STUDIO_ID = "studio-1";
const OTHER_STUDIO_ID = "studio-2";
const STUDIO_SLUG = "test-studio";
const USER_ID = "user-ii-1";
const CLIENT_ID = "own-client-1";
const ROOM_ID = "room-1";
const OTHER_ROOM_ID = "room-2";

const HOUR = 60 * 60 * 1000;
// A fixed far-future noon-UTC anchor rather than Date.now(): keeps every
// offset (including the +/-90min ones below) safely away from a UTC
// calendar-day boundary regardless of the real time this suite happens to
// run at, and is always in the future so "past time slot" validation never
// interferes.
const NOW = new Date("2099-06-15T12:00:00.000Z").getTime();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function makeChain(rows: Row[]) {
  let current = rows;

  const chain: Record<string, unknown> = {
    select: () => chain,
    eq(col: string, val: unknown) {
      current = current.filter((r) => r[col] === val);
      return chain;
    },
    neq(col: string, val: unknown) {
      current = current.filter((r) => r[col] !== val);
      return chain;
    },
    in(col: string, vals: unknown[]) {
      current = current.filter((r) => vals.includes(r[col]));
      return chain;
    },
    is(col: string, val: unknown) {
      if (val === null) {
        current = current.filter((r) => r[col] === null || r[col] === undefined);
      }
      return chain;
    },
    lt(col: string, val: string) {
      current = current.filter((r) => String(r[col]) < val);
      return chain;
    },
    gt(col: string, val: string) {
      current = current.filter((r) => String(r[col]) > val);
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    async single() {
      return current.length
        ? { data: current[0], error: null }
        : { data: null, error: { message: "Row not found" } };
    },
    async maybeSingle() {
      return { data: current[0] ?? null, error: null };
    },
    then(
      onFulfilled: (v: { data: Row[]; error: null; count: number }) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) {
      return Promise.resolve({ data: current, error: null, count: current.length }).then(
        onFulfilled,
        onRejected,
      );
    },
  };

  return chain;
}

function roomRow(overrides: Partial<Row> = {}): Row {
  return { id: ROOM_ID, studio_id: STUDIO_ID, active: true, ...overrides };
}

function clientRow(overrides: Partial<Row> = {}): Row {
  return {
    id: CLIENT_ID,
    studio_id: STUDIO_ID,
    first_name: "Own",
    last_name: "Instructor",
    is_independent_instructor: true,
    linked_instructor_id: null,
    ...overrides,
  };
}

function appointmentRow(overrides: Partial<Row> = {}): Row {
  return {
    id: `appt-${Math.random().toString(36).slice(2)}`,
    studio_id: STUDIO_ID,
    client_id: "unrelated-client",
    instructor_id: null,
    room_id: ROOM_ID,
    appointment_type: "private_lesson",
    status: "scheduled",
    starts_at: iso(0),
    ends_at: iso(HOUR),
    ...overrides,
  };
}

function createFakeSupabase(options: {
  appointments?: Row[];
  instructorScheduleBlocks?: Row[];
  rooms?: Row[];
  clients?: Row[];
}) {
  const state = {
    appointments: options.appointments ?? [],
    insertedRows: [] as Row[],
  };

  const rooms = options.rooms ?? [roomRow()];
  const clients = options.clients ?? [clientRow()];
  // UTC keeps the action's local-timezone-to-UTC conversion a no-op, so the
  // test's own ISO offsets line up exactly with what the action computes --
  // avoids DST/offset arithmetic entirely rather than fighting it.
  const studios = [{ id: STUDIO_ID, slug: STUDIO_SLUG, name: "Test Studio", timezone: "UTC" }];
  const instructorScheduleBlocks = options.instructorScheduleBlocks ?? [];

  const supabase = {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } } }),
    },
    from(table: string) {
      if (table === "studios") return makeChain(studios);
      if (table === "clients") return makeChain(clients);
      if (table === "rooms") return makeChain(rooms);
      if (table === "instructor_schedule_blocks") return makeChain(instructorScheduleBlocks);

      if (table === "appointments") {
        const chain = makeChain(state.appointments) as Record<string, unknown> & {
          insert?: (rows: Row[]) => unknown;
        };
        chain.insert = (rowsToInsert: Row[]) => {
          state.insertedRows.push(...rowsToInsert);
          return {
            then(onFulfilled: (v: { error: null }) => unknown) {
              return Promise.resolve({ error: null }).then(onFulfilled);
            },
          };
        };
        return chain;
      }

      return makeChain([]);
    },
  };

  return { supabase, state };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeSupabase,
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>["supabase"];

const { createFloorSpaceRentalAction } = await import("../actions");

function mockRelationship(overrides: Partial<Row> = {}) {
  resolvePortalRelationshipMock.mockResolvedValue({
    linkId: "link-1",
    clientId: CLIENT_ID,
    studioId: STUDIO_ID,
    relationshipType: "self",
    isPrimary: true,
    canViewSchedule: true,
    canViewBilling: true,
    canManageBookings: true,
    canSignDocuments: false,
    ...overrides,
  });
}

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function slotFormData(params: {
  startOffsetMs: number;
  endOffsetMs: number;
  roomId?: string;
  extra?: Record<string, string>;
}) {
  const start = new Date(NOW + params.startOffsetMs);
  const end = new Date(NOW + params.endOffsetMs);
  const dateKey = start.toISOString().slice(0, 10);
  const startTime = start.toISOString().slice(11, 16);
  const endTime = end.toISOString().slice(11, 16);

  return formDataFor({
    studioSlug: STUDIO_SLUG,
    clientId: CLIENT_ID,
    roomId: params.roomId ?? ROOM_ID,
    slotsJson: JSON.stringify([
      { date: dateKey, startTime, endTime, priceAmount: "50" },
    ]),
    ...(params.extra ?? {}),
  });
}

function multiSlotFormData(params: {
  slots: { startOffsetMs: number; endOffsetMs: number }[];
  roomId?: string;
}) {
  const slots = params.slots.map(({ startOffsetMs, endOffsetMs }) => {
    const start = new Date(NOW + startOffsetMs);
    const end = new Date(NOW + endOffsetMs);
    return {
      date: start.toISOString().slice(0, 10),
      startTime: start.toISOString().slice(11, 16),
      endTime: end.toISOString().slice(11, 16),
      priceAmount: "50",
    };
  });

  return formDataFor({
    studioSlug: STUDIO_SLUG,
    clientId: CLIENT_ID,
    roomId: params.roomId ?? ROOM_ID,
    slotsJson: JSON.stringify(slots),
  });
}

async function runAction(formData: FormData) {
  return createFloorSpaceRentalAction({ error: "", success: "" }, formData).catch((e) => e);
}

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  const match = digest.match(/^NEXT_REDIRECT;replace;([^;]*);/);
  return match?.[1] ?? "";
}

beforeEach(() => {
  resolvePortalRelationshipMock.mockReset();
});

describe("createFloorSpaceRentalAction room-conflict prevention -- FC-1B3", () => {
  it("booking into a truly free room/time succeeds", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({ appointments: [] });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("same-room shared (non-exclusive) usage succeeds -- rooms may be shared", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ starts_at: iso(0), ends_at: iso(HOUR), exclusive_room_use: false }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("an existing EXCLUSIVE booking's exact overlap is rejected", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ starts_at: iso(0), ends_at: iso(HOUR), exclusive_room_use: true }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(result).toMatchObject({
      error: "That room is unavailable for the selected time. Choose another room or time.",
    });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("an existing EXCLUSIVE booking's partial overlap at the start is rejected", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({
          starts_at: iso(-30 * 60 * 1000),
          ends_at: iso(30 * 60 * 1000),
          exclusive_room_use: true,
        }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("unavailable") });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("an existing EXCLUSIVE booking's partial overlap at the end is rejected", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({
          starts_at: iso(30 * 60 * 1000),
          ends_at: iso(90 * 60 * 1000),
          exclusive_room_use: true,
        }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("unavailable") });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("a requested booking fully inside an existing EXCLUSIVE booking is rejected", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ starts_at: iso(-HOUR), ends_at: iso(2 * HOUR), exclusive_room_use: true }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("unavailable") });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("a requested booking fully containing an existing EXCLUSIVE booking is rejected", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({
          starts_at: iso(15 * 60 * 1000),
          ends_at: iso(45 * 60 * 1000),
          exclusive_room_use: true,
        }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("unavailable") });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("a back-to-back booking (existing exclusive booking ends exactly when requested starts) is allowed", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ starts_at: iso(-HOUR), ends_at: iso(0), exclusive_room_use: true }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("a back-to-back booking (requested ends exactly when an existing exclusive booking starts) is allowed", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ starts_at: iso(HOUR), ends_at: iso(2 * HOUR), exclusive_room_use: true }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("capacity 1 rejects a second simultaneous booking in that room", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ starts_at: iso(0), ends_at: iso(HOUR), exclusive_room_use: false }),
      ],
      rooms: [roomRow({ max_simultaneous_bookings: 1 })],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(result).toMatchObject({
      error: "That room is unavailable for the selected time. Choose another room or time.",
    });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("capacity 2 allows a second simultaneous booking in that room", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ starts_at: iso(0), ends_at: iso(HOUR), exclusive_room_use: false }),
      ],
      rooms: [roomRow({ max_simultaneous_bookings: 2 })],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("a different room at the same time is allowed", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [appointmentRow({ room_id: OTHER_ROOM_ID, starts_at: iso(0), ends_at: iso(HOUR) })],
      rooms: [roomRow(), roomRow({ id: OTHER_ROOM_ID })],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR, roomId: ROOM_ID }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("an identical room/time booking at a different studio is irrelevant", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ studio_id: OTHER_STUDIO_ID, starts_at: iso(0), ends_at: iso(HOUR) }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("a cancelled appointment in the same room/time does not block the booking", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ status: "cancelled", starts_at: iso(0), ends_at: iso(HOUR) }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("a room-specific room_unavailable block rejects the booking", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({
          appointment_type: "room_unavailable",
          client_id: "n/a",
          title: "Staff-only maintenance window",
          starts_at: iso(0),
          ends_at: iso(HOUR),
        }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(result).toMatchObject({
      error: "That room is unavailable for the selected time. Choose another room or time.",
    });
    // Privacy: the staff-authored block's internal title must never leak.
    expect((result as { error: string }).error).not.toContain("Staff-only maintenance window");
    expect(state.insertedRows).toHaveLength(0);
  });

  it("a studio-wide room_unavailable block (room_id null) rejects the booking regardless of room", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({
          appointment_type: "room_unavailable",
          client_id: "n/a",
          room_id: null,
          title: "Studio closed for holiday",
          starts_at: iso(0),
          ends_at: iso(HOUR),
        }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(result).toMatchObject({
      error: "That room is unavailable for the selected time. Choose another room or time.",
    });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("FC-1B3: another independent instructor's non-exclusive floor rental in the same room/time SUCCEEDS -- rooms may be shared", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({
          client_id: "other-ii-client",
          appointment_type: "floor_space_rental",
          exclusive_room_use: false,
          starts_at: iso(0),
          ends_at: iso(HOUR),
        }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("FC-1B3: an ordinary non-exclusive staff/client appointment in the same room/time SUCCEEDS -- rooms may be shared", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({
          client_id: "regular-student",
          appointment_type: "private_lesson",
          exclusive_room_use: false,
          starts_at: iso(0),
          ends_at: iso(HOUR),
        }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("the conflict error is generic and identical regardless of cause -- no identity/type/title/id leak", async () => {
    mockRelationship();
    const { supabase } = createFakeSupabase({
      appointments: [
        appointmentRow({
          client_id: "some-other-client",
          instructor_id: "some-instructor",
          appointment_type: "coaching",
          title: "Coaching session with VIP client",
          notes: "Confidential notes",
          payment_status: "paid",
          exclusive_room_use: true,
          starts_at: iso(0),
          ends_at: iso(HOUR),
        }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({ startOffsetMs: 0, endOffsetMs: HOUR }),
    );

    const error = (result as { error: string }).error;
    expect(error).toBe(
      "That room is unavailable for the selected time. Choose another room or time.",
    );
    expect(error).not.toContain("VIP");
    expect(error).not.toContain("Confidential");
    expect(error).not.toContain("coaching");
    expect(error).not.toContain("some-other-client");
    expect(error).not.toContain("some-instructor");
    expect(error).not.toContain("paid");
  });

  it("a forged overrideRoomConflict form field does not bypass a real EXCLUSIVE conflict", async () => {
    // FC-1B3 Room Resource Model Foundation: the dead overrideRoomConflict
    // UI control was removed (it never worked, before or after FC-1B3, and
    // its "override overlap" premise no longer matches a model where
    // overlap alone isn't a conflict) -- this proves the action itself
    // still ignores a forged field even if a client posts one directly,
    // now against the one real hard-block case that remains: exclusivity.
    mockRelationship();
    const { supabase, state } = createFakeSupabase({
      appointments: [
        appointmentRow({ starts_at: iso(0), ends_at: iso(HOUR), exclusive_room_use: true }),
      ],
    });
    fakeSupabase = supabase;

    const result = await runAction(
      slotFormData({
        startOffsetMs: 0,
        endOffsetMs: HOUR,
        extra: { overrideRoomConflict: "true" },
      }),
    );

    expect(result).toMatchObject({
      error: "That room is unavailable for the selected time. Choose another room or time.",
    });
    expect(state.insertedRows).toHaveLength(0);
  });
});

describe("createFloorSpaceRentalAction same-request sibling-slot overlap -- FC-1B3A", () => {
  it("two non-overlapping submitted slots both succeed", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({ appointments: [] });
    fakeSupabase = supabase;

    const result = await runAction(
      multiSlotFormData({
        slots: [
          { startOffsetMs: 0, endOffsetMs: HOUR },
          { startOffsetMs: 2 * HOUR, endOffsetMs: 3 * HOUR },
        ],
      }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(2);
  });

  it("back-to-back submitted slots both succeed", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({ appointments: [] });
    fakeSupabase = supabase;

    const result = await runAction(
      multiSlotFormData({
        slots: [
          { startOffsetMs: 0, endOffsetMs: HOUR },
          { startOffsetMs: HOUR, endOffsetMs: 2 * HOUR },
        ],
      }),
    );

    expect(digestUrl(result)).toContain("floor_rentals_booked");
    expect(state.insertedRows).toHaveLength(2);
  });

  it("identical sibling slots are rejected", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({ appointments: [] });
    fakeSupabase = supabase;

    const result = await runAction(
      multiSlotFormData({
        slots: [
          { startOffsetMs: 0, endOffsetMs: HOUR },
          { startOffsetMs: 0, endOffsetMs: HOUR },
        ],
      }),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("Duplicate") });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("partial sibling overlap is rejected", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({ appointments: [] });
    fakeSupabase = supabase;

    const result = await runAction(
      multiSlotFormData({
        slots: [
          { startOffsetMs: 0, endOffsetMs: HOUR },
          { startOffsetMs: 30 * 60 * 1000, endOffsetMs: 90 * 60 * 1000 },
        ],
      }),
    );

    expect(result).toMatchObject({
      error: "Two of the selected time slots overlap. Adjust the times and try again.",
    });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("one sibling slot fully containing another is rejected", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({ appointments: [] });
    fakeSupabase = supabase;

    const result = await runAction(
      multiSlotFormData({
        slots: [
          { startOffsetMs: 0, endOffsetMs: 2 * HOUR },
          { startOffsetMs: 30 * 60 * 1000, endOffsetMs: 90 * 60 * 1000 },
        ],
      }),
    );

    expect(result).toMatchObject({
      error: "Two of the selected time slots overlap. Adjust the times and try again.",
    });
    expect(state.insertedRows).toHaveLength(0);
  });

  it("sibling-overlap validation runs before any database write", async () => {
    mockRelationship();
    const { supabase, state } = createFakeSupabase({ appointments: [] });
    fakeSupabase = supabase;

    await runAction(
      multiSlotFormData({
        slots: [
          { startOffsetMs: 0, endOffsetMs: HOUR },
          { startOffsetMs: 15 * 60 * 1000, endOffsetMs: 45 * 60 * 1000 },
        ],
      }),
    );

    // Nothing was ever inserted -- not even the first, non-conflicting slot
    // -- proving the whole batch is validated before any write is attempted.
    expect(state.insertedRows).toHaveLength(0);
  });

  it("the sibling-overlap error is generic and leaks no internal detail", async () => {
    mockRelationship();
    const { supabase } = createFakeSupabase({ appointments: [] });
    fakeSupabase = supabase;

    const result = await runAction(
      multiSlotFormData({
        slots: [
          { startOffsetMs: 0, endOffsetMs: HOUR },
          { startOffsetMs: 30 * 60 * 1000, endOffsetMs: 90 * 60 * 1000 },
        ],
      }),
    );

    const error = (result as { error: string }).error;
    expect(error).toBe("Two of the selected time slots overlap. Adjust the times and try again.");
    expect(error).not.toContain(ROOM_ID);
    expect(error).not.toContain(CLIENT_ID);
    expect(error).not.toContain(STUDIO_ID);
  });
});
