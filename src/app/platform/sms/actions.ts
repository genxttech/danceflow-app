"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import {
  SMS_CAMPAIGN_USE_CASES,
  SMS_PROVIDER_REVIEW_STATUSES,
  SMS_REGISTRATION_STATUSES,
  normalizeBrandSid,
  normalizeCampaignSid,
  normalizeCustomerProfileSid,
  normalizeMessagingServiceSid,
  normalizePhoneNumberSid,
  normalizeSenderE164,
  registrationContradictions,
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
  const brandStatusResult = normalizeRequiredEnum(
    rawFormString(formData, "brandStatus") || "not_started",
    SMS_PROVIDER_REVIEW_STATUSES,
    "Brand status",
  );
  const campaignStatusResult = normalizeRequiredEnum(
    rawFormString(formData, "campaignStatus") || "not_started",
    SMS_PROVIDER_REVIEW_STATUSES,
    "Campaign status",
  );
  const rawUseCase = rawFormString(formData, "campaignUseCase").trim();
  const useCaseResult = rawUseCase
    ? normalizeRequiredEnum(rawUseCase, SMS_CAMPAIGN_USE_CASES, "Use case")
    : ({ ok: true, value: null } as const);
  const profileResult = normalizeCustomerProfileSid(rawFormString(formData, "customerProfileSid"));
  const brandResult = normalizeBrandSid(rawFormString(formData, "brandSid"));
  const phoneSidResult = normalizePhoneNumberSid(rawFormString(formData, "phoneNumberSid"));
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
  if (!brandStatusResult.ok) done({ error: brandStatusResult.error });
  if (!campaignStatusResult.ok) done({ error: campaignStatusResult.error });
  if (!useCaseResult.ok) done({ error: useCaseResult.error });
  if (!profileResult.ok) done({ error: profileResult.error });
  if (!brandResult.ok) done({ error: brandResult.error });
  if (!phoneSidResult.ok) done({ error: phoneSidResult.error });
  if (!serviceResult.ok) done({ error: serviceResult.error });
  if (!campaignResult.ok) done({ error: campaignResult.error });
  if (!senderResult.ok) done({ error: senderResult.error });
  if (!noteResult.ok) done({ error: noteResult.error });

  const contradictions = registrationContradictions({
    registrationStatus: statusResult.value,
    customerProfileSid: profileResult.value,
    brandSid: brandResult.value,
    brandStatus: brandStatusResult.value,
    messagingServiceSid: serviceResult.value,
    campaignSid: campaignResult.value,
    campaignStatus: campaignStatusResult.value,
    campaignUseCase: useCaseResult.value,
    phoneNumberSid: phoneSidResult.value,
    senderE164: senderResult.value,
  });
  if (contradictions.length > 0) done({ error: contradictions[0] });

  const supabase = await createClient();

  const { error } = await supabase.from("studio_sms_registrations").upsert(
    {
      studio_id: studioIdResult.value,
      registration_status: statusResult.value,
      customer_profile_sid: profileResult.value,
      brand_sid: brandResult.value,
      brand_status: brandStatusResult.value,
      messaging_service_sid: serviceResult.value,
      campaign_sid: campaignResult.value,
      campaign_status: campaignStatusResult.value,
      campaign_use_case: useCaseResult.value,
      phone_number_sid: phoneSidResult.value,
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
          ? "That Messaging Service SID, Campaign SID, Phone Number SID or sender number is already assigned to another studio."
          : "The registration could not be saved.",
    });
  }

  revalidatePath(RETURN_PATH);
  done({ saved: true });
}
