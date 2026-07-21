import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  canViewReports,
  isOrganizerWorkspaceRole,
} from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getCurrentWorkspaceCapabilitiesForUser } from "@/lib/billing/access";
import ReportInsightsCard from "./ReportInsightsCard";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import AriaAccountingInsightsSection from "@/components/app/reports/AriaAccountingInsightsSection";
import ReportReadinessCard from "@/components/app/reports/ReportReadinessCard";
import {
  accountingCategoryLabel,
  getStudioAccountingEntries,
  summarizeAccountingEntries,
} from "@/lib/accounting/entries";
import {
  buildEventFinancialSummary,
  buildEventProfitabilityByEventId,
} from "@/lib/events/financial-summary";

type SearchParams = Promise<{
  range?: string;
}>;

type PaymentRow = {
  id: string;
  amount: number | null;
  status: string | null;
  payment_method: string | null;
  payment_type: string | null;
  source: string | null;
  payment_channel: string | null;
  client_package_id?: string | null;
  client_membership_id?: string | null;
  refunded_amount?: number | null;
  refund_amount?: number | null;
  created_at: string;
  clients:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
};

type ClientRow = {
  id: string;
  status: string | null;
  created_at: string;
  referral_source: string | null;
};

type AppointmentRow = {
  id: string;
  status: string | null;
  starts_at: string;
  appointment_type: string | null;
  instructor_id: string | null;
  duration_minutes: number | null;
  price_amount: number | null;
  payment_status: string | null;
};

type ClientPackageRow = {
  id: string;
  active: boolean | null;
  created_at: string;
  name_snapshot: string | null;
  lesson_count_snapshot?: number | string | null;
  price_snapshot: number | string | null;
  lessons_used?: number | string | null;
  lessons_remaining?: number | string | null;
  purchase_date?: string | null;
  expiration_date?: string | null;
  sold_price: number | string | null;
};

type ClientMembershipRow = {
  id: string;
  status: string | null;
  created_at: string;
  name_snapshot: string | null;
  price_snapshot: number | null;
  signup_fee_snapshot: number | null;
  billing_interval_snapshot: string | null;
  current_period_end?: string | null;
  auto_renew?: boolean | null;
  cancel_at_period_end?: boolean | null;
};

type EventRegistrationRevenueRow = {
  id: string;
  event_id: string | null;
  studio_id: string | null;
  ticket_type_id?: string | null;
  status?: string | null;
  quantity: number | null;
  payment_status: string | null;
  total_amount: number | null;
  total_price: number | null;
  currency: string | null;
  checked_in_at?: string | null;
  created_at: string;
  events:
    | {
        name: string | null;
        event_type: string | null;
        start_date: string | null;
      }
    | {
        name: string | null;
        event_type: string | null;
        start_date: string | null;
      }[]
    | null;
  event_ticket_types:
    | { name: string | null; ticket_kind: string | null }
    | { name: string | null; ticket_kind: string | null }[]
    | null;
};

type EventAttendeeReportRow = {
  id: string;
  registration_id: string;
  checked_in_at: string | null;
};

type EventSummary = {
  eventId: string;
  name: string;
  type: string;
  registrations: number;
  tickets: number;
  checkedIn: number;
  noShows: number;
  revenue: number;
  refunds: number;
  fees: number;
  netRevenue: number;
  expenses: number;
  profitLoss: number;
  marginPercent: number | null;
};

type TicketSummary = {
  key: string;
  name: string;
  kind: string;
  registrations: number;
  quantity: number;
  revenue: number;
};

type CategorySummary = {
  key: string;
  label: string;
  count: number;
  total: number;
};

type ExpenseRow = {
  id: string;
  expense_date: string;
  vendor_name: string;
  category: string;
  amount: number | null;
  currency: string | null;
  payment_method: string | null;
  related_event_id?: string | null;
  notes: string | null;
  created_at: string;
};

type InstructorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

type InstructorSummary = {
  instructorId: string;
  name: string;
  totalAppointments: number;
  attended: number;
  scheduled: number;
  cancelled: number;
  noShows: number;
  privateLessons: number;
  groupClasses: number;
  minutes: number;
  revenue: number;
};

type InstructorEarningReportRow = {
  id: string;
  instructor_id: string | null;
  earning_date: string | null;
  source_type: string | null;
  appointment_type: string | null;
  gross_revenue_basis: number | string | null;
  earning_amount: number | string | null;
  status: string | null;
  paid_at: string | null;
  payment_method: string | null;
};

type InstructorPaySummary = {
  instructorId: string;
  name: string;
  count: number;
  pending: number;
  approved: number;
  paid: number;
  total: number;
};

type OrganizerAccessRow = {
  organizer_id: string;
  role: string | null;
  active: boolean | null;
};

type OrganizerReportRow = {
  id: string;
  name: string;
  slug: string | null;
  active: boolean | null;
};

type OrganizerContactReportRow = {
  id: string;
  organizer_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  total_registrations: number | null;
  total_paid_registrations: number | null;
  total_spend: number | null;
  last_seen_at: string | null;
  created_at: string;
};

type OrganizerContactRegistrationReportRow = {
  id: string;
  organizer_id: string;
  organizer_contact_id: string | null;
  event_id: string | null;
  registration_id: string | null;
  payment_status: string | null;
  status: string | null;
  total_amount: number | null;
  currency: string | null;
  registered_at: string | null;
  checked_in_at: string | null;
};

type OrganizerEventReportRow = {
  id: string;
  organizer_id: string | null;
  name: string | null;
  start_date: string | null;
};

type OrganizerCampaignReportRow = {
  id: string;
  organizer_id: string;
  name: string;
  status: string;
  audience_type: string | null;
  sent_at: string | null;
  created_at: string;
};

type OrganizerCampaignRecipientReportRow = {
  id: string;
  campaign_id: string;
  organizer_id: string;
  status: string | null;
  created_at: string;
};

type OrganizerEventSummary = {
  eventId: string;
  organizerId: string;
  organizerName: string;
  eventName: string;
  registrations: number;
  paidRegistrations: number;
  checkedIn: number;
  noShows: number;
  revenue: number;
};


type RetailOrderRow = {
  id: string;
  order_number: string;
  payment_status: string;
  status: string;
  subtotal: number | string | null;
  discount_total: number | string | null;
  tax_total: number | string | null;
  refund_total: number | string | null;
  total: number | string | null;
  created_at: string;
  commerce_order_items:
    | {
        id: string;
        catalog_item_id: string | null;
        variant_id: string | null;
        name_snapshot: string;
        sku_snapshot: string | null;
        quantity: number;
        unit_price: number | string | null;
        discount_total: number | string | null;
        line_total: number | string | null;
        cogs_total: number | string | null;
      }[]
    | {
        id: string;
        catalog_item_id: string | null;
        variant_id: string | null;
        name_snapshot: string;
        sku_snapshot: string | null;
        quantity: number;
        unit_price: number | string | null;
        discount_total: number | string | null;
        line_total: number | string | null;
        cogs_total: number | string | null;
      }
    | null;
  payments:
    | { payment_method: string | null; payment_channel: string | null }
    | { payment_method: string | null; payment_channel: string | null }[]
    | null;
};

type RetailInventoryRow = {
  id: string;
  catalog_item_id: string;
  name: string;
  sku: string | null;
  quantity_on_hand: number | null;
  reorder_threshold: number | null;
  unit_cost: number | string | null;
  active: boolean;
  commerce_catalog_items:
    | { name: string; active: boolean }
    | { name: string; active: boolean }[]
    | null;
};


