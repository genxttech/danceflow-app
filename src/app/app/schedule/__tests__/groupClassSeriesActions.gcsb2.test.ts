import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * GC-S1B B2: server actions for canonical group-class series. The role guard
 * and the conflict engine are mocked (the engine's own behavior, including
 * client_id = null, has dedicated coverage in
 * groupClassSeriesConflicts.gcsb2.test.ts against the REAL engine); these
 * tests drive the real action code: preview, create, the recheck-before-commit
 * control, skip semantics, idempotency, error mapping and authority.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: (error: unknown) =>
    typeof (error as { digest?: string })?.digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const detectAppointmentConflicts = vi.fn();
vi.mock("@/lib/schedule/conflicts", () => ({
  detectAppointmentConflicts: (...args: unknown[]) => detectAppointmentConflicts(...args),
}));

type GuardState = {
  studioId: string;
  studioRole: string | null;
  isPlatformAdmin: boolean;
  throwMessage: string | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => Promise<unknown>>;
};
const guard: GuardState = {
  studioId: "studio-ctx",
  studioRole: "studio_owner",
  isPlatformAdmin: false,
  throwMessage: null,
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>(),
};
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: async () => {
    if (guard.throwMessage) throw new Error(guard.throwMessage);
    return {
      supabase: { rpc: (name: string, args: Record<string, unknown>) => guard.rpc(name, args) },
      studioId: guard.studioId,
      user: { id: "user-1" },
      studioRole: guard.studioRole,
      isPlatformAdmin: guard.isPlatformAdmin,
    };
  },
}));

const { previewGroupClassSeriesAction, createGroupClassSeriesAction } = await import(
  "@/app/app/schedule/groupClassSeriesActions"
);

const REQUEST_ID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const INSTRUCTOR = "11111111-1111-4111-8111-111111111111";
const ROOM = "22222222-2222-4222-8222-222222222222";

function form(overrides: Record<string, string | string[] | undefined> = {}) {
  const values: Record<string, string | string[] | undefined> = {
    title: "Salsa 1",
    instructorId: INSTRUCTOR,
    roomId: ROOM,
    rosterCapacity: "12",
    weekdays: ["2", "4"],
    intervalWeeks: "1",
    startsOn: "2027-01-12",
    startTime: "18:30",
    endTime: "19:30",
    endMode: "count",
    occurrenceCount: "6",
    clientRequestId: REQUEST_ID,
    ...overrides,
  };
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) fd.append(key, item);
  }
  return fd;
}

function generated(count = 6, extra: Record<number, Record<string, unknown>> = {}) {
  return Array.from({ length: count }, (_, i) => {
    const index = i + 1;
    const start = new Date(Date.UTC(2027, 0, 12 + (index - 1) * 2, 23, 30));
    return {
      occurrence_index: index,
      local_date: start.toISOString().slice(0, 10),
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
      instructor_id: INSTRUCTOR,
      room_id: ROOM,
      location_name: null,
      roster_capacity: 12,
      dst_note: null,
      ...(extra[index] ?? {}),
    };
  });
}

function rpcBehavior(opts: {
  preview?: unknown[] | { message: string };
  create?: Record<string, unknown> | { message: string };
}) {
  guard.rpc.mockImplementation(async (name: string) => {
    const outcome = name === "preview_group_class_series" ? opts.preview ?? generated() : opts.create ?? { series_id: "series-1", materialized_count: 6, replay: false };
    if (outcome && !Array.isArray(outcome) && "message" in outcome && Object.keys(outcome).length === 1) {
      return { data: null, error: outcome };
    }
    return { data: outcome, error: null };
  });
}

async function runCreate(fd: FormData) {
  try {
    const state = await createGroupClassSeriesAction({ status: "idle" }, fd);
    return { state, redirectedTo: null as string | null };
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return { state: null, redirectedTo: digest.split(";")[2] };
    }
    throw error;
  }
}

const createCalls = () => guard.rpc.mock.calls.filter((c) => c[0] === "create_group_class_series");
const previewCalls = () => guard.rpc.mock.calls.filter((c) => c[0] === "preview_group_class_series");

