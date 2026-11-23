import { createAdminClient } from "@/lib/supabase/admin";
import { handleFeedRequest, unavailable } from "@/lib/calendar-feeds/handler";

export const dynamic = "force-dynamic";

/**
 * Private calendar subscription feed (dark): GET /calendar/feed/<secret>.ics
 * Off unless CALENDAR_FEEDS_ENABLED=true AND the token's studio is enabled in calendar_feed_settings.
 * All logic lives in src/lib/calendar-feeds/handler.ts.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const now = () => new Date();
  if (process.env.CALENDAR_FEEDS_ENABLED !== "true") {
    return handleFeedRequest(request, token, { admin: null as never, now, enabled: false });
  }
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return unavailable(503, 60);
  }
  return handleFeedRequest(request, token, { admin, now, enabled: true });
}
