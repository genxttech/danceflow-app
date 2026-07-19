export type EventProfitabilityInput = {
  gross_ticket_revenue?: number | string | null;
  refunds?: number | string | null;
  processing_and_platform_fees?: number | string | null;
  net_ticket_revenue?: number | string | null;
  event_expenses?: number | string | null;
  event_labor_costs?: number | string | null;
  total_event_costs?: number | string | null;
  event_profit_loss?: number | string | null;
};

export type EventRegistrationFinancialInput = {
  payment_status?: string | null;
  status?: string | null;
};

export type EventTicketAttendanceInput = {
  checked_in_at?: string | null;
};

export type EventFinancialSummary = {
  grossTicketRevenue: number;
  refunds: number;
  processingAndPlatformFees: number;
  netTicketRevenue: number;
  eventExpenses: number;
  eventLaborCosts: number;
  totalEventCosts: number;
  eventProfitLoss: number;
  margin: number | null;
  registrations: number;
  paidRegistrations: number;
  unpaidRegistrations: number;
  pendingRegistrations: number;
  refundedRegistrations: number;
  ticketsIssued: number;
  ticketsCheckedIn: number;
  checkInRate: number | null;
};

const PAID_PAYMENT_STATUSES = new Set([
  "paid",
  "partial",
  "comped",
  "free",
]);

const UNPAID_PAYMENT_STATUSES = new Set([
  "unpaid",
  "failed",
  "requires_payment",
]);

const PENDING_PAYMENT_STATUSES = new Set([
  "pending",
  "processing",
  "requires_action",
]);

