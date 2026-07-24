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
