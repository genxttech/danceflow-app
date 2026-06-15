import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  createTicketTypeAction,
  updateTicketTypeAction,
} from "./tickets/actions";
import { duplicateEventAction } from "../actions";
import {
  createEventLaborCostAction,
  deleteEventLaborCostAction,
} from "./labor/actions";
import { updateEventSettlementAction } from "./settlement/actions";

type TicketTypeRow = {
  id: string;
  name: string;
  description: string | null;
  ticket_kind: string;
  price: number | string;
  currency: string;
  capacity: number | null;
  sort_order: number;
  active: boolean;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  attendees_per_ticket: number | null;
};

type EventRow = {
  id: string;
  studio_id: string;
  organizer_id: string | null;
  name: string;
  slug: string;
  status: string;
  visibility: string;
};

type EventProfitLossRow = {
  event_id: string;
  gross_ticket_revenue: number | string | null;
  refunds: number | string | null;
  processing_and_platform_fees: number | string | null;
  net_ticket_revenue: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
  total_event_costs: number | string | null;
  event_profit_loss: number | string | null;
};

type EventRegistrationCheckInRow = {
  id: string;
  payment_status: string | null;
  status: string | null;
  quantity: number | string | null;
  checked_in_at: string | null;
};

type EventAttendeeCheckInRow = {
  id: string;
  registration_id: string | null;
  checked_in_at: string | null;
};

type EventLaborCostRow = {
  id: string;
  staff_name: string;
  role: string;
  pay_type: string;
  rate_amount: number | string | null;
  hours: number | string | null;
  quantity: number | string | null;
  total_amount: number | string | null;
  currency: string | null;
  labor_date: string | null;
  status: string | null;
  notes: string | null;
};

