import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * GC-1.4A: staff-side group-class write actions.
 *
 * Drives the real actions (not stand-ins) from src/app/app/schedule/actions.ts,
 * with the role-guard entry points (@/lib/auth/serverRoleGuard,
 * @/lib/auth/appointmentAccess) mocked to hand back a fake Supabase client
 * plus a controllable studioRole/scope -- exactly mirroring the established
 * independentInstructorFloorRental.test.ts / markAppointmentAttendedAction.test.ts
 * convention of mocking the guard entry point while exercising the action's
 * own real logic (RPC call selection, redirect codes, notification
 * ordering).
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

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/schedule/conflicts", () => ({
  detectAppointmentConflicts: vi.fn().mockResolvedValue({ hasConflict: false }),
}));

vi.mock("@/lib/compensation/earnings", () => ({
  stageInstructorEarningForAppointment: vi.fn().mockResolvedValue({ staged: false }),
}));

vi.mock("@/lib/packages/lifecycle", () => ({
  reconcileClientPackageLifecycle: vi.fn().mockResolvedValue({ completedPackageIds: [] }),
}));

const sendGroupClassCancellationPushMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: vi.fn().mockResolvedValue(undefined),
  sendGroupClassCancellationPush: (...args: unknown[]) =>
    sendGroupClassCancellationPushMock(...args),
}));

const requireFloorRentalAppointmentAccessMock = vi.fn();
const requireAppointmentEditAccessMock = vi.fn();
const requireAppointmentDeleteAccessMock = vi.fn();
const requireAppointmentPaymentAccessMock = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...args: unknown[]) =>
    requireFloorRentalAppointmentAccessMock(...args),
  requireAppointmentEditAccess: (...args: unknown[]) => requireAppointmentEditAccessMock(...args),
  requireAppointmentDeleteAccess: (...args: unknown[]) =>
    requireAppointmentDeleteAccessMock(...args),
  requireAppointmentPaymentAccess: (...args: unknown[]) =>
    requireAppointmentPaymentAccessMock(...args),
  requireAppointmentCreateAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));

const requireAppointmentRelationshipAccessMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...args: unknown[]) =>
    requireAppointmentRelationshipAccessMock(...args),
}));

const {
  createAppointmentAction,
  updateAppointmentAction,
  deleteAppointmentAction,
  enrollClassAttendeeAction,
  cancelClassAttendeeAction,
  cancelGroupClassAppointmentAction,
  recordPayAsYouGoClassAttendeePaymentAction,
} = await import("../actions");

const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const APPOINTMENT_ID = "appt-class-1";
const CLIENT_ID = "client-1";

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function run(promise: Promise<unknown>) {
  return promise.catch((error) => error);
}

function redirectUrl(error: unknown): string {
  const digest = (error as { digest?: string })?.digest ?? "";
  return digest.split(";")[2] ?? "";
}

type TableResponses = Record<string, { select?: unknown; update?: { error: unknown } }>;

function makeFakeSupabase(params: {
  tableResponses?: TableResponses;
  rpcResponses?: Record<string, { data?: unknown; error?: unknown }>;
}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const updateCalls: Array<{ table: string; payload: unknown }> = [];

  const supabase = {
    from(table: string) {
      const response = params.tableResponses?.[table];
      let pendingResult: unknown = response?.select ?? { data: null, error: null, count: 0 };

      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.order = self;
      chain.limit = self;
      chain.single = () => Promise.resolve(pendingResult);
      chain.maybeSingle = () => Promise.resolve(pendingResult);
      chain.update = (payload: unknown) => {
        updateCalls.push({ table, payload });
        pendingResult = response?.update ?? { error: null };
        return chain;
      };
      chain.insert = (payload: unknown) => {
        updateCalls.push({ table: `${table}:insert`, payload });
        return Promise.resolve({ error: null });
      };
      // Delete-blocking-check style: `await supabase.from(table).select(...).eq().eq()`
      // (no terminal .single()/.maybeSingle() call) -- the chain itself
      // must be awaitable at any point in the call sequence.
      chain.then = (resolve: (value: unknown) => void) => resolve(pendingResult);
      return chain;
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(params.rpcResponses?.[name] ?? { data: null, error: null });
    },
  };

  return { supabase, rpcCalls, updateCalls };
}

