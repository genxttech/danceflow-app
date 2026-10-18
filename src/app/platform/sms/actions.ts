"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { setPilotAccess } from "@/lib/sms/onboarding/client";
import { buildRunnerRuntime, buildRunnerStore } from "@/lib/sms/twilioIsv/factory";
import { describeOutcome } from "@/lib/sms/twilioIsv/outcomes";
import { refreshBrandStatus, runBrandSubmission, type SubmissionStepKey } from "@/lib/sms/twilioIsv/runner";
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

/**
 * TW-4A: platform admins switch a studio's SMS onboarding pilot access ON/OFF (default OFF for every studio). The database
 * re-checks platform_role inside `set_sms_onboarding_access`, so this is the second check, not the only one.
 */
export async function setSmsOnboardingAccessAction(formData: FormData) {
  await requirePlatformAdmin();

  const studioIdResult = normalizeOptionalUuid(rawFormString(formData, "studioId"), "Studio");
  const reasonResult = cleanTextValue(rawFormString(formData, "reason"), { fieldLabel: "Reason", maxLength: 500, allowNewlines: false });
  const enabled = rawFormString(formData, "enabled") === "on";
  const back = (query: string): never => redirect(`${RETURN_PATH}?${query}#onboarding-pilot`);

  if (!studioIdResult.ok) back(`pilot_error=${encodeURIComponent(studioIdResult.error)}`);
  if (!studioIdResult.ok || !studioIdResult.value) back(`pilot_error=${encodeURIComponent("Choose a studio.")}`);
  if (!reasonResult.ok || reasonResult.value.trim().length < 3) back(`pilot_error=${encodeURIComponent("Give a short reason (3+ characters).")}`);

  try {
    await setPilotAccess(
      await createClient(),
      String(studioIdResult.ok ? studioIdResult.value : ""),
      enabled,
      reasonResult.ok ? reasonResult.value.trim() : "",
    );
  } catch {
    back(`pilot_error=${encodeURIComponent("The pilot switch could not be changed.")}`);
  }
  revalidatePath(RETURN_PATH);
  back("pilot=saved");
}

/**
 * TW-4 R1: a platform admin runs the brand submission steps for ONE studio ("Run next steps"), or checks the brand's status
 * ("Check brand status", GET-only). Nothing runs on a schedule. The paid brand step needs the fee confirmation ticked on every
 * run, and each irreversible submission (profile for review, A2P trust product) needs its OWN confirmation plus the typed word SUBMIT,
 * also on every run: a box left unticked means the run stops before that submission. The database re-checks the platform-admin actor and the pilot switch inside the claim. In DEV/preview the real adapter
 * cannot be built (only the fake, if TW4_ISV_FAKE=on); in production it needs TW4_ISV_REAL_CALLS=on.
 */
export async function runSmsOnboardingAction(formData: FormData) {
  const admin = await requirePlatformAdmin();

  const studioIdResult = normalizeOptionalUuid(rawFormString(formData, "studioId"), "Studio");
  const intent = rawFormString(formData, "intent") === "refresh" ? "refresh" : "run";
  const confirmFee = rawFormString(formData, "confirmFee") === "on";
  const confirmSubmit: SubmissionStepKey[] = [];
  if (intent === "run" && rawFormString(formData, "confirmSubmitProfile") === "on") confirmSubmit.push("S11");
  if (intent === "run" && rawFormString(formData, "confirmSubmitTrustProduct") === "on") confirmSubmit.push("T6");
  const back = (query: string): never => redirect(`${RETURN_PATH}?${query}#onboarding-pilot`);

  if (!studioIdResult.ok || !studioIdResult.value) back(`runner_error=${encodeURIComponent("Choose a studio.")}`);
  const studioId = String(studioIdResult.ok ? studioIdResult.value : "");
  // An irreversible submission needs a deliberate second act: the typed word, checked before any runtime is built.
  if (confirmSubmit.length > 0 && rawFormString(formData, "submitPhrase").trim() !== "SUBMIT") {
    back(`runner_error=${encodeURIComponent("To submit to Twilio, tick the submission and type SUBMIT exactly. Nothing was run.")}`);
  }

  const runtime = buildRunnerRuntime();
  if (!runtime.ok) back(`runner_error=${encodeURIComponent(runtime.reason)}`);
  if (!runtime.ok) return;

  if (confirmSubmit.length > 0) {
    // Interim trail until a ledger column exists (needs a migration, tracked as a 4F follow-up): who confirmed which submission, for which studio.
    console.info(JSON.stringify({ event: "sms_runner_submission_requested", studioId, actorId: admin.id, steps: confirmSubmit }));
  }
  let message: string;
  try {
    const result =
      intent === "refresh"
        ? await refreshBrandStatus({ store: runtime.store, adapter: runtime.adapter, studioId, actorId: admin.id })
        : await runBrandSubmission({ store: runtime.store, adapter: runtime.adapter, config: runtime.config, studioId, actorId: admin.id, confirmFee, confirmSubmit });
    message = describeOutcome(result.outcome, result.detail);
    if (confirmSubmit.length > 0) {
      const done = (result.stepsRun ?? []).filter((step): step is SubmissionStepKey => step === "S11" || step === "T6");
      console.info(JSON.stringify({ event: "sms_runner_submission_result", studioId, actorId: admin.id, requested: confirmSubmit, submitted: done, outcome: result.outcome }));
    }
  } catch {
    back(`runner_error=${encodeURIComponent("The run failed unexpectedly. Nothing was repeated; check the step list before running again.")}`);
    return;
  }
  revalidatePath(RETURN_PATH);
  back(`runner=${encodeURIComponent(message)}`);
}

/**
 * TW-4 R1: the database kill switch. A platform admin opens a time-limited runner window (1-72 hours, 0 closes) for ONE studio; the run
 * action refuses to create anything outside an open window. The database re-checks the platform-admin actor.
 */
export async function setSmsRunnerWindowAction(formData: FormData) {
  const admin = await requirePlatformAdmin();

  const studioIdResult = normalizeOptionalUuid(rawFormString(formData, "studioId"), "Studio");
  const reasonResult = cleanTextValue(rawFormString(formData, "reason"), { fieldLabel: "Reason", maxLength: 300, allowNewlines: false });
  const hours = Number.parseInt(rawFormString(formData, "hours"), 10);
  const back = (query: string): never => redirect(`${RETURN_PATH}?${query}#onboarding-pilot`);

  if (!studioIdResult.ok || !studioIdResult.value) back(`runner_error=${encodeURIComponent("Choose a studio.")}`);
  if (!reasonResult.ok || reasonResult.value.trim().length < 3) back(`runner_error=${encodeURIComponent("Give a short reason (3+ characters).")}`);
  if (!Number.isInteger(hours) || hours < 0 || hours > 72) back(`runner_error=${encodeURIComponent("Hours must be between 0 (close) and 72.")}`);

  try {
    await buildRunnerStore().setWindow(String(studioIdResult.ok ? studioIdResult.value : ""), admin.id, hours, reasonResult.ok ? reasonResult.value.trim() : "");
  } catch {
    back(`runner_error=${encodeURIComponent("The runner window could not be changed.")}`);
  }
  revalidatePath(RETURN_PATH);
  back(`runner=${encodeURIComponent(hours === 0 ? "Runner window closed." : `Runner window open for ${hours} hour(s).`)}`);
}
