"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";
import {
  cleanTextValue,
  getValidationError,
  getValidatedValue,
  normalizeOptionalDate,
  normalizeOptionalEmail,
  normalizeOptionalPhone,
  normalizeOptionalUuid,
  normalizeRequiredEnum,
  rawFormString,
  safeLocalRedirectPath,
} from "@/lib/validation/forms";

const SALES_STAGES = [
  "new_lead",
  "demo_scheduled",
  "trial_started",
  "onboarding",
  "won",
  "lost",
] as const;

const SALES_SOURCES = [
  "manual",
  "referral",
  "website",
  "founder_outreach",
  "social_media",
  "event",
  "partner",
  "other",
] as const;

function returnWithError(returnTo: string, key: string, value: string): never {
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`);
}

function parseMoney(value: string | null | undefined) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return 0;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) {
    throw new Error("Estimated value must be a valid non-negative amount.");
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) {
    throw new Error("Estimated value must be a valid non-negative amount.");
  }
  return Math.round(amount * 100) / 100;
}

function validatedSalesPayload(formData: FormData) {
  const companyNameResult = cleanTextValue(rawFormString(formData, "companyName"), {
    fieldLabel: "Company / studio name",
    maxLength: 140,
    required: true,
  });
  const studioIdResult = normalizeOptionalUuid(rawFormString(formData, "studioId"), "Linked studio");
  const contactNameResult = cleanTextValue(rawFormString(formData, "contactName"), {
    fieldLabel: "Contact name",
    maxLength: 120,
  });
  const contactEmailResult = normalizeOptionalEmail(rawFormString(formData, "contactEmail"), "Contact email");
  const contactPhoneResult = normalizeOptionalPhone(rawFormString(formData, "contactPhone"), "Contact phone");
  const sourceResult = normalizeRequiredEnum(
    rawFormString(formData, "source") || "manual",
    SALES_SOURCES,
    "Source"
  );
  const stageResult = normalizeRequiredEnum(
    rawFormString(formData, "stage") || "new_lead",
    SALES_STAGES,
    "Stage"
  );
  const planInterestResult = cleanTextValue(rawFormString(formData, "planInterest"), {
    fieldLabel: "Plan interest",
    maxLength: 120,
  });
  const trialStartedAtResult = normalizeOptionalDate(rawFormString(formData, "trialStartedAt"), "Trial start date");
  const trialEndsAtResult = normalizeOptionalDate(rawFormString(formData, "trialEndsAt"), "Trial end date");
  const nextFollowUpAtResult = normalizeOptionalDate(rawFormString(formData, "nextFollowUpAt"), "Next follow-up date");
  const lostReasonResult = cleanTextValue(rawFormString(formData, "lostReason"), {
    fieldLabel: "Lost reason",
    maxLength: 500,
  });
  const notesResult = cleanTextValue(rawFormString(formData, "notes"), {
    fieldLabel: "Notes",
    maxLength: 2500,
    allowNewlines: true,
  });

  const validationError = getValidationError([
    companyNameResult,
    studioIdResult,
    contactNameResult,
    contactEmailResult,
    contactPhoneResult,
    sourceResult,
    stageResult,
    planInterestResult,
    trialStartedAtResult,
    trialEndsAtResult,
    nextFollowUpAtResult,
    lostReasonResult,
    notesResult,
  ]);

  if (validationError) {
    throw new Error(validationError);
  }

  return {
    studio_id: getValidatedValue(studioIdResult),
    company_name: getValidatedValue(companyNameResult),
    contact_name: getValidatedValue(contactNameResult) || null,
    contact_email: getValidatedValue(contactEmailResult),
    contact_phone: getValidatedValue(contactPhoneResult),
    source: getValidatedValue(sourceResult),
    stage: getValidatedValue(stageResult),
    plan_interest: getValidatedValue(planInterestResult) || null,
    estimated_value: parseMoney(rawFormString(formData, "estimatedValue")),
    trial_started_at: getValidatedValue(trialStartedAtResult),
    trial_ends_at: getValidatedValue(trialEndsAtResult),
    next_follow_up_at: getValidatedValue(nextFollowUpAtResult),
    lost_reason: getValidatedValue(lostReasonResult) || null,
    notes: getValidatedValue(notesResult) || null,
  };
}

export async function createPlatformSalesOpportunityAction(formData: FormData) {
  await requirePlatformAdmin();

  const returnTo = safeLocalRedirectPath(rawFormString(formData, "returnTo"), "/platform/sales");

  let payload: ReturnType<typeof validatedSalesPayload>;
  try {
    payload = validatedSalesPayload(formData);
  } catch (error) {
    returnWithError(returnTo, "sales_error", error instanceof Error ? error.message : "invalid_input");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("platform_sales_opportunities").insert({
    ...payload,
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
  });

  if (error) {
    throw new Error(`Failed to create sales opportunity: ${error.message}`);
  }

  revalidatePath("/platform/sales");
  revalidatePath("/platform/analytics");
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}sales_created=1`);
}

export async function updatePlatformSalesOpportunityAction(formData: FormData) {
  await requirePlatformAdmin();

  const returnTo = safeLocalRedirectPath(rawFormString(formData, "returnTo"), "/platform/sales");
  const opportunityIdResult = normalizeOptionalUuid(rawFormString(formData, "opportunityId"), "Opportunity");

  if (!opportunityIdResult.ok || !opportunityIdResult.value) redirect(returnTo);

  let payload: ReturnType<typeof validatedSalesPayload>;
  try {
    payload = validatedSalesPayload(formData);
  } catch (error) {
    returnWithError(returnTo, "sales_error", error instanceof Error ? error.message : "invalid_input");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("platform_sales_opportunities")
    .update({
      ...payload,
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", opportunityIdResult.value);

  if (error) {
    throw new Error(`Failed to update sales opportunity: ${error.message}`);
  }

  revalidatePath("/platform/sales");
  revalidatePath("/platform/analytics");
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}sales_updated=1`);
}

export async function updatePlatformSalesStageAction(formData: FormData) {
  await requirePlatformAdmin();

  const returnTo = safeLocalRedirectPath(rawFormString(formData, "returnTo"), "/platform/sales");
  const opportunityIdResult = normalizeOptionalUuid(rawFormString(formData, "opportunityId"), "Opportunity");
  const stageResult = normalizeRequiredEnum(rawFormString(formData, "stage") || "new_lead", SALES_STAGES, "Stage");

  if (!opportunityIdResult.ok || !opportunityIdResult.value || !stageResult.ok) redirect(returnTo);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("platform_sales_opportunities")
    .update({
      stage: stageResult.value,
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", opportunityIdResult.value);

  if (error) {
    throw new Error(`Failed to update sales stage: ${error.message}`);
  }

  revalidatePath("/platform/sales");
  revalidatePath("/platform/analytics");
  redirect(returnTo);
}
