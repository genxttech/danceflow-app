import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GC-S1D-1: roster management for ONE group-class occurrence (application layer). The authoritative rules (duplicate
 * prevention, capacity, cancelled-class refusal, funding eligibility, ownership, authority) stay in enroll_class_attendee /
 * cancel_class_attendee and their triggers; here we prove the roster read model and wording, the in-context add / remove
 * actions (RPC routing, fixed-copy outcomes, safe return paths), the recorded-attendance guard on Remove, the lean
 * discovery helpers, and that no series scope is offered.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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
vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: vi.fn().mockResolvedValue(undefined),
  sendGroupClassCancellationPush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/groupClassSeriesCancellation", () => ({ notifySeriesCancellation: vi.fn() }));

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

const panel = await import("@/lib/schedule/groupClassRosterPanel");
const { enrollClassAttendeeAction, cancelClassAttendeeAction } = await import("../actions");
const rosterActions = await import("../groupClassRosterActions");
const { default: GroupClassRosterPanel } = await import("@/components/schedule/GroupClassRosterPanel");
const { default: AddDancerPanel } = await import("@/components/schedule/AddDancerPanel");
const { default: EnrollStudentForm } = await import("../enroll-student/EnrollStudentForm");

const APPT = "11111111-1111-4111-8111-111111111111";
const OTHER_APPT = "22222222-2222-4222-8222-222222222222";
const STUDIO = "studio-1";

// ---------------------------------------------------------------------------------------------------------------------
// Pure read model
// ---------------------------------------------------------------------------------------------------------------------
describe("S1D-1 capacity, funding and attendance wording", () => {
  it("capacity states: open (singular and plural), full, over, unlimited", () => {
    expect(panel.rosterCapacitySummary(8, 10)).toMatchObject({ headline: "Roster 8 / 10", detail: "2 seats left", state: "open", seatsLeft: 2 });
    expect(panel.rosterCapacitySummary(9, 10).detail).toBe("1 seat left");
    expect(panel.rosterCapacitySummary(10, 10)).toMatchObject({ detail: "Class is full", state: "full", seatsLeft: 0 });
    expect(panel.rosterCapacitySummary(12, 10)).toMatchObject({ detail: "Over capacity by 2", state: "over" });
    expect(panel.rosterCapacitySummary(3, null)).toMatchObject({ headline: "Roster 3", detail: "No capacity limit", state: "unlimited", seatsLeft: null });
    expect(panel.rosterCapacitySummary(0, 5).detail).toBe("5 seats left");
  });

  it("funding labels are concise and never expose ids", () => {
    const base = { paymentStatus: null, packageName: null, membershipName: null };
    expect(panel.rosterFundingLabel({ ...base, billingType: "package_credit", packageName: "10-class pack" })).toBe("Package credit · 10-class pack");
    expect(panel.rosterFundingLabel({ ...base, billingType: "package_credit" })).toBe("Package credit");
    expect(panel.rosterFundingLabel({ ...base, billingType: "membership", membershipName: "Unlimited" })).toBe("Membership · Unlimited");
    expect(panel.rosterFundingLabel({ ...base, billingType: "pay_as_you_go", paymentStatus: "paid" })).toBe("Pay as you go · Paid");
    expect(panel.rosterFundingLabel({ ...base, billingType: "pay_as_you_go", paymentStatus: "unpaid" })).toBe("Pay as you go · Unpaid");
    expect(panel.rosterFundingLabel({ ...base, billingType: "free_comped" })).toBe("Comped");
    expect(panel.rosterFundingLabel({ ...base, billingType: null })).toBeNull();
  });

  it("attendance labels and the terminal states", () => {
    expect(panel.rosterAttendanceLabel("checked_in")).toBe("Checked in");
    expect(panel.rosterAttendanceLabel("no_show")).toBe("No-show");
    expect(panel.rosterAttendanceLabel(null)).toBeNull();
    expect(panel.isTerminalAttendance("attended")).toBe(true);
    expect(panel.isTerminalAttendance("no_show")).toBe(true);
    expect(panel.isTerminalAttendance("checked_in")).toBe(false);
    expect(panel.isTerminalAttendance(null)).toBe(false);
  });
});

