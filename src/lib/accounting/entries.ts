import type { SupabaseClient } from "@supabase/supabase-js";

type PaymentRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  client_package_id: string | null;
  client_membership_id: string | null;
  amount: number | null;
  currency: string | null;
  payment_method: string | null;
  payment_type: string | null;
  source: string | null;
  status: string | null;
  notes: string | null;
  paid_at: string | null;
  created_at: string;
  external_payment_id?: string | null;
  external_reference?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_charge_id?: string | null;
  stripe_invoice_id?: string | null;
  stripe_processing_fee_amount?: number | string | null;
  stripe_application_fee_amount?: number | string | null;
  platform_fee_amount?: number | string | null;
  stripe_balance_transaction_id?: string | null;
};

type EventPaymentRow = {
  id: string;
  registration_id: string | null;
  amount: number | null;
  currency: string | null;
  payment_method: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
  created_at: string;
  external_reference?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_charge_id?: string | null;
  stripe_processing_fee_amount?: number | string | null;
  stripe_application_fee_amount?: number | string | null;
  platform_fee_amount?: number | string | null;
  stripe_balance_transaction_id?: string | null;
  event_registrations:
    | {
        id: string;
        studio_id: string | null;
        event_id: string | null;
        client_id?: string | null;
        events:
          | { id: string; name: string | null; organizer_id?: string | null }
          | { id: string; name: string | null; organizer_id?: string | null }[]
          | null;
      }
    | Array<{
        id: string;
        studio_id: string | null;
        event_id: string | null;
        client_id?: string | null;
        events:
          | { id: string; name: string | null; organizer_id?: string | null }
          | { id: string; name: string | null; organizer_id?: string | null }[]
          | null;
      }>
    | null;
};

type ExpenseRow = {
  id: string;
  studio_id: string;
  expense_date: string;
  vendor_name: string | null;
  category: string | null;
  amount: number | null;
  currency: string | null;
  payment_method: string | null;
  notes: string | null;
  created_at: string;
};

export type AccountingEntryType =
  | "revenue"
  | "refund"
  | "processing_fee"
  | "platform_fee"
  | "expense"
  | "credit_applied"
  | "adjustment";

export type AccountingEntry = {
  id: string;
  studioId: string | null;
  organizerId: string | null;
  entryDate: string;
  entryType: AccountingEntryType;
  category: string;
  categoryLabel: string;
  direction: "credit" | "debit";
  grossAmount: number;
  feeAmount: number;
  refundAmount: number;
  netAmount: number;
  currency: string;
  paymentMethod: string | null;
  sourceTable: string;
  sourceId: string;
  clientId: string | null;
  eventId: string | null;
  appointmentId: string | null;
  externalReference: string | null;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  stripeInvoiceId: string | null;
  description: string;
  status: string | null;
  createdAt: string;
};

function toNumber(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toCurrency(value: string | null | undefined) {
  return (value || "USD").toUpperCase();
}

function toDateOnly(value: string | null | undefined) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function first<T>(value: T | T[] | null | undefined) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function accountingCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    private_lesson_revenue: "Private Lesson Revenue",
    group_class_revenue: "Group Class Revenue",
    package_revenue: "Package Revenue",
    membership_revenue: "Membership Revenue",
    event_ticket_revenue: "Event Ticket Revenue",
    coach_private_lesson_revenue: "Coach Private Lesson Revenue",
    floor_rental_revenue: "Floor Rental Revenue",
    practice_party_revenue: "Practice Party Revenue",
    manual_payment_revenue: "Manual Payment Revenue",
    other_revenue: "Other Revenue",
    other_income: "Other Revenue",
    refund: "Refund",
    stripe_processing_fee: "Stripe Processing Fee",
    danceflow_platform_fee: "DanceFlow Platform Fee",
    organizer_platform_fee: "Organizer Platform Fee",
    floor_fee_expense: "Floor Fee Expense",
    rent_expense: "Rent Expense",
    instructor_pay_expense: "Instructor Pay Expense",
    marketing_expense: "Marketing Expense",
    software_expense: "Software Expense",
    supplies_expense: "Supplies Expense",
    event_expense: "Event Expense",
    travel_expense: "Travel Expense",
    other_expense: "Other Expense",
    account_credit: "Account Credit",
    manual_adjustment: "Manual Adjustment",
  };

  return labels[category] ?? category.replaceAll("_", " ");
}

function normalizeAccountingText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_")
    .trim();
}

function paymentText(payment: PaymentRow) {
  return [
    payment.payment_type,
    payment.source,
    payment.notes,
    payment.external_reference,
    payment.external_payment_id,
  ]
    .map(normalizeAccountingText)
    .filter(Boolean)
    .join(" ");
}

