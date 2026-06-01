import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { mapTwilioStatusToSmsLogStatus } from "@/lib/sms/twilio";

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

export async function POST(request: Request) {
  const url = new URL(request.url);
  const expectedSecret = process.env.TWILIO_STATUS_CALLBACK_SECRET ?? "";
  const providedSecret = url.searchParams.get("secret") ?? "";

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const messageSid = String(formData.get("MessageSid") ?? "");
  const messageStatus = String(formData.get("MessageStatus") ?? "");
  const errorCode = formData.get("ErrorCode");
  const errorMessage = formData.get("ErrorMessage");

  if (!messageSid) {
    return NextResponse.json({ ok: false, error: "Missing MessageSid" }, { status: 400 });
  }

  const supabase = getServiceSupabase();

  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase service client is not configured." }, { status: 500 });
  }

  const mappedStatus = mapTwilioStatusToSmsLogStatus(messageStatus);
  const timestamp = new Date().toISOString();

  const updatePayload: Record<string, string | null> = {
    status: mappedStatus,
    provider_error_code: errorCode ? String(errorCode) : null,
    provider_error_message: errorMessage ? String(errorMessage) : null,
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
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
