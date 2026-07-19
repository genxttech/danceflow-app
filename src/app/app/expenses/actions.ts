"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageOrganizerExpenses } from "@/lib/auth/permissions";
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

const allowedRecurringFrequencies = [
  "weekly",
  "monthly",
  "quarterly",
  "annually",
] as const;

function expenseAccountingCategory(category: (typeof allowedCategories)[number]) {
  const categories: Record<(typeof allowedCategories)[number], string> = {
    floor_fee: "floor_fee_expense",
    rent: "rent_expense",
    instructor_pay: "instructor_pay_expense",
    marketing: "marketing_expense",
    software: "software_expense",
    supplies: "supplies_expense",
    costumes_retail_inventory: "costumes_retail_inventory_expense",
    event_expense: "event_expense",
    travel: "travel_expense",
    meals: "meals_expense",
    utilities: "utilities_expense",
    insurance: "insurance_expense",
    professional_services: "professional_services_expense",
    other: "other_expense",
  };

  return categories[category];
}

function parseAmount(value: string | null | undefined) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) return null;
  return Math.round(amount * 100) / 100;
}


function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addMonthsClamped(value: Date, months: number) {
  const originalDay = value.getUTCDate();
  const result = new Date(value);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const finalDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, finalDay));
  return result;
}

function nextRecurringDate(
  currentDate: string,
  frequency: (typeof allowedRecurringFrequencies)[number]
) {
  const current = parseDateKey(currentDate);

  if (frequency === "weekly") {
    current.setUTCDate(current.getUTCDate() + 7);
    return dateKey(current);
  }

  if (frequency === "monthly") {
    return dateKey(addMonthsClamped(current, 1));
  }

  if (frequency === "quarterly") {
    return dateKey(addMonthsClamped(current, 3));
  }

  return dateKey(addMonthsClamped(current, 12));
}

async function requireExpenseManager() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in to manage expenses.");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active workspace was found.");
  }

  const canManage = Boolean(context.isPlatformAdmin) ||
    canManageOrganizerExpenses(context.studioRole) ||
    ["studio_owner", "studio_admin", "independent_instructor"].includes(
      context.studioRole ?? "",
    );

  if (!canManage) {
    throw new Error("You do not have permission to manage expenses.");
  }

  return { supabase, user, context };
}

