import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileStudioMembershipPeriods } from "@/lib/memberships/renewal";

export const runtime = "nodejs";

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const authorization = request.headers.get("authorization") ?? "";
  return authorization === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: studios, error } = await supabase
    .from("client_memberships")
    .select("studio_id")
    .eq("auto_renew", true)
    .eq("cancel_at_period_end", false)
    .in("status", ["active", "past_due", "unpaid"]);

  if (error) {
    return NextResponse.json(
      { error: `Could not load membership studios: ${error.message}` },
      { status: 500 },
    );
  }

  const studioIds = Array.from(
    new Set(
      (studios ?? [])
        .map((row) => row.studio_id as string | null)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const results = [];
  for (const studioId of studioIds) {
    try {
      const result = await reconcileStudioMembershipPeriods({
        supabase,
        studioId,
      });
      results.push({ studioId, ...result });
    } catch (error) {
      results.push({
        studioId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    studiosChecked: studioIds.length,
    results,
  });
}
