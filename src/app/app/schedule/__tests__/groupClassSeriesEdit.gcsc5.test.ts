import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GC-S1C-5: "This and following classes" series editing (application layer). The bulk-edit change set is diffed against the
 * SERIES DEFINITION, never against the selected class, so a customized class's own value can be propagated. The authoritative rules live in
 * edit_group_class_series_from (test_T_gcsc5 SQL suite + two-session harness); here we prove the action sends only
 * the diffed change set and the occurrence id, refuses an instructor before any RPC, requires the reviewed
 * fingerprint to still match, maps every outcome to fixed copy, never writes tables itself and never notifies.
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
vi.mock("@/lib/schedule/conflicts", () => ({
  detectAppointmentConflicts: vi.fn().mockResolvedValue({ hasConflict: false }),
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
const pushMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: (...a: unknown[]) => pushMock(...a),
  sendGroupClassCancellationPush: (...a: unknown[]) => pushMock(...a),
}));
const notifyMock = vi.fn();
vi.mock("@/lib/notifications/groupClassSeriesCancellation", () => ({
  notifySeriesCancellation: (...a: unknown[]) => notifyMock(...a),
}));
const queueMock = vi.fn();
vi.mock("@/lib/notifications/outbound", () => ({ queueOutboundDelivery: (...a: unknown[]) => queueMock(...a) }));

const requireEditAccessMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: vi.fn(),
  requireAppointmentEditAccess: (...a: unknown[]) => requireEditAccessMock(...a),
  requireAppointmentDeleteAccess: vi.fn(),
  requireAppointmentPaymentAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));
vi.mock("@/lib/auth/appointmentAccess", () => ({ requireAppointmentRelationshipAccess: vi.fn() }));

const { submitGroupClassSeriesEditAction } = await import("../actions");
const lib = await import("@/lib/schedule/groupClassSeriesEdit");
const cancel = await import("@/lib/schedule/groupClassCancel");
const { canEditGroupClassSeries, canCancelGroupClass } = await import("@/lib/auth/permissions");
const { default: SeriesEditFollowingForm } = await import("@/app/app/schedule/[id]/edit-following/SeriesEditFollowingForm");
const { default: GroupClassSeriesContext } = await import("@/app/app/schedule/[id]/edit/GroupClassSeriesContext");

const STUDIO = "studio-1";
const APPT = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const INSTRUCTOR = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";

// 2030-03-05 18:30 America/New_York = 23:30Z (EST), one hour long
const ANCHOR = {
  id: APPT,
  appointment_type: "group_class",
  group_class_series_id: "series-1",
  title: "Salsa",
  instructor_id: INSTRUCTOR,
  room_id: null,
  location_name: null,
  roster_capacity: 10,
  starts_at: "2030-03-05T23:30:00Z",
  ends_at: "2030-03-06T00:30:00Z",
};

const PREVIEW_RAW = {
  series_id: "series-1",
  anchor_index: 3,
  will_split: true,
  class_count: 4,
  editable_count: 4,
  changed_count: 4,
  cancelled_count: 0,
  historical_count: 0,
  terminal_attendance_count: 0,
  customized_count: 1,
  customized_fields: { title: 1 },
  overwrite: false,
  conflict_count: 0,
  first_conflict: null,
  capacity_blocked_count: 0,
};
const RESULT_RAW = {
  series_id: "series-2",
  predecessor_series_id: "series-1",
  split_created: true,
  moved_class_count: 4,
  edited_class_count: 4,
  preserved_customized_count: 1,
  overwritten_customized_count: 0,
  replay: false,
};

type Rpc = { data?: unknown; error?: { message: string } | null };

const SERIES_BASELINE = {
  title: "Salsa",
  default_instructor_id: INSTRUCTOR,
  default_room_id: null as string | null,
  default_location_name: null as string | null,
  default_roster_capacity: 10 as number | null,
  local_start_time: "18:30:00",
  duration_minutes: 60,
};

function makeSupabase(opts: { anchor?: unknown; series?: Partial<typeof SERIES_BASELINE> | null; previewRpc?: Rpc; editRpc?: Rpc } = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const writes: string[] = [];
  const supabase = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () =>
        Promise.resolve(
          table === "appointments"
            ? { data: opts.anchor === undefined ? ANCHOR : opts.anchor, error: null }
            : { data: opts.series === null ? null : { ...SERIES_BASELINE, ...(opts.series ?? {}) }, error: null },
        );
      chain.update = () => (writes.push(`update:${table}`), chain);
      chain.insert = () => (writes.push(`insert:${table}`), Promise.resolve({ error: null }));
      chain.delete = () => (writes.push(`delete:${table}`), chain);
      return chain;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "preview_group_class_series_edit") return Promise.resolve(opts.previewRpc ?? { data: PREVIEW_RAW, error: null });
      return Promise.resolve(opts.editRpc ?? { data: RESULT_RAW, error: null });
    },
  };
  return { supabase, rpcCalls, writes };
}

function form(fields: Record<string, string> = {}) {
  const fd = new FormData();
  const base: Record<string, string> = {
    appointmentId: APPT,
    title: "Salsa",
    instructorId: INSTRUCTOR,
    roomId: "",
    locationName: "",
    rosterCapacity: "10",
    startTime: "18:30",
    durationMinutes: "60",
    intent: "preview",
  };
  for (const [k, v] of Object.entries({ ...base, ...fields })) fd.set(k, v);
  return fd;
}
const IDLE = { status: "idle" } as const;
const run = (p: Promise<unknown>) => p.catch((e) => e);
const redirectUrl = (e: unknown) => ((e as { digest?: string })?.digest ?? "").split(";")[2] ?? "";
function asRole(supabase: unknown, studioRole: string, isPlatformAdmin = false) {
  requireEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO, user: { id: "u1" }, studioRole, isPlatformAdmin });
}

