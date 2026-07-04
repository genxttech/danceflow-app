import { createClient } from "@/lib/supabase/server";

export type DanceGoalRangeValue = "30" | "90" | "180" | "365" | "all";

export type DanceGoalInsightTone = "neutral" | "strong" | "watch" | "risk";

export type DanceGoalAriaRecommendation = {
  title: string;
  insight: string;
  recommendation: string;
  metric: string;
  tone: DanceGoalInsightTone;
};

export type DanceGoalStats = {
  goal: string;
  totalClients: number;
  leads: number;
  converted: number;
  active: number;
  retained: number;
  totalSpend: number;
  purchases: number;
  completedLessons: number;
  avgDaysToFirstPurchase: number | null;
};

export type DanceGoalIntelligence = {
  range: {
    value: DanceGoalRangeValue;
    label: string;
    days: number | null;
  };
  goalStats: DanceGoalStats[];
  totals: {
    goalSelections: number;
    convertedSelections: number;
    retainedSelections: number;
    totalSpend: number;
  };
  leaders: {
    bestConversion: DanceGoalStats | null;
    highestRevenue: DanceGoalStats | null;
    retentionLeader: DanceGoalStats | null;
    highInterestLowConversion: DanceGoalStats | null;
  };
  recommendations: DanceGoalAriaRecommendation[];
};

type ClientRow = {
  id: string;
  status: string | null;
  created_at: string;
  dance_goals: string[] | null;
};

type AppointmentRow = {
  id: string;
  client_id: string | null;
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
};

type MembershipRow = {
  id: string;
  client_id: string | null;
  created_at: string;
  status: string | null;
  price_snapshot: number | string | null;
  signup_fee_snapshot: number | string | null;
};

type PurchaseEvent = {
  clientId: string;
  date: Date;
  amount: number;
};

const RANGE_OPTIONS: DanceGoalIntelligence["range"][] = [
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "180", label: "Last 180 days", days: 180 },
  { value: "365", label: "Last 12 months", days: 365 },
  { value: "all", label: "All time", days: null },
];

const ACTIVE_STATUSES = new Set(["active", "client", "student", "member"]);
const LEAD_STATUSES = new Set(["lead", "prospect", "new"]);
const RETENTION_WINDOW_DAYS = 90;

export function getDanceGoalRange(range: string | undefined) {
  return RANGE_OPTIONS.find((option) => option.value === range) ?? RANGE_OPTIONS[1];
}

