import { canViewStudioSchedule } from "@/lib/auth/permissions";
import {
  requireStaffApi,
  staffApiError,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import { localDateInTimeZone, localDayUtcRange, resolveStudioTimeZone } from "@/lib/staff/instructorToday";
import { loadPulseCards } from "@/lib/staff/pulseCards";
import { loadPulse } from "@/lib/staff/studioPulse";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ studioId: string }> },
) {
  const { studioId } = await params;
  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return guard.response;

  if (!canViewStudioSchedule(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot view the studio summary.", 403);
  }

  const now = new Date();
  const timeZone = resolveStudioTimeZone(guard.studioTimeZone);
  const date = localDateInTimeZone(now, timeZone);
  const range = localDayUtcRange(date, timeZone);
  if (!range) return staffApiError("service_unavailable", "The studio summary is unavailable.", 503);

  try {
    const pulse = await loadPulse({
      supabase: guard.supabase,
      studioId: guard.studioId,
      userId: guard.user.id,
      studioRole: guard.studioRole,
      timeZone,
      date,
      range,
      now,
    });
    // v1 stays byte-identical unless the caller asks for the cards (`?include=cards`); each card fails and hides on its own.
    const wantsCards = new URL(request.url).searchParams.get("include") === "cards";
    if (!wantsCards) return staffApiJson(pulse);
    const cards = await loadPulseCards({
      supabase: guard.supabase,
      studioId: guard.studioId,
      userId: guard.user.id,
      studioRole: guard.studioRole,
      now,
      today: pulse.today,
    });
    return staffApiJson({ ...pulse, cards });
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