const ATTENDEES = [
  { id: "a1", client_id: "c1", status: "booked", billing_type: "package_credit", payment_status: null, clients: { first_name: "Zed", last_name: "Zane" }, client_packages: { name_snapshot: "Pack" }, client_memberships: null },
  { id: "a2", client_id: "c2", status: "booked", billing_type: "membership", payment_status: null, clients: [{ first_name: "Ann", last_name: "Lee" }], client_packages: null, client_memberships: [{ name_snapshot: "Gold" }] },
  { id: "a3", client_id: "c3", status: "booked", billing_type: "pay_as_you_go", payment_status: "unpaid", clients: { first_name: "Bo", last_name: "Kim" }, client_packages: null, client_memberships: null },
  { id: "a4", client_id: "c4", status: "cancelled", billing_type: "free_comped", payment_status: null, clients: { first_name: "Cy", last_name: "Ode" }, client_packages: null, client_memberships: null },
];
const ATTENDANCE = [
  { client_id: "c2", status: "attended" },
  { client_id: "c3", status: "checked_in" },
];

describe("S1D-1 roster read model", () => {
  const data = panel.buildRosterPanel({ attendees: ATTENDEES, attendance: ATTENDANCE, capacity: 5, includeFunding: true, canManage: true });

  it("lists enrolled dancers by name, separates removed ones, and counts only enrolled for capacity", () => {
    expect(data.entries.map((e) => e.name)).toEqual(["Ann Lee", "Bo Kim", "Zed Zane"]);
    expect(data.removed.map((e) => [e.name, e.enrollment])).toEqual([["Cy Ode", "removed"]]);
    expect(data.bookedCount).toBe(3);
    expect(data.capacity).toMatchObject({ headline: "Roster 3 / 5", detail: "2 seats left" });
  });

  it("attendance state is read-only context; recorded attendance blocks Remove", () => {
    const byName = Object.fromEntries(data.entries.map((e) => [e.name, e]));
    expect(byName["Ann Lee"]).toMatchObject({ attendanceLabel: "Attended", hasTerminalAttendance: true, canRemove: false });
    expect(byName["Bo Kim"]).toMatchObject({ attendanceLabel: "Checked in", hasTerminalAttendance: false, canRemove: true });
    expect(byName["Zed Zane"]).toMatchObject({ attendanceLabel: null, canRemove: true });
  });

  it("funding is shown to broad staff only; the instructor view carries no billing detail", () => {
    expect(data.entries.map((e) => e.fundingLabel)).toEqual(["Membership · Gold", "Pay as you go · Unpaid", "Package credit · Pack"]);
    const instructor = panel.buildRosterPanel({ attendees: ATTENDEES, attendance: ATTENDANCE, capacity: 5, includeFunding: false, canManage: true });
    expect(instructor.entries.every((e) => e.fundingLabel === null)).toBe(true);
  });

  it("nobody can be removed when the viewer cannot manage (closed class or no authority); empty roster is valid", () => {
    const closed = panel.buildRosterPanel({ attendees: ATTENDEES, attendance: [], capacity: 5, includeFunding: true, canManage: false });
    expect(closed.entries.every((e) => !e.canRemove)).toBe(true);
    const empty = panel.buildRosterPanel({ attendees: [], attendance: [], capacity: null, includeFunding: true, canManage: true });
    expect(empty.entries).toEqual([]);
    expect(empty.capacity.detail).toBe("No capacity limit");
  });

  it("a class accepts new dancers only while upcoming or in progress and not cancelled / final", () => {
    const now = new Date("2030-01-01T12:00:00Z").getTime();
    expect(panel.rosterAcceptsNewDancers({ status: "scheduled", endsAtIso: "2030-01-01T13:00:00Z", nowMs: now })).toBe(true);
    expect(panel.rosterAcceptsNewDancers({ status: "scheduled", endsAtIso: "2030-01-01T11:00:00Z", nowMs: now })).toBe(false);
    for (const status of ["cancelled", "attended", "no_show"]) {
      expect(panel.rosterAcceptsNewDancers({ status, endsAtIso: "2030-01-01T13:00:00Z", nowMs: now })).toBe(false);
    }
  });
});