function includesAny(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term));
}

function paymentCategory(payment: PaymentRow) {
  const type = normalizeAccountingText(payment.payment_type);
  const source = normalizeAccountingText(payment.source);
  const text = paymentText(payment);

  if (
    payment.client_membership_id ||
    includesAny(text, [
      "membership",
      "membership_sale",
      "membership_payment",
      "membership_subscription",
      "stripe_invoice",
    ])
  ) {
    return "membership_revenue";
  }

  if (
    payment.client_package_id ||
    includesAny(text, [
      "package",
      "package_sale",
      "package_purchase",
      "existing_package_payment",
    ])
  ) {
    return "package_revenue";
  }

  if (
    includesAny(text, [
      "floor_rental",
      "floor_space_rental",
      "floor_fee",
      "floor_space",
      "room_rental",
    ])
  ) {
    return "floor_rental_revenue";
  }

  if (
    includesAny(text, [
      "event_registration",
      "event_ticket",
      "ticket_sale",
      "manual_ticket_sale",
    ])
  ) {
    return "event_ticket_revenue";
  }

  if (
    includesAny(text, [
      "coach_private_lesson",
      "guest_coach_private_lesson",
      "coach_private",
    ])
  ) {
    return "coach_private_lesson_revenue";
  }

  if (
    includesAny(text, [
      "private_lesson",
      "private_lesson_payment",
      "private",
    ])
  ) {
    return "private_lesson_revenue";
  }

  if (
    includesAny(text, [
      "group_class",
      "group_class_payment",
      "class_payment",
      "group",
    ])
  ) {
    return "group_class_revenue";
  }

  if (includesAny(text, ["practice_party", "practice"])) {
    return "practice_party_revenue";
  }

  if (type === "general" && source === "manual") {
    return "manual_payment_revenue";
  }

  return "other_revenue";
}


function positiveMoney(value: number | string | null | undefined) {
  const amount = toNumber(value);
  return amount > 0 ? amount : 0;
}

function paymentFeeEntries(payment: PaymentRow, baseEntry: AccountingEntry) {
  const entries: AccountingEntry[] = [];

  const stripeProcessingFee = positiveMoney(payment.stripe_processing_fee_amount);
  if (stripeProcessingFee > 0) {
    entries.push({
      ...baseEntry,
      id: `payments:${payment.id}:processing_fee:stripe_processing_fee`,
      entryType: "processing_fee",
      category: "stripe_processing_fee",
      categoryLabel: accountingCategoryLabel("stripe_processing_fee"),
      direction: "debit",
      grossAmount: 0,
      feeAmount: stripeProcessingFee,
      refundAmount: 0,
      netAmount: -stripeProcessingFee,
      sourceTable: "payments",
      sourceId: payment.id,
      description: "Stripe processing fee",
      status: payment.status,
    });
  }

  const applicationFee = positiveMoney(payment.stripe_application_fee_amount);
  const platformFee = positiveMoney(payment.platform_fee_amount);
  const danceFlowPlatformFee = platformFee || applicationFee;

  if (danceFlowPlatformFee > 0) {
    entries.push({
      ...baseEntry,
      id: `payments:${payment.id}:platform_fee:danceflow_platform_fee`,
      entryType: "platform_fee",
      category: "danceflow_platform_fee",
      categoryLabel: accountingCategoryLabel("danceflow_platform_fee"),
      direction: "debit",
      grossAmount: 0,
      feeAmount: danceFlowPlatformFee,
      refundAmount: 0,
      netAmount: -danceFlowPlatformFee,
      sourceTable: "payments",
      sourceId: payment.id,
      description: "DanceFlow platform fee",
      status: payment.status,
    });
  }

  return entries;
}

function eventPaymentFeeEntries(payment: EventPaymentRow, baseEntry: AccountingEntry) {
  const entries: AccountingEntry[] = [];

  const stripeProcessingFee = positiveMoney(payment.stripe_processing_fee_amount);
  if (stripeProcessingFee > 0) {
    entries.push({
      ...baseEntry,
      id: `event_payments:${payment.id}:processing_fee:stripe_processing_fee`,
      entryType: "processing_fee",
      category: "stripe_processing_fee",
      categoryLabel: accountingCategoryLabel("stripe_processing_fee"),
      direction: "debit",
      grossAmount: 0,
      feeAmount: stripeProcessingFee,
      refundAmount: 0,
      netAmount: -stripeProcessingFee,
      sourceTable: "event_payments",
      sourceId: payment.id,
      description: "Stripe processing fee",
      status: payment.status,
    });
  }

  const applicationFee = positiveMoney(payment.stripe_application_fee_amount);
  const platformFee = positiveMoney(payment.platform_fee_amount);
  const organizerPlatformFee = platformFee || applicationFee;

  if (organizerPlatformFee > 0) {
    entries.push({
      ...baseEntry,
      id: `event_payments:${payment.id}:platform_fee:organizer_platform_fee`,
      entryType: "platform_fee",
      category: "organizer_platform_fee",
      categoryLabel: accountingCategoryLabel("organizer_platform_fee"),
      direction: "debit",
      grossAmount: 0,
      feeAmount: organizerPlatformFee,
      refundAmount: 0,
      netAmount: -organizerPlatformFee,
      sourceTable: "event_payments",
      sourceId: payment.id,
      description: "Organizer platform fee",
      status: payment.status,
    });
  }

  return entries;
}