beforeEach(() => {
  requireEditAccessMock.mockReset();
  pushMock.mockClear();
  notifyMock.mockClear();
  queueMock.mockClear();
});

describe("S1C-5 action: authority and inputs", () => {
  it("an assigned instructor never reaches an RPC", async () => {
    const { supabase, rpcCalls } = makeSupabase();
    asRole(supabase, "instructor");
    const state = await submitGroupClassSeriesEditAction(IDLE, form({ title: "New" }));
    expect(state.status).toBe("error");
    expect(state.error).toBe("Only studio owners, admins and front desk can edit a series of classes.");
    expect(rpcCalls).toHaveLength(0);
  });

  it("owner, admin, front desk and platform admin may preview", async () => {
    for (const [role, admin] of [["studio_owner", false], ["studio_admin", false], ["front_desk", false], ["", true]] as const) {
      const { supabase, rpcCalls } = makeSupabase();
      asRole(supabase, role, admin);
      const state = await submitGroupClassSeriesEditAction(IDLE, form({ title: "New" }));
      expect(state.status).toBe("preview");
      expect(rpcCalls.map((c) => c.name)).toEqual(["preview_group_class_series_edit"]);
    }
  });

  it("a malformed occurrence id or a missing / standalone class is refused before any RPC", async () => {
    for (const [id, anchor] of [["not-a-uuid", undefined], [APPT, null], [APPT, { ...ANCHOR, appointment_type: "private_lesson" }], [APPT, { ...ANCHOR, group_class_series_id: null }]] as const) {
      const { supabase, rpcCalls } = makeSupabase({ anchor });
      asRole(supabase, "studio_owner");
      const state = await submitGroupClassSeriesEditAction(IDLE, form({ appointmentId: id, title: "New" }));
      expect(state.status).toBe("error");
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it("invalid values and an unchanged form are refused with fixed copy before any RPC", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ title: "   " }, "A class title is required."],
      [{ rosterCapacity: "0" }, "Maximum students must be a whole number of 1 or more, or left blank for no limit."],
      [{ rosterCapacity: "2.5" }, "Maximum students must be a whole number of 1 or more, or left blank for no limit."],
      [{ startTime: "25:00" }, "Choose a valid start time."],
      [{ durationMinutes: "3" }, "Class length must be between 5 and 720 minutes."],
      [{ instructorId: "x; drop table" }, "One of the values is not valid. Check the fields and try again."],
      [{}, "Nothing would change. Edit at least one field first."], // untouched relative to the series baseline
    ];
    for (const [fields, copy] of cases) {
      const { supabase, rpcCalls } = makeSupabase();
      asRole(supabase, "studio_owner");
      const state = await submitGroupClassSeriesEditAction(IDLE, form(fields));
      expect(state.error).toBe(copy);
      expect(rpcCalls).toHaveLength(0);
    }
  });
});

