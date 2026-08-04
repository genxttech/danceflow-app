import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { confirmAppointmentByToken } from "@/lib/schedule/appointmentConfirmation";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const rateLimit = checkRateLimit(
    rateLimitKey("appointment:public-confirm", getIpFromRequest(request)),
    { limit: 10, windowMs: 10 * 60 * 1000 },
  );
  if (!rateLimit.allowed) return rateLimitedJson(rateLimit);

  const token = (await params).token?.trim();
  if (!token || token.length < 32 || token.length > 200) {
    return NextResponse.json({ error: "Invalid confirmation link." }, { status: 400 });
  }

  try {
    const result = await confirmAppointmentByToken({
      supabase: createAdminClient(),
      token,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Confirmation failed." },
      { status: 400 },
    );
  }
}
