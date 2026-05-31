import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PortalTabs from "./PortalTabs";

type Params = Promise<{
  studioSlug: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  slug: string;
  public_name: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  is_independent_instructor: boolean | null;
};

type ActiveMembership = {
  id: string;
  status: string;
  starts_on: string;
  ends_on: string | null;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  name_snapshot: string;
  price_snapshot: number | null;
  billing_interval_snapshot: string | null;
};

type AppointmentSummaryRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  appointment_type: string;
  title: string | null;
};

type RentalSummaryRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  room_id: string | null;
};

type PendingPaymentRow = {
  id: string;
  amount: number | null;
  currency: string | null;
  payment_type: string | null;
  notes: string | null;
  created_at: string;
  client_package_id: string | null;
  client_membership_id: string | null;
};

type ClientPackageItemRow = {
  usage_type: string | null;
  quantity_total: number | string | null;
  quantity_used: number | string | null;
  quantity_remaining: number | string | null;
  is_unlimited: boolean | null;
};

type ClientPackageRow = {
  id: string;
  name_snapshot: string;
  active: boolean;
  expiration_date: string | null;
  sold_price: number | null;
  price_snapshot: number | null;
  client_package_items: ClientPackageItemRow[] | null;
};

type PaymentHistoryRow = {
  id: string;
  amount: number | null;
  currency: string | null;
  payment_type: string | null;
  payment_method: string | null;
  status: string;
  notes: string | null;
  paid_at: string | null;
  created_at: string;
};

type LessonRecapRow = {
  id: string;
  appointment_id: string;
  summary: string | null;
  homework: string | null;
  next_focus: string | null;
  visible_to_client: boolean | null;
  updated_at: string;
};

type SyllabusAssignmentRow = {
  id: string;
  syllabus_template_id: string;
  assigned_at: string;
  visible_in_portal: boolean;
};

type SyllabusTemplateRow = {
  id: string;
  name: string;
  dance_style: string | null;
  level: string | null;
  description: string | null;
};

type SyllabusTemplateItemRow = {
  id: string;
  template_id: string;
  title: string;
  category: string | null;
  description: string | null;
  sort_order: number | null;
};

type SyllabusProgressRow = {
  assignment_id: string;
  template_item_id: string;
  status: string;
  notes: string | null;
  show_notes_in_portal: boolean | null;
  updated_at: string;
};

type PortalSyllabusFigure = {
  id: string;
  title: string;
  category: string | null;
  description: string | null;
  status: string;
  visibleNote: string | null;
  updatedAt: string | null;
};

type PortalSyllabusAssignment = {
  id: string;
  assigned_at: string;
  template: SyllabusTemplateRow;
  figures: PortalSyllabusFigure[];
  totalFigures: number;
  startedCount: number;
  masteredCount: number;
  progressPercent: number;
};

