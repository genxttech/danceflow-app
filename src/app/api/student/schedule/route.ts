import { NextResponse } from "next/server";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import { createAdminClient } from "@/lib/supabase/admin";

type StudioRow = { id: string; slug: string; name: string | null; public_name: string | null };
type ClientRow = { id: string };


const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

function cleanInput(value: string | null | undefined, maxLength = 120) {
  return (value ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function normalizeSlug(value: string | null | undefined) {
  const slug = cleanInput(value, 80);
  return SLUG_PATTERN.test(slug) ? slug : "";
}


export async function GET(request: Request) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const url = new URL(request.url);
  const studioSlug = normalizeSlug(url.searchParams.get("studioSlug"));
  const requestedClientId = cleanInput(url.searchParams.get("clientId"), 36) || null;

  if (!studioSlug) {
    return NextResponse.json({ error: "studioSlug is required." }, { status: 400 });
  }

  const supabase = createAdminClient();

  try {
    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("id, slug, name, public_name")
      .eq("slug", studioSlug)
      .maybeSingle<StudioRow>();

    if (studioError || !studio) {
      throw new Error(studioError?.message ?? "Studio not found.");
    }

    let relationshipQuery = supabase
      .from("client_account_links")
      .select("client_id")
      .eq("user_id", user.id)
      .eq("studio_id", studio.id)
      .eq("status", "linked")
      .eq("can_view_schedule", true);

    if (requestedClientId) {
      relationshipQuery = relationshipQuery.eq("client_id", requestedClientId);
    }

    const { data: relationship, error: relationshipError } =
      await relationshipQuery
        .order("is_primary", { ascending: false })
        .limit(1)
        .maybeSingle<{ client_id: string }>();

    if (relationshipError || !relationship) {
      throw new Error(
        relationshipError?.message ?? "Linked student profile not found.",
      );
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id")
      .eq("studio_id", studio.id)
      .eq("id", relationship.client_id)
      .maybeSingle<ClientRow>();

    if (clientError || !client) {
      throw new Error(clientError?.message ?? "Linked student profile not found.");
    }

    const nowIso = new Date().toISOString();
    const { data: appointments, error: appointmentsError } = await supabase
      .from("appointments")
      .select(`
        id,
        title,
        appointment_type,
        status,
        starts_at,
        ends_at,
        instructor_id,
        room_id,
        instructors (
          first_name,
          last_name
        ),
        rooms (
          name
        )
      `)
      .eq("studio_id", studio.id)
      .eq("client_id", client.id)
      .gte("ends_at", nowIso)
      .in("status", ["scheduled", "rescheduled"])
      .order("starts_at", { ascending: true })
      .limit(20);

    if (appointmentsError) {
      throw new Error(appointmentsError.message);
    }

    const { data: settings } = await supabase
      .from("studio_settings")
      .select("timezone")
      .eq("studio_id", studio.id)
      .maybeSingle<{ timezone: string | null }>();

    return NextResponse.json({
      studio,
      clientId: client.id,
      timezone: settings?.timezone ?? "America/New_York",
      appointments: appointments ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not load schedule.",
      },
      { status: 400 }
    );
  }
}