describe("S1C-5 action: preview then apply", () => {
  it("preview sends only the diffed changes (never ids or counts from the client) and returns lines + fingerprint", async () => {
    const { supabase, rpcCalls, writes } = makeSupabase();
    asRole(supabase, "studio_owner");
    const state = await submitGroupClassSeriesEditAction(
      IDLE,
      form({ title: "Salsa 2", startTime: "19:00", seriesId: "evil", studioId: "other", recipients: "x", classCount: "99" }),
    );
    expect(rpcCalls).toEqual([
      {
        name: "preview_group_class_series_edit",
        args: { p_appointment_id: APPT, p_changes: { title: "Salsa 2", local_start_time: "19:00" }, p_overwrite: false },
      },
    ]);
    expect(state.status).toBe("preview");
    expect(state.preview?.changedCount).toBe(4);
    expect(state.lines?.join(" ")).toContain("4 classes will be updated");
    expect(typeof state.fingerprint).toBe("string");
    expect(writes).toEqual([]);
  });

  it("apply with the reviewed fingerprint calls the one edit RPC and redirects with the count; nothing is notified", async () => {
    const { supabase, rpcCalls, writes } = makeSupabase();
    asRole(supabase, "studio_admin");
    const reviewed = await submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2" }));
    const err = await run(
      submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2", intent: "apply", requestId: REQ, reviewedFingerprint: reviewed.fingerprint ?? "" })),
    );
    expect(rpcCalls.map((c) => c.name)).toEqual([
      "preview_group_class_series_edit",
      "preview_group_class_series_edit",
      "edit_group_class_series_from",
    ]);
    expect(rpcCalls[2].args).toEqual({ p_appointment_id: APPT, p_client_request_id: REQ, p_changes: { title: "Salsa 2" }, p_overwrite: false });
    const url = redirectUrl(err);
    expect(url).toContain(`/app/schedule/${APPT}`);
    expect(url).toContain("success=series_edited");
    expect(url).toContain("count=4");
    expect(writes).toEqual([]);
    expect(pushMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(queueMock).not.toHaveBeenCalled();
  });

  it("the overwrite checkbox maps to p_overwrite and is part of what was reviewed", async () => {
    const { supabase, rpcCalls } = makeSupabase();
    asRole(supabase, "studio_owner");
    const reviewed = await submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2", overwriteCustomized: "on" }));
    expect(rpcCalls[0].args.p_overwrite).toBe(true);
    // reviewed WITHOUT overwrite, applied WITH it: the fingerprint no longer matches
    const withoutOverwrite = await submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2" }));
    expect(withoutOverwrite.fingerprint).not.toBe(reviewed.fingerprint);
    const state = await submitGroupClassSeriesEditAction(
      IDLE,
      form({ title: "Salsa 2", intent: "apply", requestId: REQ, overwriteCustomized: "on", reviewedFingerprint: withoutOverwrite.fingerprint ?? "" }),
    );
    expect(state.error).toBe("The classes changed since you reviewed them. Review the changes again.");
    expect(rpcCalls.some((c) => c.name === "edit_group_class_series_from")).toBe(false);
  });

  it("apply is refused when the reviewed fingerprint is missing, stale or the request id is not a uuid", async () => {
    for (const fields of [{ reviewedFingerprint: "" }, { reviewedFingerprint: "stale" }, { requestId: "nope" }] as Array<Record<string, string>>) {
      const { supabase, rpcCalls } = makeSupabase();
      asRole(supabase, "studio_owner");
      const state = await submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2", intent: "apply", requestId: REQ, ...fields }));
      expect(state.status).toBe("error");
      expect(rpcCalls.some((c) => c.name === "edit_group_class_series_from")).toBe(false);
    }
  });

  it("a different preview at apply time (classes changed in between) is refused", async () => {
    const first = makeSupabase();
    asRole(first.supabase, "studio_owner");
    const reviewed = await submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2" }));
    const second = makeSupabase({ previewRpc: { data: { ...PREVIEW_RAW, class_count: 3, changed_count: 3 }, error: null } });
    asRole(second.supabase, "studio_owner");
    const state = await submitGroupClassSeriesEditAction(
      IDLE,
      form({ title: "Salsa 2", intent: "apply", requestId: REQ, reviewedFingerprint: reviewed.fingerprint ?? "" }),
    );
    expect(state.error).toBe("The classes changed since you reviewed them. Review the changes again.");
    expect(second.rpcCalls.some((c) => c.name === "edit_group_class_series_from")).toBe(false);
  });
});

describe("S1C-5 action: errors are fixed copy", () => {
  async function applyWith(previewRpc: Rpc | undefined, editRpc: Rpc | undefined) {
    const { supabase } = makeSupabase({ previewRpc, editRpc });
    asRole(supabase, "studio_owner");
    const reviewed = await submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2" }));
    // fingerprint of the happy preview; the RPC under test is the apply
    const { supabase: s2 } = makeSupabase({ editRpc });
    asRole(s2, "studio_owner");
    return submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2", intent: "apply", requestId: REQ, reviewedFingerprint: reviewed.fingerprint ?? "" }));
  }

  it("maps every apply error to fixed copy with no raw database text", async () => {
    const cases: Array<[string, RegExp]> = [
      ["GCSC5_UNAUTHORIZED: Not authorized to edit classes in this series.", /Only studio owners/],
      ["GCSC5_ANCHOR_NOT_EDITABLE: This class can no longer be edited.", /can no longer be edited together/],
      ["GCSC5_SERIES_NOT_EDITABLE: This series can no longer be edited.", /can no longer be edited together/],
      ["GCSC5_NO_CHANGES: Nothing would change.", /Nothing would change/],
      ["GCSC5_INVALID_CHANGES: One of the values is not valid.", /not valid/],
      ["GCSC5_INSTRUCTOR_UNASSIGNABLE: nope", /active instructor/],
      ["GCSC5_ROOM_INVALID: nope", /active room/],
      ["GCSC5_IDEMPOTENCY_CONFLICT: used", /already used for a different change/],
      ["GCSC5_CONFLICT: reason=instructor index=3", /instructor is already booked.*Nothing was changed/],
      ["GCSC5_CONFLICT: reason=room_busy index=4", /room is already booked.*Nothing was changed/],
      ["GCSC3_CAPACITY_BELOW_BOOKED: Maximum students cannot be lower than the 3 students already booked.", /3 seats booked or reserved.*Nothing was changed/],
      ["GCSC3_CAPACITY_BELOW_BOOKED: Maximum students cannot be lower than the 2 seats already booked or reserved.", /2 seats booked or reserved.*Nothing was changed/],
      ["deadlock detected; relation \"appointments\" secret", /Could not update the classes/],
    ];
    for (const [message, expected] of cases) {
      const state = await applyWith(undefined, { error: { message } });
      expect(state.status).toBe("error");
      expect(state.error).toMatch(expected);
      expect(state.error).not.toMatch(/GCSC|deadlock|relation|secret|index=/);
    }
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("a malformed RPC result is a safe failure", async () => {
    const state = await applyWith(undefined, { data: "nope", error: null });
    expect(state.error).toBe("Could not update the classes. Please try again.");
  });

  it("preview errors map to fixed copy too", async () => {
    const { supabase } = makeSupabase({ previewRpc: { error: { message: "GCSC5_ANCHOR_NOT_EDITABLE: x relation secret" } } });
    asRole(supabase, "studio_owner");
    const state = await submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2" }));
    expect(state.error).toMatch(/can no longer be edited together/);
    expect(state.error).not.toMatch(/GCSC|secret|relation/);
  });
});

describe("S1C-5 remediation: the bulk edit is expressed against the series baseline (customized anchor)", () => {
  const OTHER = "55555555-5555-4555-8555-555555555555";

  // The selected class is customized (its own values live on the appointment row); the series definition is the baseline.
  // Every editable field, generically: the form carries the anchor's customized value; the change set must include it.
  const FIELDS: Array<{ name: string; series: Partial<typeof SERIES_BASELINE>; form: Record<string, string>; expected: Record<string, unknown> }> = [
    { name: "title", series: {}, form: { title: "Substitute title" }, expected: { title: "Substitute title" } },
    { name: "instructor", series: {}, form: { instructorId: OTHER }, expected: { instructor_id: OTHER } },
    { name: "room", series: {}, form: { roomId: ROOM }, expected: { room_id: ROOM } },
    { name: "location", series: {}, form: { locationName: "Annex" }, expected: { location_name: "Annex" } },
    { name: "capacity", series: {}, form: { rosterCapacity: "6" }, expected: { roster_capacity: 6 } },
    { name: "start time", series: {}, form: { startTime: "19:15" }, expected: { local_start_time: "19:15" } },
    { name: "duration", series: {}, form: { durationMinutes: "75" }, expected: { duration_minutes: 75 } },
    // clearing a field the series has set is also a change against the baseline
    { name: "clear capacity", series: {}, form: { rosterCapacity: "" }, expected: { roster_capacity: null } },
    { name: "clear instructor", series: {}, form: { instructorId: "" }, expected: { instructor_id: null } },
    // a series with a room: choosing no room is a change; choosing the series room is not
    { name: "clear room", series: { default_room_id: ROOM }, form: { roomId: "" }, expected: { room_id: null } },
  ];

  for (const field of FIELDS) {
    it(`propagating the selected class's customized ${field.name} is sent as a change even though that class already has it`, async () => {
      // the anchor already holds the customized value; the series baseline holds something else
      const { supabase, rpcCalls } = makeSupabase({
        series: field.series,
        anchor: {
          ...ANCHOR,
          title: field.form.title ?? ANCHOR.title,
          instructor_id: "instructorId" in field.form ? field.form.instructorId || null : ANCHOR.instructor_id,
          room_id: "roomId" in field.form ? field.form.roomId || null : ANCHOR.room_id,
          location_name: "locationName" in field.form ? field.form.locationName || null : ANCHOR.location_name,
        },
      });
      asRole(supabase, "studio_owner");
      const state = await submitGroupClassSeriesEditAction(IDLE, form(field.form));
      expect(state.status).toBe("preview");
      expect(rpcCalls).toEqual([
        { name: "preview_group_class_series_edit", args: { p_appointment_id: APPT, p_changes: field.expected, p_overwrite: false } },
      ]);
    });
  }

  it("the critical case: series instructor A, anchor customized to B, owner submits B -> the change set carries B", async () => {
    const A = INSTRUCTOR;
    const B = OTHER;
    const { supabase, rpcCalls } = makeSupabase({ series: { default_instructor_id: A }, anchor: { ...ANCHOR, instructor_id: B } });
    asRole(supabase, "studio_owner");
    await submitGroupClassSeriesEditAction(IDLE, form({ instructorId: B }));
    expect(rpcCalls[0].args.p_changes).toEqual({ instructor_id: B });
  });

  it("a mixed edit sends both the propagated customized value and the new bulk field", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, instructor_id: OTHER } });
    asRole(supabase, "studio_owner");
    await submitGroupClassSeriesEditAction(IDLE, form({ instructorId: OTHER, title: "Mixed" }));
    expect(rpcCalls[0].args.p_changes).toEqual({ instructor_id: OTHER, title: "Mixed" });
  });

  it("an untouched form (every field equal to the series baseline) is still refused, even when the selected class is customized", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, instructor_id: OTHER, title: "Customized", roster_capacity: 3 } });
    asRole(supabase, "studio_owner");
    // the form carries the BASELINE values (what the page prefills), so nothing differs from the series
    const state = await submitGroupClassSeriesEditAction(IDLE, form());
    expect(state.error).toBe("Nothing would change. Edit at least one field first.");
    expect(rpcCalls).toHaveLength(0);
  });

  it("the baseline time is read from the series definition (HH:MM:SS -> HH:MM) and a missing series is refused", async () => {
    const same = makeSupabase({ series: { local_start_time: "07:05:00" } });
    asRole(same.supabase, "studio_owner");
    await submitGroupClassSeriesEditAction(IDLE, form({ startTime: "07:05" }));
    expect(same.rpcCalls).toHaveLength(0); // equal to the baseline: not a change
    const missing = makeSupabase({ series: null });
    asRole(missing.supabase, "studio_owner");
    const state = await submitGroupClassSeriesEditAction(IDLE, form({ title: "x" }));
    expect(state.error).toBe("We couldn't find this class.");
  });

  it("the preserve/overwrite choice stays an explicit, separate input (the customized-anchor fix does not imply overwrite)", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, instructor_id: OTHER } });
    asRole(supabase, "studio_owner");
    await submitGroupClassSeriesEditAction(IDLE, form({ instructorId: OTHER }));
    await submitGroupClassSeriesEditAction(IDLE, form({ instructorId: OTHER, overwriteCustomized: "on" }));
    expect(rpcCalls.map((c) => c.args.p_overwrite)).toEqual([false, true]);
  });

  it("review staleness covers every reviewed value and the preserve/overwrite choice", () => {
    const base = { title: "T", instructorId: "", roomId: "", locationName: "", rosterCapacity: "", startTime: "18:30", durationMinutes: "60" };
    const key = lib.seriesEditReviewKey(base, false);
    expect(lib.isSeriesEditReviewStale(null, key)).toBe(true);
    expect(lib.isSeriesEditReviewStale(key, key)).toBe(false);
    expect(lib.isSeriesEditReviewStale(key, lib.seriesEditReviewKey(base, true))).toBe(true);
    for (const field of Object.keys(base) as Array<keyof typeof base>) {
      expect(lib.isSeriesEditReviewStale(key, lib.seriesEditReviewKey({ ...base, [field]: "changed" }, false))).toBe(true);
    }
  });

  it("the customized-anchor shortcut copies only the customized groups' fields", () => {
    const baseline = { title: "A", instructorId: "i1", roomId: "", locationName: "", rosterCapacity: "10", startTime: "18:30", durationMinutes: "60" };
    const anchor = { title: "B", instructorId: "i2", roomId: "r1", locationName: "L", rosterCapacity: "5", startTime: "19:00", durationMinutes: "90" };
    expect(lib.applyAnchorCustomizedValues(baseline, anchor, ["instructor"])).toEqual({ ...baseline, instructorId: "i2" });
    expect(lib.applyAnchorCustomizedValues(baseline, anchor, ["time", "title"])).toEqual({ ...baseline, title: "B", startTime: "19:00", durationMinutes: "90" });
    expect(lib.applyAnchorCustomizedValues(baseline, anchor, [])).toEqual(baseline);
    expect(lib.applyAnchorCustomizedValues(baseline, anchor, ["bogus"])).toEqual(baseline);
  });
});

