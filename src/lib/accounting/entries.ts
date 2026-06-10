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
  refund_amount?: number | string | null;
  refunded_at?: string | null;
  stripe_refund_id?: string | null;
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
  stripe_invoice_id?: string | null;
  stripe_processing_fee_amount?: number | string | null;
  stripe_application_fee_amount?: number | string | null;
  platform_fee_amount?: number | string | null;
  stripe_balance_transaction_id?: string | null;
  refund_amount?: number | string | null;
  refunded_at?: string | null;
  stripe_refund_id?: string | null;
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
    other_income: "Other Income",
    refund: "Refund",
    client_payment_refund: "Client Payment Refund",
    package_refund: "Package Refund",
    membership_refund: "Membership Refund",
    floor_rental_refund: "Floor Rental Refund",
    event_ticket_refund: "Event Ticket Refund",
    other_refund: "Other Refund",
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

function paymentCategory(payment: PaymentRow) {
  const type = (payment.payment_type ?? "").toLowerCase();
  const source = (payment.source ?? "").toLowerCase();
  const notes = (payment.notes ?? "").toLowerCase();

  if (type.includes("membership")) return "membership_revenue";
  if (type.includes("package") || payment.client_package_id) return "package_revenue";
  if (type.includes("floor") || source.includes("floor")) return "floor_rental_revenue";
  if (type.includes("event")) return "event_ticket_revenue";
  if (type.includes("private")) return "private_lesson_revenue";
  if (type.includes("group")) return "group_class_revenue";
  if (notes.includes("practice")) return "practice_party_revenue";
  return "other_income";
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


function isPaidLike(status: string | null | undefined) {
  return ["paid", "processed", "complete", "completed", "refunded", "partial"].includes(
    (status ?? "").toLowerCase(),
  );
}

function hasPositiveAmount(value: number | string | null | undefined) {
  return toNumber(value) > 0;
}

function paymentRefundCategory(payment: PaymentRow) {
  const revenueCategory = paymentCategory(payment);

  if (revenueCategory === "package_revenue") return "package_refund";
  if (revenueCategory === "membership_revenue") return "membership_refund";
  if (revenueCategory === "floor_rental_revenue") return "floor_rental_refund";

  return "client_payment_refund";
}

function paymentRevenueEntry(payment: PaymentRow): AccountingEntry | null {
  if (!isPaidLike(payment.status)) return null;

  const amount = toNumber(payment.amount);
  if (amount <= 0) return null;

  const category = paymentCategory(payment);

  return {
    id: `payments:${payment.id}:revenue:${category}`,
    studioId: payment.studio_id,
    organizerId: null,
    entryDate: toDateOnly(payment.paid_at ?? payment.created_at),
    entryType: "revenue",
    category,
    categoryLabel: accountingCategoryLabel(category),
    direction: "credit",
    grossAmount: amount,
    feeAmount: 0,
    refundAmount: 0,
    netAmount: amount,
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
}

function paymentRefundEntry(payment: PaymentRow): AccountingEntry | null {
  if (!isPaidLike(payment.status)) return null;

  const explicitRefundAmount = toNumber(payment.refund_amount);
  const status = (payment.status ?? "").toLowerCase();
  const refundAmount =
    explicitRefundAmount > 0
      ? explicitRefundAmount
      : status === "refunded"
        ? toNumber(payment.amount)
        : 0;

  if (refundAmount <= 0) return null;

  const category = paymentRefundCategory(payment);

  return {
    id: `payments:${payment.id}:refund:${category}`,
    studioId: payment.studio_id,
    organizerId: null,
    entryDate: toDateOnly(payment.refunded_at ?? payment.paid_at ?? payment.created_at),
    entryType: "refund",
    category,
    categoryLabel: accountingCategoryLabel(category),
    direction: "debit",
    grossAmount: 0,
    feeAmount: 0,
    refundAmount,
    netAmount: -refundAmount,
    currency: toCurrency(payment.currency),
    paymentMethod: payment.payment_method,
    sourceTable: "payments",
    sourceId: payment.id,
    clientId: payment.client_id,
    eventId: null,
    appointmentId: null,
    externalReference:
      payment.stripe_refund_id ??
      payment.external_reference ??
      payment.external_payment_id ??
      null,
    stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
    stripeChargeId: payment.stripe_charge_id ?? null,
    stripeInvoiceId: payment.stripe_invoice_id ?? null,
    description: `${accountingCategoryLabel(category)} — ${payment.notes || "Stripe refund"}`,
    status: payment.status,
    createdAt: payment.refunded_at ?? payment.created_at,
  };
}

function paymentFeeEntries(payment: PaymentRow): AccountingEntry[] {
  if (!isPaidLike(payment.status)) return [];

  const entries: AccountingEntry[] = [];
  const stripeProcessingFee = toNumber(payment.stripe_processing_fee_amount);
  const platformFee =
    toNumber(payment.platform_fee_amount) ||
    toNumber(payment.stripe_application_fee_amount);

  if (stripeProcessingFee > 0) {
    entries.push({
      id: `payments:${payment.id}:processing_fee:stripe_processing_fee`,
      studioId: payment.studio_id,
      organizerId: null,
      entryDate: toDateOnly(payment.paid_at ?? payment.created_at),
      entryType: "processing_fee",
      category: "stripe_processing_fee",
      categoryLabel: accountingCategoryLabel("stripe_processing_fee"),
      direction: "debit",
      grossAmount: 0,
      feeAmount: stripeProcessingFee,
      refundAmount: 0,
      netAmount: -stripeProcessingFee,
      currency: toCurrency(payment.currency),
      paymentMethod: payment.payment_method,
      sourceTable: "payments",
      sourceId: payment.id,
      clientId: payment.client_id,
      eventId: null,
      appointmentId: null,
      externalReference: payment.stripe_balance_transaction_id ?? payment.external_reference ?? null,
      stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
      stripeChargeId: payment.stripe_charge_id ?? null,
      stripeInvoiceId: payment.stripe_invoice_id ?? null,
      description: "Stripe processing fee",
      status: payment.status,
      createdAt: payment.created_at,
    });
  }

  if (platformFee > 0) {
    entries.push({
      id: `payments:${payment.id}:platform_fee:danceflow_platform_fee`,
      studioId: payment.studio_id,
      organizerId: null,
      entryDate: toDateOnly(payment.paid_at ?? payment.created_at),
      entryType: "platform_fee",
      category: "danceflow_platform_fee",
      categoryLabel: accountingCategoryLabel("danceflow_platform_fee"),
      direction: "debit",
      grossAmount: 0,
      feeAmount: platformFee,
      refundAmount: 0,
      netAmount: -platformFee,
      currency: toCurrency(payment.currency),
      paymentMethod: payment.payment_method,
      sourceTable: "payments",
      sourceId: payment.id,
      clientId: payment.client_id,
      eventId: null,
      appointmentId: null,
      externalReference: payment.stripe_balance_transaction_id ?? payment.external_reference ?? null,
      stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
      stripeChargeId: payment.stripe_charge_id ?? null,
      stripeInvoiceId: payment.stripe_invoice_id ?? null,
      description: "DanceFlow platform fee",
      status: payment.status,
      createdAt: payment.created_at,
    });
  }

  return entries;
}

function eventPaymentRevenueEntry(payment: EventPaymentRow): AccountingEntry | null {
  if (!isPaidLike(payment.status)) return null;

  const registration = first(payment.event_registrations);
  if (!registration?.studio_id) return null;

  const event = first(registration.events);
  const amount = toNumber(payment.amount);
  if (amount <= 0) return null;

  const category = "event_ticket_revenue";

  return {
    id: `event_payments:${payment.id}:revenue:${category}`,
    studioId: registration.studio_id,
    organizerId: event?.organizer_id ?? null,
    entryDate: toDateOnly(payment.created_at),
    entryType: "revenue",
    category,
    categoryLabel: accountingCategoryLabel(category),
    direction: "credit",
    grossAmount: amount,
    feeAmount: 0,
    refundAmount: 0,
    netAmount: amount,
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
    stripeInvoiceId: payment.stripe_invoice_id ?? null,
    description: payment.notes || event?.name || "Event ticket revenue",
    status: payment.status,
    createdAt: payment.created_at,
  };
}

function eventPaymentRefundEntry(payment: EventPaymentRow): AccountingEntry | null {
  if (!isPaidLike(payment.status)) return null;

  const registration = first(payment.event_registrations);
  if (!registration?.studio_id) return null;

  const event = first(registration.events);
  const explicitRefundAmount = toNumber(payment.refund_amount);
  const status = (payment.status ?? "").toLowerCase();
  const refundAmount =
    explicitRefundAmount > 0
      ? explicitRefundAmount
      : status === "refunded"
        ? toNumber(payment.amount)
        : 0;

  if (refundAmount <= 0) return null;

  const category = "event_ticket_refund";

  return {
    id: `event_payments:${payment.id}:refund:${category}`,
    studioId: registration.studio_id,
    organizerId: event?.organizer_id ?? null,
    entryDate: toDateOnly(payment.refunded_at ?? payment.created_at),
    entryType: "refund",
    category,
    categoryLabel: accountingCategoryLabel(category),
    direction: "debit",
    grossAmount: 0,
    feeAmount: 0,
    refundAmount,
    netAmount: -refundAmount,
    currency: toCurrency(payment.currency),
    paymentMethod: payment.payment_method,
    sourceTable: "event_payments",
    sourceId: payment.id,
    clientId: registration.client_id ?? null,
    eventId: registration.event_id,
    appointmentId: null,
    externalReference: payment.stripe_refund_id ?? payment.external_reference ?? null,
    stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
    stripeChargeId: payment.stripe_charge_id ?? null,
    stripeInvoiceId: payment.stripe_invoice_id ?? null,
    description: `${accountingCategoryLabel(category)} — ${payment.notes || event?.name || "Stripe refund"}`,
    status: payment.status,
    createdAt: payment.refunded_at ?? payment.created_at,
  };
}

function eventPaymentFeeEntries(payment: EventPaymentRow): AccountingEntry[] {
  if (!isPaidLike(payment.status)) return [];

  const registration = first(payment.event_registrations);
  if (!registration?.studio_id) return [];

  const event = first(registration.events);
  const entries: AccountingEntry[] = [];
  const stripeProcessingFee = toNumber(payment.stripe_processing_fee_amount);
  const platformFee =
    toNumber(payment.platform_fee_amount) ||
    toNumber(payment.stripe_application_fee_amount);

  if (stripeProcessingFee > 0) {
    entries.push({
      id: `event_payments:${payment.id}:processing_fee:stripe_processing_fee`,
      studioId: registration.studio_id,
      organizerId: event?.organizer_id ?? null,
      entryDate: toDateOnly(payment.created_at),
      entryType: "processing_fee",
      category: "stripe_processing_fee",
      categoryLabel: accountingCategoryLabel("stripe_processing_fee"),
      direction: "debit",
      grossAmount: 0,
      feeAmount: stripeProcessingFee,
      refundAmount: 0,
      netAmount: -stripeProcessingFee,
      currency: toCurrency(payment.currency),
      paymentMethod: payment.payment_method,
      sourceTable: "event_payments",
      sourceId: payment.id,
      clientId: registration.client_id ?? null,
      eventId: registration.event_id,
      appointmentId: null,
      externalReference: payment.stripe_balance_transaction_id ?? payment.external_reference ?? null,
      stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
      stripeChargeId: payment.stripe_charge_id ?? null,
      stripeInvoiceId: payment.stripe_invoice_id ?? null,
      description: "Stripe processing fee",
      status: payment.status,
      createdAt: payment.created_at,
    });
  }

  if (platformFee > 0) {
    entries.push({
      id: `event_payments:${payment.id}:platform_fee:organizer_platform_fee`,
      studioId: registration.studio_id,
      organizerId: event?.organizer_id ?? null,
      entryDate: toDateOnly(payment.created_at),
      entryType: "platform_fee",
      category: "organizer_platform_fee",
      categoryLabel: accountingCategoryLabel("organizer_platform_fee"),
      direction: "debit",
      grossAmount: 0,
      feeAmount: platformFee,
      refundAmount: 0,
      netAmount: -platformFee,
      currency: toCurrency(payment.currency),
      paymentMethod: payment.payment_method,
      sourceTable: "event_payments",
      sourceId: payment.id,
      clientId: registration.client_id ?? null,
      eventId: registration.event_id,
      appointmentId: null,
      externalReference: payment.stripe_balance_transaction_id ?? payment.external_reference ?? null,
      stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
      stripeChargeId: payment.stripe_charge_id ?? null,
      stripeInvoiceId: payment.stripe_invoice_id ?? null,
      description: "Organizer platform fee",
      status: payment.status,
      createdAt: payment.created_at,
    });
  }

  return entries;
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
        "id, studio_id, client_id, client_package_id, client_membership_id, amount, currency, payment_method, payment_type, source, status, notes, paid_at, created_at, external_payment_id, external_reference, stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id, stripe_processing_fee_amount, stripe_application_fee_amount, platform_fee_amount, stripe_balance_transaction_id, refund_amount, refunded_at, stripe_refund_id",
      )
      .eq("studio_id", studioId)
      .gte("created_at", startDate)
      .lte("created_at", endDate)
      .limit(5000),
    supabase
      .from("event_payments")
      .select(
        `id, registration_id, amount, currency, payment_method, status, source, notes, created_at, external_reference, stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id, stripe_processing_fee_amount, stripe_application_fee_amount, platform_fee_amount, stripe_balance_transaction_id, refund_amount, refunded_at, stripe_refund_id,
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

  const paymentEntries = ((paymentsResult.data ?? []) as PaymentRow[]).flatMap(
    (payment) =>
      [
        paymentRevenueEntry(payment),
        paymentRefundEntry(payment),
        ...paymentFeeEntries(payment),
      ].filter((entry): entry is AccountingEntry => Boolean(entry)),
  );

  const eventPaymentEntries = ((eventPaymentsResult.data ?? []) as EventPaymentRow[]).flatMap(
    (payment) =>
      [
        eventPaymentRevenueEntry(payment),
        eventPaymentRefundEntry(payment),
        ...eventPaymentFeeEntries(payment),
      ].filter((entry): entry is AccountingEntry => Boolean(entry)),
  );

  const entries = [
    ...paymentEntries,
    ...eventPaymentEntries,
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