beforeEach(() => {
  requireFloorRentalAppointmentAccessMock.mockReset();
  requireAppointmentEditAccessMock.mockReset();
  requireAppointmentDeleteAccessMock.mockReset();
  requireAppointmentPaymentAccessMock.mockReset();
  requireAppointmentRelationshipAccessMock.mockReset();
  sendGroupClassCancellationPushMock.mockClear();
});

describe("createAppointmentAction -- group_class branch", () => {
  it("broad staff (studio_owner) creates a class via the RPC and redirects to it", async () => {
    const { supabase, rpcCalls } = makeFakeSupabase({
      rpcResponses: { create_group_class_appointment: { data: "new-class-id", error: null } },
    });

    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "studio_owner",
      isPlatformAdmin: false,
    });

    const formData = formDataFor({
      appointmentType: "group_class",
      title: "Beginner Salsa",
      instructorId: "instructor-1",
      roomId: "room-1",
      startsAt: "2026-09-20T18:00",
      endsAt: "2026-09-20T19:00",
    });

    const error = await run(createAppointmentAction({}, formData));

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("create_group_class_appointment");
    expect(rpcCalls[0].args).toMatchObject({
      p_studio_id: STUDIO_ID,
      p_instructor_id: "instructor-1",
      p_room_id: "room-1",
      p_title: "Beginner Salsa",
    });
    expect(redirectUrl(error)).toBe("/app/schedule/new-class-id");
  });

  it("a pure instructor is denied before the RPC is ever called", async () => {
    const { supabase, rpcCalls } = makeFakeSupabase({});

    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "instructor",
      isPlatformAdmin: false,
    });

    const formData = formDataFor({
      appointmentType: "group_class",
      title: "Beginner Salsa",
      startsAt: "2026-09-20T18:00",
      endsAt: "2026-09-20T19:00",
    });

    const result = await createAppointmentAction({}, formData);

    expect(rpcCalls).toHaveLength(0);
    expect(result).toMatchObject({
      error: expect.stringContaining("owner, admin, or front desk"),
    });
  });
});

describe("updateAppointmentAction -- type-transition guard + class-level-field-only edit", () => {
  it("blocks flipping an existing group_class into a lesson type", async () => {
    const { supabase } = makeFakeSupabase({});

    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "studio_owner",
      isPlatformAdmin: false,
    });

    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "broad",
      appointment: { id: APPOINTMENT_ID, studio_id: STUDIO_ID, appointment_type: "group_class" },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      appointmentType: "private_lesson",
      clientId: CLIENT_ID,
    });

    const result = await updateAppointmentAction({}, formData);

    expect(result).toMatchObject({
      error: expect.stringContaining("cannot be changed to another appointment type"),
    });
  });

  it("blocks flipping an existing lesson into group_class", async () => {
    const { supabase } = makeFakeSupabase({});

    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "studio_owner",
      isPlatformAdmin: false,
    });

    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "broad",
      appointment: { id: APPOINTMENT_ID, studio_id: STUDIO_ID, appointment_type: "private_lesson" },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      appointmentType: "group_class",
    });

    const result = await updateAppointmentAction({}, formData);

    expect(result).toMatchObject({
      error: expect.stringContaining("cannot be changed into a group class"),
    });
  });

  it("assigned instructor (own-instructor scope) may edit class-level fields", async () => {
    const { supabase, updateCalls } = makeFakeSupabase({
      tableResponses: {
        appointments: { select: { data: { appointment_type: "group_class" }, error: null }, update: { error: null } },
      },
    });

    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "instructor",
      isPlatformAdmin: false,
    });

    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "own-instructor",
      appointment: { id: APPOINTMENT_ID, studio_id: STUDIO_ID, appointment_type: "group_class" },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      appointmentType: "group_class",
      title: "Renamed Class",
      instructorId: "instructor-1",
      roomId: "room-1",
      startsAt: "2026-09-20T18:00",
      endsAt: "2026-09-20T19:00",
    });

    const error = await run(updateAppointmentAction({}, formData));

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].table).toBe("appointments");
    expect(updateCalls[0].payload).toMatchObject({ title: "Renamed Class" });
    // Never touches client/package/membership/billing fields for a class.
    expect(updateCalls[0].payload).not.toHaveProperty("client_id");
    expect(updateCalls[0].payload).not.toHaveProperty("billing_type");
    expect(redirectUrl(error)).toBe(`/app/schedule/${APPOINTMENT_ID}`);
  });

  it("own-floor-rental scope is denied for a class edit", async () => {
    const { supabase } = makeFakeSupabase({
      tableResponses: {
        appointments: { select: { data: { appointment_type: "group_class" }, error: null } },
      },
    });

    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "independent_instructor",
      isPlatformAdmin: false,
    });

    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "own-floor-rental",
      appointment: { id: APPOINTMENT_ID, studio_id: STUDIO_ID, appointment_type: "group_class" },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      appointmentType: "group_class",
      title: "Renamed Class",
    });

    const result = await updateAppointmentAction({}, formData);

    expect(result).toMatchObject({
      error: expect.stringContaining("do not have permission"),
    });
  });
});

