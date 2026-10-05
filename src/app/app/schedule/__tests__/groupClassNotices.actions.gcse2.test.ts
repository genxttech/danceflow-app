import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-S1E-2: where the notices are triggered. The orchestrators themselves are proven in
 * src/lib/notifications/__tests__/groupClassNotices.gcse2.test.ts; here the server actions run with the orchestrators stubbed
 * so we prove WHEN each one is called (only after the mutation committed), with WHAT (only what the operation actually did),
 * and that a refused, stale, no-op or failed operation notifies nobody.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  isRedirectError: (error: unknown) =>
    typeof (error as { digest?: string })?.digest === "string" && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
}));
vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: (error: unknown) =>
    typeof (error as { digest?: string })?.digest === "string" && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/schedule/conflicts", () => ({ detectAppointmentConflicts: vi.fn().mockResolvedValue({ hasConflict: false }) }));
vi.mock("@/lib/compensation/earnings", () => ({ stageInstructorEarningForAppointment: vi.fn().mockResolvedValue({ staged: false }) }));
vi.mock("@/lib/packages/lifecycle", () => ({ reconcileClientPackageLifecycle: vi.fn().mockResolvedValue({ completedPackageIds: [] }) }));
vi.mock("@/lib/instructors/assignability", () => ({
  isInstructionalAppointmentType: () => true,
  validateAssignableInstructor: vi.fn().mockResolvedValue(null),
  assignmentRelationshipChanged: () => false,
}));
vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: vi.fn().mockResolvedValue(undefined),
  sendGroupClassCancellationPush: vi.fn().mockResolvedValue(undefined),
  sendGroupClassNoticePush: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/notifications/groupClassSeriesCancellation", () => ({ notifySeriesCancellation: vi.fn() }));

const m = vi.hoisted(() => ({
  changed: vi.fn(),
  enrolled: vi.fn(),
  removed: vi.fn(),
  removedByAttendee: vi.fn(),
  seriesChanged: vi.fn(),
  snapshotFollowing: vi.fn(),
  snapshotByIds: vi.fn(),
  noticeLine: vi.fn(),
}));
vi.mock("@/lib/notifications/groupClassNotices", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/notifications/groupClassNotices")>();
  return {
    ...actual,
    notifyGroupClassChanged: (...a: unknown[]) => m.changed(...a),
    notifyGroupClassEnrolled: (...a: unknown[]) => m.enrolled(...a),
    notifyGroupClassRemoved: (...a: unknown[]) => m.removed(...a),
    notifyGroupClassRemovedByAttendee: (...a: unknown[]) => m.removedByAttendee(...a),
    notifyGroupClassSeriesChanged: (...a: unknown[]) => m.seriesChanged(...a),
    snapshotSeriesFollowing: (...a: unknown[]) => m.snapshotFollowing(...a),
    snapshotClassesByIds: (...a: unknown[]) => m.snapshotByIds(...a),
    seriesEditNoticeLine: (...a: unknown[]) => m.noticeLine(...a),
  };
});

const requireEditAccessMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...a: unknown[]) => requireEditAccessMock(...a),
  requireAppointmentEditAccess: (...a: unknown[]) => requireEditAccessMock(...a),
  requireAppointmentDeleteAccess: vi.fn(),
  requireAppointmentPaymentAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));
const requireRelationshipMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...a: unknown[]) => requireRelationshipMock(...a),
}));

const actions = await import("../actions");
const rosterActions = await import("../groupClassSeriesRosterActions");

const STUDIO = "studio-1";
const APPT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const REQ = "22222222-2222-4222-8222-222222222222";
const INSTRUCTOR = "44444444-4444-4444-8444-444444444444";

