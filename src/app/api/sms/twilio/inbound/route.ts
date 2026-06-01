import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { normalizeSmsPhone } from "@/lib/sms/compliance";

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

function twiml(message: string) {
  return new Response(`<Response><Message>${message}</Message></Response>`, {
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

export async function POST(request: Request) {
  const supabase = getServiceSupabase();

  if (!supabase) {
    return twiml("Text messaging is temporarily unavailable. Please contact the studio directly.");
  }

  const formData = await request.formData();
  const from = normalizeSmsPhone(String(formData.get("From") ?? ""));
  const to = normalizeSmsPhone(String(formData.get("To") ?? ""));
  const body = String(formData.get("Body") ?? "");
  const messageSid = String(formData.get("MessageSid") ?? "");

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
    for (const permission of permissions ?? []) {
      await supabase
        .from("sms_contact_permissions")
        .update({
          consent_status: "opted_out",
          opted_out_at: now,
          opted_out_source: "twilio_inbound_stop",
          consent_source: "twilio_inbound_stop",
          updated_at: now,
        })
        .eq("id", permission.id);
    }

    return twiml("You are opted out and will no longer receive texts from this workspace. Reply START to opt back in.");
  }

  if (keyword === "start") {
    for (const permission of permissions ?? []) {
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

    return twiml("You are opted in to receive texts from this workspace. Reply STOP to opt out.");
  }

  if (keyword === "help") {
    return twiml("Reply STOP to opt out of texts. For help, contact the studio or organizer directly.");
  }

  return twiml("Thanks for your message. Please contact the studio directly if you need help.");
}
