import { NextResponse } from "next/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import {
  appendSmsOptOutFooter,
  canSendSms,
  getSmsPlatformReadiness,
  normalizeSmsPhone,
} from "@/lib/sms/compliance";
import { estimateSmsSegments, sendTwilioSms } from "@/lib/sms/twilio";
import { cleanTextValue, normalizeOptionalUuid } from "@/lib/validation/forms";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

function canSendClientSms(role: string | null | undefined) {
  return ["studio_owner", "studio_admin", "front_desk"].includes(
    String(role ?? "").toLowerCase(),
  );
}

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(
    rateLimitKey("sms:send", getIpFromRequest(request)),
    { limit: 10, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();

    const studioId = context.studioId;
    const studioRole = context.studioRole ?? "";

    if (!canSendClientSms(studioRole)) {
      return NextResponse.json(
        { ok: false, error: "You do not have permission to send text messages." },
        { status: 403 },
      );
    }

    const payload = (await request.json().catch(() => null)) as
      | { clientId?: string; body?: string }
      | null;

    const clientIdResult = normalizeOptionalUuid(
      typeof payload?.clientId === "string" ? payload.clientId : "",
      "Client"
    );
    const bodyResult = cleanTextValue(
      typeof payload?.body === "string" ? payload.body : "",
      {
        fieldLabel: "Text message",
        maxLength: 1200,
        required: true,
        allowNewlines: true,
      }
    );

    if (!clientIdResult.ok || !clientIdResult.value) {
      return NextResponse.json({ ok: false, error: "Client not found." }, { status: 400 });
    }

    if (!bodyResult.ok) {
      return NextResponse.json(
        { ok: false, error: bodyResult.error },
        { status: 400 },
      );
    }

    const clientId = clientIdResult.value;
    const requestedBody = bodyResult.value;

    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("id, name")
      .eq("id", studioId)
      .single();

    if (studioError || !studio) {
      return NextResponse.json({ ok: false, error: "Studio not found." }, { status: 404 });
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, studio_id, phone")
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .single();

    if (clientError || !client) {
      return NextResponse.json({ ok: false, error: "Client not found." }, { status: 404 });
    }

    const phoneE164 = normalizeSmsPhone(client.phone ?? "");

    if (!phoneE164) {
      return NextResponse.json(
        { ok: false, error: "Add a valid phone number before sending a text." },
        { status: 400 },
      );
    }

    const { data: permission, error: permissionError } = await supabase
      .from("sms_contact_permissions")
      .select("*")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .eq("phone_e164", phoneE164)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (permissionError) {
      console.error("SMS consent lookup failed", permissionError.message);

      return NextResponse.json(
        { ok: false, error: "SMS consent could not be verified." },
        { status: 500 },
      );
    }

    if (!canSendSms(permission as any)) {
      return NextResponse.json(
        { ok: false, error: "This client must be opted in before you send a text." },
        { status: 400 },
      );
    }

    const smsReadiness = getSmsPlatformReadiness();

    if (!smsReadiness.canSend) {
      return NextResponse.json(
        { ok: false, error: smsReadiness.studioMessage },
        { status: 503 },
      );
    }

    const finalBody = appendSmsOptOutFooter(requestedBody, studio.name);
    const segmentCount = Math.max(1, estimateSmsSegments(finalBody));

    const { data: logRow, error: logError } = await supabase
      .from("sms_message_logs")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        phone_e164: phoneE164,
        direction: "outbound",
        message_type: "manual",
        body: finalBody,
        segment_count: segmentCount,
        status: "queued",
        provider: "twilio",
        related_table: "clients",
        related_id: clientId,
        sent_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (logError || !logRow) {
      console.error("SMS log insert failed", logError?.message);

      return NextResponse.json(
        { ok: false, error: "The text could not be logged before sending." },
        { status: 500 },
      );
    }

    const callbackSecret = String(process.env.TWILIO_STATUS_CALLBACK_SECRET ?? "").trim();
    const callbackUrl = callbackSecret
      ? `${new URL(request.url).origin}/api/sms/twilio/status?secret=${encodeURIComponent(
          callbackSecret,
        )}`
      : null;

    const sendResult = await sendTwilioSms({
      to: phoneE164,
      body: finalBody,
      statusCallbackUrl: callbackUrl,
    });

    if (!sendResult.ok) {
      await supabase
        .from("sms_message_logs")
        .update({
          status: "failed",
          provider_error_code: sendResult.errorCode ?? null,
          provider_error_message: sendResult.error ?? "The text could not be sent.",
          failed_at: new Date().toISOString(),
        })
        .eq("id", logRow.id)
        .eq("studio_id", studioId);

      return NextResponse.json(
        { ok: false, error: sendResult.error ?? "The text could not be sent." },
        { status: 500 },
      );
    }

    const { error: updateError } = await supabase
      .from("sms_message_logs")
      .update({
        provider_message_id: sendResult.sid ?? null,
        status: sendResult.status === "sent" ? "sent" : "queued",
      })
      .eq("id", logRow.id)
      .eq("studio_id", studioId);

    if (updateError) {
      console.error("SMS provider ID update failed", updateError.message);
    }

    return NextResponse.json({
      ok: true,
      message: "Text queued for sending.",
      id: logRow.id,
    });
  } catch (error) {
    console.error("Unhandled SMS send route error", error);

    return NextResponse.json(
      {
        ok: false,
        error: "The text message could not be sent. Please try again.",
      },
      { status: 500 },
    );
  }
}