describe("S1D-1 outcome copy and routing helpers", () => {
  it("banners are fixed copy and kind-matched", () => {
    expect(panel.rosterBanner({ success: "student_enrolled" })).toEqual({ kind: "success", message: "Dancer added to the class." });
    expect(panel.rosterBanner({ success: "attendee_cancelled" })?.message).toBe("Dancer removed from the class.");
    expect(panel.rosterBanner({ error: "already_enrolled" })?.message).toBe("That dancer is already enrolled in this class.");
    expect(panel.rosterBanner({ error: "class_full" })?.message).toContain("This class is full");
    expect(panel.rosterBanner({ error: "attendee_attendance_recorded" })?.message).toContain("Attendance is already recorded");
    expect(panel.rosterBanner({ error: "student_enrolled" })).toBeNull();
    expect(panel.rosterBanner({ success: "class_full" })).toBeNull();
    expect(panel.rosterBanner({ error: "<script>" })).toBeNull();
    expect(panel.rosterBanner({})).toBeNull();
  });

  it("enrollment failures map to stable codes; every earlier code is preserved", () => {
    const m = panel.classifyRosterEnrollError;
    expect(m("A membership-funded group-class enrollment requires a specific membership to be selected.")).toBe("membership_requires_selection");
    expect(m("This membership has no applicable group-class benefit.")).toBe("no_eligible_entitlement");
    expect(m("No allowance remaining in this membership's billing period for a group class.")).toBe("entitlement_exhausted");
    expect(m("This membership does not belong to this client, or is not active.")).toBe("membership_not_active");
    expect(m("This enrollment needs a billing decision -- ask an owner.")).toBe("ambiguous_funding_source");
    expect(m("GCSC3_CLASS_CANCELLED: This class has been cancelled")).toBe("class_cancelled");
    expect(m("This client is already enrolled in this class.")).toBe("already_enrolled");
    expect(m("This class has no available seats remaining.")).toBe("class_full");
    expect(m("Not authorized to enroll a student into this class.")).toBe("enrollment_not_authorized");
    expect(m("deadlock detected; relation secret")).toBe("enrollment_failed");
  });

  it("the in-context return path is exactly this class's detail page", () => {
    expect(panel.safeRosterErrorReturn(`/app/schedule/${APPT}`, APPT)).toBe(`/app/schedule/${APPT}`);
    expect(panel.safeRosterErrorReturn(`/app/schedule/${OTHER_APPT}`, APPT)).toBeNull();
    expect(panel.safeRosterErrorReturn("https://evil.example/x", APPT)).toBeNull();
    expect(panel.safeRosterErrorReturn(`/app/schedule/${APPT}?x=1`, APPT)).toBeNull();
    expect(panel.safeRosterErrorReturn("", APPT)).toBeNull();
    expect(panel.safeRosterErrorReturn(`/app/schedule/not-a-uuid`, "not-a-uuid")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------------------------------------------------
function rosterFor(params: { canManage?: boolean; capacity?: number | null; attendees?: typeof ATTENDEES; attendance?: typeof ATTENDANCE; funding?: boolean } = {}) {
  return panel.buildRosterPanel({
    attendees: params.attendees ?? ATTENDEES,
    attendance: params.attendance ?? ATTENDANCE,
    capacity: params.capacity === undefined ? 5 : params.capacity,
    includeFunding: params.funding ?? true,
    canManage: params.canManage ?? true,
  });
}
const render = (props: Partial<Parameters<typeof GroupClassRosterPanel>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(GroupClassRosterPanel, {
      appointmentId: APPT,
      returnTo: `/app/schedule/${APPT}`,
      roster: rosterFor(),
      canManage: true,
      isBroadStaff: true,
      closedReason: null,
      ...props,
    }),
  );

describe("S1D-1 roster panel rendering", () => {
  it("shows capacity, dancers, funding, attendance state, the attendance link and the add control", () => {
    const html = render();
    expect(html).toContain("Roster 3 / 5");
    expect(html).toContain("2 seats left");
    for (const name of ["Ann Lee", "Bo Kim", "Zed Zane"]) expect(html).toContain(name);
    expect(html).toContain("Membership · Gold");
    expect(html).toContain("Attended");
    expect(html).toContain("Checked in");
    expect(html).toContain("Enrolled");
    expect(html).toContain(`href="/app/schedule/${APPT}/attendance"`);
    expect(html).toContain("Take attendance");
    expect(html).toContain("+ Add dancer");
  });

  it("offers Remove only where allowed, with a lightweight confirmation, and explains recorded attendance", () => {
    const html = render();
    expect(html.match(/>Remove</g)?.length).toBe(2); // Bo and Zed; not the attended dancer
    expect(html).toContain("Remove from class");
    expect(html).toContain("No credit is used or returned");
    expect(html).toContain('name="attendeeId" value="a3"');
    expect(html).not.toContain('name="attendeeId" value="a2"');
    expect(html).toContain("Attendance recorded");
  });

  it("the instructor view has no funding detail and nothing for a viewer who cannot manage", () => {
    const instructor = render({ roster: rosterFor({ funding: false }), isBroadStaff: false });
    expect(instructor).not.toContain("Membership · Gold");
    expect(instructor).not.toContain("Package credit");
    const viewer = render({ canManage: false, roster: rosterFor({ canManage: false }) });
    expect(viewer).not.toContain("+ Add dancer");
    expect(viewer).not.toContain("Remove from class");
  });

  it("empty roster has a useful empty state with the next action", () => {
    const html = render({ roster: rosterFor({ attendees: [], attendance: [] }) });
    expect(html).toContain("No dancers are enrolled yet.");
    expect(html).toContain("Use Add dancer below.");
    expect(html).toContain("Roster 0 / 5");
  });

  it("a full class replaces the add form with the reason and the way forward", () => {
    const full = render({ roster: rosterFor({ capacity: 3 }) });
    expect(full).toContain("Class is full");
    expect(full).toContain("This class is full. Raise Maximum students in Edit class to add more dancers.");
    expect(full).not.toContain("+ Add dancer");
    const forInstructor = render({ roster: rosterFor({ capacity: 3, funding: false }), isBroadStaff: false });
    expect(forInstructor).toContain("Ask front desk to raise Maximum students");
  });

  it("unlimited capacity is stated plainly and the bar is not drawn", () => {
    const html = render({ roster: rosterFor({ capacity: null }) });
    expect(html).toContain("Roster 3");
    expect(html).toContain("No capacity limit");
    expect(html).not.toContain("h-1.5 w-full");
  });

  it("a cancelled or ended class closes the roster to changes and says why", () => {
    const cancelled = render({ closedReason: "cancelled", roster: rosterFor({ canManage: false }) });
    expect(cancelled).toContain("This class is cancelled, so its roster is closed.");
    expect(cancelled).not.toContain("+ Add dancer");
    expect(cancelled).not.toContain("Remove from class");
    const ended = render({ closedReason: "ended", roster: rosterFor({ canManage: false }) });
    expect(ended).toContain("This class has ended, so enrollment is closed.");
    expect(ended).toContain("Take attendance");
  });

  it("removed dancers sit in a collapsed disclosure, not in the active list", () => {
    const html = render();
    expect(html).toContain("Removed (1)");
    expect(html).toContain("Cy Ode");
  });

  it("the add control starts collapsed and reopens after an add-dancer refusal", () => {
    expect(render()).not.toMatch(/<details[^>]*open=""[^>]*>\s*<summary[^>]*>\s*\+ Add dancer/);
    expect(render({ reopenAdd: true })).toMatch(/<details[^>]*open=""[^>]*>\s*<summary[^>]*>\s*\+ Add dancer/);
    expect(panel.isRosterEnrollmentError("already_enrolled")).toBe(true);
    expect(panel.isRosterEnrollmentError("class_full")).toBe(true);
    expect(panel.isRosterEnrollmentError("attendee_cancel_failed")).toBe(false);
    expect(panel.isRosterEnrollmentError(undefined)).toBe(false);
  });

  it("offers no series scope unless the viewer is broad staff on a series class (S1D-2 turns it on explicitly; default off)", () => {
    const html = render();
    expect(html).not.toMatch(/this and following|entire series|following classes|series/i);
  });

  it("the add control is enrollment only: no payment, attendance or credit actions", () => {
    const html = renderToStaticMarkup(createElement(AddDancerPanel, { appointmentId: APPT, returnTo: `/app/schedule/${APPT}`, isBroadStaff: true, full: false }));
    expect(html).toContain('name="errorReturnTo"');
    expect(html).toContain(`value="/app/schedule/${APPT}"`);
    expect(html).toContain(`href="/app/schedule/enroll-student?appointmentId=${APPT}"`);
    expect(html).toContain("Add to class");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add to class/); // nothing chosen yet
    expect(html).not.toMatch(/mark attended|record payment|take payment|refund/i);
    const instructor = renderToStaticMarkup(createElement(AddDancerPanel, { appointmentId: APPT, returnTo: `/app/schedule/${APPT}`, isBroadStaff: false, full: false }));
    expect(instructor).not.toContain('name="billingType"');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Actions (add / remove)
// ---------------------------------------------------------------------------------------------------------------------
type Tables = Record<string, { data?: unknown; error?: unknown }>;
function fakeSupabase(opts: { rpc?: Record<string, { data?: unknown; error?: { message: string } | null }>; tables?: Tables } = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve(opts.rpc?.[name] ?? { data: null, error: null });
    },
    from(table: string) {
      const result = opts.tables?.[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "or", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve(Array.isArray(result.data) ? { data: result.data[0] ?? null, error: null } : result);
      chain.then = (resolve: (v: unknown) => void) => resolve(Array.isArray(result.data) ? result : { data: result.data ?? [], error: result.error ?? null });
      return chain;
    },
  };
  return { supabase, rpcCalls };
}
const ctx = (supabase: unknown, studioRole = "studio_owner", isPlatformAdmin = false) => ({ supabase, studioId: STUDIO, user: { id: "u1" }, studioRole, isPlatformAdmin });
const formOf = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const run = (p: Promise<unknown>) => p.catch((e) => e);
const urlOf = (e: unknown) => ((e as { digest?: string })?.digest ?? "").split(";")[2] ?? "";

beforeEach(() => requireEditAccessMock.mockReset());

describe("S1D-1 Enroll Student fallback page", () => {
  const classes = [
    { id: "class-a", title: "Salsa A", startsAt: "2030-01-01T18:00:00Z", endsAt: "2030-01-01T19:00:00Z", instructorName: null },
    { id: "class-b", title: "Salsa B", startsAt: "2030-01-08T18:00:00Z", endsAt: "2030-01-08T19:00:00Z", instructorName: null },
  ];
  const props = { classes, clients: [], clientPackagesByClientId: {}, clientMembershipsByClientId: {}, eligibleFundingSourcesByClientId: {}, instructorSearchMode: false, isBroadStaff: true };

  it("opens with the requested class preselected, and falls back to the first class otherwise", () => {
    expect(renderToStaticMarkup(createElement(EnrollStudentForm, { ...props, initialAppointmentId: "class-b" }))).toMatch(/<option value="class-b" selected/);
    expect(renderToStaticMarkup(createElement(EnrollStudentForm, props))).toMatch(/<option value="class-a" selected/);
    expect(renderToStaticMarkup(createElement(EnrollStudentForm, { ...props, initialAppointmentId: "unknown" }))).toMatch(/<option value="class-a" selected/);
  });
});

describe("S1D-1 add dancer action (this class)", () => {
  const base = { appointmentId: APPT, clientId: "c9", returnTo: `/app/schedule/${APPT}`, errorReturnTo: `/app/schedule/${APPT}`, billingType: "pay_as_you_go" };

  it("enrolls through enroll_class_attendee and returns to the class with a success code", async () => {
    const { supabase, rpcCalls } = fakeSupabase({ rpc: { enroll_class_attendee: { data: "att-1", error: null } } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const url = urlOf(await run(enrollClassAttendeeAction(formOf(base))));
    expect(rpcCalls).toEqual([
      { name: "enroll_class_attendee", args: { p_appointment_id: APPT, p_client_id: "c9", p_billing_type: "pay_as_you_go", p_client_package_id: null, p_client_membership_id: null } },
    ]);
    expect(url).toBe(`/app/schedule/${APPT}?success=student_enrolled`);
  });

  it("a membership enrollment reports the membership success code", async () => {
    const { supabase } = fakeSupabase({ rpc: { enroll_class_attendee: { data: "att-1", error: null } } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const url = urlOf(await run(enrollClassAttendeeAction(formOf({ ...base, billingType: "membership", clientMembershipId: "m1" }))));
    expect(url).toContain("success=student_enrolled_membership");
  });

  it("refusals stay in the class page with a stable code (duplicate, full, cancelled, authority, funding, unknown)", async () => {
    const cases: Array<[string, string]> = [
      ["This client is already enrolled in this class.", "already_enrolled"],
      ["This class has no available seats remaining.", "class_full"],
      ["GCSC3_CLASS_CANCELLED: This class has been cancelled", "class_cancelled"],
      ["Not authorized to enroll a student into this class.", "enrollment_not_authorized"],
      ["This enrollment needs a billing decision -- ask an owner.", "ambiguous_funding_source"],
      ["relation \"x\" does not exist (secret)", "enrollment_failed"],
    ];
    for (const [message, code] of cases) {
      const { supabase } = fakeSupabase({ rpc: { enroll_class_attendee: { error: { message } } } });
      requireEditAccessMock.mockResolvedValue(ctx(supabase));
      const url = urlOf(await run(enrollClassAttendeeAction(formOf(base))));
      expect(url).toBe(`/app/schedule/${APPT}?error=${code}`);
      expect(url).not.toMatch(/secret|relation/);
    }
  });

  it("an incomplete membership selection is refused in context before any RPC", async () => {
    const { supabase, rpcCalls } = fakeSupabase();
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const url = urlOf(await run(enrollClassAttendeeAction(formOf({ ...base, billingType: "membership" }))));
    expect(url).toBe(`/app/schedule/${APPT}?error=membership_requires_selection`);
    expect(rpcCalls).toHaveLength(0);
  });

  it("without an in-context return (or with an unsafe one) the existing Enroll Student behavior is unchanged", async () => {
    for (const errorReturnTo of [undefined, `/app/schedule/${OTHER_APPT}`, "https://evil.example/x", "/app/anything"]) {
      const { supabase } = fakeSupabase({ rpc: { enroll_class_attendee: { error: { message: "This client is already enrolled in this class." } } } });
      requireEditAccessMock.mockResolvedValue(ctx(supabase));
      const fields: Record<string, string> = { ...base };
      if (errorReturnTo === undefined) delete fields.errorReturnTo;
      else fields.errorReturnTo = errorReturnTo;
      const url = urlOf(await run(enrollClassAttendeeAction(formOf(fields))));
      expect(url).toContain("/app/schedule/enroll-student");
      expect(url).toContain("error=already_enrolled");
      expect(url).toContain(`appointmentId=${APPT}`);
    }
  });

  it("the assigned instructor's own-class enrollment sends no billing choice (the database resolves it)", async () => {
    const { supabase, rpcCalls } = fakeSupabase({ rpc: { enroll_class_attendee: { data: "att-1", error: null } } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase, "instructor"));
    await run(enrollClassAttendeeAction(formOf({ appointmentId: APPT, clientId: "c9", returnTo: `/app/schedule/${APPT}`, errorReturnTo: `/app/schedule/${APPT}` })));
    expect(rpcCalls[0].args).toEqual({ p_appointment_id: APPT, p_client_id: "c9", p_billing_type: null, p_client_package_id: null, p_client_membership_id: null });
  });
});

describe("S1D-1 remove dancer action (this class)", () => {
  const fields = { appointmentId: APPT, attendeeId: "att-7", returnTo: `/app/schedule/${APPT}` };
  const attendeeRow = { id: "att-7", appointment_id: APPT, client_id: "c7" };

  it("removes through cancel_class_attendee and returns with a success code", async () => {
    const { supabase, rpcCalls } = fakeSupabase({ rpc: { cancel_class_attendee: { data: null, error: null } }, tables: { appointment_attendees: { data: [attendeeRow] }, attendance_records: { data: [] } } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const url = urlOf(await run(cancelClassAttendeeAction(formOf(fields))));
    expect(rpcCalls).toEqual([{ name: "cancel_class_attendee", args: { p_attendee_id: "att-7" } }]);
    expect(url).toBe(`/app/schedule/${APPT}?success=attendee_cancelled`);
  });

  it("the database refusal for recorded terminal attendance maps to the existing explanation (the rule lives in the database)", async () => {
    const message =
      "GCSD1_ATTENDEE_ATTENDANCE_RECORDED: This dancer already has attendance recorded for this class. Correct the attendance record before removing them from the class.";
    const { supabase, rpcCalls } = fakeSupabase({ rpc: { cancel_class_attendee: { error: { message } } } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const url = urlOf(await run(cancelClassAttendeeAction(formOf(fields))));
    expect(rpcCalls).toEqual([{ name: "cancel_class_attendee", args: { p_attendee_id: "att-7" } }]);
    expect(url).toBe(`/app/schedule/${APPT}?error=attendee_attendance_recorded`);
    expect(url).not.toContain("GCSD1");
    expect(panel.rosterBanner({ error: "attendee_attendance_recorded" })?.message).toContain("Attendance is already recorded");
  });

  it("the action performs no attendance rule of its own: it calls only the removal RPC", async () => {
    const reads: string[] = [];
    const { supabase } = fakeSupabase({ rpc: { cancel_class_attendee: { data: null, error: null } } });
    const spied = { ...supabase, from: (table: string) => (reads.push(table), supabase.from(table)) };
    requireEditAccessMock.mockResolvedValue(ctx(spied));
    await run(cancelClassAttendeeAction(formOf(fields)));
    expect(reads).toEqual([]);
  });

  it("authority and unexpected refusals map to fixed codes with no raw text", async () => {
    const cases: Array<[string, string]> = [
      ["Not authorized to manage this class's roster.", "attendee_not_authorized"],
      ["Enrollment not found.", "attendee_cancel_failed"],
      ["relation \"x\" secret detail", "attendee_cancel_failed"],
    ];
    for (const [message, code] of cases) {
      const { supabase } = fakeSupabase({ rpc: { cancel_class_attendee: { error: { message } } }, tables: { appointment_attendees: { data: [attendeeRow] }, attendance_records: { data: [] } } });
      requireEditAccessMock.mockResolvedValue(ctx(supabase));
      const url = urlOf(await run(cancelClassAttendeeAction(formOf(fields))));
      expect(url).toBe(`/app/schedule/${APPT}?error=${code}`);
      expect(url).not.toMatch(/secret|relation/);
    }
  });

  it("a missing attendee id is refused before any RPC", async () => {
    const { supabase, rpcCalls } = fakeSupabase();
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const url = urlOf(await run(cancelClassAttendeeAction(formOf({ appointmentId: APPT, returnTo: `/app/schedule/${APPT}` }))));
    expect(url).toContain("error=missing_attendee");
    expect(rpcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------------------------------------------------
describe("S1D-1 add-dancer discovery helpers", () => {
  const classRow = { data: [{ id: APPT, appointment_type: "group_class" }] };

  it("broad staff search studio clients (short text and non-classes return nothing) and flag enrolled dancers", async () => {
    const { supabase, rpcCalls } = fakeSupabase({
      tables: {
        appointments: classRow,
        clients: { data: [{ id: "c1", first_name: "Ann", last_name: "Lee" }, { id: "c2", first_name: "Bo", last_name: "Kim" }] },
        appointment_attendees: { data: [{ client_id: "c2" }] },
      },
    });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    expect(await rosterActions.searchRosterClientsAction(APPT, "a")).toEqual([]);
    expect(await rosterActions.searchRosterClientsAction("not-a-uuid", "ann")).toEqual([]);
    const result = await rosterActions.searchRosterClientsAction(APPT, "an");
    expect(result).toEqual([
      { id: "c1", name: "Ann Lee", alreadyEnrolled: false },
      { id: "c2", name: "Bo Kim", alreadyEnrolled: true },
    ]);
    expect(rpcCalls).toHaveLength(0);
  });

  it("a class that is not a group class of this studio yields nothing", async () => {
    const { supabase } = fakeSupabase({ tables: { appointments: { data: [{ id: APPT, appointment_type: "private_lesson" }] }, clients: { data: [{ id: "c1", first_name: "A", last_name: "B" }] } } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    expect(await rosterActions.searchRosterClientsAction(APPT, "ann")).toEqual([]);
  });

  it("the assigned instructor uses the existing minimal booking-discovery RPC, for their own class only", async () => {
    const own = fakeSupabase({
      rpc: { search_bookable_clients_for_instructor: { data: [{ id: "c1", first_name: "Ann", last_name: "Lee" }], error: null } },
      tables: { appointments: { data: [{ id: APPT, appointment_type: "group_class", instructor_id: "i1" }] }, instructors: { data: [{ id: "i1" }] }, appointment_attendees: { data: [] } },
    });
    requireEditAccessMock.mockResolvedValue(ctx(own.supabase, "instructor"));
    const result = await rosterActions.searchRosterClientsAction(APPT, "ann");
    expect(own.rpcCalls[0].name).toBe("search_bookable_clients_for_instructor");
    expect(result).toEqual([{ id: "c1", name: "Ann Lee", alreadyEnrolled: false }]);

    // another instructor's class: nothing is discovered and nothing is revealed about its roster
    const other = fakeSupabase({
      rpc: { search_bookable_clients_for_instructor: { data: [{ id: "c1", first_name: "Ann", last_name: "Lee" }], error: null } },
      tables: { appointments: { data: [{ id: APPT, appointment_type: "group_class", instructor_id: "i2" }] }, instructors: { data: [{ id: "i1" }] }, appointment_attendees: { data: [{ client_id: "c1" }] } },
    });
    requireEditAccessMock.mockResolvedValue(ctx(other.supabase, "instructor"));
    expect(await rosterActions.searchRosterClientsAction(APPT, "ann")).toEqual([]);
    expect(other.rpcCalls).toHaveLength(0);

    // an instructor login with no instructor row gets nothing
    const unlinked = fakeSupabase({ tables: { appointments: { data: [{ id: APPT, appointment_type: "group_class", instructor_id: "i1" }] }, instructors: { data: [] } } });
    requireEditAccessMock.mockResolvedValue(ctx(unlinked.supabase, "instructor"));
    expect(await rosterActions.searchRosterClientsAction(APPT, "ann")).toEqual([]);
  });

  it("funding options: instructor is automatic; broad staff get the canonical eligible set plus manual choices", async () => {
    const instructor = fakeSupabase({ tables: { appointments: classRow } });
    requireEditAccessMock.mockResolvedValue(ctx(instructor.supabase, "instructor"));
    expect(await rosterActions.getRosterFundingOptionsAction(APPT, "11111111-1111-4111-8111-aaaaaaaaaaaa")).toEqual({ mode: "auto" });
    expect(instructor.rpcCalls).toHaveLength(0);

    const broad = fakeSupabase({
      rpc: {
        get_eligible_group_class_funding_candidates: {
          data: [
            { funding_type: "package", source_id: "p1", label: "10-pack", is_unlimited: false, quantity_total: 10, used: 4, remaining: 6 },
            { funding_type: "membership", source_id: "m1", label: "Gold", is_unlimited: true, quantity_total: null, used: null, remaining: null },
          ],
          error: null,
        },
      },
      tables: {
        appointments: classRow,
        client_packages: { data: [
          { id: "p1", name_snapshot: "10-pack", client_package_items: [{ usage_type: "group_class", quantity_remaining: 6, is_unlimited: false }] },
          { id: "p2", name_snapshot: "Privates", client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 3, is_unlimited: false }] },
        ] },
        client_memberships: { data: [{ id: "m1", name_snapshot: "Gold" }] },
      },
    });
    requireEditAccessMock.mockResolvedValue(ctx(broad.supabase));
    const options = await rosterActions.getRosterFundingOptionsAction(APPT, "11111111-1111-4111-8111-aaaaaaaaaaaa");
    expect(broad.rpcCalls[0]).toEqual({
      name: "get_eligible_group_class_funding_candidates",
      args: { p_studio_id: STUDIO, p_client_id: "11111111-1111-4111-8111-aaaaaaaaaaaa", p_appointment_id: APPT },
    });
    expect(options).toEqual({
      mode: "choose",
      eligible: [
        { type: "package", id: "p1", label: "10-pack", remainingLabel: "6 remaining" },
        { type: "membership", id: "m1", label: "Gold", remainingLabel: "Unlimited" },
      ],
      packages: [{ id: "p1", label: "10-pack — 6 remaining" }],
      memberships: [{ id: "m1", label: "Gold" }],
    });
  });
});
