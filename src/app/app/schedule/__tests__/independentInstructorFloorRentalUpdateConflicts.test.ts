import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B3: real conflict detection during floor-rental edit/reschedule.
 *
 * updateAppointmentAction (staff-side, unmodified by FC-1B3) already
 * threads excludeAppointmentId through to detectAppointmentConflicts --
 * confirmed by direct source read. This suite proves that wiring actually
 * works end to end against the REAL conflict engine (detectAppointmentConflicts
 * is NOT mocked here, unlike FC-1's own authorization-focused suite, which
 * mocks it away since it tests a different concern): editing a floor rental
 * back into its own current slot must not conflict with itself, but moving
 * it into a slot another appointment already occupies must be rejected.
 *
 * This path has no reachable /app UI for independent_instructor today
 * (FC-1B1 gated the edit page), but the action itself remains a legitimate,
 * FC-1-guarded entry point -- this suite verifies its pre-existing,
 * untouched conflict behavior is correct, it does not change it.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
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

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const requireFloorRentalAppointmentAccessMock = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...args: unknown[]) =>
    requireFloorRentalAppointmentAccessMock(...args),
  requireAppointmentCreateAccess: vi.fn(),
  requireAppointmentEditAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));

const { updateAppointmentAction } = await import("@/app/app/schedule/actions");

type Row = Record<string, unknown>;

const STUDIO_ID = "studio-1";
const USER_ID = "instructor-user-1";
const CLIENT_ID = "own-client-1";
const ROOM_ID = "room-1";
const APPOINTMENT_ID = "appt-being-edited";

const BASE = new Date("2099-06-15T12:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();
// toIsoFromLocalDateTime (the form-field parser) expects a local
// "YYYY-MM-DDTHH:mm:ss" value with no trailing milliseconds/Z -- the
// studio's fake timezone below is UTC, so this lines up numerically with
// iso() while satisfying the parser's expected shape.
const localDateTime = (offsetMs: number) => iso(offsetMs).slice(0, 19);

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
    gte(col: string, val: string) {
      current = current.filter((r) => String(r[col]) >= val);
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    update: () => {
      const updateChain: Record<string, unknown> = {};
      updateChain.eq = () => updateChain;
      updateChain.is = () => updateChain;
      updateChain.then = (onFulfilled: (v: { error: null }) => unknown) =>
        Promise.resolve({ error: null }).then(onFulfilled);
      return updateChain;
    },
    delete: () => {
      const deleteChain: Record<string, unknown> = {};
      deleteChain.eq = () => deleteChain;
      deleteChain.is = () => deleteChain;
      deleteChain.then = (onFulfilled: (v: { error: null }) => unknown) =>
        Promise.resolve({ error: null }).then(onFulfilled);
      return deleteChain;
    },
    insert: () => {
      const insertChain: Record<string, unknown> = {};
      insertChain.select = () => insertChain;
      insertChain.single = async () => ({ data: null, error: null });
      insertChain.then = (onFulfilled: (v: { error: null; data: null }) => unknown) =>
        Promise.resolve({ error: null, data: null }).then(onFulfilled);
      return insertChain;
    },
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

function existingAppointmentRow(overrides: Partial<Row> = {}): Row {
  return {
    id: APPOINTMENT_ID,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    appointment_type: "floor_space_rental",
    room_id: ROOM_ID,
    recurrence_series_id: null,
    starts_at: iso(0),
    ends_at: iso(HOUR),
    status: "scheduled",
    payment_status: "unpaid",
    ...overrides,
  };
}

function createFakeSupabase(appointments: Row[]) {
  const studios = [{ id: STUDIO_ID, timezone: "UTC" }];
  const clients = [
    { id: CLIENT_ID, studio_id: STUDIO_ID, is_independent_instructor: true },
  ];
  const links = [
    { id: "link-1", studio_id: STUDIO_ID, client_id: CLIENT_ID, user_id: USER_ID, status: "linked" },
  ];

  return {
    from(table: string) {
      if (table === "studios") return makeChain(studios);
      if (table === "clients") return makeChain(clients);
      if (table === "client_account_links") return makeChain(links);
      if (table === "appointments") return makeChain(appointments);
      // instructor_schedule_blocks, appointment_confirmation_tokens, and
      // every other side-effect table this update path may touch
      // (membership/lead-activity bookkeeping, outbound delivery) safely
      // no-op -- mirrors the same established catch-all FC-1's own
      // authorization suite already relies on to drive this action to
      // completion.
      return makeChain([]);
    },
  };
}

// detectAppointmentConflicts (unmocked here -- it's the real behavior under
// test) creates its own Supabase client internally via this same module
// rather than accepting one as a parameter, so it must resolve to the same
// fake the guard hands to the action, not a separate/empty client.
let fakeSupabaseForConflictCheck: unknown;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeSupabaseForConflictCheck,
}));

function mockGuard(supabase: unknown) {
  fakeSupabaseForConflictCheck = supabase;
  requireFloorRentalAppointmentAccessMock.mockResolvedValue({
    supabase,
    studioId: STUDIO_ID,
    studioRole: "independent_instructor",
    user: { id: USER_ID },
    isPlatformAdmin: false,
  });
}

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function runAction(formData: FormData) {
  return updateAppointmentAction({}, formData).catch((e) => e);
}

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  const match = digest.match(/^NEXT_REDIRECT;replace;([^;]*);/);
  return match?.[1] ?? "";
}

beforeEach(() => {
  requireFloorRentalAppointmentAccessMock.mockReset();
});

describe("updateAppointmentAction real conflict detection on floor-rental edit -- FC-1B3", () => {
  it("editing the rental back into its own current time/room does not conflict with itself", async () => {
    const existing = existingAppointmentRow();
    mockGuard(createFakeSupabase([existing]));

    const result = await runAction(
      formDataFor({
        appointmentId: APPOINTMENT_ID,
        clientId: CLIENT_ID,
        appointmentType: "floor_space_rental",
        roomId: ROOM_ID,
        startsAt: localDateTime(0),
        endsAt: localDateTime(HOUR),
      }),
    );

    // Reaching the success redirect (not a conflict error) proves
    // excludeAppointmentId correctly excluded the appointment's own row
    // from the room-occupancy check.
    expect(digestUrl(result)).toContain(`/app/schedule/${APPOINTMENT_ID}`);
  });

  it("moving the rental into a slot an EXCLUSIVE appointment already occupies is rejected", async () => {
    // FC-1B3 Room Resource Model Foundation: ordinary room overlap is no
    // longer a conflict (rooms may be shared) -- the "other" occupant must
    // be exclusive for this move to be genuinely rejected.
    const existing = existingAppointmentRow();
    const other = existingAppointmentRow({
      id: "appt-other",
      client_id: "unrelated-client",
      exclusive_room_use: true,
      starts_at: iso(3 * HOUR),
      ends_at: iso(4 * HOUR),
    });
    mockGuard(createFakeSupabase([existing, other]));

    const result = await runAction(
      formDataFor({
        appointmentId: APPOINTMENT_ID,
        clientId: CLIENT_ID,
        appointmentType: "floor_space_rental",
        roomId: ROOM_ID,
        // Reschedule into the other appointment's occupied window.
        startsAt: localDateTime(3 * HOUR + 15 * 60 * 1000),
        endsAt: localDateTime(3 * HOUR + 45 * 60 * 1000),
      }),
    );

    expect(result).toMatchObject({
      error: expect.stringContaining("already booked"),
    });
  });
});
