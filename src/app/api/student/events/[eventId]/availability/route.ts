import { NextRequest, NextResponse } from "next/server";
import { normalizeStudentApiUuid, requireStudentApiUser } from "@/lib/auth/studentApiAuth";
import { loadEventAvailability } from "@/lib/events/ticketAvailability";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

type Params = { params: Promise<{ eventId: string }> };

/**
 * GET /api/student/events/[eventId]/availability
 * Signed-in student session (bearer or cookie). Returns, for a published public/unlisted event only:
 *   { "eventId": "<uuid>", "tickets": [ { "ticketTypeId": "<uuid>", "capacity": <int|null>, "remaining": <int|null>, "soldOut": <bool> } ] }
 * sorted by ticketTypeId; counts are admissions (quantity x attendees_per_ticket), computed with the service role by the rule the capacity
 * trigger enforces. capacity/remaining are null for an unlimited ticket. No registration, attendee, order or email data is returned.
 * Unknown / unpublished / private events answer an identical 404. Cacheable per user for a few seconds.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireStudentApiUser(request);
  if (!auth.ok) return auth.response;

  const limit = checkRateLimit(rateLimitKey("availability:student-event", auth.user.id, getIpFromRequest(request)), { limit: 60, windowMs: 60 * 1000 });
  if (!limit.allowed) return rateLimitedJson(limit);

  const { eventId: rawEventId } = await params;
  const eventId = normalizeStudentApiUuid(rawEventId);
  if (!eventId) return NextResponse.json({ error: "This event is not available." }, { status: 404 });

  try {
    const availability = await loadEventAvailability(createAdminClient(), eventId);
    if (!availability) return NextResponse.json({ error: "This event is not available." }, { status: 404 });
    return NextResponse.json(availability, { headers: { "Cache-Control": "private, max-age=5" } });
  } catch (error) {
    console.error("student event availability failed", { eventId, message: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Availability could not be loaded." }, { status: 500 });
  }
}
