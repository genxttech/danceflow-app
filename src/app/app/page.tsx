import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "./dashboard-actions";
import { syncStudioNotifications } from "@/lib/notifications/sync";
import {
  getAccessibleStudios,
  getCurrentStudioContext,
} from "@/lib/auth/studio";

function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function endOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

function startOfMonthLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function fmtCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function fmtShortDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDateOnly(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "floor_space_rental") return "Floor Space Rental";
  if (value === "event") return "Event";
  return value.replaceAll("_", " ");
}

function appointmentTypeBadgeClass(value: string) {
  if (value === "floor_space_rental") return "bg-indigo-50 text-indigo-700";
  if (value === "intro_lesson") return "bg-cyan-50 text-cyan-700";
  if (value === "group_class") return "bg-green-50 text-green-700";
  if (value === "coaching") return "bg-purple-50 text-purple-700";
  if (value === "practice_party") return "bg-amber-50 text-amber-700";
  if (value === "event") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-700";
}

function paymentSourceLabel(source: string | null) {
  if (source === "stripe") return "Stripe";
  if (source === "manual") return "Manual";
  return "Unknown";
}

function paymentTypeLabel(value: string | null) {
  if (value === "membership") return "Membership";
  if (value === "package_sale") return "Package Sale";
  if (value === "event_registration") return "Event Registration";
  if (value === "floor_rental") return "Floor Rental";
  if (value === "other") return "Other";
  return "General";
}

function getClientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getInstructorName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
) {
  const instructor = Array.isArray(value) ? value[0] : value;
  return instructor
    ? `${instructor.first_name} ${instructor.last_name}`
    : "No instructor";
}

function getRoomName(value: { name: string } | { name: string }[] | null) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room";
}

function membershipStatusBadgeClass(status: string) {
  if (status === "past_due") return "bg-amber-50 text-amber-700";
  if (status === "unpaid") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function billingIntervalLabel(value: string) {
  if (value === "monthly") return "Monthly";
  if (value === "quarterly") return "Quarterly";
  if (value === "yearly") return "Yearly";
  return value;
}

function looksRecoveredMembershipBilling(
  status: string,
  latestPaymentStatus: string | null
) {
  return status === "active" && latestPaymentStatus === "paid";
}

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  client_id: string | null;
  appointment_id: string | null;
  read_at: string | null;
  created_at: string;
};

