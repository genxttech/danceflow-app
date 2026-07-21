import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  FileSignature,
  Package,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
  Ticket,
  WandSparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import AriaAvatar from "@/components/app/AriaAvatar";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import { getDanceGoalIntelligence } from "@/lib/aria/danceGoalInsights";
import { getCommerceIntelligence } from "@/lib/commerce/intelligence";
import CommerceIntelligenceSection from "@/components/app/commerce/CommerceIntelligenceSection";

type ClientPackageRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  active: boolean | null;
  client_package_items?:
    | {
        quantity_remaining: number | string | null;
        is_unlimited: boolean | null;
      }[]
    | null;
};

type BookingRequestRow = {
  id: string;
  status: string | null;
  source: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  requested_starts_at: string | null;
  created_at: string;
};

type AutomationActionRow = {
  id: string;
  rule_key: string;
  title: string;
  body: string | null;
  status: string;
  priority: string;
  related_table: string | null;
  related_id: string | null;
  client_id: string | null;
  created_at: string;
};

type AutomationRuleRow = {
  id: string;
  rule_key: string;
  enabled: boolean;
  mode: string;
  last_evaluated_at: string | null;
};

type AppointmentRow = {
  id: string;
  client_id: string | null;
  starts_at: string;
  status: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
  created_at: string;
};

type ConversionClientRow = {
  id: string;
  created_at: string;
};

type ConversionAppointmentRow = {
  id: string;
  client_id: string | null;
  appointment_type: string | null;
  status: string | null;
  starts_at: string;
};

type ConversionPackageRow = {
  id: string;
  client_id: string | null;
  created_at: string;
  purchase_date: string | null;
};

type ConversionMembershipRow = {
  id: string;
  client_id: string | null;
  created_at: string;
};

type ConversionPurchase = {
  date: Date;
};

type AriaGoalRow = {
  id: string;
  title: string;
  status: string;
  target_value: number | string | null;
  current_value: number | string | null;
  target_unit: string;
  target_date: string | null;
  updated_at: string;
};

type OrganizerAriaEventRow = {
  id: string;
  name: string;
  slug: string | null;
  status: string | null;
  start_date: string;
  end_date: string | null;
};

type OrganizerAriaRegistrationRow = {
  id: string;
  event_id: string;
  status: string | null;
  payment_status: string | null;
  quantity: number | string | null;
};

type OrganizerAriaTicketRow = {
  id: string;
  event_id: string | null;
  checked_in_at: string | null;
};

type OrganizerAriaProfitabilityRow = {
  event_id: string | null;
  gross_ticket_revenue: number | string | null;
  refunds: number | string | null;
  processing_and_platform_fees: number | string | null;
  net_ticket_revenue: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
  total_event_costs: number | string | null;
  event_profit_loss: number | string | null;
};

type OrganizerAriaSettlementRow = {
  event_id: string | null;
  status: string | null;
  settled_at: string | null;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not scheduled";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatGoalTarget(value: number | string | null, unit: string) {
  if (value === null || value === undefined || value === "")
    return "Target not set";
  const numericValue = typeof value === "number" ? value : Number(value);
  const formattedValue = Number.isFinite(numericValue)
    ? numericValue.toLocaleString("en-US")
    : String(value);

  if (unit === "dollars") return `$${formattedValue}`;
  if (unit === "percent") return `${formattedValue}%`;
  return `${formattedValue} ${unit}`;
}

function personName(
  firstName?: string | null,
  lastName?: string | null,
  fallback = "Client",
) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || fallback;
}

function asNumber(value: number | string | null | undefined) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function safeNumber(value: number | string | null | undefined) {
  return asNumber(value) ?? 0;
}

