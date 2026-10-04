import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GC-S1C-4: "This and following classes" (application layer). The authoritative rules live in
 * cancel_group_class_series_from (test_T_gcsc4 SQL suite + two-session harness); here we prove the
 * action routes scope to the right RPC with only the appointment id, never trusts client counts,
 * maps outcomes to fixed copy, notifies after commit, and survives a notification failure.
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
const singlePushMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: vi.fn().mockResolvedValue(undefined),
  sendGroupClassCancellationPush: (...args: unknown[]) => singlePushMock(...args),
}));
const notifyMock = vi.fn();
vi.mock("@/lib/notifications/groupClassSeriesCancellation", () => ({
  notifySeriesCancellation: (...args: unknown[]) => notifyMock(...args),
}));

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

const { cancelGroupClassAppointmentAction } = await import("../actions");
const series = await import("@/lib/schedule/groupClassSeriesCancel");
const cancel = await import("@/lib/schedule/groupClassCancel");
const { default: GroupClassCancellationForm } = await import("@/components/schedule/GroupClassCancellationForm");
const { buildGroupClassSeriesCancellationEmail } = await import("@/lib/notifications/scheduling-emails");
const { CLIENT_FACING_TEMPLATE_KEYS } = await import("@/lib/notifications/senderIdentity");

const STUDIO = "studio-1";
const APPT = "appt-1";

const RESULT = {
  series_id: "ser-1",
  studio_id: STUDIO,
  occurrence_index: 2,
  cancelled_class_count: 3,
  enrollments_cancelled: 4,
  already_cancelled_count: 1,
  historical_count: 1,
  terminal_attendance_count: 0,
  series_status: "cancelled",
  series_cancelled_by_this_call: true,
  recipients: [{ client_id: "c1", class_starts: ["2026-11-03T23:30:00Z", "2026-11-10T23:30:00Z"] }],
};

function makeSupabase(opts: { status?: string; rpc?: { data?: unknown; error?: { message: string } | null } } = {}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const writes: string[] = [];
  const supabase = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () =>
        Promise.resolve({
          data: { id: APPT, appointment_type: "group_class", status: opts.status ?? "scheduled" },
          error: null,
        });
      chain.update = () => {
        writes.push(`update:${table}`);
        return chain;
      };
      chain.insert = () => {
        writes.push(`insert:${table}`);
        return Promise.resolve({ error: null });
      };
      chain.delete = () => {
        writes.push(`delete:${table}`);
        return chain;
      };
      return chain;
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(opts.rpc ?? { data: RESULT, error: null });
    },
  };
  return { supabase, rpcCalls, writes };
}

function form(fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("appointmentId", APPT);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const redirectUrl = (e: unknown) => ((e as { digest?: string })?.digest ?? "").split(";")[2] ?? "";
const run = (p: Promise<unknown>) => p.catch((e) => e);
function asRole(supabase: unknown, studioRole: string, isPlatformAdmin = false) {
  requireEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO, user: { id: "u1" }, studioRole, isPlatformAdmin });
}

beforeEach(() => {
  singlePushMock.mockClear();
  notifyMock.mockReset().mockResolvedValue(1);
  requireEditAccessMock.mockReset();
});

