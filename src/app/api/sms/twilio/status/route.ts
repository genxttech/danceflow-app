import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sanitizedSmsProviderError } from "@/lib/sms/compliance";
import { mapTwilioStatusToSmsLogStatus } from "@/lib/sms/twilio";
import { twilioFormParams, verifyTwilioWebhook } from "@/lib/sms/twilioWebhook";
import { cleanTextValue } from "@/lib/validation/forms";
import { hasValidSecret } from "@/lib/security/cron";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) return null;

  return createSupabaseClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

// A2P-1A: only rejected requests count against the per-IP limiter, so legitimate
// delivery callbacks from shared Twilio egress IPs are never throttled.
function rejectUnverified(request: Request, status: 401 | 403 | 503) {
  const rateLimit = checkRateLimit(
    rateLimitKey("sms:twilio-status-rejected", getIpFromRequest(request)),
    { limit: 60, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  const error =
    status === 503 ? "Status callback is temporarily unavailable." : status === 401 ? "Unauthorized" : "Forbidden";

  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(request: Request) {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return rejectUnverified(request, 403);
  }

  // 1) Twilio request signature, then 2) the existing callback secret. Both are required
  // before any delivery-log mutation.
  const verification = verifyTwilioWebhook(request, twilioFormParams(formData));

  if (!verification.ok) {
    console.warn(verification.reason);
    return rejectUnverified(request, verification.status);
  }

  const url = new URL(request.url);
  const expectedSecret = process.env.TWILIO_STATUS_CALLBACK_SECRET ?? "";
  const providedSecret = url.searchParams.get("secret") ?? "";

  if (!hasValidSecret(providedSecret, expectedSecret)) {
    return rejectUnverified(request, 401);
  }

  const messageSidResult = cleanTextValue(String(formData.get("MessageSid") ?? ""), {
    fieldLabel: "MessageSid",
    maxLength: 80,
    required: true,
  });
  const messageStatusResult = cleanTextValue(String(formData.get("MessageStatus") ?? ""), {
    fieldLabel: "MessageStatus",
    maxLength: 40,
  });
  const errorCodeResult = cleanTextValue(String(formData.get("ErrorCode") ?? ""), {
    fieldLabel: "ErrorCode",
    maxLength: 40,
  });
  const errorMessageResult = cleanTextValue(String(formData.get("ErrorMessage") ?? ""), {
    fieldLabel: "ErrorMessage",
    maxLength: 500,
  });

  if (!messageSidResult.ok) {
    return NextResponse.json({ ok: false, error: "Invalid status payload." }, { status: 400 });
  }

  if (!messageStatusResult.ok || !errorCodeResult.ok || !errorMessageResult.ok) {
    return NextResponse.json({ ok: false, error: "Invalid status payload." }, { status: 400 });
  }

  const messageSid = messageSidResult.value;
  const messageStatus = messageStatusResult.value;
  const errorCode = errorCodeResult.value;
  const errorMessage = errorMessageResult.value;

  const supabase = getServiceSupabase();

  if (!supabase) {
    console.error("Twilio status callback service client is not configured.");
    return NextResponse.json({ ok: false, error: "Status callback is temporarily unavailable." }, { status: 503 });
  }

  const mappedStatus = mapTwilioStatusToSmsLogStatus(messageStatus);
  const timestamp = new Date().toISOString();

  // Twilio's raw ErrorMessage is never persisted (it can echo request values such as the
  // callback URL); only a code-derived message is stored when the callback reports an error.
  const hasProviderError = Boolean(errorCode || errorMessage);

  const updatePayload: Record<string, string | null> = {
    status: mappedStatus,
    provider_error_code: errorCode || null,
    provider_error_message: hasProviderError ? sanitizedSmsProviderError(errorCode) : null,
    updated_at: timestamp,
  };

  if (mappedStatus === "delivered") {
    updatePayload.delivered_at = timestamp;
  }

  if (mappedStatus === "failed") {
    updatePayload.failed_at = timestamp;
  }

  const { error } = await supabase
    .from("sms_message_logs")
    .update(updatePayload)
    .eq("provider", "twilio")
    .eq("provider_message_id", messageSid);

  if (error) {
    console.error("Twilio status callback update failed", error.message);
    return NextResponse.json({ ok: false, error: "Status callback could not be processed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
