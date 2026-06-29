import { NextResponse } from "next/server";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import {
  loadStudentSelfServiceSlots,
  type SupabaseQueryClient,
} from "@/lib/booking/selfServiceQueries";
import { createAdminClient } from "@/lib/supabase/admin";

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

  try {
    const result = await loadStudentSelfServiceSlots({
      supabase: createAdminClient() as unknown as SupabaseQueryClient,
      studioSlug,
      portalUserId: user.id,
      lessonType: url.searchParams.get("lessonType")?.trim() || "private_lesson",
      instructorId: url.searchParams.get("instructorId")?.trim() || null,
      roomId: url.searchParams.get("roomId")?.trim() || null,
      action:
        url.searchParams.get("action") === "reschedule"
          ? "reschedule"
          : "book",
    });

    return NextResponse.json({
      studio: result.studio,
      bookingDecision: result.bookingDecision,
      eligibility: result.eligibility,
      instructors: result.instructors,
      slots: result.slots,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not load self-service booking slots.",
      },
      { status: 400 }
    );
  }
}
