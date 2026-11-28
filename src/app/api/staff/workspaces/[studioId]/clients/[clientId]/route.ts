import { normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import {
  requireStaffApi,
  staffApiError,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import { clientLookupScope, loadClientSummary } from "@/lib/staff/clients";
import { resolveStudioTimeZone } from "@/lib/staff/instructorToday";

export async function GET(request: Request, { params }: { params: Promise<{ studioId: string; clientId: string }> }) {
  const { studioId, clientId } = await params;
  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return guard.response;

  const scope = clientLookupScope(guard.studioRole);
  if (!scope) return staffApiError("role_not_permitted", "Your role cannot look up clients.", 403);

  const normalizedClientId = normalizeStudentApiUuid(clientId)?.toLowerCase();
  if (!normalizedClientId) return staffApiError("invalid_request", "A valid client id is required.", 400);

  try {
    const summary = await loadClientSummary({
      supabase: guard.supabase,
      studioId: guard.studioId,
      scope,
      userId: guard.user.id,
      clientId: normalizedClientId,
      timeZone: resolveStudioTimeZone(guard.studioTimeZone),
    });
    if (!summary) return staffApiError("not_found", "Client not found.", 404);
    return staffApiJson(summary);
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
