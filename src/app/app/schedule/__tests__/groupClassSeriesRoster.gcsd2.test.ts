import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GC-S1D-2: "This and following classes" roster management (application layer). The authoritative rules (broad-staff
 * authority, lineage-aware targets, atomic refusal on capacity / funding, idempotency, terminal-attendance preservation)
 * live in the four database RPCs; here we prove the result parsing, the fixed-copy wording and the preview summaries, the
 * server actions (RPC routing, broad-staff gate, input hygiene, no raw database text, revalidation), the apply-outcome
 * interpretation the UI uses, and what the roster controls render for broad staff, instructors and non-series classes.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect: vi.fn(),
}));
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePathMock(...a) }));

const requireEditAccessMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: vi.fn(),
  requireAppointmentEditAccess: (...a: unknown[]) => requireEditAccessMock(...a),
  requireAppointmentDeleteAccess: vi.fn(),
  requireAppointmentPaymentAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));

const lib = await import("@/lib/schedule/groupClassSeriesRoster");
const rosterPanelLib = await import("@/lib/schedule/groupClassRosterPanel");
const actions = await import("../groupClassSeriesRosterActions");
const { default: SeriesRosterPreview } = await import("@/components/schedule/SeriesRosterPreview");
const { default: RemoveDancerControl } = await import("@/components/schedule/RemoveDancerControl");
const { default: AddDancerPanel } = await import("@/components/schedule/AddDancerPanel");
const { default: GroupClassRosterPanel } = await import("@/components/schedule/GroupClassRosterPanel");

const APPT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const PACKAGE = "55555555-5555-4555-8555-555555555555";
const TZ = "America/New_York";

type RawClass = { idx: number; state: string };
const rawResult = (kind: "enroll" | "remove", outcome: string, classes: RawClass[], applied = 0, mode = "preview") => ({
  mode,
  outcome,
  series_id: "series-1",
  anchor_index: classes[0]?.idx ?? 1,
  client_id: CLIENT,
  [kind === "enroll" ? "enrolled_count" : "removed_count"]: applied,
  counts: {},
  classes: classes.map((c) => ({
    appointment_id: `00000000-0000-4000-8000-0000000000${String(c.idx).padStart(2, "0")}`,
    occurrence_index: c.idx,
    starts_at: `2026-11-${String(c.idx + 9).padStart(2, "0")}T23:00:00Z`,
    state: c.state,
  })),
});
const parse = (kind: "enroll" | "remove", outcome: string, classes: RawClass[], applied = 0, mode = "preview") => {
  const parsed = lib.parseSeriesRosterResult(rawResult(kind, outcome, classes, applied, mode), kind);
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
};
const states = (...s: string[]): RawClass[] => s.map((state, i) => ({ idx: i + 1, state }));

// ---------------------------------------------------------------------------------------------------------------------
describe("S1D-2 result parsing", () => {
  it("parses an enrollment result and derives the counts from the classes", () => {
    const r = parse("enroll", "ready", states("will_enroll", "will_enroll", "already_enrolled", "skipped_cancelled"));
    expect(r.outcome).toBe("ready");
    expect(r.counts).toEqual({ will_enroll: 2, already_enrolled: 1, skipped_cancelled: 1 });
    expect(r.classes.map((c) => c.occurrenceIndex)).toEqual([1, 2, 3, 4]);
    expect(r.appliedCount).toBe(0);
  });

  it("uses enrolled_count for enrollment and removed_count for removal", () => {
    expect(parse("enroll", "enrolled", states("will_enroll", "will_enroll"), 2, "apply").appliedCount).toBe(2);
    expect(parse("remove", "removed", states("will_remove"), 1, "apply").appliedCount).toBe(1);
    expect(lib.parseSeriesRosterResult(rawResult("enroll", "ready", states("will_enroll")), "remove")).toBeNull();
  });

  it("an unknown class state is treated as blocking, never as success", () => {
    const r = parse("enroll", "blocked", states("will_enroll", "something_new"));
    expect(r.classes[1].state).toBe("blocked_other");
    expect(lib.seriesRosterBlockers(r)).toHaveLength(1);
  });

  it("rejects malformed results", () => {
    const base = rawResult("enroll", "ready", states("will_enroll"));
    for (const bad of [null, "x", 5, { ...base, mode: "other" }, { ...base, outcome: "weird" }, { ...base, anchor_index: -1 }, { ...base, classes: "no" }, { ...base, classes: [null] }, { ...base, enrolled_count: "many" }]) {
      expect(lib.parseSeriesRosterResult(bad, "enroll")).toBeNull();
    }
  });
});

