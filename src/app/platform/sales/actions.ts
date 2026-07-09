"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";

const SALES_STAGES = new Set([
  "new_lead",
  "demo_scheduled",
  "trial_started",
  "onboarding",
  "won",
  "lost",
]);

const SALES_SOURCES = new Set([
  "manual",
  "referral",
  "website",
  "founder_outreach",
  "social_media",
  "event",
  "partner",
  "other",
]);

function safeReturnPath(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/platform/sales";
  return raw;
}

function nullableText(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw || null;
}

function nullableDate(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const parsed = new Date(`${raw}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;

  return raw;
}

function normalizeSetValue(value: FormDataEntryValue | null, allowed: Set<string>, fallback: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function parseMoney(value: FormDataEntryValue | null) {
  const amount = Number(String(value ?? "").replace(/,/g, "").trim());
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 100) / 100;
}

export async function createPlatformSalesOpportunityAction(formData: FormData) {
  await requirePlatformAdmin();

  const returnTo = safeReturnPath(formData.get("returnTo"));
  const companyName = String(formData.get("companyName") ?? "").trim();

  if (!companyName) {
    redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}sales_error=missing_company`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("platform_sales_opportunities").insert({
    studio_id: nullableText(formData.get("studioId")),
    company_name: companyName,
    contact_name: nullableText(formData.get("contactName")),
    contact_email: nullableText(formData.get("contactEmail")),
    contact_phone: nullableText(formData.get("contactPhone")),
    source: normalizeSetValue(formData.get("source"), SALES_SOURCES, "manual"),
    stage: normalizeSetValue(formData.get("stage"), SALES_STAGES, "new_lead"),
    plan_interest: nullableText(formData.get("planInterest")),
    estimated_value: parseMoney(formData.get("estimatedValue")),
    trial_started_at: nullableDate(formData.get("trialStartedAt")),
    trial_ends_at: nullableDate(formData.get("trialEndsAt")),
    next_follow_up_at: nullableDate(formData.get("nextFollowUpAt")),
    lost_reason: nullableText(formData.get("lostReason")),
    notes: nullableText(formData.get("notes")),
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

  const returnTo = safeReturnPath(formData.get("returnTo"));
  const opportunityId = String(formData.get("opportunityId") ?? "").trim();

  if (!opportunityId) redirect(returnTo);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("platform_sales_opportunities")
    .update({
      studio_id: nullableText(formData.get("studioId")),
      company_name: String(formData.get("companyName") ?? "").trim(),
      contact_name: nullableText(formData.get("contactName")),
      contact_email: nullableText(formData.get("contactEmail")),
      contact_phone: nullableText(formData.get("contactPhone")),
      source: normalizeSetValue(formData.get("source"), SALES_SOURCES, "manual"),
      stage: normalizeSetValue(formData.get("stage"), SALES_STAGES, "new_lead"),
      plan_interest: nullableText(formData.get("planInterest")),
      estimated_value: parseMoney(formData.get("estimatedValue")),
      trial_started_at: nullableDate(formData.get("trialStartedAt")),
      trial_ends_at: nullableDate(formData.get("trialEndsAt")),
      next_follow_up_at: nullableDate(formData.get("nextFollowUpAt")),
      lost_reason: nullableText(formData.get("lostReason")),
      notes: nullableText(formData.get("notes")),
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", opportunityId);

  if (error) {
    throw new Error(`Failed to update sales opportunity: ${error.message}`);
  }

  revalidatePath("/platform/sales");
  revalidatePath("/platform/analytics");
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}sales_updated=1`);
}

export async function updatePlatformSalesStageAction(formData: FormData) {
  await requirePlatformAdmin();

  const opportunityId = String(formData.get("opportunityId") ?? "").trim();
  const returnTo = safeReturnPath(formData.get("returnTo"));
  const stage = normalizeSetValue(formData.get("stage"), SALES_STAGES, "new_lead");

  if (!opportunityId) redirect(returnTo);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("platform_sales_opportunities")
    .update({
      stage,
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", opportunityId);

  if (error) {
    throw new Error(`Failed to update sales stage: ${error.message}`);
  }

  revalidatePath("/platform/sales");
  revalidatePath("/platform/analytics");
  redirect(returnTo);
}
