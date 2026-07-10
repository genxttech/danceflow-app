"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import {
  cleanTextValue,
  getValidationError,
  getValidatedValue,
  normalizeOptionalDate,
  normalizeOptionalEnum,
  normalizeOptionalUuid,
  normalizeRequiredEnum,
  rawFormString,
  safeLocalRedirectPath,
} from "@/lib/validation/forms";

const EXPENSE_CATEGORIES = [
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
] as const;

const EXPENSE_STATUSES = ["draft", "reviewed", "reconciled", "excluded"] as const;

const TAX_TREATMENTS = [
  "deductible",
  "capitalized",
  "non_deductible",
  "distribution",
  "unknown",
] as const;

const RECURRENCE_FREQUENCIES = ["weekly", "monthly", "quarterly", "annual"] as const;

function appendError(returnTo: string, message: string) {
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}expense_error=${encodeURIComponent(message)}`);
}

function parseAmount(value: string | null | undefined) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) return null;
  return Math.round(amount * 100) / 100;
}

function normalizeCurrency(value: string | null | undefined) {
  const currency = String(value ?? "USD").trim().toUpperCase() || "USD";
  return /^[A-Z]{3}$/.test(currency) ? currency : "USD";
}

function normalizeOptionalUrl(value: string | null | undefined) {
  const cleaned = cleanTextValue(value, { fieldLabel: "Receipt URL", maxLength: 2048 });
  if (!cleaned.ok) return cleaned;
  if (!cleaned.value) return { ok: true as const, value: null };

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(cleaned.value)
    ? cleaned.value
    : `https://${cleaned.value}`;

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { ok: false as const, error: "Receipt URL must be a valid http or https URL." };
    }
    return { ok: true as const, value: parsed.toString() };
  } catch {
    return { ok: false as const, error: "Receipt URL must be a valid URL." };
  }
}

export async function createPlatformExpenseAction(formData: FormData) {
  await requirePlatformAdmin();

  const returnTo = safeLocalRedirectPath(rawFormString(formData, "returnTo"), "/platform/expenses");
  const expenseDateResult = normalizeOptionalDate(rawFormString(formData, "expenseDate"), "Expense date");
  const vendorNameResult = cleanTextValue(rawFormString(formData, "vendorName"), {
    fieldLabel: "Vendor",
    maxLength: 160,
    required: true,
  });
  const descriptionResult = cleanTextValue(rawFormString(formData, "description"), {
    fieldLabel: "Description",
    maxLength: 300,
  });
  const categoryResult = normalizeRequiredEnum(
    rawFormString(formData, "category") || "other",
    EXPENSE_CATEGORIES,
    "Category"
  );
  const taxTreatmentResult = normalizeRequiredEnum(
    rawFormString(formData, "taxTreatment") || "deductible",
    TAX_TREATMENTS,
    "Tax treatment"
  );
  const recurrenceFrequencyResult = normalizeOptionalEnum(
    rawFormString(formData, "recurrenceFrequency"),
    RECURRENCE_FREQUENCIES,
    "Recurrence"
  );
  const paymentMethodResult = cleanTextValue(rawFormString(formData, "paymentMethod"), {
    fieldLabel: "Payment method",
    maxLength: 80,
  });
  const receiptUrlResult = normalizeOptionalUrl(rawFormString(formData, "receiptUrl"));
  const notesResult = cleanTextValue(rawFormString(formData, "notes"), {
    fieldLabel: "Notes",
    maxLength: 2500,
    allowNewlines: true,
  });

  const validationError = getValidationError([
    expenseDateResult,
    vendorNameResult,
    descriptionResult,
    categoryResult,
    taxTreatmentResult,
    recurrenceFrequencyResult,
    paymentMethodResult,
    receiptUrlResult,
    notesResult,
  ]);

  const amount = parseAmount(rawFormString(formData, "amount"));

  if (validationError || !getValidatedValue(expenseDateResult) || amount === null) {
    appendError(returnTo, validationError || "Expense date, vendor, and valid amount are required.");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("platform_expenses").insert({
    expense_date: getValidatedValue(expenseDateResult),
    vendor_name: getValidatedValue(vendorNameResult),
    description: getValidatedValue(descriptionResult) || null,
    category: getValidatedValue(categoryResult),
    amount,
    currency: normalizeCurrency(rawFormString(formData, "currency")),
    payment_method: getValidatedValue(paymentMethodResult) || null,
    status: "draft",
    tax_treatment: getValidatedValue(taxTreatmentResult),
    is_recurring: formData.get("isRecurring") === "on",
    recurrence_frequency: getValidatedValue(recurrenceFrequencyResult),
    receipt_url: getValidatedValue(receiptUrlResult),
    notes: getValidatedValue(notesResult) || null,
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

  const returnTo = safeLocalRedirectPath(rawFormString(formData, "returnTo"), "/platform/expenses");
  const expenseIdResult = normalizeOptionalUuid(rawFormString(formData, "expenseId"), "Expense");
  const statusResult = normalizeRequiredEnum(rawFormString(formData, "status") || "draft", EXPENSE_STATUSES, "Status");

  if (!expenseIdResult.ok || !expenseIdResult.value || !statusResult.ok) {
    redirect(returnTo);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("platform_expenses")
    .update({
      status: statusResult.value,
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", expenseIdResult.value);

  if (error) {
    throw new Error(`Failed to update platform expense: ${error.message}`);
  }

  revalidatePath("/platform/expenses");
  revalidatePath("/platform/accounting");
  redirect(returnTo);
}