type FollowUpRow = {
  id: string;
  client_id: string;
  activity_type: string;
  note: string;
  follow_up_due_at: string | null;
  completed_at: string | null;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

type LowBalanceRow = {
  id: string;
  client_id: string;
  name_snapshot: string;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  client_package_items: {
    usage_type: string;
    quantity_remaining: number | null;
    is_unlimited: boolean;
  }[];
};

type TodayAppointmentRow = {
  id: string;
  appointment_type: string;
  title: string | null;
  status: string;
  starts_at: string;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  instructors:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  rooms:
    | { name: string }
    | { name: string }[]
    | null;
};

type PaymentRow = {
  id: string;
  client_id: string | null;
  amount: number;
  status: string;
  created_at: string;
  source: string | null;
  payment_type: string | null;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

type RecentSaleRow = {
  id: string;
  client_id: string;
  name_snapshot: string;
  purchase_date: string;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

type PublicIntroBookingRow = {
  id: string;
  starts_at: string;
  appointment_type: string;
  title: string | null;
  client_id: string | null;
  clients:
    | {
        first_name: string;
        last_name: string;
        referral_source: string | null;
      }
    | {
        first_name: string;
        last_name: string;
        referral_source: string | null;
      }[]
    | null;
};

type MembershipOpsRow = {
  id: string;
  client_id: string;
  status: string;
  current_period_end: string;
  name_snapshot: string;
  price_snapshot: number;
  billing_interval_snapshot: string;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

type DashboardMembershipPaymentRow = {
  client_id: string;
  amount: number;
  created_at: string;
  payment_type: string | null;
  status: string;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

function StatCard({
  label,
  value,
  subtext,
}: {
  label: string;
  value: string | number;
  subtext?: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">{value}</p>
      {subtext ? <p className="mt-2 text-sm text-slate-500">{subtext}</p> : null}
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold text-[var(--brand-text)]">{title}</h3>
          {subtitle ? <p className="mt-1 text-sm text-slate-600">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </div>
  );
}

export default async function AppDashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

    const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const accessibleStudios = await getAccessibleStudios();

  const currentWorkspace =
    accessibleStudios.find((workspace) => workspace.studioId === studioId) ??
    accessibleStudios.find((workspace) => workspace.isSelected) ??
    null;

  const workspaceCount = accessibleStudios.length;
  const currentRoleLabel = context.isPlatformAdmin
    ? "platform admin"
    : (context.studioRole ?? "studio user").replaceAll("_", " ");

  const todayStart = startOfTodayLocal().toISOString();
  const todayEnd = endOfTodayLocal().toISOString();
  const monthStart = startOfMonthLocal().toISOString();
  const nowIso = new Date().toISOString();

  await syncStudioNotifications(studioId);

  const [
    { data: studio, error: studioError },
    { count: activeClients, error: activeClientsError },
    { count: followUpsOpen, error: followUpsOpenError },
    { count: todayAppointmentsCount, error: todayAppointmentsCountError },
    { data: monthPayments, error: monthPaymentsError },
    { data: notifications, error: notificationsError },
    { data: followUps, error: followUpsError },
    { data: lowBalances, error: lowBalancesError },
    { data: todayAppointments, error: todayAppointmentsError },
    { data: recentPayments, error: recentPaymentsError },
    { data: recentSales, error: recentSalesError },
    { data: publicIntroBookings, error: publicIntroBookingsError },
    { count: todayFloorRentalsCount, error: todayFloorRentalsCountError },
    { data: membershipOps, error: membershipOpsError },
    { data: recentMembershipPayments, error: recentMembershipPaymentsError },
  ] = await Promise.all([
    supabase.from("studios").select("id, name").eq("id", studioId).single(),

    supabase
      .from("clients")
      .select("*", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("status", "active"),

    supabase
      .from("lead_activities")
      .select("*", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .not("follow_up_due_at", "is", null)
      .is("completed_at", null),

    supabase
      .from("appointments")
      .select("*", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .gte("starts_at", todayStart)
      .lt("starts_at", todayEnd),

    supabase
      .from("payments")
      .select("amount, status")
      .eq("studio_id", studioId)
      .eq("status", "paid")
      .gte("created_at", monthStart),

    supabase
      .from("notifications")
      .select("id, type, title, body, client_id, appointment_id, read_at, created_at")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(8),

    supabase
      .from("lead_activities")
      .select(`
        id,
        client_id,
        activity_type,
        note,
        follow_up_due_at,
        completed_at,
        clients (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .not("follow_up_due_at", "is", null)
      .is("completed_at", null)
      .order("follow_up_due_at", { ascending: true })
      .limit(10),

    supabase
      .from("client_packages")
      .select(`
        id,
        client_id,
        name_snapshot,
        clients (
          first_name,
          last_name
        ),
        client_package_items (
          usage_type,
          quantity_remaining,
          is_unlimited
        )
      `)
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("purchase_date", { ascending: false })
      .limit(25),

    supabase
      .from("appointments")
      .select(`
        id,
        appointment_type,
        title,
        status,
        starts_at,
        clients:clients!appointments_client_id_fkey (
          first_name,
          last_name
        ),
        instructors (
          first_name,
          last_name
        ),
        rooms (
          name
        )
      `)
      .eq("studio_id", studioId)
      .gte("starts_at", todayStart)
      .lt("starts_at", todayEnd)
      .order("starts_at", { ascending: true })
      .limit(12),

    supabase
      .from("payments")
      .select(`
        id,
        client_id,
        amount,
        status,
        created_at,
        source,
        payment_type,
        clients (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(10),

    supabase
      .from("client_packages")
      .select(`
        id,
        client_id,
        name_snapshot,
        purchase_date,
        clients (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .order("purchase_date", { ascending: false })
      .limit(10),

    supabase
      .from("appointments")
      .select(`
        id,
        starts_at,
        appointment_type,
        title,
        client_id,
        clients:clients!appointments_client_id_fkey (
          first_name,
          last_name,
          referral_source
        )
      `)
      .eq("studio_id", studioId)
      .eq("appointment_type", "intro_lesson")
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(8),

    supabase
      .from("appointments")
      .select("*", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("appointment_type", "floor_space_rental")
      .gte("starts_at", todayStart)
      .lt("starts_at", todayEnd),

    supabase
      .from("client_memberships")
      .select(`
        id,
        client_id,
        status,
        current_period_end,
        name_snapshot,
        price_snapshot,
        billing_interval_snapshot,
        clients (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .in("status", ["active", "past_due", "unpaid"])
      .order("current_period_end", { ascending: true })
      .limit(25),

    supabase
      .from("payments")
      .select(`
        client_id,
        amount,
        created_at,
        payment_type,
        status,
        clients (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .eq("payment_type", "membership")
      .order("created_at", { ascending: false })
      .limit(75),
  ]);

  if (studioError || !studio) {
    throw new Error(`Failed to load studio: ${studioError?.message ?? "Studio not found"}`);
  }
  if (activeClientsError) {
    throw new Error(`Failed to load active client count: ${activeClientsError.message}`);
  }
  if (followUpsOpenError) {
    throw new Error(`Failed to load follow-up count: ${followUpsOpenError.message}`);
  }
  if (todayAppointmentsCountError) {
    throw new Error(`Failed to load today appointment count: ${todayAppointmentsCountError.message}`);
  }
  if (monthPaymentsError) {
    throw new Error(`Failed to load monthly payments: ${monthPaymentsError.message}`);
  }
  if (notificationsError) {
    throw new Error(`Failed to load notifications: ${notificationsError.message}`);
  }
  if (followUpsError) {
    throw new Error(`Failed to load follow-ups: ${followUpsError.message}`);
  }
  if (lowBalancesError) {
    throw new Error(`Failed to load low balances: ${lowBalancesError.message}`);
  }
  if (todayAppointmentsError) {
    throw new Error(`Failed to load today's appointments: ${todayAppointmentsError.message}`);
  }
  if (recentPaymentsError) {
    throw new Error(`Failed to load recent payments: ${recentPaymentsError.message}`);
  }
  if (recentSalesError) {
    throw new Error(`Failed to load recent package sales: ${recentSalesError.message}`);
  }
  if (publicIntroBookingsError) {
    throw new Error(`Failed to load public intro bookings: ${publicIntroBookingsError.message}`);
  }
  if (todayFloorRentalsCountError) {
    throw new Error(`Failed to load floor rental count: ${todayFloorRentalsCountError.message}`);
  }
  if (membershipOpsError) {
    throw new Error(`Failed to load membership operations data: ${membershipOpsError.message}`);
  }
  if (recentMembershipPaymentsError) {
    throw new Error(`Failed to load recent membership payments: ${recentMembershipPaymentsError.message}`);
  }

  const typedNotifications = (notifications ?? []) as NotificationRow[];
  const typedFollowUps = (followUps ?? []) as FollowUpRow[];
  const typedTodayAppointments = (todayAppointments ?? []) as TodayAppointmentRow[];
  const typedRecentPayments = (recentPayments ?? []) as PaymentRow[];
  const typedRecentSales = (recentSales ?? []) as RecentSaleRow[];
  const typedPublicIntroBookings = (publicIntroBookings ?? []) as PublicIntroBookingRow[];
  const typedMembershipOps = (membershipOps ?? []) as MembershipOpsRow[];
  const typedRecentMembershipPayments = (recentMembershipPayments ?? []) as DashboardMembershipPaymentRow[];

  const monthlyRevenue = (monthPayments ?? []).reduce(
    (sum, row) => sum + Number(row.amount ?? 0),
    0
  );

  const lowBalanceAlerts = ((lowBalances ?? []) as LowBalanceRow[]).filter((pkg) =>
    pkg.client_package_items.some(
      (item) =>
        !item.is_unlimited &&
        typeof item.quantity_remaining === "number" &&
        Number(item.quantity_remaining) <= 1
    )
  );

  const unreadNotifications = typedNotifications.filter((item) => !item.read_at);

  const latestMembershipPaymentByClientId = new Map<string, DashboardMembershipPaymentRow>();
  for (const payment of typedRecentMembershipPayments) {
    if (!latestMembershipPaymentByClientId.has(payment.client_id)) {
      latestMembershipPaymentByClientId.set(payment.client_id, payment);
    }
  }

  const openDelinquentMemberships = typedMembershipOps.filter(
    (membership) => membership.status === "past_due" || membership.status === "unpaid"
  );

  const recoveredMemberships = typedMembershipOps.filter((membership) => {
    const latestPayment = latestMembershipPaymentByClientId.get(membership.client_id);
    return looksRecoveredMembershipBilling(
      membership.status,
      latestPayment?.status ?? null
    );
  });

  const delinquentMembershipCount = openDelinquentMemberships.length;

  return (
    <div className="space-y-8">
            <div className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,rgba(255,255,255,0.96)_0%,rgba(255,249,243,0.98)_100%)] p-6 shadow-sm">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Studio Command Center
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[var(--brand-accent-soft)] px-3 py-1 text-xs font-medium text-[var(--brand-accent-dark)]">
                Active Workspace
              </span>

              <span className="rounded-full border border-[var(--brand-border)] bg-white px-3 py-1 text-xs font-medium text-slate-600">
                {currentRoleLabel}
              </span>

              {workspaceCount > 1 ? (
                <span className="rounded-full border border-[var(--brand-border)] bg-white px-3 py-1 text-xs font-medium text-slate-600">
                  {workspaceCount} studio workspaces
                </span>
              ) : null}
            </div>

            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--brand-text)] sm:text-4xl">
              {currentWorkspace?.studioPublicName?.trim() || studio.name}
            </h1>

            <p className="mt-3 max-w-2xl text-sm text-slate-600">
              Monitor urgent follow-ups, today’s activity, billing issues, recent recoveries, revenue,
              and floor rental operations from one place.
              {workspaceCount > 1
                ? " Use the workspace switcher in the sidebar to move between studio tenants without leaving the app."
                : ""}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/clients"
              className="rounded-2xl bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] px-4 py-2 text-white hover:brightness-105"
            >
              Find Client
            </Link>
            <Link
              href="/app/schedule/new"
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
            >
              Book Lesson
            </Link>
            <Link
              href="/app/events/new"
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
            >
              New Event/Class
            </Link>
            <Link
              href="/app/payments"
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
            >
              Take Payment
            </Link>
            <Link
              href="/app/memberships/sell"
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
            >
              Sell Membership
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <StatCard label="Active Clients" value={activeClients ?? 0} />
        <StatCard label="Open Follow-Ups" value={followUpsOpen ?? 0} />
        <StatCard label="Today’s Appointments" value={todayAppointmentsCount ?? 0} />
        <StatCard label="This Month Revenue" value={fmtCurrency(monthlyRevenue)} />
        <StatCard
          label="Membership Billing Issues"
          value={delinquentMembershipCount}
          subtext="Past due or unpaid"
        />
        <StatCard
          label="Workspaces"
          value={workspaceCount}
          subtext={workspaceCount > 1 ? "Switch from the sidebar" : "Single studio workspace"}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard
          title="Membership Billing Alerts"
          subtitle="Past due and unpaid memberships that need staff follow-up."
          action={
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              {delinquentMembershipCount} open
            </span>
          }
        >
          <div className="space-y-3">
            {openDelinquentMemberships.length === 0 ? (
              <p className="text-slate-500">No membership billing issues right now.</p>
            ) : (
              openDelinquentMemberships.map((membership) => {
                const latestPayment = latestMembershipPaymentByClientId.get(membership.client_id);

                return (
                  <Link
                    key={membership.id}
                    href={`/app/clients/${membership.client_id}`}
                    className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-[var(--brand-text)]">
                            {getClientName(membership.clients)}
                          </p>
                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${membershipStatusBadgeClass(
                              membership.status
                            )}`}
                          >
                            {membership.status.replaceAll("_", " ")}
                          </span>
                        </div>

                        <p className="mt-1 text-sm text-slate-600">
                          {membership.name_snapshot} • {fmtCurrency(membership.price_snapshot)} /{" "}
                          {billingIntervalLabel(membership.billing_interval_snapshot)}
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                          Current period end: {fmtDateOnly(membership.current_period_end)}
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                          Last membership payment:{" "}
                          {latestPayment
                            ? `${fmtCurrency(latestPayment.amount)} on ${fmtShortDateTime(
                                latestPayment.created_at
                              )}`
                            : "None recorded"}
                        </p>
                      </div>

                      <span className="text-sm underline">Open Client</span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Recent Billing Recoveries"
          subtitle="Memberships that appear to be back in good standing."
        >
          <div className="space-y-3">
            {recoveredMemberships.length === 0 ? (
              <p className="text-slate-500">No recent billing recoveries.</p>
            ) : (
              recoveredMemberships.slice(0, 5).map((membership) => {
                const latestPayment = latestMembershipPaymentByClientId.get(membership.client_id);

                return (
                  <Link
                    key={membership.id}
                    href={`/app/clients/${membership.client_id}`}
                    className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-[var(--brand-text)]">
                          {getClientName(membership.clients)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">{membership.name_snapshot}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          Latest payment:{" "}
                          {latestPayment
                            ? `${fmtCurrency(latestPayment.amount)} on ${fmtShortDateTime(
                                latestPayment.created_at
                              )}`
                            : "—"}
                        </p>
                      </div>

                      <span className="inline-flex rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700">
                        Recovered
                      </span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard
          title="Lead Follow-Up Alerts"
          subtitle="Open reminders and overdue follow-up work."
          action={
            <Link href="/app/leads" className="text-sm underline">
              View Leads
            </Link>
          }
        >
          <div className="space-y-3">
            {typedFollowUps.length ? (
              typedFollowUps.map((item) => {
                const overdue =
                  item.follow_up_due_at && new Date(item.follow_up_due_at) < new Date();

                return (
                  <Link
                    key={item.id}
                    href={`/app/clients/${item.client_id}`}
                    className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-[var(--brand-text)]">
                          {getClientName(item.clients)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">{item.note}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          {item.follow_up_due_at
                            ? `Due: ${fmtShortDateTime(item.follow_up_due_at)}`
                            : ""}
                        </p>
                      </div>

                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                          overdue
                            ? "bg-red-50 text-red-700"
                            : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {overdue ? "Overdue" : "Upcoming"}
                      </span>
                    </div>
                  </Link>
                );
              })
            ) : (
              <p className="text-slate-500">No open follow-up reminders.</p>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Notifications"
          subtitle="Recent internal alerts and booking signals."
          action={
            unreadNotifications.length > 0 ? (
              <form action={markAllNotificationsReadAction}>
                <button
                  type="submit"
                  className="rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm hover:bg-slate-50"
                >
                  Mark All Read
                </button>
              </form>
            ) : null
          }
        >
          <div className="space-y-3">
            {typedNotifications.length === 0 ? (
              <p className="text-slate-500">No notifications right now.</p>
            ) : (
              typedNotifications.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-xl border p-4 ${
                    item.read_at
                      ? "border-[var(--brand-border)] bg-slate-50"
                      : "border-[var(--brand-accent-dark)]/20 bg-[var(--brand-primary-soft)]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-[var(--brand-text)]">{item.title}</p>
                      {item.body ? (
                        <p className="mt-1 text-sm text-slate-600">{item.body}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-slate-500">
                        {fmtShortDateTime(item.created_at)}
                      </p>
                    </div>

                    {!item.read_at ? (
                      <form action={markNotificationReadAction}>
                        <input type="hidden" name="notificationId" value={item.id} />
                        <button type="submit" className="text-xs font-medium underline">
                          Mark Read
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard
          title="Recent Public Intro Bookings"
          subtitle="Upcoming intro bookings from the public flow."
          action={
            <Link href="/app/leads" className="text-sm underline">
              Review Leads
            </Link>
          }
        >
          <div className="space-y-3">
            {typedPublicIntroBookings.length === 0 ? (
              <p className="text-slate-500">No recent public intro bookings.</p>
            ) : (
              typedPublicIntroBookings.map((appointment) => {
                const client = Array.isArray(appointment.clients)
                  ? appointment.clients[0]
                  : appointment.clients;
                const isPublicIntro =
                  client?.referral_source === "public_intro_booking";

                return (
                  <Link
                    key={appointment.id}
                    href={
                      appointment.client_id
                        ? `/app/clients/${appointment.client_id}`
                        : "/app/schedule"
                    }
                    className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-[var(--brand-text)]">
                            {client
                              ? `${client.first_name} ${client.last_name}`
                              : "Unknown Client"}
                          </p>

                          {isPublicIntro ? (
                            <span className="inline-flex rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                              Public Intro
                            </span>
                          ) : null}
                        </div>

                        <p className="mt-1 text-sm text-slate-600">
                          {appointment.title || appointmentTypeLabel(appointment.appointment_type)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          {fmtShortDateTime(appointment.starts_at)}
                        </p>
                      </div>

                      <span className="text-sm underline">Open</span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Today’s Schedule"
          subtitle="Today’s appointments, lessons, and rentals."
          action={
            <Link href="/app/schedule" className="text-sm underline">
              Open Schedule
            </Link>
          }
        >
          <div className="space-y-3">
            {typedTodayAppointments.length === 0 ? (
              <p className="text-slate-500">No appointments today.</p>
            ) : (
              typedTodayAppointments.map((appointment) => (
                <Link
                  key={appointment.id}
                  href={`/app/schedule/${appointment.id}`}
                  className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-[var(--brand-text)]">
                          {appointment.title ||
                            appointmentTypeLabel(appointment.appointment_type)}
                        </p>
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${appointmentTypeBadgeClass(
                            appointment.appointment_type
                          )}`}
                        >
                          {appointmentTypeLabel(appointment.appointment_type)}
                        </span>
                      </div>

                      <p className="mt-1 text-sm text-slate-600">
                        {getClientName(appointment.clients)}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        {fmtShortDateTime(appointment.starts_at)}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        {appointment.appointment_type === "floor_space_rental"
                          ? getRoomName(appointment.rooms) === "No room"
                            ? "No room required"
                            : `Room: ${getRoomName(appointment.rooms)}`
                          : `${getInstructorName(appointment.instructors)} • ${getRoomName(
                              appointment.rooms
                            )}`}
                      </p>
                    </div>

                    <span className="text-sm underline">Open</span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard
          title="Floor Rental Activity"
          subtitle="Quick visibility into today’s floor rental operations."
          action={
            <Link
              href="/app/schedule/calendar?appointmentType=floor_space_rental"
              className="text-sm underline"
            >
              View Floor Rentals
            </Link>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-5">
              <p className="text-sm text-slate-500">Today’s Floor Rentals</p>
              <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">
                {todayFloorRentalsCount ?? 0}
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-5">
              <p className="text-sm text-slate-500">Quick Links</p>
              <div className="mt-3 flex flex-col gap-2">
                <Link href="/app/schedule?source=floor_rentals" className="text-sm underline">
                  Filtered Schedule View
                </Link>
                <Link
                  href="/app/schedule/calendar?appointmentType=floor_space_rental"
                  className="text-sm underline"
                >
                  Calendar View
                </Link>
              </div>
            </div>
          </div>
        </SectionCard>

      <SectionCard
        title="Recent Payments"
        subtitle="Most recent recorded payments across the studio."
        action={
          <Link href="/app/payments" className="text-sm underline">
            View Payments
          </Link>
        }
      >
        <div className="space-y-3">
          {typedRecentPayments.length === 0 ? (
            <p className="text-slate-500">No recent payments.</p>
          ) : (
            typedRecentPayments.map((payment) => (
              <Link
                key={payment.id}
                href={payment.client_id ? `/app/clients/${payment.client_id}` : "/app/payments"}
                className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-[var(--brand-text)]">
                      {getClientName(payment.clients)}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {fmtCurrency(Number(payment.amount ?? 0))} •{" "}
                      {paymentTypeLabel(payment.payment_type)} •{" "}
                      {paymentSourceLabel(payment.source)}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {fmtShortDateTime(payment.created_at)}
                    </p>
                  </div>

                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                      payment.status === "paid"
                        ? "bg-green-50 text-green-700"
                        : payment.status === "pending"
                        ? "bg-amber-50 text-amber-700"
                        : payment.status === "failed"
                        ? "bg-red-50 text-red-700"
                        : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {payment.status}
                  </span>
                </div>
              </Link>
            ))
          )}
        </div>
      </SectionCard>
    </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard
          title="Recent Package Sales"
          subtitle="Recently sold lesson packages."
          action={
            <Link href="/app/packages" className="text-sm underline">
              View Packages
            </Link>
          }
        >
          <div className="space-y-3">
            {typedRecentSales.length === 0 ? (
              <p className="text-slate-500">No recent package sales.</p>
            ) : (
              typedRecentSales.map((sale) => (
                <Link
                  key={sale.id}
                  href={`/app/clients/${sale.client_id}`}
                  className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-[var(--brand-text)]">
                        {getClientName(sale.clients)}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">{sale.name_snapshot}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        {fmtShortDateTime(sale.purchase_date)}
                      </p>
                    </div>

                    <p className="text-sm text-slate-500">Package sold</p>
                  </div>
                </Link>
              ))
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Low Balance Alerts"
          subtitle="Packages that are low or depleted."
          action={
            <Link href="/app/packages/client-balances" className="text-sm underline">
              View Balances
            </Link>
          }
        >
          <div className="space-y-3">
            {lowBalanceAlerts.length === 0 ? (
              <p className="text-slate-500">No low balances right now.</p>
            ) : (
              lowBalanceAlerts.slice(0, 10).map((pkg) => {
                const lowestFinite = pkg.client_package_items
                  .filter(
                    (item) =>
                      !item.is_unlimited &&
                      typeof item.quantity_remaining === "number"
                  )
                  .map((item) => Number(item.quantity_remaining ?? 0))
                  .sort((a, b) => a - b)[0];

                const critical = typeof lowestFinite === "number" && lowestFinite <= 0;

                return (
                  <Link
                    key={pkg.id}
                    href={`/app/clients/${pkg.client_id}`}
                    className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-[var(--brand-text)]">
                          {getClientName(pkg.clients)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">{pkg.name_snapshot}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          Lowest remaining balance:{" "}
                          {typeof lowestFinite === "number" ? lowestFinite : "—"}
                        </p>
                      </div>

                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                          critical
                            ? "bg-red-50 text-red-700"
                            : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {critical ? "Depleted" : "Low"}
                      </span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Quick Tools" subtitle="Fast paths into common daily workflows.">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Link
            href="/app/clients/new"
            className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
          >
            New Lead / Client
          </Link>
          <Link
            href="/app/schedule/new"
            className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
          >
            New Appointment
          </Link>
          <Link
            href="/app/packages/new-sale"
            className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
          >
            Sell Package
          </Link>
          <Link
            href="/app/memberships/sell"
            className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
          >
            Sell Membership
          </Link>
          <Link
            href="/app/events"
            className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
          >
            Events / Classes
          </Link>
          <Link
            href="/app/reports"
            className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
          >
            Reports
          </Link>
        </div>
      </SectionCard>
    </div>
  );
}