"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  cleanTextValue,
  getValidationError,
  getValidatedValue,
  normalizeOptionalDate,
  normalizeOptionalUuid,
  normalizeRequiredEnum,
  rawFormString,
} from "@/lib/validation/forms";

const allowedCategories = [
  "floor_fee",
  "rent",
  "instructor_pay",
  "marketing",
  "software",
  "supplies",
  "costumes_retail_inventory",
  "event_expense",
  "travel",
  "meals",
  "utilities",
  "insurance",
  "professional_services",
  "other",
] as const;

const allowedPaymentMethods = [
  "cash",
  "check",
  "card",
  "venmo",
  "zelle",
  "ach",
  "stripe",
  "other",
] as const;

function canManageExpenses(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;

  return (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "organizer_owner" ||
    role === "organizer_admin" ||
    role === "independent_instructor"
  );
}

function parseAmount(value: string | null | undefined) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) return null;
  return Math.round(amount * 100) / 100;
}

export async function createExpenseAction(formData: FormData) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in to add an expense.");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active workspace was found.");
  }

  if (!canManageExpenses(context.studioRole, context.isPlatformAdmin)) {
    throw new Error("You do not have permission to add expenses.");
  }

  const expenseDateResult = normalizeOptionalDate(rawFormString(formData, "expense_date"), "Expense date");
  const vendorNameResult = cleanTextValue(rawFormString(formData, "vendor_name"), {
    fieldLabel: "Vendor or studio name",
    maxLength: 160,
    required: true,
  });
  const categoryResult = normalizeRequiredEnum(
    rawFormString(formData, "category") || "other",
    allowedCategories,
    "Category"
  );
  const paymentMethodResult = normalizeRequiredEnum(
    rawFormString(formData, "payment_method") || "other",
    allowedPaymentMethods,
    "Payment method"
  );
  const relatedEventIdResult = normalizeOptionalUuid(rawFormString(formData, "related_event_id"), "Related event");
  const notesResult = cleanTextValue(rawFormString(formData, "notes"), {
    fieldLabel: "Notes",
    maxLength: 2500,
    allowNewlines: true,
  });
  const amount = parseAmount(rawFormString(formData, "amount"));

  const validationError = getValidationError([
    expenseDateResult,
    vendorNameResult,
    categoryResult,
    paymentMethodResult,
    relatedEventIdResult,
    notesResult,
  ]);

  if (validationError) {
    throw new Error(validationError);
  }

  const expenseDate = getValidatedValue(expenseDateResult);
  if (!expenseDate) {
    throw new Error("Expense date is required.");
  }

  if (amount === null) {
    throw new Error("Amount must be a valid non-negative number with up to 2 decimals.");
  }

  const { error } = await supabase.from("expenses").insert({
    studio_id: context.studioId,
    recorded_by: user.id,
    expense_date: expenseDate,
    vendor_name: getValidatedValue(vendorNameResult),
    category: getValidatedValue(categoryResult),
    amount,
    currency: "USD",
    payment_method: getValidatedValue(paymentMethodResult),
    related_event_id: getValidatedValue(relatedEventIdResult),
    notes: getValidatedValue(notesResult) || null,
  });

  if (error) {
    throw new Error(`Could not add expense: ${error.message}`);
  }

  revalidatePath("/app/expenses");
  revalidatePath("/app/reports");
}

export async function deleteExpenseAction(formData: FormData) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in to delete an expense.");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active workspace was found.");
  }

  if (!canManageExpenses(context.studioRole, context.isPlatformAdmin)) {
    throw new Error("You do not have permission to delete expenses.");
  }

  const expenseIdResult = normalizeOptionalUuid(rawFormString(formData, "expense_id"), "Expense");

  if (!expenseIdResult.ok || !expenseIdResult.value) {
    throw new Error("Expense ID is required.");
  }

  const { error } = await supabase
    .from("expenses")
    .delete()
    .eq("id", expenseIdResult.value)
    .eq("studio_id", context.studioId);

  if (error) {
    throw new Error(`Could not delete expense: ${error.message}`);
  }

  revalidatePath("/app/expenses");
  revalidatePath("/app/reports");
}