function expenseCategory(expense: ExpenseRow) {
  const category = (expense.category ?? "other").toLowerCase();
  if (category === "floor_fee") return "floor_fee_expense";
  if (category === "rent") return "rent_expense";
  if (category === "instructor_pay") return "instructor_pay_expense";
  if (category === "marketing") return "marketing_expense";
  if (category === "software") return "software_expense";
  if (category === "supplies") return "supplies_expense";
  if (category === "event_expense") return "event_expense";
  if (category === "travel") return "travel_expense";
  return "other_expense";
}

function isRefunded(status: string | null | undefined) {
  return (status ?? "").toLowerCase() === "refunded";
}

function isPaidLike(status: string | null | undefined) {
  return ["paid", "processed", "complete", "completed", "refunded"].includes(
    (status ?? "").toLowerCase(),
  );
}

function paymentToEntries(payment: PaymentRow): AccountingEntry[] {
  if (!isPaidLike(payment.status)) return [];

  const amount = toNumber(payment.amount);
  const refunded = isRefunded(payment.status);
  const entryType: AccountingEntryType = refunded ? "refund" : "revenue";
  const category = refunded ? "refund" : paymentCategory(payment);

  const baseEntry: AccountingEntry = {
    id: `payments:${payment.id}:${entryType}:${category}`,
    studioId: payment.studio_id,
    organizerId: null,
    entryDate: toDateOnly(payment.paid_at ?? payment.created_at),
    entryType,
    category,
    categoryLabel: accountingCategoryLabel(category),
    direction: refunded ? "debit" : "credit",
    grossAmount: refunded ? 0 : amount,
    feeAmount: 0,
    refundAmount: refunded ? amount : 0,
    netAmount: refunded ? -amount : amount,
    currency: toCurrency(payment.currency),
    paymentMethod: payment.payment_method,
    sourceTable: "payments",
    sourceId: payment.id,
    clientId: payment.client_id,
    eventId: null,
    appointmentId: null,
    externalReference:
      payment.external_reference ?? payment.external_payment_id ?? null,
    stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
    stripeChargeId: payment.stripe_charge_id ?? null,
    stripeInvoiceId: payment.stripe_invoice_id ?? null,
    description: payment.notes || accountingCategoryLabel(category),
    status: payment.status,
    createdAt: payment.created_at,
  };

  if (refunded) return [baseEntry];

  return [baseEntry, ...paymentFeeEntries(payment, baseEntry)];
}

function eventPaymentToEntries(payment: EventPaymentRow): AccountingEntry[] {
  if (!isPaidLike(payment.status)) return [];

  const registration = first(payment.event_registrations);
  if (!registration?.studio_id) return [];

  const event = first(registration.events);
  const amount = toNumber(payment.amount);
  const refunded = isRefunded(payment.status);
  const entryType: AccountingEntryType = refunded ? "refund" : "revenue";
  const category = refunded ? "refund" : "event_ticket_revenue";

  const baseEntry: AccountingEntry = {
    id: `event_payments:${payment.id}:${entryType}:${category}`,
    studioId: registration.studio_id,
    organizerId: event?.organizer_id ?? null,
    entryDate: toDateOnly(payment.created_at),
    entryType,
    category,
    categoryLabel: accountingCategoryLabel(category),
    direction: refunded ? "debit" : "credit",
    grossAmount: refunded ? 0 : amount,
    feeAmount: 0,
    refundAmount: refunded ? amount : 0,
    netAmount: refunded ? -amount : amount,
    currency: toCurrency(payment.currency),
    paymentMethod: payment.payment_method,
    sourceTable: "event_payments",
    sourceId: payment.id,
    clientId: registration.client_id ?? null,
    eventId: registration.event_id,
    appointmentId: null,
    externalReference: payment.external_reference ?? null,
    stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
    stripeChargeId: payment.stripe_charge_id ?? null,
    stripeInvoiceId: null,
    description: payment.notes || event?.name || "Event ticket revenue",
    status: payment.status,
    createdAt: payment.created_at,
  };

  if (refunded) return [baseEntry];

  return [baseEntry, ...eventPaymentFeeEntries(payment, baseEntry)];
}