beforeEach(() => {
  vi.clearAllMocks();
  guard.studioId = "studio-ctx";
  guard.studioRole = "studio_owner";
  guard.isPlatformAdmin = false;
  guard.throwMessage = null;
  detectAppointmentConflicts.mockResolvedValue({ hasConflict: false });
  rpcBehavior({});
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("previewGroupClassSeriesAction", () => {
  it("returns the generated occurrences with no conflicts and persists nothing", async () => {
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    expect(state.status).toBe("preview");
    if (state.status !== "preview") return;
    expect(state.occurrences).toHaveLength(6);
    expect(state.conflictCount).toBe(0);
    expect(state.materializedCount).toBe(6);
    expect(state.occurrences[0]).toEqual({
      index: 1,
      localDate: "2027-01-12",
      startsAt: "2027-01-12T23:30:00.000Z",
      endsAt: "2027-01-13T00:30:00.000Z",
      dstNote: null,
      conflict: null,
      skipped: false,
    });
    expect(createCalls()).toHaveLength(0);
    expect(previewCalls()).toHaveLength(1);
    expect(previewCalls()[0][1]).toMatchObject({
      p_studio_id: "studio-ctx",
      p_title: "Salsa 1",
      p_weekdays: [2, 4],
      p_interval_weeks: 1,
      p_starts_on: "2027-01-12",
      p_occurrence_count: 6,
      p_local_start_time: "18:30:00",
      p_duration_minutes: 60,
      p_roster_capacity: 12,
    });
  });

  it("passes the DST notes through", async () => {
    rpcBehavior({ preview: generated(3, { 2: { dst_note: "nonexistent_adjusted" }, 3: { dst_note: "ambiguous_later_selected" } }) });
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    if (state.status !== "preview") throw new Error("expected preview");
    expect(state.occurrences.map((o) => o.dstNote)).toEqual([null, "nonexistent_adjusted", "ambiguous_later_selected"]);
  });

  it("runs the conflict engine for every occurrence with the context studio, instructor, room and no client", async () => {
    await previewGroupClassSeriesAction({ status: "idle" }, form());
    expect(detectAppointmentConflicts).toHaveBeenCalledTimes(6);
    const first = detectAppointmentConflicts.mock.calls[0][0];
    expect(first).toEqual({
      studioId: "studio-ctx",
      startsAt: "2027-01-12T23:30:00.000Z",
      endsAt: "2027-01-13T00:30:00.000Z",
      instructorId: INSTRUCTOR,
      roomId: ROOM,
    });
    expect("clientId" in first).toBe(false);
  });

  it("merges conflicts as safe output only: category and canned copy, no raw engine text, no ids", async () => {
    detectAppointmentConflicts.mockImplementation(async ({ startsAt }: { startsAt: string }) => {
      if (startsAt.startsWith("2027-01-12")) return { hasConflict: true, message: "That instructor is already booked during this time." };
      if (startsAt.startsWith("2027-01-16")) return { hasConflict: true, message: "That room is unavailable during this time." };
      if (startsAt.startsWith("2027-01-20")) return { hasConflict: true, message: "Jane Doe already has a private lesson (notes: knee)" };
      return { hasConflict: false };
    });
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    if (state.status !== "preview") throw new Error("expected preview");
    expect(state.conflictCount).toBe(3);
    expect(state.occurrences.filter((o) => o.conflict).map((o) => [o.index, o.conflict?.category])).toEqual([
      [1, "instructor_overlap"],
      [3, "room_unavailable"],
      [5, "other"],
    ]);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/Jane|knee|private lesson/);
    expect(serialized).not.toContain(INSTRUCTOR);
    expect(serialized).not.toContain(ROOM);
  });

  it("flags skipped occurrences and excludes them from the conflict count", async () => {
    detectAppointmentConflicts.mockImplementation(async ({ startsAt }: { startsAt: string }) =>
      startsAt.startsWith("2027-01-12") ? { hasConflict: true, message: "That room is already booked during this time." } : { hasConflict: false },
    );
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form({ skipIndices: ["1"] }));
    if (state.status !== "preview") throw new Error("expected preview");
    expect(state.occurrences[0]).toMatchObject({ index: 1, skipped: true, conflict: { category: "room_booked" } });
    expect(state.conflictCount).toBe(0);
    expect(state.materializedCount).toBe(5);
  });

  it("skips the engine entirely when there is no instructor and no room to conflict with", async () => {
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form({ instructorId: undefined, roomId: undefined }));
    expect(state.status).toBe("preview");
    expect(detectAppointmentConflicts).not.toHaveBeenCalled();
  });

  it("fails closed when the conflict engine throws: no preview is returned as clean", async () => {
    detectAppointmentConflicts.mockRejectedValue(new Error("Room usage check failed: secret table detail"));
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    expect(state).toMatchObject({ status: "error", code: "conflict_check_failed" });
    expect(JSON.stringify(state)).not.toMatch(/secret|Room usage/);
  });

  it("rejects malformed input before any database call", async () => {
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form({ weekdays: undefined }));
    expect(state).toMatchObject({ status: "error", code: "invalid_recurrence" });
    expect(guard.rpc).not.toHaveBeenCalled();
    expect(detectAppointmentConflicts).not.toHaveBeenCalled();
  });

  it("maps database errors to safe copy and never returns raw text", async () => {
    rpcBehavior({ preview: { message: 'GCSB1_ROOM_INVALID: That room does not belong to this studio.' } });
    expect(await previewGroupClassSeriesAction({ status: "idle" }, form())).toMatchObject({ status: "error", code: "room_invalid" });

    rpcBehavior({ preview: { message: 'relation "group_class_series" does not exist at character 17' } });
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    expect(state).toMatchObject({ status: "error", code: "unknown" });
    expect(JSON.stringify(state)).not.toMatch(/relation|group_class_series|character/);
  });

  it("treats an empty generated schedule as an error", async () => {
    rpcBehavior({ preview: [] });
    expect(await previewGroupClassSeriesAction({ status: "idle" }, form())).toMatchObject({ status: "error", code: "no_occurrences" });
  });

  it("rejects a series whose generated occurrences would overlap each other", async () => {
    const rows = generated(2);
    rows[1].starts_at = new Date(Date.parse(rows[0].starts_at) + 1_800_000).toISOString();
    rows[1].ends_at = new Date(Date.parse(rows[0].starts_at) + 5_400_000).toISOString();
    rpcBehavior({ preview: rows });
    expect(await previewGroupClassSeriesAction({ status: "idle" }, form())).toMatchObject({ status: "error", code: "invalid_recurrence" });
    expect(detectAppointmentConflicts).not.toHaveBeenCalled();
  });
});