function formatCurrency(value: number | string | null | undefined) {
  const amount = safeNumber(value);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function conversionPercent(numerator: number, denominator: number) {
  if (!denominator) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function daysBetween(start: Date, end: Date) {
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
}

function isIntroAppointmentType(value: string | null) {
  const normalized = `${value ?? ""}`.toLowerCase();
  return normalized.includes("intro") || normalized.includes("consult");
}

function isCanceledConversionStatus(value: string | null) {
  const normalized = `${value ?? ""}`.toLowerCase();
  return (
    normalized.includes("cancel") ||
    normalized.includes("declin") ||
    normalized.includes("no_show") ||
    normalized.includes("no-show")
  );
}

function isCompletedConversionStatus(value: string | null) {
  const normalized = `${value ?? ""}`.toLowerCase();
  return (
    normalized.includes("complete") ||
    normalized.includes("attend") ||
    normalized.includes("done") ||
    normalized.includes("closed")
  );
}

function hasPurchaseWithinWindow(
  purchases: ConversionPurchase[],
  start: Date,
  windowDays: number,
) {
  return purchases.some((purchase) => {
    const elapsed = daysBetween(start, purchase.date);
    return elapsed >= 0 && elapsed <= windowDays;
  });
}

function isOrganizerRole(role: string | null | undefined) {
  return (
    role === "organizer_owner" ||
    role === "organizer_admin" ||
    role === "organizer_staff"
  );
}

function packageLowestRemaining(row: ClientPackageRow) {
  const finiteItems = (row.client_package_items ?? [])
    .filter((item) => !item.is_unlimited)
    .map((item) => asNumber(item.quantity_remaining))
    .filter((value): value is number => typeof value === "number");

  if (finiteItems.length === 0) return null;

  return Math.min(...finiteItems);
}

function priorityClass(priority: string) {
  if (priority === "urgent") return "border-red-200 bg-red-50 text-red-700";
  if (priority === "high") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-violet-200 bg-violet-50 text-violet-700";
}

function ruleLabel(ruleKey: string) {
  if (ruleKey === "low_package_balance") return "Low balance";
  if (ruleKey === "no_upcoming_lesson") return "Rebooking";
  if (ruleKey === "pending_booking_request") return "Booking request";
  if (ruleKey === "unsigned_document") return "Documents";
  if (ruleKey === "first_lesson_follow_up") return "First lesson";
  return "Automation";
}

function opportunityToneClass(
  tone: "revenue" | "booking" | "document" | "automation" | "retention",
) {
  if (tone === "revenue") return "border-pink-200 bg-pink-50 text-pink-700";
  if (tone === "booking")
    return "border-violet-200 bg-violet-50 text-violet-700";
  if (tone === "document") return "border-amber-200 bg-amber-50 text-amber-700";
  if (tone === "automation") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function OpportunityCard({
  tone,
  icon: Icon,
  title,
  metric,
  description,
  href,
  actionLabel,
}: {
  tone: "revenue" | "booking" | "document" | "automation" | "retention";
  icon: typeof Sparkles;
  title: string;
  metric: string;
  description: string;
  href: string;
  actionLabel: string;
}) {
  return (
    <article className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div
          className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl border ${opportunityToneClass(tone)}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          {metric}
        </span>
      </div>

      <h2 className="mt-4 text-lg font-semibold text-slate-950">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>

      <Link
        href={href}
        className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-[#6B21A8] hover:underline"
      >
        {actionLabel}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </article>
  );
}

export default async function AriaOpportunityHubPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  const studioId = context.studioId;
  const organizerWorkspace = isOrganizerRole(context.studioRole);

  if (organizerWorkspace) {
    const todayStart = new Date(new Date().toDateString());

    const { data: eventsData, error: eventsError } = await supabase
      .from("events")
      .select("id, name, slug, status, start_date, end_date")
      .eq("studio_id", studioId)
      .order("start_date", { ascending: true })
      .limit(250);

    if (eventsError) {
      throw new Error(
        `Failed to load organizer ARIA events: ${eventsError.message}`,
      );
    }

    const organizerEvents = (eventsData ?? []) as OrganizerAriaEventRow[];
    const eventIds = organizerEvents.map((event) => event.id);

    let registrationRows: OrganizerAriaRegistrationRow[] = [];
    let ticketRows: OrganizerAriaTicketRow[] = [];
    let profitabilityRows: OrganizerAriaProfitabilityRow[] = [];
    let settlementRows: OrganizerAriaSettlementRow[] = [];

    if (eventIds.length > 0) {
      const [
        registrationsResult,
        ticketsResult,
        profitabilityResult,
        settlementsResult,
      ] = await Promise.all([
        supabase
          .from("event_registrations")
          .select("id,event_id,status,payment_status,quantity")
          .in("event_id", eventIds),
        supabase
          .from("event_registration_attendees")
          .select("id,event_id,checked_in_at")
          .in("event_id", eventIds)
          .limit(10000),
        supabase
          .from("v_event_profit_loss")
          .select(
            "event_id,gross_ticket_revenue,refunds,processing_and_platform_fees,net_ticket_revenue,event_expenses,event_labor_costs,total_event_costs,event_profit_loss",
          )
          .in("event_id", eventIds),
        supabase
          .from("event_settlements")
          .select("event_id,status,settled_at")
          .in("event_id", eventIds),
      ]);

      if (registrationsResult.error) {
        throw new Error(
          `Failed to load organizer ARIA registrations: ${registrationsResult.error.message}`,
        );
      }

      if (ticketsResult.error) {
        console.warn(
          "Failed to load organizer ARIA tickets:",
          ticketsResult.error.message,
        );
      }

      if (profitabilityResult.error) {
        console.warn(
          "Failed to load organizer ARIA profitability:",
          profitabilityResult.error.message,
        );
      }

      if (settlementsResult.error) {
        console.warn(
          "Failed to load organizer ARIA settlements:",
          settlementsResult.error.message,
        );
      }

      registrationRows = (registrationsResult.data ??
        []) as OrganizerAriaRegistrationRow[];
      ticketRows = ticketsResult.error
        ? []
        : ((ticketsResult.data ?? []) as OrganizerAriaTicketRow[]);
      profitabilityRows = profitabilityResult.error
        ? []
        : ((profitabilityResult.data ?? []) as OrganizerAriaProfitabilityRow[]);
      settlementRows = settlementsResult.error
        ? []
        : ((settlementsResult.data ?? []) as OrganizerAriaSettlementRow[]);
    }

    const registrationsByEventId = new Map<
      string,
      OrganizerAriaRegistrationRow[]
    >();
    for (const registration of registrationRows) {
      const current = registrationsByEventId.get(registration.event_id) ?? [];
      current.push(registration);
      registrationsByEventId.set(registration.event_id, current);
    }

    const ticketsByEventId = new Map<string, OrganizerAriaTicketRow[]>();
    for (const ticket of ticketRows) {
      if (!ticket.event_id) continue;
      const current = ticketsByEventId.get(ticket.event_id) ?? [];
      current.push(ticket);
      ticketsByEventId.set(ticket.event_id, current);
    }

    const profitabilityByEventId = new Map<
      string,
      OrganizerAriaProfitabilityRow
    >();
    for (const row of profitabilityRows) {
      if (row.event_id) profitabilityByEventId.set(row.event_id, row);
    }

    const settlementByEventId = new Map<string, OrganizerAriaSettlementRow>();
    for (const row of settlementRows) {
      if (row.event_id) settlementByEventId.set(row.event_id, row);
    }

    const organizerEventRows = organizerEvents.map((event) => {
      const registrations = registrationsByEventId.get(event.id) ?? [];
      const tickets = ticketsByEventId.get(event.id) ?? [];
      const profitability = profitabilityByEventId.get(event.id);
      const settlement = settlementByEventId.get(event.id);
      const netTicketRevenue = safeNumber(profitability?.net_ticket_revenue);
      const eventProfitLoss = safeNumber(profitability?.event_profit_loss);
      const ticketsIssued =
        tickets.length > 0
          ? tickets.length
          : registrations.reduce(
              (sum, row) => sum + safeNumber(row.quantity ?? 1),
              0,
            );
      const ticketsCheckedIn = tickets.filter(
        (ticket) => ticket.checked_in_at,
      ).length;
      const eventDate = new Date(`${event.start_date}T00:00:00`);
      const isPast =
        !Number.isNaN(eventDate.getTime()) && eventDate < todayStart;

      return {
        event,
        grossTicketRevenue: safeNumber(profitability?.gross_ticket_revenue),
        refunds: safeNumber(profitability?.refunds),
        fees: safeNumber(profitability?.processing_and_platform_fees),
        netTicketRevenue,
        eventExpenses: safeNumber(profitability?.event_expenses),
        eventLaborCosts: safeNumber(profitability?.event_labor_costs),
        totalEventCosts: safeNumber(profitability?.total_event_costs),
        eventProfitLoss,
        marginPercent: netTicketRevenue
          ? (eventProfitLoss / netTicketRevenue) * 100
          : null,
        registrations: registrations.length,
        unpaidRegistrations: registrations.filter(
          (row) => row.payment_status === "unpaid",
        ).length,
        pendingRegistrations: registrations.filter(
          (row) => row.payment_status === "pending",
        ).length,
        refundedRegistrations: registrations.filter(
          (row) =>
            row.payment_status === "refunded" || row.status === "refunded",
        ).length,
        ticketsIssued,
        ticketsCheckedIn,
        checkInRate: ticketsIssued
          ? (ticketsCheckedIn / ticketsIssued) * 100
          : null,
        settlementStatus: settlement?.status ?? "open",
        hasSettlementRecord: Boolean(settlement),
        isCompletedOrPast: event.status === "completed" || isPast,
      };
    });

    const totalNetRevenue = organizerEventRows.reduce(
      (sum, row) => sum + row.netTicketRevenue,
      0,
    );
    const totalProfitLoss = organizerEventRows.reduce(
      (sum, row) => sum + row.eventProfitLoss,
      0,
    );
    const totalTicketsIssued = organizerEventRows.reduce(
      (sum, row) => sum + row.ticketsIssued,
      0,
    );
    const totalTicketsCheckedIn = organizerEventRows.reduce(
      (sum, row) => sum + row.ticketsCheckedIn,
      0,
    );
    const totalCheckInRate = totalTicketsIssued
      ? (totalTicketsCheckedIn / totalTicketsIssued) * 100
      : null;

    const unsettledCompletedEvents = organizerEventRows.filter(
      (row) => row.isCompletedOrPast && row.settlementStatus !== "settled",
    );
    const losingMoneyEvents = organizerEventRows.filter(
      (row) => row.eventProfitLoss < 0,
    );
    const missingCostEvents = organizerEventRows.filter(
      (row) =>
        row.netTicketRevenue > 0 &&
        (row.eventExpenses <= 0 || row.eventLaborCosts <= 0),
    );
    const registrationExceptionEvents = organizerEventRows.filter(
      (row) => row.unpaidRegistrations > 0 || row.pendingRegistrations > 0,
    );
    const repeatCandidate = [...organizerEventRows]
      .filter(
        (row) =>
          row.netTicketRevenue > 0 &&
          row.eventProfitLoss > 0 &&
          (row.marginPercent ?? 0) >= 25 &&
          (row.checkInRate ?? 0) >= 75,
      )
      .sort((a, b) => b.eventProfitLoss - a.eventProfitLoss)[0];

    const readyToSettleEvents = organizerEventRows.filter(
      (row) =>
        row.isCompletedOrPast &&
        row.settlementStatus !== "settled" &&
        row.unpaidRegistrations === 0 &&
        row.pendingRegistrations === 0 &&
        row.eventProfitLoss >= 0 &&
        row.eventExpenses > 0 &&
        row.eventLaborCosts > 0,
    );

    const weakestCheckInEvent = [...organizerEventRows]
      .filter(
        (row) =>
          row.ticketsIssued > 0 &&
          row.checkInRate !== null &&
          row.isCompletedOrPast,
      )
      .sort((a, b) => (a.checkInRate ?? 0) - (b.checkInRate ?? 0))[0];

    const highestRevenueEvent = [...organizerEventRows]
      .filter((row) => row.netTicketRevenue > 0)
      .sort((a, b) => b.netTicketRevenue - a.netTicketRevenue)[0];

    const strongestProfitEvent = [...organizerEventRows]
      .filter((row) => row.eventProfitLoss > 0)
      .sort((a, b) => b.eventProfitLoss - a.eventProfitLoss)[0];

    const nextBestOrganizerMove = unsettledCompletedEvents[0]
      ? {
          title: "Close out completed events first.",
          insight: `${unsettledCompletedEvents.length} completed or past event${unsettledCompletedEvents.length === 1 ? " still needs" : "s still need"} settlement review.`,
          recommendation:
            "Open the oldest unsettled event, verify refunds, labor, expenses, and check-ins, then mark the settlement ready or settled.",
          href: `/app/events/${unsettledCompletedEvents[0].event.id}`,
          label: "Review closeout",
          metric: `${unsettledCompletedEvents.length} unsettled`,
        }
      : losingMoneyEvents[0]
        ? {
            title: "Review events losing money.",
            insight: `${losingMoneyEvents.length} event${losingMoneyEvents.length === 1 ? " is" : "s are"} currently below break-even.`,
            recommendation:
              "Check whether labor, expenses, refunds, or pricing caused the loss before repeating the event format.",
            href: `/app/events/${losingMoneyEvents[0].event.id}`,
            label: "Review loss",
            metric: `${losingMoneyEvents.length} loss event${losingMoneyEvents.length === 1 ? "" : "s"}`,
          }
        : repeatCandidate
          ? {
              title: "Repeat your strongest event format.",
              insight: `${repeatCandidate.event.name} generated ${formatCurrency(repeatCandidate.eventProfitLoss)} profit with a ${formatPercent(repeatCandidate.marginPercent)} margin.`,
              recommendation:
                "Duplicate this event or use its pricing, timing, and promotion approach as the model for your next organizer event.",
              href: `/app/events/${repeatCandidate.event.id}`,
              label: "Open event",
              metric: "Repeat candidate",
            }
          : {
              title: "ARIA is watching your organizer event health.",
              insight:
                "No urgent event closeout or profitability issue is standing out right now.",
              recommendation:
                "Keep labor, expenses, settlements, and registrations current so ARIA can make stronger recommendations as your events run.",
              href: "/app/events",
              label: "Open events",
              metric: "Monitoring",
            };

    return (
      <main className="space-y-8 p-6 md:p-8">
        <section className="overflow-hidden rounded-[36px] border border-[#F9A8D4] bg-white shadow-sm">
          <div className="relative p-6 md:p-8">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.18),transparent_32%),linear-gradient(135deg,rgba(255,247,237,0.9),rgba(255,255,255,0.95)_45%,rgba(250,245,255,0.9))]" />
            <div className="relative grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
              <AriaAvatar size="lg" />
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#BE185D]">
                  ARIA Organizer Command Center
                </p>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                  ARIA for event organizers
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-700 md:text-base">
                  I’m tuned to your organizer workspace. I look at event
                  revenue, refunds, fees, labor, expenses, ticket check-ins, and
                  settlement status so you know which events need action and
                  which ones are worth repeating.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
                <Link
                  href="/app/aria/operations"
                  className="inline-flex items-center justify-center rounded-2xl bg-[#6B21A8] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#581C87]"
                >
                  Open Operations Center
                </Link>
                <Link
                  href="/app/events"
                  className="inline-flex items-center justify-center rounded-2xl border border-[#C084FC] bg-white/80 px-4 py-3 text-sm font-semibold text-[#6B21A8] shadow-sm hover:bg-white"
                >
                  Organizer Dashboard
                </Link>
              </div>
            </div>
          </div>
        </section>

        <AriaInsightCard
          eyebrow="ARIA's Organizer Next Best Move"
          title={nextBestOrganizerMove.title}
          insight={nextBestOrganizerMove.insight}
          recommendation={nextBestOrganizerMove.recommendation}
          metric={nextBestOrganizerMove.metric}
          primaryAction={{
            href: nextBestOrganizerMove.href,
            label: nextBestOrganizerMove.label,
          }}
          secondaryAction={{
            href: "/app/events",
            label: "View organizer reporting",
          }}
        />

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <OpportunityCard
            tone="revenue"
            icon={Wallet}
            title="Organizer net revenue"
            metric={formatCurrency(totalNetRevenue)}
            description="Net ticket revenue after refunds and processing/platform fees across organizer events."
            href="/app/events"
            actionLabel="Open reporting"
          />
          <OpportunityCard
            tone={totalProfitLoss >= 0 ? "retention" : "revenue"}
            icon={totalProfitLoss >= 0 ? TrendingUp : TrendingDown}
            title="Event profit/loss"
            metric={formatCurrency(totalProfitLoss)}
            description="Profit/loss after event expenses and labor costs are applied to event ticket revenue."
            href="/app/events"
            actionLabel="Review events"
          />
          <OpportunityCard
            tone="booking"
            icon={Ticket}
            title="Ticket check-in health"
            metric={formatPercent(totalCheckInRate)}
            description="Issued ticket check-ins help show whether ticket buyers actually attended the event."
            href="/app/events"
            actionLabel="View check-ins"
          />
          <OpportunityCard
            tone="automation"
            icon={ClipboardList}
            title="Closeout queue"
            metric={`${unsettledCompletedEvents.length}`}
            description="Completed or past events that still need settlement review, notes, or final closeout."
            href="/app/events"
            actionLabel="Review closeouts"
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <AriaInsightCard
            eyebrow="ARIA Profitability"
            title="Know what to repeat and what to repair."
            insight={
              repeatCandidate
                ? `${repeatCandidate.event.name} is your strongest repeat candidate based on profit, margin, and attendance signals.`
                : "ARIA needs more settled events with complete cost data before it can confidently recommend repeat formats."
            }
            recommendation={
              repeatCandidate
                ? "Use the event dashboard to review the pricing, ticket mix, and cost structure before duplicating this event."
                : "Complete labor and expense tracking for each event so future recommendations are based on full profitability."
            }
            metric={
              repeatCandidate
                ? formatCurrency(repeatCandidate.eventProfitLoss)
                : "Needs data"
            }
            primaryAction={{
              href: repeatCandidate
                ? `/app/events/${repeatCandidate.event.id}`
                : "/app/events",
              label: repeatCandidate ? "Review candidate" : "Open events",
            }}
            compact
          />

          <AriaInsightCard
            eyebrow="ARIA Risk Scan"
            title="Watch the events with missing or risky closeout data."
            insight={`${missingCostEvents.length} event${missingCostEvents.length === 1 ? " is" : "s are"} missing labor or expense data, and ${registrationExceptionEvents.length} event${registrationExceptionEvents.length === 1 ? " has" : "s have"} unpaid or pending registrations.`}
            recommendation="Prioritize cost completeness and registration exceptions before marking an event settled."
            metric={`${missingCostEvents.length + registrationExceptionEvents.length} review signal${missingCostEvents.length + registrationExceptionEvents.length === 1 ? "" : "s"}`}
            primaryAction={{
              href: "/app/events",
              label: "Review attention list",
            }}
            compact
          />
        </section>

        <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Organizer consult prompts
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Ask ARIA event-operator questions
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                These are organizer-specific prompts with an immediate answer
                from your current event data and a direct next action.
              </p>
            </div>
            <Link
              href="/app/events/export/attention"
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-[#6B21A8] hover:bg-slate-50"
            >
              Export attention list
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <article className="rounded-3xl border border-amber-200 bg-amber-50/70 p-5">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">
                Which events need closeout first?
              </p>
              <h3 className="mt-3 text-lg font-semibold text-slate-950">
                {unsettledCompletedEvents[0]
                  ? unsettledCompletedEvents[0].event.name
                  : "No completed event is currently waiting on settlement."}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {unsettledCompletedEvents.length > 0
                  ? `${unsettledCompletedEvents.length} completed or past event${unsettledCompletedEvents.length === 1 ? " needs" : "s need"} closeout review. Start with the oldest open event, verify refunds, labor, expenses, and check-ins, then save the settlement status.`
                  : "ARIA does not see a completed organizer event that needs settlement review right now."}
              </p>
              <Link
                href={
                  unsettledCompletedEvents[0]
                    ? `/app/events/${unsettledCompletedEvents[0].event.id}`
                    : "/app/events"
                }
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-amber-800 hover:underline"
              >
                {unsettledCompletedEvents[0]
                  ? "Open closeout"
                  : "Open organizer dashboard"}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </article>

            <article className="rounded-3xl border border-emerald-200 bg-emerald-50/70 p-5">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">
                Which events should I repeat?
              </p>
              <h3 className="mt-3 text-lg font-semibold text-slate-950">
                {repeatCandidate
                  ? repeatCandidate.event.name
                  : strongestProfitEvent
                    ? strongestProfitEvent.event.name
                    : "No repeat candidate yet."}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {repeatCandidate
                  ? `${repeatCandidate.event.name} is the strongest repeat signal with ${formatCurrency(repeatCandidate.eventProfitLoss)} profit, ${formatPercent(repeatCandidate.marginPercent)} margin, and ${formatPercent(repeatCandidate.checkInRate)} check-in rate.`
                  : strongestProfitEvent
                    ? `${strongestProfitEvent.event.name} has your highest current profit at ${formatCurrency(strongestProfitEvent.eventProfitLoss)}, but ARIA needs stronger margin/check-in signals before calling it a repeat model.`
                    : "ARIA needs more events with revenue, complete costs, and check-in data before recommending a repeat format."}
              </p>
              <Link
                href={
                  repeatCandidate
                    ? `/app/events/${repeatCandidate.event.id}`
                    : strongestProfitEvent
                      ? `/app/events/${strongestProfitEvent.event.id}`
                      : "/app/events"
                }
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-emerald-800 hover:underline"
              >
                Review repeat signal
                <ArrowRight className="h-4 w-4" />
              </Link>
            </article>

            <article className="rounded-3xl border border-rose-200 bg-rose-50/70 p-5">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-rose-700">
                Where am I losing margin?
              </p>
              <h3 className="mt-3 text-lg font-semibold text-slate-950">
                {losingMoneyEvents[0]
                  ? losingMoneyEvents[0].event.name
                  : "No event is currently below break-even."}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {losingMoneyEvents.length > 0
                  ? `${losingMoneyEvents.length} event${losingMoneyEvents.length === 1 ? " is" : "s are"} below break-even. Review ticket pricing, refunds, labor, and event expenses before repeating those formats.`
                  : "ARIA does not see a negative-profit event right now. Keep cost attribution current so margin warnings stay accurate."}
              </p>
              <Link
                href={
                  losingMoneyEvents[0]
                    ? `/app/events/${losingMoneyEvents[0].event.id}`
                    : "/app/events"
                }
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-rose-800 hover:underline"
              >
                Review margin risk
                <ArrowRight className="h-4 w-4" />
              </Link>
            </article>

            <article className="rounded-3xl border border-violet-200 bg-violet-50/70 p-5">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">
                What data is missing?
              </p>
              <h3 className="mt-3 text-lg font-semibold text-slate-950">
                {missingCostEvents.length > 0
                  ? `${missingCostEvents.length} event${missingCostEvents.length === 1 ? " needs" : "s need"} cost cleanup`
                  : "Labor and expenses look complete for revenue events."}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {missingCostEvents.length > 0
                  ? "Events with ticket revenue but no labor or no expenses can make profit look better than it really is. Add staff pay and event-linked expenses before closeout."
                  : "ARIA is not seeing obvious missing labor or expense data in revenue-producing organizer events."}
              </p>
              <Link
                href="/app/events"
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-violet-800 hover:underline"
              >
                Review attention dashboard
                <ArrowRight className="h-4 w-4" />
              </Link>
            </article>

            <article className="rounded-3xl border border-blue-200 bg-blue-50/70 p-5">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">
                Which event had the weakest check-in rate?
              </p>
              <h3 className="mt-3 text-lg font-semibold text-slate-950">
                {weakestCheckInEvent
                  ? weakestCheckInEvent.event.name
                  : "No completed check-in signal yet."}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {weakestCheckInEvent
                  ? `${weakestCheckInEvent.event.name} checked in ${formatPercent(weakestCheckInEvent.checkInRate)} of issued tickets. Review whether buyers missed the event, check-in was incomplete, or event reminders need improvement.`
                  : "ARIA needs issued ticket and check-in data from completed events to identify attendance friction."}
              </p>
              <Link
                href={
                  weakestCheckInEvent
                    ? `/app/events/${weakestCheckInEvent.event.id}`
                    : "/app/events"
                }
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-800 hover:underline"
              >
                Review check-ins
                <ArrowRight className="h-4 w-4" />
              </Link>
            </article>

            <article className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-600">
                What should I export for review?
              </p>
              <h3 className="mt-3 text-lg font-semibold text-slate-950">
                Start with financial summary and attention list.
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                Use the financial export for accounting review and the attention
                export to follow up on closeout, missing costs, registration
                exceptions, and event profitability risks.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  href="/app/events/export/financial-summary"
                  className="inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  Financial CSV
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <Link
                  href="/app/events/export/attention"
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Attention CSV
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </article>
          </div>
        </section>
      </main>
    );
  }

  const nowIso = new Date().toISOString();
  const now = new Date(nowIso);
  const ninetyDaysAgoIso = new Date(
    Date.now() - 90 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const ninetyDaysAgo = new Date(ninetyDaysAgoIso);

  const [
    packagesResult,
    pendingRequestsResult,
    automationActionsResult,
    automationRulesResult,
    recentAppointmentsResult,
    futureAppointmentsResult,
    activeClientsResult,
    ariaGoalsResult,
    conversionClientsResult,
    conversionAppointmentsResult,
    conversionPackagesResult,
    conversionMembershipsResult,
  ] = await Promise.all([
    supabase
      .from("client_packages")
      .select(
        `
        id,
        client_id,
        name_snapshot,
        active,
        client_package_items (
          quantity_remaining,
          is_unlimited
        )
      `,
      )
      .eq("studio_id", studioId)
      .eq("active", true)
      .limit(250),

    supabase
      .from("booking_requests")
      .select(
        "id, status, source, customer_first_name, customer_last_name, customer_email, requested_starts_at, created_at",
      )
      .eq("studio_id", studioId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(25),

    supabase
      .from("automation_actions")
      .select(
        "id, rule_key, title, body, status, priority, related_table, related_id, client_id, created_at",
      )
      .eq("studio_id", studioId)
      .in("status", ["suggested", "drafted"])
      .order("created_at", { ascending: false })
      .limit(25),

    supabase
      .from("automation_rules")
      .select("id, rule_key, enabled, mode, last_evaluated_at")
      .eq("studio_id", studioId),

    supabase
      .from("appointments")
      .select("id, client_id, starts_at, status")
      .eq("studio_id", studioId)
      .not("client_id", "is", null)
      .gte("starts_at", ninetyDaysAgoIso)
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(300),

    supabase
      .from("appointments")
      .select("id, client_id, starts_at, status")
      .eq("studio_id", studioId)
      .not("client_id", "is", null)
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(300),

    supabase
      .from("clients")
      .select("id, first_name, last_name, status, created_at")
      .eq("studio_id", studioId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(250),

    supabase
      .from("aria_goals")
      .select(
        "id, title, status, target_value, current_value, target_unit, target_date, updated_at",
      )
      .eq("studio_id", studioId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(3),

    supabase
      .from("clients")
      .select("id, created_at")
      .eq("studio_id", studioId)
      .gte("created_at", ninetyDaysAgoIso)
      .lte("created_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1000),

    supabase
      .from("appointments")
      .select("id, client_id, appointment_type, status, starts_at")
      .eq("studio_id", studioId)
      .gte("starts_at", ninetyDaysAgoIso)
      .lte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(1500),

    supabase
      .from("client_packages")
      .select("id, client_id, created_at, purchase_date")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: true })
      .limit(2000),

    supabase
      .from("client_memberships")
      .select("id, client_id, created_at")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: true })
      .limit(2000),
  ]);

  if (packagesResult.error) {
    throw new Error(
      `Failed to load ARIA package opportunities: ${packagesResult.error.message}`,
    );
  }

  if (pendingRequestsResult.error) {
    throw new Error(
      `Failed to load ARIA booking opportunities: ${pendingRequestsResult.error.message}`,
    );
  }

  if (automationActionsResult.error) {
    throw new Error(
      `Failed to load ARIA automation actions: ${automationActionsResult.error.message}`,
    );
  }

  if (automationRulesResult.error) {
    throw new Error(
      `Failed to load ARIA automation rules: ${automationRulesResult.error.message}`,
    );
  }

  if (recentAppointmentsResult.error) {
    throw new Error(
      `Failed to load ARIA recent lessons: ${recentAppointmentsResult.error.message}`,
    );
  }

  if (futureAppointmentsResult.error) {
    throw new Error(
      `Failed to load ARIA future lessons: ${futureAppointmentsResult.error.message}`,
    );
  }

  if (activeClientsResult.error) {
    throw new Error(
      `Failed to load ARIA active clients: ${activeClientsResult.error.message}`,
    );
  }

  if (ariaGoalsResult.error) {
    throw new Error(
      `Failed to load ARIA goals: ${ariaGoalsResult.error.message}`,
    );
  }

  if (conversionClientsResult.error) {
    throw new Error(
      `Failed to load ARIA conversion clients: ${conversionClientsResult.error.message}`,
    );
  }

  if (conversionAppointmentsResult.error) {
    throw new Error(
      `Failed to load ARIA conversion appointments: ${conversionAppointmentsResult.error.message}`,
    );
  }

  if (conversionPackagesResult.error) {
    throw new Error(
      `Failed to load ARIA conversion packages: ${conversionPackagesResult.error.message}`,
    );
  }

  if (conversionMembershipsResult.error) {
    throw new Error(
      `Failed to load ARIA conversion memberships: ${conversionMembershipsResult.error.message}`,
    );
  }

  const packages = (packagesResult.data ?? []) as ClientPackageRow[];
  const pendingRequests = (pendingRequestsResult.data ??
    []) as BookingRequestRow[];
  const automationActions = (automationActionsResult.data ??
    []) as AutomationActionRow[];
  const automationRules = (automationRulesResult.data ??
    []) as AutomationRuleRow[];
  const recentAppointments = (recentAppointmentsResult.data ??
    []) as AppointmentRow[];
  const futureAppointments = (futureAppointmentsResult.data ??
    []) as AppointmentRow[];
  const activeClients = (activeClientsResult.data ?? []) as ClientRow[];
  const activeGoals = (ariaGoalsResult.data ?? []) as AriaGoalRow[];
  const activeGoal = activeGoals[0] ?? null;
  const conversionClients = (conversionClientsResult.data ??
    []) as ConversionClientRow[];
  const conversionAppointments = (conversionAppointmentsResult.data ??
    []) as ConversionAppointmentRow[];
  const conversionPackages = (conversionPackagesResult.data ??
    []) as ConversionPackageRow[];
  const conversionMemberships = (conversionMembershipsResult.data ??
    []) as ConversionMembershipRow[];
  const danceGoalIntelligence = await getDanceGoalIntelligence({
    studioId,
    range: "90",
  });

  const lowBalancePackages = packages.filter((pkg) => {
    const lowestRemaining = packageLowestRemaining(pkg);
    return typeof lowestRemaining === "number" && lowestRemaining <= 2;
  });

  const depletedPackages = lowBalancePackages.filter(
    (pkg) => packageLowestRemaining(pkg) === 0,
  );

  const futureClientIds = new Set(
    futureAppointments
      .filter(
        (appointment) =>
          (appointment.status ?? "").toLowerCase() !== "cancelled",
      )
      .map((appointment) => appointment.client_id)
      .filter((id): id is string => Boolean(id)),
  );

  const recentClientIds = new Set(
    recentAppointments
      .filter(
        (appointment) =>
          (appointment.status ?? "").toLowerCase() !== "cancelled",
      )
      .map((appointment) => appointment.client_id)
      .filter((id): id is string => Boolean(id)),
  );

  const rebookingClientIds = activeClients
    .filter(
      (client) =>
        recentClientIds.has(client.id) && !futureClientIds.has(client.id),
    )
    .map((client) => client.id);

  const enabledRuleKeys = new Set(
    automationRules.filter((rule) => rule.enabled).map((rule) => rule.rule_key),
  );

  const recommendedAutomationCount = [
    "low_package_balance",
    "no_upcoming_lesson",
    "pending_booking_request",
    "unsigned_document",
    "first_lesson_follow_up",
  ].filter((key) => !enabledRuleKeys.has(key)).length;

  const conversionIntroAppointments = conversionAppointments.filter(
    (appointment) =>
      appointment.client_id &&
      isIntroAppointmentType(appointment.appointment_type) &&
      !isCanceledConversionStatus(appointment.status),
  );
  const conversionIntroByClient = new Map<
    string,
    ConversionAppointmentRow[]
  >();
  conversionIntroAppointments.forEach((appointment) => {
    if (!appointment.client_id) return;
    const existing = conversionIntroByClient.get(appointment.client_id) ?? [];
    existing.push(appointment);
    conversionIntroByClient.set(appointment.client_id, existing);
  });

  const completedIntroByClient = new Map<string, ConversionAppointmentRow>();
  conversionIntroAppointments
    .filter((appointment) =>
      isCompletedConversionStatus(appointment.status),
    )
    .forEach((appointment) => {
      if (
        appointment.client_id &&
        !completedIntroByClient.has(appointment.client_id)
      ) {
        completedIntroByClient.set(appointment.client_id, appointment);
      }
    });

  const conversionPurchasesByClient = new Map<string, ConversionPurchase[]>();
  const conversionPurchases = [
    ...conversionPackages
      .filter((row) => row.client_id)
      .map((row) => ({
        clientId: row.client_id as string,
        date: new Date(row.purchase_date ?? row.created_at),
      })),
    ...conversionMemberships
      .filter((row) => row.client_id)
      .map((row) => ({
        clientId: row.client_id as string,
        date: new Date(row.created_at),
      })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
  conversionPurchases.forEach((purchase) => {
    const existing = conversionPurchasesByClient.get(purchase.clientId) ?? [];
    existing.push({ date: purchase.date });
    conversionPurchasesByClient.set(purchase.clientId, existing);
  });

  const leadToIntroClientIds = conversionClients
    .filter((client) =>
      (conversionIntroByClient.get(client.id) ?? []).some(
        (intro) => new Date(intro.starts_at) >= new Date(client.created_at),
      ),
    )
    .map((client) => client.id);
  const completedIntroClientIds = Array.from(completedIntroByClient.keys());
  const introConvertedClientIds = completedIntroClientIds.filter(
    (clientId) => {
      const intro = completedIntroByClient.get(clientId);
      const firstPurchase = conversionPurchasesByClient.get(clientId)?.[0];
      if (!intro || !firstPurchase) return false;
      return hasPurchaseWithinWindow(
        [firstPurchase],
        new Date(intro.starts_at),
        30,
      );
    },
  );
  const firstPurchaseClientIds = Array.from(
    conversionPurchasesByClient.entries(),
  )
    .filter(([, purchases]) => {
      const firstPurchase = purchases[0];
      return Boolean(
        firstPurchase &&
          firstPurchase.date >= ninetyDaysAgo &&
          firstPurchase.date <= now,
      );
    })
    .map(([clientId]) => clientId);
  const retainedClientIds = firstPurchaseClientIds.filter((clientId) => {
    const purchases = conversionPurchasesByClient.get(clientId) ?? [];
    const firstPurchase = purchases[0];
    return Boolean(
      firstPurchase &&
        hasPurchaseWithinWindow(purchases.slice(1), firstPurchase.date, 90),
    );
  });

  const leadsWithoutIntroCount = conversionClients.filter(
    (client) =>
      daysBetween(new Date(client.created_at), now) >= 3 &&
      !leadToIntroClientIds.includes(client.id),
  ).length;
  const introsWithoutPurchaseCount = completedIntroClientIds.filter(
    (clientId) => {
      const intro = completedIntroByClient.get(clientId);
      return Boolean(
        intro &&
          daysBetween(new Date(intro.starts_at), now) >= 7 &&
          !introConvertedClientIds.includes(clientId),
      );
    },
  ).length;
  const firstPurchaseWithoutRetentionCount = firstPurchaseClientIds.filter(
    (clientId) => {
      const firstPurchase = conversionPurchasesByClient.get(clientId)?.[0];
      return Boolean(
        firstPurchase &&
          daysBetween(firstPurchase.date, now) >= 30 &&
          !retainedClientIds.includes(clientId),
      );
    },
  ).length;

  const nextBestMove =
    pendingRequests.length > 0
      ? {
          title: "Booking requests need timely follow-up.",
          insight: `${pendingRequests.length} booking request${pendingRequests.length === 1 ? " is" : "s are"} waiting for staff review.`,
          recommendation:
            "Approve, decline, or contact those clients before the request turns into a missed opportunity.",
          href: "/app/schedule/requests?status=pending",
          label: "Review requests",
          metric: `${pendingRequests.length} pending`,
        }
      : introsWithoutPurchaseCount > 0
        ? {
            title: "Completed intros need a purchase follow-up.",
            insight: `${introsWithoutPurchaseCount} completed intro client${introsWithoutPurchaseCount === 1 ? " has" : "s have"} not made a first purchase after at least 7 days.`,
            recommendation:
              "Review the conversion list, contact the warmest opportunities, and ask what is preventing the next step.",
            href: "/app/analytics?range=90",
            label: "Review intro gaps",
            metric: `${introsWithoutPurchaseCount} follow-up${introsWithoutPurchaseCount === 1 ? "" : "s"}`,
          }
        : lowBalancePackages.length > 0
      ? {
          title: "Package renewals are the fastest revenue opportunity.",
          insight: `${lowBalancePackages.length} active package${lowBalancePackages.length === 1 ? "" : "s"} have 2 or fewer credits remaining, including ${depletedPackages.length} depleted package${depletedPackages.length === 1 ? "" : "s"}.`,
          recommendation:
            "Review low-balance clients first, then use the low package balance automation to prepare renewal follow-ups before the next lesson.",
          href: "/app/packages/client-balances",
          label: "Review balances",
          metric: `${lowBalancePackages.length} renewal lead${lowBalancePackages.length === 1 ? "" : "s"}`,
        }
      : firstPurchaseWithoutRetentionCount > 0
        ? {
            title: "First-purchase clients need a retention plan.",
            insight: `${firstPurchaseWithoutRetentionCount} first-purchase client${firstPurchaseWithoutRetentionCount === 1 ? " has" : "s have"} gone at least 30 days without buying again.`,
            recommendation:
              "Review their lesson activity and package usage, then prioritize a personal rebooking or renewal conversation.",
            href: "/app/analytics?range=90",
            label: "Review retention gaps",
            metric: `${firstPurchaseWithoutRetentionCount} at risk`,
          }
        : rebookingClientIds.length > 0
          ? {
              title: "Rebooking is your next best move.",
              insight: `${rebookingClientIds.length} active client${rebookingClientIds.length === 1 ? "" : "s"} had a recent lesson but no future appointment scheduled.`,
              recommendation:
                "Use the no upcoming lesson automation to prepare rebooking prompts with usual-time suggestions.",
              href: "/app/automations",
              label: "Open automations",
              metric: `${rebookingClientIds.length} rebooking lead${rebookingClientIds.length === 1 ? "" : "s"}`,
            }
          : leadsWithoutIntroCount > 0
            ? {
                title: "New leads need an intro path.",
                insight: `${leadsWithoutIntroCount} lead${leadsWithoutIntroCount === 1 ? " has" : "s have"} gone at least 3 days without intro activity.`,
                recommendation:
                  "Review the lead list and offer a clear next step while their interest is still fresh.",
                href: "/app/analytics?range=90",
                label: "Review lead gaps",
                metric: `${leadsWithoutIntroCount} waiting`,
              }
            : {
              title: "Your studio is ready for the next growth layer.",
              insight:
                "ARIA did not find an urgent renewal or booking backlog right now.",
              recommendation:
                "Use automations to keep the front desk rhythm consistent, then set a revenue goal when ARIA Goals becomes available.",
              href: "/app/automations",
              label: "Review automations",
              metric: "Stable",
            };

  const commerceIntelligence = await getCommerceIntelligence({
    supabase,
    studioId,
  });

  return (
    <main className="space-y-8 p-6 md:p-8">
      <section className="overflow-hidden rounded-[36px] border border-[#F9A8D4] bg-white shadow-sm">
        <div className="relative p-6 md:p-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.18),transparent_32%),linear-gradient(135deg,rgba(255,247,237,0.9),rgba(255,255,255,0.95)_45%,rgba(250,245,255,0.9))]" />
          <div className="relative grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
            <AriaAvatar size="lg" />
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#BE185D]">
                ARIA Opportunity Hub
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                Hi, I’m ARIA.
              </h1>
              <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-2xl border border-[#F9A8D4] bg-white/80 px-3 py-2 text-sm font-semibold text-[#831843] shadow-sm">
                <span className="rounded-full bg-[#FCE7F3] px-2.5 py-1 text-xs font-bold uppercase tracking-[0.16em] text-[#BE185D]">
                  ARIA
                </span>
                <span>AI Revenue Insights Assistant</span>
              </div>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-700 md:text-base">
                I’m your AI Revenue Insights Assistant. My job is to help you
                spot the opportunities hiding inside your studio data, turn them
                into clear next steps, and keep you moving toward your goals.
              </p>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-700 md:text-base">
                I’ll help you find clients who need follow-up, packages ready
                for renewal, booking requests that need attention, documents
                that need signatures, and automations that can reduce front desk
                work. Think of me as your studio’s growth coach — I’ll help you
                decide what to focus on next.
              </p>
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-white/85 p-4 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                    Starter
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-950">
                    Meet ARIA
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    Basic ARIA insights help point you toward the next useful
                    action.
                  </p>
                </div>
                <div className="rounded-2xl border border-violet-200 bg-violet-50/80 p-4 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-700">
                    Growth
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-950">
                    Unlock the opportunity hub
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    Review revenue opportunities, automation recommendations,
                    and client follow-ups.
                  </p>
                </div>
                <div className="rounded-2xl border border-pink-200 bg-pink-50/80 p-4 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-pink-700">
                    Pro
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-950">
                    Plan with ARIA
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    Future ARIA Goals, growth plans, advanced AI
                    recommendations, and Chat with ARIA.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
              <Link
                href="/app/aria/operations"
                className="inline-flex items-center justify-center rounded-2xl bg-[#6B21A8] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#581C87]"
              >
                Open Operations Center
              </Link>
              <Link
                href="/app/automations"
                className="inline-flex items-center justify-center rounded-2xl border border-[#C084FC] bg-white/80 px-4 py-3 text-sm font-semibold text-[#6B21A8] shadow-sm hover:bg-white"
              >
                Automation Settings
              </Link>
            </div>
          </div>
        </div>
      </section>

      <CommerceIntelligenceSection
        data={commerceIntelligence}
        title="Sales, inventory, and digital learning signals"
      />

      <AriaInsightCard
        eyebrow="ARIA's Next Best Move"
        title={nextBestMove.title}
        insight={nextBestMove.insight}
        recommendation={nextBestMove.recommendation}
        metric={nextBestMove.metric}
        primaryAction={{ href: nextBestMove.href, label: nextBestMove.label }}
        secondaryAction={{ href: "/app/analytics?range=90", label: "View analytics" }}
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OpportunityCard
          tone="revenue"
          icon={Package}
          title="Package renewal opportunities"
          metric={`${lowBalancePackages.length}`}
          description="Low balances are usually the fastest path to repeat revenue because the client is already active."
          href="/app/packages/client-balances"
          actionLabel="Review balances"
        />
        <OpportunityCard
          tone="retention"
          icon={CalendarDays}
          title="Rebooking opportunities"
          metric={`${rebookingClientIds.length}`}
          description="Active clients with recent lesson history but no future appointment are strong candidates for a rebooking prompt."
          href="/app/automations"
          actionLabel="Evaluate rebooking"
        />
        <OpportunityCard
          tone="booking"
          icon={ClipboardList}
          title="Pending booking requests"
          metric={`${pendingRequests.length}`}
          description="Requests should be handled quickly so interested leads and clients do not lose momentum."
          href="/app/schedule/requests?status=pending"
          actionLabel="Review requests"
        />
        <OpportunityCard
          tone="automation"
          icon={WandSparkles}
          title="Automation recommendations"
          metric={`${recommendedAutomationCount}`}
          description="ARIA recommends enabling the automations that match your current workload and follow-up patterns."
          href="/app/automations"
          actionLabel="Open rules"
        />
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              ARIA Conversion Pulse
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Where clients are moving and where they are getting stuck
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              A 90-day view using the same conversion definitions as Studio
              Analytics.
            </p>
          </div>
          <Link
            href="/app/analytics?range=90"
            className="inline-flex items-center gap-2 text-sm font-semibold text-[#6B21A8] hover:underline"
          >
            Open Studio Analytics
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <OpportunityCard
            tone="booking"
            icon={Target}
            title="Lead to intro"
            metric={conversionPercent(
              leadToIntroClientIds.length,
              conversionClients.length,
            )}
            description={`${leadsWithoutIntroCount} lead${leadsWithoutIntroCount === 1 ? " is" : "s are"} overdue for an intro next step after the 3-day follow-up window.`}
            href="/app/analytics?range=90"
            actionLabel="Review lead gaps"
          />
          <OpportunityCard
            tone="revenue"
            icon={CheckCircle2}
            title="Intro to first purchase"
            metric={conversionPercent(
              introConvertedClientIds.length,
              completedIntroClientIds.length,
            )}
            description={`${introsWithoutPurchaseCount} completed intro client${introsWithoutPurchaseCount === 1 ? " needs" : "s need"} purchase follow-up after the 7-day grace period.`}
            href="/app/analytics?range=90"
            actionLabel="Review conversion gaps"
          />
          <OpportunityCard
            tone="retention"
            icon={TrendingUp}
            title="First purchase to retention"
            metric={conversionPercent(
              retainedClientIds.length,
              firstPurchaseClientIds.length,
            )}
            description={`${firstPurchaseWithoutRetentionCount} first-purchase client${firstPurchaseWithoutRetentionCount === 1 ? " is" : "s are"} due for retention attention after 30 days.`}
            href="/app/analytics?range=90"
            actionLabel="Review retention gaps"
          />
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">
              ARIA Dance Goal Intelligence
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              What client goals are telling ARIA
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              ARIA reads Dance Goal Analytics to connect motivation with conversion,
              retention, lessons, and lifetime spend.
            </p>
          </div>
          <Link
            href="/app/analytics/dance-goals?range=90"
            className="inline-flex items-center gap-2 text-sm font-semibold text-[#BE185D] hover:underline"
          >
            Open Dance Goal Analytics
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {danceGoalIntelligence.recommendations.slice(0, 2).map((recommendation) => (
            <AriaInsightCard
              key={recommendation.title}
              eyebrow="ARIA Goal Signal"
              title={recommendation.title}
              insight={recommendation.insight}
              recommendation={recommendation.recommendation}
              metric={recommendation.metric}
              primaryAction={{
                href: "/app/analytics/dance-goals?range=90",
                label: "Review goal metrics",
              }}
              compact
            />
          ))}
        </div>
      </section>

      <section className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Active ARIA actions
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Reviewable actions from automations
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                These are suggestions and drafts created by automation
                evaluations. They are safe to review because DanceFlow does not
                auto-send messages from these V1 automations.
              </p>
            </div>
            <Link
              href="/app/automations"
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-[#6B21A8] hover:bg-slate-50"
            >
              Manage actions
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          {automationActions.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm leading-6 text-slate-600">
              No active automation actions yet. Enable a rule, click Evaluate
              now, and ARIA will surface reviewable next steps here.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {automationActions.slice(0, 6).map((action) => (
                <article
                  key={action.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-[#6B21A8] ring-1 ring-violet-200">
                          {ruleLabel(action.rule_key)}
                        </span>
                        <span
                          className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${priorityClass(action.priority)}`}
                        >
                          {action.priority}
                        </span>
                      </div>
                      <h3 className="mt-3 text-base font-semibold text-slate-950">
                        {action.title}
                      </h3>
                      {action.body ? (
                        <p className="mt-1 text-sm leading-6 text-slate-600">
                          {action.body}
                        </p>
                      ) : null}
                    </div>
                    <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                      {action.status}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
            Guided workflows
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Where ARIA sends you next
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Operational pages still remain the source of truth. ARIA summarizes
            the decision and routes you into the right workflow.
          </p>

          <div className="mt-5 space-y-3">
            {[
              {
                title: "Renewal review",
                body: "Open package balances when ARIA finds low-credit clients.",
                href: "/app/packages/client-balances",
                icon: Package,
              },
              {
                title: "Booking request review",
                body: "Open the queue when a request needs approval, decline, or follow-up.",
                href: "/app/schedule/requests?status=pending",
                icon: ClipboardList,
              },
              {
                title: "Document follow-up",
                body: "Open Documents when clients still need to sign forms or waivers.",
                href: "/app/documents",
                icon: FileSignature,
              },
              {
                title: "Automation settings",
                body: "Enable and evaluate the rules that let ARIA prepare actions for staff.",
                href: "/app/automations",
                icon: Bell,
              },
            ].map((item) => {
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-[#F9A8D4] hover:bg-white"
                >
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white text-[#6B21A8] ring-1 ring-violet-200">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-slate-950">
                      {item.title}
                    </span>
                    <span className="mt-1 block text-sm leading-6 text-slate-600">
                      {item.body}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              ARIA Goals
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Turn opportunities into a focused growth plan.
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Give ARIA a revenue, retention, membership, booking, event, or
              attendance goal with a timeline. She will organize the opportunity
              hub into a practical plan with focus areas, suggested automations,
              weekly milestones, and KPIs to watch.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                href="/app/aria/goals"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#BE185D] to-[#F97316] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-95"
              >
                Open ARIA Goals
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/app/automations"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-[#F9A8D4] hover:text-[#BE185D]"
              >
                Review automations
              </Link>
            </div>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-[#FCE7F3] px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-[#BE185D] ring-1 ring-[#F9A8D4]">
            <Target className="h-3.5 w-3.5" />
            Goal planning
          </span>
        </div>

        {activeGoal ? (
          <div className="mt-5 rounded-2xl border border-[#F9A8D4] bg-[#FDF2F8] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#BE185D]">
                  Active goal
                </p>
                <h3 className="mt-2 text-base font-semibold text-slate-950">
                  {activeGoal.title}
                </h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Target:{" "}
                  {formatGoalTarget(
                    activeGoal.target_value,
                    activeGoal.target_unit,
                  )}
                  {activeGoal.target_date
                    ? ` by ${formatDate(activeGoal.target_date)}`
                    : ""}
                  .
                  {activeGoal.current_value !== null &&
                  activeGoal.current_value !== undefined
                    ? ` Current progress: ${formatGoalTarget(activeGoal.current_value, activeGoal.target_unit)}.`
                    : " Add progress updates so ARIA can track the plan."}
                </p>
              </div>
              <Link
                href={`/app/aria/goals/${activeGoal.id}`}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#BE185D] ring-1 ring-[#F9A8D4]"
              >
                Open goal
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
