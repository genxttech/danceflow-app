import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Brain,
  CalendarCheck,
  Clock3,
  LineChart,
  Target,
  TrendingUp,
  UserCheck,
  Users,
} from "lucide-react";
import { canViewReports } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { getCommerceIntelligence } from "@/lib/commerce/intelligence";
import CommerceIntelligenceSection from "@/components/app/commerce/CommerceIntelligenceSection";
import { loadStudioLifecycleSnapshot } from "@/lib/clients/lifecycle";

type SearchParams = Promise<{
  range?: string;
}>;

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
  created_at: string;
  referral_source: string | null;
};

type AppointmentRow = {
  id: string;
  client_id: string | null;
  instructor_id: string | null;
  appointment_type: string | null;
  status: string | null;
  starts_at: string;
};

type PackageRow = {
  id: string;
  client_id: string | null;
  created_at: string;
  purchase_date: string | null;
  sold_price: number | string | null;
  price_snapshot: number | string | null;
  name_snapshot: string | null;
  active: boolean | null;
};

type MembershipRow = {
  id: string;
  client_id: string | null;
  created_at: string;
  status: string | null;
  price_snapshot: number | string | null;
  signup_fee_snapshot: number | string | null;
  name_snapshot: string | null;
};

type InstructorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  active: boolean | null;
};

type PurchaseEvent = {
  id: string;
  clientId: string;
  type: "package" | "membership";
  date: Date;
  amount: number;
  label: string;
};

type Opportunity = {
  clientId: string;
  clientName: string;
  detail: string;
  action: string;
};

const RANGE_OPTIONS = [
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "180", label: "Last 180 days", days: 180 },
  { value: "365", label: "Last 12 months", days: 365 },
];

const INTRO_PURCHASE_WINDOW_DAYS = 30;
const RETENTION_WINDOW_DAYS = 90;
const LEAD_FOLLOW_UP_GRACE_DAYS = 3;
const INTRO_FOLLOW_UP_GRACE_DAYS = 7;
const RETENTION_FOLLOW_UP_GRACE_DAYS = 30;

function getRangeDays(range: string | undefined) {
  return RANGE_OPTIONS.find((option) => option.value === range)?.days ?? 90;
}

function getRangeLabel(range: string | undefined) {
  return (
    RANGE_OPTIONS.find((option) => option.value === range)?.label ??
    "Last 90 days"
  );
}

function toNumber(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function fmtPercent(numerator: number, denominator: number) {
  if (!denominator) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function fmtCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function fmtDays(value: number | null) {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value)}d`;
}

function daysBetween(start: Date, end: Date) {
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
}

function isDateInRange(date: Date, start: Date, end: Date) {
  return date >= start && date <= end;
}

function findPurchaseWithinWindow(
  purchases: PurchaseEvent[],
  start: Date,
  windowDays: number,
) {
  return purchases.find((purchase) => {
    const elapsed = daysBetween(start, purchase.date);
    return elapsed >= 0 && elapsed <= windowDays;
  });
}

function average(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function getClientName(client: ClientRow | undefined) {
  if (!client) return "Unknown client";
  const name = `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim();
  return name || "Unnamed client";
}