describe("S1C-5 reset customizations to series values (explicit reset intent)", () => {
  const OTHER = "55555555-5555-4555-8555-555555555555";
  const BASELINE_KEYS: Record<string, Record<string, unknown>> = {
    title: { title: "Salsa" },
    instructor: { instructor_id: INSTRUCTOR },
    room: { room_id: null },
    location: { location_name: null },
    capacity: { roster_capacity: 10 },
    time: { local_start_time: "18:30", duration_minutes: 60 },
  };

  function resetForm(groups: string[], extra: Record<string, string> = {}) {
    const fd = form(extra);
    for (const g of groups) fd.append("resetGroups", g);
    return fd;
  }

  it("resetting a customized instructor sends the series-baseline value although it equals the baseline, as an overwrite", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, instructor_id: OTHER, series_overridden_fields: ["instructor"] } });
    asRole(supabase, "studio_owner");
    const state = await submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor"]));
    expect(state.status).toBe("preview");
    expect(rpcCalls).toEqual([
      { name: "preview_group_class_series_edit", args: { p_appointment_id: APPT, p_changes: { instructor_id: INSTRUCTOR }, p_overwrite: true } },
    ]);
  });

  it("the same request with the overwrite box also ticked is identical (the reset already implies the overwrite)", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, instructor_id: OTHER, series_overridden_fields: ["instructor"] } });
    asRole(supabase, "studio_owner");
    await submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor"], { overwriteCustomized: "on" }));
    expect(rpcCalls[0].args).toEqual({ p_appointment_id: APPT, p_changes: { instructor_id: INSTRUCTOR }, p_overwrite: true });
  });

  it("apply carries the reset and the overwrite to the one edit RPC", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, instructor_id: OTHER, series_overridden_fields: ["instructor"] } });
    asRole(supabase, "studio_owner");
    const reviewed = await submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor"]));
    const err = await run(
      submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor"], { intent: "apply", requestId: REQ, reviewedFingerprint: reviewed.fingerprint ?? "" })),
    );
    const edit = rpcCalls.find((c) => c.name === "edit_group_class_series_from");
    expect(edit?.args).toEqual({ p_appointment_id: APPT, p_client_request_id: REQ, p_changes: { instructor_id: INSTRUCTOR }, p_overwrite: true });
    expect(redirectUrl(err)).toContain("success=series_edited");
  });

  it("with several customized groups the owner can reset one without touching the others", async () => {
    const { supabase, rpcCalls } = makeSupabase({
      anchor: { ...ANCHOR, instructor_id: OTHER, title: "Customized", series_overridden_fields: ["instructor", "title"] },
    });
    asRole(supabase, "studio_owner");
    await submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor"]));
    expect(rpcCalls[0].args.p_changes).toEqual({ instructor_id: INSTRUCTOR });
    await submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor", "title"]));
    expect(rpcCalls[1].args.p_changes).toEqual({ instructor_id: INSTRUCTOR, title: "Salsa" });
  });

  for (const [group, expected] of Object.entries(BASELINE_KEYS)) {
    it(`the reset mechanism is generic: resetting ${group} sends exactly that group's baseline keys`, async () => {
      const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, series_overridden_fields: [group] } });
      asRole(supabase, "studio_owner");
      const state = await submitGroupClassSeriesEditAction(IDLE, resetForm([group]));
      expect(state.status).toBe("preview");
      expect(rpcCalls[0].args.p_changes).toEqual(expected);
      expect(rpcCalls[0].args.p_overwrite).toBe(true);
    });
  }

  it("a reset wins over a value typed into the same group, and leaves other typed changes alone", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, instructor_id: OTHER, series_overridden_fields: ["instructor"] } });
    asRole(supabase, "studio_owner");
    await submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor"], { instructorId: OTHER, title: "New title" }));
    expect(rpcCalls[0].args.p_changes).toEqual({ instructor_id: INSTRUCTOR, title: "New title" });
  });

  it("a reset can only be requested for a group the selected class has customized; anything else is ignored", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, series_overridden_fields: [] } });
    asRole(supabase, "studio_owner");
    const state = await submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor", "bogus"]));
    expect(state.error).toBe("Nothing would change. Edit at least one field first.");
    expect(rpcCalls).toHaveLength(0);
    const partial = makeSupabase({ anchor: { ...ANCHOR, series_overridden_fields: ["title"] } });
    asRole(partial.supabase, "studio_owner");
    await submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor", "title", "bogus"]));
    expect(partial.rpcCalls[0].args.p_changes).toEqual({ title: "Salsa" });
  });

  it("without any reset selection the earlier behavior is unchanged (propagation, preserve default)", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, instructor_id: OTHER, series_overridden_fields: ["instructor"] } });
    asRole(supabase, "studio_owner");
    await submitGroupClassSeriesEditAction(IDLE, form({ instructorId: OTHER }));
    expect(rpcCalls[0].args).toEqual({ p_appointment_id: APPT, p_changes: { instructor_id: OTHER }, p_overwrite: false });
  });

  it("an instructor still cannot reach the reset path", async () => {
    const { supabase, rpcCalls } = makeSupabase({ anchor: { ...ANCHOR, series_overridden_fields: ["instructor"] } });
    asRole(supabase, "instructor");
    const state = await submitGroupClassSeriesEditAction(IDLE, resetForm(["instructor"]));
    expect(state.error).toBe("Only studio owners, admins and front desk can edit a series of classes.");
    expect(rpcCalls).toHaveLength(0);
  });

  it("parseSeriesEditResetGroups keeps known customized groups only, in a stable order", () => {
    expect(lib.parseSeriesEditResetGroups(["time", "title", "title", "x"], ["title", "time", "room"])).toEqual(["title", "time"]);
    expect(lib.parseSeriesEditResetGroups(["instructor"], [])).toEqual([]);
    expect(lib.parseSeriesEditResetGroups([], ["title"])).toEqual([]);
  });

  it("buildSeriesEditChanges includes only the selected groups' baseline and nothing for untouched fields", () => {
    const current = { title: "Salsa", instructorId: INSTRUCTOR, roomId: null, locationName: null, rosterCapacity: 10, startTime: "18:30", durationMinutes: 60 };
    const same = { title: "Salsa", instructorId: INSTRUCTOR, roomId: "", locationName: "", rosterCapacity: "10", startTime: "18:30", durationMinutes: "60" };
    expect(lib.buildSeriesEditChanges(same, current)).toEqual({ ok: true, changes: {} });
    expect(lib.buildSeriesEditChanges(same, current, ["room", "capacity"])).toEqual({ ok: true, changes: { room_id: null, roster_capacity: 10 } });
    expect(lib.buildSeriesEditChanges(same, current, ["time"])).toEqual({ ok: true, changes: { local_start_time: "18:30", duration_minutes: 60 } });
  });

  it("review invalidation: changing the reset selection (or its order-insensitive set) makes the review stale", () => {
    const base = { title: "T", instructorId: "", roomId: "", locationName: "", rosterCapacity: "", startTime: "18:30", durationMinutes: "60" };
    const reviewed = lib.seriesEditReviewKey(base, true, ["instructor", "title"]);
    expect(lib.isSeriesEditReviewStale(reviewed, lib.seriesEditReviewKey(base, true, ["title", "instructor"]))).toBe(false);
    expect(lib.isSeriesEditReviewStale(reviewed, lib.seriesEditReviewKey(base, true, ["instructor"]))).toBe(true);
    expect(lib.isSeriesEditReviewStale(reviewed, lib.seriesEditReviewKey(base, true, []))).toBe(true);
    expect(lib.isSeriesEditReviewStale(lib.seriesEditReviewKey(base, false, []), lib.seriesEditReviewKey(base, false, ["room"]))).toBe(true);
  });

  const uiProps = {
    appointmentId: APPT,
    requestId: REQ,
    occurrenceLabel: "Class 3",
    defaults: { title: "Salsa", instructorId: INSTRUCTOR, roomId: "", locationName: "", rosterCapacity: "10", startTime: "18:30", durationMinutes: "60" },
    anchorValues: { title: "Customized", instructorId: OTHER, roomId: "", locationName: "", rosterCapacity: "10", startTime: "18:30", durationMinutes: "60" },
    instructors: [{ id: INSTRUCTOR, label: "Pat Smith" }],
    rooms: [{ id: ROOM, label: "Studio A" }],
    cancelHref: `/app/schedule/${APPT}/edit`,
  };

  it("a customized class offers one reset checkbox per customized group beside the use-values shortcut; none are pre-ticked", () => {
    const html = renderToStaticMarkup(createElement(SeriesEditFollowingForm, { ...uiProps, customizedGroups: ["instructor", "title"] }));
    expect(html).toContain("Reset customizations to series values");
    expect(html).toContain("Use this class&#x27;s values");
    expect(html).toMatch(/name="resetGroups"[^>]*value="instructor"/);
    expect(html).toMatch(/name="resetGroups"[^>]*value="title"/);
    expect(html).not.toMatch(/name="resetGroups"[^>]*value="room"/);
    expect(html).not.toMatch(/name="resetGroups"[^>]*checked/);
    expect(html).not.toContain('name="overwriteCustomized"');
  });

  it("a class that follows the series shows no reset controls", () => {
    const html = renderToStaticMarkup(createElement(SeriesEditFollowingForm, { ...uiProps, customizedGroups: [] }));
    expect(html).not.toContain("Reset customizations");
    expect(html).not.toContain("resetGroups");
  });
});