export async function createExpenseAction(formData: FormData) {
  const { supabase, user, context } = await requireExpenseManager();

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
  const repeatExpense = rawFormString(formData, "repeat_expense") === "on";
  const recurringFrequencyResult = repeatExpense
    ? normalizeRequiredEnum(
        rawFormString(formData, "recurring_frequency") || "monthly",
        allowedRecurringFrequencies,
        "Recurring frequency"
      )
    : null;
  const recurringNextDateResult = repeatExpense
    ? normalizeOptionalDate(
        rawFormString(formData, "recurring_next_date"),
        "Next expected date"
      )
    : null;
  const recurringEndDateResult = repeatExpense
    ? normalizeOptionalDate(
        rawFormString(formData, "recurring_end_date"),
        "Recurring end date"
      )
    : null;

  const validationError = getValidationError([
    expenseDateResult,
    vendorNameResult,
    categoryResult,
    paymentMethodResult,
    relatedEventIdResult,
    notesResult,
    ...(recurringFrequencyResult ? [recurringFrequencyResult] : []),
    ...(recurringNextDateResult ? [recurringNextDateResult] : []),
    ...(recurringEndDateResult ? [recurringEndDateResult] : []),
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

  const category = getValidatedValue(categoryResult);

  const expensePayload = {
    studio_id: context.studioId,
    recorded_by: user.id,
    expense_date: expenseDate,
    vendor_name: getValidatedValue(vendorNameResult),
    category,
    accounting_category: expenseAccountingCategory(category),
    amount,
    currency: "USD",
    payment_method: getValidatedValue(paymentMethodResult),
    related_event_id: getValidatedValue(relatedEventIdResult),
    notes: getValidatedValue(notesResult) || null,
  };

  const { data: createdExpense, error } = await supabase
    .from("expenses")
    .insert(expensePayload)
    .select("id")
    .single<{ id: string }>();

  if (error || !createdExpense) {
    throw new Error(`Could not add expense: ${error?.message ?? "Unknown error."}`);
  }

  if (repeatExpense && recurringFrequencyResult) {
    const recurringFrequency = getValidatedValue(recurringFrequencyResult);
    const requestedNextDate = recurringNextDateResult
      ? getValidatedValue(recurringNextDateResult)
      : null;
    const recurringEndDate = recurringEndDateResult
      ? getValidatedValue(recurringEndDateResult)
      : null;
    const nextDueDate =
      requestedNextDate || nextRecurringDate(expenseDate, recurringFrequency);

    if (recurringEndDate && recurringEndDate < nextDueDate) {
      throw new Error("Recurring end date must be on or after the next expected date.");
    }

    const { error: recurringError } = await supabase
      .from("recurring_expense_schedules")
      .insert({
        studio_id: context.studioId,
        created_by: user.id,
        vendor_name: expensePayload.vendor_name,
        category: expensePayload.category,
        accounting_category: expensePayload.accounting_category,
        amount: expensePayload.amount,
        currency: expensePayload.currency,
        payment_method: expensePayload.payment_method,
        related_event_id: expensePayload.related_event_id,
        notes: expensePayload.notes,
        frequency: recurringFrequency,
        next_due_date: nextDueDate,
        end_date: recurringEndDate,
        status: "active",
        last_recorded_expense_id: createdExpense.id,
        last_recorded_at: new Date().toISOString(),
      });

    if (recurringError) {
      throw new Error(
        `Expense was added, but the recurring schedule could not be created: ${recurringError.message}`
      );
    }
  }

  revalidatePath("/app/expenses");
  revalidatePath("/app/reports");
}

export async function voidExpenseAction(formData: FormData) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in to void an expense.");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active workspace was found.");
  }

  const canManage = Boolean(context.isPlatformAdmin) ||
    canManageOrganizerExpenses(context.studioRole) ||
    ["studio_owner", "studio_admin", "independent_instructor"].includes(
      context.studioRole ?? "",
    );

  if (!canManage) {
    throw new Error("You do not have permission to void expenses.");
  }

  const expenseIdResult = normalizeOptionalUuid(
    rawFormString(formData, "expense_id"),
    "Expense",
  );
  const reasonResult = cleanTextValue(rawFormString(formData, "void_reason"), {
    fieldLabel: "Void reason",
    maxLength: 500,
    required: true,
  });

  const validationError = getValidationError([expenseIdResult, reasonResult]);

  if (validationError) {
    throw new Error(validationError);
  }

  if (!expenseIdResult.ok || !expenseIdResult.value) {
    throw new Error("Expense ID is required.");
  }

  const voidReason = getValidatedValue(reasonResult);

  if (!voidReason) {
    throw new Error("A reason is required to void an expense.");
  }

  const { data: expense, error: lookupError } = await supabase
    .from("expenses")
    .select("id, voided_at")
    .eq("id", expenseIdResult.value)
    .eq("studio_id", context.studioId)
    .single();

  if (lookupError || !expense) {
    throw new Error("The expense could not be found.");
  }

  if (expense.voided_at) {
    throw new Error("This expense has already been voided.");
  }

  const { error } = await supabase
    .from("expenses")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: user.id,
      void_reason: voidReason,
    })
    .eq("id", expense.id)
    .eq("studio_id", context.studioId)
    .is("voided_at", null);

  if (error) {
    throw new Error(`Could not void expense: ${error.message}`);
  }

  revalidatePath("/app/expenses");
  revalidatePath("/app/reports");
}

