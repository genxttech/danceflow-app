import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  SMS_HELP_REPLY,
  SMS_START_NO_PRIOR_CONSENT_REPLY,
  SMS_START_REPLY,
  SMS_STOP_REPLY,
  normalizeSmsPhone,
} from "@/lib/sms/compliance";
import { twilioFormParams, verifyTwilioWebhook } from "@/lib/sms/twilioWebhook";
import { cleanTextValue } from "@/lib/validation/forms";
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

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(message: string) {
  return new Response(`<Response><Message>${escapeXml(message)}</Message></Response>`, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
  });
}

function classifyKeyword(body: string) {
  const normalized = body.trim().toUpperCase();

  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(normalized)) {
    return "stop";
  }

  if (["START", "YES", "UNSTOP"].includes(normalized)) {
    return "start";
  }

  if (["HELP", "INFO"].includes(normalized)) {
    return "help";
  }

  return "message";
}

// A2P-1A: only requests that fail verification count against the per-IP limiter, so
// genuine STOP messages arriving from shared Twilio egress IPs are never throttled.
function rejectUnverified(request: Request, status: 403 | 503) {
  const rateLimit = checkRateLimit(
    rateLimitKey("sms:twilio-inbound-rejected", getIpFromRequest(request)),
    { limit: 30, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  return new Response(status === 503 ? "Service unavailable" : "Forbidden", {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(request: Request) {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return rejectUnverified(request, 403);
  }

  // The Twilio signature is verified before any database access or consent mutation.
  const verification = verifyTwilioWebhook(request, twilioFormParams(formData));

  if (!verification.ok) {
    console.warn(verification.reason);
    return rejectUnverified(request, verification.status);
  }

  const supabase = getServiceSupabase();

  if (!supabase) {
    return twiml("Text messaging is temporarily unavailable. Please contact the studio directly.");
  }

  const from = normalizeSmsPhone(String(formData.get("From") ?? ""));
  const bodyResult = cleanTextValue(String(formData.get("Body") ?? ""), {
    fieldLabel: "Message",
    maxLength: 1600,
    allowNewlines: true,
  });
  const sidResult = cleanTextValue(String(formData.get("MessageSid") ?? ""), {
    fieldLabel: "MessageSid",
    maxLength: 80,
  });

  if (!bodyResult.ok || !sidResult.ok) {
    return twiml("We could not process that message. Please contact the studio directly.");
  }

  const body = bodyResult.value;
  const messageSid = sidResult.value;

  if (!from) {
    return twiml("We could not recognize your phone number. Please contact the studio directly.");
  }

  const keyword = classifyKeyword(body);

  const { data: permissions } = await supabase
    .from("sms_contact_permissions")
    .select("*")
    .eq("phone_e164", from)
    .order("updated_at", { ascending: false })
    .limit(20);

  const now = new Date().toISOString();

  for (const permission of permissions ?? []) {
    await supabase.from("sms_message_logs").insert({
      studio_id: permission.studio_id ?? null,
      organizer_id: permission.organizer_id ?? null,
      client_id: permission.client_id ?? null,
      organizer_contact_id: permission.organizer_contact_id ?? null,
      phone_e164: from,
      direction: "inbound",
      message_type: keyword,
      body,
      segment_count: 1,
      status: "received",
      provider: "twilio",
      provider_message_id: messageSid || null,
      sent_at: now,
    });
  }

  if (keyword === "stop") {
    // consent_source and consent_at are deliberately left intact so the original
    // opt-in evidence survives the opt-out.
    for (const permission of permissions ?? []) {
      await supabase
        .from("sms_contact_permissions")
        .update({
          consent_status: "opted_out",
          opted_out_at: now,
          opted_out_source: "twilio_inbound_stop",
          updated_at: now,
        })
        .eq("id", permission.id);
    }

    return twiml(SMS_STOP_REPLY);
  }

  if (keyword === "start") {
    // START only restores a subscription that previously existed: an opted-out row with
    // a recorded prior opt-in. It never creates initial consent for unknown or new numbers.
    const eligible = (permissions ?? []).filter(
      (permission) => permission.consent_status === "opted_out" && Boolean(permission.consent_at),
    );

    for (const permission of eligible) {
      await supabase
        .from("sms_contact_permissions")
        .update({
          consent_status: "opted_in",
          consent_at: now,
          opted_out_at: null,
          opted_out_source: null,
          consent_source: "twilio_inbound_start",
          updated_at: now,
        })
        .eq("id", permission.id);
    }

    return twiml(eligible.length > 0 ? SMS_START_REPLY : SMS_START_NO_PRIOR_CONSENT_REPLY);
  }

  if (keyword === "help") {
    return twiml(SMS_HELP_REPLY);
  }

  return twiml("Thanks for your message. Please contact the studio directly if you need help.");
}
