import { NextResponse } from "next/server";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import {
  loadStudentSelfServiceSlots,
  type SupabaseQueryClient,
} from "@/lib/booking/selfServiceQueries";
import { createAdminClient } from "@/lib/supabase/admin";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const LESSON_TYPES = [
  "private_lesson",
  "group_class",
  "coaching",
  "floor_rental",
] as const;

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

function normalizeOptionalUuid(value: string | null | undefined) {
  const id = cleanInput(value, 36);
  return id && UUID_PATTERN.test(id) ? id : null;
}

function normalizeLessonType(value: string | null | undefined) {
  const type = cleanInput(value, 80);
  return LESSON_TYPES.includes(type as (typeof LESSON_TYPES)[number])
    ? type
    : "private_lesson";
}

export async function GET(request: Request) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const url = new URL(request.url);
  const studioSlug = normalizeSlug(url.searchParams.get("studioSlug"));

  if (!studioSlug) {
    return NextResponse.json({ error: "studioSlug is required." }, { status: 400 });
  }

  try {
    const result = await loadStudentSelfServiceSlots({
      supabase: createAdminClient() as unknown as SupabaseQueryClient,
      studioSlug,
      portalUserId: user.id,
      lessonType: normalizeLessonType(url.searchParams.get("lessonType")),
      instructorId: normalizeOptionalUuid(url.searchParams.get("instructorId")),
      roomId: normalizeOptionalUuid(url.searchParams.get("roomId")),
      action:
        cleanInput(url.searchParams.get("action"), 20) === "reschedule"
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
    console.error("Self-service slot request failed", {
      studioSlug,
      message:
        error instanceof Error
          ? error.message
          : "Could not load self-service booking slots.",
    });

    return NextResponse.json(
      { error: "Lesson times could not be loaded. Please try again." },
      { status: 400 },
    );
  }
}