describe("deleteAppointmentAction -- appointment_attendees history blocker", () => {
  it("blocks deletion when roster history exists, with the same friendly redirect as other history checks", async () => {
    const { supabase } = makeFakeSupabase({
      tableResponses: {
        appointments: {
          select: {
            data: { id: APPOINTMENT_ID, client_id: null, appointment_type: "group_class", status: "scheduled" },
            error: null,
          },
        },
        payments: { select: { count: 0, error: null } },
        lesson_transactions: { select: { count: 0, error: null } },
        lesson_recaps: { select: { count: 0, error: null } },
        appointment_package_deduction_errors: { select: { count: 0, error: null } },
        appointment_attendees: { select: { count: 2, error: null } },
      },
    });

    requireAppointmentDeleteAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      confirmDeleteAppointment: "DELETE",
    });

    const error = await run(deleteAppointmentAction(formData));

    expect(redirectUrl(error)).toContain("error=delete_blocked_history");
  });
});

describe("enrollClassAttendeeAction / cancelClassAttendeeAction", () => {
  it("enrolls via the RPC and redirects with a success code", async () => {
    const { supabase, rpcCalls } = makeFakeSupabase({
      rpcResponses: { enroll_class_attendee: { data: "attendee-1", error: null } },
    });

    requireAppointmentEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      clientId: CLIENT_ID,
      billingType: "free_comped",
    });

    const error = await run(enrollClassAttendeeAction(formData));

    expect(rpcCalls[0]).toMatchObject({
      name: "enroll_class_attendee",
      args: { p_appointment_id: APPOINTMENT_ID, p_client_id: CLIENT_ID, p_billing_type: "free_comped" },
    });
    expect(redirectUrl(error)).toContain("success=student_enrolled");
  });

  it("a failed enrollment redirects with an error code, not a thrown raw error", async () => {
    const { supabase } = makeFakeSupabase({
      rpcResponses: {
        enroll_class_attendee: { data: null, error: { message: "This client is already enrolled in this class." } },
      },
    });

    requireAppointmentEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const formData = formDataFor({ appointmentId: APPOINTMENT_ID, clientId: CLIENT_ID });

    const error = await run(enrollClassAttendeeAction(formData));

    expect(redirectUrl(error)).toContain("error=enrollment_failed");
  });

  it("cancels one attendee via the RPC", async () => {
    const { supabase, rpcCalls } = makeFakeSupabase({
      rpcResponses: { cancel_class_attendee: { data: null, error: null } },
    });

    requireAppointmentEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const formData = formDataFor({ appointmentId: APPOINTMENT_ID, attendeeId: "attendee-1" });

    const error = await run(cancelClassAttendeeAction(formData));

    expect(rpcCalls[0]).toMatchObject({
      name: "cancel_class_attendee",
      args: { p_attendee_id: "attendee-1" },
    });
    expect(redirectUrl(error)).toContain("success=attendee_cancelled");
  });
});

