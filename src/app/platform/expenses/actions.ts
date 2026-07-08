"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";

const EXPENSE_CATEGORIES = new Set([
  "software_tools",
  "hosting_infrastructure",
  "payment_processing",
  "contractor_payroll",
  "marketing_ads",
  "professional_services",
  "taxes_licenses",
  "office_admin",
  "travel_meals",
  "owner_draw",
  "other",
]);

const EXPENSE_STATUSES = new Set(["draft", "reviewed", "reconciled", "excluded"]);

const TAX_TREATMENTS = new Set([
  "deductible",
  "capitalized",
  "non_deductible",
  "distribution",
  "unknown",
]);

const RECURRENCE_FREQUENCIES = new Set(["weekly", "monthly", "quarterly", "annual"]);

function safeReturnPath(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/platform/expenses";
  }
  return raw;
}

function normalizeSetValue(
  value: FormDataEntryValue | null,
  allowed: Set<string>,
  fallback: string
) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function nullableText(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw || null;
}

function parseAmount(value: FormDataEntryValue | null) {
  const amount = Number(String(value ?? "").replace(/,/g, "").trim());
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100) / 100;
}

export async function createPlatformExpenseAction(formData: FormData) {
  await requirePlatformAdmin();

  const returnTo = safeReturnPath(formData.get("returnTo"));
  const vendorName = String(formData.get("vendorName") ?? "").trim();
  const expenseDate = String(formData.get("expenseDate") ?? "").trim();
  const amount = parseAmount(formData.get("amount"));

  if (!vendorName || !expenseDate || amount === null) {
    redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}expense_error=missing_required`);
  }

  const category = normalizeSetValue(formData.get("category"), EXPENSE_CATEGORIES, "other");
  const taxTreatment = normalizeSetValue(formData.get("taxTreatment"), TAX_TREATMENTS, "deductible");
  const recurrenceFrequency = normalizeSetValue(
    formData.get("recurrenceFrequency"),
    RECURRENCE_FREQUENCIES,
    ""
  );

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("platform_expenses").insert({
    expense_date: expenseDate,
    vendor_name: vendorName,
    description: nullableText(formData.get("description")),
    category,
    amount,
    currency: String(formData.get("currency") ?? "USD").trim().toUpperCase() || "USD",
    payment_method: nullableText(formData.get("paymentMethod")),
    status: "draft",
    tax_treatment: taxTreatment,
    is_recurring: formData.get("isRecurring") === "on",
    recurrence_frequency: recurrenceFrequency || null,
    receipt_url: nullableText(formData.get("receiptUrl")),
    notes: nullableText(formData.get("notes")),
    source: "manual",
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
  });

  if (error) {
    throw new Error(`Failed to create platform expense: ${error.message}`);
  }

  revalidatePath("/platform/expenses");
  revalidatePath("/platform/accounting");
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}expense_created=1`);
}

export async function updatePlatformExpenseStatusAction(formData: FormData) {
  await requirePlatformAdmin();

  const returnTo = safeReturnPath(formData.get("returnTo"));
  const expenseId = String(formData.get("expenseId") ?? "").trim();
  const status = normalizeSetValue(formData.get("status"), EXPENSE_STATUSES, "draft");

  if (!expenseId) {
    redirect(returnTo);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("platform_expenses")
    .update({
      status,
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", expenseId);

  if (error) {
    throw new Error(`Failed to update platform expense: ${error.message}`);
  }

  revalidatePath("/platform/expenses");
  revalidatePath("/platform/accounting");
  redirect(returnTo);
}