function normalizedStatus(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export function eventFinancialNumber(
  value: number | string | null | undefined,
) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export function buildEventFinancialSummary(params: {
  profitability?: EventProfitabilityInput | null;
  registrations?: EventRegistrationFinancialInput[] | null;
  attendees?: EventTicketAttendanceInput[] | null;
  ticketsIssuedOverride?: number | null;
  ticketsCheckedInOverride?: number | null;
}): EventFinancialSummary {
  const profitability = params.profitability ?? {};
  const registrations = params.registrations ?? [];
  const attendees = params.attendees ?? [];

  const grossTicketRevenue = eventFinancialNumber(
    profitability.gross_ticket_revenue,
  );
  const refunds = eventFinancialNumber(profitability.refunds);
  const processingAndPlatformFees = eventFinancialNumber(
    profitability.processing_and_platform_fees,
  );
  const netTicketRevenue = eventFinancialNumber(
    profitability.net_ticket_revenue,
  );
  const eventExpenses = eventFinancialNumber(profitability.event_expenses);
  const eventLaborCosts = eventFinancialNumber(
    profitability.event_labor_costs,
  );
  const recordedTotalCosts = eventFinancialNumber(
    profitability.total_event_costs,
  );
  const totalEventCosts =
    recordedTotalCosts || eventExpenses + eventLaborCosts;
  const eventProfitLoss = eventFinancialNumber(
    profitability.event_profit_loss,
  );
  const margin =
    netTicketRevenue > 0 ? eventProfitLoss / netTicketRevenue : null;

  let paidRegistrations = 0;
  let unpaidRegistrations = 0;
  let pendingRegistrations = 0;
  let refundedRegistrations = 0;

  for (const registration of registrations) {
    const paymentStatus = normalizedStatus(registration.payment_status);
    const registrationStatus = normalizedStatus(registration.status);

    if (PAID_PAYMENT_STATUSES.has(paymentStatus)) {
      paidRegistrations += 1;
    }

    if (UNPAID_PAYMENT_STATUSES.has(paymentStatus)) {
      unpaidRegistrations += 1;
    }

    if (PENDING_PAYMENT_STATUSES.has(paymentStatus)) {
      pendingRegistrations += 1;
    }

    if (
      paymentStatus.includes("refund") ||
      registrationStatus.includes("refund")
    ) {
      refundedRegistrations += 1;
    }
  }

  const attendeeTicketsIssued = attendees.length;
  const attendeeTicketsCheckedIn = attendees.filter((attendee) =>
    Boolean(attendee.checked_in_at),
  ).length;
  const ticketsIssued =
    params.ticketsIssuedOverride != null
      ? Math.max(0, params.ticketsIssuedOverride)
      : attendeeTicketsIssued;
  const ticketsCheckedIn =
    params.ticketsCheckedInOverride != null
      ? Math.max(0, params.ticketsCheckedInOverride)
      : attendeeTicketsCheckedIn;
  const checkInRate =
    ticketsIssued > 0 ? ticketsCheckedIn / ticketsIssued : null;

  return {
    grossTicketRevenue,
    refunds,
    processingAndPlatformFees,
    netTicketRevenue,
    eventExpenses,
    eventLaborCosts,
    totalEventCosts,
    eventProfitLoss,
    margin,
    registrations: registrations.length,
    paidRegistrations,
    unpaidRegistrations,
    pendingRegistrations,
    refundedRegistrations,
    ticketsIssued,
    ticketsCheckedIn,
    checkInRate,
  };
}


export type EventAccountingFinancialInput = {
  eventId?: string | null;
  event_id?: string | null;
  sourceTable?: string | null;
  source_table?: string | null;
  category?: string | null;
  grossAmount?: number | string | null;
  gross_amount?: number | string | null;
  feeAmount?: number | string | null;
  fee_amount?: number | string | null;
  refundAmount?: number | string | null;
  refund_amount?: number | string | null;
  netAmount?: number | string | null;
  net_amount?: number | string | null;
};

export function buildEventProfitabilityByEventId(
  entries: EventAccountingFinancialInput[],
) {
  const grouped = new Map<string, EventProfitabilityInput>();

  for (const entry of entries) {
    const eventId = entry.eventId ?? entry.event_id;
    if (!eventId) continue;

    const sourceTable = entry.sourceTable ?? entry.source_table ?? "";
    const category = entry.category ?? "";
    const current = grouped.get(eventId) ?? {
      gross_ticket_revenue: 0,
      refunds: 0,
      processing_and_platform_fees: 0,
      net_ticket_revenue: 0,
      event_expenses: 0,
      event_labor_costs: 0,
      total_event_costs: 0,
      event_profit_loss: 0,
    };

    if (
      sourceTable === "event_payments" &&
      category === "event_ticket_revenue"
    ) {
      current.gross_ticket_revenue =
        eventFinancialNumber(current.gross_ticket_revenue) +
        eventFinancialNumber(entry.grossAmount ?? entry.gross_amount);
      current.refunds =
        eventFinancialNumber(current.refunds) +
        Math.abs(
          eventFinancialNumber(entry.refundAmount ?? entry.refund_amount),
        );
      current.processing_and_platform_fees =
        eventFinancialNumber(current.processing_and_platform_fees) +
        Math.abs(eventFinancialNumber(entry.feeAmount ?? entry.fee_amount));
      current.net_ticket_revenue =
        eventFinancialNumber(current.net_ticket_revenue) +
        eventFinancialNumber(entry.netAmount ?? entry.net_amount);
    } else if (
      sourceTable === "event_labor_costs" &&
      category === "event_labor_expense"
    ) {
      current.event_labor_costs =
        eventFinancialNumber(current.event_labor_costs) +
        Math.abs(eventFinancialNumber(entry.netAmount ?? entry.net_amount));
    } else if (sourceTable === "expenses") {
      current.event_expenses =
        eventFinancialNumber(current.event_expenses) +
        Math.abs(eventFinancialNumber(entry.netAmount ?? entry.net_amount));
    }

    grouped.set(eventId, current);
  }

  for (const profitability of grouped.values()) {
    const eventExpenses = eventFinancialNumber(
      profitability.event_expenses,
    );
    const eventLaborCosts = eventFinancialNumber(
      profitability.event_labor_costs,
    );
    const totalEventCosts = eventExpenses + eventLaborCosts;
    const netTicketRevenue = eventFinancialNumber(
      profitability.net_ticket_revenue,
    );

    profitability.total_event_costs = totalEventCosts;
    profitability.event_profit_loss =
      netTicketRevenue - totalEventCosts;
  }

  return grouped;
}