export async function recordRecurringExpenseAction(formData: FormData) {
  const { supabase, user, context } = await requireExpenseManager();
  const scheduleIdResult = normalizeOptionalUuid(
    rawFormString(formData, "schedule_id"),
    "Recurring expense"
  );

  if (!scheduleIdResult.ok || !scheduleIdResult.value) {
    throw new Error("Recurring expense ID is required.");
  }

  const { data: schedule, error: scheduleError } = await supabase
    .from("recurring_expense_schedules")
    .select(`
      id,
      vendor_name,
      category,
      accounting_category,
      amount,
      currency,
      payment_method,
      related_event_id,
      notes,
      frequency,
      next_due_date,
      end_date,
      status
    `)
    .eq("id", scheduleIdResult.value)
    .eq("studio_id", context.studioId)
    .single();

  if (scheduleError || !schedule) {
    throw new Error("The recurring expense could not be found.");
  }

  if (schedule.status !== "active") {
    throw new Error("Resume this recurring expense before recording it.");
  }

  const { data: expense, error: expenseError } = await supabase
    .from("expenses")
    .insert({
      studio_id: context.studioId,
      recorded_by: user.id,
      expense_date: schedule.next_due_date,
      vendor_name: schedule.vendor_name,
      category: schedule.category,
      accounting_category: schedule.accounting_category,
      amount: schedule.amount,
      currency: schedule.currency,
      payment_method: schedule.payment_method,
      related_event_id: schedule.related_event_id,
      notes: schedule.notes,
      recurring_schedule_id: schedule.id,
    })
    .select("id")
    .single<{ id: string }>();

  if (expenseError || !expense) {
    throw new Error(`Could not record recurring expense: ${expenseError?.message ?? "Unknown error."}`);
  }

  const nextDueDate = nextRecurringDate(schedule.next_due_date, schedule.frequency);
  const completed = Boolean(schedule.end_date && nextDueDate > schedule.end_date);

  const { error: updateError } = await supabase
    .from("recurring_expense_schedules")
    .update({
      next_due_date: nextDueDate,
      status: completed ? "completed" : "active",
      last_recorded_expense_id: expense.id,
      last_recorded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", schedule.id)
    .eq("studio_id", context.studioId);

  if (updateError) {
    throw new Error(`Expense was recorded, but the schedule could not advance: ${updateError.message}`);
  }

  revalidatePath("/app/expenses");
  revalidatePath("/app/reports");
}

export async function skipRecurringExpenseAction(formData: FormData) {
  const { supabase, context } = await requireExpenseManager();
  const scheduleIdResult = normalizeOptionalUuid(
    rawFormString(formData, "schedule_id"),
    "Recurring expense"
  );

  if (!scheduleIdResult.ok || !scheduleIdResult.value) {
    throw new Error("Recurring expense ID is required.");
  }

  const { data: schedule, error: lookupError } = await supabase
    .from("recurring_expense_schedules")
    .select("id, frequency, next_due_date, end_date, status")
    .eq("id", scheduleIdResult.value)
    .eq("studio_id", context.studioId)
    .single();

  if (lookupError || !schedule) {
    throw new Error("The recurring expense could not be found.");
  }

  if (schedule.status !== "active") {
    throw new Error("Only active recurring expenses can be skipped.");
  }

  const nextDueDate = nextRecurringDate(schedule.next_due_date, schedule.frequency);
  const completed = Boolean(schedule.end_date && nextDueDate > schedule.end_date);

  const { error } = await supabase
    .from("recurring_expense_schedules")
    .update({
      next_due_date: nextDueDate,
      status: completed ? "completed" : "active",
      updated_at: new Date().toISOString(),
    })
    .eq("id", schedule.id)
    .eq("studio_id", context.studioId);

  if (error) {
    throw new Error(`Could not skip recurring expense: ${error.message}`);
  }

  revalidatePath("/app/expenses");
}

export async function setRecurringExpenseStatusAction(formData: FormData) {
  const { supabase, context } = await requireExpenseManager();
  const scheduleIdResult = normalizeOptionalUuid(
    rawFormString(formData, "schedule_id"),
    "Recurring expense"
  );
  const requestedStatus = rawFormString(formData, "status");

  if (!scheduleIdResult.ok || !scheduleIdResult.value) {
    throw new Error("Recurring expense ID is required.");
  }

  if (requestedStatus !== "active" && requestedStatus !== "paused") {
    throw new Error("Recurring expense status is invalid.");
  }

  const { error } = await supabase
    .from("recurring_expense_schedules")
    .update({
      status: requestedStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", scheduleIdResult.value)
    .eq("studio_id", context.studioId)
    .neq("status", "completed");

  if (error) {
    throw new Error(`Could not update recurring expense: ${error.message}`);
  }

  revalidatePath("/app/expenses");
}