describe("createGroupClassSeriesAction", () => {
  it("creates a clean series through the RPC with the authoritative definition, then revalidates and redirects", async () => {
    const { redirectedTo, state } = await runCreate(form({ skipIndices: ["2", "4"], description: "Beginner" }));
    expect(state).toBeNull();
    expect(redirectedTo).toBe("/app/schedule");
    expect(revalidatePath).toHaveBeenCalledWith("/app/schedule");
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0][1]).toMatchObject({
      p_studio_id: "studio-ctx",
      p_client_request_id: REQUEST_ID,
      p_title: "Salsa 1",
      p_description: "Beginner",
      p_instructor_id: INSTRUCTOR,
      p_room_id: ROOM,
      p_weekdays: [2, 4],
      p_skip_indices: [2, 4],
      p_direct_payment_amount: null,
    });
  });

  it("re-generates and re-checks conflicts at submit time (never trusts a prior preview)", async () => {
    await runCreate(form());
    expect(previewCalls()).toHaveLength(1);
    expect(detectAppointmentConflicts).toHaveBeenCalledTimes(6);
    // preview RPC is invoked before the create RPC
    const order = guard.rpc.mock.calls.map((c) => c[0]);
    expect(order).toEqual(["preview_group_class_series", "create_group_class_series"]);
  });

  it("a stale clean preview cannot bypass a conflict that appeared afterwards", async () => {
    const preview = await previewGroupClassSeriesAction({ status: "idle" }, form());
    expect(preview).toMatchObject({ status: "preview", conflictCount: 0 });

    // A booking now exists on occurrence 3 (e.g. made by someone else between preview and submit).
    detectAppointmentConflicts.mockImplementation(async ({ startsAt }: { startsAt: string }) =>
      startsAt.startsWith("2027-01-16") ? { hasConflict: true, message: "That instructor is already booked during this time." } : { hasConflict: false },
    );
    guard.rpc.mockClear();
    const { state, redirectedTo } = await runCreate(form());
    expect(redirectedTo).toBeNull();
    expect(state).toMatchObject({ status: "conflict", code: "conflict" });
    expect(createCalls()).toHaveLength(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("blocks creation on an unskipped conflict and returns a structured, safe conflict list", async () => {
    detectAppointmentConflicts.mockImplementation(async ({ startsAt }: { startsAt: string }) =>
      startsAt.startsWith("2027-01-14") || startsAt.startsWith("2027-01-18")
        ? { hasConflict: true, message: "That room is already booked during this time." }
        : { hasConflict: false },
    );
    const { state } = await runCreate(form());
    if (!state || state.status !== "conflict") throw new Error("expected conflict");
    expect(state.conflicts.map((c) => [c.index, c.conflict.category])).toEqual([
      [2, "room_booked"],
      [4, "room_booked"],
    ]);
    expect(state.conflicts[0]).toEqual({
      index: 2,
      localDate: "2027-01-14",
      startsAt: "2027-01-14T23:30:00.000Z",
      endsAt: "2027-01-15T00:30:00.000Z",
      conflict: { category: "room_booked", message: "The room is already booked at this time." },
    });
    expect(createCalls()).toHaveLength(0);
  });

  it("allows creation when every conflicting occurrence is explicitly skipped, without renumbering", async () => {
    detectAppointmentConflicts.mockImplementation(async ({ startsAt }: { startsAt: string }) =>
      startsAt.startsWith("2027-01-14") || startsAt.startsWith("2027-01-18")
        ? { hasConflict: true, message: "That room is already booked during this time." }
        : { hasConflict: false },
    );
    const { redirectedTo } = await runCreate(form({ skipIndices: ["2", "4"] }));
    expect(redirectedTo).toBe("/app/schedule");
    expect(createCalls()[0][1].p_skip_indices).toEqual([2, 4]);
    // skipped occurrences are not even checked
    expect(detectAppointmentConflicts).toHaveBeenCalledTimes(4);
  });

  it("a conflict that is not in the skip set still blocks, even when other conflicts were skipped", async () => {
    detectAppointmentConflicts.mockImplementation(async ({ startsAt }: { startsAt: string }) =>
      startsAt.startsWith("2027-01-14") || startsAt.startsWith("2027-01-18")
        ? { hasConflict: true, message: "That instructor is already booked during this time." }
        : { hasConflict: false },
    );
    const { state } = await runCreate(form({ skipIndices: ["2"] }));
    if (!state || state.status !== "conflict") throw new Error("expected conflict");
    expect(state.conflicts.map((c) => c.index)).toEqual([4]);
    expect(createCalls()).toHaveLength(0);
  });

  it("rejects skipping every occurrence and skip indices outside the schedule", async () => {
    expect((await runCreate(form({ skipIndices: ["1", "2", "3", "4", "5", "6"] }))).state).toMatchObject({ status: "error", code: "no_occurrences" });
    expect((await runCreate(form({ skipIndices: ["9"] }))).state).toMatchObject({ status: "error", code: "invalid_skip" });
    expect(createCalls()).toHaveLength(0);
  });

  it("treats an idempotent replay as success", async () => {
    rpcBehavior({ create: { series_id: "series-1", materialized_count: 6, replay: true } });
    const { redirectedTo, state } = await runCreate(form());
    expect(state).toBeNull();
    expect(redirectedTo).toBe("/app/schedule");
  });

  it("maps an idempotency conflict to the safe refresh message", async () => {
    rpcBehavior({ create: { message: "GCSB1_IDEMPOTENCY_CONFLICT: This request was already used for a different class series." } });
    const { state } = await runCreate(form());
    expect(state).toEqual({
      status: "error",
      code: "idempotency_conflict",
      error: "This series was already created or changed. Refresh before trying again.",
    });
  });

  it.each([
    ["GCSB1_INSTRUCTOR_UNASSIGNABLE: x", "instructor_unassignable"],
    ["GCSB1_ROOM_INVALID: x", "room_invalid"],
    ["GCSB1_POLICY_INVALID: x", "policy_invalid"],
    ["GCSB1_OCCURRENCE_CAP_EXCEEDED: x", "occurrence_cap_exceeded"],
    ["GCSB1_UNAUTHORIZED: x", "unauthorized"],
  ])("maps the create RPC error %s", async (message, code) => {
    rpcBehavior({ create: { message } });
    expect((await runCreate(form())).state).toMatchObject({ status: "error", code });
  });

  it("never exposes a raw RPC or database error", async () => {
    const raw = 'duplicate key value violates unique constraint "uq_group_class_series_client_request" (secret: tenant 42)';
    rpcBehavior({ create: { message: raw } });
    const { state } = await runCreate(form());
    expect(state).toMatchObject({ status: "error", code: "unknown" });
    expect(JSON.stringify(state)).not.toMatch(/duplicate|constraint|uq_|secret|tenant/);
    // the raw text is only logged server-side
    expect(console.error).toHaveBeenCalled();
  });

  it("fails if the RPC returns no series id, and does not redirect", async () => {
    rpcBehavior({ create: {} });
    const { state, redirectedTo } = await runCreate(form());
    expect(redirectedTo).toBeNull();
    expect(state).toMatchObject({ status: "error", code: "unknown" });
  });

  it("fails closed on a conflict-engine failure without calling create", async () => {
    detectAppointmentConflicts.mockRejectedValue(new Error("db down"));
    const { state } = await runCreate(form());
    expect(state).toMatchObject({ status: "error", code: "conflict_check_failed" });
    expect(createCalls()).toHaveLength(0);
  });

  it("does not create when the preview RPC rejects the definition", async () => {
    rpcBehavior({ preview: { message: "GCSB1_INSTRUCTOR_UNASSIGNABLE: x" } });
    expect((await runCreate(form())).state).toMatchObject({ code: "instructor_unassignable" });
    expect(createCalls()).toHaveLength(0);
  });

  it("preserves the same request id across a retry after an ambiguous failure", async () => {
    rpcBehavior({ create: { message: "network reset" } });
    expect((await runCreate(form())).state).toMatchObject({ code: "unknown" });
    rpcBehavior({ create: { series_id: "series-1", materialized_count: 6, replay: true } });
    expect((await runCreate(form())).redirectedTo).toBe("/app/schedule");
    const ids = createCalls().map((c) => c[1].p_client_request_id);
    expect(ids).toEqual([REQUEST_ID, REQUEST_ID]);
  });

  it("requires a request id (no automatic generation that could defeat retry protection)", async () => {
    const { state } = await runCreate(form({ clientRequestId: undefined }));
    expect(state).toMatchObject({ status: "error", code: "invalid_input" });
    expect(guard.rpc).not.toHaveBeenCalled();
  });
});

describe("authority and tenant boundary", () => {
  it.each([
    ["studio_owner", false],
    ["studio_admin", false],
    ["front_desk", false],
    ["instructor", true],
    ["independent_instructor", true],
    [null, true],
  ])("role %s refused=%s", async (role, refused) => {
    guard.studioRole = role as string | null;
    const preview = await previewGroupClassSeriesAction({ status: "idle" }, form());
    const { state } = await runCreate(form());
    if (refused) {
      expect(preview).toMatchObject({ status: "error", code: "unauthorized" });
      expect(state).toMatchObject({ status: "error", code: "unauthorized" });
      expect(guard.rpc).not.toHaveBeenCalled();
    } else {
      expect(preview.status).toBe("preview");
    }
  });

  it("allows a platform admin", async () => {
    guard.studioRole = null;
    guard.isPlatformAdmin = true;
    expect((await previewGroupClassSeriesAction({ status: "idle" }, form())).status).toBe("preview");
    expect((await runCreate(form())).redirectedTo).toBe("/app/schedule");
  });

  it("maps a permission failure from the guard to unauthorized without leaking its message", async () => {
    guard.throwMessage = "You do not have permission to manage this appointment. (internal detail)";
    const state = await previewGroupClassSeriesAction({ status: "idle" }, form());
    expect(state).toMatchObject({ status: "error", code: "unauthorized" });
    expect(JSON.stringify(state)).not.toContain("internal detail");
  });

  it("ignores any submitted studio id: every RPC and conflict lookup uses the authenticated studio", async () => {
    await runCreate(form({ studioId: "other-studio", studio_id: "other-studio", p_studio_id: "other-studio" }));
    for (const call of guard.rpc.mock.calls) expect(call[1].p_studio_id).toBe("studio-ctx");
    for (const call of detectAppointmentConflicts.mock.calls) expect(call[0].studioId).toBe("studio-ctx");
  });
});

describe("compatibility guards", () => {
  const source = readFileSync(join(process.cwd(), "src/app/app/schedule/groupClassSeriesActions.ts"), "utf8");

  it("the series layer does not touch the one-time class RPC, legacy Events, Stripe, Twilio or the campaign allowance", () => {
    expect(source).not.toContain("create_group_class_appointment");
    expect(source).not.toMatch(/stripe|twilio|campaignAllowance|usage\/|createAdminClient|\bevent_sessions\b|\bevents\b/i);
  });

  it("the existing one-time class action file does not reference the series layer", () => {
    const actions = readFileSync(join(process.cwd(), "src/app/app/schedule/actions.ts"), "utf8");
    expect(actions).not.toMatch(/group_class_series|groupClassSeries|create_group_class_series|preview_group_class_series/);
    expect(actions).toContain('"create_group_class_appointment"');
  });
});
