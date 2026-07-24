export type ClientLifecycleStage =
  | "new_lead"
  | "contacted"
  | "intro_scheduled"
  | "conversion_pending"
  | "new_student"
  | "active_student"
  | "needs_rebooking"
  | "retention_risk"
  | "inactive"
  | "recovered"
  | "archived";

export type ClientLifecycleRisk = "none" | "watch" | "high";

export type ClientLifecycleInput = {
  clientStatus: string;
  createdAt: string;
  now?: Date;
  leadActivities?: Array<{
    created_at: string;
    activity_type?: string | null;
    follow_up_due_at?: string | null;
    completed_at?: string | null;
  }>;
  appointments?: Array<{
    id?: string;
    appointment_type: string;
    status: string;
    starts_at: string;
  }>;
  packages?: Array<{
    id?: string;
    active: boolean;
    purchase_date?: string | null;
    created_at?: string | null;
  }>;
  memberships?: Array<{
    id?: string;
    status: string;
    starts_on?: string | null;
    created_at?: string | null;
    cancel_at_period_end?: boolean | null;
  }>;
  payments?: Array<{
    id?: string;
    status: string;
    created_at: string;
    payment_type?: string | null;
  }>;
};


export type ClientLifecycleAction = {
  label: string;
  href: string | null;
  intent: "contact" | "book" | "sell" | "recover" | "review" | "none";
  ariaPrompt: string;
};

export function getClientLifecycleAction(params: {
  clientId: string;
  stage: ClientLifecycleStage;
}): ClientLifecycleAction {
  const clientPath = `/app/clients/${params.clientId}`;

  switch (params.stage) {
    case "new_lead":
      return {
        label: "Log first contact",
        href: `${clientPath}?tab=marketing#lead-activity-form`,
        intent: "contact",
        ariaPrompt: "Prepare a first-contact message and follow-up date.",
      };
    case "contacted":
      return {
        label: "Book intro lesson",
        href: `/app/schedule/new?clientId=${params.clientId}&appointmentType=intro_lesson`,
        intent: "book",
        ariaPrompt: "Recommend the best next appointment and prepare booking outreach.",
      };
    case "intro_scheduled":
      return {
        label: "Review intro appointment",
        href: `${clientPath}?tab=schedule`,
        intent: "review",
        ariaPrompt: "Prepare attendance confirmation and the first-offer conversation.",
      };
    case "conversion_pending":
      return {
        label: "Open conversion options",
        href: `${clientPath}?tab=overview#quick-sale-payment`,
        intent: "sell",
        ariaPrompt: "Recommend a first package or membership based on the client record.",
      };
    case "new_student":
      return {
        label: "Book next lesson",
        href: `/app/schedule/new?clientId=${params.clientId}`,
        intent: "book",
        ariaPrompt: "Prepare onboarding follow-up and secure the next appointment.",
      };
    case "active_student":
      return {
        label: "Review relationship",
        href: clientPath,
        intent: "review",
        ariaPrompt: "Monitor momentum, package health, and the next scheduled touchpoint.",
      };
    case "needs_rebooking":
      return {
        label: "Start rebooking follow-up",
        href: `${clientPath}?tab=marketing#lead-activity-form`,
        intent: "contact",
        ariaPrompt: "Draft a rebooking message using recent attendance context.",
      };
    case "retention_risk":
      return {
        label: "Open recovery workspace",
        href: `${clientPath}?tab=marketing`,
        intent: "recover",
        ariaPrompt: "Review the risk signal and prepare the safest recovery action.",
      };
    case "inactive":
      return {
        label: "Start win-back outreach",
        href: `${clientPath}?tab=marketing#lead-activity-form`,
        intent: "recover",
        ariaPrompt: "Draft a respectful win-back message based on the last meaningful activity.",
      };
    case "recovered":
      return {
        label: "Build next booking plan",
        href: `/app/schedule/new?clientId=${params.clientId}`,
        intent: "book",
        ariaPrompt: "Reinforce the recovery with a consistent next-booking plan.",
      };
    case "archived":
      return {
        label: "Review history",
        href: clientPath,
        intent: "none",
        ariaPrompt: "No automated outreach should occur unless staff reactivates the relationship.",
      };
  }
}

