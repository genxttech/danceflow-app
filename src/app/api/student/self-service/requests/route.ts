import { NextResponse } from "next/server";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import { createAdminClient } from "@/lib/supabase/admin";

type StudioRow = { id: string; slug: string };
type ClientRow = { id: string };

export async function GET(request: Request) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const url = new URL(request.url);
  const studioSlug = url.searchParams.get("studioSlug")?.trim();

  if (!studioSlug) {
    return NextResponse.json({ error: "studioSlug is required." }, { status: 400 });
  }

  const supabase = createAdminClient();

  try {
    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("id, slug")
      .eq("slug", studioSlug)
      .maybeSingle<StudioRow>();

    if (studioError || !studio) {
      throw new Error(studioError?.message ?? "Studio not found.");
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id")
      .eq("studio_id", studio.id)
      .eq("portal_user_id", user.id)
      .maybeSingle<ClientRow>();

    if (clientError || !client) {
      throw new Error(clientError?.message ?? "Linked student profile not found.");
    }

    const { data: requests, error: requestsError } = await supabase
      .from("student_booking_action_requests")
      .select(`
        id,
        action_type,
        mode,
        status,
        lesson_type,
        requested_starts_at,
        requested_ends_at,
        previous_starts_at,
        previous_ends_at,
        reason,
        staff_note,
        failure_reason,
        created_at,
        decision_at,
        executed_at,
        instructors:instructor_id (
          first_name,
          last_name
        ),
        rooms:room_id (
          name
        )
      `)
      .eq("studio_id", studio.id)
      .eq("client_id", client.id)
      .order("created_at", { ascending: false })
      .limit(25);

    if (requestsError) throw new Error(requestsError.message);

    const { data: settings } = await supabase
      .from("studio_settings")
      .select("timezone")
      .eq("studio_id", studio.id)
      .maybeSingle<{ timezone: string | null }>();

    return NextResponse.json({
      timezone: settings?.timezone ?? "America/New_York",
      requests: requests ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not load self-service requests.",
      },
      { status: 400 }
    );
  }
}
