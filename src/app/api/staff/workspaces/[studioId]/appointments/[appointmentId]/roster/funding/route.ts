import { canEditClients } from "@/lib/auth/permissions";
import { normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { requireStaffApi, staffApiError, staffApiJson, staffApiUnavailable } from "@/lib/auth/staffApiAuth";
import { loadRosterFundingCandidates } from "@/lib/staff/rosterFunding";

// What a dancer can be billed to for this class (read only, not behind the write gate): src/lib/staff/rosterFunding.ts. Owner, admin and front desk only: the web
// never offers an instructor a funding choice, because the database decides an instructor's enrollment itself.
export async function GET(request: Request, { params }: { params: Promise<{ studioId: string; appointmentId: string }> }) {
  const { studioId, appointmentId } = await params;
  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return guard.response;

  if (!canEditClients(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot choose how a dancer pays.", 403);
  }

  const classId = normalizeStudentApiUuid(appointmentId);
  const clientId = normalizeStudentApiUuid(new URL(request.url).searchParams.get("clientId") ?? "");
  if (!classId || !clientId) return staffApiError("invalid_request", "Valid class and client ids are required.", 400);

  try {
    const result = await loadRosterFundingCandidates({
      supabase: guard.supabase,
      studioId: guard.studioId,
      appointmentId: classId.toLowerCase(),
      clientId: clientId.toLowerCase(),
    });
    if (!result.ok) return staffApiError("not_found", "Class or dancer not found.", 404);
    return staffApiJson({ candidates: result.candidates });
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
