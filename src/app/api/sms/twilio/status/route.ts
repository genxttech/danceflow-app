import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sanitizedSmsProviderError } from "@/lib/sms/compliance";
import { mapTwilioStatusToSmsLogStatus } from "@/lib/sms/twilio";
import { buildWebhookAccountDeps, recordWebhookReceipt } from "@/lib/sms/twilioIsv/webhookRuntime";
import { twilioFormHasDuplicateKeys, twilioFormParams } from "@/lib/sms/twilioWebhook";
import { verifyTwilioWebhookAccount, webhookMayActForStudio, webhookReceiptKey } from "@/lib/sms/twilioWebhookAccount";
import { cleanTextValue } from "@/lib/validation/forms";
import { hasValidSecret } from "@/lib/security/cron";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** PostgREST PGRST202 / Postgres 42883: the usage-billing functions are not installed in this environment. */
const USAGE_NOT_INSTALLED = new Set(["PGRST202", "42883"]);

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
  // TW-4F: a callback for a message sent from a studio legal business's subaccount is signed with that subaccount's own token.
  // a repeated form key would let the signed values (last) differ from the values the route reads (first)
  if (twilioFormHasDuplicateKeys(formData)) {
    console.warn("twilio_form_duplicate_key");
    return rejectUnverified(request, 403);
  }
  const params = twilioFormParams(formData);
  const supabase = getServiceSupabase();
  const verification = await verifyTwilioWebhookAccount(request, params, buildWebhookAccountDeps(supabase));

  if (!verification.ok) {
    console.warn(verification.reason);
    return rejectUnverified(request, verification.status);
  }
  const signer = verification.account;

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

  if (!supabase) {
    console.error("Twilio status callback service client is not configured.");
    return NextResponse.json({ ok: false, error: "Status callback is temporarily unavailable." }, { status: 503 });
  }

  // TW-4F usage billing: a billed text's callback carries its attempt id (the StatusCallback URL). The signer must be the attempt's own subaccount; the callback
  // binds the provider SID when the send's own record of it was lost, and records the status. It never moves money (the reconciler settles from evidence).
  const attemptParam = url.searchParams.get("attempt");
  const attemptId = attemptParam && UUID.test(attemptParam) ? attemptParam : null;
  if (attemptParam !== null && !attemptId) {
    return NextResponse.json({ ok: false, error: "Invalid status payload." }, { status: 400 });
  }
  let billedVerified = false;
  const usage = await supabase.rpc("tw4_usage_record_callback", {
    p_attempt_id: attemptId,
    p_provider_sid: messageSid,
    p_signer_account: signer.kind === "subaccount" ? signer.accountSid : null,
    p_status: messageStatus,
    p_error_code: errorCode || null,
  });
  if (usage.error) {
    const code = String(usage.error.code ?? "");
    if (code === "42501") {
      console.warn("sms_status_usage_account_mismatch");
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    // a legacy message (no attempt id) is unaffected when billing is not installed or its SID is not a billable one
    const legacyUnaffected = !attemptId && (USAGE_NOT_INSTALLED.has(code) || code === "22023");
    if (!legacyUnaffected) {
      console.error("Twilio status callback usage record failed", code || "unknown");
      return NextResponse.json({ ok: false, error: "Status callback could not be processed." }, { status: code === "22023" ? 400 : 500 });
    }
  } else {
    billedVerified = Boolean(usage.data && typeof usage.data === "object" && (usage.data as { billed?: unknown }).billed === true);
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

  // SMS-A2P-2: scope the callback to the studio that owns the logged message. When that
  // studio has a registration, the callback must come from its own Messaging Service,
  // so one studio's sender can never update another studio's log.
  const { data: logRow, error: lookupError } = await supabase
    .from("sms_message_logs")
    .select("id, studio_id")
    .eq("provider", "twilio")
    .eq("provider_message_id", messageSid)
    .limit(1)
    .maybeSingle<{ id: string; studio_id: string | null }>();

  if (lookupError) {
    console.error("Twilio status callback lookup failed", lookupError.message);
    return NextResponse.json({ ok: false, error: "Status callback could not be processed." }, { status: 500 });
  }

  if (!logRow) {
    return NextResponse.json({ ok: true });
  }

  // TW-4F tenant isolation: a subaccount-signed callback may only update a message of that subaccount's own legal business.
  if (!webhookMayActForStudio(signer, logRow.studio_id)) {
    console.warn("sms_status_account_studio_mismatch");
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  // a billed text was already tied to its subaccount above; its sender is that subaccount's own service, not a legacy registration
  if (logRow.studio_id && !billedVerified) {
    const { data: registration, error: registrationError } = await supabase
      .from("studio_sms_registrations")
      .select("messaging_service_sid")
      .eq("studio_id", logRow.studio_id)
      .maybeSingle<{ messaging_service_sid: string | null }>();

    if (registrationError) {
      console.error("Twilio status callback registration lookup failed", registrationError.message);
      return NextResponse.json({ ok: false, error: "Status callback could not be processed." }, { status: 500 });
    }

    const callbackServiceSid = String(formData.get("MessagingServiceSid") ?? "").trim();

    if (registration?.messaging_service_sid && callbackServiceSid !== registration.messaging_service_sid) {
      console.warn("sms_status_sender_mismatch");
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
  }

  // TW-4F replay protection: each (MessageSid, MessageStatus) is applied once, so an exact replay of an earlier callback changes nothing.
  // (A genuine out-of-order callback, e.g. sent after delivered, still applies: there is no status ranking yet.)
  // If the ledger is unreachable the callback is applied anyway (status updates are idempotent; the signature is already verified).
  const receiptKey = webhookReceiptKey("status", params);
  if (receiptKey) {
    const receipt = await recordWebhookReceipt(supabase, "status", receiptKey, signer.kind === "subaccount" ? signer.accountSid : null);
    if (receipt === "duplicate") return NextResponse.json({ ok: true, duplicate: true });
    if (receipt === "unavailable") console.warn("sms_status_receipt_unavailable");
  }

  let update = supabase.from("sms_message_logs").update(updatePayload).eq("id", logRow.id);
  if (logRow.studio_id) update = update.eq("studio_id", logRow.studio_id);
  const { error } = await update;

  if (error) {
    console.error("Twilio status callback update failed", error.message);
    return NextResponse.json({ ok: false, error: "Status callback could not be processed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
