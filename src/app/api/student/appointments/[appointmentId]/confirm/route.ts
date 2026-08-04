import { NextResponse } from "next/server";
import { getStudentApiUser, normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { confirmOwnedAppointment } from "@/lib/schedule/appointmentConfirmation";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const rateLimit = checkRateLimit(
    rateLimitKey("student:appointment-confirm", getIpFromRequest(request)),
    { limit: 10, windowMs: 10 * 60 * 1000 },
  );
  if (!rateLimit.allowed) return rateLimitedJson(rateLimit);

  const user = await getStudentApiUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const appointmentId = normalizeStudentApiUuid((await params).appointmentId);
  if (!appointmentId) {
    return NextResponse.json({ error: "Invalid appointment." }, { status: 400 });
  }

  try {
    const result = await confirmOwnedAppointment({
      supabase: createAdminClient(),
      userId: user.id,
      appointmentId,
      source: "student_mobile",
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Confirmation failed." },
      { status: 400 },
    );
  }
}
