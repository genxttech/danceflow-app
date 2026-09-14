import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * GC-3.3: staff-side group-class enrollment policy authoring action.
 *
 * Drives the real updateGroupClassEnrollmentPolicyAction (not a stand-in)
 * from src/app/app/schedule/actions.ts, with requireAppointmentEditAccess
 * mocked -- mirroring the established groupClassActions.gc1_4a.test.ts
 * convention. Covers the merge-preserving upsert design from the
 * implementation plan (section 51, "revision pass" item 1): first-row
 * creation builds accepted_funding_types fresh from only the two managed
 * checkboxes; an update preserves any pre-existing unmanaged value
 * (direct_payment/manual_other) untouched while only ever adding/removing
 * package/membership; validation checks the RESULTING merged array, not
 * "at least one checkbox checked".
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

vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: vi.fn().mockResolvedValue(undefined),
  sendGroupClassCancellationPush: vi.fn().mockResolvedValue(undefined),
}));

const requireAppointmentEditAccessMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireAppointmentEditAccess: (...args: unknown[]) => requireAppointmentEditAccessMock(...args),
  requireFloorRentalAppointmentAccess: vi.fn(),
  requireAppointmentDeleteAccess: vi.fn(),
  requireAppointmentPaymentAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));

vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: vi.fn(),
}));

const { updateGroupClassEnrollmentPolicyAction } = await import("../actions");

const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const APPOINTMENT_ID = "appt-class-1";

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

function makeFakeSupabase(params: {
  existingRow?: { accepted_funding_types: string[] | null } | null;
}) {
  const insertCalls: Array<{ table: string; payload: unknown }> = [];
  const updateCalls: Array<{ table: string; payload: unknown }> = [];

  const supabase = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () =>
        Promise.resolve({ data: params.existingRow ?? null, error: null });
      chain.insert = (payload: unknown) => {
        insertCalls.push({ table, payload });
        return Promise.resolve({ error: null });
      };
      chain.update = (payload: unknown) => {
        updateCalls.push({ table, payload });
        return { eq: () => Promise.resolve({ error: null }) };
      };
      return chain;
    },
  };

  return { supabase, insertCalls, updateCalls };
}

beforeEach(() => {
  requireAppointmentEditAccessMock.mockReset();
});

describe("updateGroupClassEnrollmentPolicyAction", () => {
  it("first-row creation: builds accepted_funding_types fresh from only the checked boxes, sets created_by", async () => {
    const { supabase, insertCalls } = makeFakeSupabase({ existingRow: null });

    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      publiclyDiscoverable: "on",
      selfEnrollmentAllowed: "on",
      packageEnabled: "on",
    });

    const error = await run(updateGroupClassEnrollmentPolicyAction(formData));

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].payload).toMatchObject({
      studio_id: STUDIO_ID,
      appointment_id: APPOINTMENT_ID,
      publicly_discoverable: true,
      self_enrollment_allowed: true,
      accepted_funding_types: ["package"],
      created_by: USER_ID,
    });
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

  it("update path: preserves a pre-existing unmanaged value (direct_payment) while swapping package for membership", async () => {
    const { supabase, updateCalls } = makeFakeSupabase({
      existingRow: { accepted_funding_types: ["direct_payment", "package"] },
    });

    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      publiclyDiscoverable: "on",
      membershipEnabled: "on",
      // packageEnabled intentionally omitted -- turning it off.
    });

    const error = await run(updateGroupClassEnrollmentPolicyAction(formData));

    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0].payload as { accepted_funding_types: string[] };
    expect(payload.accepted_funding_types).toContain("direct_payment");
    expect(payload.accepted_funding_types).toContain("membership");
    expect(payload.accepted_funding_types).not.toContain("package");
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

  it("rejects (no DB write) when either toggle is on and the resulting merged array would be empty", async () => {
    const { supabase, insertCalls, updateCalls } = makeFakeSupabase({ existingRow: null });

    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      selfEnrollmentAllowed: "on",
      // no package/membership checkbox, no pre-existing row to preserve.
    });

    const error = await run(updateGroupClassEnrollmentPolicyAction(formData));

    expect(insertCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(redirectUrl(error)).toContain("error=policy_requires_funding_type");
  });

  it("allows publiclyDiscoverable=true / selfEnrollmentAllowed=false with only a pre-existing unmanaged value and no checkboxes checked", async () => {
    const { supabase, updateCalls } = makeFakeSupabase({
      existingRow: { accepted_funding_types: ["manual_other"] },
    });

    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      publiclyDiscoverable: "on",
      // selfEnrollmentAllowed omitted (false); package/membership omitted.
    });

    const error = await run(updateGroupClassEnrollmentPolicyAction(formData));

    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0].payload as {
      publicly_discoverable: boolean;
      self_enrollment_allowed: boolean;
      accepted_funding_types: string[];
    };
    expect(payload.publicly_discoverable).toBe(true);
    expect(payload.self_enrollment_allowed).toBe(false);
    expect(payload.accepted_funding_types).toEqual(["manual_other"]);
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

  // B2 fix (second code review): AppointmentEditForm.tsx previously hid the
  // Package/Membership checkboxes from the DOM entirely whenever both
  // publiclyDiscoverable and selfEnrollmentAllowed were off, so native
  // FormData submitted no packageEnabled/membershipEnabled field at all --
  // silently stripping those values on save even though the staff member
  // only intended to pause discoverability/self-enrollment. The fix keeps
  // hidden <input>s carrying the current managed values through in that
  // case, so the form now ALWAYS submits packageEnabled/membershipEnabled
  // reflecting the true prior state regardless of visibility. This test
  // proves the action side of that contract: given a submission shaped
  // exactly like the fixed form's own hidden-input fallback (package/
  // membership still "on" even though both toggles are off), the resulting
  // accepted_funding_types is unchanged -- policy information is never
  // silently erased by a disable-and-save.
  it("preserves existing Package/Membership selections when both toggles are turned off (fixed hidden-input submission)", async () => {
    const { supabase, updateCalls } = makeFakeSupabase({
      existingRow: { accepted_funding_types: ["package", "membership"] },
    });

    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      // publiclyDiscoverable/selfEnrollmentAllowed both omitted (off).
      // packageEnabled/membershipEnabled ARE submitted -- exactly what the
      // fixed form's hidden inputs now guarantee even while the visible
      // section is hidden.
      packageEnabled: "on",
      membershipEnabled: "on",
    });

    const error = await run(updateGroupClassEnrollmentPolicyAction(formData));

    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0].payload as {
      publicly_discoverable: boolean;
      self_enrollment_allowed: boolean;
      accepted_funding_types: string[];
    };
    expect(payload.publicly_discoverable).toBe(false);
    expect(payload.self_enrollment_allowed).toBe(false);
    expect(payload.accepted_funding_types).toEqual(
      expect.arrayContaining(["package", "membership"]),
    );
    expect(payload.accepted_funding_types).toHaveLength(2);
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

  it("both toggles off with no funding types at all -- allowed, writes null accepted_funding_types", async () => {
    const { supabase, insertCalls } = makeFakeSupabase({ existingRow: null });

    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
    });

    const formData = formDataFor({ appointmentId: APPOINTMENT_ID });

    const error = await run(updateGroupClassEnrollmentPolicyAction(formData));

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].payload).toMatchObject({
      publicly_discoverable: false,
      self_enrollment_allowed: false,
      accepted_funding_types: null,
    });
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });
});
