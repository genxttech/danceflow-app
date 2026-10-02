"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import {
  SMS_REGISTRATION_STATUSES,
  missingApprovalIdentifiers,
  normalizeCampaignSid,
  normalizeMessagingServiceSid,
  normalizeSenderE164,
} from "@/lib/sms/registration";
import {
  cleanTextValue,
  normalizeOptionalUuid,
  normalizeRequiredEnum,
  rawFormString,
} from "@/lib/validation/forms";

const RETURN_PATH = "/platform/sms";

function done(params: { saved?: boolean; error?: string }): never {
  const search = new URLSearchParams();
  if (params.saved) search.set("registration", "saved");
  if (params.error) search.set("registration_error", params.error);
  redirect(`${RETURN_PATH}?${search.toString()}#registrations`);
}

/**
 * SMS-A2P-1: platform admins record a studio's non-secret A2P registration state.
 * Twilio Console stays the registration authority; this only mirrors identifiers and
 * status. Authority is enforced twice: `requirePlatformAdmin` here and RLS on the
 * table (profiles.platform_role = 'platform_admin'). It does not enable sending.
 */
export async function saveStudioSmsRegistrationAction(formData: FormData) {
  await requirePlatformAdmin();

  const studioIdResult = normalizeOptionalUuid(rawFormString(formData, "studioId"), "Studio");
  const statusResult = normalizeRequiredEnum(
    rawFormString(formData, "registrationStatus"),
    SMS_REGISTRATION_STATUSES,
    "Status",
  );
  const serviceResult = normalizeMessagingServiceSid(rawFormString(formData, "messagingServiceSid"));
  const campaignResult = normalizeCampaignSid(rawFormString(formData, "campaignSid"));
  const senderResult = normalizeSenderE164(rawFormString(formData, "senderE164"));
  const noteResult = cleanTextValue(rawFormString(formData, "reviewNote"), {
    fieldLabel: "Note",
    maxLength: 500,
    allowNewlines: true,
  });

  if (!studioIdResult.ok) done({ error: studioIdResult.error });
  if (!studioIdResult.value) done({ error: "Choose a studio." });
  if (!statusResult.ok) done({ error: statusResult.error });
  if (!serviceResult.ok) done({ error: serviceResult.error });
  if (!campaignResult.ok) done({ error: campaignResult.error });
  if (!senderResult.ok) done({ error: senderResult.error });
  if (!noteResult.ok) done({ error: noteResult.error });

  if (statusResult.value === "approved") {
    const missing = missingApprovalIdentifiers({
      messagingServiceSid: serviceResult.value,
      campaignSid: campaignResult.value,
      senderE164: senderResult.value,
    });

    if (missing.length > 0) {
      done({ error: `To mark a studio approved, add: ${missing.join(", ")}.` });
    }
  }

  const supabase = await createClient();

  const { error } = await supabase.from("studio_sms_registrations").upsert(
    {
      studio_id: studioIdResult.value,
      registration_status: statusResult.value,
      messaging_service_sid: serviceResult.value,
      campaign_sid: campaignResult.value,
      sender_e164: senderResult.value,
      review_note: noteResult.value || null,
    },
    { onConflict: "studio_id" },
  );

  if (error) {
    // Code-only log; the message can echo submitted identifiers.
    console.error("studio_sms_registration_save_failed", error.code ?? "unknown");
    done({
      error:
        error.code === "23505"
          ? "That Messaging Service SID, Campaign SID or sender number is already assigned to another studio."
          : "The registration could not be saved.",
    });
  }

  revalidatePath(RETURN_PATH);
  done({ saved: true });
}
