import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  SMS_UNROUTED_REPLY,
  buildSmsHelpReply,
  buildSmsStartNoPriorConsentReply,
  buildSmsStartReply,
  buildSmsStopReply,
  normalizeSmsPhone,
} from "@/lib/sms/compliance";
import { resolveInboundKeyword } from "@/lib/sms/inboundKeywords";
import { resolveStudioFromInboundSender } from "@/lib/sms/studioSender";
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

/**
 * TW-1: an empty TwiML response sends no SMS. Used whenever Twilio Advanced Opt-Out has
 * already handled the keyword and sent the reply configured on the studio's Messaging
 * Service, so the recipient never receives a second, application-generated message.
 */
function emptyTwiml() {
  return new Response("<Response></Response>", {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
  });
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

  // TW-1: Twilio Advanced Opt-Out is authoritative. A recognized OptOutType beats the
  // body, and once Twilio has handled the keyword every response below stays silent.
  const { keyword, twilioHandled } = resolveInboundKeyword({
    optOutType: String(formData.get("OptOutType") ?? ""),
    body: String(formData.get("Body") ?? ""),
  });
  const reply = (message: string) => (twilioHandled ? emptyTwiml() : twiml(message));

  const supabase = getServiceSupabase();

  if (!supabase) {
    return reply("Text messaging is temporarily unavailable. Please contact the studio directly.");
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
    return reply("We could not process that message. Please contact the studio directly.");
  }

  const body = bodyResult.value;
  const messageSid = sidResult.value;

  if (!from) {
    return reply("We could not recognize your phone number. Please contact the studio directly.");
  }

  // SMS-A2P-2: tie the message to exactly one studio via the receiving sender
  // (MessagingServiceSid and/or To). If it cannot be tied to one studio nothing is
  // read or changed, so a reply can never affect another studio's consent.
  const routing = await resolveStudioFromInboundSender(supabase, {
    messagingServiceSid: String(formData.get("MessagingServiceSid") ?? ""),
    to: String(formData.get("To") ?? ""),
  });

  if (!routing.ok) {
    console.warn(`sms_inbound_unrouted:${routing.reason}`);
    return reply(SMS_UNROUTED_REPLY);
  }

  const studioId = routing.studioId;

  const { data: studioRow } = await supabase
    .from("studios")
    .select("name")
    .eq("id", studioId)
    .maybeSingle<{ name: string | null }>();
  const studioName = studioRow?.name ?? null;

  const { data: permissions } = await supabase
    .from("sms_contact_permissions")
    .select("*")
    .eq("studio_id", studioId)
    .eq("phone_e164", from)
    .order("updated_at", { ascending: false })
    .limit(20);

  const now = new Date().toISOString();

  // One inbound log per known client/contact; TW-2 phone-level opt-out rows carry no identity.
  const identifiedPermissions = (permissions ?? []).filter(
    (permission) => permission.client_id != null || permission.organizer_contact_id != null,
  );

  for (const permission of identifiedPermissions) {
    await supabase.from("sms_message_logs").insert({
      studio_id: studioId,
      organizer_id: null,
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

  if (keyword === "stop" || keyword === "start") {
    // TW-2: one canonical database call, scoped to the resolved studio, updates current
    // consent and appends consumer history atomically.
    //   STOP  -> every client/contact row for this studio+phone is opted out (original
    //            opt-in evidence kept) and a studio+phone opt-out is stored even when the
    //            number matches no client, so a later client with this phone stays blocked.
    //   START -> restores only rows with recorded prior consent and lifts the studio+phone
    //            block; it never creates consent, even though Twilio has unblocked the number.
    const { data: outcome, error: consentError } = await supabase.rpc("record_sms_inbound_opt_event", {
      p_studio_id: studioId,
      p_phone_e164: from,
      p_event: keyword,
    });

    if (consentError) {
      // Code only. Twilio Advanced Opt-Out still enforces the carrier-level block.
      console.error("sms_inbound_consent_update_failed", consentError.code ?? "unknown");
    }

    if (keyword === "stop") {
      return reply(buildSmsStopReply(studioName));
    }

    const restored = Number((outcome as { rows_changed?: unknown } | null)?.rows_changed ?? 0) > 0;

    return reply(restored ? buildSmsStartReply(studioName) : buildSmsStartNoPriorConsentReply(studioName));
  }

  if (keyword === "help") {
    return reply(buildSmsHelpReply(studioName));
  }

  return reply("Thanks for your message. Please contact the studio directly if you need help.");
}