describe("S1C-4 action: this_and_following", () => {
  it("calls only the series RPC with just the appointment id, notifies after commit, redirects with the DB count", async () => {
    const { supabase, rpcCalls, writes } = makeSupabase();
    asRole(supabase, "studio_owner");
    const err = await run(
      cancelGroupClassAppointmentAction(
        form({ classCancelScope: "this_and_following", classCount: "99", recipients: "evil", seriesId: "other" }),
      ),
    );
    expect(rpcCalls).toEqual([{ name: "cancel_group_class_series_from", args: { p_appointment_id: APPT } }]);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorAppointmentId: APPT,
        result: expect.objectContaining({ cancelledClassCount: 3, seriesId: "ser-1" }),
      }),
    );
    expect(singlePushMock).not.toHaveBeenCalled();
    const url = redirectUrl(err);
    expect(url).toContain("success=series_cancelled");
    expect(url).toContain("count=3");
    expect(writes).toEqual([]);
  });

  it("works for platform admin, admin and front desk; series stays active when classes remain", async () => {
    for (const [role, admin] of [["front_desk", false], ["studio_admin", false], ["", true]] as const) {
      const { supabase } = makeSupabase({
        rpc: { data: { ...RESULT, series_status: "active", series_cancelled_by_this_call: false }, error: null },
      });
      asRole(supabase, role, admin);
      const err = await run(cancelGroupClassAppointmentAction(form({ classCancelScope: "this_and_following" })));
      expect(redirectUrl(err)).toContain("success=series_classes_cancelled");
    }
  });

  it("an assigned instructor never reaches the series RPC", async () => {
    const { supabase, rpcCalls } = makeSupabase();
    asRole(supabase, "instructor");
    const err = await run(cancelGroupClassAppointmentAction(form({ classCancelScope: "this_and_following" })));
    expect(rpcCalls).toHaveLength(0);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(redirectUrl(err)).toContain("error=class_cancel_not_authorized");
  });

  it("replay (nothing cancelled) reports nothing to cancel with no count", async () => {
    const { supabase } = makeSupabase({
      rpc: {
        data: {
          ...RESULT,
          cancelled_class_count: 0,
          enrollments_cancelled: 0,
          already_cancelled_count: 4,
          series_cancelled_by_this_call: false,
          recipients: [],
        },
        error: null,
      },
    });
    asRole(supabase, "studio_owner");
    const err = await run(cancelGroupClassAppointmentAction(form({ classCancelScope: "this_and_following" })));
    const url = redirectUrl(err);
    expect(url).toContain("success=series_nothing_to_cancel");
    expect(url).not.toContain("count=");
  });

  it("an already-cancelled anchor still runs the series RPC (later classes may remain)", async () => {
    const { supabase, rpcCalls } = makeSupabase({ status: "cancelled" });
    asRole(supabase, "studio_owner");
    await run(cancelGroupClassAppointmentAction(form({ classCancelScope: "this_and_following" })));
    expect(rpcCalls.map((c) => c.name)).toEqual(["cancel_group_class_series_from"]);
  });

  it("a notification failure does not undo or hide the cancellation", async () => {
    notifyMock.mockRejectedValue(new Error("smtp exploded"));
    const { supabase } = makeSupabase();
    asRole(supabase, "studio_owner");
    const err = await run(cancelGroupClassAppointmentAction(form({ classCancelScope: "this_and_following" })));
    expect(redirectUrl(err)).toContain("success=series_cancelled");
  });

  it("maps RPC errors to fixed codes with no raw text and sends nothing", async () => {
    const cases: Array<[string, string]> = [
      ["GCSC4_UNAUTHORIZED: Not authorized to cancel classes in this series.", "series_cancel_not_authorized"],
      ["GCSC4_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.", "series_cancel_not_a_series"],
      ["GCSC4_NOT_FOUND: Group class not found.", "appointment_not_found"],
      ["deadlock detected; secret internals", "series_cancel_failed"],
    ];
    for (const [message, code] of cases) {
      const { supabase } = makeSupabase({ rpc: { error: { message } } });
      asRole(supabase, "studio_owner");
      const err = await run(cancelGroupClassAppointmentAction(form({ classCancelScope: "this_and_following" })));
      const url = redirectUrl(err);
      expect(url).toContain(`error=${code}`);
      expect(url).not.toMatch(/GCSC4|deadlock|secret/);
    }
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("a malformed RPC result is a safe failure", async () => {
    const { supabase } = makeSupabase({ rpc: { data: "nope", error: null } });
    asRole(supabase, "studio_owner");
    const err = await run(cancelGroupClassAppointmentAction(form({ classCancelScope: "this_and_following" })));
    expect(redirectUrl(err)).toContain("error=series_cancel_failed");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("an unknown scope (including an entire-series attempt) is refused before any RPC", async () => {
    for (const scope of ["entire_series", "all", "this-and-following", "THIS_CLASS"]) {
      const { supabase, rpcCalls } = makeSupabase();
      asRole(supabase, "studio_owner");
      const err = await run(cancelGroupClassAppointmentAction(form({ classCancelScope: scope })));
      expect(redirectUrl(err)).toContain("error=series_cancel_invalid_scope");
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it("scope absent or this_class keeps the single-occurrence RPC", async () => {
    for (const fields of [{}, { classCancelScope: "this_class" }] as Array<Record<string, string>>) {
      const { supabase, rpcCalls } = makeSupabase({ rpc: { data: ["c1"], error: null } });
      asRole(supabase, "studio_owner");
      const err = await run(cancelGroupClassAppointmentAction(form(fields)));
      expect(rpcCalls).toEqual([{ name: "cancel_group_class_appointment", args: { p_appointment_id: APPT } }]);
      expect(singlePushMock).toHaveBeenCalled();
      expect(redirectUrl(err)).toContain("success=class_cancelled");
      singlePushMock.mockClear();
    }
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("S1C-4 pure helpers", () => {
  it("parses scope strictly", () => {
    expect(series.parseGroupClassCancelScope(undefined)).toBe("this_class");
    expect(series.parseGroupClassCancelScope("")).toBe("this_class");
    expect(series.parseGroupClassCancelScope("this_and_following")).toBe("this_and_following");
    expect(series.parseGroupClassCancelScope("entire_series")).toBeNull();
  });

  it("parses RPC results defensively and drops malformed recipients", () => {
    const parsed = series.parseGroupClassSeriesCancelResult({
      ...RESULT,
      recipients: [{ client_id: "c1", class_starts: ["a", 5] }, { client_id: 3 }, null, { client_id: "c2", class_starts: [] }],
    });
    expect(parsed?.recipients).toEqual([{ clientId: "c1", classStarts: ["a"] }]);
    expect(series.parseGroupClassSeriesCancelResult(null)).toBeNull();
    expect(series.parseGroupClassSeriesCancelResult([])).toBeNull();
    expect(series.parseGroupClassSeriesCancelResult({ series_id: 1 })).toBeNull();
  });

  it("banner copy is fixed, kind-matched and count-safe", () => {
    expect(cancel.groupClassCancelBanner({ success: "series_cancelled", count: "3" })?.message).toBe(
      "3 classes cancelled. The series is now cancelled.",
    );
    expect(cancel.groupClassCancelBanner({ success: "series_classes_cancelled", count: "1" })?.message).toContain(
      "1 class cancelled",
    );
    expect(cancel.groupClassCancelBanner({ success: "series_classes_cancelled", count: "<script>" })?.message).not.toContain("<");
    expect(cancel.groupClassCancelBanner({ error: "series_cancel_not_authorized" })).toMatchObject({ kind: "error" });
    expect(cancel.groupClassCancelBanner({ error: "series_cancelled" })).toBeNull();
    expect(cancel.groupClassCancelBanner({ success: "series_cancel_failed" })).toBeNull();
  });

  it("impact summary states remaining classes, dancers and the series outcome truthfully", () => {
    const lines = series.groupClassSeriesCancelImpactLines({
      eligibleClassCount: 5,
      enrollmentsAffected: 9,
      dancersAffected: 4,
      alreadyCancelledCount: 0,
      historicalCount: 2,
      terminalAttendanceCount: 1,
      seriesWouldBeCancelled: false,
    });
    const text = lines.join(" ");
    expect(text).toContain("5 classes from this one onward will be cancelled");
    expect(text).toContain("4 dancers are enrolled in 9 bookings");
    expect(text).toContain("1 class has recorded attendance");
    expect(text).toContain("stays active");
    expect(text).not.toMatch(/entire series/i);
  });
});

describe("S1C-4 form", () => {
  const preview = {
    eligibleClassCount: 4,
    enrollmentsAffected: 6,
    dancersAffected: 3,
    alreadyCancelledCount: 0,
    historicalCount: 0,
    terminalAttendanceCount: 0,
    seriesWouldBeCancelled: true,
  };
  const html = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(GroupClassCancellationForm, {
        appointmentId: APPT,
        returnTo: "/app/schedule",
        isSeriesOccurrence: true,
        ...props,
      }),
    );

  it("offers exactly two scopes for a series occurrence with a preview, and never an entire-series choice", () => {
    const out = html({ seriesPreview: preview });
    expect(out).toContain('value="this_class"');
    expect(out).toContain('value="this_and_following"');
    expect(out).not.toMatch(/entire series/i);
    expect(out).toContain("3 dancers enrolled");
  });

  it("offers no series option without a preview, for a standalone class, or with nothing eligible", () => {
    expect(html({})).not.toContain("this_and_following");
    expect(html({ seriesPreview: preview, isSeriesOccurrence: false })).not.toContain("this_and_following");
    expect(html({ seriesPreview: { ...preview, eligibleClassCount: 0 } })).not.toContain("this_and_following");
  });
});

describe("S1C-4 consolidated email", () => {
  it("is allowlisted as client-facing and renders one letter listing every class", () => {
    expect(CLIENT_FACING_TEMPLATE_KEYS.has("group_class_series_cancelled")).toBe(true);
    const email = buildGroupClassSeriesCancellationEmail({
      studio: { name: "Legal Name LLC", public_name: "Bright Studio", slug: "bright" },
      firstName: "Ava",
      classTitle: "Salsa Basics",
      classTimes: ["Tue, Nov 3, 6:30 PM", "Tue, Nov 10, 6:30 PM"],
    });
    expect(email.subject).toBe("Bright Studio: Salsa Basics cancelled");
    expect(email.bodyText).toContain("cancelled 2 upcoming sessions of Salsa Basics");
    expect(email.bodyText).toContain("- Tue, Nov 3, 6:30 PM");
    expect(email.bodyText).toContain("- Tue, Nov 10, 6:30 PM");
    expect(email.bodyText).not.toContain("Legal Name LLC");
    expect(email.bodyHtml).toContain("Tue, Nov 10, 6:30 PM");
  });
});
