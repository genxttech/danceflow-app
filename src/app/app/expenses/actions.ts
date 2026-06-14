"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

const allowedCategories = new Set([
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
]);

const allowedPaymentMethods = new Set([
  "cash",
  "check",
  "card",
  "venmo",
  "zelle",
  "ach",
  "stripe",
  "other",
]);

function cleanText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function cleanOptionalText(value: FormDataEntryValue | null) {
  const cleaned = cleanText(value);
  return cleaned.length > 0 ? cleaned : null;
}

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

  const expenseDate = cleanText(formData.get("expense_date"));
  const vendorName = cleanText(formData.get("vendor_name"));
  const rawCategory = cleanText(formData.get("category")) || "other";
  const rawAmount = cleanText(formData.get("amount"));
  const rawPaymentMethod = cleanText(formData.get("payment_method")) || "other";
  const notes = cleanOptionalText(formData.get("notes"));
  const relatedEventId = cleanOptionalText(formData.get("related_event_id"));

  const category = allowedCategories.has(rawCategory) ? rawCategory : "other";
  const paymentMethod = allowedPaymentMethods.has(rawPaymentMethod)
    ? rawPaymentMethod
    : "other";

  const amount = Number(rawAmount);

  if (!expenseDate) {
    throw new Error("Expense date is required.");
  }

  if (!vendorName) {
    throw new Error("Vendor or studio name is required.");
  }

  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Amount must be a valid number.");
  }

  const { error } = await supabase.from("expenses").insert({
    studio_id: context.studioId,
    recorded_by: user.id,
    expense_date: expenseDate,
    vendor_name: vendorName,
    category,
    amount,
    currency: "USD",
    payment_method: paymentMethod,
    related_event_id: relatedEventId,
    notes,
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

  const expenseId = cleanText(formData.get("expense_id"));

  if (!expenseId) {
    throw new Error("Expense ID is required.");
  }

  const { error } = await supabase
    .from("expenses")
    .delete()
    .eq("id", expenseId)
    .eq("studio_id", context.studioId);

  if (error) {
    throw new Error(`Could not delete expense: ${error.message}`);
  }

  revalidatePath("/app/expenses");
  revalidatePath("/app/reports");
}