type EventSettlementRow = {
  id: string;
  status: string | null;
  notes: string | null;
  gross_ticket_revenue: number | string | null;
  refunds: number | string | null;
  processing_and_platform_fees: number | string | null;
  net_ticket_revenue: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
  total_event_costs: number | string | null;
  event_profit_loss: number | string | null;
  margin: number | string | null;
  paid_registrations: number | string | null;
  tickets_issued: number | string | null;
  tickets_checked_in: number | string | null;
  unpaid_registrations: number | string | null;
  pending_registrations: number | string | null;
  refunded_registrations: number | string | null;
  settled_at: string | null;
  settled_by: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type EventSettlementHistoryRow = {
  id: string;
  previous_status: string | null;
  new_status: string | null;
  notes: string | null;
  event_profit_loss: number | string | null;
  margin: number | string | null;
  total_event_costs: number | string | null;
  net_ticket_revenue: number | string | null;
  tickets_checked_in: number | string | null;
  tickets_issued: number | string | null;
  changed_by: string | null;
  changed_at: string | null;
};


function canManageTickets(params: {
  isPlatformAdmin: boolean;
  organizerUserRole: string | null;
  studioRole: string | null;
  isStudioHosted: boolean;
}) {
  const { isPlatformAdmin, organizerUserRole, studioRole, isStudioHosted } = params;

  if (isPlatformAdmin) return true;

  if (["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUserRole ?? "")) {
    return true;
  }

  if (isStudioHosted && ["studio_owner", "studio_admin"].includes(studioRole ?? "")) {
    return true;
  }

  return false;
}

function formatPrice(value: number | string, currency: string) {
  const amount = typeof value === "number" ? value : Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

function toNumber(value: number | string | null | undefined) {
  const amount = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";

  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function profitStatus(profitLoss: number, margin: number | null) {
  if (profitLoss < 0) {
    return {
      label: "Losing money",
      className: "border-rose-200 bg-rose-50 text-rose-800",
      helper: "Expenses, refunds, and fees are currently higher than net ticket revenue.",
    };
  }

  if (margin !== null && margin < 0.15) {
    return {
      label: "Low margin",
      className: "border-amber-200 bg-amber-50 text-amber-800",
      helper: "This event is profitable, but the current margin is thin.",
    };
  }

  if (profitLoss > 0) {
    return {
      label: "Profitable",
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
      helper: "Ticket revenue is currently covering recorded event costs.",
    };
  }

  return {
    label: "Break-even",
    className: "border-slate-200 bg-slate-50 text-slate-700",
    helper: "No profit or loss is showing yet for this event.",
  };
}

function ticketStatusLabel(ticket: TicketTypeRow) {
  const now = Date.now();

  if (!ticket.active) {
    return {
      label: "Inactive",
      className: "bg-slate-100 text-slate-700 border border-slate-200",
    };
  }

  if (ticket.sale_starts_at && new Date(ticket.sale_starts_at).getTime() > now) {
    return {
      label: "Scheduled",
      className: "bg-blue-50 text-blue-700 border border-blue-200",
    };
  }

  if (ticket.sale_ends_at && new Date(ticket.sale_ends_at).getTime() < now) {
    return {
      label: "Ended",
      className: "bg-slate-100 text-slate-700 border border-slate-200",
    };
  }

  return {
    label: "On sale",
    className: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  };
}

function formatTicketKind(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}


function toDatetimeLocal(value: string | null) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function formatDateTime(value: string | null) {
  if (!value) return "Not set";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDate(value: string | null) {
  if (!value) return "Not set";

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function todayDateInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function formatPayType(value: string | null | undefined) {
  return String(value ?? "manual")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}



function settlementStatusMeta(value: string | null | undefined) {
  switch (value) {
    case "ready_to_settle":
      return {
        label: "Ready to settle",
        className: "border-amber-200 bg-amber-50 text-amber-800",
        helper: "Financials look reviewed and this event is ready for final closeout.",
      };
    case "settled":
      return {
        label: "Settled",
        className: "border-emerald-200 bg-emerald-50 text-emerald-800",
        helper: "A final settlement snapshot has been saved for this event.",
      };
    case "reopened":
      return {
        label: "Reopened",
        className: "border-sky-200 bg-sky-50 text-sky-800",
        helper: "This event was reopened after settlement for corrections or late adjustments.",
      };
    default:
      return {
        label: "Open",
        className: "border-slate-200 bg-slate-50 text-slate-700",
        helper: "This event is still open for financial review and closeout preparation.",
      };
  }
}

function formatSettlementStatusLabel(value: string | null | undefined) {
  return settlementStatusMeta(value ?? "open").label;
}

function derivedSettlementReadiness(params: {
  unpaidRegistrations: number;
  pendingRegistrations: number;
  issuedTicketCount: number;
  hasFinancialActivity: boolean;
  eventExpenses: number;
  eventLaborCosts: number;
}) {
  const {
    unpaidRegistrations,
    pendingRegistrations,
    issuedTicketCount,
    hasFinancialActivity,
    eventExpenses,
    eventLaborCosts,
  } = params;

  if (!hasFinancialActivity && issuedTicketCount === 0) {
    return {
      label: "Not ready",
      className: "border-slate-200 bg-slate-50 text-slate-700",
      helper: "No ticket or financial activity has been recorded yet.",
    };
  }

  if (unpaidRegistrations > 0 || pendingRegistrations > 0) {
    return {
      label: "Needs payment review",
      className: "border-amber-200 bg-amber-50 text-amber-800",
      helper: "Review unpaid or pending registrations before marking the event ready to settle.",
    };
  }

  if (eventExpenses === 0 && eventLaborCosts === 0) {
    return {
      label: "Check costs",
      className: "border-amber-200 bg-amber-50 text-amber-800",
      helper: "No event-specific expenses or labor costs are recorded. Confirm that is correct before settlement.",
    };
  }

  return {
    label: "Ready candidate",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    helper: "Payments and costs look ready for event closeout review.",
  };
}

type SettlementChecklistSeverity = "clear" | "warning" | "critical";

function settlementChecklistStyle(severity: SettlementChecklistSeverity) {
  switch (severity) {
    case "critical":
      return {
        badge: "Needs review",
        className: "border-rose-200 bg-rose-50 text-rose-800",
        dotClassName: "bg-rose-500",
      };
    case "warning":
      return {
        badge: "Check",
        className: "border-amber-200 bg-amber-50 text-amber-800",
        dotClassName: "bg-amber-500",
      };
    default:
      return {
        badge: "Clear",
        className: "border-emerald-200 bg-emerald-50 text-emerald-800",
        dotClassName: "bg-emerald-500",
      };
  }
}

function formatCurrency(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

export default async function EventTicketsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!context) {
    notFound();
  }

  const { studioId, studioRole, isPlatformAdmin } = context;

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select(`
      id,
      studio_id,
      organizer_id,
      name,
      slug,
      status,
      visibility
    `)
    .eq("id", id)
    .eq("studio_id", studioId)
    .single();

  if (eventError || !event) {
    notFound();
  }

  const typedEvent = event as EventRow;
  const isStudioHosted = !typedEvent.organizer_id;

  let organizerUserRole: string | null = null;

  if (typedEvent.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", typedEvent.organizer_id)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle();

    organizerUserRole = organizerUser?.role ?? null;
  }

  const canManage = canManageTickets({
    isPlatformAdmin: Boolean(isPlatformAdmin),
    organizerUserRole,
    studioRole: studioRole ?? null,
    isStudioHosted,
  });

  const { data: tickets, error: ticketsError } = await supabase
    .from("event_ticket_types")
    .select(`
      id,
      name,
      description,
      ticket_kind,
      price,
      currency,
      capacity,
      sort_order,
      active,
      sale_starts_at,
      sale_ends_at,
      attendees_per_ticket
    `)
    .eq("event_id", typedEvent.id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (ticketsError) {
    throw new Error(`Failed to load tickets: ${ticketsError.message}`);
  }

  const { count: privateLessonSlotCount } = await supabase
    .from("event_private_lesson_slots")
    .select("id", { count: "exact", head: true })
    .eq("event_id", typedEvent.id)
    .eq("studio_id", studioId);

  const hasPrivateLessonSlots = Number(privateLessonSlotCount ?? 0) > 0;

  const [
    profitabilityResult,
    registrationsResult,
    attendeesResult,
    laborCostsResult,
    settlementResult,
    settlementHistoryResult,
  ] = await Promise.all([
    (supabase as any)
      .from("v_event_profit_loss")
      .select("event_id, gross_ticket_revenue, refunds, processing_and_platform_fees, net_ticket_revenue, event_expenses, event_labor_costs, total_event_costs, event_profit_loss")
      .eq("event_id", typedEvent.id)
      .maybeSingle(),
    supabase
      .from("event_registrations")
      .select("id, payment_status, status, quantity, checked_in_at")
      .eq("event_id", typedEvent.id),
    supabase
      .from("event_registration_attendees")
      .select("id, registration_id, checked_in_at")
      .eq("event_id", typedEvent.id),
    (supabase as any)
      .from("event_labor_costs")
      .select("id, staff_name, role, pay_type, rate_amount, hours, quantity, total_amount, currency, labor_date, status, notes")
      .eq("event_id", typedEvent.id)
      .neq("status", "cancelled")
      .order("labor_date", { ascending: false })
      .order("created_at", { ascending: false }),
    (supabase as any)
      .from("event_settlements")
      .select("id, status, notes, gross_ticket_revenue, refunds, processing_and_platform_fees, net_ticket_revenue, event_expenses, event_labor_costs, total_event_costs, event_profit_loss, margin, paid_registrations, tickets_issued, tickets_checked_in, unpaid_registrations, pending_registrations, refunded_registrations, settled_at, settled_by, created_at, updated_at")
      .eq("event_id", typedEvent.id)
      .maybeSingle(),
    (supabase as any)
      .from("event_settlement_history")
      .select("id, previous_status, new_status, notes, event_profit_loss, margin, total_event_costs, net_ticket_revenue, tickets_checked_in, tickets_issued, changed_by, changed_at")
      .eq("event_id", typedEvent.id)
      .order("changed_at", { ascending: false })
      .limit(10),
  ]);

  if (registrationsResult.error) {
    throw new Error(`Failed to load registration profitability context: ${registrationsResult.error.message}`);
  }

  if (attendeesResult.error) {
  console.warn(
    "Failed to load attendee profitability context:",
    attendeesResult.error.message
  );
}

  if (laborCostsResult.error) {
    throw new Error(`Failed to load event labor costs: ${laborCostsResult.error.message}`);
  }

  if (settlementResult.error) {
    throw new Error(`Failed to load event settlement: ${settlementResult.error.message}`);
  }

  if (settlementHistoryResult.error) {
    throw new Error(`Failed to load event settlement history: ${settlementHistoryResult.error.message}`);
  }

  const profitability = profitabilityResult.data as EventProfitLossRow | null;
  const registrationRows = (registrationsResult.data ?? []) as EventRegistrationCheckInRow[];
  const attendeeRows = (attendeesResult.error ? [] : attendeesResult.data ?? []) as EventAttendeeCheckInRow[];
  const laborCostRows = (laborCostsResult.data ?? []) as EventLaborCostRow[];
  const settlement = settlementResult.data as EventSettlementRow | null;
  const settlementHistoryRows = (settlementHistoryResult.data ?? []) as EventSettlementHistoryRow[];

  const ticketRows = (tickets ?? []) as TicketTypeRow[];
  const activeCount = ticketRows.filter((ticket) => ticket.active).length;

  const grossTicketRevenue = toNumber(profitability?.gross_ticket_revenue);
  const refunds = toNumber(profitability?.refunds);
  const processingAndPlatformFees = toNumber(profitability?.processing_and_platform_fees);
  const netTicketRevenue = toNumber(profitability?.net_ticket_revenue);
  const eventExpenses = toNumber(profitability?.event_expenses);
  const eventLaborCosts = toNumber(profitability?.event_labor_costs);
  const totalEventCosts = toNumber(profitability?.total_event_costs) || eventExpenses + eventLaborCosts;
  const eventProfitLoss = toNumber(profitability?.event_profit_loss);
  const profitMargin = netTicketRevenue > 0 ? eventProfitLoss / netTicketRevenue : null;
  const status = profitStatus(eventProfitLoss, profitMargin);

  const paidRegistrations = registrationRows.filter((registration) =>
    ["paid", "partial", "comped", "free"].includes((registration.payment_status ?? "").toLowerCase()),
  );
  const unpaidRegistrations = registrationRows.filter((registration) =>
    ["unpaid", "failed", "requires_payment"].includes((registration.payment_status ?? "").toLowerCase()),
  ).length;
  const pendingRegistrations = registrationRows.filter((registration) =>
    ["pending", "processing", "requires_action"].includes((registration.payment_status ?? "").toLowerCase()),
  ).length;
  const refundedRegistrations = registrationRows.filter((registration) => {
    const paymentStatus = (registration.payment_status ?? "").toLowerCase();
    const registrationStatus = (registration.status ?? "").toLowerCase();
    return paymentStatus.includes("refund") || registrationStatus.includes("refund");
  }).length;
  const issuedTicketCount = attendeeRows.length;
  const checkedInTicketCount = attendeeRows.filter((attendee) => attendee.checked_in_at).length;
  const remainingTicketCount = Math.max(issuedTicketCount - checkedInTicketCount, 0);
  const checkInRate = issuedTicketCount > 0 ? checkedInTicketCount / issuedTicketCount : null;
  const profitPerCheckedIn = checkedInTicketCount > 0 ? eventProfitLoss / checkedInTicketCount : null;
  const hasFinancialActivity =
    grossTicketRevenue > 0 ||
    refunds > 0 ||
    processingAndPlatformFees > 0 ||
    netTicketRevenue > 0 ||
    eventExpenses > 0 ||
    eventLaborCosts > 0;
  const settlementStatus = settlementStatusMeta(settlement?.status ?? "open");
  const settlementReadiness = derivedSettlementReadiness({
    unpaidRegistrations,
    pendingRegistrations,
    issuedTicketCount,
    hasFinancialActivity,
    eventExpenses,
    eventLaborCosts,
  });
  const uncheckedIssuedTickets = Math.max(issuedTicketCount - checkedInTicketCount, 0);
  const isSettled = (settlement?.status ?? "open") === "settled";
  const isReopened = (settlement?.status ?? "open") === "reopened";
  const eventFinancialsLocked = isSettled;
  const lowMarginThreshold = 0.15;
  const settlementChecklistItems: Array<{
    label: string;
    detail: string;
    severity: SettlementChecklistSeverity;
  }> = [
    {
      label: "Payment exceptions",
      detail:
        unpaidRegistrations > 0 || pendingRegistrations > 0
          ? `${unpaidRegistrations} unpaid and ${pendingRegistrations} pending registrations need review.`
          : "No unpaid or pending registrations were found.",
      severity: unpaidRegistrations > 0 || pendingRegistrations > 0 ? "critical" : "clear",
    },
    {
      label: "Refund activity",
      detail:
        refundedRegistrations > 0
          ? `${refundedRegistrations} refunded registrations are included in the closeout numbers.`
          : "No refunded registrations were found.",
      severity: refundedRegistrations > 0 ? "warning" : "clear",
    },
    {
      label: "Issued ticket check-in",
      detail:
        issuedTicketCount === 0
          ? "No issued attendee tickets were found."
          : uncheckedIssuedTickets > 0
            ? `${uncheckedIssuedTickets} of ${issuedTicketCount} issued tickets are not checked in.`
            : "All issued tickets are checked in.",
      severity: uncheckedIssuedTickets > 0 ? "warning" : "clear",
    },
    {
      label: "Labor / staff costs",
      detail:
        eventLaborCosts > 0
          ? `${formatCurrency(eventLaborCosts)} in labor or staff costs is linked to this event.`
          : "No labor or staff costs are linked to this event.",
      severity: eventLaborCosts > 0 ? "clear" : "warning",
    },
    {
      label: "Event expenses",
      detail:
        eventExpenses > 0
          ? `${formatCurrency(eventExpenses)} in event expenses is linked to this event.`
          : "No event-specific expenses are linked to this event.",
      severity: eventExpenses > 0 ? "clear" : "warning",
    },
    {
      label: "Profitability",
      detail:
        eventProfitLoss < 0
          ? `This event is currently negative by ${formatCurrency(Math.abs(eventProfitLoss))}.`
          : profitMargin !== null && profitMargin < lowMarginThreshold
            ? `Profit is positive, but margin is low at ${formatPercent(profitMargin)}.`
            : `Current profit/loss is ${formatCurrency(eventProfitLoss)}${profitMargin !== null ? ` with ${formatPercent(profitMargin)} margin` : ""}.`,
      severity:
        eventProfitLoss < 0
          ? "critical"
          : profitMargin !== null && profitMargin < lowMarginThreshold
            ? "warning"
            : "clear",
    },
    {
      label: "Settlement state",
      detail: isSettled
        ? "This event is marked settled. Reopen before making material changes."
        : isReopened
          ? "This event was reopened. Review any changes before settling again."
          : "This event is still editable before final settlement.",
      severity: isReopened ? "warning" : "clear",
    },
  ];
  const checklistCriticalCount = settlementChecklistItems.filter((item) => item.severity === "critical").length;
  const checklistWarningCount = settlementChecklistItems.filter((item) => item.severity === "warning").length;
  const checklistClearCount = settlementChecklistItems.filter((item) => item.severity === "clear").length;
  const checklistSummary =
    checklistCriticalCount > 0
      ? `${checklistCriticalCount} must-review item${checklistCriticalCount === 1 ? "" : "s"} before settlement.`
      : checklistWarningCount > 0
        ? `${checklistWarningCount} advisory item${checklistWarningCount === 1 ? "" : "s"} to confirm before settlement.`
        : "All checklist items are clear.";

  const eventAriaInsights: Array<{
    title: string;
    detail: string;
    tone: "positive" | "warning" | "critical";
    actionLabel: string;
    actionHref: string;
  }> = [];

  if (eventFinancialsLocked) {
    eventAriaInsights.push({
      title: "This event is settled and locked",
      detail:
        "ARIA sees this event as financially closed. Keep exports and history available, but reopen before changing labor, expenses, or closeout notes.",
      tone: "positive",
      actionLabel: "View settlement history",
      actionHref: `#settlement-history`,
    });
  } else if (checklistCriticalCount > 0) {
    eventAriaInsights.push({
      title: "Do not settle this event yet",
      detail: `${checklistCriticalCount} closeout item${checklistCriticalCount === 1 ? "" : "s"} still need review before this event should be settled.`,
      tone: "critical",
      actionLabel: "Review checklist",
      actionHref: `#closeout-readiness`,
    });
  } else if (checklistWarningCount > 0) {
    eventAriaInsights.push({
      title: "This event is close to settlement-ready",
      detail: `${checklistWarningCount} advisory item${checklistWarningCount === 1 ? "" : "s"} should be confirmed, then this event can likely move to ready-to-settle.`,
      tone: "warning",
      actionLabel: "Review closeout",
      actionHref: `#event-closeout`,
    });
  } else {
    eventAriaInsights.push({
      title: "This event looks ready to settle",
      detail:
        "Payment exceptions, check-ins, labor, expenses, and profitability checks are clear based on the current data.",
      tone: "positive",
      actionLabel: "Open closeout",
      actionHref: `#event-closeout`,
    });
  }

  if (eventProfitLoss < 0) {
    eventAriaInsights.push({
      title: "Profitability is negative",
      detail: `ARIA sees a current loss of ${formatCurrency(Math.abs(eventProfitLoss))}. Review pricing, refunds, fees, labor, and event expenses before repeating this format.`,
      tone: "critical",
      actionLabel: "Review financials",
      actionHref: `#event-financial-health`,
    });
  } else if (profitMargin !== null && profitMargin < lowMarginThreshold && netTicketRevenue > 0) {
    eventAriaInsights.push({
      title: "Margin is thin",
      detail: `The current margin is ${formatPercent(profitMargin)}. This may still be profitable, but ARIA recommends reviewing costs before using this as a repeatable model.`,
      tone: "warning",
      actionLabel: "Review costs",
      actionHref: `#event-financial-health`,
    });
  } else if (eventProfitLoss > 0 && profitMargin !== null && profitMargin >= 0.25) {
    eventAriaInsights.push({
      title: "Strong repeat-event signal",
      detail: `This event is profitable with a ${formatPercent(profitMargin)} margin. ARIA would consider it a candidate to repeat if attendance and feedback were strong.`,
      tone: "positive",
      actionLabel: "Duplicate event",
      actionHref: `#event-actions`,
    });
  }

  if (eventLaborCosts === 0 || eventExpenses === 0) {
    const missing = [
      eventLaborCosts === 0 ? "labor/staff costs" : null,
      eventExpenses === 0 ? "event expenses" : null,
    ].filter(Boolean).join(" and ");

    eventAriaInsights.push({
      title: "Closeout data may be incomplete",
      detail: `ARIA does not see ${missing} linked to this event. Confirm whether this event truly had no related costs before settling.`,
      tone: "warning",
      actionLabel: "Review costs",
      actionHref: `#event-labor-costs`,
    });
  }

  if (checkInRate !== null && checkInRate < 0.7 && issuedTicketCount > 0) {
    eventAriaInsights.push({
      title: "Check-in rate is low",
      detail: `${checkedInTicketCount} of ${issuedTicketCount} issued tickets are checked in. ARIA recommends confirming whether walk-ins, no-shows, or missed scans explain the gap.`,
      tone: "warning",
      actionLabel: "Open check-in",
      actionHref: `/app/events/${typedEvent.id}/check-in`,
    });
  }

  if (unpaidRegistrations > 0 || pendingRegistrations > 0) {
    eventAriaInsights.push({
      title: "Registration exceptions need follow-up",
      detail: `${unpaidRegistrations} unpaid and ${pendingRegistrations} pending registrations may affect final revenue and closeout confidence.`,
      tone: "critical",
      actionLabel: "Review registrations",
      actionHref: `/app/events/${typedEvent.id}/registrations`,
    });
  }

  const visibleEventAriaInsights = eventAriaInsights.slice(0, 4);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-gradient-to-r from-[#2D0B45] via-[#5B197A] to-[#7C2D92] text-white shadow-sm">
        <div className="flex flex-col gap-6 px-6 py-6 md:flex-row md:items-start md:justify-between md:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#F3D7FF]">
              Event ticket setup
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Manage tickets for {typedEvent.name}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/85 md:text-base">
              Build ticket options, set pricing, and control when sales open and close so your
              public registration flow is ready for dancers.
            </p>
          </div>

          <div id="event-actions" className="flex flex-wrap gap-3">
            <Link
              href="/app/events"
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Back to Events
            </Link>
            <Link
              href={`/app/events/${typedEvent.id}/edit`}
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Edit Event
            </Link>
            <Link
              href={`/app/events/${typedEvent.id}/tickets`}
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Manage Tickets
            </Link>
            <Link
              href={`/app/events/${typedEvent.id}/registrations`}
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Manage registrations
            </Link>
            {hasPrivateLessonSlots ? (
              <Link
                href={`/app/events/${typedEvent.id}/private-lessons`}
                className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
              >
                Manage Coach Slots
              </Link>
            ) : null}
            <form action={duplicateEventAction}>
              <input type="hidden" name="eventId" value={typedEvent.id} />
              <button
                type="submit"
                className="inline-flex w-full items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
              >
                Duplicate Event
              </button>
            </form>

            <Link
              href={`/events/${typedEvent.slug}`}
              className="inline-flex items-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#5B197A] transition hover:bg-[#F9F1FF]"
            >
              View public page
            </Link>
          </div>
        </div>

        <div className="grid gap-3 border-t border-white/10 bg-black/10 px-6 py-4 md:grid-cols-4 md:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Event status</p>
            <p className="mt-1 text-sm font-semibold capitalize">{typedEvent.status}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Visibility</p>
            <p className="mt-1 text-sm font-semibold capitalize">
              {typedEvent.visibility.replaceAll("_", " ")}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Ticket types</p>
            <p className="mt-1 text-sm font-semibold">{ticketRows.length}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Currently active</p>
            <p className="mt-1 text-sm font-semibold">{activeCount}</p>
          </div>
        </div>
      </section>

      <section id="event-financial-health" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
              Running event profitability
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">Financial health for this event</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              This snapshot updates as ticket payments, refunds, fees, check-ins, and event-linked expenses are recorded.
            </p>
          </div>

          <span className={`inline-flex rounded-full border px-3 py-1 text-sm font-semibold ${status.className}`}>
            {status.label}
          </span>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Gross revenue</p>
            <p className="mt-2 text-xl font-semibold text-slate-950">
              {formatPrice(grossTicketRevenue, "USD")}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Refunds</p>
            <p className="mt-2 text-xl font-semibold text-rose-700">
              -{formatPrice(refunds, "USD")}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Fees</p>
            <p className="mt-2 text-xl font-semibold text-amber-700">
              -{formatPrice(processingAndPlatformFees, "USD")}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Event expenses</p>
            <p className="mt-2 text-xl font-semibold text-rose-700">
              -{formatPrice(eventExpenses, "USD")}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Labor / staff</p>
            <p className="mt-2 text-xl font-semibold text-rose-700">
              -{formatPrice(eventLaborCosts, "USD")}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Total costs</p>
            <p className="mt-2 text-xl font-semibold text-rose-700">
              -{formatPrice(totalEventCosts, "USD")}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Profit / loss</p>
            <p className={`mt-2 text-xl font-semibold ${eventProfitLoss < 0 ? "text-rose-700" : "text-emerald-700"}`}>
              {formatPrice(eventProfitLoss, "USD")}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Margin</p>
            <p className="mt-2 text-xl font-semibold text-slate-950">{formatPercent(profitMargin)}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-[#7C2D92]">Paid registrations</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">{paidRegistrations.length}</p>
          </div>
          <div className="rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-[#7C2D92]">QR tickets issued</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">{issuedTicketCount}</p>
          </div>
          <div className="rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-[#7C2D92]">Checked in</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">
              {checkedInTicketCount}/{issuedTicketCount}
            </p>
            <p className="mt-1 text-xs text-slate-500">{formatPercent(checkInRate)} check-in rate</p>
          </div>
          <div className="rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-[#7C2D92]">Profit per checked-in</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">
              {profitPerCheckedIn === null ? "—" : formatPrice(profitPerCheckedIn, "USD")}
            </p>
            <p className="mt-1 text-xs text-slate-500">{remainingTicketCount} tickets remaining</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className={`rounded-2xl border px-4 py-3 text-sm ${status.className}`}>
            <p className="font-semibold">{status.label}</p>
            <p className="mt-1 leading-6">{status.helper}</p>
          </div>

          {hasFinancialActivity && eventExpenses === 0 ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold">No event expenses linked yet</p>
              <p className="mt-1 leading-6">
                Link event-specific costs from Expenses and add staff/labor costs below to make this profitability view more accurate.
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Event-day read</p>
              <p className="mt-1 leading-6">
                Net ticket revenue is {formatPrice(netTicketRevenue, "USD")} after refunds and fees. Total recorded event costs are {formatPrice(totalEventCosts, "USD")}.
              </p>
            </div>
          )}
        </div>


        <div className="mt-5 rounded-3xl border border-[#E9D5FF] bg-gradient-to-br from-[#FCF8FF] to-white p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                ARIA event insights
              </p>
              <h3 className="mt-1 text-lg font-semibold text-slate-950">What ARIA sees in this event</h3>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                ARIA reviews this event’s revenue, closeout readiness, labor, expenses, registration exceptions, and check-in rate to suggest the next operational move.
              </p>
            </div>
            <Link
              href="/app/aria"
              className="inline-flex items-center justify-center rounded-xl border border-[#5B197A]/25 bg-white px-4 py-2 text-sm font-semibold text-[#5B197A] transition hover:bg-[#F9F1FF]"
            >
              Consult with ARIA
            </Link>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {visibleEventAriaInsights.map((insight) => {
              const insightClassName =
                insight.tone === "critical"
                  ? "border-rose-200 bg-rose-50 text-rose-900"
                  : insight.tone === "warning"
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "border-emerald-200 bg-emerald-50 text-emerald-900";

              const dotClassName =
                insight.tone === "critical"
                  ? "bg-rose-500"
                  : insight.tone === "warning"
                    ? "bg-amber-500"
                    : "bg-emerald-500";

              return (
                <div key={insight.title} className={`rounded-2xl border p-4 text-sm ${insightClassName}`}>
                  <div className="flex items-start gap-3">
                    <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${dotClassName}`} />
                    <div className="min-w-0">
                      <p className="font-semibold">{insight.title}</p>
                      <p className="mt-2 leading-6 opacity-90">{insight.detail}</p>
                      <Link
                        href={insight.actionHref}
                        className="mt-3 inline-flex text-xs font-semibold underline-offset-4 hover:underline"
                      >
                        {insight.actionLabel}
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div id="event-closeout" className="mt-5 rounded-3xl border border-[#E9D5FF] bg-[#FCF8FF] p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                Event settlement / closeout
              </p>
              <h3 className="mt-1 text-lg font-semibold text-slate-950">Final event closeout snapshot</h3>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                Use this to review final event revenue, refunds, fees, expenses, labor, check-ins, and payment exceptions before closing the event.
              </p>
            </div>
            <div className="flex flex-col gap-2 md:items-end">
              <div className="flex flex-col gap-2 sm:flex-row md:flex-col">
                <Link
                  href={`/app/events/${typedEvent.id}/settlement/export`}
                  className="inline-flex items-center justify-center rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4A1363]"
                >
                  Download Settlement CSV
                </Link>
                <Link
                  href={`/app/events/${typedEvent.id}/settlement/pdf`}
                  className="inline-flex items-center justify-center rounded-xl border border-[#5B197A]/25 bg-white px-4 py-2 text-sm font-semibold text-[#5B197A] transition hover:bg-[#F9F1FF]"
                >
                  Download Settlement PDF
                </Link>
              </div>
              <span className={`inline-flex rounded-full border px-3 py-1 text-sm font-semibold ${settlementStatus.className}`}>
                {settlementStatus.label}
              </span>
              <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${settlementReadiness.className}`}>
                {settlementReadiness.label}
              </span>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-4">
            <div className="rounded-2xl border border-white bg-white p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Net ticket revenue</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{formatPrice(netTicketRevenue, "USD")}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Total event costs</p>
              <p className="mt-2 text-lg font-semibold text-rose-700">-{formatPrice(totalEventCosts, "USD")}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Final profit / loss</p>
              <p className={`mt-2 text-lg font-semibold ${eventProfitLoss < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                {formatPrice(eventProfitLoss, "USD")}
              </p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Margin</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{formatPercent(profitMargin)}</p>
            </div>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-5">
            <div className="rounded-2xl border border-white bg-white p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Paid</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{paidRegistrations.length}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Unpaid</p>
              <p className="mt-2 text-lg font-semibold text-rose-700">{unpaidRegistrations}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Pending</p>
              <p className="mt-2 text-lg font-semibold text-amber-700">{pendingRegistrations}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Refunded</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{refundedRegistrations}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Checked in</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{checkedInTicketCount}/{issuedTicketCount}</p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className={`rounded-2xl border px-4 py-3 text-sm ${settlementStatus.className}`}>
              <p className="font-semibold">{settlementStatus.label}</p>
              <p className="mt-1 leading-6">{settlementStatus.helper}</p>
              {settlement ? (
                <p className="mt-2 text-xs opacity-80">Last saved {formatDateTime(settlement.updated_at)}{settlement.settled_at ? ` · Settled ${formatDateTime(settlement.settled_at)}` : ""}</p>
              ) : null}
            </div>
            <div className={`rounded-2xl border px-4 py-3 text-sm ${settlementReadiness.className}`}>
              <p className="font-semibold">Closeout readiness</p>
              <p className="mt-1 leading-6">{settlementReadiness.helper}</p>
            </div>
          </div>

          {eventFinancialsLocked ? (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-semibold">Settlement locked</p>
              <p className="mt-1 leading-6">
                This event has been settled. Financial changes are locked unless the settlement is reopened with a reason.
              </p>
            </div>
          ) : null}

          <div id="closeout-readiness" className="mt-5 rounded-2xl border border-[#E9D5FF] bg-white p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <h4 className="text-sm font-semibold text-slate-950">Closeout readiness checklist</h4>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Review these items before marking the event ready to settle or settled. Warnings do not block settlement yet.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-semibold">
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-800">{checklistClearCount} clear</span>
                <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-amber-800">{checklistWarningCount} check</span>
                <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-rose-800">{checklistCriticalCount} review</span>
              </div>
            </div>

            <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
              checklistCriticalCount > 0
                ? "border-rose-200 bg-rose-50 text-rose-800"
                : checklistWarningCount > 0
                  ? "border-amber-200 bg-amber-50 text-amber-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
            }`}>
              <p className="font-semibold">
                {checklistCriticalCount > 0 ? "Needs review" : checklistWarningCount > 0 ? "Ready with confirmations" : "Ready to settle"}
              </p>
              <p className="mt-1 leading-6">{checklistSummary}</p>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {settlementChecklistItems.map((item) => {
                const itemStyle = settlementChecklistStyle(item.severity);

                return (
                  <div key={item.label} className={`rounded-xl border px-4 py-3 text-sm ${itemStyle.className}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${itemStyle.dotClassName}`} />
                          <p className="font-semibold">{item.label}</p>
                        </div>
                        <p className="mt-2 leading-6 opacity-90">{item.detail}</p>
                      </div>
                      <span className="shrink-0 rounded-full border border-current/20 bg-white/60 px-2 py-1 text-[11px] font-semibold">
                        {itemStyle.badge}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {canManage ? (
            eventFinancialsLocked ? (
              <form action={updateEventSettlementAction} className="mt-5 grid gap-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 md:grid-cols-[1fr_auto] md:items-end">
                <input type="hidden" name="event_id" value={typedEvent.id} />
                <input type="hidden" name="status" value="reopened" />

                <label className="space-y-2 text-sm">
                  <span className="font-medium text-amber-950">Reason for reopening settlement</span>
                  <input
                    name="notes"
                    required
                    minLength={8}
                    placeholder="Example: Late refund, corrected labor cost, or missing expense found."
                    className="w-full rounded-xl border border-amber-300 px-3 py-2 outline-none ring-0"
                  />
                </label>

                <button type="submit" className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-800">
                  Reopen Settlement
                </button>
              </form>
            ) : (
              <form action={updateEventSettlementAction} className="mt-5 grid gap-4 rounded-2xl border border-[#E9D5FF] bg-white p-4 md:grid-cols-[240px_1fr_auto] md:items-end">
                <input type="hidden" name="event_id" value={typedEvent.id} />

                <label className="space-y-2 text-sm">
                  <span className="font-medium text-slate-700">Closeout status</span>
                  <select name="status" defaultValue={settlement?.status ?? "open"} className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0">
                    <option value="open">Open</option>
                    <option value="ready_to_settle">Ready to settle</option>
                    <option value="settled">Settled</option>
                    <option value="reopened">Reopened</option>
                  </select>
                </label>

                <label className="space-y-2 text-sm">
                  <span className="font-medium text-slate-700">Settlement notes</span>
                  <input
                    name="notes"
                    defaultValue={settlement?.notes ?? ""}
                    placeholder="Example: Final numbers reviewed after event check-in."
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                  />
                </label>

                <button type="submit" className="rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4A1363]">
                  Save Closeout
                </button>
              </form>
            )
          ) : null}

          <div id="settlement-history" className="mt-5 rounded-2xl border border-[#E9D5FF] bg-white p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <h4 className="text-sm font-semibold text-slate-950">Settlement history</h4>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Tracks closeout status changes and the saved financial snapshot at each step.
                </p>
              </div>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                {settlementHistoryRows.length} recent changes
              </span>
            </div>

            {settlementHistoryRows.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-600">
                No settlement history yet. Save a closeout status to create the first audit entry.
              </div>
            ) : (
              <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                <div className="hidden grid-cols-[1.2fr_1fr_1fr_1fr] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 md:grid">
                  <span>Status change</span>
                  <span>Profit / loss</span>
                  <span>Snapshot</span>
                  <span>Changed</span>
                </div>

                <div className="divide-y divide-slate-200">
                  {settlementHistoryRows.map((history) => {
                    const previousStatus = history.previous_status
                      ? formatSettlementStatusLabel(history.previous_status)
                      : "Initial snapshot";
                    const newStatus = formatSettlementStatusLabel(history.new_status);
                    const historyProfitLoss = toNumber(history.event_profit_loss);
                    const historyMargin = history.margin === null || history.margin === undefined
                      ? null
                      : toNumber(history.margin);

                    return (
                      <div key={history.id} className="grid gap-3 px-4 py-4 text-sm md:grid-cols-[1.2fr_1fr_1fr_1fr] md:items-center">
                        <div>
                          <p className="font-semibold text-slate-950">
                            {previousStatus} → {newStatus}
                          </p>
                          {history.notes ? (
                            <p className="mt-1 text-xs leading-5 text-slate-600">{history.notes}</p>
                          ) : (
                            <p className="mt-1 text-xs text-slate-500">No notes saved for this change.</p>
                          )}
                        </div>

                        <div>
                          <p className={`font-semibold ${historyProfitLoss < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                            {formatPrice(historyProfitLoss, "USD")}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">Margin {formatPercent(historyMargin)}</p>
                        </div>

                        <div className="text-xs leading-5 text-slate-600">
                          <p>Net revenue {formatPrice(toNumber(history.net_ticket_revenue), "USD")}</p>
                          <p>Total costs {formatPrice(toNumber(history.total_event_costs), "USD")}</p>
                          <p>Checked in {toNumber(history.tickets_checked_in)}/{toNumber(history.tickets_issued)}</p>
                        </div>

                        <div>
                          <p className="font-medium text-slate-900">{formatDateTime(history.changed_at)}</p>
                          <p className="mt-1 text-xs text-slate-500">Changed by {history.changed_by ? history.changed_by.slice(0, 8) : "system"}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href={`/app/events/${typedEvent.id}/check-in`}
            className="inline-flex items-center rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4A1363]"
          >
            Open Check-In
          </Link>
          <Link
            href={`/app/events/${typedEvent.id}/registrations`}
            className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Review Registrations
          </Link>
          <Link
            href="/app/expenses"
            className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Add Event Expense
          </Link>
        </div>
      </section>

      <section id="event-labor-costs" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
              Event labor / staff costs
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">Staff costs for this event</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              Add check-in staff, DJs, guest coaches, setup teams, or other event labor. These costs post into the accounting ledger and reduce event profit immediately.
            </p>
          </div>
          <div className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            <p className="font-semibold">Recorded labor</p>
            <p className="mt-1 text-lg font-semibold">-{formatPrice(eventLaborCosts, "USD")}</p>
          </div>
        </div>

        {canManage && eventFinancialsLocked ? (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-semibold">Labor costs are locked</p>
            <p className="mt-1 leading-6">Reopen the settlement before adding, deleting, or changing event labor costs.</p>
          </div>
        ) : null}

        {canManage && !eventFinancialsLocked ? (
          <form action={createEventLaborCostAction} className="mt-5 grid gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-4">
            <input type="hidden" name="event_id" value={typedEvent.id} />

            <label className="space-y-2 text-sm md:col-span-2">
              <span className="font-medium text-slate-700">Staff / vendor name</span>
              <input
                name="staff_name"
                required
                placeholder="Front desk staff, DJ, guest coach..."
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm md:col-span-2">
              <span className="font-medium text-slate-700">Role</span>
              <input
                name="role"
                required
                placeholder="Check-in Staff, DJ, Instructor, Setup"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Pay type</span>
              <select name="pay_type" defaultValue="flat" className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0">
                <option value="flat">Flat fee</option>
                <option value="hourly">Hourly</option>
                <option value="per_session">Per session</option>
                <option value="manual">Manual total</option>
              </select>
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Rate</span>
              <input name="rate_amount" type="number" min="0" step="0.01" defaultValue="0" className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0" />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Hours</span>
              <input name="hours" type="number" min="0" step="0.25" defaultValue="0" className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0" />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Qty / sessions</span>
              <input name="quantity" type="number" min="0" step="1" defaultValue="1" className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0" />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Manual total</span>
              <input name="total_amount" type="number" min="0" step="0.01" placeholder="Optional" className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0" />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Labor date</span>
              <input name="labor_date" type="date" defaultValue={todayDateInputValue()} required className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0" />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Status</span>
              <select name="status" defaultValue="planned" className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0">
                <option value="planned">Planned</option>
                <option value="earned">Earned</option>
                <option value="paid">Paid</option>
              </select>
            </label>

            <label className="space-y-2 text-sm md:col-span-4">
              <span className="font-medium text-slate-700">Notes</span>
              <textarea name="notes" rows={2} placeholder="Optional details for the event ledger" className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0" />
            </label>

            <div className="md:col-span-4">
              <button type="submit" className="rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4A1363]">
                Add Labor Cost
              </button>
            </div>
          </form>
        ) : null}

        <div className="mt-5 space-y-3">
          {laborCostRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-600">
              No event labor costs recorded yet. Add expected staff costs before the event, then update status as costs are earned or paid.
            </div>
          ) : (
            laborCostRows.map((labor) => (
              <div key={labor.id} className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-950">{labor.staff_name}</p>
                    <span className="rounded-full bg-[#F3E8FF] px-2.5 py-1 text-xs font-semibold text-[#6B21A8]">{labor.role}</span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold capitalize text-slate-700">{labor.status ?? "planned"}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {formatPayType(labor.pay_type)} · Rate {formatPrice(toNumber(labor.rate_amount), labor.currency ?? "USD")} · Hours {toNumber(labor.hours)} · Qty {toNumber(labor.quantity)} · {formatDate(labor.labor_date)}
                  </p>
                  {labor.notes ? <p className="mt-1 text-sm text-slate-500">{labor.notes}</p> : null}
                </div>
                <div className="flex items-center gap-3 md:justify-end">
                  <p className="text-lg font-semibold text-rose-700">-{formatPrice(toNumber(labor.total_amount), labor.currency ?? "USD")}</p>
                  {canManage && !eventFinancialsLocked ? (
                    <form action={deleteEventLaborCostAction}>
                      <input type="hidden" name="event_id" value={typedEvent.id} />
                      <input type="hidden" name="labor_cost_id" value={labor.id} />
                      <button type="submit" className="rounded-xl border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-50">
                        Delete
                      </button>
                    </form>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-3xl border border-[#E9D5FF] bg-[#FCF8FF] p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Quick tips</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Keep pricing simple</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Start with your main ticket first. Add VIP, package, or pass options only when they
                make the buying flow clearer.
              </p>
            </div>
            <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Use sale windows</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Set open and close dates if you want early access, presale timing, or ticket sales
                to stop before the event starts.
              </p>
            </div>
            <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Control availability</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Use capacity and the active toggle to control what dancers can buy without deleting
                older ticket types.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Access</h2>
          {canManage ? (
            <p className="mt-2 text-sm leading-6 text-slate-600">
              You can manage ticket types for this event. Changes here update what dancers see when
              they register on the public event page.
            </p>
          ) : (
            <p className="mt-2 text-sm leading-6 text-slate-600">
              You can view ticket setup for this event, but your current role does not have
              permission to make changes.
            </p>
          )}

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <p>
              <span className="font-medium text-slate-900">Hosted as:</span>{" "}
              {isStudioHosted ? "Studio-hosted event" : "Organizer-hosted event"}
            </p>
            <p className="mt-2">
              <span className="font-medium text-slate-900">Current role:</span>{" "}
              {isPlatformAdmin
                ? "Platform admin"
                : organizerUserRole ?? studioRole ?? "Viewer"}
            </p>
          </div>
        </div>
      </div>

      {!canManage ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          You can view tickets, but your current role does not have permission to manage them.
        </div>
      ) : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Current ticket types</h2>
            <p className="mt-1 text-sm text-slate-600">
              Update pricing, availability, and sales timing for each ticket option.
            </p>
          </div>
        </div>

        {ticketRows.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-[#D8B4FE] bg-[#FCF8FF] px-4 py-8 text-sm text-slate-600">
            No ticket types yet. Add your first ticket option below to start selling registrations.
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {ticketRows.map((ticket) => {
              const status = ticketStatusLabel(ticket);

              return (
                <form
                  key={ticket.id}
                  action={updateTicketTypeAction}
                  className="rounded-2xl border border-slate-200 p-4"
                >
                  <input type="hidden" name="ticketId" value={ticket.id} />
                  <input type="hidden" name="eventId" value={typedEvent.id} />

                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-[#F3E8FF] px-3 py-1 text-xs font-medium text-[#6B21A8]">
                        {formatTicketKind(ticket.ticket_kind)}
                      </span>
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${status.className}`}>
                        {status.label}
                      </span>
                    </div>

                    <p className="text-sm text-slate-500">
                      Current price: {formatPrice(ticket.price, ticket.currency)}
                    </p>
                  </div>

                  <div className="mb-4 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Capacity</p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {ticket.capacity ?? "Unlimited"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Admits</p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Sale starts</p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {formatDateTime(ticket.sale_starts_at)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Sale ends</p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {formatDateTime(ticket.sale_ends_at)}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Ticket name</span>
                      <input
                        name="name"
                        defaultValue={ticket.name}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                    </label>

                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Ticket type</span>
                      <select
                        name="ticketKind"
                        defaultValue={ticket.ticket_kind}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      >
                        <option value="general_admission">General admission</option>
                        <option value="vip">VIP</option>
                        <option value="package">Package</option>
                        <option value="pass">Pass</option>
                        <option value="other">Other</option>
                      </select>
                    </label>

                    <label className="space-y-2 text-sm md:col-span-2">
                      <span className="font-medium text-slate-700">Description</span>
                      <textarea
                        name="description"
                        defaultValue={ticket.description ?? ""}
                        disabled={!canManage}
                        rows={3}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                    </label>

                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Price</span>
                      <input
                        name="price"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={ticket.price}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                    </label>

                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Currency</span>
                      <input
                        name="currency"
                        defaultValue={ticket.currency}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                    </label>

                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Capacity</span>
                      <input
                        name="capacity"
                        type="number"
                        min="0"
                        defaultValue={ticket.capacity ?? ""}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                    </label>

                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Attendees per ticket</span>
                      <input
                        name="attendeesPerTicket"
                        type="number"
                        min="1"
                        max="20"
                        defaultValue={Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1)}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                      <span className="block text-xs text-slate-500">
                        Use 2 for couple tickets, 8 for a table of 8, etc.
                      </span>
                    </label>

                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Sort order</span>
                      <input
                        name="sortOrder"
                        type="number"
                        min="0"
                        defaultValue={ticket.sort_order}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                    </label>

                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Sale starts</span>
                      <input
                        name="saleStartsAt"
                        type="datetime-local"
                        defaultValue={toDatetimeLocal(ticket.sale_starts_at)}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                    </label>

                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Sale ends</span>
                      <input
                        name="saleEndsAt"
                        type="datetime-local"
                        defaultValue={toDatetimeLocal(ticket.sale_ends_at)}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                    </label>

                    <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                      <input
                        name="active"
                        type="checkbox"
                        defaultChecked={ticket.active}
                        disabled={!canManage}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Active
                    </label>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                    {canManage ? (
                      <button
                        type="submit"
                        className="inline-flex items-center rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#4A1363]"
                      >
                        Save changes
                      </button>
                    ) : null}
                  </div>
                </form>
              );
            })}
          </div>
        )}
      </section>

      {canManage ? (
        <section className="rounded-3xl border border-[#E9D5FF] bg-[#FCF8FF] p-6 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
              Create ticket option
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-900">Add ticket type</h2>
            <p className="mt-1 text-sm text-slate-600">
              Create pricing options for registration on the public event page.
            </p>
          </div>

          <form action={createTicketTypeAction} className="mt-6 grid gap-4 md:grid-cols-2">
            <input type="hidden" name="eventId" value={typedEvent.id} />

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Ticket name</span>
              <input
                name="name"
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                placeholder="General Admission"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Ticket type</span>
              <select
                name="ticketKind"
                defaultValue="general_admission"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              >
                <option value="general_admission">General admission</option>
                <option value="vip">VIP</option>
                <option value="package">Package</option>
                <option value="pass">Pass</option>
                <option value="other">Other</option>
              </select>
            </label>

            <label className="space-y-2 text-sm md:col-span-2">
              <span className="font-medium text-slate-700">Description</span>
              <textarea
                name="description"
                rows={3}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                placeholder="Optional details about this ticket"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Price</span>
              <input
                name="price"
                type="number"
                min="0"
                step="0.01"
                defaultValue="0"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Currency</span>
              <input
                name="currency"
                defaultValue="USD"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Capacity</span>
              <input
                name="capacity"
                type="number"
                min="0"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                placeholder="Optional"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Attendees per ticket</span>
              <input
                name="attendeesPerTicket"
                type="number"
                min="1"
                max="20"
                defaultValue="1"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
              <span className="block text-xs text-slate-500">
                Use 2 for couple tickets, 8 for a table of 8, etc.
              </span>
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Sort order</span>
              <input
                name="sortOrder"
                type="number"
                min="0"
                defaultValue="0"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Sale starts</span>
              <input
                name="saleStartsAt"
                type="datetime-local"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Sale ends</span>
              <input
                name="saleEndsAt"
                type="datetime-local"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-slate-700 md:col-span-2">
              <input
                name="active"
                type="checkbox"
                defaultChecked
                className="h-4 w-4 rounded border-slate-300"
              />
              Active
            </label>

            <div className="md:col-span-2 flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#4A1363]"
              >
                Add ticket type
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