describe("S1C-5 pure helpers", () => {
  const CURRENT = { title: "Salsa", instructorId: INSTRUCTOR, roomId: null, locationName: null, rosterCapacity: 10, startTime: "18:30", durationMinutes: 60 };
  const SAME = { title: "Salsa", instructorId: INSTRUCTOR, roomId: "", locationName: "", rosterCapacity: "10", startTime: "18:30", durationMinutes: "60" };

  it("diffs the form against the class and clears nullable fields explicitly", () => {
    expect(lib.buildSeriesEditChanges(SAME, CURRENT)).toEqual({ ok: true, changes: {} });
    expect(lib.buildSeriesEditChanges({ ...SAME, title: " New ", instructorId: "", roomId: ROOM, locationName: " Floor ", rosterCapacity: "", startTime: "07:05", durationMinutes: "90" }, CURRENT)).toEqual({
      ok: true,
      changes: { title: "New", instructor_id: null, room_id: ROOM, location_name: "Floor", roster_capacity: null, local_start_time: "07:05", duration_minutes: 90 },
    });
  });

  it("never emits recurrence, date, notes or enrollment-policy keys", () => {
    const built = lib.buildSeriesEditChanges({ ...SAME, title: "X", rosterCapacity: "3", startTime: "09:00", durationMinutes: "45" }, CURRENT);
    expect(built.ok && Object.keys(built.changes).every((k) => ["title", "instructor_id", "room_id", "location_name", "roster_capacity", "local_start_time", "duration_minutes"].includes(k))).toBe(true);
  });

  it("local time of day and duration derive from the stored instants (DST aware)", () => {
    expect(lib.localTimeOfDay("2030-03-05T23:30:00Z", "America/New_York")).toBe("18:30");
    expect(lib.localTimeOfDay("2030-07-05T22:30:00Z", "America/New_York")).toBe("18:30");
    expect(lib.localTimeOfDay("garbage", "America/New_York")).toBeNull();
    expect(lib.localTimeOfDay("2030-03-05T23:30:00Z", "Not/AZone")).toBeNull();
    expect(lib.minutesBetween("2030-03-05T23:30:00Z", "2030-03-06T01:00:00Z")).toBe(90);
    expect(lib.minutesBetween("2030-03-05T23:30:00Z", "2030-03-05T23:30:00Z")).toBeNull();
  });

  it("parses preview and result defensively", () => {
    expect(lib.parseSeriesEditPreview(null)).toBeNull();
    expect(lib.parseSeriesEditPreview({ series_id: 1 })).toBeNull();
    const p = lib.parseSeriesEditPreview({ ...PREVIEW_RAW, customized_fields: { title: 2, bogus: 9 }, first_conflict: { reason: "room_busy", occurrence_index: 4 } });
    expect(p?.customizedFields).toEqual({ title: 2 });
    expect(p?.firstConflict).toEqual({ occurrenceIndex: 4, reason: "room_busy" });
    expect(lib.parseSeriesEditPreview({ ...PREVIEW_RAW, first_conflict: { reason: "<script>", occurrence_index: 1 } })?.firstConflict).toBeNull();
    expect(lib.parseSeriesEditResult("x")).toBeNull();
    expect(lib.parseSeriesEditResult(RESULT_RAW)?.editedClassCount).toBe(4);
  });

  it("preview wording: preserve is the default, overwrite is explicit, preserved classes are reported", () => {
    const base = lib.parseSeriesEditPreview(PREVIEW_RAW)!;
    const preserve = lib.seriesEditPreviewLines(base).join(" ");
    expect(preserve).toContain("4 classes will be updated, starting with this one.");
    expect(preserve).toContain("Earlier classes in the series stay exactly as they are.");
    expect(preserve).toContain("1 customized class keeps its own title.");
    expect(preserve).toContain("No notifications are sent.");
    const overwrite = lib.seriesEditPreviewLines({ ...base, overwrite: true }).join(" ");
    expect(overwrite).toContain("1 customized class will be changed to the new title.");
    const kept = lib.seriesEditPreviewLines({ ...base, cancelledCount: 1, historicalCount: 1, terminalAttendanceCount: 1 }).join(" ");
    expect(kept).toContain("3 classes stay unchanged");
    expect(lib.seriesEditPreviewLines({ ...base, willSplit: false }).join(" ")).not.toContain("Earlier classes");
  });

  it("fingerprint changes with the change set, overwrite choice and shown counts", () => {
    const p = lib.parseSeriesEditPreview(PREVIEW_RAW)!;
    const a = lib.seriesEditFingerprint({ title: "A", roster_capacity: 3 }, false, p);
    expect(lib.seriesEditFingerprint({ roster_capacity: 3, title: "A" }, false, p)).toBe(a);
    expect(lib.seriesEditFingerprint({ title: "B", roster_capacity: 3 }, false, p)).not.toBe(a);
    expect(lib.seriesEditFingerprint({ title: "A", roster_capacity: 3 }, true, p)).not.toBe(a);
    expect(lib.seriesEditFingerprint({ title: "A", roster_capacity: 3 }, false, { ...p, classCount: 5 })).not.toBe(a);
    expect(lib.seriesEditFingerprint({ title: "A", roster_capacity: 3 }, false, { ...p, conflictCount: 1 })).not.toBe(a);
  });

  it("classifies conflict reasons and capacity floors and ignores anything else", () => {
    expect(lib.classifySeriesEditError({ message: "GCSC5_CONFLICT: reason=instructor_block index=7" })).toEqual({ failure: "conflict", conflictReason: "instructor_block", conflictIndex: 7 });
    expect(lib.classifySeriesEditError({ message: "GCSC5_CONFLICT: reason=<script> index=7" }).failure).toBe("conflict");
    expect(lib.classifySeriesEditError({ message: "GCSC3_CAPACITY_BELOW_BOOKED: lower than the 1 students already booked" })).toMatchObject({ failure: "capacity_below_booked", booked: 1 });
    expect(lib.classifySeriesEditError({ message: "GCSC3_CAPACITY_BELOW_BOOKED: lower than the 5 seats already booked or reserved." })).toMatchObject({ failure: "capacity_below_booked", booked: 5 });
    expect(lib.classifySeriesEditError({ message: "boom" }).failure).toBe("unknown");
    expect(lib.classifySeriesEditError(null).failure).toBe("unknown");
  });

  it("success banner is count-safe and kind-matched", () => {
    expect(cancel.groupClassCancelBanner({ success: "series_edited", count: "4" })).toEqual({ kind: "success", message: "4 classes updated." });
    expect(cancel.groupClassCancelBanner({ success: "series_edited", count: "1" })?.message).toBe("1 class updated.");
    expect(cancel.groupClassCancelBanner({ success: "series_edited", count: "<b>" })?.message).toBe("Classes updated.");
    expect(cancel.groupClassCancelBanner({ error: "series_edited" })).toBeNull();
    expect(cancel.groupClassCancelBanner({ success: "series_cancelled", count: "2" })?.message).toContain("2 classes cancelled");
  });

  it("series edit authority is exactly broad staff (same set as series cancellation) and never the instructor", () => {
    for (const role of ["platform_admin", "studio_owner", "studio_admin", "front_desk", "instructor", "independent_instructor", "", null, undefined]) {
      expect(canEditGroupClassSeries(role)).toBe(canCancelGroupClass(role));
    }
    expect(canEditGroupClassSeries("instructor")).toBe(false);
  });
});

