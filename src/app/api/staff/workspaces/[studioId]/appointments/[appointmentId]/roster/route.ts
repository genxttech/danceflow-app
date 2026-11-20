import { NextResponse } from "next/server";
import { canEditAppointments } from "@/lib/auth/permissions";
import { normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { staffApiError, staffApiJson, staffApiUnavailable } from "@/lib/auth/staffApiAuth";
import { requireStaffWrite } from "@/lib/staff/writeGuard";
import { readIdempotencyKey, readJsonBody, staffConflict, staffWriteError } from "@/lib/staff/writeSupport";
import { enrollClassAttendee } from "@/lib/staff/classRoster";

const BILLING_TYPES = ["package_credit", "membership", "pay_as_you_go", "free_comped"];

// Funding and capacity refusals the enroll RPC raises, as the app shows them. Wording is the app's; the codes are stable (Staff_API_Contract.md).
const CONFLICTS: Record<string, string> = {
  class_full: "This class has no available seats.",
  class_cancelled: "This class has been cancelled and can't take new students.",
  no_eligible_entitlement: "This dancer has no package or membership that covers a group class.",
  entitlement_exhausted: "The dancer's package or membership has no allowance remaining.",
  membership_not_active: "That membership is not active for this dancer.",
  // For an instructor this also means "not exactly one eligible package or membership": the database ignores an instructor's billing choice and asks front desk to complete it.
  ambiguous_funding_source: "This enrollment needs a billing decision. Ask an owner, admin or front desk to complete it.",
};

// Drop-in enroll (Phase 1A S2): src/lib/staff/classRoster.ts calls the enroll_class_attendee RPC, which owns capacity, duplicates and funding. Pattern 3 (natural domain key).
export async function POST(request: Request, { params }: { params: Promise<{ studioId: string; appointmentId: string }> }) {
  const { studioId, appointmentId } = await params;
  const guard = await requireStaffWrite(request, studioId, "classRoster");
  if (!guard.ok) return guard.response;

  if (!canEditAppointments(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot change a class roster.", 403);
  }

  const classId = normalizeStudentApiUuid(appointmentId);
  if (!classId) return staffApiError("invalid_request", "A valid class id is required.", 400);

  const key = readIdempotencyKey(request);
  if (!key.ok) return key.response;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { clientId, billingType, clientPackageId, clientMembershipId } = parsed.body;

  const uuid = (value: unknown) => (typeof value === "string" ? normalizeStudentApiUuid(value)?.toLowerCase() ?? null : null);
  const client = uuid(clientId);
  if (!client) return staffApiError("invalid_request", "clientId must be a client id.", 400);
  if (billingType !== undefined && billingType !== null && (typeof billingType !== "string" || !BILLING_TYPES.includes(billingType))) {
    return staffApiError("invalid_request", "billingType must be package_credit, membership, pay_as_you_go or free_comped.", 400);
  }
  for (const [name, value] of [["clientPackageId", clientPackageId], ["clientMembershipId", clientMembershipId]] as const) {
    if (value !== undefined && value !== null && !uuid(value)) return staffApiError("invalid_request", `${name} must be an id.`, 400);
  }

  try {
    const result = await enrollClassAttendee({
      supabase: guard.supabase,
      studioId: guard.studioId,
      appointmentId: classId.toLowerCase(),
      clientId: client,
      billingType: (billingType as string | null | undefined) ?? null,
      clientPackageId: uuid(clientPackageId),
      clientMembershipId: uuid(clientMembershipId),
      treatAlreadyEnrolledAsSuccess: true,
    });

    if (result.ok) {
      const attendee = { id: result.attendeeId, clientId: client, alreadyEnrolled: result.alreadyEnrolled };
      const ok = staffApiJson({ attendee });
      return result.alreadyEnrolled ? ok : NextResponse.json({ attendee }, { status: 201, headers: ok.headers });
    }

    const { reason } = result;
    if (reason === "not_found" || reason === "enrollment_not_authorized") {
      // A class that is missing, in another studio, or not the caller's (an instructor's colleague's class) is indistinguishable.
      return staffApiError("not_found", "Class not found.", 404);
    }
    if (reason === "membership_requires_selection") {
      return staffWriteError("invalid_request", "A membership billing type needs clientMembershipId.", 400);
    }
    if (reason === "invalid_funding") {
      return staffConflict("invalid_funding", "That package or membership isn't an active one of this dancer's.", null);
    }
    if (reason === "already_enrolled") {
      return staffConflict("already_enrolled", "That dancer is already enrolled in this class.", null);
    }
    if (CONFLICTS[reason]) return staffConflict(reason, CONFLICTS[reason], null);
    throw new Error(`Enroll failed: ${reason}`);
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
