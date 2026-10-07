import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * GC-3.3: staff-side group-class enrollment policy authoring action.
 *
 * Drives the real updateGroupClassEnrollmentPolicyAction (not a stand-in)
 * from src/app/app/schedule/actions.ts, with requireAppointmentEditAccess
 * mocked -- mirroring the established groupClassActions.gc1_4a.test.ts
 * convention. Covers the merge-preserving upsert design from the
 * implementation plan (section 51, "revision pass" item 1): first-row
 * creation builds accepted_funding_types fresh from only the managed
 * checkboxes; an update preserves any pre-existing unmanaged value
 * (manual_other) untouched while only ever adding/removing the managed
 * values (package/membership, and since GC-3.5-1 direct_payment);
 * validation checks the RESULTING merged array, not "at least one checkbox
 * checked".
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
  // GC-3.5-1: the studio that owns the class (defaults to the session's
  // studio). The action resolves ownership server-side via appointments.
  appointmentStudioId?: string;
}) {
  const insertCalls: Array<{ table: string; payload: unknown }> = [];
  const updateCalls: Array<{ table: string; payload: unknown; filters: Record<string, unknown> }> = [];
  const rpcCalls: string[] = [];
  const appointmentStudioId = params.appointmentStudioId ?? STUDIO_ID;

  const supabase = {
    rpc(name: string) {
      rpcCalls.push(name);
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return chain;
      };
      chain.maybeSingle = () => {
        if (table === "appointments") {
          const owned =
            filters.id === APPOINTMENT_ID && filters.studio_id === appointmentStudioId;
          return Promise.resolve({ data: owned ? { id: APPOINTMENT_ID } : null, error: null });
        }
        return Promise.resolve({ data: params.existingRow ?? null, error: null });
      };
      chain.insert = (payload: unknown) => {
        insertCalls.push({ table, payload });
        return Promise.resolve({ error: null });
      };
      chain.update = (payload: unknown) => {
        const updateFilters: Record<string, unknown> = {};
        updateCalls.push({ table, payload, filters: updateFilters });
        const builder = {
          eq(column: string, value: unknown) {
            updateFilters[column] = value;
            return builder;
          },
          then(resolve: (value: { error: null }) => unknown) {
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return builder;
      };
      return chain;
    },
  };

  return { supabase, insertCalls, updateCalls, rpcCalls };
}

beforeEach(() => {
  requireAppointmentEditAccessMock.mockReset();
});

describe("updateGroupClassEnrollmentPolicyAction", () => {
  it("GC-S1D-3: the single-class save never invokes a series RPC and ignores the series scope control", async () => {
    const { supabase, updateCalls, rpcCalls } = makeFakeSupabase({
      existingRow: { accepted_funding_types: ["direct_payment", "manual_other", "package"] },
    });
    requireAppointmentEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID, user: { id: USER_ID } });

    const error = await run(
      updateGroupClassEnrollmentPolicyAction(
        formDataFor({
          appointmentId: APPOINTMENT_ID,
          publiclyDiscoverable: "on",
          selfEnrollmentAllowed: "on",
          packageEnabled: "on",
          membershipEnabled: "on",
          directPaymentEnabled: "on",
          directPaymentAmount: "30",
          settingsScope: "series",
        }),
      ),
    );

    expect(rpcCalls).toEqual([]);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload).toMatchObject({
      publicly_discoverable: true,
      self_enrollment_allowed: true,
      accepted_funding_types: ["manual_other", "package", "membership", "direct_payment"],
      direct_payment_amount: 30,
    });
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

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

  it("update path: preserves a pre-existing unmanaged value (manual_other) while swapping package for membership", async () => {
    const { supabase, updateCalls } = makeFakeSupabase({
      existingRow: { accepted_funding_types: ["manual_other", "package"] },
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
    expect(payload.accepted_funding_types).toContain("manual_other");
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

describe("GC-3.5-1: staff direct-payment policy configuration", () => {
  function staffSession(supabase: unknown) {
    requireAppointmentEditAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID, user: { id: USER_ID } });
  }

  async function saveWith(
    fields: Record<string, string>,
    existingRow: { accepted_funding_types: string[] | null } | null = null,
  ) {
    const fake = makeFakeSupabase({ existingRow });
    staffSession(fake.supabase);
    const error = await run(
      updateGroupClassEnrollmentPolicyAction(formDataFor({ appointmentId: APPOINTMENT_ID, ...fields })),
    );
    const write = fake.insertCalls[0] ?? fake.updateCalls[0];
    return { ...fake, error, payload: write?.payload as Record<string, unknown> | undefined };
  }

  it("saves a valid direct-payment price (first row) with direct_payment accepted", async () => {
    const { payload, insertCalls, error } = await saveWith({
      publiclyDiscoverable: "on",
      directPaymentEnabled: "on",
      directPaymentAmount: "25",
    });
    expect(insertCalls).toHaveLength(1);
    expect(payload).toMatchObject({
      studio_id: STUDIO_ID,
      accepted_funding_types: ["direct_payment"],
      direct_payment_amount: 25,
    });
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

  it.each([
    ["25.5", 25.5],
    ["$25.50", 25.5],
    [" 40.05 ", 40.05],
    ["0.01", 0.01],
    ["100000", 100000],
  ])("normalizes %j to the dollar amount %s", async (input, expected) => {
    const { payload, error } = await saveWith({ directPaymentEnabled: "on", directPaymentAmount: input });
    expect(payload?.direct_payment_amount).toBe(expected);
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

  it.each([
    ["missing", undefined, "direct_payment_amount_required"],
    ["blank", "   ", "direct_payment_amount_required"],
    ["zero", "0", "direct_payment_amount_invalid"],
    ["zero with decimals", "0.00", "direct_payment_amount_invalid"],
    ["negative", "-5", "direct_payment_amount_invalid"],
    ["malformed", "abc", "direct_payment_amount_invalid"],
    ["malformed (comma)", "1,000", "direct_payment_amount_invalid"],
    ["malformed (exponent)", "1e3", "direct_payment_amount_invalid"],
    ["non-finite", "Infinity", "direct_payment_amount_invalid"],
    ["more than 2 decimals", "10.999", "direct_payment_amount_invalid"],
    ["above the DanceFlow limit", "100000.01", "direct_payment_amount_invalid"],
  ])("rejects a %s price without writing", async (_label, amount, code) => {
    const fields: Record<string, string> = { publiclyDiscoverable: "on", directPaymentEnabled: "on", packageEnabled: "on" };
    if (amount !== undefined) fields.directPaymentAmount = amount;
    const { insertCalls, updateCalls, error } = await saveWith(fields, { accepted_funding_types: ["package"] });
    expect(insertCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(redirectUrl(error)).toContain(`error=${code}`);
  });

  it("rejects an unauthorized user before any read or write", async () => {
    const fake = makeFakeSupabase({ existingRow: null });
    requireAppointmentEditAccessMock.mockRejectedValue(new Error("You do not have permission to edit appointments."));
    const error = await run(
      updateGroupClassEnrollmentPolicyAction(
        formDataFor({ appointmentId: APPOINTMENT_ID, directPaymentEnabled: "on", directPaymentAmount: "25" }),
      ),
    );
    expect(fake.insertCalls).toHaveLength(0);
    expect(fake.updateCalls).toHaveLength(0);
    expect(redirectUrl(error)).toContain("error=policy_save_failed");
  });

  it("rejects modifying another studio's class (studio comes from the session, never the form)", async () => {
    const fake = makeFakeSupabase({ existingRow: null, appointmentStudioId: "studio-2" });
    staffSession(fake.supabase);
    const error = await run(
      updateGroupClassEnrollmentPolicyAction(
        formDataFor({
          appointmentId: APPOINTMENT_ID,
          studioId: "studio-2",
          directPaymentEnabled: "on",
          directPaymentAmount: "25",
        }),
      ),
    );
    expect(fake.insertCalls).toHaveLength(0);
    expect(fake.updateCalls).toHaveLength(0);
    expect(redirectUrl(error)).toContain("error=policy_save_failed");
  });

  it("scopes the update to the session studio and the class", async () => {
    const { updateCalls } = await saveWith(
      { directPaymentEnabled: "on", directPaymentAmount: "25" },
      { accepted_funding_types: ["package"] },
    );
    expect(updateCalls[0].filters).toEqual({ appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID });
  });

  it.each([
    ["Package + direct payment", { packageEnabled: "on" }, ["package", "direct_payment"]],
    ["Membership + direct payment", { membershipEnabled: "on" }, ["membership", "direct_payment"]],
    [
      "Package + membership + direct payment",
      { packageEnabled: "on", membershipEnabled: "on" },
      ["package", "membership", "direct_payment"],
    ],
  ])("saves %s", async (_label, managed, expected) => {
    const { payload, error } = await saveWith({
      publiclyDiscoverable: "on",
      selfEnrollmentAllowed: "on",
      ...managed,
      directPaymentEnabled: "on",
      directPaymentAmount: "18.75",
    });
    expect(payload?.accepted_funding_types).toEqual(expected);
    expect(payload?.direct_payment_amount).toBe(18.75);
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

  it("disabling direct payment removes it from accepted methods and clears the price (stale posted price ignored)", async () => {
    const { updateCalls, payload, error } = await saveWith(
      { publiclyDiscoverable: "on", packageEnabled: "on", directPaymentAmount: "25.00" },
      { accepted_funding_types: ["package", "direct_payment", "manual_other"] },
    );
    expect(updateCalls).toHaveLength(1);
    expect(payload?.accepted_funding_types).toEqual(["manual_other", "package"]);
    expect(payload?.accepted_funding_types).not.toContain("direct_payment");
    expect(payload).toHaveProperty("direct_payment_amount", null);
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

  it("disabling direct payment when it was the only method still requires another method while visible", async () => {
    const { insertCalls, updateCalls, error } = await saveWith(
      { publiclyDiscoverable: "on" },
      { accepted_funding_types: ["direct_payment"] },
    );
    expect(insertCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(redirectUrl(error)).toContain("error=policy_requires_funding_type");
  });

  it("direct payment alone satisfies the discoverable/self-enroll funding requirement", async () => {
    const { payload, error } = await saveWith({
      publiclyDiscoverable: "on",
      selfEnrollmentAllowed: "on",
      directPaymentEnabled: "on",
      directPaymentAmount: "12",
    });
    expect(payload?.accepted_funding_types).toEqual(["direct_payment"]);
    expect(redirectUrl(error)).toContain("success=policy_saved");
  });

  it("never writes a $0 direct payment for a class that accepts no direct payment (free stays null)", async () => {
    const { payload } = await saveWith({ packageEnabled: "on", directPaymentAmount: "0" });
    expect(payload?.accepted_funding_types).toEqual(["package"]);
    expect(payload?.direct_payment_amount).toBeNull();
  });
});
