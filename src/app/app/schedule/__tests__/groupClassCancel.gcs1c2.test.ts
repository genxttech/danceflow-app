import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GC-S1C-2: canonical group-class cancellation safety (application layer).
 *
 * Drives the real cancelGroupClassAppointmentAction and the generic
 * cancelAppointmentAction with the role-guard entry points mocked (the repo's
 * convention) and a fake Supabase client that records every table write. The
 * authoritative terminal-state rules live in the RPC (covered by
 * test_T_gcsc2_group_class_cancel_safety.sql); here we prove the application
 * routes every class cancellation to that single path, never runs the generic
 * mutation logic for a class, and maps outcomes to safe copy.
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
  sendAppointmentSchedulePush: vi.fn().mockResolvedValue(undefined),
  sendGroupClassCancellationPush: (...args: unknown[]) => pushMock(...args),
}));

const requireEditAccessMock = vi.fn();
const requireFloorRentalMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...a: unknown[]) => requireFloorRentalMock(...a),
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

const { cancelGroupClassAppointmentAction, cancelAppointmentAction } = await import("../actions");
const cancel = await import("@/lib/schedule/groupClassCancel");
const { canCancelGroupClass } = await import("@/lib/auth/permissions");
const { default: GroupClassCancellationForm } = await import(
  "@/components/schedule/GroupClassCancellationForm"
);

const STUDIO = "studio-1";
const APPT = "appt-1";

type Setup = {
  loaded?: { id: string; appointment_type: string; status: string } | null;
  loadError?: boolean;
  rpc?: { data?: unknown; error?: { message: string } | null };
};

function makeSupabase(setup: Setup = {}) {
  const loaded =
    setup.loaded === undefined
      ? { id: APPT, appointment_type: "group_class", status: "scheduled" }
      : setup.loaded;
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const tableWrites: Array<{ table: string; op: string }> = [];
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const supabase = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (c: string, v: unknown) => {
        filters.push([c, v]);
        return chain;
      };
      chain.maybeSingle = () => {
        reads.push({ table, filters });
        return Promise.resolve(
          setup.loadError ? { data: null, error: { message: "raw db error" } } : { data: loaded, error: null },
        );
      };
      chain.update = () => {
        tableWrites.push({ table, op: "update" });
        return chain;
      };
      chain.delete = () => {
        tableWrites.push({ table, op: "delete" });
        return chain;
      };
      chain.insert = () => {
        tableWrites.push({ table, op: "insert" });
        return Promise.resolve({ error: null });
      };
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return chain;
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(setup.rpc ?? { data: [], error: null });
    },
  };
  return { supabase, rpcCalls, tableWrites, reads };
}

