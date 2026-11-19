import {
  requireStaffApi,
  staffApiError,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import { localDateInTimeZone, localDayUtcRange, resolveStudioTimeZone } from "@/lib/staff/instructorToday";
import { canViewStudioWideSchedule, loadStudioDay } from "@/lib/staff/studioSchedule";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ studioId: string }> },
) {
  const { studioId } = await params;
  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return guard.response;

  // Before any appointment or client read: instructors, independent instructors and organizer roles are refused here.
  if (!canViewStudioWideSchedule(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot view the studio schedule.", 403);
  }

  const url = new URL(request.url);
  const timeZone = resolveStudioTimeZone(guard.studioTimeZone);
  const date = url.searchParams.get("date") ?? localDateInTimeZone(new Date(), timeZone);
  const range = localDayUtcRange(date, timeZone);

  if (!range) {
    return staffApiError("invalid_request", "date must be a real date in YYYY-MM-DD form.", 400);
  }

  try {
    return staffApiJson(await loadStudioDay({ supabase: guard.supabase, studioId: guard.studioId, date, timeZone, range }));
  } catch (failure) {
    return staffApiUnavailable(url.pathname, failure);
  }
}