const run = (p: Promise<unknown>) => p.catch((e) => e);
const redirectUrl = (e: unknown) => ((e as { digest?: string })?.digest ?? "").split(";")[2] ?? "";
const formOf = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.snapshotFollowing.mockResolvedValue(null);
  m.snapshotByIds.mockResolvedValue(null);
  m.noticeLine.mockResolvedValue(null);
  requireEditAccessMock.mockReset();
  requireRelationshipMock.mockReset();
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S1E-2 trigger: single enrollment and removal", () => {
  function supabaseFor(rpc: Record<string, { data?: unknown; error?: { message: string } | null }>) {
    return {
      rpc: (name: string) => Promise.resolve(rpc[name] ?? { data: null, error: null }),
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    };
  }
  const asOwner = (supabase: unknown) => requireEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO, user: { id: "u1" }, studioRole: "studio_owner", isPlatformAdmin: false });

  it("a successful enrollment confirms to that dancer with the new attendee row as the event", async () => {
    asOwner(supabaseFor({ enroll_class_attendee: { data: "att-1", error: null } }));
    const err = await run(actions.enrollClassAttendeeAction(formOf({ appointmentId: APPT, clientId: CLIENT, billingType: "pay_as_you_go" })));
    expect(redirectUrl(err)).toContain("success=student_enrolled");
    expect(m.enrolled).toHaveBeenCalledTimes(1);
    expect(m.enrolled).toHaveBeenCalledWith({ studioId: STUDIO, clientId: CLIENT, appointmentIds: [APPT], eventId: "att-1", series: false });
  });

  it("a refused enrollment (duplicate, full, unauthorized, anything) notifies nobody", async () => {
    for (const message of ["This client is already enrolled in this class.", "This class has no available seats remaining.", "Not authorized to enroll a student into this class.", "boom"]) {
      asOwner(supabaseFor({ enroll_class_attendee: { error: { message } } }));
      await run(actions.enrollClassAttendeeAction(formOf({ appointmentId: APPT, clientId: CLIENT, billingType: "pay_as_you_go" })));
    }
    expect(m.enrolled).not.toHaveBeenCalled();
  });

  it("an enrollment that returns no attendee id cannot be tied to an event, so nothing is sent", async () => {
    asOwner(supabaseFor({ enroll_class_attendee: { data: null, error: null } }));
    await run(actions.enrollClassAttendeeAction(formOf({ appointmentId: APPT, clientId: CLIENT, billingType: "pay_as_you_go" })));
    expect(m.enrolled).not.toHaveBeenCalled();
  });

  it("a successful removal tells that dancer; the notice reads the cancelled row itself (nothing from the form decides who)", async () => {
    asOwner(supabaseFor({ cancel_class_attendee: { data: null, error: null } }));
    await run(actions.cancelClassAttendeeAction(formOf({ appointmentId: APPT, attendeeId: "att-9", clientId: "evil-client", returnTo: `/app/schedule/${APPT}` })));
    expect(m.removedByAttendee).toHaveBeenCalledTimes(1);
    expect(m.removedByAttendee).toHaveBeenCalledWith({ studioId: STUDIO, attendeeId: "att-9" });
  });

  it("a refused removal (recorded attendance, not authorized, anything) notifies nobody", async () => {
    for (const message of ["GCSD1_ATTENDEE_ATTENDANCE_RECORDED: x", "Not authorized to manage this class's roster.", "boom"]) {
      asOwner(supabaseFor({ cancel_class_attendee: { error: { message } } }));
      await run(actions.cancelClassAttendeeAction(formOf({ appointmentId: APPT, attendeeId: "att-9", returnTo: `/app/schedule/${APPT}` })));
    }
    expect(m.removedByAttendee).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S1E-2 trigger: This and following enrollment and removal", () => {
  const classesRaw = (...states: string[]) =>
    states.map((state, i) => ({
      appointment_id: `00000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, "0")}`,
      occurrence_index: i + 1,
      starts_at: `2030-05-${String(i + 1).padStart(2, "0")}T22:00:00Z`,
      state,
    }));
  const raw = (kind: "enroll" | "remove", outcome: string, states: string[], applied = 0) => ({
    mode: "apply",
    outcome,
    series_id: "series-1",
    anchor_index: 1,
    client_id: CLIENT,
    [kind === "enroll" ? "enrolled_count" : "removed_count"]: applied,
    counts: {},
    classes: classesRaw(...states),
  });
  const idOf = (i: number) => `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`;
  function asStaff(rpc: Record<string, unknown>, role = "studio_owner") {
    const supabase = { rpc: (name: string) => Promise.resolve({ data: rpc[name] ?? null, error: null }) };
    requireEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO, user: { id: "u1" }, studioRole: role, isPlatformAdmin: false });
  }
  const enroll = { kind: "enroll" as const, appointmentId: APPT, clientId: CLIENT, billingType: "free_comped" };
  const remove = { kind: "remove" as const, appointmentId: APPT, clientId: CLIENT };

  it("series enrollment: one consolidated notice naming exactly the classes that were enrolled", async () => {
    asStaff({ enroll_group_class_series_from: raw("enroll", "enrolled", ["will_enroll", "already_enrolled", "will_enroll", "skipped_cancelled"], 2) });
    const out = await rosterActions.applySeriesRosterAction(enroll, 2);
    expect(out.status).toBe("ok");
    expect(m.enrolled).toHaveBeenCalledTimes(1);
    const arg = m.enrolled.mock.calls[0][0];
    expect(arg).toMatchObject({ studioId: STUDIO, clientId: CLIENT, series: true });
    expect(arg.appointmentIds).toEqual([idOf(1), idOf(3)]);
    expect(typeof arg.eventId).toBe("string");
  });

  it("series removal: one consolidated notice naming the removed classes and counting those kept for recorded attendance", async () => {
    asStaff({ remove_group_class_series_from: raw("remove", "removed", ["will_remove", "skipped_terminal", "will_remove", "not_enrolled"], 2) });
    await rosterActions.applySeriesRosterAction(remove, 2);
    expect(m.removed).toHaveBeenCalledTimes(1);
    const arg = m.removed.mock.calls[0][0];
    expect(arg.appointmentIds).toEqual([idOf(1), idOf(3)]);
    expect(arg.keptCount).toBe(1);
    expect(arg).toMatchObject({ studioId: STUDIO, clientId: CLIENT, series: true });
  });

  it("an atomic refusal, a stale preview, a no-op and a preview notify nobody", async () => {
    for (const [kind, outcome] of [["enroll", "blocked"], ["enroll", "changed"], ["enroll", "noop"], ["enroll", "no_eligible_targets"]] as const) {
      asStaff({ enroll_group_class_series_from: raw(kind, outcome, ["blocked_capacity", "will_enroll"]) });
      await rosterActions.applySeriesRosterAction(enroll, 1);
    }
    for (const outcome of ["changed", "noop"]) {
      asStaff({ remove_group_class_series_from: raw("remove", outcome, ["not_enrolled"]) });
      await rosterActions.applySeriesRosterAction(remove, 0);
    }
    asStaff({ preview_group_class_series_enrollment: { ...raw("enroll", "ready", ["will_enroll"]), mode: "preview" } });
    await rosterActions.previewSeriesRosterAction(enroll);
    expect(m.enrolled).not.toHaveBeenCalled();
    expect(m.removed).not.toHaveBeenCalled();
  });

  it("an instructor never reaches the RPC or a notice", async () => {
    asStaff({ enroll_group_class_series_from: raw("enroll", "enrolled", ["will_enroll"], 1) }, "instructor");
    const out = await rosterActions.applySeriesRosterAction(enroll, 1);
    expect(out.status).toBe("error");
    expect(m.enrolled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S1E-2 trigger: single class edit", () => {
  const CURRENT = {
    id: APPT,
    studio_id: STUDIO,
    client_id: null,
    instructor_id: INSTRUCTOR,
    room_id: "room-1",
    starts_at: "2030-11-02T22:00:00.000Z",
    ends_at: "2030-11-02T23:00:00.000Z",
    appointment_type: "group_class",
    roster_capacity: 10,
    location_name: "Front studio",
  };

  function arrange(updateError = false) {
    const writes: Array<Record<string, unknown>> = [];
    const supabase = {
      from(table: string) {
        let result: unknown = { data: null, error: null };
        const chain: Record<string, unknown> = {};
        chain.select = (_c?: string, opts?: { head?: boolean }) => {
          if (table === "appointment_attendees" && opts?.head) result = { count: 0, error: null };
          else if (table === "rooms") result = { data: { id: "room-2" }, error: null };
          return chain;
        };
        chain.eq = () => chain;
        chain.order = () => chain;
        chain.limit = () => chain;
        chain.single = () => Promise.resolve(result);
        chain.maybeSingle = () => Promise.resolve(result);
        chain.update = (payload: Record<string, unknown>) => {
          if (table === "appointments") writes.push(payload);
          result = { error: updateError ? { message: "boom" } : null };
          return chain;
        };
        chain.then = (resolve: (v: unknown) => void) => resolve(result);
        return chain;
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    };
    requireEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO, user: { id: "u1" }, studioRole: "studio_owner", isPlatformAdmin: false });
    requireRelationshipMock.mockResolvedValue({ ok: true, scope: "studio", appointment: CURRENT });
    return writes;
  }

  const editForm = (fields: Record<string, string>) =>
    formOf({
      appointmentId: APPT,
      appointmentType: "group_class",
      title: "Salsa",
      instructorId: INSTRUCTOR,
      roomId: "room-1",
      locationName: "Front studio",
      startsAt: "2030-11-02T18:00",
      endsAt: "2030-11-02T19:00",
      ...fields,
    });

  it("after a successful save the orchestrator gets the before and after material values and this edit as the event", async () => {
    const writes = arrange();
    const err = await run(actions.updateAppointmentAction({}, editForm({ startsAt: "2030-11-03T18:00", endsAt: "2030-11-03T19:00", roomId: "room-2", locationName: "Back lot" })));
    expect(redirectUrl(err)).toBe(`/app/schedule/${APPT}`);
    expect(m.changed).toHaveBeenCalledTimes(1);
    const arg = m.changed.mock.calls[0][0];
    expect(arg.studioId).toBe(STUDIO);
    expect(arg.appointmentId).toBe(APPT);
    expect(arg.before).toEqual({ startsAt: CURRENT.starts_at, endsAt: CURRENT.ends_at, instructorId: INSTRUCTOR, roomId: "room-1", locationName: "Front studio" });
    expect(arg.after).toMatchObject({ instructorId: INSTRUCTOR, roomId: "room-2", locationName: "Back lot" });
    expect(arg.after.startsAt).not.toBe(CURRENT.starts_at);
    expect(arg.eventId).toBe(writes[0].updated_at); // the saved row's own timestamp identifies this edit
  });

  it("a notes-only or capacity-only save still calls the orchestrator with identical before/after, which sends nothing (it decides)", async () => {
    arrange();
    await run(actions.updateAppointmentAction({}, editForm({ notes: "bring shoes", rosterCapacity: "12" })));
    const arg = m.changed.mock.calls[0][0];
    const { diffClassMaterial } = await import("@/lib/notifications/groupClassNotices");
    expect(diffClassMaterial(arg.before, arg.after).any).toBe(false);
  });

  it("a failed save notifies nobody", async () => {
    arrange(true);
    const out = await run(actions.updateAppointmentAction({}, editForm({ startsAt: "2030-11-03T18:00", endsAt: "2030-11-03T19:00" })));
    expect((out as { error?: string }).error).toBeTruthy();
    expect(m.changed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S1E-2 trigger: This and following edit", () => {
  const ANCHOR = {
    id: APPT,
    appointment_type: "group_class",
    group_class_series_id: "series-1",
    series_overridden_fields: [],
  };
  const SERIES = { title: "Salsa", default_instructor_id: INSTRUCTOR, default_room_id: null, default_location_name: null, default_roster_capacity: 10, local_start_time: "18:30:00", duration_minutes: 60 };
  const PREVIEW = {
    series_id: "series-1", anchor_index: 3, will_split: true, class_count: 4, editable_count: 4, changed_count: 4, cancelled_count: 0, historical_count: 0,
    terminal_attendance_count: 0, customized_count: 0, customized_fields: {}, overwrite: false, conflict_count: 0, first_conflict: null, capacity_blocked_count: 0,
  };
  const RESULT = { series_id: "series-2", predecessor_series_id: "series-1", split_created: true, moved_class_count: 4, edited_class_count: 4, preserved_customized_count: 0, overwritten_customized_count: 0, replay: false };

  function arrange(over: { editRpc?: { data?: unknown; error?: { message: string } | null } } = {}) {
    const supabase = {
      from(table: string) {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = () => Promise.resolve({ data: table === "appointments" ? ANCHOR : SERIES, error: null });
        return chain;
      },
      rpc: (name: string) => Promise.resolve(name === "preview_group_class_series_edit" ? { data: PREVIEW, error: null } : (over.editRpc ?? { data: RESULT, error: null })),
    };
    requireEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO, user: { id: "u1" }, studioRole: "studio_owner", isPlatformAdmin: false });
  }
  const form = (fields: Record<string, string>) =>
    formOf({ appointmentId: APPT, title: "Salsa", instructorId: INSTRUCTOR, roomId: "", locationName: "", rosterCapacity: "10", startTime: "18:30", durationMinutes: "60", intent: "preview", ...fields });
  const IDLE = { status: "idle" } as const;
  const before = new Map([["c1", { startsAt: "a", endsAt: "b", instructorId: INSTRUCTOR, roomId: null, locationName: null }]]);
  const after = new Map([["c1", { startsAt: "c", endsAt: "d", instructorId: INSTRUCTOR, roomId: null, locationName: null }]]);

  async function apply(fields: Record<string, string>) {
    const reviewed = await actions.submitGroupClassSeriesEditAction(IDLE, form(fields));
    return run(actions.submitGroupClassSeriesEditAction(IDLE, form({ ...fields, intent: "apply", requestId: REQ, reviewedFingerprint: reviewed.fingerprint ?? "" })));
  }

  it("the review adds the unique-dancer notification line for a material change", async () => {
    arrange();
    m.noticeLine.mockResolvedValue("3 enrolled dancers will be notified about these changes.");
    const state = await actions.submitGroupClassSeriesEditAction(IDLE, form({ startTime: "19:00" }));
    expect(state.status).toBe("preview");
    expect(state.lines?.[state.lines.length - 1]).toBe("3 enrolled dancers will be notified about these changes.");
    expect(m.noticeLine).toHaveBeenCalledWith(expect.anything(), STUDIO, APPT, { local_start_time: "19:00" });
  });

  it("no notification line when nobody is enrolled or the change is not material", async () => {
    arrange();
    const state = await actions.submitGroupClassSeriesEditAction(IDLE, form({ title: "Salsa 2" }));
    expect(state.lines?.join(" ")).not.toMatch(/will be notified/);
  });

  it("a material apply snapshots before, applies, snapshots after, and sends one consolidated notice keyed by the request id", async () => {
    arrange();
    m.snapshotFollowing.mockResolvedValue({ seriesId: "series-1", classes: before });
    m.snapshotByIds.mockResolvedValue(after);
    const err = await apply({ startTime: "19:00" });
    expect(redirectUrl(err)).toContain("success=series_edited");
    expect(m.snapshotFollowing).toHaveBeenCalledTimes(1);
    expect(m.snapshotByIds).toHaveBeenCalledWith(expect.anything(), STUDIO, ["c1"]);
    expect(m.seriesChanged).toHaveBeenCalledTimes(1);
    expect(m.seriesChanged).toHaveBeenCalledWith({ studioId: STUDIO, eventId: REQ, seriesId: "series-2", before, after });
  });

  it("a non-material apply (title or capacity) takes no snapshot and sends nothing", async () => {
    arrange();
    await apply({ title: "Salsa 2" });
    await apply({ rosterCapacity: "12" });
    expect(m.snapshotFollowing).not.toHaveBeenCalled();
    expect(m.seriesChanged).not.toHaveBeenCalled();
  });

  it("a replayed apply, a failed apply and an unreadable snapshot all send nothing", async () => {
    arrange({ editRpc: { data: { ...RESULT, replay: true } } });
    m.snapshotFollowing.mockResolvedValue({ seriesId: "series-1", classes: before });
    m.snapshotByIds.mockResolvedValue(after);
    await apply({ startTime: "19:00" });
    arrange({ editRpc: { error: { message: "GCSC5_CONFLICT: reason=instructor index=2" } } });
    await apply({ startTime: "19:00" });
    arrange();
    m.snapshotFollowing.mockResolvedValue(null);
    await apply({ startTime: "19:00" });
    arrange();
    m.snapshotFollowing.mockResolvedValue({ seriesId: "series-1", classes: before });
    m.snapshotByIds.mockResolvedValue(null);
    await apply({ startTime: "19:00" });
    expect(m.seriesChanged).not.toHaveBeenCalled();
  });
});
