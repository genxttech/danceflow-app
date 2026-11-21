import { canViewStudioSchedule } from "@/lib/auth/permissions";
import {
  requireStaffApi,
  staffApiError,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import {
  loadInstructorDay,
  localDateInTimeZone,
  localDayUtcRange,
  resolveStudioTimeZone,
} from "@/lib/staff/instructorToday";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ studioId: string }> },
) {
  const { studioId } = await params;
  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return guard.response;

  if (!canViewStudioSchedule(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot view this schedule.", 403);
  }

  const url = new URL(request.url);
  const timeZone = resolveStudioTimeZone(guard.studioTimeZone);
  const date = url.searchParams.get("date") ?? localDateInTimeZone(new Date(), timeZone);
  const range = localDayUtcRange(date, timeZone);

  if (!range) {
    return staffApiError("invalid_request", "date must be a real date in YYYY-MM-DD form.", 400);
  }

  try {
    return staffApiJson(
      await loadInstructorDay({
        supabase: guard.supabase,
        studioId: guard.studioId,
        userId: guard.user.id,
        date,
        timeZone,
        range,
      }),
    );
  } catch (failure) {
    return staffApiUnavailable(url.pathname, failure);
  }
}