function getInstructorName(instructor: InstructorRow | undefined) {
  if (!instructor) return "Unassigned";
  const name =
    `${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim();
  return name || "Unnamed instructor";
}

function isIntroAppointment(appointment: AppointmentRow) {
  const value = `${appointment.appointment_type ?? ""}`.toLowerCase();
  return value.includes("intro") || value.includes("consult");
}

function isCanceledStatus(status: string | null) {
  const value = `${status ?? ""}`.toLowerCase();
  return (
    value.includes("cancel") ||
    value.includes("declin") ||
    value.includes("no_show") ||
    value.includes("no-show")
  );
}

function isCompletedStatus(status: string | null) {
  const value = `${status ?? ""}`.toLowerCase();
  return (
    value.includes("complete") ||
    value.includes("attend") ||
    value.includes("done") ||
    value.includes("closed")
  );
}

function statusPillClass(value: string) {
  if (value === "strong") return "bg-emerald-50 text-emerald-700";
  if (value === "watch") return "bg-amber-50 text-amber-700";
  if (value === "risk") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-700";
}

function StatCard({
  label,
  value,
  helper,
  icon: Icon,
}: {
  label: string;
  value: string;
  helper: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
          <p className="mt-2 text-sm text-slate-500">{helper}</p>
        </div>
        <div className="rounded-lg bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
      {message}
    </div>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const range = params.range ?? "90";
  const rangeDays = getRangeDays(range);
  const rangeLabel = getRangeLabel(range);
  const rangeStart = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);
  const rangeStartIso = rangeStart.toISOString();
  const now = new Date();

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;
  if (!studioId) {
    redirect("/app");
  }

  const [
    { data: clients, error: clientsError },
    { data: appointments, error: appointmentsError },
    { data: packages, error: packagesError },
    { data: memberships, error: membershipsError },
    { data: instructors, error: instructorsError },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, first_name, last_name, status, created_at, referral_source")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(3000),
    supabase
      .from("appointments")
      .select(
        "id, client_id, instructor_id, appointment_type, status, starts_at",
      )
      .eq("studio_id", studioId)
      .gte("starts_at", rangeStartIso)
      .lte("starts_at", now.toISOString())
      .order("starts_at", { ascending: false })
      .limit(1500),
    supabase
      .from("client_packages")
      .select(
        "id, client_id, created_at, purchase_date, sold_price, price_snapshot, name_snapshot, active",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: true })
      .limit(2000),
    supabase
      .from("client_memberships")
      .select(
        "id, client_id, created_at, status, price_snapshot, signup_fee_snapshot, name_snapshot",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: true })
      .limit(2000),
    supabase
      .from("instructors")
      .select("id, first_name, last_name, active")
      .eq("studio_id", studioId)
      .order("first_name", { ascending: true })
      .limit(500),
  ]);

  if (clientsError)
    throw new Error(
      `Failed to load analytics clients: ${clientsError.message}`,
    );
  if (appointmentsError)
    throw new Error(
      `Failed to load analytics appointments: ${appointmentsError.message}`,
    );
  if (packagesError)
    throw new Error(
      `Failed to load analytics packages: ${packagesError.message}`,
    );
  if (membershipsError)
    throw new Error(
      `Failed to load analytics memberships: ${membershipsError.message}`,
    );
  if (instructorsError)
    throw new Error(
      `Failed to load analytics instructors: ${instructorsError.message}`,
    );

  const typedClients = (clients ?? []) as ClientRow[];
  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedPackages = (packages ?? []) as PackageRow[];
  const typedMemberships = (memberships ?? []) as MembershipRow[];
  const typedInstructors = (instructors ?? []) as InstructorRow[];

  const clientById = new Map(typedClients.map((client) => [client.id, client]));

  const leadCohort = typedClients.filter((client) =>
    isDateInRange(new Date(client.created_at), rangeStart, now),
  );

  const introAppointments = typedAppointments.filter(
    (appointment) =>
      appointment.client_id &&
      isIntroAppointment(appointment) &&
      !isCanceledStatus(appointment.status),
  );
  const completedIntroAppointments = introAppointments.filter((appointment) =>
    isCompletedStatus(appointment.status),
  );

  const purchases: PurchaseEvent[] = [
    ...typedPackages
      .filter((pkg) => pkg.client_id)
      .map((pkg) => ({
        id: pkg.id,
        clientId: pkg.client_id as string,
        type: "package" as const,
        date: new Date(pkg.purchase_date ?? pkg.created_at),
        amount: toNumber(pkg.sold_price ?? pkg.price_snapshot),
        label: pkg.name_snapshot ?? "Package",
      })),
    ...typedMemberships
      .filter((membership) => membership.client_id)
      .map((membership) => ({
        id: membership.id,
        clientId: membership.client_id as string,
        type: "membership" as const,
        date: new Date(membership.created_at),
        amount:
          toNumber(membership.price_snapshot) +
          toNumber(membership.signup_fee_snapshot),
        label: membership.name_snapshot ?? "Membership",
      })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  const purchasesByClient = new Map<string, PurchaseEvent[]>();
  purchases.forEach((purchase) => {
    const existing = purchasesByClient.get(purchase.clientId) ?? [];
    existing.push(purchase);
    purchasesByClient.set(purchase.clientId, existing);
  });

  const introByClient = new Map<string, AppointmentRow[]>();
  introAppointments.forEach((appointment) => {
    if (!appointment.client_id) return;
    const existing = introByClient.get(appointment.client_id) ?? [];
    existing.push(appointment);
    introByClient.set(appointment.client_id, existing);
  });
  introByClient.forEach((items) =>
    items.sort(
      (a, b) =>
        new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
    ),
  );

  const leadCount = leadCohort.length;
  const leadToIntroClientIds = leadCohort
    .filter((client) => {
      const createdAt = new Date(client.created_at);
      return (introByClient.get(client.id) ?? []).some(
        (intro) => new Date(intro.starts_at) >= createdAt,
      );
    })
    .map((client) => client.id);
  const completedIntroCohort = completedIntroAppointments
    .filter((intro) =>
      isDateInRange(new Date(intro.starts_at), rangeStart, now),
    )
    .sort(
      (a, b) =>
        new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
    );
  const firstCompletedIntroByClient = new Map<string, AppointmentRow>();
  completedIntroCohort.forEach((intro) => {
    if (!intro.client_id || firstCompletedIntroByClient.has(intro.client_id)) {
      return;
    }
    firstCompletedIntroByClient.set(intro.client_id, intro);
  });
  const completedIntroClientIds = Array.from(
    firstCompletedIntroByClient.keys(),
  );

  const introToFirstPurchaseClientIds = completedIntroClientIds.filter(
    (clientId) => {
      const firstIntro = firstCompletedIntroByClient.get(clientId);
      if (!firstIntro) return false;
      const introDate = new Date(firstIntro.starts_at);
      return Boolean(
        findPurchaseWithinWindow(
          (purchasesByClient.get(clientId) ?? []).slice(0, 1),
          introDate,
          INTRO_PURCHASE_WINDOW_DAYS,
        ),
      );
    },
  );

  const firstPurchaseClientIds = Array.from(purchasesByClient.entries())
    .filter(([, clientPurchases]) => {
      const firstPurchase = clientPurchases[0];
      return Boolean(
        firstPurchase &&
          isDateInRange(firstPurchase.date, rangeStart, now),
      );
    })
    .map(([clientId]) => clientId);

  const retentionClientIds = firstPurchaseClientIds.filter((clientId) => {
    const clientPurchases = purchasesByClient.get(clientId) ?? [];
    const firstPurchase = clientPurchases[0];
    if (!firstPurchase) return false;
    return Boolean(
      findPurchaseWithinWindow(
        clientPurchases.slice(1),
        firstPurchase.date,
        RETENTION_WINDOW_DAYS,
      ),
    );
  });

  const leadToIntroDays = leadToIntroClientIds
    .map((clientId) => {
      const client = clientById.get(clientId);
      const intro = introByClient.get(clientId)?.[0];
      if (!client || !intro) return null;
      return daysBetween(
        new Date(client.created_at),
        new Date(intro.starts_at),
      );
    })
    .filter((value): value is number => value !== null);

  const introToPurchaseDays = introToFirstPurchaseClientIds
    .map((clientId) => {
      const intro = firstCompletedIntroByClient.get(clientId);
      if (!intro) return null;
      const introDate = new Date(intro.starts_at);
      const purchase = findPurchaseWithinWindow(
        (purchasesByClient.get(clientId) ?? []).slice(0, 1),
        introDate,
        INTRO_PURCHASE_WINDOW_DAYS,
      );
      if (!purchase) return null;
      return daysBetween(introDate, purchase.date);
    })
    .filter((value): value is number => value !== null);

  const firstToRetentionDays = retentionClientIds
    .map((clientId) => {
      const clientPurchases = purchasesByClient.get(clientId) ?? [];
      const firstPurchase = clientPurchases[0];
      if (!firstPurchase) return null;
      const retentionPurchase = findPurchaseWithinWindow(
        clientPurchases.slice(1),
        firstPurchase.date,
        RETENTION_WINDOW_DAYS,
      );
      if (!retentionPurchase) return null;
      return daysBetween(firstPurchase.date, retentionPurchase.date);
    })
    .filter((value): value is number => value !== null);

  const convertedRevenue = introToFirstPurchaseClientIds.reduce(
    (sum, clientId) => {
      const firstIntro = firstCompletedIntroByClient.get(clientId);
      if (!firstIntro) return sum;
      const introDate = new Date(firstIntro.starts_at);
      const firstPurchase = findPurchaseWithinWindow(
        (purchasesByClient.get(clientId) ?? []).slice(0, 1),
        introDate,
        INTRO_PURCHASE_WINDOW_DAYS,
      );
      return sum + (firstPurchase?.amount ?? 0);
    },
    0,
  );

  const instructorStats = typedInstructors
    .map((instructor) => {
      const intros = Array.from(firstCompletedIntroByClient.values()).filter(
        (appointment) => appointment.instructor_id === instructor.id,
      );
      const uniqueClientIds = Array.from(
        new Set(
          intros.map((appointment) => appointment.client_id).filter(Boolean),
        ),
      ) as string[];
      const convertedClientIds = uniqueClientIds.filter((clientId) =>
        introToFirstPurchaseClientIds.includes(clientId),
      );
      const retainedClientIds = uniqueClientIds.filter((clientId) =>
        retentionClientIds.includes(clientId),
      );
      const influencedRevenue = convertedClientIds.reduce((sum, clientId) => {
        const firstIntro = firstCompletedIntroByClient.get(clientId);
        if (!firstIntro) return sum;
        const introDate = new Date(firstIntro.starts_at);
        const firstPurchase = findPurchaseWithinWindow(
          (purchasesByClient.get(clientId) ?? []).slice(0, 1),
          introDate,
          INTRO_PURCHASE_WINDOW_DAYS,
        );
        return sum + (firstPurchase?.amount ?? 0);
      }, 0);

      return {
        instructor,
        intros: intros.length,
        clients: uniqueClientIds.length,
        converted: convertedClientIds.length,
        retained: retainedClientIds.length,
        influencedRevenue,
      };
    })
    .filter(
      (stat) => stat.intros > 0 || stat.converted > 0 || stat.retained > 0,
    )
    .sort((a, b) => b.converted - a.converted || b.intros - a.intros)
    .slice(0, 10);

  const lostLeadOpportunities: Opportunity[] = leadCohort
    .filter((client) => {
      const age = daysBetween(new Date(client.created_at), now);
      return (
        age >= LEAD_FOLLOW_UP_GRACE_DAYS &&
        !leadToIntroClientIds.includes(client.id)
      );
    })
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )
    .map((client) => ({
      clientId: client.id,
      clientName: getClientName(client),
      detail: client.referral_source
        ? `Source: ${client.referral_source}`
        : "No intro booked yet",
      action: "Book intro",
    }));
  const lostLeads = lostLeadOpportunities.slice(0, 6);

  const introNoPurchaseOpportunities: Opportunity[] = completedIntroClientIds
    .filter((clientId) => {
      const intro = firstCompletedIntroByClient.get(clientId);
      return Boolean(
        intro &&
          daysBetween(new Date(intro.starts_at), now) >=
            INTRO_FOLLOW_UP_GRACE_DAYS &&
          !introToFirstPurchaseClientIds.includes(clientId),
      );
    })
    .sort((a, b) => {
      const aDate = firstCompletedIntroByClient.get(a)?.starts_at ?? "";
      const bDate = firstCompletedIntroByClient.get(b)?.starts_at ?? "";
      return new Date(aDate).getTime() - new Date(bDate).getTime();
    })
    .map((clientId) => {
      const client = clientById.get(clientId);
      const intro = firstCompletedIntroByClient.get(clientId);
      const daysAgo = intro
        ? Math.max(0, Math.round(daysBetween(new Date(intro.starts_at), now)))
        : 0;
      return {
        clientId,
        clientName: getClientName(client),
        detail: intro
          ? `Intro completed ${daysAgo} days ago`
          : "Intro completed",
        action: "Follow up",
      };
    });
  const introsNoPurchase = introNoPurchaseOpportunities.slice(0, 6);

  const firstPurchaseNoRetentionOpportunities: Opportunity[] =
    firstPurchaseClientIds
    .filter((clientId) => {
      const firstPurchase = purchasesByClient.get(clientId)?.[0];
      return Boolean(
        firstPurchase &&
          daysBetween(firstPurchase.date, now) >=
            RETENTION_FOLLOW_UP_GRACE_DAYS &&
          !retentionClientIds.includes(clientId),
      );
    })
    .sort((a, b) => {
      const aDate = purchasesByClient.get(a)?.[0]?.date.getTime() ?? 0;
      const bDate = purchasesByClient.get(b)?.[0]?.date.getTime() ?? 0;
      return aDate - bDate;
    })
    .map((clientId) => {
      const client = clientById.get(clientId);
      const firstPurchase = purchasesByClient.get(clientId)?.[0];
      const daysAgo = firstPurchase
        ? Math.max(0, Math.round(daysBetween(firstPurchase.date, now)))
        : 0;
      return {
        clientId,
        clientName: getClientName(client),
        detail: firstPurchase
          ? `${firstPurchase.label} purchased ${daysAgo} days ago`
          : "First purchase only",
        action: "Retain",
      };
    });
  const firstPurchaseNoRetention =
    firstPurchaseNoRetentionOpportunities.slice(0, 6);

  const sourceStats = Array.from(
    leadCohort
      .reduce((map, client) => {
        const key = client.referral_source?.trim() || "Unknown / not set";
        const current = map.get(key) ?? {
          source: key,
          leads: 0,
          intros: 0,
          buyers: 0,
        };
        current.leads += 1;
        if (leadToIntroClientIds.includes(client.id)) current.intros += 1;
        if (introToFirstPurchaseClientIds.includes(client.id)) {
          current.buyers += 1;
        }
        map.set(key, current);
        return map;
      }, new Map<string, { source: string; leads: number; intros: number; buyers: number }>())
      .values(),
  )
    .sort((a, b) => b.buyers - a.buyers || b.leads - a.leads)
    .slice(0, 8);

  const conversionHealth =
    introToFirstPurchaseClientIds.length /
    Math.max(completedIntroClientIds.length, 1);
  const retentionHealth =
    retentionClientIds.length / Math.max(firstPurchaseClientIds.length, 1);

  const ariaInsights = [
    {
      label: "Conversion focus",
      status:
        completedIntroClientIds.length === 0
          ? "neutral"
          : introNoPurchaseOpportunities.length === 0 &&
              introToFirstPurchaseClientIds.length === 0
            ? "neutral"
          : conversionHealth >= 0.5
            ? "strong"
            : conversionHealth >= 0.3
              ? "watch"
              : "risk",
      text:
        completedIntroClientIds.length === 0
          ? "No completed intros are in this range yet. Start by driving intro bookings and completion."
          : introNoPurchaseOpportunities.length === 0
            ? "No completed intro follow-ups are currently overdue."
          : `${introNoPurchaseOpportunities.length} completed intro${introNoPurchaseOpportunities.length === 1 ? "" : "s"} still need a first-purchase follow-up.`,
    },
    {
      label: "Retention focus",
      status:
        firstPurchaseClientIds.length === 0
          ? "neutral"
          : firstPurchaseNoRetentionOpportunities.length === 0 &&
              retentionClientIds.length === 0
            ? "neutral"
          : retentionHealth >= 0.5
            ? "strong"
            : retentionHealth >= 0.3
              ? "watch"
              : "risk",
      text:
        firstPurchaseNoRetentionOpportunities.length === 0
          ? "No first-purchase retention gaps are visible in this range."
          : `${firstPurchaseNoRetentionOpportunities.length} first-purchase client${firstPurchaseNoRetentionOpportunities.length === 1 ? "" : "s"} should be checked before they go cold.`,
    },
    {
      label: "Lead flow",
      status:
        leadCount === 0
          ? "neutral"
          : lostLeadOpportunities.length === 0 &&
              leadToIntroClientIds.length === 0
            ? "neutral"
          : leadToIntroClientIds.length / leadCount >= 0.6
            ? "strong"
            : "watch",
      text:
        lostLeadOpportunities.length === 0
          ? leadToIntroClientIds.length > 0
            ? "New leads in this range have intro activity. Keep the follow-up cadence consistent."
            : "No lead follow-ups are overdue in this range."
          : `${lostLeadOpportunities.length} new lead${lostLeadOpportunities.length === 1 ? "" : "s"} in this range do not have intro activity yet.`,
    },
  ];

  const lifecycleSnapshot = await loadStudioLifecycleSnapshot({
    supabase,
    studioId,
  });

  const commerceIntelligence = await getCommerceIntelligence({
    supabase,
    studioId,
    rangeStart: rangeStartIso,
  });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-slate-950 shadow-sm">
        <div className="p-6 text-white sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white/80">
                <LineChart className="h-3.5 w-3.5" />
                Studio Analytics
              </div>
              <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Conversion Dashboard
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/75 sm:text-base">
                Track how leads move into intros, first purchases, and retention
                purchases. Accounting reports show what happened financially;
                analytics shows where the studio is gaining or losing momentum.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {RANGE_OPTIONS.map((option) => {
                const active = option.value === range;
                return (
                  <Link
                    key={option.value}
                    href={`/app/analytics?range=${option.value}`}
                    className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                      active
                        ? "bg-white text-slate-950"
                        : "bg-white/10 text-white hover:bg-white/20"
                    }`}
                  >
                    {option.label.replace("Last ", "")}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        <span className="font-semibold text-slate-900">How rates work:</span>{" "}
        the lead stage begins when a client record is created. Leads and
        completed intros are grouped by the selected date range. First purchase
        must happen within {INTRO_PURCHASE_WINDOW_DAYS} days of the completed
        intro. Retention means a second package or membership purchase within{" "}
        {RETENTION_WINDOW_DAYS} days of the first purchase.
      </section>

      <section className="rounded-lg border border-violet-200 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_70%,#ffffff_100%)] p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
              Client lifecycle
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Current studio journey health
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              These counts use the same derived lifecycle model shown in Clients, Leads, Today, and ARIA.
            </p>
          </div>
          <Link
            href="/app/clients"
            className="inline-flex items-center gap-2 text-sm font-semibold text-violet-800 hover:underline"
          >
            Review client journeys
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ["New leads", lifecycleSnapshot.counts.new_lead + lifecycleSnapshot.counts.contacted],
            ["Intro scheduled", lifecycleSnapshot.counts.intro_scheduled],
            ["Conversion pending", lifecycleSnapshot.counts.conversion_pending],
            ["Needs rebooking", lifecycleSnapshot.counts.needs_rebooking],
            ["Retention risk", lifecycleSnapshot.counts.retention_risk],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border border-white bg-white/85 p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {label}
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {value}
              </p>
            </div>
          ))}
        </div>
      </section>

      <CommerceIntelligenceSection
        data={commerceIntelligence}
        title={`Commerce performance · ${rangeLabel}`}
      />

      <section className="grid gap-4 lg:grid-cols-3">
        <Link
          href={`/app/analytics/dance-goals?range=${range}`}
          className="group rounded-lg border border-[#E9D5FF] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#C084FC] hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                New analytics
              </p>
              <h2 className="mt-2 text-lg font-semibold text-slate-950">
                Dance Goal Analytics
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Compare conversion, retention, lifetime spend, and lesson activity
                by the goals clients select at intake.
              </p>
            </div>
            <div className="rounded-lg bg-[#F3E8FF] p-3 text-[#6B21A8]">
              <Target className="h-5 w-5" />
            </div>
          </div>
          <span className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-[#6B21A8]">
            Open goal analytics
            <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </span>
        </Link>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Lead → Intro"
          value={fmtPercent(leadToIntroClientIds.length, leadCount)}
          helper={`${leadToIntroClientIds.length} of ${leadCount} new leads booked or completed intro activity`}
          icon={Target}
        />
        <StatCard
          label="Intro → First Purchase"
          value={fmtPercent(
            introToFirstPurchaseClientIds.length,
            completedIntroClientIds.length,
          )}
          helper={`${introToFirstPurchaseClientIds.length} of ${completedIntroClientIds.length} completed intro clients purchased within ${INTRO_PURCHASE_WINDOW_DAYS} days`}
          icon={UserCheck}
        />
        <StatCard
          label="First Purchase → Retention"
          value={fmtPercent(
            retentionClientIds.length,
            firstPurchaseClientIds.length,
          )}
          helper={`${retentionClientIds.length} of ${firstPurchaseClientIds.length} first-purchase clients bought again within ${RETENTION_WINDOW_DAYS} days`}
          icon={TrendingUp}
        />
        <StatCard
          label="Converted First-Purchase Revenue"
          value={fmtCurrency(convertedRevenue)}
          helper={`First purchase value after completed intros in ${rangeLabel.toLowerCase()}`}
          icon={BarChart3}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-slate-950">
            Avg. lead to intro
          </p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {fmtDays(average(leadToIntroDays))}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Average time from new lead/client creation to intro activity.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-slate-950">
            Avg. intro to purchase
          </p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {fmtDays(average(introToPurchaseDays))}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Average time from completed intro to first package or membership.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-slate-950">
            Avg. first to retention purchase
          </p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {fmtDays(average(firstToRetentionDays))}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Average time from first purchase to the next package or membership.
          </p>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  Instructor Conversion
                </h2>
                <p className="text-sm text-slate-500">
                  Intro conversion, first-purchase revenue, and retention by
                  instructor.
                </p>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto p-5">
            {instructorStats.length ? (
              <table className="min-w-full divide-y divide-slate-100 text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-3">Instructor</th>
                    <th className="px-3 py-3 text-right">Intros</th>
                    <th className="px-3 py-3 text-right">Converted</th>
                    <th className="px-3 py-3 text-right">Conv. %</th>
                    <th className="px-3 py-3 text-right">Retained</th>
                    <th className="px-3 py-3 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {instructorStats.map((stat) => (
                    <tr key={stat.instructor.id} className="text-slate-700">
                      <td className="px-3 py-4 font-medium text-slate-950">
                        {getInstructorName(stat.instructor)}
                      </td>
                      <td className="px-3 py-4 text-right">{stat.intros}</td>
                      <td className="px-3 py-4 text-right">{stat.converted}</td>
                      <td className="px-3 py-4 text-right">
                        {fmtPercent(stat.converted, stat.clients)}
                      </td>
                      <td className="px-3 py-4 text-right">{stat.retained}</td>
                      <td className="px-3 py-4 text-right">
                        {fmtCurrency(stat.influencedRevenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState message="No completed intro activity by instructor appears in this range yet." />
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <div className="rounded-lg bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Brain className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-950">
                ARIA Focus
              </h2>
              <p className="text-sm text-slate-500">
                Early conversion guidance.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            {ariaInsights.map((insight) => (
              <div
                key={insight.label}
                className="rounded-lg border border-slate-100 bg-slate-50 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-950">
                    {insight.label}
                  </p>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusPillClass(insight.status)}`}
                  >
                    {insight.status === "strong"
                      ? "Strong"
                      : insight.status === "risk"
                        ? "Needs action"
                        : insight.status === "neutral"
                          ? "Not enough data"
                          : "Watch"}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {insight.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
            <h2 className="text-lg font-semibold text-slate-950">
              Leads without intro
            </h2>
          </div>
          <OpportunityList
            items={lostLeads}
            empty="No new leads without intro activity in this range."
          />
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <CalendarCheck className="h-5 w-5 text-rose-600" />
            <h2 className="text-lg font-semibold text-slate-950">
              Intros without purchase
            </h2>
          </div>
          <OpportunityList
            items={introsNoPurchase}
            empty="No completed intro clients are missing a first purchase in this range."
          />
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <Clock3 className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-slate-950">
              First purchase without retention
            </h2>
          </div>
          <OpportunityList
            items={firstPurchaseNoRetention}
            empty="No first-purchase retention gaps are visible in this range."
          />
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-950">
                Lead Source Performance
              </h2>
              <p className="text-sm text-slate-500">
                Shows which sources create buyers, not just leads.
              </p>
            </div>
          </div>
        </div>
        <div className="overflow-x-auto p-5">
          {sourceStats.length ? (
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-3">Source</th>
                  <th className="px-3 py-3 text-right">Leads</th>
                  <th className="px-3 py-3 text-right">Intro %</th>
                  <th className="px-3 py-3 text-right">Buyer %</th>
                  <th className="px-3 py-3 text-right">Buyers</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sourceStats.map((source) => (
                  <tr key={source.source} className="text-slate-700">
                    <td className="px-3 py-4 font-medium text-slate-950">
                      {source.source}
                    </td>
                    <td className="px-3 py-4 text-right">{source.leads}</td>
                    <td className="px-3 py-4 text-right">
                      {fmtPercent(source.intros, source.leads)}
                    </td>
                    <td className="px-3 py-4 text-right">
                      {fmtPercent(source.buyers, source.leads)}
                    </td>
                    <td className="px-3 py-4 text-right">{source.buyers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState message="No lead source data appears in this range yet." />
          )}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-slate-50 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              What comes next
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              V1 uses existing client, appointment, package, and membership
              data. The next patch can add deeper cohort windows, configurable
              conversion periods, and ARIA follow-up actions.
            </p>
          </div>
          <Link
            href="/app/reports"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-100"
          >
            Financial Reports
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}

function OpportunityList({
  items,
  empty,
}: {
  items: Opportunity[];
  empty: string;
}) {
  if (!items.length) return <EmptyState message={empty} />;

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div
          key={`${item.clientId}-${item.action}`}
          className="rounded-lg border border-slate-100 bg-slate-50 p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-950">
                {item.clientName}
              </p>
              <p className="mt-1 text-xs text-slate-500">{item.detail}</p>
            </div>
            <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm">
              {item.action}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
