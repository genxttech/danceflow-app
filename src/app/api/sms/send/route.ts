import { NextResponse } from "next/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveStudioSmsSender } from "@/lib/sms/studioSender";
import {
  appendSmsOptOutFooter,
  effectiveSmsConsentTip,
  getSmsPlatformReadiness,
  normalizeSmsPhone,
  resolveEffectiveSmsConsent,
  sanitizedSmsProviderError,
} from "@/lib/sms/compliance";
import { estimateSmsSegments, sendTwilioSms } from "@/lib/sms/twilio";
import { BILLED_REFUSAL_MESSAGE, replayMeaning, sendBilledSms, smsUsageBillingEnabled, type BilledSendRefusal } from "@/lib/sms/usageBilling";
import { billedSmsProviderFromEnv } from "@/lib/sms/usageProvider";
import { cleanTextValue, normalizeOptionalUuid } from "@/lib/validation/forms";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UNCERTAIN_MESSAGE = "We could not confirm whether this text was sent. Do not send it again: it is checked automatically, and you are charged only if it went out.";

const REFUSAL_STATUS: Record<BilledSendRefusal, number> = {
  insufficient_credit: 402,
  monthly_limit: 402,
  no_billed_sender: 503,
  suspended: 503,
  switched_off: 503,
  paused: 503,
  no_price: 503,
  not_billed: 503,
  invalid: 400,
  forbidden: 403,
  unavailable: 503,
};

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
      | { clientId?: string; body?: string; idempotencyKey?: string }
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

    // TW-2: any opt-out for this studio + phone wins over the client's own row, including a
    // STOP received before this phone belonged to a client (studio+phone-level row).
    const { data: optOuts, error: optOutError } = await supabase
      .from("sms_contact_permissions")
      .select("consent_status, opted_out_source")
      .eq("studio_id", studioId)
      .eq("phone_e164", phoneE164)
      .eq("consent_status", "opted_out");

    if (optOutError) {
      console.error("SMS opt-out lookup failed", optOutError.code ?? "unknown");

      return NextResponse.json(
        { ok: false, error: "SMS consent could not be verified." },
        { status: 500 },
      );
    }

    const consentState = resolveEffectiveSmsConsent(permission, optOuts);

    if (consentState !== "allowed") {
      const error =
        consentState === "blocked_by_text_stop"
          ? effectiveSmsConsentTip(consentState)
          : consentState === "opted_out"
            ? "This number has opted out of texts from your studio."
            : "This client must be opted in before you send a text.";

      return NextResponse.json({ ok: false, error }, { status: 400 });
    }

    // SMS-A2P-2: send only through this studio's own approved registration. The
    // registration table is platform-admin-only under RLS, so it is read server-side.
    const senderResult = await resolveStudioSmsSender(createAdminClient(), studioId);

    if (!senderResult.ok) {
      if (senderResult.reason === "sms_billed_studio") {
        return sendBilled({
          request,
          studioId,
          studioName: studio.name,
          clientId,
          phoneE164,
          requestedBody,
          sentBy: context.userId ?? null,
          idempotencyKey: typeof payload?.idempotencyKey === "string" ? payload.idempotencyKey : "",
        });
      }

      if (
        senderResult.reason === "sms_registration_lookup_failed" ||
        senderResult.reason === "sms_service_check_failed" ||
        senderResult.reason === "sms_billing_check_failed"
      ) {
        return NextResponse.json(
          { ok: false, error: "Text messaging could not be verified. Please try again." },
          { status: 500 },
        );
      }

      if (senderResult.reason === "sms_service_suspended") {
        return NextResponse.json(
          { ok: false, error: "Texting is paused because a monthly charge was not covered. Add credit or contact DanceFlow support; replies like STOP and HELP still work for your contacts." },
          { status: 503 },
        );
      }

      return NextResponse.json(
        {
          ok: false,
          error:
            senderResult.reason === "sms_not_approved"
              ? getSmsPlatformReadiness().studioMessage
              : "Text messaging is not set up for your studio yet. Contact DanceFlow support to finish carrier registration.",
        },
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
      messagingServiceSid: senderResult.sender.messagingServiceSid,
      statusCallbackUrl: callbackUrl,
    });

    if (!sendResult.ok) {
      await supabase
        .from("sms_message_logs")
        .update({
          status: "failed",
          provider_error_code: sendResult.errorCode ?? null,
          provider_error_message: sanitizedSmsProviderError(sendResult.errorCode),
          failed_at: new Date().toISOString(),
        })
        .eq("id", logRow.id)
        .eq("studio_id", studioId);

      // Code only: raw Twilio text can echo request values such as the callback URL.
      console.error("Twilio SMS send failed", sendResult.errorCode ?? "unknown");

      return NextResponse.json(
        { ok: false, error: "The text could not be sent. Please try again." },
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

/**
 * TW-4F: a studio of a verified legal business texts only through the billed path: its own subaccount, after a prepaid-credit reservation made by the
 * database (which also writes the log row). The manual send's idempotency key is the source: pressing Send again for the same message is a replay, never
 * a second text. An uncertain provider answer is reported as such and must not be resent.
 */
async function sendBilled(input: {
  request: Request;
  studioId: string;
  studioName: string | null;
  clientId: string;
  phoneE164: string;
  requestedBody: string;
  sentBy: string | null;
  idempotencyKey: string;
}) {
  if (!smsUsageBillingEnabled()) {
    return NextResponse.json({ ok: false, error: BILLED_REFUSAL_MESSAGE.switched_off }, { status: 503 });
  }
  if (!UUID.test(input.idempotencyKey)) {
    return NextResponse.json({ ok: false, error: "Refresh the page and send the text again." }, { status: 400 });
  }
  const provider = billedSmsProviderFromEnv();
  if (!provider) {
    return NextResponse.json({ ok: false, error: BILLED_REFUSAL_MESSAGE.switched_off }, { status: 503 });
  }

  const callbackSecret = String(process.env.TWILIO_STATUS_CALLBACK_SECRET ?? "").trim();
  const statusCallbackBase = callbackSecret
    ? `${new URL(input.request.url).origin}/api/sms/twilio/status?secret=${encodeURIComponent(callbackSecret)}`
    : null;

  const result = await sendBilledSms(createAdminClient(), provider, {
    source: { kind: "manual", id: input.idempotencyKey.toLowerCase() },
    studioId: input.studioId,
    clientId: input.clientId,
    phoneE164: input.phoneE164,
    body: appendSmsOptOutFooter(input.requestedBody, input.studioName),
    messageType: "manual",
    relatedTable: "clients",
    relatedId: input.clientId,
    sentBy: input.sentBy,
    statusCallbackBase,
  });

  switch (result.outcome) {
    case "sent":
      return NextResponse.json({ ok: true, message: "Text queued for sending.", id: result.logId });
    case "replay": {
      const meaning = replayMeaning(result.state);
      if (meaning === "accepted") return NextResponse.json({ ok: true, message: "This text was already sent.", id: result.logId });
      if (meaning === "not_sent" || meaning === "not_yet") {
        return NextResponse.json({ ok: false, error: "This text was not sent. Edit the message to send it as a new text." }, { status: 409 });
      }
      return NextResponse.json({ ok: false, uncertain: true, error: UNCERTAIN_MESSAGE, id: result.logId }, { status: 202 });
    }
    case "uncertain":
      console.error("Billed SMS outcome uncertain");
      return NextResponse.json({ ok: false, uncertain: true, error: UNCERTAIN_MESSAGE, id: result.logId }, { status: 202 });
    case "rejected":
      // Code only: never the provider's text.
      console.error("Billed SMS refused by the provider", result.code);
      return NextResponse.json({ ok: false, error: "The text could not be sent. Nothing was charged." }, { status: 502 });
    case "refused":
      return NextResponse.json({ ok: false, error: BILLED_REFUSAL_MESSAGE[result.reason] }, { status: REFUSAL_STATUS[result.reason] });
  }
}