export function formatDanceGoalCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatDanceGoalPercent(numerator: number, denominator: number) {
  if (!denominator) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

export function formatDanceGoalDays(value: number | null) {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value)}d`;
}

function toNumber(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function daysBetween(start: Date, end: Date) {
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
}

function isDateInRange(date: Date, rangeStart: Date | null, now: Date) {
  if (date > now) return false;
  return rangeStart ? date >= rangeStart : true;
}

function normalizeStatus(status: string | null) {
  return `${status ?? ""}`.trim().toLowerCase();
}

function isActiveClient(client: ClientRow) {
  return ACTIVE_STATUSES.has(normalizeStatus(client.status));
}

function isLead(client: ClientRow) {
  return LEAD_STATUSES.has(normalizeStatus(client.status));
}

function isCompletedAppointment(appointment: AppointmentRow) {
  const value = `${appointment.status ?? ""}`.toLowerCase();
  return (
    value.includes("complete") ||
    value.includes("attend") ||
    value.includes("done") ||
    value.includes("closed")
  );
}

function getClientGoals(client: ClientRow) {
  const goals = Array.isArray(client.dance_goals)
    ? client.dance_goals.map((goal) => goal.trim()).filter(Boolean)
    : [];

  return goals.length ? Array.from(new Set(goals)) : ["No goal selected"];
}

function average(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function firstPurchaseAfterClientCreated(client: ClientRow, purchases: PurchaseEvent[]) {
  const createdAt = new Date(client.created_at);
  return purchases.find((purchase) => purchase.date >= createdAt) ?? null;
}

function buildRecommendations(params: {
  goalStats: DanceGoalStats[];
  leaders: DanceGoalIntelligence["leaders"];
  totals: DanceGoalIntelligence["totals"];
}): DanceGoalAriaRecommendation[] {
  const { goalStats, leaders, totals } = params;

  if (!goalStats.length) {
    return [
      {
        title: "ARIA needs more dance-goal data.",
        insight:
          "Client intake does not have enough Dance Goal selections yet for reliable goal-based recommendations.",
        recommendation:
          "Use preset Dance Goals on new client intake for every lead so ARIA can compare conversion, retention, and lifetime spend by motivation.",
        metric: "No goal data",
        tone: "neutral",
      },
    ];
  }

  const recommendations: DanceGoalAriaRecommendation[] = [];
  const { bestConversion, highestRevenue, retentionLeader, highInterestLowConversion } =
    leaders;

  if (bestConversion) {
    recommendations.push({
      title: `${bestConversion.goal} is your strongest conversion signal.`,
      insight: `${formatDanceGoalPercent(
        bestConversion.converted,
        bestConversion.totalClients,
      )} of clients with this goal have purchased a package or membership.`,
      recommendation:
        "Use this goal's language in consult scripts, website copy, and first-lesson close prompts because it is already translating into buyer intent.",
      metric: `${bestConversion.converted}/${bestConversion.totalClients} converted`,
      tone: "strong",
    });
  }

  if (highestRevenue && highestRevenue.totalSpend > 0) {
    recommendations.push({
      title: `${highestRevenue.goal} is driving the most lifetime spend.`,
      insight: `${highestRevenue.goal} is tied to ${formatDanceGoalCurrency(
        highestRevenue.totalSpend,
      )} in package and membership value.`,
      recommendation:
        "Review which packages, instructors, and follow-up paths are attached to this goal, then turn the strongest path into a repeatable studio playbook.",
      metric: formatDanceGoalCurrency(highestRevenue.totalSpend),
      tone: "strong",
    });
  }

  if (retentionLeader && retentionLeader.retained > 0) {
    recommendations.push({
      title: `${retentionLeader.goal} is producing repeat buyers.`,
      insight: `${formatDanceGoalPercent(
        retentionLeader.retained,
        retentionLeader.converted,
      )} of converted clients with this goal bought again within ${RETENTION_WINDOW_DAYS} days.`,
      recommendation:
        "Use this goal to design retention campaigns, progress check-ins, and package renewal prompts because students with this motivation are staying engaged.",
      metric: `${retentionLeader.retained} retained`,
      tone: "strong",
    });
  }

  if (highInterestLowConversion) {
    const conversionRate =
      highInterestLowConversion.converted /
      Math.max(highInterestLowConversion.totalClients, 1);

    if (highInterestLowConversion.totalClients >= 2 && conversionRate < 0.35) {
      recommendations.push({
        title: `${highInterestLowConversion.goal} has interest but needs a better close.`,
        insight: `${highInterestLowConversion.totalClients} clients selected this goal, but only ${formatDanceGoalPercent(
          highInterestLowConversion.converted,
          highInterestLowConversion.totalClients,
        )} have converted.`,
        recommendation:
          "Audit the offer, first-lesson script, and follow-up sequence for this goal. The demand is visible, but the current path is not turning enough people into buyers.",
        metric: `${formatDanceGoalPercent(
          highInterestLowConversion.converted,
          highInterestLowConversion.totalClients,
        )} conversion`,
        tone: "risk",
      });
    }
  }

  if (totals.convertedSelections > 0 && totals.retainedSelections === 0) {
    recommendations.push({
      title: "ARIA sees conversion without retention yet.",
      insight:
        "Dance Goals are producing first purchases, but there are not repeat purchases inside the retention window.",
      recommendation:
        "Add a post-purchase follow-up tied to each goal, such as a showcase path, wedding countdown plan, practice schedule, or social dance milestone.",
      metric: "0 retained",
      tone: "watch",
    });
  }

  return recommendations.slice(0, 4);
}

export async function getDanceGoalIntelligence(params: {
  studioId: string;
  range?: string;
}): Promise<DanceGoalIntelligence> {
  const range = getDanceGoalRange(params.range);
  const now = new Date();
  const rangeStart = range.days
    ? new Date(Date.now() - range.days * 24 * 60 * 60 * 1000)
    : null;
  const supabase = await createClient();

  const [
    { data: clients, error: clientsError },
    { data: appointments, error: appointmentsError },
    { data: packages, error: packagesError },
    { data: memberships, error: membershipsError },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, status, created_at, dance_goals")
      .eq("studio_id", params.studioId)
      .order("created_at", { ascending: false })
      .limit(5000),
    supabase
      .from("appointments")
      .select("id, client_id, status, starts_at")
      .eq("studio_id", params.studioId)
      .order("starts_at", { ascending: false })
      .limit(5000),
    supabase
      .from("client_packages")
      .select("id, client_id, created_at, purchase_date, sold_price, price_snapshot")
      .eq("studio_id", params.studioId)
      .order("created_at", { ascending: true })
      .limit(5000),
    supabase
      .from("client_memberships")
      .select("id, client_id, created_at, status, price_snapshot, signup_fee_snapshot")
      .eq("studio_id", params.studioId)
      .order("created_at", { ascending: true })
      .limit(5000),
  ]);

  if (clientsError) {
    throw new Error(`Failed to load ARIA dance goal clients: ${clientsError.message}`);
  }
  if (appointmentsError) {
    throw new Error(
      `Failed to load ARIA dance goal appointments: ${appointmentsError.message}`,
    );
  }
  if (packagesError) {
    throw new Error(`Failed to load ARIA dance goal packages: ${packagesError.message}`);
  }
  if (membershipsError) {
    throw new Error(
      `Failed to load ARIA dance goal memberships: ${membershipsError.message}`,
    );
  }

  const typedClients = (clients ?? []) as ClientRow[];
  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedPackages = (packages ?? []) as PackageRow[];
  const typedMemberships = (memberships ?? []) as MembershipRow[];
  const rangeClients = typedClients.filter((client) =>
    isDateInRange(new Date(client.created_at), rangeStart, now),
  );

  const purchases: PurchaseEvent[] = [
    ...typedPackages
      .filter((pkg) => pkg.client_id)
      .map((pkg) => ({
        clientId: pkg.client_id as string,
        date: new Date(pkg.purchase_date ?? pkg.created_at),
        amount: toNumber(pkg.sold_price ?? pkg.price_snapshot),
      })),
    ...typedMemberships
      .filter((membership) => membership.client_id)
      .map((membership) => ({
        clientId: membership.client_id as string,
        date: new Date(membership.created_at),
        amount:
          toNumber(membership.price_snapshot) +
          toNumber(membership.signup_fee_snapshot),
      })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  const purchasesByClient = new Map<string, PurchaseEvent[]>();
  purchases.forEach((purchase) => {
    const existing = purchasesByClient.get(purchase.clientId) ?? [];
    existing.push(purchase);
    purchasesByClient.set(purchase.clientId, existing);
  });

  const completedLessonsByClient = new Map<string, number>();
  typedAppointments
    .filter((appointment) => appointment.client_id && isCompletedAppointment(appointment))
    .forEach((appointment) => {
      const clientId = appointment.client_id as string;
      completedLessonsByClient.set(
        clientId,
        (completedLessonsByClient.get(clientId) ?? 0) + 1,
      );
    });

  const statsByGoal = new Map<string, DanceGoalStats & { _days?: number[] }>();

  rangeClients.forEach((client) => {
    const clientPurchases = purchasesByClient.get(client.id) ?? [];
    const firstPurchase = firstPurchaseAfterClientCreated(client, clientPurchases);
    const retained = firstPurchase
      ? clientPurchases.some(
          (purchase) =>
            purchase.date > firstPurchase.date &&
            daysBetween(firstPurchase.date, purchase.date) <= RETENTION_WINDOW_DAYS,
        )
      : false;
    const totalSpend = clientPurchases.reduce((sum, purchase) => sum + purchase.amount, 0);
    const daysToFirstPurchase = firstPurchase
      ? daysBetween(new Date(client.created_at), firstPurchase.date)
      : null;

    getClientGoals(client).forEach((goal) => {
      const current = statsByGoal.get(goal) ?? {
        goal,
        totalClients: 0,
        leads: 0,
        converted: 0,
        active: 0,
        retained: 0,
        totalSpend: 0,
        purchases: 0,
        completedLessons: 0,
        avgDaysToFirstPurchase: null,
        _days: [],
      };

      current.totalClients += 1;
      if (isLead(client)) current.leads += 1;
      if (firstPurchase) current.converted += 1;
      if (isActiveClient(client)) current.active += 1;
      if (retained) current.retained += 1;
      current.totalSpend += totalSpend;
      current.purchases += clientPurchases.length;
      current.completedLessons += completedLessonsByClient.get(client.id) ?? 0;
      if (daysToFirstPurchase !== null) current._days?.push(daysToFirstPurchase);
      current.avgDaysToFirstPurchase = average(current._days ?? []);

      statsByGoal.set(goal, current);
    });
  });

  const goalStats = Array.from(statsByGoal.values())
    .map(({ _days, ...stat }) => stat)
    .sort(
      (a, b) =>
        b.converted - a.converted ||
        b.totalSpend - a.totalSpend ||
        b.totalClients - a.totalClients,
    );

  const totals = {
    goalSelections: goalStats.reduce((sum, stat) => sum + stat.totalClients, 0),
    convertedSelections: goalStats.reduce((sum, stat) => sum + stat.converted, 0),
    retainedSelections: goalStats.reduce((sum, stat) => sum + stat.retained, 0),
    totalSpend: goalStats.reduce((sum, stat) => sum + stat.totalSpend, 0),
  };

  const leaders = {
    bestConversion:
      [...goalStats]
        .filter((stat) => stat.totalClients >= 2)
        .sort(
          (a, b) =>
            b.converted / Math.max(b.totalClients, 1) -
            a.converted / Math.max(a.totalClients, 1),
        )[0] ?? null,
    highestRevenue: [...goalStats].sort((a, b) => b.totalSpend - a.totalSpend)[0] ?? null,
    retentionLeader:
      [...goalStats]
        .filter((stat) => stat.converted > 0)
        .sort(
          (a, b) =>
            b.retained / Math.max(b.converted, 1) -
            a.retained / Math.max(a.converted, 1),
        )[0] ?? null,
    highInterestLowConversion:
      [...goalStats]
        .filter((stat) => stat.totalClients >= 2)
        .sort(
          (a, b) =>
            b.totalClients -
              a.totalClients ||
            a.converted / Math.max(a.totalClients, 1) -
              b.converted / Math.max(b.totalClients, 1),
        )[0] ?? null,
  };

  return {
    range,
    goalStats,
    totals,
    leaders,
    recommendations: buildRecommendations({ goalStats, leaders, totals }),
  };
}