export type ClientLifecycleSummary = {
  stage: ClientLifecycleStage;
  label: string;
  description: string;
  lastMeaningfulActivityAt: string | null;
  nextExpectedStep: string;
  risk: ClientLifecycleRisk;
  riskReason: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function validDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latestDate(values: Array<string | null | undefined>) {
  return values
    .map(validDate)
    .filter((value): value is Date => Boolean(value))
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}

function daysBetween(earlier: Date, later: Date) {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}

function isPaidLike(status: string) {
  return ["paid", "processed", "complete", "completed"].includes(
    status.toLowerCase(),
  );
}

function isCompletedAppointment(status: string) {
  return ["attended", "completed"].includes(status.toLowerCase());
}

function isFutureAppointment(status: string) {
  return !["cancelled", "canceled", "no_show"].includes(status.toLowerCase());
}

function stageCopy(stage: ClientLifecycleStage) {
  switch (stage) {
    case "new_lead":
      return {
        label: "New lead",
        description: "New interest without a recorded outreach touchpoint yet.",
        nextExpectedStep: "Make first contact and set a follow-up date.",
      };
    case "contacted":
      return {
        label: "Contacted",
        description: "Outreach is underway, but the first appointment is not booked.",
        nextExpectedStep: "Book an intro lesson or first service.",
      };
    case "intro_scheduled":
      return {
        label: "Intro scheduled",
        description: "An intro lesson is booked and awaiting attendance.",
        nextExpectedStep: "Confirm attendance and prepare the first-offer conversation.",
      };
    case "conversion_pending":
      return {
        label: "Conversion pending",
        description: "The intro was completed, but no package or membership is recorded.",
        nextExpectedStep: "Follow up with the best first package or membership option.",
      };
    case "new_student":
      return {
        label: "New student",
        description: "A first package or membership was purchased recently.",
        nextExpectedStep: "Complete onboarding and secure the next appointment.",
      };
    case "active_student":
      return {
        label: "Active student",
        description: "The client has current engagement and future activity.",
        nextExpectedStep: "Maintain momentum and monitor package or membership health.",
      };
    case "needs_rebooking":
      return {
        label: "Needs rebooking",
        description: "The client attended recently but has nothing scheduled next.",
        nextExpectedStep: "Reach out and book the next lesson.",
      };
    case "retention_risk":
      return {
        label: "Retention risk",
        description: "Engagement, billing, or renewal signals need attention.",
        nextExpectedStep: "Review the risk signal and begin a recovery follow-up.",
      };
    case "recovered":
      return {
        label: "Recovered",
        description: "The client returned after an extended engagement gap.",
        nextExpectedStep: "Rebuild consistency with a clear next booking plan.",
      };
    case "inactive":
      return {
        label: "Inactive",
        description: "No meaningful engagement has been recorded recently.",
        nextExpectedStep: "Choose a win-back action or formally retain as inactive.",
      };
    case "archived":
      return {
        label: "Archived",
        description: "The relationship is retained for history but is no longer active.",
        nextExpectedStep: "No action unless the client returns.",
      };
  }
}

export function deriveClientLifecycle(
  input: ClientLifecycleInput,
): ClientLifecycleSummary {
  const now = input.now ?? new Date();
  const activities = input.leadActivities ?? [];
  const appointments = input.appointments ?? [];
  const packages = input.packages ?? [];
  const memberships = input.memberships ?? [];
  const payments = input.payments ?? [];

  const futureAppointments = appointments
    .filter((item) => {
      const startsAt = validDate(item.starts_at);
      return (
        startsAt &&
        startsAt.getTime() >= now.getTime() &&
        isFutureAppointment(item.status)
      );
    })
    .sort(
      (a, b) =>
        new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
    );

  const attendedAppointments = appointments
    .filter((item) => {
      const startsAt = validDate(item.starts_at);
      return startsAt && startsAt.getTime() < now.getTime() && isCompletedAppointment(item.status);
    })
    .sort(
      (a, b) =>
        new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime(),
    );

  const futureIntro = futureAppointments.find(
    (item) => item.appointment_type === "intro_lesson",
  );
  const attendedIntro = attendedAppointments.find(
    (item) => item.appointment_type === "intro_lesson",
  );

  const activePackages = packages.filter((item) => item.active);
  const activeMemberships = memberships.filter((item) =>
    ["active", "trialing"].includes(item.status.toLowerCase()),
  );
  const riskyMembership = memberships.find(
    (item) =>
      ["past_due", "unpaid"].includes(item.status.toLowerCase()) ||
      item.cancel_at_period_end === true,
  );
  const successfulPayments = payments.filter((item) => isPaidLike(item.status));
  const hasPurchase =
    activePackages.length > 0 ||
    activeMemberships.length > 0 ||
    successfulPayments.some((item) =>
      ["package_sale", "package_purchase", "membership"].includes(
        String(item.payment_type ?? "").toLowerCase(),
      ),
    );

  const firstPurchaseAt = latestDate([
    ...activePackages.map((item) => item.purchase_date ?? item.created_at),
    ...activeMemberships.map((item) => item.starts_on ?? item.created_at),
    ...successfulPayments
      .filter((item) =>
        ["package_sale", "package_purchase", "membership"].includes(
          String(item.payment_type ?? "").toLowerCase(),
        ),
      )
      .map((item) => item.created_at),
  ]);

  const lastAttendanceAt = validDate(attendedAppointments[0]?.starts_at);
  const previousAttendanceAt = validDate(attendedAppointments[1]?.starts_at);
  const nextAppointmentAt = validDate(futureAppointments[0]?.starts_at);
  const lastContactAt = latestDate(activities.map((item) => item.created_at));
  const lastPaymentAt = latestDate(successfulPayments.map((item) => item.created_at));
  const createdAt = validDate(input.createdAt);

  const lastMeaningful = latestDate([
    createdAt?.toISOString(),
    lastContactAt?.toISOString(),
    lastAttendanceAt?.toISOString(),
    lastPaymentAt?.toISOString(),
    firstPurchaseAt?.toISOString(),
  ]);

  const normalizedStatus = input.clientStatus.toLowerCase();
  let stage: ClientLifecycleStage;
  let risk: ClientLifecycleRisk = "none";
  let riskReason: string | null = null;

  if (["archived", "lost"].includes(normalizedStatus)) {
    stage = "archived";
  } else if (normalizedStatus === "lead") {
    if (futureIntro) {
      stage = "intro_scheduled";
    } else if (attendedIntro && !hasPurchase) {
      stage = "conversion_pending";
      risk = "watch";
      riskReason = "Intro completed without a recorded first purchase.";
    } else if (activities.length > 0) {
      stage = "contacted";
    } else {
      stage = "new_lead";
    }
  } else if (normalizedStatus === "inactive") {
    stage = "inactive";
    risk = "high";
    riskReason = "Client status is inactive.";
  } else if (riskyMembership) {
    stage = "retention_risk";
    risk = "high";
    riskReason = ["past_due", "unpaid"].includes(riskyMembership.status.toLowerCase())
      ? "Membership billing is not in good standing."
      : "Membership is set to cancel at the end of the period.";
  } else if (
    firstPurchaseAt &&
    daysBetween(firstPurchaseAt, now) <= 30
  ) {
    stage = "new_student";
  } else if (
    nextAppointmentAt &&
    previousAttendanceAt &&
    daysBetween(previousAttendanceAt, nextAppointmentAt) >= 45
  ) {
    stage = "recovered";
  } else if (nextAppointmentAt) {
    stage = "active_student";
  } else if (lastAttendanceAt && daysBetween(lastAttendanceAt, now) <= 45) {
    stage = "needs_rebooking";
    risk = "watch";
    riskReason = "Recent attendance exists, but there is no future appointment.";
  } else if (lastAttendanceAt && daysBetween(lastAttendanceAt, now) <= 90) {
    stage = "retention_risk";
    risk = "high";
    riskReason = "The client has no future appointment and engagement is declining.";
  } else if (lastMeaningful && daysBetween(lastMeaningful, now) > 90) {
    stage = "inactive";
    risk = "high";
    riskReason = "No meaningful activity has been recorded in more than 90 days.";
  } else if (hasPurchase) {
    stage = "retention_risk";
    risk = "watch";
    riskReason = "The client has value on record but no future appointment.";
  } else {
    stage = "inactive";
    risk = "watch";
    riskReason = "No active purchase or future appointment is recorded.";
  }

  const copy = stageCopy(stage);

  return {
    stage,
    label: copy.label,
    description: copy.description,
    lastMeaningfulActivityAt: lastMeaningful?.toISOString() ?? null,
    nextExpectedStep: copy.nextExpectedStep,
    risk,
    riskReason,
  };
}

export function lifecycleStageTone(stage: ClientLifecycleStage) {
  if (["active_student", "new_student", "recovered"].includes(stage)) {
    return "success" as const;
  }
  if (["new_lead", "contacted", "intro_scheduled"].includes(stage)) {
    return "info" as const;
  }
  if (["conversion_pending", "needs_rebooking"].includes(stage)) {
    return "warning" as const;
  }
  if (stage === "retention_risk") return "danger" as const;
  return "default" as const;
}

export type StudioLifecycleQueueItem = {
  clientId: string;
  clientName: string;
  clientStatus: string;
  stage: ClientLifecycleStage;
  label: string;
  description: string;
  nextExpectedStep: string;
  risk: ClientLifecycleRisk;
  riskReason: string | null;
  lastMeaningfulActivityAt: string | null;
  action: ClientLifecycleAction;
};

export type StudioLifecycleSnapshot = {
  generatedAt: string;
  totalClients: number;
  counts: Record<ClientLifecycleStage, number>;
  riskCounts: { watch: number; high: number };
  queue: StudioLifecycleQueueItem[];
  byClientId: Record<string, StudioLifecycleQueueItem>;
};

type SupabaseLike = { from: (table: string) => any };

function emptyLifecycleCounts(): Record<ClientLifecycleStage, number> {
  return {
    new_lead: 0,
    contacted: 0,
    intro_scheduled: 0,
    conversion_pending: 0,
    new_student: 0,
    active_student: 0,
    needs_rebooking: 0,
    retention_risk: 0,
    inactive: 0,
    recovered: 0,
    archived: 0,
  };
}

function lifecycleQueueRank(item: StudioLifecycleQueueItem) {
  const stageRank: Record<ClientLifecycleStage, number> = {
    retention_risk: 0,
    conversion_pending: 1,
    needs_rebooking: 2,
    new_lead: 3,
    contacted: 4,
    intro_scheduled: 5,
    inactive: 6,
    new_student: 7,
    recovered: 8,
    active_student: 9,
    archived: 10,
  };
  const riskRank = item.risk === "high" ? 0 : item.risk === "watch" ? 1 : 2;
  return riskRank * 100 + stageRank[item.stage];
}

export async function loadStudioLifecycleSnapshot(params: {
  supabase: SupabaseLike;
  studioId: string;
  now?: Date;
  clientLimit?: number;
}): Promise<StudioLifecycleSnapshot> {
  const now = params.now ?? new Date();
  const clientLimit = params.clientLimit ?? 3000;
  const clientsResult = await params.supabase
    .from("clients")
    .select("id, first_name, last_name, status, created_at")
    .eq("studio_id", params.studioId)
    .order("created_at", { ascending: false })
    .limit(clientLimit);

  if (clientsResult.error) {
    throw new Error(`Failed to load lifecycle clients: ${clientsResult.error.message}`);
  }

  const clients = (clientsResult.data ?? []) as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    status: string;
    created_at: string;
  }>;
  const clientIds = clients.map((client) => client.id);
  const counts = emptyLifecycleCounts();

  if (clientIds.length === 0) {
    return {
      generatedAt: now.toISOString(),
      totalClients: 0,
      counts,
      riskCounts: { watch: 0, high: 0 },
      queue: [],
      byClientId: {},
    };
  }

  const [activitiesResult, appointmentsResult, packagesResult, membershipsResult, paymentsResult] = await Promise.all([
    params.supabase.from("lead_activities").select("client_id, created_at, activity_type, follow_up_due_at, completed_at").eq("studio_id", params.studioId).in("client_id", clientIds).order("created_at", { ascending: false }).limit(10000),
    params.supabase.from("appointments").select("id, client_id, appointment_type, status, starts_at").eq("studio_id", params.studioId).in("client_id", clientIds).gte("starts_at", new Date(now.getTime() - 180 * DAY_MS).toISOString()).lte("starts_at", new Date(now.getTime() + 365 * DAY_MS).toISOString()).order("starts_at", { ascending: false }).limit(10000),
    params.supabase.from("client_packages").select("id, client_id, active, purchase_date, created_at").eq("studio_id", params.studioId).in("client_id", clientIds).order("created_at", { ascending: false }).limit(10000),
    params.supabase.from("client_memberships").select("id, client_id, status, starts_on, created_at, cancel_at_period_end").eq("studio_id", params.studioId).in("client_id", clientIds).order("created_at", { ascending: false }).limit(10000),
    params.supabase.from("payments").select("id, client_id, status, created_at, payment_type").eq("studio_id", params.studioId).in("client_id", clientIds).order("created_at", { ascending: false }).limit(10000),
  ]);

  const failures = [
    ["lead activities", activitiesResult.error],
    ["appointments", appointmentsResult.error],
    ["packages", packagesResult.error],
    ["memberships", membershipsResult.error],
    ["payments", paymentsResult.error],
  ] as const;
  const failed = failures.find(([, error]) => Boolean(error));
  if (failed) {
    throw new Error(`Failed to load lifecycle ${failed[0]}: ${failed[1]?.message ?? "Unknown error"}`);
  }

  const groupByClient = <T extends { client_id: string | null }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      if (!row.client_id) continue;
      const current = map.get(row.client_id) ?? [];
      current.push(row);
      map.set(row.client_id, current);
    }
    return map;
  };

  const activitiesByClient = groupByClient(
    (activitiesResult.data ?? []) as Array<
      NonNullable<ClientLifecycleInput["leadActivities"]>[number] & {
        client_id: string | null;
      }
    >,
  );
  const appointmentsByClient = groupByClient(
    (appointmentsResult.data ?? []) as Array<
      NonNullable<ClientLifecycleInput["appointments"]>[number] & {
        client_id: string | null;
      }
    >,
  );
  const packagesByClient = groupByClient(
    (packagesResult.data ?? []) as Array<
      NonNullable<ClientLifecycleInput["packages"]>[number] & {
        client_id: string | null;
      }
    >,
  );
  const membershipsByClient = groupByClient(
    (membershipsResult.data ?? []) as Array<
      NonNullable<ClientLifecycleInput["memberships"]>[number] & {
        client_id: string | null;
      }
    >,
  );
  const paymentsByClient = groupByClient(
    (paymentsResult.data ?? []) as Array<
      NonNullable<ClientLifecycleInput["payments"]>[number] & {
        client_id: string | null;
      }
    >,
  );

  const queue = clients.map((client) => {
    const summary = deriveClientLifecycle({
      clientStatus: client.status,
      createdAt: client.created_at,
      now,
      leadActivities: activitiesByClient.get(client.id) ?? [],
      appointments: appointmentsByClient.get(client.id) ?? [],
      packages: packagesByClient.get(client.id) ?? [],
      memberships: membershipsByClient.get(client.id) ?? [],
      payments: paymentsByClient.get(client.id) ?? [],
    });
    counts[summary.stage] += 1;
    return {
      clientId: client.id,
      clientName: [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || "Unnamed client",
      clientStatus: client.status,
      ...summary,
      action: getClientLifecycleAction({ clientId: client.id, stage: summary.stage }),
    } satisfies StudioLifecycleQueueItem;
  });

  queue.sort((a, b) => {
    const rank = lifecycleQueueRank(a) - lifecycleQueueRank(b);
    if (rank !== 0) return rank;
    const aTime = a.lastMeaningfulActivityAt ? new Date(a.lastMeaningfulActivityAt).getTime() : 0;
    const bTime = b.lastMeaningfulActivityAt ? new Date(b.lastMeaningfulActivityAt).getTime() : 0;
    return aTime - bTime;
  });

  return {
    generatedAt: now.toISOString(),
    totalClients: clients.length,
    counts,
    riskCounts: {
      watch: queue.filter((item) => item.risk === "watch").length,
      high: queue.filter((item) => item.risk === "high").length,
    },
    queue,
    byClientId: Object.fromEntries(queue.map((item) => [item.clientId, item])),
  };
}