describe("cancelGroupClassAppointmentAction -- notification ordering", () => {
  it("sends notifications using exactly the RPC's returned pre-cancellation client ids, after redirect-worthy success", async () => {
    const { supabase, rpcCalls } = makeFakeSupabase({
      rpcResponses: {
        cancel_group_class_appointment: { data: ["client-a", "client-b"], error: null },
      },
    });

    requireAppointmentEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const formData = formDataFor({ appointmentId: APPOINTMENT_ID });

    const error = await run(cancelGroupClassAppointmentAction(formData));

    expect(rpcCalls[0]).toMatchObject({
      name: "cancel_group_class_appointment",
      args: { p_appointment_id: APPOINTMENT_ID },
    });
    // The action must never re-derive recipients itself -- it passes the
    // RPC's own returned array straight through.
    expect(sendGroupClassCancellationPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        studioId: STUDIO_ID,
        appointmentId: APPOINTMENT_ID,
        affectedClientIds: ["client-a", "client-b"],
      }),
    );
    expect(redirectUrl(error)).toContain("success=class_cancelled");
  });

  it("a notification failure does not roll back the cancellation or block the success redirect", async () => {
    const { supabase } = makeFakeSupabase({
      rpcResponses: {
        cancel_group_class_appointment: { data: ["client-a"], error: null },
      },
    });

    requireAppointmentEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });
    sendGroupClassCancellationPushMock.mockRejectedValueOnce(new Error("push provider down"));

    const formData = formDataFor({ appointmentId: APPOINTMENT_ID });

    const error = await run(cancelGroupClassAppointmentAction(formData));

    expect(redirectUrl(error)).toContain("success=class_cancelled");
  });
});

describe("recordPayAsYouGoClassAttendeePaymentAction -- attendee-specific PAYG", () => {
  it("writes price_amount/payment_status onto the attendee row, never appointments", async () => {
    const { supabase, updateCalls } = makeFakeSupabase({
      tableResponses: {
        appointment_attendees: {
          select: {
            data: {
              id: "attendee-1",
              studio_id: STUDIO_ID,
              appointment_id: APPOINTMENT_ID,
              client_id: CLIENT_ID,
              billing_type: "pay_as_you_go",
              payment_status: "unpaid",
            },
            error: null,
          },
          update: { error: null },
        },
        payments: { update: { error: null } },
      },
    });

    requireAppointmentPaymentAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID, user: { id: USER_ID } });

    const formData = formDataFor({
      attendeeId: "attendee-1",
      appointmentId: APPOINTMENT_ID,
      amount: "25",
      paymentMethod: "card",
    });

    const error = await run(recordPayAsYouGoClassAttendeePaymentAction(formData));

    const attendeeUpdate = updateCalls.find((call) => call.table === "appointment_attendees");
    expect(attendeeUpdate?.payload).toMatchObject({ price_amount: 25, payment_status: "paid" });
    expect(updateCalls.some((call) => call.table === "appointments")).toBe(false);
    expect(redirectUrl(error)).toContain("success=payment_recorded");
  });

  it("rejects a non-pay-as-you-go attendee", async () => {
    const { supabase } = makeFakeSupabase({
      tableResponses: {
        appointment_attendees: {
          select: {
            data: {
              id: "attendee-1",
              studio_id: STUDIO_ID,
              billing_type: "package_credit",
              payment_status: "unpaid",
            },
            error: null,
          },
        },
      },
    });

    requireAppointmentPaymentAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID, user: { id: USER_ID } });

    const formData = formDataFor({ attendeeId: "attendee-1", amount: "25" });

    const error = await run(recordPayAsYouGoClassAttendeePaymentAction(formData));

    expect(redirectUrl(error)).toContain("error=not_pay_as_you_go");
  });
});