describe("S1C-5 UI", () => {
  const props = {
    appointmentId: APPT,
    requestId: REQ,
    occurrenceLabel: "Class 3",
    defaults: { title: "Salsa", instructorId: INSTRUCTOR, roomId: "", locationName: "", rosterCapacity: "10", startTime: "18:30", durationMinutes: "60" },
    anchorValues: { title: "Salsa", instructorId: INSTRUCTOR, roomId: "", locationName: "", rosterCapacity: "10", startTime: "18:30", durationMinutes: "60" },
    customizedGroups: [] as string[],
    instructors: [{ id: INSTRUCTOR, label: "Pat Smith" }],
    rooms: [{ id: ROOM, label: "Studio A" }],
    cancelHref: `/app/schedule/${APPT}/edit`,
  };

  it("the editor offers only series-safe fields, no recurrence / date / notes / enrollment controls, no overwrite until reviewed", () => {
    const html = renderToStaticMarkup(createElement(SeriesEditFollowingForm, props));
    for (const name of ["title", "instructorId", "roomId", "locationName", "rosterCapacity", "startTime", "durationMinutes"]) {
      expect(html).toContain(`name="${name}"`);
    }
    for (const forbidden of ["weekdays", "intervalWeeks", "occurrenceCount", "endsOn", "notes", "publiclyDiscoverable", "selfEnrollmentAllowed", "overwriteCustomized", "reviewedFingerprint"]) {
      expect(html).not.toContain(`name="${forbidden}"`);
    }
    expect(html).not.toMatch(/entire series/i);
    expect(html).toContain("Review changes");
    expect(html).not.toContain("Apply to");
    expect(html).toContain("starting with Class 3");
    expect(html).toContain('name="requestId"');
  });

  it("a customized selected class shows a note and the use-my-values shortcut; a class that follows the series does not", () => {
    const customized = renderToStaticMarkup(
      createElement(SeriesEditFollowingForm, { ...props, customizedGroups: ["instructor", "time"], anchorValues: { ...props.anchorValues, instructorId: "other" } }),
    );
    expect(customized).toContain("This class is customized");
    expect(customized).toContain("instructor, start time or length");
    expect(customized).toContain("Use this class&#x27;s values");
    // the fields start from the series values, not from the customized class
    expect(customized).toContain(`value="${INSTRUCTOR}" selected`);
    expect(renderToStaticMarkup(createElement(SeriesEditFollowingForm, props))).not.toContain("This class is customized");
  });

  it("the series context links to the following-classes editor only when the link is provided", () => {
    const withLink = renderToStaticMarkup(createElement(GroupClassSeriesContext, { occurrenceIndex: 3, overriddenFields: [], followingHref: "/app/schedule/x/edit-following" }));
    expect(withLink).toContain("Edit this and following classes instead");
    expect(withLink).toContain('href="/app/schedule/x/edit-following"');
    const without = renderToStaticMarkup(createElement(GroupClassSeriesContext, { occurrenceIndex: 3, overriddenFields: [] }));
    expect(without).not.toContain("following classes");
  });
});