function form(fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("appointmentId", APPT);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const redirectUrl = (e: unknown) => ((e as { digest?: string })?.digest ?? "").split(";")[2] ?? "";
async function run(p: Promise<unknown>) {
  return p.catch((e) => e);
}

function asRole(supabase: unknown, studioRole: string, isPlatformAdmin = false) {
  const ctx = { supabase, studioId: STUDIO, user: { id: "u1" }, studioRole, isPlatformAdmin };
  requireEditAccessMock.mockResolvedValue(ctx);
  requireFloorRentalMock.mockResolvedValue(ctx);
  return ctx;
}

beforeEach(() => {
  pushMock.mockClear().mockResolvedValue(undefined);
  requireEditAccessMock.mockReset();
  requireFloorRentalMock.mockReset();
  requireRelationshipMock.mockReset();
});

describe("S1C-2 class cancel action", () => {
  it("cancels via the RPC and pushes exactly once to the RPC-returned clients", async () => {
    const { supabase, rpcCalls, tableWrites } = makeSupabase({ rpc: { data: ["c1", "c2"], error: null } });
    asRole(supabase, "studio_owner");
    const err = await run(cancelGroupClassAppointmentAction(form()));
    expect(rpcCalls).toEqual([{ name: "cancel_group_class_appointment", args: { p_appointment_id: APPT } }]);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({ affectedClientIds: ["c1", "c2"], appointmentId: APPT, studioId: STUDIO }));
    expect(redirectUrl(err)).toContain("success=class_cancelled");
    expect(tableWrites).toEqual([]);
  });

  it("an RPC replay (empty recipient list) sends no notification", async () => {
    const { supabase } = makeSupabase({ rpc: { data: [], error: null } });
    asRole(supabase, "front_desk");
    const err = await run(cancelGroupClassAppointmentAction(form()));
    expect(pushMock).not.toHaveBeenCalled();
    expect(redirectUrl(err)).toContain("success=class_cancelled");
  });

  it("an already-cancelled class is a no-op: no RPC, no push, friendly success", async () => {
    const { supabase, rpcCalls } = makeSupabase({
      loaded: { id: APPT, appointment_type: "group_class", status: "cancelled" },
    });
    asRole(supabase, "studio_admin");
    const err = await run(cancelGroupClassAppointmentAction(form()));
    expect(rpcCalls).toHaveLength(0);
    expect(pushMock).not.toHaveBeenCalled();
    expect(redirectUrl(err)).toContain("success=class_already_cancelled");
  });

  it("recorded attendance (RPC refusal) maps to the fixed code, no push, no raw text", async () => {
    const { supabase } = makeSupabase({
      rpc: { error: { message: "GCSC2_ATTENDANCE_RECORDED: This class already has attendance recorded. Correct the attendance record before cancelling the class." } },
    });
    asRole(supabase, "studio_owner");
    const err = await run(cancelGroupClassAppointmentAction(form()));
    const url = redirectUrl(err);
    expect(url).toContain("error=class_cancel_attendance_recorded");
    expect(url).not.toContain("GCSC2");
    expect(url).not.toContain("attendance%20recorded");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("maps authorization and unknown RPC failures to fixed codes without raw text", async () => {
    for (const [message, code] of [
      ["Not authorized to cancel this class.", "class_cancel_not_authorized"],
      ["Group class not found.", "appointment_not_found"],
      ["deadlock detected on relation appointments", "class_cancel_failed"],
    ] as const) {
      const { supabase } = makeSupabase({ rpc: { error: { message } } });
      asRole(supabase, "studio_owner");
      const err = await run(cancelGroupClassAppointmentAction(form()));
      expect(redirectUrl(err)).toContain(`error=${code}`);
      expect(redirectUrl(err)).not.toContain("deadlock");
    }
  });

  it("a push failure does not undo the cancellation", async () => {
    const { supabase } = makeSupabase({ rpc: { data: ["c1"], error: null } });
    asRole(supabase, "studio_owner");
    pushMock.mockRejectedValueOnce(new Error("push provider down"));
    const err = await run(cancelGroupClassAppointmentAction(form()));
    expect(redirectUrl(err)).toContain("success=class_cancelled");
  });

  it("is broad-staff only: instructors (even the assigned one) are refused before any RPC", async () => {
    for (const role of ["instructor", "independent_instructor"]) {
      const { supabase, rpcCalls } = makeSupabase();
      asRole(supabase, role);
      const err = await run(cancelGroupClassAppointmentAction(form()));
      expect(redirectUrl(err)).toContain("error=class_cancel_not_authorized");
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it("allows platform admin and the three broad studio roles", async () => {
    for (const [role, pa] of [["studio_owner", false], ["studio_admin", false], ["front_desk", false], ["", true]] as const) {
      const { supabase, rpcCalls } = makeSupabase({ rpc: { data: [], error: null } });
      asRole(supabase, role, pa);
      await run(cancelGroupClassAppointmentAction(form()));
      expect(rpcCalls).toHaveLength(1);
    }
    expect(canCancelGroupClass("instructor")).toBe(false);
    expect(canCancelGroupClass("studio_owner")).toBe(true);
    expect(canCancelGroupClass(null)).toBe(false);
  });

  it("loads the class scoped to the authenticated studio; a client-supplied studio is ignored", async () => {
    const { supabase, reads } = makeSupabase();
    asRole(supabase, "studio_owner");
    await run(cancelGroupClassAppointmentAction(form({ studioId: "studio-2", studio_id: "studio-2" })));
    const load = reads.find((r) => r.table === "appointments");
    expect(load?.filters).toEqual(expect.arrayContaining([["id", APPT], ["studio_id", STUDIO]]));
  });

  it("refuses a missing class or a non-class appointment without calling the RPC", async () => {
    for (const loaded of [null, { id: APPT, appointment_type: "private_lesson", status: "scheduled" }]) {
      const { supabase, rpcCalls } = makeSupabase({ loaded });
      asRole(supabase, "studio_owner");
      const err = await run(cancelGroupClassAppointmentAction(form()));
      expect(redirectUrl(err)).toContain("error=appointment_not_found");
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it("never writes any table itself (no usage clear, no attendance, no appointment update)", async () => {
    const { supabase, tableWrites } = makeSupabase({ rpc: { data: ["c1"], error: null } });
    asRole(supabase, "studio_owner");
    await run(cancelGroupClassAppointmentAction(form()));
    expect(tableWrites).toEqual([]);
  });
});

describe("S1C-2 generic cancel routing", () => {
  function arrangeGeneric(supabaseSetup: Setup, role = "studio_owner", type = "group_class") {
    const made = makeSupabase(supabaseSetup);
    asRole(made.supabase, role);
    requireRelationshipMock.mockResolvedValue({
      ok: true,
      scope: "broad",
      appointment: {
        id: APPT,
        studio_id: STUDIO,
        client_id: null,
        instructor_id: "i1",
        appointment_type: type,
        recurrence_series_id: "r1",
        starts_at: "2026-11-01T10:00:00Z",
        title: "x",
        client_package_id: null,
        client_membership_id: null,
        billing_type: null,
        status: "scheduled",
      },
    });
    return made;
  }

  it("a group class goes through the class path BEFORE any generic mutation, with no requester/reason/charge/scope", async () => {
    const { rpcCalls, tableWrites } = arrangeGeneric({ rpc: { data: ["c1"], error: null } });
    const err = await run(
      cancelAppointmentAction(form({ cancelScope: "this_and_future", missedAppointmentCharge: "package" })),
    );
    expect(rpcCalls).toEqual([{ name: "cancel_group_class_appointment", args: { p_appointment_id: APPT } }]);
    expect(tableWrites).toEqual([]); // no status flip, no client_membership_usage delete, no charge
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(redirectUrl(err)).toContain("success=class_cancelled");
  });

  it("the generic path never clears membership usage for a group class (no client_membership_usage write)", async () => {
    const { tableWrites } = arrangeGeneric({ rpc: { data: [], error: null } });
    await run(cancelAppointmentAction(form()));
    expect(tableWrites.some((w) => w.table === "client_membership_usage")).toBe(false);
    expect(tableWrites.some((w) => w.table === "appointments")).toBe(false);
  });

  it("an instructor reaching the generic action for a class is refused by the class path", async () => {
    const { rpcCalls } = arrangeGeneric({}, "instructor");
    const err = await run(cancelAppointmentAction(form()));
    expect(redirectUrl(err)).toContain("error=class_cancel_not_authorized");
    expect(rpcCalls).toHaveLength(0);
  });

  it("other appointment types still run the generic requester/reason validation unchanged", async () => {
    const { rpcCalls } = arrangeGeneric({}, "studio_owner", "private_lesson");
    const err = await run(cancelAppointmentAction(form()));
    expect(redirectUrl(err)).toContain("error=cancellation_requester_required");
    expect(rpcCalls).toHaveLength(0);
    const err2 = await run(cancelAppointmentAction(form({ cancellationRequestedBy: "studio" })));
    expect(redirectUrl(err2)).toContain("error=cancellation_reason_required");
  });

  it("source order: the group-class delegation precedes every generic mutation helper", () => {
    const src = readFileSync("src/app/app/schedule/actions.ts", "utf8");
    const generic = src.slice(
      src.indexOf("export async function cancelAppointmentAction"),
      src.indexOf("export async function markAppointmentAttendedAction"),
    );
    const delegate = generic.indexOf("cancelCanonicalGroupClass(");
    expect(delegate).toBeGreaterThan(0);
    for (const marker of ["clearMembershipUsageForAppointment(", "applyMissedAppointmentCharge(", ".update({", "recurrence_series_id", "cancellation_requester_required"]) {
      const idx = generic.indexOf(marker, generic.indexOf("relationshipResult.appointment"));
      expect(idx).toBeGreaterThan(delegate);
    }
  });

  it("the class helper itself never references usage, charge, attendance or series mutation", () => {
    const src = readFileSync("src/app/app/schedule/actions.ts", "utf8");
    const helper = src
      .slice(
        src.indexOf("async function cancelCanonicalGroupClass("),
        src.indexOf("// GC-S1C-4: \"This and following classes\"."),
      )
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["clearMembershipUsageForAppointment", "client_membership_usage", "attendance_records", "applyMissedAppointmentCharge", "group_class_series", ".delete(", ".update("]) {
      expect(helper).not.toContain(forbidden);
    }
  });

  it("GC-S1C-4: the series helper only calls the one RPC (no direct table mutation, usage or attendance)", () => {
    const src = readFileSync("src/app/app/schedule/actions.ts", "utf8");
    const helper = src
      .slice(
        src.indexOf("async function cancelGroupClassSeriesFrom("),
        src.indexOf("export async function cancelGroupClassAppointmentAction"),
      )
      .replace(/^\s*\/\/.*$/gm, "");
    expect(helper).toContain('"cancel_group_class_series_from"');
    for (const forbidden of ["clearMembershipUsageForAppointment", "client_membership_usage", "attendance_records", "applyMissedAppointmentCharge", ".from(", ".delete(", ".update(", ".insert("]) {
      expect(helper).not.toContain(forbidden);
    }
  });
});

describe("S1C-2 pure helpers", () => {
  it("classifies RPC errors without exposing raw text", () => {
    expect(cancel.classifyGroupClassCancelError({ message: "GCSC2_ATTENDANCE_RECORDED: ..." })).toBe("attendance_recorded");
    expect(cancel.classifyGroupClassCancelError({ message: "Not authorized to cancel this class." })).toBe("not_authorized");
    expect(cancel.classifyGroupClassCancelError({ message: "Group class not found." })).toBe("not_found");
    expect(cancel.classifyGroupClassCancelError({ message: "boom" })).toBe("unknown");
    expect(cancel.classifyGroupClassCancelError(null)).toBe("unknown");
  });

  it("banners are fixed copy and kind-matched", () => {
    expect(cancel.groupClassCancelBanner({ success: "class_cancelled" })).toMatchObject({ kind: "success" });
    expect(cancel.groupClassCancelBanner({ error: "class_cancel_attendance_recorded" })?.message).toContain("Correct the attendance record");
    expect(cancel.groupClassCancelBanner({ error: "class_cancelled" })).toBeNull();
    expect(cancel.groupClassCancelBanner({ error: "something_else" })).toBeNull();
    expect(cancel.groupClassCancelBanner({})).toBeNull();
  });

  it("consequence copy is truthful: no claim that every student is notified", () => {
    const lines = cancel.groupClassCancelConsequences({ bookedCount: 8, isSeriesOccurrence: true });
    expect(lines[0]).toBe("This cancels only this class. Other classes in the series stay scheduled.");
    expect(lines).toContain("8 booked students will be marked cancelled.");
    expect(lines.join(" ")).toContain("linked DanceFlow account may receive");
    expect(lines.join(" ")).toContain("not changed");
    expect(lines.join(" ")).not.toMatch(/all students will be notified|every student/i);
    expect(cancel.groupClassCancelConsequences({ bookedCount: 1, isSeriesOccurrence: false })[0]).toBe("1 booked student will be marked cancelled.");
    expect(cancel.groupClassCancelConsequences({ bookedCount: null, isSeriesOccurrence: false })[0]).toBe("Any booked students will be marked cancelled.");
  });
});

describe("S1C-2 UI", () => {
  it("class cancel form: series wording, no requester/reason/charge/scope controls", () => {
    const html = renderToStaticMarkup(
      createElement(GroupClassCancellationForm, { appointmentId: APPT, returnTo: "/app/schedule", isSeriesOccurrence: true, bookedCount: 3 }),
    );
    expect(html).toContain("Cancel this class");
    expect(html).toContain("This cancels only this class. Other classes in the series stay scheduled.");
    expect(html).toContain("3 booked students will be marked cancelled.");
    for (const absent of ["cancellationRequestedBy", "cancellationReason", "missedAppointmentCharge", "cancelScope", "Short-notice charge", "Cancellation scope"]) {
      expect(html).not.toContain(absent);
    }
    expect(html).toContain('name="appointmentId"');
  });

  it("a standalone class does not mention the series", () => {
    const html = renderToStaticMarkup(
      createElement(GroupClassCancellationForm, { appointmentId: APPT, returnTo: "/app/schedule", isSeriesOccurrence: false, bookedCount: 0 }),
    );
    expect(html).not.toContain("series");
    expect(html).not.toContain("booked student");
  });

  it("detail, list and drawer all route a class to the class-specific path", () => {
    const detail = readFileSync("src/app/app/schedule/[id]/page.tsx", "utf8");
    const list = readFileSync("src/app/app/schedule/page.tsx", "utf8");
    const drawer = readFileSync("src/app/app/schedule/calendar/ScheduleEventDrawer.tsx", "utf8");
    expect(detail).toContain("GroupClassCancellationForm");
    expect(detail).toMatch(/!isFinalStatus && canEdit && !isGroupClass/);
    expect(list).toContain("GroupClassCancellationForm");
    expect(list).toMatch(/isGroupClass && !isFinalStatus && canCancelGroupClass\(role\)/);
    // drawer: the generic cancel form is only for non-class appointments
    expect(drawer).toMatch(/canShowCancelAction && isGroupClass/);
    expect(drawer).toMatch(/canShowCancelAction && !isGroupClass/);
    expect(drawer).toContain("Cancel this class");
  });

  it("detail page hides Delete for a series occurrence, keeps it for standalone, and shows recorded-attendance state", () => {
    const detail = readFileSync("src/app/app/schedule/[id]/page.tsx", "utf8");
    expect(detail).toMatch(/canDeleteAppointments\(role\) && !isFinalStatus && !isSeriesOccurrence/);
    expect(detail).toContain("classHasRecordedAttendance");
    expect(detail).toContain("already has attendance recorded");
  });
});

describe("S1C-2 boundaries", () => {
  it("the migration never deletes usage, rewrites attendance, or touches series/events", () => {
    const sql = readFileSync("src/lib/supabase/migrations/20261016090000_gcsc2_group_class_cancel_safety.sql", "utf8")
      .replace(/^\s*--.*$/gm, "");
    expect(sql).not.toMatch(/\bdelete\b/i);
    expect(sql).not.toMatch(/update\s+public\.attendance_records/i);
    expect(sql).not.toMatch(/client_membership_usage|client_package_items|group_class_series\b|event_/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = 'public'/);
    expect(sql).toContain("GCSC2_ATTENDANCE_RECORDED");
    expect(sql).toMatch(/status in \('attended', 'no_show'\)/);
  });

  it("GC-R1 excludes cancelled appointments from new reminder generation and is untouched", () => {
    const route = readFileSync("src/app/api/notifications/generate/route.ts", "utf8");
    expect(route).toContain('.neq("status", "cancelled")');
    const reminders = readFileSync("src/lib/notifications/groupClassReminders.ts", "utf8");
    expect(reminders).not.toMatch(/cancel_group_class_appointment|GCSC2/);
  });

  it("no admin/service-role client is introduced for class cancellation", () => {
    const helper = readFileSync("src/lib/schedule/groupClassCancel.ts", "utf8");
    const comp = readFileSync("src/components/schedule/GroupClassCancellationForm.tsx", "utf8");
    expect(helper + comp).not.toMatch(/createAdminClient|service_role/);
  });
});