describe("S1D-2 error mapping and copy", () => {
  it("maps the stable database codes and nothing else", () => {
    const m = (message: string) => lib.classifySeriesRosterError({ message });
    expect(m("GCSD2_UNAUTHORIZED: Not authorized to manage the roster of a whole series.")).toBe("not_authorized");
    expect(m("GCSD2_NOT_FOUND: Group class not found.")).toBe("not_found");
    expect(m("GCSD2_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.")).toBe("not_a_series");
    expect(m("GCSD2_CLIENT_NOT_FOUND: Client not found for this studio.")).toBe("client_not_found");
    expect(m("GCSD2_INVALID_FUNDING: Select a specific membership.")).toBe("invalid_funding");
    expect(m('relation "appointment_attendees" secret detail')).toBe("unknown");
    expect(lib.classifySeriesRosterError(null)).toBe("unknown");
  });

  it("every failure message is fixed copy with no database text", () => {
    for (const failure of ["not_authorized", "not_found", "not_a_series", "client_not_found", "invalid_funding", "unknown"] as const) {
      const text = lib.seriesRosterFailureMessage(failure);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/GCSD|relation|sql|postgres|exception/i);
    }
    expect(lib.seriesRosterFailureMessage("not_authorized")).toContain("single class");
  });
});

describe("S1D-2 preview summaries", () => {
  it("enrollment ready: counts the classes, the already enrolled and the skipped, and can apply", () => {
    const r = parse("enroll", "ready", states("will_enroll", "will_enroll", "will_enroll", "already_enrolled", "skipped_cancelled", "skipped_ended", "skipped_terminal"));
    const s = lib.seriesRosterSummary(r, "enroll", "Ann Lee");
    expect(s.tone).toBe("ready");
    expect(s.canApply).toBe(true);
    expect(s.headline).toBe("Enroll Ann Lee in 3 classes");
    const text = s.details.join(" ");
    expect(text).toContain("3 classes will be added, starting with this one.");
    expect(text).toContain("1 class already enrolled and left as they are.");
    expect(text).toContain("1 cancelled class and 1 class that has ended will be skipped.");
    expect(text).toContain("1 class where attendance is already recorded will be left alone.");
  });

  it("enrollment blocked: nothing is enrolled, says why, never offers apply, distinguishes blocked from skipped", () => {
    const r = parse("enroll", "blocked", states("will_enroll", "blocked_capacity", "skipped_cancelled", "blocked_membership_allowance"));
    const s = lib.seriesRosterSummary(r, "enroll", "Ann Lee");
    expect(s.tone).toBe("blocked");
    expect(s.canApply).toBe(false);
    const text = [s.headline, ...s.details].join(" ");
    expect(text).toContain("2 classes need attention");
    expect(text).toMatch(/nothing will be enrolled/i);
    expect(lib.seriesRosterBlockers(r).map((c) => c.occurrenceIndex)).toEqual([2, 4]);
    expect(lib.seriesRosterSkippedCount(r)).toBe(1);
  });

  it("enrollment no-op, nothing eligible and a stale preview are explained and cannot be applied", () => {
    const noop = lib.seriesRosterSummary(parse("enroll", "noop", states("already_enrolled", "already_enrolled")), "enroll", "Ann Lee");
    expect(noop.headline).toContain("already enrolled in every eligible class");
    expect(noop.canApply).toBe(false);
    const none = lib.seriesRosterSummary(parse("enroll", "no_eligible_targets", states("skipped_cancelled", "skipped_ended")), "enroll", "Ann Lee");
    expect(none.headline).toBe("No following class can take an enrollment.");
    expect(none.canApply).toBe(false);
    const changed = lib.seriesRosterSummary(parse("enroll", "changed", states("will_enroll")), "enroll", "Ann Lee");
    expect(changed.headline).toContain("changed since you reviewed");
    expect(changed.canApply).toBe(false);
  });

  it("removal ready: counts removals, keeps terminal-attendance classes, does not imply credits are restored", () => {
    const r = parse("remove", "ready", states("will_remove", "will_remove", "skipped_terminal", "not_enrolled", "skipped_cancelled"));
    const s = lib.seriesRosterSummary(r, "remove", "Ann Lee");
    expect(s.tone).toBe("ready");
    expect(s.canApply).toBe(true);
    expect(s.headline).toBe("Remove Ann Lee from 2 classes");
    const text = s.details.join(" ");
    expect(text).toContain("No credit is used or returned");
    expect(text).toContain("1 class with recorded attendance will keep Ann Lee enrolled.");
    expect(text).toContain("1 class where Ann Lee is not enrolled will be skipped.");
    expect(text).not.toMatch(/refund|restor|credit (is|will be) (returned|restored)/i);
  });

  it("removal with nothing to remove is a plain no-op, and a blocked removal says nothing changed", () => {
    const noop = lib.seriesRosterSummary(parse("remove", "noop", states("not_enrolled", "skipped_terminal")), "remove", "Ann Lee");
    expect(noop.tone).toBe("info");
    expect(noop.canApply).toBe(false);
    expect(noop.details.join(" ")).toContain("1 class has recorded attendance and stays as is.");
    const blocked = lib.seriesRosterSummary(parse("remove", "blocked", states("will_remove", "blocked_other")), "remove", "Ann Lee");
    expect(blocked.canApply).toBe(false);
    expect(blocked.details.join(" ")).toContain("Nothing was changed");
  });

  it("class labels use the studio time zone and singular/plural wording is correct", () => {
    expect(lib.seriesRosterClassLabel("2026-11-10T23:30:00Z", TZ)).toBe("Tue, Nov 10 · 6:30 PM");
    expect(lib.seriesRosterClassLabel("not a date", TZ)).toBe("Class");
    expect(lib.seriesRosterApplyLabel("enroll", 1)).toBe("Enroll in 1 class");
    expect(lib.seriesRosterApplyLabel("enroll", 4)).toBe("Enroll in 4 classes");
    expect(lib.seriesRosterApplyLabel("remove", 1)).toBe("Remove from 1 class");
    expect(lib.seriesRosterExpectedCount(parse("enroll", "ready", states("will_enroll", "will_enroll")), "enroll")).toBe(2);
    expect(lib.seriesRosterExpectedCount(parse("remove", "ready", states("will_remove")), "remove")).toBe(1);
  });
});