function expenseToEntry(expense: ExpenseRow): AccountingEntry {
  const category = expenseCategory(expense);
  const amount = toNumber(expense.amount);

  return {
    id: `expenses:${expense.id}:expense:${category}`,
    studioId: expense.studio_id,
    organizerId: null,
    entryDate: expense.expense_date,
    entryType: "expense",
    category,
    categoryLabel: accountingCategoryLabel(category),
    direction: "debit",
    grossAmount: 0,
    feeAmount: 0,
    refundAmount: 0,
    netAmount: -amount,
    currency: toCurrency(expense.currency),
    paymentMethod: expense.payment_method,
    sourceTable: "expenses",
    sourceId: expense.id,
    clientId: null,
    eventId: null,
    appointmentId: null,
    externalReference: null,
    stripePaymentIntentId: null,
    stripeChargeId: null,
    stripeInvoiceId: null,
    description: [expense.vendor_name, expense.notes].filter(Boolean).join(" — ") || accountingCategoryLabel(category),
    status: "paid",
    createdAt: expense.created_at,
  };
}

export async function getStudioAccountingEntries({
  supabase,
  studioId,
  startDate,
  endDate,
}: {
  supabase: SupabaseClient;
  studioId: string;
  startDate: string;
  endDate: string;
}) {
  const [paymentsResult, eventPaymentsResult, expensesResult] = await Promise.all([
    supabase
      .from("payments")
      .select(
        "id, studio_id, client_id, client_package_id, client_membership_id, amount, currency, payment_method, payment_type, source, status, notes, paid_at, created_at, external_payment_id, external_reference, stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id, stripe_processing_fee_amount, stripe_application_fee_amount, platform_fee_amount, stripe_balance_transaction_id",
      )
      .eq("studio_id", studioId)
      .gte("created_at", startDate)
      .lte("created_at", endDate)
      .limit(5000),
    supabase
      .from("event_payments")
      .select(
        `id, registration_id, amount, currency, payment_method, status, source, notes, created_at, external_reference, stripe_payment_intent_id, stripe_charge_id, stripe_processing_fee_amount, stripe_application_fee_amount, platform_fee_amount, stripe_balance_transaction_id,
        event_registrations!inner (
          id,
          studio_id,
          event_id,
          client_id,
          events (
            id,
            name,
            organizer_id
          )
        )`,
      )
      .eq("event_registrations.studio_id", studioId)
      .gte("created_at", startDate)
      .lte("created_at", endDate)
      .limit(5000),
    supabase
      .from("expenses")
      .select("id, studio_id, expense_date, vendor_name, category, amount, currency, payment_method, notes, created_at")
      .eq("studio_id", studioId)
      .gte("expense_date", startDate.slice(0, 10))
      .lte("expense_date", endDate.slice(0, 10))
      .limit(5000),
  ]);

  if (paymentsResult.error) {
    throw new Error(`Accounting payments lookup failed: ${paymentsResult.error.message}`);
  }

  if (eventPaymentsResult.error) {
    throw new Error(
      `Accounting event payments lookup failed: ${eventPaymentsResult.error.message}`,
    );
  }

  if (expensesResult.error) {
    throw new Error(`Accounting expenses lookup failed: ${expensesResult.error.message}`);
  }

  const entries = [
    ...((paymentsResult.data ?? []) as PaymentRow[])
      .flatMap(paymentToEntries),
    ...((eventPaymentsResult.data ?? []) as EventPaymentRow[])
      .flatMap(eventPaymentToEntries),
    ...((expensesResult.data ?? []) as ExpenseRow[]).map(expenseToEntry),
  ].sort((a, b) => {
    if (a.entryDate === b.entryDate) return b.createdAt.localeCompare(a.createdAt);
    return b.entryDate.localeCompare(a.entryDate);
  });

  return entries;
}

export function summarizeAccountingEntries(entries: AccountingEntry[]) {
  return entries.reduce(
    (summary, entry) => {
      if (entry.entryType === "revenue") summary.revenue += entry.grossAmount;
      if (entry.entryType === "refund") summary.refunds += entry.refundAmount;
      if (entry.entryType === "expense") summary.expenses += Math.abs(entry.netAmount);
      if (entry.entryType === "processing_fee" || entry.entryType === "platform_fee") {
        summary.fees += Math.abs(entry.netAmount || entry.feeAmount);
      }
      summary.net += entry.netAmount;
      return summary;
    },
    { revenue: 0, refunds: 0, expenses: 0, fees: 0, net: 0 },
  );
}