type UpcomingItem = {
  id: string;
  kind: "appointment" | "rental";
  starts_at: string;
  ends_at: string;
  status: string;
  title: string;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function formatTimeRange(start: string, end: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${fmt.format(new Date(start))} – ${fmt.format(new Date(end))}`;
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "floor_space_rental") return "Floor Space Rental";
  if (value === "party") return "Party";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function paymentTypeLabel(value: string | null) {
  if (value === "package_sale") return "Package Payment";
  if (value === "membership") return "Membership Payment";
  if (value === "floor_rental") return "Floor Rental Payment";
  if (value === "event_registration") return "Event Registration Payment";
  return "Payment Request";
}

function packageUsageTypeLabel(value: string | null) {
  if (value === "private_lesson") return "Private Lessons";
  if (value === "group_class") return "Group Classes";
  if (value === "practice_party") return "Practice Parties";
  return "Credits";
}

function toNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function paymentMethodLabel(value: string | null) {
  if (!value) return "Payment";
  return value
    .replaceAll("_", " ")
    .replace(/\w/g, (char) => char.toUpperCase());
}

function statusLabel(value: string) {
  if (value === "scheduled") return "Scheduled";
  if (value === "attended") return "Completed";
  if (value === "cancelled") return "Cancelled";
  if (value === "no_show") return "Missed";
  if (value === "active") return "Active";
  if (value === "trialing") return "Trial";
  if (value === "past_due") return "Past Due";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "scheduled")
    return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "attended")
    return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "cancelled")
    return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "no_show")
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (status === "active")
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  if (status === "trialing")
    return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
  if (status === "past_due")
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function syllabusStatusLabel(value: string) {
  if (value === "not_started") return "Not Started";
  if (value === "introduced") return "Introduced";
  if (value === "practicing") return "Practicing";
  if (value === "comfortable") return "Comfortable";
  if (value === "mastered") return "Mastered";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function syllabusStatusBadgeClass(status: string) {
  if (status === "mastered") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  }

  if (status === "comfortable") {
    return "bg-sky-50 text-sky-700 ring-1 ring-sky-100";
  }

  if (status === "practicing") {
    return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
  }

  if (status === "introduced") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  }

  return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
}

function getSyllabusProgressPercent(startedCount: number, totalFigures: number) {
  if (!totalFigures) return 0;
  return Math.min(100, Math.round((startedCount / totalFigures) * 100));
}

function getClientFirstName(client: ClientRow) {
  return client.first_name?.trim() || "there";
}

function CardShell({
  title,
  subtitle,
  accent = "slate",
  children,
}: {
  title: string;
  subtitle?: string;
  accent?: "slate" | "orange" | "emerald" | "violet" | "sky";
  children: React.ReactNode;
}) {
  const accentMap: Record<string, string> = {
    slate: "text-slate-500",
    orange: "text-orange-600",
    emerald: "text-emerald-700",
    violet: "text-violet-700",
    sky: "text-sky-700",
  };

  return (
    <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
      <div className="max-w-2xl">
        <p
          className={`text-sm font-semibold uppercase tracking-[0.16em] ${accentMap[accent]}`}
        >
          {title}
        </p>
        {subtitle ? (
          <p className="mt-3 text-sm leading-7 text-slate-600">{subtitle}</p>
        ) : null}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function ActionTile({
  href,
  title,
  description,
  tone = "slate",
}: {
  href: string;
  title: string;
  description: string;
  tone?: "slate" | "sky" | "orange" | "emerald" | "violet";
}) {
  const classes: Record<string, string> = {
    slate: "border-slate-200 bg-slate-50 hover:bg-slate-100",
    sky: "border-sky-200 bg-sky-50 hover:bg-sky-100",
    orange: "border-orange-200 bg-orange-50 hover:bg-orange-100",
    emerald: "border-emerald-200 bg-emerald-50 hover:bg-emerald-100",
    violet: "border-violet-200 bg-violet-50 hover:bg-violet-100",
  };

  return (
    <Link
      href={href}
      className={`rounded-2xl border p-5 transition ${classes[tone]}`}
    >
      <p className="font-medium text-slate-900">{title}</p>
      <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
    </Link>
  );
}

export default async function PortalHomePage({ params }: { params: Params }) {
  const { studioSlug } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug, public_name")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const typedStudio = studio as StudioRow;
  const studioLabel = typedStudio.public_name?.trim() || typedStudio.name;

  let typedClient: ClientRow | null = null;

  const { data: linkedClient, error: linkedClientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, is_independent_instructor")
    .eq("studio_id", typedStudio.id)
    .eq("portal_user_id", user.id)
    .maybeSingle();

  if (linkedClientError) {
    throw linkedClientError;
  }

  if (linkedClient) {
    typedClient = linkedClient as ClientRow;
  } else if (user.email) {
    const { data: emailMatchedClient, error: emailMatchedClientError } =
      await supabase
        .from("clients")
        .select("id, first_name, last_name, email, is_independent_instructor")
        .eq("studio_id", typedStudio.id)
        .eq("email", user.email)
        .eq("is_independent_instructor", true)
        .maybeSingle();

    if (emailMatchedClientError) {
      throw emailMatchedClientError;
    }

    if (emailMatchedClient) {
      const { error: linkError } = await supabase
        .from("clients")
        .update({ portal_user_id: user.id })
        .eq("id", emailMatchedClient.id)
        .eq("studio_id", typedStudio.id);

      if (linkError) {
        throw linkError;
      }

      typedClient = emailMatchedClient as ClientRow;
    }
  }

  if (!typedClient) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: workspaceRole, error: workspaceRoleError } = await supabase
    .from("user_studio_roles")
    .select("role, active")
    .eq("studio_id", typedStudio.id)
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();

  if (workspaceRoleError) {
    throw workspaceRoleError;
  }

  const canReturnToWorkspace = Boolean(workspaceRole);

  const isInstructorPortal = Boolean(typedClient.is_independent_instructor);
  const nowIso = new Date().toISOString();

  const [
    { data: membership },
    { data: appointments, error: appointmentsError },
    { data: rentals, error: rentalsError },
    { data: pendingPayments, error: pendingPaymentsError },
    { data: packages, error: packagesError },
    { data: paymentHistory, error: paymentHistoryError },
  ] = await Promise.all([
    supabase
      .from("client_memberships")
      .select(
        `
        id,
        status,
        starts_on,
        ends_on,
        current_period_start,
        current_period_end,
        auto_renew,
        cancel_at_period_end,
        name_snapshot,
        price_snapshot,
        billing_interval_snapshot
      `,
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .in("status", ["active", "trialing", "past_due"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    supabase
      .from("appointments")
      .select(
        `
        id,
        starts_at,
        ends_at,
        status,
        appointment_type,
        title
      `,
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .in("appointment_type", ["private_lesson", "intro_lesson", "group_class"])
      .order("starts_at", { ascending: false })
      .limit(20),

    isInstructorPortal
      ? supabase
          .from("appointments")
          .select("id, starts_at, ends_at, status, room_id")
          .eq("studio_id", typedStudio.id)
          .eq("client_id", typedClient.id)
          .eq("appointment_type", "floor_space_rental")
          .gte("starts_at", nowIso)
          .order("starts_at", { ascending: true })
          .limit(5)
      : Promise.resolve({ data: [], error: null }),

    supabase
      .from("payments")
      .select(
        "id, amount, currency, payment_type, notes, created_at, client_package_id, client_membership_id",
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(10),

    supabase
      .from("client_packages")
      .select(
        `
        id,
        name_snapshot,
        active,
        expiration_date,
        sold_price,
        price_snapshot,
        client_package_items (
          usage_type,
          quantity_total,
          quantity_used,
          quantity_remaining,
          is_unlimited
        )
      `,
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(6),

    supabase
      .from("payments")
      .select(
        "id, amount, currency, payment_type, payment_method, status, notes, paid_at, created_at",
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .neq("status", "pending")
      .order("paid_at", { ascending: false, nullsFirst: false })
      .limit(8),
  ]);

   if (appointmentsError) {
    throw appointmentsError;
  }

  if (rentalsError) {
    throw rentalsError;
  }

  if (pendingPaymentsError) {
    throw pendingPaymentsError;
  }

  if (packagesError) {
    throw packagesError;
  }

  if (paymentHistoryError) {
    throw paymentHistoryError;
  }

  const typedMembership = (membership ?? null) as ActiveMembership | null;
  const typedAppointments = (appointments ?? []) as AppointmentSummaryRow[];
  const typedRentals = (rentals ?? []) as RentalSummaryRow[];
  const typedPendingPayments = (pendingPayments ?? []) as PendingPaymentRow[];
  const typedPackages = (packages ?? []) as ClientPackageRow[];
  const typedPaymentHistory = (paymentHistory ?? []) as PaymentHistoryRow[];

  const recapAppointmentIds = typedAppointments
    .filter((item) => item.status === "attended")
    .map((item) => item.id);

  let typedLessonRecaps: LessonRecapRow[] = [];

  if (recapAppointmentIds.length) {
    const { data: lessonRecaps, error: lessonRecapsError } = await supabase
      .from("lesson_recaps")
      .select(
        "id, appointment_id, summary, homework, next_focus, visible_to_client, updated_at",
      )
      .eq("studio_id", typedStudio.id)
      .in("appointment_id", recapAppointmentIds)
      .eq("visible_to_client", true)
      .order("updated_at", { ascending: false })
      .limit(5);

    if (lessonRecapsError) {
      throw lessonRecapsError;
    }

    typedLessonRecaps = (lessonRecaps ?? []) as LessonRecapRow[];
  }

  let portalSyllabusAssignments: PortalSyllabusAssignment[] = [];

  const { data: syllabusAssignments, error: syllabusAssignmentsError } =
    await supabase
      .from("client_syllabus_assignments")
      .select("id, syllabus_template_id, assigned_at, visible_in_portal")
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .eq("visible_in_portal", true)
      .is("archived_at", null)
      .order("assigned_at", { ascending: false });

  if (syllabusAssignmentsError) {
    throw syllabusAssignmentsError;
  }

  const typedSyllabusAssignments =
    (syllabusAssignments ?? []) as SyllabusAssignmentRow[];

  if (typedSyllabusAssignments.length) {
    const templateIds = Array.from(
      new Set(
        typedSyllabusAssignments
          .map((assignment) => assignment.syllabus_template_id)
          .filter(Boolean),
      ),
    );
    const assignmentIds = typedSyllabusAssignments.map((assignment) => assignment.id);

    const [
      { data: syllabusTemplates, error: syllabusTemplatesError },
      { data: syllabusItems, error: syllabusItemsError },
      { data: syllabusProgress, error: syllabusProgressError },
    ] = await Promise.all([
      supabase
        .from("syllabus_templates")
        .select("id, name, dance_style, level, description")
        .eq("studio_id", typedStudio.id)
        .in("id", templateIds)
        .eq("active", true),
      supabase
        .from("syllabus_template_items")
        .select("id, template_id, title, category, description, sort_order")
        .eq("studio_id", typedStudio.id)
        .in("template_id", templateIds)
        .eq("active", true)
        .order("sort_order", { ascending: true })
        .order("title", { ascending: true }),
      supabase
        .from("client_syllabus_progress")
        .select(
          "assignment_id, template_item_id, status, notes, show_notes_in_portal, updated_at",
        )
        .eq("studio_id", typedStudio.id)
        .eq("client_id", typedClient.id)
        .in("assignment_id", assignmentIds),
    ]);

    if (syllabusTemplatesError) {
      throw syllabusTemplatesError;
    }

    if (syllabusItemsError) {
      throw syllabusItemsError;
    }

    if (syllabusProgressError) {
      throw syllabusProgressError;
    }

    const templatesById = new Map(
      ((syllabusTemplates ?? []) as SyllabusTemplateRow[]).map((template) => [
        template.id,
        template,
      ]),
    );

    const itemsByTemplateId = new Map<string, SyllabusTemplateItemRow[]>();

    ((syllabusItems ?? []) as SyllabusTemplateItemRow[]).forEach((item) => {
      const existing = itemsByTemplateId.get(item.template_id) ?? [];
      existing.push(item);
      itemsByTemplateId.set(item.template_id, existing);
    });

    const progressByAssignmentAndItem = new Map<string, SyllabusProgressRow>();

    ((syllabusProgress ?? []) as SyllabusProgressRow[]).forEach((progress) => {
      progressByAssignmentAndItem.set(
        `${progress.assignment_id}:${progress.template_item_id}`,
        progress,
      );
    });

    portalSyllabusAssignments = typedSyllabusAssignments
      .map((assignment) => {
        const template = templatesById.get(assignment.syllabus_template_id);

        if (!template) {
          return null;
        }

        const figures = (itemsByTemplateId.get(template.id) ?? []).map((item) => {
          const progress = progressByAssignmentAndItem.get(
            `${assignment.id}:${item.id}`,
          );
          const status = progress?.status ?? "not_started";

          return {
            id: item.id,
            title: item.title,
            category: item.category,
            description: item.description,
            status,
            visibleNote:
              progress?.show_notes_in_portal && progress.notes?.trim()
                ? progress.notes.trim()
                : null,
            updatedAt: progress?.updated_at ?? null,
          };
        });

        const totalFigures = figures.length;
        const startedCount = figures.filter(
          (figure) => figure.status !== "not_started",
        ).length;
        const masteredCount = figures.filter(
          (figure) => figure.status === "mastered",
        ).length;

        return {
          id: assignment.id,
          assigned_at: assignment.assigned_at,
          template,
          figures,
          totalFigures,
          startedCount,
          masteredCount,
          progressPercent: getSyllabusProgressPercent(startedCount, totalFigures),
        };
      })
      .filter(Boolean) as PortalSyllabusAssignment[];
  }

  const upcomingAppointments = typedAppointments
    .filter((item) => item.starts_at >= nowIso)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 5);

  const recentAppointments = typedAppointments
    .filter((item) => item.starts_at < nowIso)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, 5);

  const upcomingItems: UpcomingItem[] = [
    ...upcomingAppointments.map((item) => ({
      id: item.id,
      kind: "appointment" as const,
      starts_at: item.starts_at,
      ends_at: item.ends_at,
      status: item.status,
      title: item.title?.trim() || appointmentTypeLabel(item.appointment_type),
    })),
    ...typedRentals.map((item) => ({
      id: item.id,
      kind: "rental" as const,
      starts_at: item.starts_at,
      ends_at: item.ends_at,
      status: item.status,
      title: "Floor Space Rental",
    })),
  ]
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 6);

  const upcomingCount = isInstructorPortal
    ? upcomingItems.length
    : upcomingAppointments.length;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.42)_0%,rgba(255,255,255,0)_24%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  {isInstructorPortal
                    ? "DanceFlow Instructor Portal"
                    : "DanceFlow Student Portal"}
                </p>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                  Welcome back, {getClientFirstName(typedClient)}
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                  {isInstructorPortal
                    ? "Use your portal to review schedule activity, floor rentals, payments, and account details without digging through long pages."
                    : "Use your portal to review upcoming lessons, packages, recaps, payments, and account details in a cleaner tabbed layout."}
                </p>
                <div className="mt-4 flex flex-wrap gap-3 text-sm text-white/80">
                  <span>
                    Studio: <span className="font-medium text-white">{studioLabel}</span>
                  </span>
                  <span>
                    Portal: <span className="font-medium text-white">{isInstructorPortal ? "Independent Instructor" : "Student"}</span>
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                {canReturnToWorkspace ? (
                  <Link
                    href={`/app?studio=${encodeURIComponent(typedStudio.id)}`}
                    className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                  >
                    Back to Workspace
                  </Link>
                ) : null}
                <Link
                  href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  My Account
                </Link>

                <form action="/auth/logout" method="post">
                  <button
                    type="submit"
                    className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                  >
                    Log Out
                  </button>
                </form>
              </div>
            </div>

            <div className="grid w-full gap-4 md:grid-cols-3">
              <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  {isInstructorPortal ? "Coming Up" : "Upcoming Appointments"}
                </p>
                <p className="mt-3 text-3xl font-semibold text-white">{upcomingCount}</p>
              </div>

              <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  Active Membership
                </p>
                <p className="mt-3 text-lg font-semibold text-white">
                  {typedMembership ? typedMembership.name_snapshot : "None"}
                </p>
              </div>

              <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  Active Packages
                </p>
                <p className="mt-3 text-3xl font-semibold text-white">{typedPackages.length}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <PortalTabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "schedule", label: "Schedule" },
          { id: "packages", label: "Packages" },
          { id: "recaps", label: "Recaps" },
          { id: "syllabus", label: "Syllabus" },
          { id: "payments", label: "Payments" },
          { id: "rentals", label: "Rentals" },
          { id: "account", label: "Account" },
        ]}
        defaultTabId="overview"
      >
        <section id="overview" className="space-y-8">
          <CardShell
            title="At a Glance"
            accent="sky"
            subtitle={
              isInstructorPortal
                ? "Your most important schedule, rental, and payment details in one quick view."
                : "Your most important lesson, package, and account details in one quick view."
            }
          >
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-3xl border border-sky-200 bg-sky-50 p-5">
                <p className="text-sm font-medium text-sky-900">Next up</p>
                <p className="mt-2 text-3xl font-semibold text-sky-950">{upcomingItems.length}</p>
                <p className="mt-2 text-sm text-sky-800">Upcoming schedule items</p>
              </div>
              <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
                <p className="text-sm font-medium text-emerald-900">Packages</p>
                <p className="mt-2 text-3xl font-semibold text-emerald-950">{typedPackages.length}</p>
                <p className="mt-2 text-sm text-emerald-800">Active package records</p>
              </div>
              <div className="rounded-3xl border border-violet-200 bg-violet-50 p-5">
                <p className="text-sm font-medium text-violet-900">Recaps</p>
                <p className="mt-2 text-3xl font-semibold text-violet-950">{typedLessonRecaps.length}</p>
                <p className="mt-2 text-sm text-violet-800">Shared lesson notes</p>
              </div>
            </div>
          </CardShell>

          <CardShell
            title="Quick Actions"
            accent="sky"
            subtitle={
              isInstructorPortal
                ? "Jump to schedule, rentals, account details, and workspace access."
                : "Jump to your schedule, packages, recaps, payments, and account details."
            }
          >
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <ActionTile
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
                title="My Schedule"
                description="See upcoming lessons and recent activity."
                tone="sky"
              />
              {isInstructorPortal ? (
                <ActionTile
                  href={`/portal/${encodeURIComponent(studioSlug)}/floor-space`}
                  title="Book Floor Space"
                  description="Reserve time for teaching and rentals."
                  tone="orange"
                />
              ) : null}
              {isInstructorPortal ? (
                <ActionTile
                  href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/my-rentals`}
                  title="My Rentals"
                  description="Review rentals, payments, and balances."
                  tone="emerald"
                />
              ) : null}
              <ActionTile
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
                title="My Account"
                description="Update your profile and account details."
                tone="violet"
              />
              {canReturnToWorkspace ? (
                <ActionTile
                  href={`/app?studio=${encodeURIComponent(typedStudio.id)}`}
                  title="Back to Workspace"
                  description="Return to the full staff workspace for this studio."
                  tone="slate"
                />
              ) : null}
            </div>
          </CardShell>

          {typedPendingPayments.length ? (
            <CardShell
              title="Needs Attention"
              accent="orange"
              subtitle="You have pending payment requests from the studio."
            >
              <div className="space-y-3">
                {typedPendingPayments.slice(0, 3).map((payment) => (
                  <div
                    key={payment.id}
                    className="flex flex-col gap-4 rounded-3xl border border-amber-200 bg-amber-50 p-5 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <p className="text-sm font-medium text-amber-800">
                        {paymentTypeLabel(payment.payment_type)}
                      </p>
                      <p className="mt-2 text-2xl font-semibold text-amber-950">
                        {formatCurrency(payment.amount)}
                      </p>
                      {payment.notes ? (
                        <p className="mt-1 text-sm text-amber-900">{payment.notes}</p>
                      ) : null}
                    </div>
                    <Link
                      href={
                        "/api/stripe/client-checkout?paymentId=" +
                        encodeURIComponent(payment.id) +
                        "&returnTo=" +
                        encodeURIComponent(`/portal/${typedStudio.slug}`) +
                        "&cancelTo=" +
                        encodeURIComponent(`/portal/${typedStudio.slug}?error=payment_cancelled`)
                      }
                      className="inline-flex items-center justify-center rounded-2xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-medium text-white hover:opacity-95"
                    >
                      Pay Now
                    </Link>
                  </div>
                ))}
              </div>
            </CardShell>
          ) : null}
        </section>

        <section id="schedule" className="space-y-8">
          <CardShell
            title="Coming Up"
            accent="sky"
            subtitle={
              isInstructorPortal
                ? "Your next lessons and rentals in one place."
                : "Your upcoming appointments at a glance."
            }
          >
            {upcomingItems.length ? (
              <div className="space-y-3">
                {upcomingItems.map((item) => (
                  <div
                    key={`${item.kind}-${item.id}`}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(item.status)}`}>
                        {statusLabel(item.status)}
                      </span>
                      <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        {item.kind === "rental" ? "Rental" : "Lesson"}
                      </span>
                    </div>
                    <p className="mt-3 font-medium text-slate-950">{item.title}</p>
                    <p className="mt-1 text-sm text-slate-600">{formatDateTime(item.starts_at)}</p>
                    <p className="mt-1 text-sm text-slate-500">{formatTimeRange(item.starts_at, item.ends_at)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">No upcoming schedule items right now.</p>
              </div>
            )}
            <div className="mt-5">
              <Link
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Open Full Schedule
              </Link>
            </div>
          </CardShell>

          <CardShell
            title={isInstructorPortal ? "Recent Lesson Activity" : "Recent Appointments"}
            accent="emerald"
            subtitle={
              isInstructorPortal
                ? "A quick look at your recent lesson-side activity."
                : "A quick look at your most recent lessons and class bookings."
            }
          >
            {recentAppointments.length ? (
              <div className="space-y-3">
                {recentAppointments.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <p className="font-medium text-slate-950">
                        {item.title?.trim() || appointmentTypeLabel(item.appointment_type)}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">{formatDateTime(item.starts_at)}</p>
                    </div>
                    <span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(item.status)}`}>
                      {statusLabel(item.status)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">No recent appointment history yet.</p>
              </div>
            )}
          </CardShell>
        </section>

        <section id="packages" className="space-y-8">
          <CardShell
            title="Packages & Credits"
            accent="emerald"
            subtitle="See active packages and the credits you have available for lessons, groups, and parties."
          >
            {typedPackages.length ? (
              <div className="space-y-4">
                {typedPackages.map((clientPackage) => (
                  <div key={clientPackage.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-100">
                            Active
                          </span>
                          {clientPackage.expiration_date ? (
                            <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                              Expires {formatDate(clientPackage.expiration_date)}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-3 text-lg font-semibold text-slate-950">{clientPackage.name_snapshot}</p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatCurrency(clientPackage.sold_price ?? clientPackage.price_snapshot)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      {(clientPackage.client_package_items ?? []).map((item) => (
                        <div key={`${clientPackage.id}-${item.usage_type}`} className="rounded-2xl border border-white bg-white p-4">
                          <p className="text-sm font-medium text-slate-900">{packageUsageTypeLabel(item.usage_type)}</p>
                          <p className="mt-2 text-2xl font-semibold text-slate-950">
                            {item.is_unlimited ? "Unlimited" : toNumber(item.quantity_remaining)}
                          </p>
                          {!item.is_unlimited ? (
                            <p className="mt-1 text-xs text-slate-500">
                              {toNumber(item.quantity_used)} used of {toNumber(item.quantity_total)}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">No active packages are linked to this portal profile right now.</p>
              </div>
            )}
          </CardShell>

          <CardShell
            title={isInstructorPortal ? "My Membership" : "Membership Snapshot"}
            accent="violet"
            subtitle={
              isInstructorPortal
                ? "If this portal account also has a membership, you can review it here."
                : "See your current membership and billing period in one place."
            }
          >
            {typedMembership ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Plan</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">{typedMembership.name_snapshot}</p>
                  <p className="mt-2 text-sm text-slate-600">
                    {formatCurrency(typedMembership.price_snapshot)} / {typedMembership.billing_interval_snapshot || "period"}
                  </p>
                </div>
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Status</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">{statusLabel(typedMembership.status)}</p>
                  <p className="mt-2 text-sm text-slate-600">
                    Current period: {formatDate(typedMembership.current_period_start)} – {formatDate(typedMembership.current_period_end)}
                  </p>
                </div>
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 md:col-span-2">
                  <p className="text-sm text-slate-500">Renewal</p>
                  <p className="mt-2 text-sm text-slate-700">
                    {typedMembership.cancel_at_period_end
                      ? "Your membership will end at the close of the current billing period."
                      : typedMembership.auto_renew
                        ? "Your membership is set to renew automatically."
                        : "Auto-renew is currently turned off."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">No active membership is linked to this portal profile right now.</p>
              </div>
            )}
          </CardShell>
        </section>

        <section id="recaps" className="space-y-8">
          <CardShell
            title="Lesson Recaps"
            accent="violet"
            subtitle="When your instructor shares a lesson recap, you can review notes, homework, and next focus areas here."
          >
            {typedLessonRecaps.length ? (
              <div className="space-y-3">
                {typedLessonRecaps.map((recap) => (
                  <div key={recap.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-100">
                        Shared by instructor
                      </span>
                      <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        Updated {formatDate(recap.updated_at.slice(0, 10))}
                      </span>
                    </div>
                    {recap.summary ? (
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Summary</p>
                        <p className="mt-2 text-sm leading-7 text-slate-700">{recap.summary}</p>
                      </div>
                    ) : null}
                    {recap.homework ? (
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Homework</p>
                        <p className="mt-2 text-sm leading-7 text-slate-700">{recap.homework}</p>
                      </div>
                    ) : null}
                    {recap.next_focus ? (
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Next Focus</p>
                        <p className="mt-2 text-sm leading-7 text-slate-700">{recap.next_focus}</p>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">No shared lesson recaps yet.</p>
              </div>
            )}
          </CardShell>
        </section>

        <section id="syllabus" className="space-y-8">
          <CardShell
            title="Syllabus Progress"
            accent="violet"
            subtitle="View the syllabus progress your instructor has chosen to share in your portal. This is read-only, so ask your instructor if something needs to be updated."
          >
            {portalSyllabusAssignments.length ? (
              <div className="space-y-5">
                {portalSyllabusAssignments.map((assignment) => (
                  <div
                    key={assignment.id}
                    className="overflow-hidden rounded-[28px] border border-violet-100 bg-violet-50/60"
                  >
                    <div className="border-b border-violet-100 bg-white/80 p-5">
                      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                            Shared Syllabus
                          </p>
                          <h2 className="mt-2 text-xl font-semibold text-slate-950">
                            {assignment.template.name}
                          </h2>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {assignment.template.dance_style ? (
                              <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-100">
                                {assignment.template.dance_style}
                              </span>
                            ) : null}
                            {assignment.template.level ? (
                              <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                                {assignment.template.level}
                              </span>
                            ) : null}
                            <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                              Assigned {formatDateTime(assignment.assigned_at)}
                            </span>
                          </div>
                          {assignment.template.description ? (
                            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                              {assignment.template.description}
                            </p>
                          ) : null}
                        </div>

                        <div className="rounded-2xl border border-white bg-white p-4 text-sm text-slate-600 shadow-sm md:min-w-52">
                          <p className="font-medium text-slate-900">Progress</p>
                          <p className="mt-1">
                            {assignment.startedCount} of {assignment.totalFigures} started
                          </p>
                          <p className="mt-1">
                            {assignment.masteredCount} mastered
                          </p>
                          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-[var(--brand-primary)]"
                              style={{ width: `${assignment.progressPercent}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {assignment.figures.length ? (
                      <div className="divide-y divide-violet-100 bg-white">
                        {assignment.figures.map((figure) => (
                          <div
                            key={`${assignment.id}-${figure.id}`}
                            className="p-4 sm:p-5"
                          >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                              <div>
                                <p className="font-medium text-slate-950">
                                  {figure.title}
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {figure.category ? (
                                    <span className="inline-flex rounded-full bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                                      {figure.category}
                                    </span>
                                  ) : null}
                                  {figure.updatedAt ? (
                                    <span className="inline-flex rounded-full bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500 ring-1 ring-slate-200">
                                      Updated {formatDateTime(figure.updatedAt)}
                                    </span>
                                  ) : null}
                                </div>
                                {figure.description ? (
                                  <p className="mt-3 text-sm leading-6 text-slate-600">
                                    {figure.description}
                                  </p>
                                ) : null}
                                {figure.visibleNote ? (
                                  <div className="mt-3 rounded-2xl border border-violet-100 bg-violet-50 p-4">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                                      Instructor Note
                                    </p>
                                    <p className="mt-2 text-sm leading-6 text-slate-700">
                                      {figure.visibleNote}
                                    </p>
                                  </div>
                                ) : null}
                              </div>

                              <span
                                className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-medium ${syllabusStatusBadgeClass(figure.status)}`}
                              >
                                {syllabusStatusLabel(figure.status)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-white p-6">
                        <p className="text-sm text-slate-600">
                          This syllabus does not have figures listed yet.
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm font-medium text-slate-800">
                  No syllabus progress is shared yet.
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  When your instructor shares a syllabus assignment, your progress will appear here.
                </p>
              </div>
            )}
          </CardShell>
        </section>

        <section id="payments" className="space-y-8">
          <CardShell
            title="Pending Payments"
            accent="orange"
            subtitle="Any unpaid payment requests from the studio will appear here. Use Pay Now when you are ready to complete the purchase."
          >
            {typedPendingPayments.length ? (
              <div className="space-y-3">
                {typedPendingPayments.map((payment) => (
                  <div key={payment.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-100">
                            Pending
                          </span>
                          <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                            {paymentTypeLabel(payment.payment_type)}
                          </span>
                        </div>
                        <p className="mt-3 text-2xl font-semibold text-slate-950">{formatCurrency(payment.amount)}</p>
                        {payment.notes ? <p className="mt-1 text-sm leading-6 text-slate-600">{payment.notes}</p> : null}
                      </div>
                      <Link
                        href={
                          "/api/stripe/client-checkout?paymentId=" +
                          encodeURIComponent(payment.id) +
                          "&returnTo=" +
                          encodeURIComponent(`/portal/${typedStudio.slug}`) +
                          "&cancelTo=" +
                          encodeURIComponent(`/portal/${typedStudio.slug}?error=payment_cancelled`)
                        }
                        className="inline-flex items-center justify-center rounded-2xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-medium text-white hover:opacity-95"
                      >
                        Pay Now
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">No pending payment requests right now.</p>
              </div>
            )}
          </CardShell>

          <CardShell
            title="Payment History"
            accent="slate"
            subtitle="Review recent completed payments recorded by the studio."
          >
            {typedPaymentHistory.length ? (
              <div className="space-y-3">
                {typedPaymentHistory.map((payment) => (
                  <div key={payment.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-medium text-slate-950">{paymentTypeLabel(payment.payment_type)}</p>
                        <p className="mt-1 text-sm text-slate-600">
                          {payment.paid_at ? formatDateTime(payment.paid_at) : formatDateTime(payment.created_at)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">{paymentMethodLabel(payment.payment_method)}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-slate-950">{formatCurrency(payment.amount)}</p>
                        <span className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(payment.status)}`}>
                          {statusLabel(payment.status)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">No payment history is available yet.</p>
              </div>
            )}
          </CardShell>
        </section>

        {isInstructorPortal ? (
          <section id="rentals" className="space-y-8">
            <CardShell
              title="Floor Rentals"
              accent="orange"
              subtitle="Manage your floor rental activity and keep your balance current."
            >
              <div className="space-y-5">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-slate-500">Upcoming rentals</p>
                      <p className="mt-2 text-3xl font-semibold text-slate-950">{typedRentals.length}</p>
                    </div>
                    <Link
                      href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/my-rentals`}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                      View Rentals
                    </Link>
                  </div>
                </div>

                {typedRentals.length ? (
                  <div className="space-y-3">
                    {typedRentals.map((item) => (
                      <div key={item.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(item.status)}`}>
                            {statusLabel(item.status)}
                          </span>
                        </div>
                        <p className="mt-3 font-medium text-slate-950">Floor Space Rental</p>
                        <p className="mt-1 text-sm text-slate-600">{formatDateTime(item.starts_at)}</p>
                        <p className="mt-1 text-sm text-slate-500">{formatTimeRange(item.starts_at, item.ends_at)}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                    <p className="text-sm text-slate-600">You do not have any upcoming rentals booked.</p>
                  </div>
                )}
              </div>
            </CardShell>
          </section>
        ) : null}

        <section id="account" className="space-y-8">
          <CardShell
            title="Account"
            accent="violet"
            subtitle="Manage your profile, return to the studio workspace when available, or sign out."
          >
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <ActionTile
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
                title="My Account"
                description="Update your profile and account details."
                tone="violet"
              />
              <ActionTile
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
                title="Full Schedule"
                description="Open the dedicated schedule page."
                tone="sky"
              />
              {canReturnToWorkspace ? (
                <ActionTile
                  href={`/app?studio=${encodeURIComponent(typedStudio.id)}`}
                  title="Back to Workspace"
                  description="Return to the full staff workspace for this studio."
                  tone="slate"
                />
              ) : null}
            </div>

            <form action="/auth/logout" method="post" className="mt-6">
              <button
                type="submit"
                className="inline-flex rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Log Out
              </button>
            </form>
          </CardShell>
        </section>
      </PortalTabs>
    </div>
  );
}