type StripePayoutRow = {
  id: string;
  studio_id: string | null;
  stripe_account_id: string | null;
  stripe_payout_id: string;
  stripe_balance_transaction_id: string | null;
  amount: number | string | null;
  currency: string | null;
  status: string | null;
  arrival_date: string | null;
  payout_created_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type StripePayoutItemRow = {
  id: string;
  stripe_payout_id: string;
  stripe_account_id: string | null;
  stripe_balance_transaction_id: string | null;
  stripe_source_id: string | null;
  stripe_source_type: string | null;
  studio_id: string | null;
  payment_id: string | null;
  event_payment_id: string | null;
  amount: number | string | null;
  fee: number | string | null;
  net: number | string | null;
  currency: string | null;
  type: string | null;
  reporting_category: string | null;
  description: string | null;
  available_on: string | null;
  balance_transaction_created_at: string | null;
  created_at: string;
};

type PayoutItemSummary = {
  payoutId: string;
  itemCount: number;
  matchedCount: number;
  unmatchedCount: number;
  grossAmount: number;
  fees: number;
  netAmount: number;
};

type RecentPayoutSummary = StripePayoutRow & {
  itemSummary: PayoutItemSummary;
};

function fmtCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function fmtNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDate(value: string | null | undefined) {
  if (!value) return "Not scheduled";

  return new Date(`${value}T00:00:00`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function moneyValue(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}


const DEFAULT_TIME_ZONE = "America/New_York";

function getStudioTimeZone(value?: string | null) {
  const timeZone = value?.trim() || DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function getZonedDateTimeParts(value: Date | string, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const hourValue = Number(lookup.get("hour") ?? "0");

  return {
    year: lookup.get("year") ?? "0000",
    month: lookup.get("month") ?? "01",
    day: lookup.get("day") ?? "01",
    hour: String(hourValue === 24 ? 0 : hourValue).padStart(2, "0"),
    minute: lookup.get("minute") ?? "00",
    second: lookup.get("second") ?? "00",
  };
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour = 0, minute = 0, second = 0] = time.split(":").map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);

  for (let i = 0; i < 2; i += 1) {
    const offsetMs = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMs;
  }

  return new Date(utcMs);
}

function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(date, time, timeZone).toISOString();
}

function getZonedDateKey(value: Date | string, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return date.toISOString().slice(0, 10);
}

function getRangeStartDateKey(range: string, timeZone: string) {
  const nowParts = getZonedDateTimeParts(new Date(), timeZone);
  const year = Number(nowParts.year);
  const month = Number(nowParts.month);

  if (range === "today") {
    return `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
  }

  if (range === "last_30" || range === "last30") {
    return addDaysToDateKey(`${nowParts.year}-${nowParts.month}-${nowParts.day}`, -30);
  }

  if (range === "quarter") {
    const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return `${year}-${String(quarterStartMonth).padStart(2, "0")}-01`;
  }

  if (range === "year") {
    return `${year}-01-01`;
  }

  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function getRangeStartIso(range: string, timeZone: string) {
  return zonedDateTimeToUtcIso(getRangeStartDateKey(range, timeZone), "00:00", timeZone);
}


function rangeLabel(range: string) {
  if (range === "today") return "Today";
  if (range === "last30") return "Last 30 Days";
  if (range === "quarter") return "This Quarter";
  if (range === "year") return "This Year";
  return "This Month";
}

function exportHref(path: string, range: string) {
  return `${path}?range=${encodeURIComponent(range)}`;
}

function getClientName(
  value:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  if (!client) return "Unknown Client";

  return (
    [client.first_name ?? "", client.last_name ?? ""].join(" ").trim() ||
    "Unknown Client"
  );
}

function getEventInfo(
  value:
    | {
        name: string | null;
        event_type: string | null;
        start_date: string | null;
      }
    | {
        name: string | null;
        event_type: string | null;
        start_date: string | null;
      }[]
    | null,
) {
  return Array.isArray(value) ? value[0] : value;
}

function getTicketInfo(
  value:
    | { name: string | null; ticket_kind: string | null }
    | { name: string | null; ticket_kind: string | null }[]
    | null,
) {
  return Array.isArray(value) ? value[0] : value;
}

function isFloorRentalPayment(payment: PaymentRow) {
  const paymentType = (payment.payment_type ?? "").toLowerCase();
  const source = (payment.source ?? "").toLowerCase();

  return (
    paymentType === "floor_fee" ||
    paymentType === "floor_space_rental" ||
    source === "floor_rental" ||
    source === "portal_floor_rental_balance_checkout"
  );
}

function labelize(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ");
}

function paymentChannelLabel(value: string | null | undefined) {
  if (value === "terminal") return "Card Reader";
  if (value === "online") return "Online";
  if (value === "manual") return "Manual";
  return labelize(value);
}

function expenseCategoryLabel(value: string | null | undefined) {
  if (value === "floor_fee") return "Floor Rental / Floor Fee";
  if (value === "rent") return "Rent";
  if (value === "instructor_pay") return "Instructor Pay";
  if (value === "marketing") return "Marketing";
  if (value === "software") return "Software";
  if (value === "supplies") return "Supplies";
  if (value === "costumes_retail_inventory")
    return "Costumes / Retail Inventory";
  if (value === "event_expense") return "Event Expense";
  if (value === "travel") return "Travel";
  if (value === "meals") return "Meals";
  if (value === "utilities") return "Utilities";
  if (value === "insurance") return "Insurance";
  if (value === "professional_services") return "Professional Services";
  return labelize(value);
}

function paymentStatusBadgeClass(status: string | null) {
  if (status === "paid") return "bg-green-50 text-green-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "refunded") return "bg-blue-50 text-blue-700";
  return "bg-slate-100 text-slate-700";
}

function payoutStatusBadgeClass(status: string | null) {
  if (status === "paid") return "bg-green-50 text-green-700";
  if (status === "in_transit" || status === "pending")
    return "bg-amber-50 text-amber-700";
  if (status === "failed" || status === "canceled")
    return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function sourceLabel(value: string | null) {
  if (value === "website") return "Website";
  if (value === "public_discovery") return "Public Discovery";
  if (value === "referral") return "Referral";
  if (value === "walk_in") return "Walk-In";
  return labelize(value);
}

function sortEntriesDesc<T extends string>(
  record: Record<T, number>,
): Array<[T, number]> {
  return (Object.entries(record) as Array<[T, number]>).sort(
    (a, b) => b[1] - a[1],
  );
}

function percentage(part: number, total: number) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function monthlyMembershipAmount(
  amount: number,
  interval: string | null | undefined,
) {
  const normalized = (interval ?? "month").toLowerCase();

  if (normalized.includes("week")) return amount * 4.333;
  if (normalized.includes("quarter")) return amount / 3;
  if (normalized.includes("year") || normalized.includes("annual")) {
    return amount / 12;
  }

  return amount;
}

function isMembershipPayment(payment: PaymentRow) {
  const paymentType = (payment.payment_type ?? "").toLowerCase();
  const source = (payment.source ?? "").toLowerCase();

  return (
    Boolean(payment.client_membership_id) ||
    paymentType.includes("membership") ||
    source.includes("membership")
  );
}

function isPackagePayment(payment: PaymentRow) {
  const paymentType = (payment.payment_type ?? "").toLowerCase();
  const source = (payment.source ?? "").toLowerCase();

  return (
    Boolean(payment.client_package_id) ||
    paymentType.includes("package") ||
    source.includes("package")
  );
}

function packageUnitCreditValue(pkg: ClientPackageRow) {
  const soldPrice = moneyValue(pkg.sold_price ?? pkg.price_snapshot);
  const creditCount = moneyValue(pkg.lesson_count_snapshot);

  if (soldPrice <= 0 || creditCount <= 0) return 0;

  return soldPrice / creditCount;
}

function packageOutstandingValue(pkg: ClientPackageRow) {
  return packageUnitCreditValue(pkg) * Math.max(0, moneyValue(pkg.lessons_remaining));
}

function organizerContactName(contact: OrganizerContactReportRow) {
  const name = [contact.first_name, contact.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return name || contact.email;
}

function campaignStatusLabel(status: string | null | undefined) {
  if (!status) return "Draft";
  return labelize(status);
}

function LockedReportCard({
  eyebrow,
  title,
  description,
  requiredPlan,
}: {
  eyebrow: string;
  title: string;
  description: string;
  requiredPlan: "Growth" | "Pro";
}) {
  const requiredPlanCode = requiredPlan.toLowerCase();

  return (
    <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
      <Link
        href={`/app/settings/billing?reason=reports_upgrade&requiredPlan=${requiredPlanCode}`}
        className="mt-5 inline-flex rounded-xl bg-[#7C2D92] px-4 py-2 text-sm font-semibold text-white hover:bg-[#5B197A]"
      >
        View Plans
      </Link>
    </div>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const range = params.range ?? "month";

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;

  if (!studioId) {
    redirect("/app");
  }

  const { data: studioTimeZoneRow } = await supabase
    .from("studios")
    .select("timezone")
    .eq("id", studioId)
    .maybeSingle<{ timezone: string | null }>();

  const studioTimeZone = getStudioTimeZone(studioTimeZoneRow?.timezone);
  const rangeStartDateOnly = getRangeStartDateKey(range, studioTimeZone);
  const rangeStart = getRangeStartIso(range, studioTimeZone);
  const todayDateOnly = getZonedDateKey(new Date(), studioTimeZone);
  const nowIso = new Date().toISOString();

  const workspaceCapabilities = await getCurrentWorkspaceCapabilitiesForUser();
  const studioPlanCode = workspaceCapabilities?.planCode ?? null;
  const canViewGrowthReports =
    studioPlanCode === "growth" || studioPlanCode === "pro";
  const canViewProReports = studioPlanCode === "pro";

  const [
    { data: payments, error: paymentsError },
    { data: leads, error: leadsError },
    { data: appointments, error: appointmentsError },
    { data: packages, error: packagesError },
    { data: packagePortfolio, error: packagePortfolioError },
    { data: memberships, error: membershipsError },
    { data: membershipPortfolio, error: membershipPortfolioError },
    { data: eventRegistrations, error: eventRegistrationsError },
    { data: expenses, error: expensesError },
    { data: instructors, error: instructorsError },
    { data: instructorEarnings, error: instructorEarningsError },
    { count: activeStudentsCount, error: activeStudentsError },
    { data: retailOrders, error: retailOrdersError },
    { data: retailInventory, error: retailInventoryError },
  ] = await Promise.all([
    supabase
      .from("payments")
      .select(
        `
          id,
          amount,
          status,
          payment_method,
          payment_type,
          source,
          payment_channel,
          client_package_id,
          client_membership_id,
          refunded_amount,
          refund_amount,
          created_at,
          clients (
            first_name,
            last_name
          )
        `,
      )
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("clients")
      .select("id, status, created_at, referral_source")
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("appointments")
      .select(
        "id, status, starts_at, appointment_type, instructor_id, duration_minutes, price_amount, payment_status",
      )
      .eq("studio_id", studioId)
      .gte("starts_at", rangeStart)
      .lte("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(1000),

    supabase
      .from("client_packages")
      .select(
        "id, active, created_at, name_snapshot, lesson_count_snapshot, price_snapshot, lessons_used, lessons_remaining, purchase_date, expiration_date, sold_price",
      )
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("client_packages")
      .select(
        "id, active, created_at, name_snapshot, lesson_count_snapshot, price_snapshot, lessons_used, lessons_remaining, purchase_date, expiration_date, sold_price",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(1000),

    supabase
      .from("client_memberships")
      .select(
        "id, status, created_at, name_snapshot, price_snapshot, signup_fee_snapshot, billing_interval_snapshot, current_period_end, auto_renew, cancel_at_period_end",
      )
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("client_memberships")
      .select(
        "id, status, created_at, name_snapshot, price_snapshot, signup_fee_snapshot, billing_interval_snapshot, current_period_end, auto_renew, cancel_at_period_end",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(1000),

    supabase
      .from("event_registrations")
      .select(
        `
          id,
          event_id,
          studio_id,
          ticket_type_id,
          status,
          quantity,
          payment_status,
          total_amount,
          total_price,
          currency,
          checked_in_at,
          created_at,
          events ( name, event_type, start_date ),
          event_ticket_types ( name, ticket_kind )
        `,
      )
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(1000),

    supabase
      .from("expenses")
      .select(
        "id, expense_date, vendor_name, category, amount, currency, payment_method, related_event_id, notes, created_at",
      )
      .eq("studio_id", studioId)
      .gte("expense_date", rangeStartDateOnly)
      .lte("expense_date", todayDateOnly)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1000),

    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .order("first_name", { ascending: true })
      .limit(500),

    supabase
      .from("instructor_earnings")
      .select(
        "id, instructor_id, earning_date, source_type, appointment_type, gross_revenue_basis, earning_amount, status, paid_at, payment_method",
      )
      .eq("studio_id", studioId)
      .gte("earning_date", rangeStartDateOnly)
      .lte("earning_date", todayDateOnly)
      .order("earning_date", { ascending: false })
      .limit(2000),

    supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("status", "active"),

    supabase
      .from("commerce_orders")
      .select(
        `
          id,
          order_number,
          payment_status,
          status,
          subtotal,
          discount_total,
          tax_total,
          refund_total,
          total,
          created_at,
          commerce_order_items (
            id,
            catalog_item_id,
            variant_id,
            name_snapshot,
            sku_snapshot,
            quantity,
            unit_price,
            discount_total,
            line_total,
            cogs_total
          ),
          payments (
            payment_method,
            payment_channel
          )
        `,
      )
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(1000),

    supabase
      .from("commerce_product_variant_inventory")
      .select(
        `
          id,
          catalog_item_id,
          name,
          sku,
          quantity_on_hand,
          reorder_threshold,
          unit_cost,
          active,
          commerce_catalog_items (
            name,
            active
          )
        `,
      )
      .eq("studio_id", studioId)
      .eq("active", true)
      .limit(5000),
  ]);

  if (paymentsError) {
    throw new Error(
      `Failed to load payments report data: ${paymentsError.message}`,
    );
  }
  if (leadsError) {
    throw new Error(`Failed to load lead report data: ${leadsError.message}`);
  }
  if (appointmentsError) {
    throw new Error(
      `Failed to load appointment report data: ${appointmentsError.message}`,
    );
  }
  if (packagesError) {
    throw new Error(
      `Failed to load package report data: ${packagesError.message}`,
    );
  }
  if (packagePortfolioError) {
    throw new Error(
      `Failed to load package portfolio report data: ${packagePortfolioError.message}`,
    );
  }
  if (membershipsError) {
    throw new Error(
      `Failed to load membership report data: ${membershipsError.message}`,
    );
  }
  if (membershipPortfolioError) {
    throw new Error(
      `Failed to load membership portfolio report data: ${membershipPortfolioError.message}`,
    );
  }
  if (eventRegistrationsError) {
    throw new Error(
      `Failed to load event revenue report data: ${eventRegistrationsError.message}`,
    );
  }
  if (expensesError) {
    throw new Error(
      `Failed to load expense report data: ${expensesError.message}`,
    );
  }
  if (instructorsError) {
    throw new Error(
      `Failed to load instructor report data: ${instructorsError.message}`,
    );
  }
  if (instructorEarningsError) {
    throw new Error(
      `Failed to load instructor pay report data: ${instructorEarningsError.message}`,
    );
  }
  if (activeStudentsError) {
    throw new Error(
      `Failed to load active students count: ${activeStudentsError.message}`,
    );
  }

  if (retailOrdersError) {
    throw new Error(
      `Failed to load retail order report data: ${retailOrdersError.message}`,
    );
  }

  if (retailInventoryError) {
    throw new Error(
      `Failed to load retail inventory report data: ${retailInventoryError.message}`,
    );
  }

  const accountingEntries = await getStudioAccountingEntries({
    supabase,
    studioId,
    startDate: rangeStart,
    endDate: nowIso,
  });
  const accountingSummary = summarizeAccountingEntries(accountingEntries);
  const accountingRevenueCategories = Array.from(
    accountingEntries
      .filter((entry) => entry.entryType === "revenue")
      .reduce((map, entry) => {
        const key = entry.category || "other_income";
        const existing = map.get(key) ?? {
          key,
          label: accountingCategoryLabel(key),
          count: 0,
          total: 0,
        };

        existing.count += 1;
        existing.total += entry.grossAmount;
        map.set(key, existing);

        return map;
      }, new Map<string, CategorySummary>())
      .values(),
  ).sort((a, b) => b.total - a.total);

  const eventTicketAccountingEntries = accountingEntries.filter(
    (entry) =>
      entry.sourceTable === "event_payments" &&
      entry.entryType === "revenue" &&
      entry.category === "event_ticket_revenue",
  );

  const accountingExpenseCategories = Array.from(
    accountingEntries
      .filter((entry) => entry.entryType === "expense")
      .reduce((map, entry) => {
        const key = entry.category || "other_expense";
        const existing = map.get(key) ?? {
          key,
          label: accountingCategoryLabel(key),
          count: 0,
          total: 0,
        };

        existing.count += 1;
        existing.total += Math.abs(entry.netAmount);
        map.set(key, existing);

        return map;
      }, new Map<string, CategorySummary>())
      .values(),
  ).sort((a, b) => b.total - a.total);

  const accountingRefundCategories = Array.from(
    accountingEntries
      .filter((entry) => entry.entryType === "refund")
      .reduce((map, entry) => {
        const key = entry.category || "other_refund";
        const existing = map.get(key) ?? {
          key,
          label: accountingCategoryLabel(key),
          count: 0,
          total: 0,
        };

        existing.count += 1;
        existing.total += Math.abs(entry.refundAmount || entry.netAmount);
        map.set(key, existing);

        return map;
      }, new Map<string, CategorySummary>())
      .values(),
  ).sort((a, b) => b.total - a.total);

  const accountingFeeCategories = Array.from(
    accountingEntries
      .filter(
        (entry) =>
          entry.entryType === "processing_fee" ||
          entry.entryType === "platform_fee",
      )
      .reduce((map, entry) => {
        const key = entry.category || "fee";
        const existing = map.get(key) ?? {
          key,
          label: accountingCategoryLabel(key),
          count: 0,
          total: 0,
        };

        existing.count += 1;
        existing.total += Math.abs(entry.netAmount || entry.feeAmount);
        map.set(key, existing);

        return map;
      }, new Map<string, CategorySummary>())
      .values(),
  ).sort((a, b) => b.total - a.total);


  const { data: stripePayouts, error: stripePayoutsError } = await supabase
    .from("stripe_payouts")
    .select(
      `
        id,
        studio_id,
        stripe_account_id,
        stripe_payout_id,
        stripe_balance_transaction_id,
        amount,
        currency,
        status,
        arrival_date,
        payout_created_at,
        created_at,
        updated_at
      `,
    )
    .eq("studio_id", studioId)
    .gte("created_at", rangeStart)
    .order("created_at", { ascending: false })
    .limit(25);

  if (stripePayoutsError) {
    throw new Error(
      `Failed to load payout reconciliation data: ${stripePayoutsError.message}`,
    );
  }

  const typedStripePayouts = (stripePayouts ?? []) as StripePayoutRow[];
  const stripePayoutIds = typedStripePayouts
    .map((payout) => payout.stripe_payout_id)
    .filter(Boolean);

  const { data: stripePayoutItems, error: stripePayoutItemsError } =
    stripePayoutIds.length > 0
      ? await supabase
          .from("stripe_payout_items")
          .select(
            `
              id,
              stripe_payout_id,
              stripe_account_id,
              stripe_balance_transaction_id,
              stripe_source_id,
              stripe_source_type,
              studio_id,
              payment_id,
              event_payment_id,
              amount,
              fee,
              net,
              currency,
              type,
              reporting_category,
              description,
              available_on,
              balance_transaction_created_at,
              created_at
            `,
          )
          .eq("studio_id", studioId)
          .in("stripe_payout_id", stripePayoutIds)
          .order("created_at", { ascending: false })
          .limit(1000)
      : { data: [], error: null };

  if (stripePayoutItemsError) {
    throw new Error(
      `Failed to load payout reconciliation item data: ${stripePayoutItemsError.message}`,
    );
  }

  const typedStripePayoutItems = (stripePayoutItems ??
    []) as StripePayoutItemRow[];

  const payoutItemSummaries = typedStripePayoutItems.reduce(
    (map, item) => {
      const payoutId = item.stripe_payout_id;
      const existing =
        map.get(payoutId) ??
        ({
          payoutId,
          itemCount: 0,
          matchedCount: 0,
          unmatchedCount: 0,
          grossAmount: 0,
          fees: 0,
          netAmount: 0,
        } satisfies PayoutItemSummary);

      const amount = moneyValue(item.amount);
      const fee = Math.abs(moneyValue(item.fee));
      const net = moneyValue(item.net);
      const matched = Boolean(item.payment_id || item.event_payment_id);

      existing.itemCount += 1;
      existing.matchedCount += matched ? 1 : 0;
      existing.unmatchedCount += matched ? 0 : 1;
      existing.grossAmount += amount;
      existing.fees += fee;
      existing.netAmount += net;

      map.set(payoutId, existing);

      return map;
    },
    new Map<string, PayoutItemSummary>(),
  );

  const recentPayoutSummaries: RecentPayoutSummary[] = typedStripePayouts.map(
    (payout) => {
      const itemSummary =
        payoutItemSummaries.get(payout.stripe_payout_id) ??
        ({
          payoutId: payout.stripe_payout_id,
          itemCount: 0,
          matchedCount: 0,
          unmatchedCount: 0,
          grossAmount: 0,
          fees: 0,
          netAmount: 0,
        } satisfies PayoutItemSummary);

      return {
        ...payout,
        itemSummary,
      };
    },
  );

  const payoutSummary = recentPayoutSummaries.reduce(
    (summary, payout) => {
      const amount = moneyValue(payout.amount);
      const status = (payout.status ?? "unknown").toLowerCase();

      summary.totalPayouts += amount;
      summary.count += 1;
      summary.paidCount += status === "paid" ? 1 : 0;
      summary.pendingCount +=
        status === "pending" || status === "in_transit" ? 1 : 0;
      summary.failedCount += status === "failed" ? 1 : 0;
      summary.unmatchedItems += payout.itemSummary.unmatchedCount;
      summary.matchedItems += payout.itemSummary.matchedCount;
      summary.netItemTotal += payout.itemSummary.netAmount;
      summary.feeTotal += payout.itemSummary.fees;

      return summary;
    },
    {
      totalPayouts: 0,
      count: 0,
      paidCount: 0,
      pendingCount: 0,
      failedCount: 0,
      matchedItems: 0,
      unmatchedItems: 0,
      netItemTotal: 0,
      feeTotal: 0,
    },
  );

  const typedPayments = (payments ?? []) as PaymentRow[];
  const typedLeads = (leads ?? []) as ClientRow[];
  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedPackages = (packages ?? []) as ClientPackageRow[];
  const typedPackagePortfolio = (packagePortfolio ?? []) as ClientPackageRow[];
  const typedMemberships = (memberships ?? []) as ClientMembershipRow[];
  const typedMembershipPortfolio = (membershipPortfolio ??
    []) as ClientMembershipRow[];
  const typedEventRegistrations = (eventRegistrations ??
    []) as EventRegistrationRevenueRow[];

  const eventRegistrationIds = typedEventRegistrations.map((item) => item.id);

  const { data: eventAttendees, error: eventAttendeesError } =
    eventRegistrationIds.length > 0
      ? await supabase
          .from("event_registration_attendees")
          .select("id, registration_id, checked_in_at")
          .in("registration_id", eventRegistrationIds)
      : { data: [], error: null };

  if (eventAttendeesError) {
    throw new Error(
      `Failed to load event check-in report data: ${eventAttendeesError.message}`,
    );
  }

  const userId = context.userId;

  const { data: organizerAccessRows, error: organizerAccessError } = userId
    ? await supabase
        .from("organizer_users")
        .select("organizer_id, role, active")
        .eq("user_id", userId)
        .eq("active", true)
    : { data: [], error: null };

  if (organizerAccessError) {
    throw new Error(
      `Failed to load organizer access: ${organizerAccessError.message}`,
    );
  }

  const organizerAccess = (organizerAccessRows ?? []) as OrganizerAccessRow[];
  const organizerAccessIds = Array.from(
    new Set(
      organizerAccess
        .map((row) => row.organizer_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const { data: organizers, error: organizersError } =
    organizerAccessIds.length > 0
      ? await supabase
          .from("organizers")
          .select("id, name, slug, active")
          .in("id", organizerAccessIds)
          .order("name", { ascending: true })
      : { data: [], error: null };

  if (organizersError) {
    throw new Error(
      `Failed to load organizer report data: ${organizersError.message}`,
    );
  }

  const typedOrganizers = (organizers ?? []) as OrganizerReportRow[];
  const organizerIds = typedOrganizers.map((organizer) => organizer.id);
  const hasOrganizerReportAccess = organizerIds.length > 0;

  const [
    { data: organizerContacts, error: organizerContactsError },
    { data: organizerRegistrations, error: organizerRegistrationsError },
    { data: organizerEvents, error: organizerEventsError },
    { data: organizerCampaigns, error: organizerCampaignsError },
  ] =
    organizerIds.length > 0
      ? await Promise.all([
          supabase
            .from("organizer_contacts")
            .select(
              "id, organizer_id, email, first_name, last_name, total_registrations, total_paid_registrations, total_spend, last_seen_at, created_at",
            )
            .in("organizer_id", organizerIds)
            .gte("created_at", rangeStart)
            .order("created_at", { ascending: false })
            .limit(1000),
          supabase
            .from("organizer_contact_registrations")
            .select(
              "id, organizer_id, organizer_contact_id, event_id, registration_id, payment_status, status, total_amount, currency, registered_at, checked_in_at",
            )
            .in("organizer_id", organizerIds)
            .gte("registered_at", rangeStart)
            .order("registered_at", { ascending: false })
            .limit(2000),
          supabase
            .from("events")
            .select("id, organizer_id, name, start_date")
            .in("organizer_id", organizerIds)
            .order("start_date", { ascending: false })
            .limit(300),
          supabase
            .from("organizer_marketing_campaigns")
            .select(
              "id, organizer_id, name, status, audience_type, sent_at, created_at",
            )
            .in("organizer_id", organizerIds)
            .gte("created_at", rangeStart)
            .order("created_at", { ascending: false })
            .limit(500),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
        ];

  if (organizerContactsError) {
    throw new Error(
      `Failed to load organizer contacts report data: ${organizerContactsError.message}`,
    );
  }
  if (organizerRegistrationsError) {
    throw new Error(
      `Failed to load organizer registration report data: ${organizerRegistrationsError.message}`,
    );
  }
  if (organizerEventsError) {
    throw new Error(
      `Failed to load organizer event report data: ${organizerEventsError.message}`,
    );
  }
  if (organizerCampaignsError) {
    throw new Error(
      `Failed to load organizer campaign report data: ${organizerCampaignsError.message}`,
    );
  }

  const typedOrganizerCampaigns = (organizerCampaigns ??
    []) as OrganizerCampaignReportRow[];
  const organizerCampaignIds = typedOrganizerCampaigns.map(
    (campaign) => campaign.id,
  );

  const {
    data: organizerCampaignRecipients,
    error: organizerCampaignRecipientsError,
  } =
    organizerCampaignIds.length > 0
      ? await supabase
          .from("organizer_marketing_campaign_recipients")
          .select("id, campaign_id, organizer_id, status, created_at")
          .in("campaign_id", organizerCampaignIds)
          .limit(5000)
      : { data: [], error: null };

  if (organizerCampaignRecipientsError) {
    throw new Error(
      `Failed to load organizer campaign recipient report data: ${organizerCampaignRecipientsError.message}`,
    );
  }

  const typedEventAttendees = (eventAttendees ??
    []) as EventAttendeeReportRow[];
  const typedExpenses = (expenses ?? []) as ExpenseRow[];
  const typedInstructors = (instructors ?? []) as InstructorRow[];
  const typedInstructorEarnings = (instructorEarnings ??
    []) as InstructorEarningReportRow[];

  const instructorPayTotals = typedInstructorEarnings.reduce(
    (summary, earning) => {
      const status = (earning.status ?? "pending").toLowerCase();
      const amount = Number(earning.earning_amount ?? 0);

      if (status === "pending") summary.pending += amount;
      if (status === "approved") summary.approved += amount;
      if (status === "paid") summary.paid += amount;
      if (status === "void") summary.voided += amount;

      return summary;
    },
    { pending: 0, approved: 0, paid: 0, voided: 0 },
  );

  const instructorPayOutstandingTotal =
    instructorPayTotals.pending + instructorPayTotals.approved;
  const instructorPayActiveTotal =
    instructorPayTotals.pending + instructorPayTotals.approved + instructorPayTotals.paid;
  const instructorCompensationExpense = instructorPayActiveTotal;

  const typedOrganizerContacts = (organizerContacts ??
    []) as OrganizerContactReportRow[];
  const typedOrganizerRegistrations = (organizerRegistrations ??
    []) as OrganizerContactRegistrationReportRow[];
  const typedOrganizerEvents = (organizerEvents ??
    []) as OrganizerEventReportRow[];
  const typedOrganizerCampaignRecipients = (organizerCampaignRecipients ??
    []) as OrganizerCampaignRecipientReportRow[];

  const typedRetailOrders = (retailOrders ?? []) as RetailOrderRow[];
  const typedRetailInventory = (retailInventory ?? []) as RetailInventoryRow[];

  const completedRetailOrders = typedRetailOrders.filter(
    (order) =>
      order.status === "completed" &&
      ["paid", "partially_refunded", "refunded"].includes(order.payment_status),
  );

  const retailOrderItems = completedRetailOrders.flatMap((order) => {
    const items = Array.isArray(order.commerce_order_items)
      ? order.commerce_order_items
      : order.commerce_order_items
        ? [order.commerce_order_items]
        : [];

    return items.map((item) => ({ order, item }));
  });

  const retailGrossRevenue = completedRetailOrders.reduce(
    (sum, order) => sum + moneyValue(order.subtotal),
    0,
  );
  const retailDiscounts = completedRetailOrders.reduce(
    (sum, order) => sum + moneyValue(order.discount_total),
    0,
  );
  const retailRefunds = completedRetailOrders.reduce(
    (sum, order) => sum + moneyValue(order.refund_total),
    0,
  );
  const retailNetRevenue = completedRetailOrders.reduce(
    (sum, order) => sum + moneyValue(order.total) - moneyValue(order.refund_total),
    0,
  );
  const retailCogs = retailOrderItems.reduce(
    (sum, row) => sum + moneyValue(row.item.cogs_total),
    0,
  );
  const retailGrossProfit = retailNetRevenue - retailCogs;
  const retailGrossMargin =
    retailNetRevenue > 0
      ? Math.round((retailGrossProfit / retailNetRevenue) * 100)
      : 0;
  const retailUnitsSold = retailOrderItems.reduce(
    (sum, row) => sum + Number(row.item.quantity ?? 0),
    0,
  );

  const retailProductSummaries = Array.from(
    retailOrderItems
      .reduce((map, row) => {
        const key = row.item.catalog_item_id ?? row.item.name_snapshot;
        const existing = map.get(key) ?? {
          key,
          name: row.item.name_snapshot,
          quantity: 0,
          revenue: 0,
          cogs: 0,
          grossProfit: 0,
        };

        existing.quantity += Number(row.item.quantity ?? 0);
        existing.revenue += moneyValue(row.item.line_total);
        existing.cogs += moneyValue(row.item.cogs_total);
        existing.grossProfit = existing.revenue - existing.cogs;
        map.set(key, existing);

        return map;
      }, new Map<string, {
        key: string;
        name: string;
        quantity: number;
        revenue: number;
        cogs: number;
        grossProfit: number;
      }>())
      .values(),
  )
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);

  const retailPaymentMethodSummaries = Array.from(
    completedRetailOrders
      .reduce((map, order) => {
        const payment = Array.isArray(order.payments)
          ? order.payments[0]
          : order.payments;
        const key = payment?.payment_method ?? "unknown";
        const existing = map.get(key) ?? { key, count: 0, total: 0 };

        existing.count += 1;
        existing.total += moneyValue(order.total) - moneyValue(order.refund_total);
        map.set(key, existing);

        return map;
      }, new Map<string, { key: string; count: number; total: number }>())
      .values(),
  ).sort((a, b) => b.total - a.total);

  const activeRetailInventory = typedRetailInventory.filter((variant) => {
    const catalogItem = Array.isArray(variant.commerce_catalog_items)
      ? variant.commerce_catalog_items[0]
      : variant.commerce_catalog_items;
    return variant.active && catalogItem?.active !== false;
  });
  const retailInventoryUnits = activeRetailInventory.reduce(
    (sum, variant) => sum + Number(variant.quantity_on_hand ?? 0),
    0,
  );
  const retailInventoryValue = activeRetailInventory.reduce(
    (sum, variant) =>
      sum +
      Number(variant.quantity_on_hand ?? 0) *
        moneyValue(variant.unit_cost),
    0,
  );
  const lowStockRetailVariants = activeRetailInventory.filter(
    (variant) =>
      Number(variant.quantity_on_hand ?? 0) <=
      Number(variant.reorder_threshold ?? 0),
  );

  const paidPayments = typedPayments.filter((item) => item.status === "paid");
  const pendingPayments = typedPayments.filter(
    (item) => item.status === "pending",
  );
  const refundedPayments = typedPayments.filter(
    (item) => item.status === "refunded",
  );

  const floorRentalPayments = paidPayments.filter(isFloorRentalPayment);
  const nonFloorStudioPayments = paidPayments.filter(
    (payment) => !isFloorRentalPayment(payment),
  );

  const floorRentalRevenueTotal = floorRentalPayments.reduce(
    (sum, item) => sum + Number(item.amount ?? 0),
    0,
  );

  const studioPaymentRevenueTotal = nonFloorStudioPayments.reduce(
    (sum, item) => sum + Number(item.amount ?? 0),
    0,
  );

  const averagePaidPayment =
    nonFloorStudioPayments.length > 0
      ? studioPaymentRevenueTotal / nonFloorStudioPayments.length
      : 0;

  const paidEventRegistrations = typedEventRegistrations.filter(
    (item) =>
      item.payment_status === "paid" || item.payment_status === "partial",
  );

  const eventProfitabilityByEventId =
    buildEventProfitabilityByEventId(accountingEntries);

  const eventFinancialSummaries = Array.from(
    eventProfitabilityByEventId.values(),
  ).map((profitability) =>
    buildEventFinancialSummary({ profitability }),
  );

  const eventRevenueTotal = eventFinancialSummaries.reduce(
    (sum, summary) => sum + summary.grossTicketRevenue,
    0,
  );
  const eventRefundedTotal = eventFinancialSummaries.reduce(
    (sum, summary) => sum + summary.refunds,
    0,
  );
  const eventFeesTotal = eventFinancialSummaries.reduce(
    (sum, summary) => sum + summary.processingAndPlatformFees,
    0,
  );
  const eventNetRevenueTotal = eventFinancialSummaries.reduce(
    (sum, summary) => sum + summary.netTicketRevenue,
    0,
  );
  const eventLinkedExpensesTotal = eventFinancialSummaries.reduce(
    (sum, summary) =>
      sum + summary.eventExpenses + summary.eventLaborCosts,
    0,
  );
  const eventProfitLossTotal = eventFinancialSummaries.reduce(
    (sum, summary) => sum + summary.eventProfitLoss,
    0,
  );


  const eventRevenueByEventId = eventTicketAccountingEntries.reduce(
    (map, entry) => {
      const eventId = entry.eventId ?? "unknown";
      map.set(eventId, (map.get(eventId) ?? 0) + entry.grossAmount);
      return map;
    },
    new Map<string, number>(),
  );

  const registrationRevenueByEventId = paidEventRegistrations.reduce(
    (map, registration) => {
      const eventId = registration.event_id ?? "unknown";
      const amount = Number(
        registration.total_amount ?? registration.total_price ?? 0,
      );
      map.set(eventId, (map.get(eventId) ?? 0) + amount);
      return map;
    },
    new Map<string, number>(),
  );

  const ledgerAllocatedRegistrationRevenue = (
    registration: EventRegistrationRevenueRow,
  ) => {
    const eventId = registration.event_id ?? "unknown";
    const registrationAmount = Number(
      registration.total_amount ?? registration.total_price ?? 0,
    );
    const eventRegistrationTotal = registrationRevenueByEventId.get(eventId) ?? 0;
    const eventLedgerTotal = eventRevenueByEventId.get(eventId) ?? 0;

    if (eventLedgerTotal <= 0) return 0;
    if (eventRegistrationTotal <= 0) return eventLedgerTotal;

    return eventLedgerTotal * (registrationAmount / eventRegistrationTotal);
  };

  const checkedInAttendeeRegistrationIds = new Set(
    typedEventAttendees
      .filter((item) => item.checked_in_at)
      .map((item) => item.registration_id),
  );

  const checkedInEventRegistrations = paidEventRegistrations.filter(
    (item) =>
      item.checked_in_at || checkedInAttendeeRegistrationIds.has(item.id),
  );

  const eventNoShowCount = Math.max(
    paidEventRegistrations.length - checkedInEventRegistrations.length,
    0,
  );

  const eventAttendanceRate = percentage(
    checkedInEventRegistrations.length,
    paidEventRegistrations.length,
  );

  const eventSummariesById = new Map<string, EventSummary>();
  const ticketSummariesByKey = new Map<string, TicketSummary>();

  for (const registration of paidEventRegistrations) {
    const eventInfo = getEventInfo(registration.events);
    const ticketInfo = getTicketInfo(registration.event_ticket_types);
    const eventId = registration.event_id ?? "unknown";
    const amount = ledgerAllocatedRegistrationRevenue(registration);
    const quantity = Number(registration.quantity ?? 1);
    const isCheckedIn =
      Boolean(registration.checked_in_at) ||
      checkedInAttendeeRegistrationIds.has(registration.id);

    const eventSummary = eventSummariesById.get(eventId) ?? {
      eventId,
      name: eventInfo?.name?.trim() || "Unknown event",
      type: eventInfo?.event_type || "event",
      registrations: 0,
      tickets: 0,
      checkedIn: 0,
      noShows: 0,
      revenue: 0,
      refunds: 0,
      fees: 0,
      netRevenue: 0,
      expenses: 0,
      profitLoss: 0,
      marginPercent: null,
    };

    eventSummary.registrations += 1;
    eventSummary.tickets += quantity;
    eventSummary.revenue += amount;
    if (isCheckedIn) {
      eventSummary.checkedIn += 1;
    } else {
      eventSummary.noShows += 1;
    }
    eventSummariesById.set(eventId, eventSummary);

    const ticketKey = `${registration.ticket_type_id ?? "unknown"}:${
      ticketInfo?.name ?? "Unknown ticket"
    }`;
    const ticketSummary = ticketSummariesByKey.get(ticketKey) ?? {
      key: ticketKey,
      name: ticketInfo?.name?.trim() || "Unknown ticket",
      kind: ticketInfo?.ticket_kind || "ticket",
      registrations: 0,
      quantity: 0,
      revenue: 0,
    };

    ticketSummary.registrations += 1;
    ticketSummary.quantity += quantity;
    ticketSummary.revenue += amount;
    ticketSummariesByKey.set(ticketKey, ticketSummary);
  }

  for (const [eventId, eventSummary] of eventSummariesById.entries()) {
    const profitability = eventProfitabilityByEventId.get(eventId);
    const summary = buildEventFinancialSummary({
      profitability,
    });

    eventSummary.revenue =
      summary.grossTicketRevenue || eventSummary.revenue;
    eventSummary.refunds = summary.refunds;
    eventSummary.fees = summary.processingAndPlatformFees;
    eventSummary.netRevenue =
      summary.netTicketRevenue || eventSummary.revenue;
    eventSummary.expenses =
      summary.eventExpenses + summary.eventLaborCosts;
    eventSummary.profitLoss =
      summary.netTicketRevenue !== 0 ||
      summary.totalEventCosts !== 0
        ? summary.eventProfitLoss
        : eventSummary.netRevenue - eventSummary.expenses;
    eventSummary.marginPercent =
      eventSummary.netRevenue > 0
        ? eventSummary.profitLoss / eventSummary.netRevenue
        : null;
  }

  const eventProfitMarginPercent =
    eventNetRevenueTotal > 0
      ? Math.round((eventProfitLossTotal / eventNetRevenueTotal) * 100)
      : 0;

  const allEventSummaries = Array.from(eventSummariesById.values());

  const topEventSummaries = [...allEventSummaries]
    .sort((a, b) => b.profitLoss - a.profitLoss)
    .slice(0, 6);

  const topProfitableEventSummaries = [...allEventSummaries]
    .filter((event) => event.profitLoss > 0)
    .sort((a, b) => b.profitLoss - a.profitLoss)
    .slice(0, 5);

  const eventAttentionSummaries = [...allEventSummaries]
    .filter(
      (event) =>
        event.profitLoss < 0 ||
        event.refunds > 0 ||
        event.fees > 0 ||
        event.expenses === 0,
    )
    .sort((a, b) => a.profitLoss - b.profitLoss)
    .slice(0, 5);

  const topTicketSummaries = Array.from(ticketSummariesByKey.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6);

  const manualExpensesTotal = typedExpenses.reduce(
    (sum, item) => sum + Number(item.amount ?? 0),
    0,
  );

  const floorFeeExpenseTotal = typedExpenses
    .filter((item) => item.category === "floor_fee")
    .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);

  const otherExpensesTotal = Math.max(
    0,
    manualExpensesTotal - floorFeeExpenseTotal,
  );

  const expenseCategorySummaries = Array.from(
    typedExpenses
      .reduce((map, expense) => {
        const key = expense.category ?? "uncategorized";
        const existing = map.get(key) ?? {
          key,
          label: expenseCategoryLabel(key),
          count: 0,
          total: 0,
        };

        existing.count += 1;
        existing.total += Number(expense.amount ?? 0);
        map.set(key, existing);

        return map;
      }, new Map<string, CategorySummary>())
      .values(),
  ).sort((a, b) => b.total - a.total);

  const expenseToProfitBuckets = typedExpenses.reduce(
    (summary, expense) => {
      const category = (expense.category ?? "").toLowerCase();
      const amount = moneyValue(expense.amount);

      if (category === "floor_fee" || category === "floor_fees") {
        summary.floorFees += amount;
      } else if (
        Boolean(expense.related_event_id) ||
        category === "event_expense" ||
        category.includes("event")
      ) {
        summary.eventRelated += amount;
      } else {
        summary.studioOperating += amount;
      }

      return summary;
    },
    {
      floorFees: 0,
      eventRelated: 0,
      studioOperating: 0,
    },
  );

  const revenueAfterRefunds =
    accountingSummary.revenue - accountingSummary.refunds;
  const netAfterFees = revenueAfterRefunds - accountingSummary.fees;
  const profitAfterExpenses = accountingSummary.net;
  const profitAfterInstructorCompensation =
    profitAfterExpenses - instructorCompensationExpense;
  const expenseToRevenueRatio = percentage(
    accountingSummary.expenses + instructorCompensationExpense,
    Math.max(revenueAfterRefunds, 0),
  );

  const revenueBreakdown: CategorySummary[] = [
    {
      key: "studio_payments",
      label: "Studio payments",
      count: nonFloorStudioPayments.length,
      total: studioPaymentRevenueTotal,
    },
    {
      key: "event_ticket_revenue",
      label: "Event / ticket revenue",
      count: eventTicketAccountingEntries.length,
      total: eventRevenueTotal,
    },
    {
      key: "floor_rental_revenue",
      label: "Floor rental revenue",
      count: floorRentalPayments.length,
      total: floorRentalRevenueTotal,
    },
  ].sort((a, b) => b.total - a.total);

  const paymentTypeRevenueSummaries = Array.from(
    nonFloorStudioPayments
      .reduce((map, payment) => {
        const key = payment.payment_type ?? "other";
        const existing = map.get(key) ?? {
          key,
          label: labelize(key),
          count: 0,
          total: 0,
        };

        existing.count += 1;
        existing.total += Number(payment.amount ?? 0);
        map.set(key, existing);

        return map;
      }, new Map<string, CategorySummary>())
      .values(),
  )
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  const revenueTotal =
    studioPaymentRevenueTotal + eventRevenueTotal + floorRentalRevenueTotal;

  const refundedTotal =
    refundedPayments.reduce((sum, item) => sum + Number(item.amount ?? 0), 0) +
    eventRefundedTotal;

  const knownFeesTotal = eventFeesTotal;

  const estimatedNetIncome =
    revenueTotal -
    refundedTotal -
    manualExpensesTotal -
    knownFeesTotal -
    instructorCompensationExpense;

  const paidRevenueItemsCount =
    paidPayments.length + eventTicketAccountingEntries.length;

  const packageRevenueSnapshot = typedPackages.reduce(
    (sum, item) => sum + moneyValue(item.sold_price ?? item.price_snapshot),
    0,
  );

  const packagePaymentRows = typedPayments.filter(isPackagePayment);
  const paidPackagePayments = packagePaymentRows.filter((payment) =>
    ["completed", "paid", "succeeded"].includes(
      (payment.status ?? "").toLowerCase(),
    ),
  );
  const failedPackagePayments = packagePaymentRows.filter((payment) =>
    ["failed", "declined", "canceled", "cancelled"].includes(
      (payment.status ?? "").toLowerCase(),
    ),
  );
  const refundedPackagePayments = packagePaymentRows.filter((payment) => {
    const status = (payment.status ?? "").toLowerCase();
    return (
      status.includes("refund") ||
      moneyValue(payment.refunded_amount) > 0 ||
      moneyValue(payment.refund_amount) > 0
    );
  });

  const packageCashCollected = paidPackagePayments.reduce(
    (sum, payment) => sum + moneyValue(payment.amount),
    0,
  );
  const packageRefundTotal = refundedPackagePayments.reduce(
    (sum, payment) =>
      sum +
      Math.max(
        moneyValue(payment.refunded_amount),
        moneyValue(payment.refund_amount),
      ),
    0,
  );

  const activePackagePortfolio = typedPackagePortfolio.filter(
    (pkg) => pkg.active !== false,
  );
  const inactivePackagePortfolio = typedPackagePortfolio.filter(
    (pkg) => pkg.active === false,
  );
  const packageCreditsSoldThisPeriod = typedPackages.reduce(
    (sum, pkg) => sum + moneyValue(pkg.lesson_count_snapshot),
    0,
  );
  const packageCreditsUsedPortfolio = activePackagePortfolio.reduce(
    (sum, pkg) => sum + moneyValue(pkg.lessons_used),
    0,
  );
  const packageCreditsRemainingPortfolio = activePackagePortfolio.reduce(
    (sum, pkg) => sum + Math.max(0, moneyValue(pkg.lessons_remaining)),
    0,
  );
  const packageOutstandingCreditValue = activePackagePortfolio.reduce(
    (sum, pkg) => sum + packageOutstandingValue(pkg),
    0,
  );
  const inactivePackageOutstandingValue = inactivePackagePortfolio.reduce(
    (sum, pkg) => sum + packageOutstandingValue(pkg),
    0,
  );
  const lowCreditPackages = activePackagePortfolio.filter((pkg) => {
    const remaining = moneyValue(pkg.lessons_remaining);
    return remaining > 0 && remaining <= 2;
  });
  const zeroCreditPackages = activePackagePortfolio.filter(
    (pkg) => moneyValue(pkg.lessons_remaining) <= 0,
  );

  const packagePlanLiabilityCounts = new Map<
    string,
    { name: string; count: number; remainingCredits: number; outstandingValue: number }
  >();

  for (const pkg of activePackagePortfolio) {
    const name = pkg.name_snapshot?.trim() || "Unnamed Package";
    const existing = packagePlanLiabilityCounts.get(name) ?? {
      name,
      count: 0,
      remainingCredits: 0,
      outstandingValue: 0,
    };

    existing.count += 1;
    existing.remainingCredits += Math.max(0, moneyValue(pkg.lessons_remaining));
    existing.outstandingValue += packageOutstandingValue(pkg);

    packagePlanLiabilityCounts.set(name, existing);
  }

  const topPackageLiabilityPlans = Array.from(packagePlanLiabilityCounts.values())
    .sort((a, b) => b.outstandingValue - a.outstandingValue)
    .slice(0, 5);

  const membershipRevenueSnapshot = typedMemberships.reduce(
    (sum, item) =>
      sum +
      Number(item.price_snapshot ?? 0) +
      Number(item.signup_fee_snapshot ?? 0),
    0,
  );

  const membershipPaymentRows = typedPayments.filter(isMembershipPayment);
  const paidMembershipPayments = membershipPaymentRows.filter((payment) =>
    ["completed", "paid", "succeeded"].includes(
      (payment.status ?? "").toLowerCase(),
    ),
  );
  const failedMembershipPayments = membershipPaymentRows.filter((payment) =>
    ["failed", "declined", "canceled", "cancelled"].includes(
      (payment.status ?? "").toLowerCase(),
    ),
  );
  const refundedMembershipPayments = membershipPaymentRows.filter((payment) => {
    const status = (payment.status ?? "").toLowerCase();
    return (
      status.includes("refund") ||
      Number(payment.refunded_amount ?? 0) > 0 ||
      Number(payment.refund_amount ?? 0) > 0
    );
  });

  const membershipPaymentRevenue = paidMembershipPayments.reduce(
    (sum, payment) => sum + Number(payment.amount ?? 0),
    0,
  );
  const membershipRefundTotal = refundedMembershipPayments.reduce(
    (sum, payment) =>
      sum +
      Math.max(
        Number(payment.refunded_amount ?? 0),
        Number(payment.refund_amount ?? 0),
      ),
    0,
  );

  const membershipActiveStatuses = ["active", "trialing"];
  const membershipPendingStatuses = ["pending", "past_due", "unpaid"];
  const membershipCanceledStatuses = [
    "cancelled",
    "canceled",
    "inactive",
    "expired",
    "ended",
  ];

  const activeMemberships = typedMembershipPortfolio.filter((membership) =>
    membershipActiveStatuses.includes((membership.status ?? "").toLowerCase()),
  );
  const pendingMemberships = typedMembershipPortfolio.filter((membership) =>
    membershipPendingStatuses.includes((membership.status ?? "").toLowerCase()),
  );
  const canceledMemberships = typedMembershipPortfolio.filter((membership) =>
    membershipCanceledStatuses.includes(
      (membership.status ?? "").toLowerCase(),
    ),
  );
  const renewingMemberships = activeMemberships.filter(
    (membership) => membership.auto_renew && !membership.cancel_at_period_end,
  );
  const endingMemberships = activeMemberships.filter(
    (membership) => membership.cancel_at_period_end,
  );
  const monthlyRecurringRevenuePreview = activeMemberships.reduce(
    (sum, membership) =>
      sum +
      monthlyMembershipAmount(
        Number(membership.price_snapshot ?? 0),
        membership.billing_interval_snapshot,
      ),
    0,
  );

  const membershipPlanCounts = new Map<
    string,
    { name: string; count: number; mrr: number }
  >();

  for (const membership of activeMemberships) {
    const name = membership.name_snapshot?.trim() || "Unnamed Membership";
    const existing = membershipPlanCounts.get(name) ?? {
      name,
      count: 0,
      mrr: 0,
    };

    existing.count += 1;
    existing.mrr += monthlyMembershipAmount(
      Number(membership.price_snapshot ?? 0),
      membership.billing_interval_snapshot,
    );
    membershipPlanCounts.set(name, existing);
  }

  const topMembershipPlans = Array.from(membershipPlanCounts.values())
    .sort((a, b) => b.mrr - a.mrr)
    .slice(0, 5);

  const leadsOnly = typedLeads.filter((item) => item.status === "lead");
  const convertedLeads = typedLeads.filter((item) => item.status === "active");
  const archivedLeads = typedLeads.filter((item) => item.status === "archived");

  const attendedAppointments = typedAppointments.filter(
    (item) => item.status === "attended",
  );
  const cancelledAppointments = typedAppointments.filter(
    (item) => item.status === "cancelled",
  );
  const noShows = typedAppointments.filter((item) => item.status === "no_show");
  const scheduledAppointments = typedAppointments.filter(
    (item) => item.status === "scheduled",
  );

  const paymentMethodCounts: Record<string, number> = {};
  const paymentChannelCounts: Record<string, number> = {};
  const paymentTypeCounts: Record<string, number> = {};
  const leadSourceCounts: Record<string, number> = {};
  const appointmentTypeCounts: Record<string, number> = {};
  const packageCounts: Record<string, number> = {};

  for (const payment of typedPayments) {
    const methodKey = payment.payment_method ?? "unknown";
    paymentMethodCounts[methodKey] = (paymentMethodCounts[methodKey] ?? 0) + 1;

    const channelKey = payment.payment_channel ?? "unknown";
    paymentChannelCounts[channelKey] = (paymentChannelCounts[channelKey] ?? 0) + 1;

    const typeKey = payment.payment_type ?? "other";
    paymentTypeCounts[typeKey] = (paymentTypeCounts[typeKey] ?? 0) + 1;
  }

  for (const lead of leadsOnly) {
    const sourceKey = lead.referral_source ?? "unknown";
    leadSourceCounts[sourceKey] = (leadSourceCounts[sourceKey] ?? 0) + 1;
  }

  for (const appointment of typedAppointments) {
    const typeKey = appointment.appointment_type ?? "other";
    appointmentTypeCounts[typeKey] = (appointmentTypeCounts[typeKey] ?? 0) + 1;
  }

  for (const pkg of typedPackages) {
    const key = pkg.name_snapshot?.trim() || "Unnamed Package";
    packageCounts[key] = (packageCounts[key] ?? 0) + 1;
  }

  const topPaymentMethods = sortEntriesDesc(paymentMethodCounts).slice(0, 5);
  const topPaymentChannels = sortEntriesDesc(paymentChannelCounts).slice(0, 5);
  const topPaymentTypes = sortEntriesDesc(paymentTypeCounts).slice(0, 5);
  const topLeadSources = sortEntriesDesc(leadSourceCounts).slice(0, 5);
  const topAppointmentTypes = sortEntriesDesc(appointmentTypeCounts).slice(
    0,
    5,
  );
  const topPackages = sortEntriesDesc(packageCounts).slice(0, 5);

  const conversionRate = percentage(
    convertedLeads.length,
    leadsOnly.length + convertedLeads.length,
  );

  const attendanceRate = percentage(
    attendedAppointments.length,
    attendedAppointments.length + cancelledAppointments.length + noShows.length,
  );

  const instructorNameById = new Map(
    typedInstructors.map((instructor) => [
      instructor.id,
      [instructor.first_name ?? "", instructor.last_name ?? ""]
        .join(" ")
        .trim() || "Unnamed Instructor",
    ]),
  );

  const instructorStatsById = new Map<string, InstructorSummary>();

  for (const appointment of typedAppointments) {
    const instructorId = appointment.instructor_id ?? "unassigned";
    const existing = instructorStatsById.get(instructorId) ?? {
      instructorId,
      name:
        instructorId === "unassigned"
          ? "Unassigned"
          : (instructorNameById.get(instructorId) ??
            `Instructor ${instructorId.slice(0, 8)}`),
      totalAppointments: 0,
      attended: 0,
      scheduled: 0,
      cancelled: 0,
      noShows: 0,
      privateLessons: 0,
      groupClasses: 0,
      minutes: 0,
      revenue: 0,
    };

    existing.totalAppointments += 1;
    existing.minutes += Number(appointment.duration_minutes ?? 0);

    if (appointment.status === "attended") existing.attended += 1;
    if (appointment.status === "scheduled") existing.scheduled += 1;
    if (appointment.status === "cancelled") existing.cancelled += 1;
    if (appointment.status === "no_show") existing.noShows += 1;

    const appointmentType = (appointment.appointment_type ?? "").toLowerCase();
    if (appointmentType.includes("private")) existing.privateLessons += 1;
    if (appointmentType.includes("group")) existing.groupClasses += 1;

    if (appointment.payment_status === "paid") {
      existing.revenue += Number(appointment.price_amount ?? 0);
    }

    instructorStatsById.set(instructorId, existing);
  }

  const instructorSummaries = Array.from(instructorStatsById.values()).sort(
    (a, b) => b.totalAppointments - a.totalAppointments,
  );

  const totalInstructorMinutes = instructorSummaries.reduce(
    (sum, item) => sum + item.minutes,
    0,
  );

  const totalInstructorRevenue = instructorSummaries.reduce(
    (sum, item) => sum + item.revenue,
    0,
  );

  const totalPrivateLessons = instructorSummaries.reduce(
    (sum, item) => sum + item.privateLessons,
    0,
  );

  const totalGroupClasses = instructorSummaries.reduce(
    (sum, item) => sum + item.groupClasses,
    0,
  );

  const instructorActivityAttendanceRate = percentage(
    instructorSummaries.reduce((sum, item) => sum + item.attended, 0),
    instructorSummaries.reduce(
      (sum, item) => sum + item.attended + item.cancelled + item.noShows,
      0,
    ),
  );

  const instructorPayToLessonRevenueRatio = percentage(
    instructorPayActiveTotal,
    totalInstructorRevenue,
  );

  const instructorPayByInstructor = new Map<string, InstructorPaySummary>();

  for (const earning of typedInstructorEarnings) {
    const instructorId = earning.instructor_id ?? "unassigned";
    const existing = instructorPayByInstructor.get(instructorId) ?? {
      instructorId,
      name:
        instructorId === "unassigned"
          ? "Unassigned"
          : (instructorNameById.get(instructorId) ??
            `Instructor ${instructorId.slice(0, 8)}`),
      count: 0,
      pending: 0,
      approved: 0,
      paid: 0,
      total: 0,
    };
    const status = (earning.status ?? "pending").toLowerCase();
    const amount = Number(earning.earning_amount ?? 0);

    existing.count += 1;
    if (status === "pending") existing.pending += amount;
    if (status === "approved") existing.approved += amount;
    if (status === "paid") existing.paid += amount;
    if (status !== "void") existing.total += amount;

    instructorPayByInstructor.set(instructorId, existing);
  }

  const topInstructorPaySummaries = Array.from(
    instructorPayByInstructor.values(),
  )
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const totalAppointmentOutcomes =
    attendedAppointments.length + cancelledAppointments.length + noShows.length;

  const clientActivityTotal =
    leadsOnly.length + convertedLeads.length + archivedLeads.length;

  const organizerNameById = new Map(
    typedOrganizers.map((organizer) => [organizer.id, organizer.name]),
  );
  const organizerEventById = new Map(
    typedOrganizerEvents.map((event) => [event.id, event]),
  );

  const paidOrganizerRegistrations = typedOrganizerRegistrations.filter(
    (registration) =>
      registration.payment_status === "paid" ||
      registration.payment_status === "partial",
  );

  const organizerRevenueTotal = paidOrganizerRegistrations.reduce(
    (sum, registration) => sum + Number(registration.total_amount ?? 0),
    0,
  );

  const organizerCheckedInRegistrations = paidOrganizerRegistrations.filter(
    (registration) => Boolean(registration.checked_in_at),
  );

  const organizerNoShowCount = Math.max(
    paidOrganizerRegistrations.length - organizerCheckedInRegistrations.length,
    0,
  );

  const organizerAttendanceRate = percentage(
    organizerCheckedInRegistrations.length,
    paidOrganizerRegistrations.length,
  );

  const organizerEventSummariesById = new Map<string, OrganizerEventSummary>();

  for (const registration of paidOrganizerRegistrations) {
    const eventId = registration.event_id ?? "unknown";
    const eventInfo = organizerEventById.get(eventId);
    const organizerId = registration.organizer_id;
    const existing = organizerEventSummariesById.get(eventId) ?? {
      eventId,
      organizerId,
      organizerName: organizerNameById.get(organizerId) ?? "Organizer",
      eventName: eventInfo?.name?.trim() || "Unknown event",
      registrations: 0,
      paidRegistrations: 0,
      checkedIn: 0,
      noShows: 0,
      revenue: 0,
    };

    existing.registrations += 1;
    existing.paidRegistrations += 1;
    existing.revenue += Number(registration.total_amount ?? 0);

    if (registration.checked_in_at) {
      existing.checkedIn += 1;
    } else {
      existing.noShows += 1;
    }

    organizerEventSummariesById.set(eventId, existing);
  }

  const topOrganizerEventSummaries = Array.from(
    organizerEventSummariesById.values(),
  )
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6);

  const organizerCampaignsSent = typedOrganizerCampaigns.filter(
    (campaign) => campaign.status === "sent" || campaign.sent_at,
  );

  const organizerCampaignRecipientsSent =
    typedOrganizerCampaignRecipients.filter(
      (recipient) => recipient.status === "sent",
    );
  const organizerCampaignRecipientsFailed =
    typedOrganizerCampaignRecipients.filter(
      (recipient) => recipient.status === "failed",
    );
  const organizerCampaignRecipientsSuppressed =
    typedOrganizerCampaignRecipients.filter(
      (recipient) =>
        recipient.status === "suppressed" ||
        recipient.status === "unsubscribed",
    );

  const recentOrganizerContacts = typedOrganizerContacts
    .slice()
    .sort(
      (a, b) =>
        new Date(b.last_seen_at ?? b.created_at).getTime() -
        new Date(a.last_seen_at ?? a.created_at).getTime(),
    )
    .slice(0, 6);

  const recentOrganizerCampaigns = typedOrganizerCampaigns.slice(0, 5);

  const ariaReportMetric = revenueTotal > 0 ? fmtCurrency(revenueTotal) : rangeLabel(range);
  const ariaReportInsight =
    revenueTotal > 0
      ? `Your studio recorded ${fmtCurrency(revenueTotal)} in total revenue for ${rangeLabel(range).toLowerCase()}, with estimated net income of ${fmtCurrency(estimatedNetIncome)}.`
      : `No revenue has been recorded for ${rangeLabel(range).toLowerCase()} yet.`;
  const ariaReportRecommendation =
    packageRevenueSnapshot >= membershipRevenueSnapshot
      ? "Use package renewal and no-upcoming-lesson follow-ups to keep lesson revenue moving."
      : "Membership revenue is playing a larger role. Review renewal timing and attendance patterns to protect recurring revenue.";

  const ariaAccountingInsights = [
    {
      title: "Net after instructor pay",
      metric: fmtCurrency(profitAfterInstructorCompensation),
      detail:
        profitAfterInstructorCompensation >= 0
          ? `After refunds, fees, expenses, and instructor pay, this range is showing a positive profit preview of ${fmtCurrency(profitAfterInstructorCompensation)}.`
          : `After refunds, fees, expenses, and instructor pay, this range is showing a negative profit preview of ${fmtCurrency(Math.abs(profitAfterInstructorCompensation))}. Review labor cost, expenses, refunds, and low-margin revenue sources before closing the period.`,
      tone: profitAfterInstructorCompensation >= 0 ? "good" : "warning",
    },
    {
      title: "Refund and fee impact",
      metric: `${percentage(accountingSummary.refunds + accountingSummary.fees, Math.max(accountingSummary.revenue, 0))}`,
      detail:
        accountingSummary.revenue > 0
          ? `Refunds and fees reduced gross revenue by ${fmtCurrency(accountingSummary.refunds + accountingSummary.fees)} for ${rangeLabel(range).toLowerCase()}.`
          : "ARIA needs revenue activity before it can compare refund and fee impact for this range.",
      tone:
        accountingSummary.revenue > 0 &&
        (accountingSummary.refunds + accountingSummary.fees) / accountingSummary.revenue > 0.12
          ? "warning"
          : "neutral",
    },
    {
      title: "Package credit liability",
      metric: fmtCurrency(packageOutstandingCreditValue),
      detail:
        packageOutstandingCreditValue > 0
          ? `${fmtNumber(Math.round(packageCreditsRemainingPortfolio))} unused package credits remain active. Watch this balance so prepaid lesson obligations do not build up unnoticed.`
          : "No active unused package credit value is showing in this reporting snapshot.",
      tone: packageOutstandingCreditValue > packageCashCollected && packageOutstandingCreditValue > 0 ? "warning" : "neutral",
    },
    {
      title: "Membership recurring revenue",
      metric: fmtCurrency(monthlyRecurringRevenuePreview),
      detail:
        activeMemberships.length > 0
          ? `${fmtNumber(activeMemberships.length)} active memberships are contributing to the monthly recurring revenue preview. ${pendingMemberships.length > 0 ? `${fmtNumber(pendingMemberships.length)} memberships need billing follow-up.` : "No pending membership billing issues are visible in this snapshot."}`
          : "No active memberships are contributing to MRR yet. Consider promoting memberships to clients with consistent weekly lesson habits.",
      tone: pendingMemberships.length > 0 || failedMembershipPayments.length > 0 ? "warning" : "good",
    },
    {
      title: "Payout reconciliation",
      metric:
        payoutSummary.count > 0
          ? `${fmtNumber(payoutSummary.matchedItems)} matched / ${fmtNumber(payoutSummary.unmatchedItems)} unmatched`
          : "No payouts",
      detail:
        payoutSummary.unmatchedItems > 0
          ? "Some payout items are not mapped to payments yet. Review payout reconciliation before closing this period."
          : payoutSummary.count > 0
            ? "Recent payout items are mapped cleanly for this range."
            : "Payout reconciliation will appear after Stripe sends payout events for this studio.",
      tone: payoutSummary.unmatchedItems > 0 || payoutSummary.failedCount > 0 ? "warning" : "neutral",
    },
    {
      title: "Expense pressure",
      metric: expenseToRevenueRatio,
      detail:
        accountingSummary.expenses > 0
          ? `${fmtCurrency(accountingSummary.expenses)} in recorded expenses and ${fmtCurrency(instructorCompensationExpense)} in instructor pay are included in the profit preview. Floor fees account for ${fmtCurrency(expenseToProfitBuckets.floorFees)}.`
          : instructorCompensationExpense > 0
            ? `${fmtCurrency(instructorCompensationExpense)} in instructor pay is included in the profit preview. Add operating expenses for a cleaner profit view.`
            : "No expenses are recorded for this range. Add floor fees, operating costs, and instructor pay rules for a cleaner profit view.",
      tone:
        revenueAfterRefunds > 0 && (accountingSummary.expenses + instructorCompensationExpense) / revenueAfterRefunds > 0.35
          ? "warning"
          : "neutral",
    },
    {
      title: "Instructor labor percentage",
      metric: instructorPayToLessonRevenueRatio,
      detail:
        totalInstructorRevenue > 0
          ? `${fmtCurrency(instructorPayActiveTotal)} in instructor pay is currently tied to ${fmtCurrency(totalInstructorRevenue)} in instructor-attributed lesson and class revenue for this range.`
          : instructorPayActiveTotal > 0
            ? `${fmtCurrency(instructorPayActiveTotal)} in instructor pay is recorded, but ARIA does not see instructor-attributed lesson or class revenue in this range yet.`
            : "Instructor labor percentage will appear after lesson or class revenue and instructor pay are both recorded.",
      tone:
        totalInstructorRevenue > 0 && instructorPayActiveTotal / totalInstructorRevenue > 0.55
          ? "warning"
          : "neutral",
    },
    {
      title: "Retail gross margin",
      metric: `${retailGrossMargin}%`,
      detail:
        completedRetailOrders.length > 0
          ? `${fmtCurrency(retailNetRevenue)} in net retail revenue produced ${fmtCurrency(retailGrossProfit)} in gross profit after ${fmtCurrency(retailCogs)} in product cost. ${lowStockRetailVariants.length > 0 ? `${fmtNumber(lowStockRetailVariants.length)} variants are at or below their reorder threshold.` : "No variants are currently below their reorder threshold."}`
          : "Retail margin will appear after physical product orders are completed.",
      tone:
        completedRetailOrders.length > 0 && retailGrossMargin < 35
          ? "warning"
          : completedRetailOrders.length > 0
            ? "good"
            : "neutral",
    },
    {
      title: "Instructor pay readiness",
      metric: fmtCurrency(instructorPayOutstandingTotal),
      detail:
        instructorPayOutstandingTotal > 0
          ? `${fmtCurrency(instructorPayOutstandingTotal)} in instructor pay is pending or approved for this range. Review Instructor Pay before closing the period.`
          : typedInstructorEarnings.length > 0
            ? "Instructor pay entries are recorded for this range and none are currently awaiting payment."
            : "No instructor pay entries are recorded for this range yet. Add rules to stage earnings automatically from completed lessons and classes.",
      tone: instructorPayOutstandingTotal > 0 ? "warning" : "neutral",
    },
  ] satisfies Array<{
    title: string;
    metric: string;
    detail: string;
    tone: "good" | "neutral" | "warning";
  }>;


  const isOrganizerWorkspace = isOrganizerWorkspaceRole(context.studioRole);

  const reportInsightsMetrics = {
    range: rangeLabel(range),
    plan: studioPlanCode ?? "starter",
    revenue: {
      total: revenueTotal,
      studioPayments: studioPaymentRevenueTotal,
      eventTickets: eventRevenueTotal,
      floorRental: floorRentalRevenueTotal,
      refunds: refundedTotal,
      averageStudioPayment: averagePaidPayment,
    },
    expenses: {
      total: manualExpensesTotal,
      floorFees: floorFeeExpenseTotal,
      other: otherExpensesTotal,
      knownFees: knownFeesTotal,
    },
    profitAndLoss: {
      estimatedNetIncome,
      instructorCompensation: instructorCompensationExpense,
      netAfterInstructorCompensation: profitAfterInstructorCompensation,
    },
    commerce: {
      orders: completedRetailOrders.length,
      unitsSold: retailUnitsSold,
      grossRevenue: retailGrossRevenue,
      discounts: retailDiscounts,
      refunds: retailRefunds,
      netRevenue: retailNetRevenue,
      cogs: retailCogs,
      grossProfit: retailGrossProfit,
      grossMarginPercent: retailGrossMargin,
      inventoryUnits: retailInventoryUnits,
      inventoryValue: retailInventoryValue,
      lowStockVariants: lowStockRetailVariants.length,
      topProducts: retailProductSummaries.slice(0, 5),
    },
    attendance: {
      rate: attendanceRate,
      attended: attendedAppointments.length,
      cancelled: cancelledAppointments.length,
      noShows: noShows.length,
      scheduled: scheduledAppointments.length,
    },
    clientsAndLeads: {
      activeStudents: activeStudentsCount ?? 0,
      newLeadRecords: typedLeads.length,
      leads: leadsOnly.length,
      converted: convertedLeads.length,
      archived: archivedLeads.length,
      conversionRate,
    },
    events: {
      paidRegistrations: paidEventRegistrations.length,
      checkedIn: checkedInEventRegistrations.length,
      noShows: eventNoShowCount,
      attendanceRate: eventAttendanceRate,
      topEvents: topEventSummaries.slice(0, 5).map((event) => ({
        name: event.name,
        revenue: event.revenue,
        registrations: event.registrations,
        checkedIn: event.checkedIn,
        noShows: event.noShows,
      })),
      topTickets: topTicketSummaries.slice(0, 5).map((ticket) => ({
        name: ticket.name,
        revenue: ticket.revenue,
        quantity: ticket.quantity,
      })),
    },
    instructors: {
      count: instructorSummaries.length,
      totalLessons: instructorSummaries.reduce(
        (sum, item) => sum + item.totalAppointments,
        0,
      ),
      attendedLessons: instructorSummaries.reduce(
        (sum, item) => sum + item.attended,
        0,
      ),
      totalRevenue: totalInstructorRevenue,
      attendanceRate: instructorActivityAttendanceRate,
      compensation: {
        pending: instructorPayTotals.pending,
        approved: instructorPayTotals.approved,
        paid: instructorPayTotals.paid,
        outstanding: instructorPayOutstandingTotal,
        activeTotal: instructorPayActiveTotal,
      },
      topInstructors: instructorSummaries.slice(0, 5).map((instructor) => ({
        name: instructor.name,
        lessons: instructor.totalAppointments,
        attended: instructor.attended,
        noShows: instructor.noShows,
        revenue: instructor.revenue,
      })),
    },
    organizer: hasOrganizerReportAccess
      ? {
          revenue: organizerRevenueTotal,
          paidRegistrations: paidOrganizerRegistrations.length,
          checkedIn: organizerCheckedInRegistrations.length,
          noShows: organizerNoShowCount,
          attendanceRate: organizerAttendanceRate,
          contacts: typedOrganizerContacts.length,
          campaignsSent: organizerCampaignsSent.length,
          campaignRecipientsSent: organizerCampaignRecipientsSent.length,
          campaignRecipientsFailed: organizerCampaignRecipientsFailed.length,
          campaignRecipientsSuppressed: organizerCampaignRecipientsSuppressed.length,
        }
      : null,
  };

  if (isOrganizerWorkspace) {
    const organizerNetRevenue =
      eventNetRevenueTotal ||
      Math.max(0, organizerRevenueTotal - eventRefundedTotal - eventFeesTotal);
    const organizerProfit =
      eventProfitLossTotal ||
      organizerNetRevenue - eventLinkedExpensesTotal;
    const organizerMargin =
      organizerNetRevenue > 0
        ? Math.round((organizerProfit / organizerNetRevenue) * 100)
        : 0;
    const organizerRegistrations =
      paidEventRegistrations.length || paidOrganizerRegistrations.length;
    const organizerCheckedIn =
      checkedInEventRegistrations.length ||
      organizerCheckedInRegistrations.length;
    const organizerNoShows =
      eventNoShowCount || organizerNoShowCount;
    const organizerAttendance =
      organizerRegistrations > 0
        ? percentage(organizerCheckedIn, organizerRegistrations)
        : "0%";

    return (
      <div className="space-y-8">
        <section className="rounded-[32px] border border-white/15 bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] p-6 text-white shadow-sm md:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-purple-200">
                Organizer Intelligence
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Event Reports
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 md:text-base">
                Track event revenue, costs, attendance, registrant growth, and
                campaign performance without studio-only lesson, package, or
                membership reporting.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {[
                ["30d", "30 Days"],
                ["90d", "90 Days"],
                ["ytd", "Year to Date"],
                ["all", "All Time"],
              ].map(([value, label]) => (
                <Link
                  key={value}
                  href={`/app/reports?range=${value}`}
                  className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                    range === value
                      ? "bg-white text-slate-950"
                      : "bg-white/10 text-white hover:bg-white/20"
                  }`}
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Gross event revenue", fmtCurrency(eventRevenueTotal || organizerRevenueTotal)],
              ["Net event revenue", fmtCurrency(organizerNetRevenue)],
              ["Event profit / loss", fmtCurrency(organizerProfit)],
              ["Profit margin", `${organizerMargin}%`],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur"
              >
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-300">
                  {label}
                </p>
                <p className="mt-2 text-2xl font-semibold">{value}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Paid registrations", fmtNumber(organizerRegistrations), "Confirmed event registrations"],
            ["Checked in", fmtNumber(organizerCheckedIn), organizerAttendance],
            ["No-shows", fmtNumber(organizerNoShows), "Paid registrations not checked in"],
            ["Organizer contacts", fmtNumber(typedOrganizerContacts.length), "Reusable event audience"],
          ].map(([label, value, helper]) => (
            <div
              key={label}
              className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <p className="text-sm text-slate-500">{label}</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
              <p className="mt-1 text-xs text-slate-500">{helper}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-700">
                  Event Performance
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Profitability by Event
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Compare event revenue, costs, profit, registration volume, and
                  attendance for {rangeLabel(range).toLowerCase()}.
                </p>
              </div>
              <a
                href={exportHref("/app/reports/export/event-profitability", range)}
                className="inline-flex w-fit rounded-xl border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-semibold text-purple-800 hover:bg-purple-100"
              >
                Export Event Profitability
              </a>
            </div>

            {topEventSummaries.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                Event profitability will appear after registrations, payments,
                fees, or event expenses are recorded.
              </div>
            ) : (
              <div className="mt-6 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-[0.12em] text-slate-500">
                      <th className="px-3 py-3 font-semibold">Event</th>
                      <th className="px-3 py-3 font-semibold">Registrations</th>
                      <th className="px-3 py-3 font-semibold">Revenue</th>
                      <th className="px-3 py-3 font-semibold">Costs</th>
                      <th className="px-3 py-3 font-semibold">Profit</th>
                      <th className="px-3 py-3 font-semibold">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topEventSummaries.map((event) => (
                      <tr
                        key={event.eventId}
                        className="border-b border-slate-100 last:border-0"
                      >
                        <td className="px-3 py-4">
                          <p className="font-semibold text-slate-950">{event.name}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            {event.type}
                          </p>
                        </td>
                        <td className="px-3 py-4 text-slate-700">
                          {fmtNumber(event.registrations)}
                        </td>
                        <td className="px-3 py-4 text-slate-700">
                          {fmtCurrency(event.netRevenue || event.revenue)}
                        </td>
                        <td className="px-3 py-4 text-slate-700">
                          {fmtCurrency(event.expenses)}
                        </td>
                        <td
                          className={`px-3 py-4 font-semibold ${
                            event.profitLoss >= 0
                              ? "text-emerald-700"
                              : "text-rose-700"
                          }`}
                        >
                          {fmtCurrency(event.profitLoss)}
                        </td>
                        <td className="px-3 py-4 text-slate-700">
                          {event.marginPercent == null
                            ? "—"
                            : `${Math.round(event.marginPercent * 100)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-700">
                Cost Control
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Event P&amp;L
              </h2>

              <div className="mt-5 space-y-3">
                {[
                  ["Gross revenue", eventRevenueTotal || organizerRevenueTotal],
                  ["Refunds", -eventRefundedTotal],
                  ["Processing and platform fees", -eventFeesTotal],
                  ["Event expenses and labor", -eventLinkedExpensesTotal],
                  ["Profit / loss", organizerProfit],
                ].map(([label, amount], index) => (
                  <div
                    key={String(label)}
                    className={`flex items-center justify-between rounded-2xl px-4 py-3 ${
                      index === 4
                        ? "border border-purple-200 bg-purple-50"
                        : "bg-slate-50"
                    }`}
                  >
                    <span className="text-sm font-medium text-slate-700">
                      {label}
                    </span>
                    <span className="text-sm font-semibold text-slate-950">
                      {fmtCurrency(Number(amount))}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <Link
                  href="/app/expenses"
                  className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Manage Event Expenses
                </Link>
                <a
                  href={exportHref("/app/events/export/financial-summary", range)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Export Financial Summary
                </a>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-700">
                Marketing Reach
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Campaign Performance
              </h2>
              <div className="mt-5 grid grid-cols-2 gap-3">
                {[
                  ["Campaigns sent", organizerCampaignsSent.length],
                  ["Delivered", organizerCampaignRecipientsSent.length],
                  ["Failed", organizerCampaignRecipientsFailed.length],
                  ["Suppressed", organizerCampaignRecipientsSuppressed.length],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-2xl bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">{label}</p>
                    <p className="mt-1 text-xl font-semibold text-slate-950">
                      {fmtNumber(Number(value))}
                    </p>
                  </div>
                ))}
              </div>
              <Link
                href="/app/organizer-campaigns"
                className="mt-5 inline-flex rounded-xl border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-semibold text-purple-800 hover:bg-purple-100"
              >
                Open Campaigns
              </Link>
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-700">
              Ticket Mix
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Top Ticket Types
            </h2>

            {topTicketSummaries.length === 0 ? (
              <p className="mt-5 rounded-2xl bg-slate-50 p-5 text-sm text-slate-600">
                Ticket performance will appear after paid registrations.
              </p>
            ) : (
              <div className="mt-5 space-y-3">
                {topTicketSummaries.map((ticket) => (
                  <div
                    key={ticket.key}
                    className="flex items-center justify-between gap-4 rounded-2xl bg-slate-50 p-4"
                  >
                    <div>
                      <p className="font-semibold text-slate-950">{ticket.name}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {fmtNumber(ticket.quantity)} tickets · {ticket.kind}
                      </p>
                    </div>
                    <p className="font-semibold text-slate-950">
                      {fmtCurrency(ticket.revenue)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-700">
              Audience Growth
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Recent Organizer Contacts
            </h2>

            {recentOrganizerContacts.length === 0 ? (
              <p className="mt-5 rounded-2xl bg-slate-50 p-5 text-sm text-slate-600">
                Contacts will appear after registrations are added to the
                organizer audience.
              </p>
            ) : (
              <div className="mt-5 space-y-3">
                {recentOrganizerContacts.map((contact) => (
                  <div
                    key={contact.id}
                    className="flex items-center justify-between gap-4 rounded-2xl bg-slate-50 p-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-950">
                        {organizerContactName(contact)}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {contact.email}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-slate-950">
                        {fmtCurrency(Number(contact.total_spend ?? 0))}
                      </p>
                      <p className="text-xs text-slate-500">
                        {fmtNumber(Number(contact.total_paid_registrations ?? 0))} paid
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Link
              href="/app/organizer-contacts"
              className="mt-5 inline-flex rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Open Organizer Contacts
            </Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="rounded-[32px] border border-white/15 bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] p-6 text-white shadow-sm md:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              DanceFlow
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              Reports
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/75">
              Track studio performance, client activity, revenue, expenses, and
              package usage from one place for {rangeLabel(range).toLowerCase()}
              .
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              ["today", "Today"],
              ["month", "Month"],
              ["last30", "Last 30 Days"],
              ["quarter", "Quarter"],
              ["year", "Year"],
            ].map(([value, label]) => (
              <Link
                key={value}
                href={`/app/reports?range=${value}`}
                className={`rounded-full border px-4 py-2 text-sm font-medium ${
                  range === value
                    ? "border-white bg-white text-slate-950"
                    : "border-white/25 bg-white/10 text-white hover:bg-white/15"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Revenue Collected</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {fmtCurrency(revenueTotal)}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            {fmtNumber(paidRevenueItemsCount)} paid revenue records in{" "}
            {rangeLabel(range).toLowerCase()}.
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Expenses Recorded</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {fmtCurrency(manualExpensesTotal)}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Includes {fmtCurrency(floorFeeExpenseTotal)} in floor fees.
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Attendance Rate</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {attendanceRate}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            {fmtNumber(attendedAppointments.length)} attended,{" "}
            {fmtNumber(noShows.length)} no-shows.
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Active Students</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {fmtNumber(activeStudentsCount ?? 0)}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Current active client records across the studio.
          </p>
        </div>
      </section>

      <ReportInsightsCard
        canUseAi={canViewGrowthReports || canViewProReports}
        metrics={reportInsightsMetrics}
      />

      <AriaInsightCard
        eyebrow="ARIA Revenue Insight"
        title="Revenue focus for this report"
        insight={ariaReportInsight}
        recommendation={ariaReportRecommendation}
        metric={ariaReportMetric}
        primaryAction={{ href: "/app/packages/client-balances", label: "Review balances" }}
        secondaryAction={{ href: "/app/marketing/campaigns", label: "Plan campaign" }}
      />

      <AriaAccountingInsightsSection
        insights={ariaAccountingInsights}
        exportHref={exportHref("/app/reports/export/accounting-map", range)}
      />

      <ReportReadinessCard
        revenueDataMessage={
          revenueTotal > 0
            ? `${fmtNumber(paidRevenueItemsCount)} paid records are included for ${rangeLabel(range).toLowerCase()}.`
            : "No paid revenue is recorded for this period yet."
        }
        expenseDataMessage={
          manualExpensesTotal > 0
            ? `${fmtCurrency(manualExpensesTotal)} in expenses are included in profit previews.`
            : "No expenses are recorded for this period. Add expenses to improve profit previews."
        }
        accountingDepthMessage={
          accountingEntries.length > 0
            ? `${fmtNumber(accountingEntries.length)} normalized accounting entries support this view.`
            : "No normalized accounting entries were found for this period."
        }
        operationalCoverageMessage={
          payoutSummary.count > 0 || activeMemberships.length > 0 || topPackageLiabilityPlans.length > 0
            ? "Payout, membership, and package sections will display when matching data exists."
            : "Payouts, memberships, and package balances will appear here after activity is recorded."
        }
      />

      <section>
        {canViewProReports ? (
          <div className="rounded-3xl border border-indigo-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">
                  Accounting Export Mapping
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Accountant-Ready CSV
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Download a mapped accounting export that groups DanceFlow
                  activity into revenue, refunds, Stripe fees, platform fees,
                  expenses, packages, memberships, events, lessons, and floor
                  rental categories.
                </p>
              </div>
              <a
                href={exportHref("/app/reports/export/accounting-map", range)}
                className="inline-flex w-fit rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-100"
              >
                Download Accounting Map CSV
              </a>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-indigo-50 p-4">
                <p className="text-sm font-medium text-indigo-900">
                  Bookkeeper Categories
                </p>
                <p className="mt-1 text-xs leading-5 text-indigo-900/70">
                  Maps each entry into cleaner accounting types like revenue,
                  refunds, processing fees, platform fees, and expenses.
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  Source Traceability
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Keeps source table, source ID, Stripe IDs, client/event IDs,
                  status, and description attached for audit follow-up.
                </p>
              </div>
              <div className="rounded-2xl bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">
                  Import-Friendly
                </p>
                <p className="mt-1 text-xs leading-5 text-amber-900/70">
                  Built for accountant review and CSV import prep before a
                  future QuickBooks or Wave integration.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Accounting Export Mapping"
            title="Unlock accountant-ready exports"
            description="Download mapped accounting CSVs for bookkeeping, reconciliation, and accounting tool imports with Pro."
            requiredPlan="Pro"
          />
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-3xl border border-[#E9D5FF] bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                Profit & Loss
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Profit & Loss Summary
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Review income, refunds, expenses, and estimated net income for{" "}
                {rangeLabel(range).toLowerCase()}.
              </p>
            </div>
            <span className="inline-flex w-fit rounded-full bg-[#F3E8FF] px-3 py-1 text-xs font-semibold text-[#6B21A8] ring-1 ring-[#E9D5FF]">
              {rangeLabel(range)}
            </span>
          </div>

          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between rounded-2xl bg-emerald-50 px-4 py-3">
              <span className="text-sm font-medium text-emerald-900">
                Income collected
              </span>
              <span className="text-sm font-semibold text-emerald-900">
                {fmtCurrency(revenueTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Studio payments
              </span>
              <span className="text-sm font-semibold text-slate-950">
                {fmtCurrency(studioPaymentRevenueTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Event / ticket revenue
              </span>
              <span className="text-sm font-semibold text-slate-950">
                {fmtCurrency(eventRevenueTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Floor rental revenue
              </span>
              <span className="text-sm font-semibold text-slate-950">
                {fmtCurrency(floorRentalRevenueTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Refunds recorded
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(refundedTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-rose-50 px-4 py-3">
              <span className="text-sm font-medium text-rose-900">
                Expenses recorded
              </span>
              <span className="text-sm font-semibold text-rose-900">
                -{fmtCurrency(manualExpensesTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Floor rental / floor fee expenses
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(floorFeeExpenseTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Other expenses
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(otherExpensesTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Known processing/platform fees
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(knownFeesTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-purple-50 px-4 py-3">
              <span className="text-sm font-medium text-purple-900">
                Instructor compensation
              </span>
              <span className="text-sm font-semibold text-purple-950">
                -{fmtCurrency(instructorCompensationExpense)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl border border-[#D8B4FE] bg-[#FCF8FF] px-4 py-4">
              <span className="text-sm font-semibold text-slate-950">
                Estimated net income
              </span>
              <span className="text-xl font-semibold text-[#5B197A]">
                {fmtCurrency(estimatedNetIncome)}
              </span>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            This report uses revenue, refunds, manually recorded expenses, and
            instructor compensation currently available in DanceFlow. Floor fees
            paid to outside studios and instructor pay are treated as expenses.
            Floor rental fees collected by a host studio are treated as revenue.
          </div>
        </div>

        {canViewGrowthReports ? (
          <div className="rounded-3xl border border-[#E9D5FF] bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                  Instructor Stats
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Instructor Activity
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Review instructor appointment activity in the selected range.
                </p>
              </div>
              <span className="inline-flex w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                {rangeLabel(range)}
              </span>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Instructors</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(instructorSummaries.length)}
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Teaching Hours</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(Math.round(totalInstructorMinutes / 60))}
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Paid Lesson Revenue</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtCurrency(totalInstructorRevenue)}
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Attendance</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {instructorActivityAttendanceRate}
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Private Lessons</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(totalPrivateLessons)}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Group Classes</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(totalGroupClasses)}
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {instructorSummaries.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  No instructor activity found for this range.
                </div>
              ) : (
                instructorSummaries.slice(0, 5).map((instructor) => (
                  <div
                    key={instructor.instructorId}
                    className="rounded-2xl bg-slate-50 p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-semibold text-slate-950">
                          {instructor.name}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {fmtNumber(instructor.attended)} attended ·{" "}
                          {fmtNumber(instructor.scheduled)} scheduled ·{" "}
                          {fmtNumber(instructor.noShows)} no-shows
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {fmtNumber(instructor.privateLessons)} private lessons
                          · {fmtNumber(instructor.groupClasses)} group classes ·{" "}
                          {fmtCurrency(instructor.revenue)} paid lesson revenue
                        </p>
                        <Link
                          href="/app/schedule"
                          className="mt-2 inline-flex text-xs font-semibold text-[#7C2D92] hover:text-[#5B197A]"
                        >
                          View schedule
                        </Link>
                      </div>

                      <div className="text-right">
                        <p className="text-sm font-semibold text-slate-950">
                          {fmtNumber(instructor.totalAppointments)}
                        </p>
                        <p className="text-xs text-slate-500">appointments</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="mt-6 rounded-2xl border border-[#D8B4FE] bg-[#FCF8FF] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-950">
                    Instructor Pay Summary
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    Review pending, approved, and paid instructor earnings for
                    this report range. This is compensation tracking and export
                    support, not tax or direct-deposit payroll processing.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href="/app/instructor-pay"
                    className="inline-flex rounded-xl border border-[#D8B4FE] bg-white px-3 py-2 text-sm font-semibold text-[#6D28D9] hover:bg-[#F5F3FF]"
                  >
                    Open Instructor Pay
                  </Link>
                  <Link
                    href={`/app/instructor-pay/export?range=${range}&status=all`}
                    className="inline-flex rounded-xl bg-[#7C2D92] px-3 py-2 text-sm font-semibold text-white hover:bg-[#5B197A]"
                  >
                    Export Pay CSV
                  </Link>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-2xl bg-white p-4">
                  <p className="text-sm text-slate-500">Pending</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {fmtCurrency(instructorPayTotals.pending)}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-4">
                  <p className="text-sm text-slate-500">Approved</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {fmtCurrency(instructorPayTotals.approved)}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-4">
                  <p className="text-sm text-slate-500">Paid</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {fmtCurrency(instructorPayTotals.paid)}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-4">
                  <p className="text-sm text-slate-500">Awaiting Payment</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {fmtCurrency(instructorPayOutstandingTotal)}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-4">
                  <p className="text-sm text-slate-500">Pay / Revenue</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {instructorPayToLessonRevenueRatio}
                  </p>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {topInstructorPaySummaries.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[#D8B4FE] bg-white px-4 py-5 text-center text-sm text-slate-500">
                    No instructor pay entries are recorded for this range yet.
                    Add compensation rules, then complete lessons or classes to
                    stage earnings automatically.
                  </div>
                ) : (
                  topInstructorPaySummaries.map((instructor) => (
                    <div
                      key={instructor.instructorId}
                      className="flex flex-col gap-3 rounded-2xl bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <p className="font-semibold text-slate-950">
                          {instructor.name}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {fmtNumber(instructor.count)} earnings · Pending {fmtCurrency(instructor.pending)} · Approved {fmtCurrency(instructor.approved)} · Paid {fmtCurrency(instructor.paid)}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-slate-950">
                        {fmtCurrency(instructor.total)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Instructor Reports"
            title="Unlock instructor activity"
            description="Review instructor lesson volume, attendance, teaching hours, and paid lesson activity with Growth."
            requiredPlan="Growth"
          />
        )}
      </section>

      <section className="rounded-3xl border border-emerald-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Commerce Performance
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Retail Revenue &amp; Inventory
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Review physical product sales, product cost, gross margin,
              inventory value, discounts, and low-stock exposure without
              leaving the existing Reports workspace.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/app/catalog"
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              Open Catalog
            </Link>
            <Link
              href="/app/orders"
              className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
            >
              Open Orders
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          {[
            ["Net retail revenue", fmtCurrency(retailNetRevenue)],
            ["Product cost", fmtCurrency(retailCogs)],
            ["Gross profit", fmtCurrency(retailGrossProfit)],
            ["Gross margin", `${retailGrossMargin}%`],
            ["Inventory value", fmtCurrency(retailInventoryValue)],
            ["Low-stock variants", fmtNumber(lowStockRetailVariants.length)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">{label}</p>
              <p className="mt-2 text-xl font-semibold text-slate-950">{value}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_0.8fr]">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Product performance
            </h3>
            <div className="mt-3 space-y-3">
              {retailProductSummaries.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600">
                  Product performance will appear after physical orders are completed.
                </div>
              ) : (
                retailProductSummaries.map((product) => (
                  <div
                    key={product.key}
                    className="grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-[1fr_auto_auto_auto]"
                  >
                    <div>
                      <p className="font-semibold text-slate-950">{product.name}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {fmtNumber(product.quantity)} units sold
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-500">Revenue</p>
                      <p className="font-semibold text-slate-950">
                        {fmtCurrency(product.revenue)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-500">COGS</p>
                      <p className="font-semibold text-slate-950">
                        {fmtCurrency(product.cogs)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-500">Gross profit</p>
                      <p className={`font-semibold ${
                        product.grossProfit >= 0
                          ? "text-emerald-700"
                          : "text-rose-700"
                      }`}>
                        {fmtCurrency(product.grossProfit)}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Retail controls
            </h3>
            <div className="mt-3 space-y-3">
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Completed orders</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">
                  {fmtNumber(completedRetailOrders.length)}
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Units sold</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">
                  {fmtNumber(retailUnitsSold)}
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Discounts</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">
                  {fmtCurrency(retailDiscounts)}
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Refunds</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">
                  {fmtCurrency(retailRefunds)}
                </p>
              </div>
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm text-amber-800">Inventory on hand</p>
                <p className="mt-1 text-2xl font-semibold text-amber-950">
                  {fmtNumber(retailInventoryUnits)}
                </p>
              </div>
            </div>

            <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Payment methods
            </h3>
            <div className="mt-3 space-y-3">
              {retailPaymentMethodSummaries.length === 0 ? (
                <p className="text-sm text-slate-500">No retail payments yet.</p>
              ) : (
                retailPaymentMethodSummaries.slice(0, 6).map((method) => (
                  <div
                    key={method.key}
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                  >
                    <span className="text-sm font-medium capitalize text-slate-700">
                      {method.key.replaceAll("_", " ")}
                    </span>
                    <span className="text-sm font-semibold text-slate-950">
                      {fmtCurrency(method.total)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-[#C4B5FD] bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6D28D9]">
              Accounting Source of Truth
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Net Revenue Preview
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              This preview uses the accounting source of truth to separate gross
              revenue, refunds, Stripe fees, platform fees, expenses, instructor
              compensation, and net revenue for the selected report range.
            </p>
          </div>
          <Link
            href={`/app/reports/export/accounting?range=${range}`}
            className="inline-flex w-fit rounded-xl border border-[#C4B5FD] bg-[#F5F3FF] px-4 py-2 text-sm font-semibold text-[#5B21B6] hover:bg-[#EDE9FE]"
          >
            Export Accounting CSV
          </Link>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-7">
          <div className="rounded-2xl bg-emerald-50 p-4">
            <p className="text-sm text-emerald-900/70">Gross Revenue</p>
            <p className="mt-2 text-2xl font-semibold text-emerald-950">
              {fmtCurrency(accountingSummary.revenue)}
            </p>
          </div>

          <div className="rounded-2xl bg-amber-50 p-4">
            <p className="text-sm text-amber-900/70">Refunds</p>
            <p className="mt-2 text-2xl font-semibold text-amber-950">
              -{fmtCurrency(accountingSummary.refunds)}
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Stripe Fees</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              -{fmtCurrency(accountingSummary.stripeProcessingFees)}
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Platform Fees</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              -{fmtCurrency(accountingSummary.platformFees)}
            </p>
          </div>

          <div className="rounded-2xl bg-rose-50 p-4">
            <p className="text-sm text-rose-900/70">Expenses</p>
            <p className="mt-2 text-2xl font-semibold text-rose-950">
              -{fmtCurrency(accountingSummary.expenses)}
            </p>
          </div>

          <div className="rounded-2xl bg-purple-50 p-4">
            <p className="text-sm text-purple-900/70">Instructor Pay</p>
            <p className="mt-2 text-2xl font-semibold text-purple-950">
              -{fmtCurrency(instructorCompensationExpense)}
            </p>
          </div>

          <div className="rounded-2xl border border-[#C4B5FD] bg-[#F5F3FF] p-4">
            <p className="text-sm font-medium text-[#5B21B6]">
              Net After Instructor Pay
            </p>
            <p className="mt-2 text-2xl font-semibold text-[#4C1D95]">
              {fmtCurrency(profitAfterInstructorCompensation)}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-col gap-2 text-sm text-slate-700 lg:flex-row lg:items-center lg:justify-between">
            <span>
              Net formula: gross revenue minus refunds, Stripe fees, platform
              fees, expenses, and instructor compensation.
            </span>
            <span className="font-semibold text-slate-950">
              {fmtCurrency(accountingSummary.revenue)} - {fmtCurrency(accountingSummary.refunds)} - {fmtCurrency(accountingSummary.fees)} - {fmtCurrency(accountingSummary.expenses)} - {fmtCurrency(instructorCompensationExpense)} = {fmtCurrency(profitAfterInstructorCompensation)}
            </span>
          </div>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Revenue categories
            </h3>
            <div className="mt-3 space-y-3">
              {accountingRevenueCategories.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  No accounting revenue entries found for this range.
                </p>
              ) : (
                accountingRevenueCategories.slice(0, 6).map((item) => (
                  <div
                    key={item.key}
                    className="flex items-start justify-between gap-4 rounded-2xl bg-emerald-50/70 p-4"
                  >
                    <div>
                      <p className="text-sm font-semibold text-emerald-950">
                        {item.label}
                      </p>
                      <p className="mt-1 text-xs text-emerald-900/70">
                        {fmtNumber(item.count)} entries
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-emerald-950">
                      {fmtCurrency(item.total)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Deductions
            </h3>
            <div className="mt-3 space-y-3">
              {accountingRefundCategories.length === 0 &&
              accountingFeeCategories.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  No refund or fee entries found for this range.
                </p>
              ) : (
                [...accountingRefundCategories, ...accountingFeeCategories]
                  .slice(0, 8)
                  .map((item) => (
                    <div
                      key={item.key}
                      className="flex items-start justify-between gap-4 rounded-2xl bg-slate-50 p-4"
                    >
                      <div>
                        <p className="text-sm font-semibold text-slate-950">
                          {item.label}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {fmtNumber(item.count)} entries
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-slate-950">
                        -{fmtCurrency(item.total)}
                      </p>
                    </div>
                  ))
              )}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Expense categories
            </h3>
            <div className="mt-3 space-y-3">
              {accountingExpenseCategories.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  No accounting expense entries found for this range.
                </p>
              ) : (
                accountingExpenseCategories.slice(0, 6).map((item) => (
                  <div
                    key={item.key}
                    className="flex items-start justify-between gap-4 rounded-2xl bg-rose-50/70 p-4"
                  >
                    <div>
                      <p className="text-sm font-semibold text-rose-950">
                        {item.label}
                      </p>
                      <p className="mt-1 text-xs text-rose-900/70">
                        {fmtNumber(item.count)} entries
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-rose-950">
                      -{fmtCurrency(item.total)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
          Net Revenue Preview is powered by the same normalized accounting
          entries used by the Accounting CSV export. Revenue, refunds, fees,
          and expenses stay separate so the export remains easy to audit.
        </div>
      </section>

      <section className="rounded-3xl border border-emerald-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Expense-to-Profit Reporting
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Expense Impact & Profit Preview
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Connect recorded expenses to net revenue so studios can see how
              floor fees, event costs, and operating expenses affect profit for
              the selected range.
            </p>
          </div>
          <Link
            href="/app/expenses"
            className="inline-flex w-fit rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            Manage Expenses
          </Link>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl bg-emerald-50 p-4">
            <p className="text-sm font-medium text-emerald-900">
              Revenue After Refunds
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-emerald-950">
              {fmtCurrency(revenueAfterRefunds)}
            </p>
            <p className="mt-1 text-xs text-emerald-900/70">
              Gross revenue minus refunds.
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-700">After Fees</p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              {fmtCurrency(netAfterFees)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Revenue after refunds, Stripe fees, and platform fees.
            </p>
          </div>

          <div className="rounded-2xl bg-rose-50 p-4">
            <p className="text-sm font-medium text-rose-900">
              Total Expenses
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-rose-950">
              -{fmtCurrency(accountingSummary.expenses)}
            </p>
            <p className="mt-1 text-xs text-rose-900/70">
              {fmtNumber(typedExpenses.length)} manually recorded expenses.
            </p>
          </div>

          <div className="rounded-2xl bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">
              Expense Ratio
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-amber-950">
              {expenseToRevenueRatio}
            </p>
            <p className="mt-1 text-xs text-amber-900/70">
              Expenses compared to revenue after refunds.
            </p>
          </div>

          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-medium text-emerald-900">
              Profit Preview
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-emerald-950">
              {fmtCurrency(profitAfterInstructorCompensation)}
            </p>
            <p className="mt-1 text-xs text-emerald-900/70">
              Net after refunds, fees, expenses, and instructor pay.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Expense Buckets
            </h3>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                <span className="font-medium text-slate-700">
                  Floor fee expenses
                </span>
                <span className="font-semibold text-slate-950">
                  -{fmtCurrency(expenseToProfitBuckets.floorFees)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                <span className="font-medium text-slate-700">
                  Event-related expenses
                </span>
                <span className="font-semibold text-slate-950">
                  -{fmtCurrency(expenseToProfitBuckets.eventRelated)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                <span className="font-medium text-slate-700">
                  Studio operating expenses
                </span>
                <span className="font-semibold text-slate-950">
                  -{fmtCurrency(expenseToProfitBuckets.studioOperating)}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Top Expense Categories
            </h3>
            <div className="mt-4 space-y-3">
              {expenseCategorySummaries.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
                  No expenses recorded in this range.
                </p>
              ) : (
                expenseCategorySummaries.slice(0, 5).map((item) => (
                  <div
                    key={item.key}
                    className="flex items-start justify-between gap-4 rounded-xl bg-white px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-semibold text-slate-950">
                        {item.label}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {fmtNumber(item.count)} expenses
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-slate-950">
                      -{fmtCurrency(item.total)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
          Profit Preview uses the accounting source-of-truth totals for revenue,
          refunds, Stripe fees, platform fees, and expenses. Expense buckets use
          the current expense records and categorize them by floor fee,
          event-related, or studio operating expense.
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Payout Reconciliation
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Recent Stripe Payouts
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Review what Stripe paid out, when it is expected to arrive, and
              how many payout items are matched back to DanceFlow payment
              records.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/app/reports/export/payouts?range=${range}`}
              className="inline-flex w-fit rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Export Payouts
            </Link>
            <Link
              href={`/app/reports/export/payout-items?range=${range}`}
              className="inline-flex w-fit rounded-xl border border-[#C4B5FD] bg-[#F5F3FF] px-4 py-2 text-sm font-semibold text-[#5B21B6] hover:bg-[#EDE9FE]"
            >
              Export Details
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Total Payouts</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {fmtCurrency(payoutSummary.totalPayouts)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {fmtNumber(payoutSummary.count)} payouts
            </p>
          </div>

          <div className="rounded-2xl bg-green-50 p-4">
            <p className="text-sm text-green-900/70">Paid</p>
            <p className="mt-2 text-2xl font-semibold text-green-950">
              {fmtNumber(payoutSummary.paidCount)}
            </p>
          </div>

          <div className="rounded-2xl bg-amber-50 p-4">
            <p className="text-sm text-amber-900/70">Pending / In Transit</p>
            <p className="mt-2 text-2xl font-semibold text-amber-950">
              {fmtNumber(payoutSummary.pendingCount)}
            </p>
          </div>

          <div className="rounded-2xl bg-red-50 p-4">
            <p className="text-sm text-red-900/70">Failed</p>
            <p className="mt-2 text-2xl font-semibold text-red-950">
              {fmtNumber(payoutSummary.failedCount)}
            </p>
          </div>

          <div className="rounded-2xl border border-[#C4B5FD] bg-[#F5F3FF] p-4">
            <p className="text-sm font-medium text-[#5B21B6]">
              Unmatched Items
            </p>
            <p className="mt-2 text-2xl font-semibold text-[#4C1D95]">
              {fmtNumber(payoutSummary.unmatchedItems)}
            </p>
            <p className="mt-1 text-xs text-[#6D28D9]">
              {fmtNumber(payoutSummary.matchedItems)} matched
            </p>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200">
          {recentPayoutSummaries.length === 0 ? (
            <div className="bg-slate-50 px-4 py-10 text-center">
              <p className="text-sm font-semibold text-slate-950">
                No Stripe payouts have been recorded yet.
              </p>
              <p className="mt-2 text-sm text-slate-600">
                Payouts will appear here after Stripe sends payout events for
                this studio.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Payout</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Arrival</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3 text-right">Matched</th>
                    <th className="px-4 py-3 text-right">Unmatched</th>
                    <th className="px-4 py-3 text-right">Item Net</th>
                    <th className="px-4 py-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {recentPayoutSummaries.map((payout) => (
                    <tr key={payout.id}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-950">
                          {payout.stripe_payout_id}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {payout.stripe_account_id ?? "Stripe account not recorded"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${payoutStatusBadgeClass(
                            payout.status,
                          )}`}
                        >
                          {labelize(payout.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {fmtDate(payout.arrival_date)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-950">
                        {fmtCurrency(moneyValue(payout.amount))}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">
                        {fmtNumber(payout.itemSummary.matchedCount)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">
                        {fmtNumber(payout.itemSummary.unmatchedCount)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">
                        {fmtCurrency(payout.itemSummary.netAmount)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/app/reports/export/payout-items?range=${range}&payoutId=${encodeURIComponent(
                            payout.stripe_payout_id,
                          )}`}
                          className="text-xs font-semibold text-[#6D28D9] hover:text-[#4C1D95]"
                        >
                          Export details
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
          Tip: unmatched items are expected when Stripe includes adjustments,
          fees, transfers, refunds, or records that do not map cleanly to a
          DanceFlow payment yet.
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-3">
        <div className="rounded-3xl border border-[#BBF7D0] bg-white p-6 shadow-sm xl:col-span-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Revenue Breakdown
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Where income came from
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Separates studio payments, event revenue, and floor rental revenue
            so the P&L is easier to review.
          </p>

          <div className="mt-6 space-y-3">
            {revenueBreakdown.map((item) => (
              <div
                key={item.key}
                className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-emerald-950">
                      {item.label}
                    </p>
                    <p className="mt-1 text-xs text-emerald-900/70">
                      {fmtNumber(item.count)} records
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-emerald-950">
                    {fmtCurrency(item.total)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-3xl border border-[#FECACA] bg-white p-6 shadow-sm xl:col-span-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-700">
            Expense Breakdown
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Spending by category
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Highlights the largest expense categories recorded in Expenses.
          </p>

          <div className="mt-6 space-y-3">
            {expenseCategorySummaries.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                No expenses recorded for this range.
              </div>
            ) : (
              expenseCategorySummaries.slice(0, 6).map((item) => (
                <div
                  key={item.key}
                  className="rounded-2xl border border-rose-100 bg-rose-50/70 p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-rose-950">
                        {item.label}
                      </p>
                      <p className="mt-1 text-xs text-rose-900/70">
                        {fmtNumber(item.count)} records
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-rose-950">
                      {fmtCurrency(item.total)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-[#E9D5FF] bg-white p-6 shadow-sm xl:col-span-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
            P&L Health
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Financial snapshot
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Quick view of margin after refunds and expenses for the selected
            range.
          </p>

          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Gross income
              </span>
              <span className="text-sm font-semibold text-slate-950">
                {fmtCurrency(revenueTotal)}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Refunds
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(refundedTotal)}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Expenses
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(manualExpensesTotal)}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-[#D8B4FE] bg-[#FCF8FF] px-4 py-4">
              <span className="text-sm font-semibold text-slate-950">
                Estimated net
              </span>
              <span className="text-xl font-semibold text-[#5B197A]">
                {fmtCurrency(estimatedNetIncome)}
              </span>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
            This is a management estimate based on the records currently saved
            in DanceFlow. It becomes more accurate as expenses and refunds are
            recorded consistently.
          </div>
        </div>
      </section>

      <section>
        {canViewProReports ? (
          <div className="rounded-3xl border border-indigo-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">
                  Accounting Export Mapping
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Accountant-Ready CSV
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Download a mapped accounting export that groups DanceFlow
                  activity into revenue, refunds, Stripe fees, platform fees,
                  expenses, packages, memberships, events, lessons, and floor
                  rental categories.
                </p>
              </div>
              <a
                href={exportHref("/app/reports/export/accounting-map", range)}
                className="inline-flex w-fit rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-100"
              >
                Download Accounting Map CSV
              </a>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-indigo-50 p-4">
                <p className="text-sm font-medium text-indigo-900">
                  Bookkeeper Categories
                </p>
                <p className="mt-1 text-xs leading-5 text-indigo-900/70">
                  Maps each entry into cleaner accounting types like revenue,
                  refunds, processing fees, platform fees, and expenses.
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  Source Traceability
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Keeps source table, source ID, Stripe IDs, client/event IDs,
                  status, and description attached for audit follow-up.
                </p>
              </div>
              <div className="rounded-2xl bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">
                  Import-Friendly
                </p>
                <p className="mt-1 text-xs leading-5 text-amber-900/70">
                  Built for accountant review and CSV import prep before a
                  future QuickBooks or Wave integration.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Accounting Export Mapping"
            title="Unlock accountant-ready exports"
            description="Download mapped accounting CSVs for bookkeeping, reconciliation, and accounting tool imports with Pro."
            requiredPlan="Pro"
          />
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                Revenue snapshot
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Studio payments plus event registration revenue by status,
                method, and sale type.
              </p>
            </div>
            <Link
              href="/app/payments"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Open Payments
            </Link>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Paid Payments</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(paidPayments.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Pending</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(pendingPayments.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Refunded</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(refundedPayments.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Paid Event Registrations</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(paidEventRegistrations.length)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {fmtCurrency(eventRevenueTotal)} event/ticket revenue
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-3">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Payment Methods
              </h3>
              <div className="mt-3 space-y-3">
                {topPaymentMethods.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No payment activity in this range.
                  </p>
                ) : (
                  topPaymentMethods.map(([method, count]) => (
                    <div
                      key={method}
                      className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                    >
                      <span className="text-sm font-medium text-slate-700">
                        {labelize(method)}
                      </span>
                      <span className="text-sm font-semibold text-slate-950">
                        {fmtNumber(count)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Payment Channels
              </h3>
              <div className="mt-3 space-y-3">
                {topPaymentChannels.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No payment channel data in this range.
                  </p>
                ) : (
                  topPaymentChannels.map(([channel, count]) => (
                    <div
                      key={channel}
                      className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                    >
                      <span className="text-sm font-medium text-slate-700">
                        {paymentChannelLabel(channel)}
                      </span>
                      <span className="text-sm font-semibold text-slate-950">
                        {fmtNumber(count)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Payment Types
              </h3>
              <div className="mt-3 space-y-3">
                {topPaymentTypes.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No payment type data in this range.
                  </p>
                ) : (
                  topPaymentTypes.map(([type, count]) => (
                    <div
                      key={type}
                      className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                    >
                      <span className="text-sm font-medium text-slate-700">
                        {labelize(type)}
                      </span>
                      <span className="text-sm font-semibold text-slate-950">
                        {fmtNumber(count)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Studio Revenue by Payment Type
            </h3>
            <div className="mt-3 space-y-3">
              {paymentTypeRevenueSummaries.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No paid studio payment revenue in this range.
                </p>
              ) : (
                paymentTypeRevenueSummaries.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                  >
                    <span className="text-sm font-medium text-slate-700">
                      {item.label}
                    </span>
                    <span className="text-sm font-semibold text-slate-950">
                      {fmtCurrency(item.total)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">
                Average Paid Studio Payment
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(averagePaidPayment)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Studio Payment Revenue</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(studioPaymentRevenueTotal)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Event/Ticket Revenue</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(eventRevenueTotal)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Floor Rental Revenue</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(floorRentalRevenueTotal)}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                Growth snapshot
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Lead intake and where interest is coming from.
              </p>
            </div>
            <Link
              href="/app/leads"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Open Leads
            </Link>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">New Leads</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(leadsOnly.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Converted</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(convertedLeads.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Archived</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(archivedLeads.length)}
              </p>
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Top Lead Sources
            </h3>
            <div className="mt-3 space-y-3">
              {topLeadSources.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No lead sources recorded in this range.
                </p>
              ) : (
                topLeadSources.map(([source, count]) => (
                  <div
                    key={source}
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                  >
                    <span className="text-sm font-medium text-slate-700">
                      {sourceLabel(source)}
                    </span>
                    <span className="text-sm font-semibold text-slate-950">
                      {fmtNumber(count)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Lead Conversion Rate</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {conversionRate}
            </p>
          </div>
        </div>
      </section>

      <section>
        {canViewProReports ? (
          <div className="rounded-3xl border border-indigo-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">
                  Accounting Export Mapping
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Accountant-Ready CSV
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Download a mapped accounting export that groups DanceFlow
                  activity into revenue, refunds, Stripe fees, platform fees,
                  expenses, packages, memberships, events, lessons, and floor
                  rental categories.
                </p>
              </div>
              <a
                href={exportHref("/app/reports/export/accounting-map", range)}
                className="inline-flex w-fit rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-100"
              >
                Download Accounting Map CSV
              </a>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-indigo-50 p-4">
                <p className="text-sm font-medium text-indigo-900">
                  Bookkeeper Categories
                </p>
                <p className="mt-1 text-xs leading-5 text-indigo-900/70">
                  Maps each entry into cleaner accounting types like revenue,
                  refunds, processing fees, platform fees, and expenses.
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  Source Traceability
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Keeps source table, source ID, Stripe IDs, client/event IDs,
                  status, and description attached for audit follow-up.
                </p>
              </div>
              <div className="rounded-2xl bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">
                  Import-Friendly
                </p>
                <p className="mt-1 text-xs leading-5 text-amber-900/70">
                  Built for accountant review and CSV import prep before a
                  future QuickBooks or Wave integration.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Accounting Export Mapping"
            title="Unlock accountant-ready exports"
            description="Download mapped accounting CSVs for bookkeeping, reconciliation, and accounting tool imports with Pro."
            requiredPlan="Pro"
          />
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                Expenses snapshot
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Manual business expenses recorded for the selected date range.
              </p>
            </div>
            <Link
              href="/app/expenses"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Open Expenses
            </Link>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Total Expenses</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(manualExpensesTotal)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Floor Fees</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(floorFeeExpenseTotal)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Expense Records</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(typedExpenses.length)}
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-3">
            {typedExpenses.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                No expenses found for this range.
              </div>
            ) : (
              typedExpenses.slice(0, 5).map((expense) => (
                <div
                  key={expense.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900">
                        {expense.vendor_name}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {expenseCategoryLabel(expense.category)} •{" "}
                        {labelize(expense.payment_method)} •{" "}
                        {new Date(
                          `${expense.expense_date}T00:00:00`,
                        ).toLocaleDateString([], {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>

                    <p className="font-semibold text-slate-950">
                      {fmtCurrency(Number(expense.amount ?? 0))}
                    </p>
                  </div>

                  {expense.notes ? (
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {expense.notes}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        {canViewGrowthReports ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                  Studio performance
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Quick view of client growth, attendance, and activity for the
                  selected range.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/app/clients"
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Open Clients
                </Link>
                <Link
                  href="/app/reports/client-birthdays"
                  className="rounded-xl bg-[#6B21A8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#581C87]"
                >
                  Birthday Outreach
                </Link>
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Active Students</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(activeStudentsCount ?? 0)}
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">New Clients</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(convertedLeads.length)}
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">New Leads</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(leadsOnly.length)}
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Lead Conversion</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {conversionRate}
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Appointment Outcomes</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(totalAppointmentOutcomes)}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Attendance Rate</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {attendanceRate}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Client Activity</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(clientActivityTotal)}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Studio Performance"
            title="Unlock client and lead reporting"
            description="Track client growth, lead conversion, attendance outcomes, and studio activity with Growth."
            requiredPlan="Growth"
          />
        )}
      </section>

      <section>
        {canViewProReports ? (
          <div className="rounded-3xl border border-indigo-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">
                  Accounting Export Mapping
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Accountant-Ready CSV
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Download a mapped accounting export that groups DanceFlow
                  activity into revenue, refunds, Stripe fees, platform fees,
                  expenses, packages, memberships, events, lessons, and floor
                  rental categories.
                </p>
              </div>
              <a
                href={exportHref("/app/reports/export/accounting-map", range)}
                className="inline-flex w-fit rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-100"
              >
                Download Accounting Map CSV
              </a>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-indigo-50 p-4">
                <p className="text-sm font-medium text-indigo-900">
                  Bookkeeper Categories
                </p>
                <p className="mt-1 text-xs leading-5 text-indigo-900/70">
                  Maps each entry into cleaner accounting types like revenue,
                  refunds, processing fees, platform fees, and expenses.
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  Source Traceability
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Keeps source table, source ID, Stripe IDs, client/event IDs,
                  status, and description attached for audit follow-up.
                </p>
              </div>
              <div className="rounded-2xl bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">
                  Import-Friendly
                </p>
                <p className="mt-1 text-xs leading-5 text-amber-900/70">
                  Built for accountant review and CSV import prep before a
                  future QuickBooks or Wave integration.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Accounting Export Mapping"
            title="Unlock accountant-ready exports"
            description="Download mapped accounting CSVs for bookkeeping, reconciliation, and accounting tool imports with Pro."
            requiredPlan="Pro"
          />
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">
            Attendance snapshot
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Appointment outcomes for the selected date range.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Scheduled</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(scheduledAppointments.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Attended</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(attendedAppointments.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Cancelled</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(cancelledAppointments.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">No-Shows</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(noShows.length)}
              </p>
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Appointment Types
            </h3>
            <div className="mt-3 space-y-3">
              {topAppointmentTypes.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No appointment activity in this range.
                </p>
              ) : (
                topAppointmentTypes.map(([type, count]) => (
                  <div
                    key={type}
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                  >
                    <span className="text-sm font-medium text-slate-700">
                      {labelize(type)}
                    </span>
                    <span className="text-sm font-semibold text-slate-950">
                      {fmtNumber(count)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {canViewGrowthReports ? (
          <div className="rounded-3xl border border-[#BAE6FD] bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#0369A1]">
                  Package Liability & Credits
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Package Sales, Usage & Unused Credit Value
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Monitor cash collected from package sales, remaining lesson credits,
                  estimated unused credit value, and clients approaching zero credits.
                </p>
              </div>
              <Link
                href="/app/packages/sell"
                className="inline-flex w-fit rounded-xl border border-sky-200 px-4 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-50"
              >
                Sell Packages
              </Link>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl bg-sky-50 p-4">
                <p className="text-sm font-medium text-sky-800">
                  Package Cash Collected
                </p>
                <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  {fmtCurrency(packageCashCollected)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Paid package payments in this range.
                </p>
              </div>

              <div className="rounded-2xl bg-cyan-50 p-4">
                <p className="text-sm font-medium text-cyan-800">
                  Unused Credit Value
                </p>
                <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  {fmtCurrency(packageOutstandingCreditValue)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Estimated value of remaining active package credits.
                </p>
              </div>

              <div className="rounded-2xl bg-emerald-50 p-4">
                <p className="text-sm font-medium text-emerald-800">
                  Credits Remaining
                </p>
                <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  {fmtNumber(packageCreditsRemainingPortfolio)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Active unused package lessons.
                </p>
              </div>

              <div className="rounded-2xl bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-800">
                  Low / Zero Credit Packages
                </p>
                <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  {fmtNumber(lowCreditPackages.length + zeroCreditPackages.length)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Clients needing renewal follow-up.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Packages Sold</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(typedPackages.length)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {fmtNumber(packageCreditsSoldThisPeriod)} credits sold this range.
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Package Revenue Snapshot</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtCurrency(packageRevenueSnapshot)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Uses package sold price snapshots.
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Credits Used</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(packageCreditsUsedPortfolio)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Consumed credits across active packages.
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Package Refunds / Failed</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtCurrency(packageRefundTotal)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {fmtNumber(failedPackagePayments.length)} failed package payments.
                </p>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-dashed border-sky-200 bg-sky-50/70 p-4">
              <p className="text-sm font-semibold text-sky-900">
                Management reporting preview
              </p>
              <p className="mt-1 text-sm leading-6 text-sky-900/80">
                Unused credit value estimates remaining lesson value from package
                sold price divided by original lesson count. It is designed for
                operational visibility and is not formal deferred-revenue accounting.
              </p>
              <p className="mt-2 text-xs text-sky-900/70">
                Inactive package remaining value: {fmtCurrency(inactivePackageOutstandingValue)}
              </p>
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Top Packages Sold
                </h3>
                <div className="mt-3 space-y-3">
                  {topPackages.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      No package sales in this range.
                    </p>
                  ) : (
                    topPackages.map(([name, count]) => (
                      <div
                        key={name}
                        className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                      >
                        <span className="text-sm font-medium text-slate-700">
                          {name}
                        </span>
                        <span className="text-sm font-semibold text-slate-950">
                          {fmtNumber(count)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Top Unused Credit Value
                </h3>
                <div className="mt-3 space-y-3">
                  {topPackageLiabilityPlans.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      No active unused package balances yet.
                    </p>
                  ) : (
                    topPackageLiabilityPlans.map((plan) => (
                      <div
                        key={plan.name}
                        className="rounded-xl bg-slate-50 px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-slate-700">
                            {plan.name}
                          </span>
                          <span className="text-sm font-semibold text-slate-950">
                            {fmtCurrency(plan.outstandingValue)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {fmtNumber(plan.count)} active packages ·{" "}
                          {fmtNumber(plan.remainingCredits)} credits remaining
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Package Reports"
            title="Unlock package reporting"
            description="Review package sales and package revenue snapshots with Growth."
            requiredPlan="Growth"
          />
        )}
      </section>

      <section>
        {canViewProReports ? (
          <div className="rounded-3xl border border-indigo-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">
                  Accounting Export Mapping
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Accountant-Ready CSV
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Download a mapped accounting export that groups DanceFlow
                  activity into revenue, refunds, Stripe fees, platform fees,
                  expenses, packages, memberships, events, lessons, and floor
                  rental categories.
                </p>
              </div>
              <a
                href={exportHref("/app/reports/export/accounting-map", range)}
                className="inline-flex w-fit rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-100"
              >
                Download Accounting Map CSV
              </a>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-indigo-50 p-4">
                <p className="text-sm font-medium text-indigo-900">
                  Bookkeeper Categories
                </p>
                <p className="mt-1 text-xs leading-5 text-indigo-900/70">
                  Maps each entry into cleaner accounting types like revenue,
                  refunds, processing fees, platform fees, and expenses.
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  Source Traceability
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Keeps source table, source ID, Stripe IDs, client/event IDs,
                  status, and description attached for audit follow-up.
                </p>
              </div>
              <div className="rounded-2xl bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">
                  Import-Friendly
                </p>
                <p className="mt-1 text-xs leading-5 text-amber-900/70">
                  Built for accountant review and CSV import prep before a
                  future QuickBooks or Wave integration.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Accounting Export Mapping"
            title="Unlock accountant-ready exports"
            description="Download mapped accounting CSVs for bookkeeping, reconciliation, and accounting tool imports with Pro."
            requiredPlan="Pro"
          />
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        {canViewGrowthReports ? (
          <div className="rounded-3xl border border-[#D8B4FE] bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                  Membership Accounting
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Membership Revenue & Recurring Income
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Track active memberships, new memberships, payments, failed billing,
                  refunds, and monthly recurring revenue preview.
                </p>
              </div>
              <Link
                href="/app/memberships"
                className="inline-flex w-fit rounded-xl border border-[#E9D5FF] px-4 py-2 text-sm font-semibold text-[#6B21A8] hover:bg-[#F3E8FF]"
              >
                Manage Memberships
              </Link>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl bg-[#FAF5FF] p-4">
                <p className="text-sm font-medium text-[#6B21A8]">MRR Preview</p>
                <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  {fmtCurrency(monthlyRecurringRevenuePreview)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Based on active memberships and billing interval snapshots.
                </p>
              </div>

              <div className="rounded-2xl bg-emerald-50 p-4">
                <p className="text-sm font-medium text-emerald-800">
                  Active Memberships
                </p>
                <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  {fmtNumber(activeMemberships.length)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {fmtNumber(renewingMemberships.length)} set to auto-renew.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-700">
                  New This Period
                </p>
                <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  {fmtNumber(typedMemberships.length)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Snapshot value {fmtCurrency(membershipRevenueSnapshot)}.
                </p>
              </div>

              <div className="rounded-2xl bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-800">
                  Needs Attention
                </p>
                <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  {fmtNumber(pendingMemberships.length + failedMembershipPayments.length)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Pending/past-due memberships plus failed membership payments.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-950">
                  Payments This Period
                </p>
                <div className="mt-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Paid membership payments</span>
                    <span className="font-semibold text-slate-950">
                      {fmtCurrency(membershipPaymentRevenue)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Payment records</span>
                    <span className="font-semibold text-slate-950">
                      {fmtNumber(paidMembershipPayments.length)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Refunds</span>
                    <span className="font-semibold text-slate-950">
                      -{fmtCurrency(membershipRefundTotal)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-950">
                  Portfolio Status
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-lg font-semibold text-slate-950">
                      {fmtNumber(activeMemberships.length)}
                    </p>
                    <p className="text-xs text-slate-500">Active</p>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-lg font-semibold text-slate-950">
                      {fmtNumber(pendingMemberships.length)}
                    </p>
                    <p className="text-xs text-slate-500">Pending / past due</p>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-lg font-semibold text-slate-950">
                      {fmtNumber(endingMemberships.length)}
                    </p>
                    <p className="text-xs text-slate-500">Ending</p>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-lg font-semibold text-slate-950">
                      {fmtNumber(canceledMemberships.length)}
                    </p>
                    <p className="text-xs text-slate-500">Canceled / inactive</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-950">
                  Top Active Plans
                </p>
                <div className="mt-3 space-y-2">
                  {topMembershipPlans.length === 0 ? (
                    <p className="rounded-xl bg-white p-3 text-sm text-slate-500">
                      No active membership plans yet.
                    </p>
                  ) : (
                    topMembershipPlans.map((plan) => (
                      <div
                        key={plan.name}
                        className="flex items-center justify-between gap-3 rounded-xl bg-white p-3"
                      >
                        <div>
                          <p className="text-sm font-semibold text-slate-900">
                            {plan.name}
                          </p>
                          <p className="text-xs text-slate-500">
                            {fmtNumber(plan.count)} active
                          </p>
                        </div>
                        <p className="text-sm font-semibold text-slate-950">
                          {fmtCurrency(plan.mrr)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Membership Reports"
            title="Unlock membership reporting"
            description="Review membership starts and membership revenue snapshots with Growth."
            requiredPlan="Growth"
          />
        )}

        {canViewProReports ? (
          <div className="rounded-3xl border border-[#FED7AA] bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#C2410C]">
                  Event & Ticket Reports
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Event revenue and attendance
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  See ticket revenue, check-ins, no-shows, and top-performing
                  events for {rangeLabel(range).toLowerCase()}.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={exportHref("/app/reports/export/event-profitability", range)}
                  className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-800 hover:bg-orange-100"
                >
                  Export Event Profitability CSV
                </Link>
                <Link
                  href="/app/events"
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Open Events
                </Link>
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl bg-orange-50 p-4">
                <p className="text-sm text-orange-900/70">Gross Ticket Revenue</p>
                <p className="mt-2 text-2xl font-semibold text-orange-950">
                  {fmtCurrency(eventRevenueTotal)}
                </p>
                <p className="mt-1 text-xs text-orange-900/70">
                  Net after refunds and fees: {fmtCurrency(eventNetRevenueTotal)}
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Event Expenses</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  -{fmtCurrency(eventLinkedExpensesTotal)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Expenses linked to a specific event
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Event Profit / Loss</p>
                <p className={`mt-2 text-2xl font-semibold ${eventProfitLossTotal >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                  {fmtCurrency(eventProfitLossTotal)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Net ticket revenue minus event expenses
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Event Margin</p>
                <p className={`mt-2 text-2xl font-semibold ${eventProfitMarginPercent >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                  {eventProfitMarginPercent}%
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Profit / loss divided by net ticket revenue
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Paid Registrations</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(paidEventRegistrations.length)}
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Checked In</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(checkedInEventRegistrations.length)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {eventAttendanceRate} attendance rate
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">No-Shows</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {fmtNumber(eventNoShowCount)}
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Top Events
                </h3>
                <div className="mt-3 space-y-3">
                  {topEventSummaries.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                      No paid event registrations in this range.
                    </p>
                  ) : (
                    topEventSummaries.map((event) => (
                      <div
                        key={event.eventId}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="font-semibold text-slate-950">
                              {event.name}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {labelize(event.type)} ·{" "}
                              {fmtNumber(event.tickets)} tickets ·{" "}
                              {fmtNumber(event.checkedIn)} checked in
                            </p>
                            <p className="mt-1 text-xs text-slate-400">
                              {event.marginPercent === null
                                ? "Margin pending"
                                : `${Math.round(event.marginPercent * 100)}% margin`}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className={`text-sm font-semibold ${event.profitLoss >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                              {fmtCurrency(event.profitLoss)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {fmtCurrency(event.netRevenue)} net · -{fmtCurrency(event.expenses)} expenses
                            </p>
                            {event.refunds > 0 || event.fees > 0 ? (
                              <p className="mt-1 text-xs text-slate-400">
                                {fmtCurrency(event.revenue)} gross · -{fmtCurrency(event.refunds)} refunds · -{fmtCurrency(event.fees)} fees
                              </p>
                            ) : null}
                            {event.eventId !== "unknown" ? (
                              <Link
                                href={`/app/events/${event.eventId}/registrations`}
                                className="mt-2 inline-flex text-xs font-semibold text-[#7C2D92] hover:text-[#5B197A]"
                              >
                                View registrations
                              </Link>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Top Profitable Events
                </h3>
                <div className="mt-3 space-y-3">
                  {topProfitableEventSummaries.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                      No profitable event summaries in this range yet.
                    </p>
                  ) : (
                    topProfitableEventSummaries.map((event) => (
                      <div
                        key={`profitable-${event.eventId}`}
                        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="font-semibold text-emerald-950">
                              {event.name}
                            </p>
                            <p className="mt-1 text-xs text-emerald-900/70">
                              {fmtCurrency(event.netRevenue)} net revenue · -{fmtCurrency(event.expenses)} expenses
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold text-emerald-800">
                              {fmtCurrency(event.profitLoss)}
                            </p>
                            <p className="mt-1 text-xs text-emerald-900/70">
                              {event.marginPercent === null
                                ? "No margin yet"
                                : `${Math.round(event.marginPercent * 100)}% margin`}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Events Needing Attention
                </h3>
                <div className="mt-3 space-y-3">
                  {eventAttentionSummaries.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                      No event profitability warnings in this range.
                    </p>
                  ) : (
                    eventAttentionSummaries.map((event) => (
                      <div
                        key={`attention-${event.eventId}`}
                        className="rounded-2xl border border-amber-200 bg-amber-50 p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="font-semibold text-amber-950">
                              {event.name}
                            </p>
                            <p className="mt-1 text-xs text-amber-900/70">
                              {event.profitLoss < 0
                                ? "Negative event profit/loss"
                                : event.expenses === 0
                                  ? "No event-linked expenses recorded"
                                  : event.refunds > 0
                                    ? "Refund activity detected"
                                    : "Review fees and cost attribution"}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className={`text-sm font-semibold ${event.profitLoss >= 0 ? "text-amber-900" : "text-rose-700"}`}>
                              {fmtCurrency(event.profitLoss)}
                            </p>
                            <p className="mt-1 text-xs text-amber-900/70">
                              {fmtCurrency(event.netRevenue)} net · -{fmtCurrency(event.expenses)} expenses
                            </p>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Top Ticket Types
                </h3>
                <div className="mt-3 space-y-3">
                  {topTicketSummaries.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                      No ticket type revenue in this range.
                    </p>
                  ) : (
                    topTicketSummaries.map((ticket) => (
                      <div
                        key={ticket.key}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="font-semibold text-slate-950">
                              {ticket.name}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {labelize(ticket.kind)} ·{" "}
                              {fmtNumber(ticket.quantity)} sold
                            </p>
                          </div>
                          <p className="text-sm font-semibold text-slate-950">
                            {fmtCurrency(ticket.revenue)}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {eventLinkedExpensesTotal === 0 && eventNetRevenueTotal > 0 ? (
              <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                No event-linked expenses are recorded for this range. Add event
                costs in Expenses and select the related event to make profit/loss
                and margin more accurate.
              </div>
            ) : null}

            <div className="mt-5 rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm leading-6 text-orange-900">
              Event reporting uses the accounting ledger for revenue, refunds,
              and fees. Expenses only affect Event Profit / Loss when they are
              linked to a specific event in Expenses.
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Event & Ticket Reports"
            title="Unlock event reporting"
            description="Track ticket revenue, check-ins, no-shows, and top-performing events with Pro."
            requiredPlan="Pro"
          />
        )}
      </section>

      {hasOrganizerReportAccess ? (
        <section className="rounded-3xl border border-[#C7D2FE] bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#4F46E5]">
                Organizer Reports
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Organizer event and campaign performance
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Review organizer ticket revenue, contacts, attendance, and
                campaign activity for {rangeLabel(range).toLowerCase()}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/app/organizer-contacts"
                className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-100"
              >
                Open Contacts
              </Link>
              <Link
                href="/app/organizer-campaigns"
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Open Campaigns
              </Link>
            </div>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl bg-indigo-50 p-4">
              <p className="text-sm text-indigo-900/70">Organizer Revenue</p>
              <p className="mt-2 text-2xl font-semibold text-indigo-950">
                {fmtCurrency(organizerRevenueTotal)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Organizer Contacts</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(typedOrganizerContacts.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Checked In</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(organizerCheckedInRegistrations.length)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {organizerAttendanceRate} attendance rate
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Campaigns Sent</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(organizerCampaignsSent.length)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {fmtNumber(organizerCampaignRecipientsSent.length)} emails sent
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Top Organizer Events
              </h3>
              <div className="mt-3 space-y-3">
                {topOrganizerEventSummaries.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                    No organizer event registrations in this range.
                  </p>
                ) : (
                  topOrganizerEventSummaries.map((event) => (
                    <div
                      key={event.eventId}
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="font-semibold text-slate-950">
                            {event.eventName}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {event.organizerName} ·{" "}
                            {fmtNumber(event.paidRegistrations)} paid
                            registrations · {fmtNumber(event.checkedIn)} checked
                            in · {fmtNumber(event.noShows)} no-shows
                          </p>
                        </div>
                        <div className="text-left sm:text-right">
                          <p className="text-sm font-semibold text-slate-950">
                            {fmtCurrency(event.revenue)}
                          </p>
                          {event.eventId !== "unknown" ? (
                            <Link
                              href={`/app/events/${event.eventId}/registrations`}
                              className="mt-2 inline-flex text-xs font-semibold text-[#4F46E5] hover:text-[#3730A3]"
                            >
                              View registrations
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-950">
                  Campaign Delivery
                </p>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-lg font-semibold text-slate-950">
                      {fmtNumber(organizerCampaignRecipientsSent.length)}
                    </p>
                    <p className="text-xs text-slate-500">Sent</p>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-lg font-semibold text-slate-950">
                      {fmtNumber(organizerCampaignRecipientsFailed.length)}
                    </p>
                    <p className="text-xs text-slate-500">Failed</p>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-lg font-semibold text-slate-950">
                      {fmtNumber(organizerCampaignRecipientsSuppressed.length)}
                    </p>
                    <p className="text-xs text-slate-500">Suppressed</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-950">
                  Recent Contacts
                </p>
                <div className="mt-3 space-y-3">
                  {recentOrganizerContacts.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      No organizer contacts in this range.
                    </p>
                  ) : (
                    recentOrganizerContacts.map((contact) => (
                      <div key={contact.id} className="rounded-xl bg-white p-3">
                        <p className="text-sm font-semibold text-slate-900">
                          {organizerContactName(contact)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {fmtNumber(
                            Number(contact.total_paid_registrations ?? 0),
                          )}{" "}
                          paid registrations ·{" "}
                          {fmtCurrency(Number(contact.total_spend ?? 0))}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Recent Organizer Campaigns
            </h3>
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {recentOrganizerCampaigns.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500 md:col-span-2 xl:col-span-3">
                  No organizer campaigns in this range.
                </p>
              ) : (
                recentOrganizerCampaigns.map((campaign) => (
                  <Link
                    key={campaign.id}
                    href={`/app/organizer-campaigns/${campaign.id}`}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4 hover:bg-slate-100"
                  >
                    <p className="font-semibold text-slate-950">
                      {campaign.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {organizerNameById.get(campaign.organizer_id) ??
                        "Organizer"}{" "}
                      · {campaignStatusLabel(campaign.status)}
                    </p>
                  </Link>
                ))
              )}
            </div>
          </div>
        </section>
      ) : null}

      <section>
        {canViewProReports ? (
          <div className="rounded-3xl border border-indigo-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">
                  Accounting Export Mapping
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  Accountant-Ready CSV
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Download a mapped accounting export that groups DanceFlow
                  activity into revenue, refunds, Stripe fees, platform fees,
                  expenses, packages, memberships, events, lessons, and floor
                  rental categories.
                </p>
              </div>
              <a
                href={exportHref("/app/reports/export/accounting-map", range)}
                className="inline-flex w-fit rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-100"
              >
                Download Accounting Map CSV
              </a>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-indigo-50 p-4">
                <p className="text-sm font-medium text-indigo-900">
                  Bookkeeper Categories
                </p>
                <p className="mt-1 text-xs leading-5 text-indigo-900/70">
                  Maps each entry into cleaner accounting types like revenue,
                  refunds, processing fees, platform fees, and expenses.
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-800">
                  Source Traceability
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Keeps source table, source ID, Stripe IDs, client/event IDs,
                  status, and description attached for audit follow-up.
                </p>
              </div>
              <div className="rounded-2xl bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">
                  Import-Friendly
                </p>
                <p className="mt-1 text-xs leading-5 text-amber-900/70">
                  Built for accountant review and CSV import prep before a
                  future QuickBooks or Wave integration.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Accounting Export Mapping"
            title="Unlock accountant-ready exports"
            description="Download mapped accounting CSVs for bookkeeping, reconciliation, and accounting tool imports with Pro."
            requiredPlan="Pro"
          />
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                Recent payments
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Latest payment activity in the selected range.
              </p>
            </div>
            <Link
              href="/app/payments"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              View all
            </Link>
          </div>

          <div className="mt-6 space-y-3">
            {typedPayments.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                No payments found for this range.
              </div>
            ) : (
              typedPayments.slice(0, 8).map((payment) => (
                <div
                  key={payment.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">
                      {fmtCurrency(Number(payment.amount ?? 0))}
                    </p>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentStatusBadgeClass(
                        payment.status,
                      )}`}
                    >
                      {labelize(payment.status)}
                    </span>
                    <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700">
                      {labelize(payment.payment_method)}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-slate-700">
                    {getClientName(payment.clients)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {labelize(payment.payment_type)} •{" "}
                    {labelize(payment.source)} •{" "}
                    {paymentChannelLabel(payment.payment_channel)} •{" "}
                    {fmtDateTime(payment.created_at)}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        {canViewProReports ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                  Export data
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Download studio data for deeper analysis, bookkeeping, and
                  event reconciliation.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-3">
              <a
                href={exportHref("/app/reports/export/clients", range)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Export Clients CSV
              </a>
              <a
                href="/app/reports/client-birthdays/export?range=next30&format=labels"
                className="rounded-2xl border border-[#D8B4FE] bg-[#FCF8FF] px-4 py-4 text-sm font-medium text-[#6B21A8] hover:bg-[#F3E8FF]"
              >
                Export Birthday Mailing Labels CSV
              </a>
              <a
                href={exportHref("/app/reports/export/appointments", range)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Export Appointments CSV
              </a>
              <a
                href={exportHref("/app/reports/export/payments", range)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Export Payments CSV
              </a>
              <a
                href={exportHref("/app/reports/export/expenses", range)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Export Expenses CSV
              </a>
              <a
                href={exportHref("/app/reports/export/accounting-map", range)}
                className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-4 text-sm font-medium text-indigo-800 hover:bg-indigo-100"
              >
                Export Accountant-Ready Accounting Map CSV
              </a>
              <a
                href={exportHref(
                  "/app/reports/export/event-registrations",
                  range,
                )}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Export Event Registrations CSV
              </a>
              <a
                href={exportHref(
                  "/app/reports/export/instructor-activity",
                  range,
                )}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Export Instructor Activity CSV
              </a>
              <a
                href={exportHref("/app/reports/export/balances", range)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Export Balances CSV
              </a>
              <a
                href={exportHref("/app/reports/export/ledger", range)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Export Lesson Ledger CSV
              </a>
            </div>
          </div>
        ) : (
          <LockedReportCard
            eyebrow="Exports"
            title="Unlock report exports"
            description="Download CSV exports for bookkeeping, reconciliation, and deeper analysis with Pro."
            requiredPlan="Pro"
          />
        )}
      </section>
    </div>
  );
}