describe("S1D-2 success and apply interpretation", () => {
  it("builds the done URL from numeric counts only and renders fixed banners", () => {
    const r = parse("enroll", "enrolled", states("will_enroll", "will_enroll", "already_enrolled", "skipped_cancelled"), 2, "apply");
    const url = lib.seriesRosterDoneUrl(`/app/schedule/${APPT}`, "enroll", r);
    expect(url).toBe(`/app/schedule/${APPT}?success=series_roster_enrolled&count=2&left=2`);
    expect(lib.seriesRosterBannerMessage("series_roster_enrolled", 2, 2)).toBe("Dancer added to 2 classes. 2 other classes were left as they were.");
    expect(lib.seriesRosterBannerMessage("series_roster_removed", 1, 1)).toBe("Dancer removed from 1 class. 1 other class was left as it was.");
    expect(lib.seriesRosterBannerMessage("series_roster_removed", 3, 0)).toBe("Dancer removed from 3 classes.");
    expect(lib.seriesRosterBannerMessage("series_roster_enrolled", null, null)).toBe("Dancer added to the following classes.");
    expect(lib.seriesRosterBannerMessage("student_enrolled", 1, 1)).toBeNull();
  });

  it("the roster banner delegates series codes with numeric params and ignores junk", () => {
    expect(rosterPanelLib.rosterBanner({ success: "series_roster_enrolled", count: "4", left: "1" })).toEqual({
      kind: "success",
      message: "Dancer added to 4 classes. 1 other class was left as it was.",
    });
    expect(rosterPanelLib.rosterBanner({ success: "series_roster_removed", count: "<b>x</b>", left: "x" })?.message).toBe("Dancer removed from the following classes.");
    expect(rosterPanelLib.rosterBanner({ success: "student_enrolled" })?.message).toBe("Dancer added to the class.");
  });

  it("an applied change lands on the class page; changed / blocked / no-op results are shown, errors use fixed copy", () => {
    const base = `/app/schedule/${APPT}`;
    const done = lib.interpretSeriesApply({ status: "ok", result: parse("enroll", "enrolled", states("will_enroll"), 1, "apply") }, "enroll", base);
    expect(done).toEqual({ type: "done", url: `${base}?success=series_roster_enrolled&count=1&left=0` });
    const removed = lib.interpretSeriesApply({ status: "ok", result: parse("remove", "removed", states("will_remove", "skipped_terminal"), 1, "apply") }, "remove", base);
    expect(removed).toEqual({ type: "done", url: `${base}?success=series_roster_removed&count=1&left=1` });
    for (const outcome of ["changed", "blocked", "noop", "no_eligible_targets"]) {
      const step = lib.interpretSeriesApply({ status: "ok", result: parse("enroll", outcome, states("blocked_capacity"), 0, "apply") }, "enroll", base);
      expect(step.type).toBe("show");
    }
    const wrongKind = lib.interpretSeriesApply({ status: "ok", result: parse("remove", "removed", states("will_remove"), 1, "apply") }, "enroll", base);
    expect(wrongKind.type).toBe("show");
    expect(lib.interpretSeriesApply({ status: "error", message: "Nothing changed" }, "enroll", base)).toEqual({ type: "error", message: "Nothing changed" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------------------------------------------------
function fakeSupabase(rpc: Record<string, { data?: unknown; error?: { message: string } | null }> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve(rpc[name] ?? { data: null, error: null });
    },
  };
  return { supabase, calls };
}
const ctx = (supabase: unknown, studioRole = "studio_owner", isPlatformAdmin = false) => ({ supabase, studioId: "studio-1", user: { id: "u1" }, studioRole, isPlatformAdmin });

beforeEach(() => {
  requireEditAccessMock.mockReset();
  revalidatePathMock.mockReset();
});

describe("S1D-2 server actions", () => {
  const enroll = { kind: "enroll" as const, appointmentId: APPT, clientId: CLIENT, billingType: "free_comped" };

  it("previews an enrollment through the preview RPC with only the occurrence, dancer and funding", async () => {
    const { supabase, calls } = fakeSupabase({ preview_group_class_series_enrollment: { data: rawResult("enroll", "ready", states("will_enroll", "will_enroll")) } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const out = await actions.previewSeriesRosterAction(enroll);
    expect(out.status).toBe("ok");
    expect(calls).toEqual([
      {
        name: "preview_group_class_series_enrollment",
        args: { p_appointment_id: APPT, p_client_id: CLIENT, p_billing_type: "free_comped", p_client_package_id: null, p_client_membership_id: null },
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/studio|series_id|lineage/i);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("applies an enrollment with the previewed count, and revalidates only when the change was made", async () => {
    const { supabase, calls } = fakeSupabase({ enroll_group_class_series_from: { data: rawResult("enroll", "enrolled", states("will_enroll", "will_enroll"), 2, "apply") } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const out = await actions.applySeriesRosterAction({ ...enroll, billingType: "membership", clientMembershipId: MEMBERSHIP }, 2);
    expect(out.status).toBe("ok");
    expect(calls[0]).toEqual({
      name: "enroll_group_class_series_from",
      args: { p_appointment_id: APPT, p_client_id: CLIENT, p_billing_type: "membership", p_client_package_id: null, p_client_membership_id: MEMBERSHIP, p_expected_count: 2 },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/app/schedule");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/app/schedule/${APPT}`);

    revalidatePathMock.mockReset();
    const blocked = fakeSupabase({ enroll_group_class_series_from: { data: rawResult("enroll", "blocked", states("blocked_capacity"), 0, "apply") } });
    requireEditAccessMock.mockResolvedValue(ctx(blocked.supabase));
    expect((await actions.applySeriesRosterAction(enroll, 1)).status).toBe("ok");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("package funding carries only the package, other funding carries no ids", async () => {
    const a = fakeSupabase({ preview_group_class_series_enrollment: { data: rawResult("enroll", "ready", states("will_enroll")) } });
    requireEditAccessMock.mockResolvedValue(ctx(a.supabase));
    await actions.previewSeriesRosterAction({ ...enroll, billingType: "package_credit", clientPackageId: PACKAGE, clientMembershipId: MEMBERSHIP });
    expect(a.calls[0].args).toMatchObject({ p_billing_type: "package_credit", p_client_package_id: PACKAGE, p_client_membership_id: null });
    await actions.previewSeriesRosterAction({ ...enroll, billingType: "pay_as_you_go", clientPackageId: PACKAGE, clientMembershipId: MEMBERSHIP });
    expect(a.calls[1].args).toMatchObject({ p_billing_type: "pay_as_you_go", p_client_package_id: null, p_client_membership_id: null });
  });

  it("removal preview and apply use the removal RPCs", async () => {
    const { supabase, calls } = fakeSupabase({
      preview_group_class_series_removal: { data: rawResult("remove", "ready", states("will_remove")) },
      remove_group_class_series_from: { data: rawResult("remove", "removed", states("will_remove"), 1, "apply") },
    });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const remove = { kind: "remove" as const, appointmentId: APPT, clientId: CLIENT };
    expect((await actions.previewSeriesRosterAction(remove)).status).toBe("ok");
    expect((await actions.applySeriesRosterAction(remove, 1)).status).toBe("ok");
    expect(calls).toEqual([
      { name: "preview_group_class_series_removal", args: { p_appointment_id: APPT, p_client_id: CLIENT } },
      { name: "remove_group_class_series_from", args: { p_appointment_id: APPT, p_client_id: CLIENT, p_expected_count: 1 } },
    ]);
  });

  it("the assigned instructor and other non-broad roles never reach the RPCs", async () => {
    for (const role of ["instructor", "independent_instructor", "student", "readonly"]) {
      const { supabase, calls } = fakeSupabase();
      requireEditAccessMock.mockResolvedValue(ctx(supabase, role));
      const out = await actions.previewSeriesRosterAction(enroll);
      expect(out).toEqual({ status: "error", message: lib.seriesRosterFailureMessage("not_authorized") });
      expect((await actions.applySeriesRosterAction({ kind: "remove", appointmentId: APPT, clientId: CLIENT }, 1)).status).toBe("error");
      expect(calls).toHaveLength(0);
    }
    for (const role of ["studio_owner", "studio_admin", "front_desk"]) {
      const { supabase, calls } = fakeSupabase({ preview_group_class_series_enrollment: { data: rawResult("enroll", "ready", states("will_enroll")) } });
      requireEditAccessMock.mockResolvedValue(ctx(supabase, role));
      expect((await actions.previewSeriesRosterAction(enroll)).status).toBe("ok");
      expect(calls).toHaveLength(1);
    }
    const platform = fakeSupabase({ preview_group_class_series_enrollment: { data: rawResult("enroll", "ready", states("will_enroll")) } });
    requireEditAccessMock.mockResolvedValue(ctx(platform.supabase, "instructor", true));
    expect((await actions.previewSeriesRosterAction(enroll)).status).toBe("ok");
  });

  it("malformed ids, kinds and funding are refused before any RPC", async () => {
    const { supabase, calls } = fakeSupabase();
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const bad = [
      { ...enroll, appointmentId: "nope" },
      { ...enroll, clientId: "x' or 1=1" },
      { ...enroll, billingType: "cash" },
      { ...enroll, billingType: null },
      { ...enroll, billingType: "membership", clientMembershipId: "not-a-uuid" },
      { ...enroll, billingType: "membership", clientMembershipId: null },
      { ...enroll, kind: "other" as unknown as "enroll" },
    ];
    for (const request of bad) {
      expect((await actions.previewSeriesRosterAction(request)).status).toBe("error");
    }
    expect(calls).toHaveLength(0);
  });

  it("database refusals and unexpected failures return fixed copy, never database text", async () => {
    const cases: Array<[string, string]> = [
      ["GCSD2_UNAUTHORIZED: Not authorized to manage the roster of a whole series.", lib.seriesRosterFailureMessage("not_authorized")],
      ["GCSD2_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.", lib.seriesRosterFailureMessage("not_a_series")],
      ["GCSD2_CLIENT_NOT_FOUND: Client not found for this studio.", lib.seriesRosterFailureMessage("client_not_found")],
      ['relation "appointment_attendees" does not exist (secret)', lib.seriesRosterFailureMessage("unknown")],
    ];
    for (const [message, expected] of cases) {
      const { supabase } = fakeSupabase({ preview_group_class_series_enrollment: { error: { message } } });
      requireEditAccessMock.mockResolvedValue(ctx(supabase));
      const out = await actions.previewSeriesRosterAction(enroll);
      expect(out).toEqual({ status: "error", message: expected });
      expect(JSON.stringify(out)).not.toMatch(/secret|relation|GCSD2/);
    }
  });

  it("an unexpected RPC payload or a thrown error is a fixed unknown failure", async () => {
    const odd = fakeSupabase({ preview_group_class_series_enrollment: { data: { nope: true } } });
    requireEditAccessMock.mockResolvedValue(ctx(odd.supabase));
    expect(await actions.previewSeriesRosterAction(enroll)).toEqual({ status: "error", message: lib.seriesRosterFailureMessage("unknown") });
    requireEditAccessMock.mockRejectedValue(new Error("boom secret"));
    const out = await actions.previewSeriesRosterAction(enroll);
    expect(out).toEqual({ status: "error", message: lib.seriesRosterFailureMessage("unknown") });
  });

  it("a negative or non-integer expected count is sent as no expectation", async () => {
    const { supabase, calls } = fakeSupabase({ remove_group_class_series_from: { data: rawResult("remove", "removed", states("will_remove"), 1, "apply") } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    await actions.applySeriesRosterAction({ kind: "remove", appointmentId: APPT, clientId: CLIENT }, -3);
    await actions.applySeriesRosterAction({ kind: "remove", appointmentId: APPT, clientId: CLIENT }, 1.5);
    expect(calls.map((c) => c.args.p_expected_count)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------------
const ATTENDEES = [
  { id: "a1", client_id: "c1", status: "booked", billing_type: "free_comped", clients: { first_name: "Ann", last_name: "Lee" } },
  { id: "a2", client_id: "c2", status: "booked", billing_type: "free_comped", clients: { first_name: "Bo", last_name: "Kim" } },
];
const rosterFor = (funding = true) =>
  rosterPanelLib.buildRosterPanel({
    attendees: ATTENDEES,
    attendance: [{ client_id: "c2", status: "attended" }],
    capacity: 10,
    includeFunding: funding,
    canManage: true,
  });
const renderPanel = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(GroupClassRosterPanel, {
      appointmentId: APPT,
      returnTo: `/app/schedule/${APPT}`,
      roster: rosterFor(),
      canManage: true,
      isBroadStaff: true,
      closedReason: null,
      ...props,
    } as never),
  );

describe("S1D-2 rendering", () => {
  it("broad staff on a series class get the scope choice on Remove, with this class as the unchanged default", () => {
    const html = renderPanel({ seriesScope: true, timeZone: TZ });
    expect(html).toContain("This and following classes");
    expect(html).toContain("This class");
    expect(html).toContain('type="radio"');
    // the default (single) path is the unchanged one-click form
    expect(html).toContain("Remove from class");
    expect(html).toContain('name="attendeeId" value="a1"');
    expect(html).not.toContain('name="attendeeId" value="a2"'); // attended dancer has no Remove control
    expect(html).toContain("No credit is used or returned");
    // no preview before the staff member asks for one
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("Show all");
  });

  it("without series scope (instructor, or not a series class) there is no scope choice or series wording at all", () => {
    for (const props of [{ seriesScope: false }, { seriesScope: false, isBroadStaff: false, roster: rosterFor(false) }, {}]) {
      const html = renderPanel(props);
      expect(html).not.toMatch(/this and following|following classes|series|Which classes/i);
      expect(html).not.toContain('type="radio"');
      expect(html).toContain("Remove from class");
    }
  });

  it("the add control offers the scope only after a dancer is chosen, and not at all without series scope", () => {
    const onSeries = renderToStaticMarkup(createElement(AddDancerPanel, { appointmentId: APPT, returnTo: `/app/schedule/${APPT}`, isBroadStaff: true, full: false, seriesScope: true, timeZone: TZ }));
    expect(onSeries).toContain("+ Add dancer");
    expect(onSeries).not.toContain("Which classes?"); // revealed after choosing the dancer and funding
    expect(onSeries).toContain("Add to class"); // the unchanged default path
    const plain = renderToStaticMarkup(createElement(AddDancerPanel, { appointmentId: APPT, returnTo: `/app/schedule/${APPT}`, isBroadStaff: true, full: false }));
    expect(plain).not.toMatch(/following|series|Which classes/i);
  });

  it("the remove control keeps the single-class form as the default and shows no preview or series button", () => {
    const html = renderToStaticMarkup(createElement(RemoveDancerControl, { appointmentId: APPT, attendeeId: "a1", clientId: "c1", name: "Ann Lee", returnTo: `/app/schedule/${APPT}`, seriesScope: true, timeZone: TZ }));
    expect(html).toContain("Which classes?");
    expect(html).toContain('<input type="radio" name="removeScope-a1" checked=""/>');
    expect(html).toContain("Remove from class");
    expect(html).not.toContain("Review classes");
    expect(html).not.toContain("Remove from 0 classes");
  });

  it("the preview shows the headline, the blocking classes with reasons and a collapsed list of every class", () => {
    const blocked = renderToStaticMarkup(
      createElement(SeriesRosterPreview, {
        result: parse("enroll", "blocked", states("will_enroll", "blocked_capacity", "skipped_cancelled", "blocked_membership_allowance")),
        kind: "enroll",
        name: "Ann Lee",
        timeZone: TZ,
      }),
    );
    expect(blocked).toContain("Ann Lee can&#x27;t be enrolled in the following classes yet.");
    expect(blocked).toContain("Needs attention");
    expect(blocked).toContain("Class is full");
    expect(blocked).toContain("No membership allowance left");
    expect(blocked).toContain("Cancelled class (skipped)");
    expect(blocked).toContain("Show all 4 classes");
    expect(blocked).toContain('role="status"');
    expect(blocked).toContain('aria-live="polite"');
    expect(blocked).toContain("border-amber-300");

    const ready = renderToStaticMarkup(
      createElement(SeriesRosterPreview, {
        result: parse("remove", "ready", states("will_remove", "will_remove", "skipped_terminal")),
        kind: "remove",
        name: "Ann Lee",
        timeZone: TZ,
      }),
    );
    expect(ready).toContain("Remove Ann Lee from 2 classes");
    expect(ready).toContain("No credit is used or returned");
    expect(ready).toContain("Attendance recorded (skipped)");
    expect(ready).not.toContain("Needs attention");
    expect(ready).toContain("border-emerald-200");
  });

  it("offers no portal series self-enrollment and no enrollment-settings (S1D-3) editing", () => {
    const html = renderPanel({ seriesScope: true, timeZone: TZ });
    expect(html).not.toMatch(/self-enroll|portal|enrollment polic|enrollment settings|accepted funding|apply settings/i);
  });
});
