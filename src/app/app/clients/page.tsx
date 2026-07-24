import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import {
  Search,
  Sparkles,
  UserRoundCheck,
  UserRoundX,
  Users,
} from "lucide-react";
import CompactSummaryStrip from "@/components/app/workspace/CompactSummaryStrip";
import WorkspaceEmptyState from "@/components/app/workspace/WorkspaceEmptyState";
import WorkspaceHeader from "@/components/app/workspace/WorkspaceHeader";
import WorkspaceToolbar from "@/components/app/workspace/WorkspaceToolbar";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import ClientWorkspaceList from "./ClientWorkspaceList";
import { deriveClientLifecycle, type ClientLifecycleStage, type ClientLifecycleRisk } from "@/lib/clients/lifecycle";

type SearchParams = Promise<{
  status?: string;
  q?: string;
}>;

export type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  skill_level: string | null;
  dance_interests: string | null;
  referral_source: string | null;
  created_at: string;
  lifecycle_stage: ClientLifecycleStage;
  lifecycle_label: string;
  lifecycle_description: string;
  lifecycle_last_activity_at: string | null;
  lifecycle_next_step: string;
  lifecycle_risk: ClientLifecycleRisk;
  lifecycle_risk_reason: string | null;
};


const statusOptions = [
  { value: "", label: "All statuses" },
  { value: "lead", label: "Lead" },
  { value: "contacted", label: "Contacted" },
  { value: "consultation_booked", label: "Consultation Booked" },
  { value: "converted", label: "Converted" },
  { value: "lost", label: "Lost" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "archived", label: "Archived" },
];

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const resolvedSearchParams = await searchParams;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;
  const selectedStatus = resolvedSearchParams.status ?? "";
  const queryText = (resolvedSearchParams.q ?? "").trim().toLowerCase();

  let query = supabase
    .from("clients")
    .select(`
      id,
      first_name,
      last_name,
      email,
      phone,
      status,
      skill_level,
      dance_interests,
      referral_source,
      created_at
    `)
    .eq("studio_id", studioId)
    .order("first_name", { ascending: true })
    .order("last_name", { ascending: true })
    .order("created_at", { ascending: true });

  if (selectedStatus) {
    query = query.eq("status", selectedStatus);
  }

  const { data: clients, error } = await query;

  if (error) {
    throw new Error(`Failed to load clients: ${error.message}`);
  }

  const baseClients = (clients ?? []) as Array<Omit<ClientRow,
    | "lifecycle_stage"
    | "lifecycle_label"
    | "lifecycle_description"
    | "lifecycle_last_activity_at"
    | "lifecycle_next_step"
    | "lifecycle_risk"
    | "lifecycle_risk_reason"
  >>;
  const clientIds = baseClients.map((client) => client.id);

  const [
    { data: lifecycleAppointments, error: lifecycleAppointmentsError },
    { data: lifecyclePackages, error: lifecyclePackagesError },
    { data: lifecycleMemberships, error: lifecycleMembershipsError },
    { data: lifecyclePayments, error: lifecyclePaymentsError },
    { data: lifecycleActivities, error: lifecycleActivitiesError },
  ] = clientIds.length
    ? await Promise.all([
        supabase
          .from("appointments")
          .select("client_id, appointment_type, status, starts_at")
          .eq("studio_id", studioId)
          .in("client_id", clientIds)
          .order("starts_at", { ascending: false }),
        supabase
          .from("client_packages")
          .select("client_id, active, purchase_date, created_at")
          .eq("studio_id", studioId)
          .in("client_id", clientIds),
        supabase
          .from("client_memberships")
          .select("client_id, status, starts_on, created_at, cancel_at_period_end")
          .eq("studio_id", studioId)
          .in("client_id", clientIds),
        supabase
          .from("payments")
          .select("client_id, status, created_at, payment_type")
          .eq("studio_id", studioId)
          .in("client_id", clientIds),
        supabase
          .from("lead_activities")
          .select("client_id, created_at, activity_type, follow_up_due_at, completed_at")
          .eq("studio_id", studioId)
          .in("client_id", clientIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];

  if (lifecycleAppointmentsError) {
    throw new Error(`Failed to load lifecycle appointments: ${lifecycleAppointmentsError.message}`);
  }
  if (lifecyclePackagesError) {
    throw new Error(`Failed to load lifecycle packages: ${lifecyclePackagesError.message}`);
  }
  if (lifecycleMembershipsError) {
    throw new Error(`Failed to load lifecycle memberships: ${lifecycleMembershipsError.message}`);
  }
  if (lifecyclePaymentsError) {
    throw new Error(`Failed to load lifecycle payments: ${lifecyclePaymentsError.message}`);
  }
  if (lifecycleActivitiesError) {
    throw new Error(`Failed to load lifecycle activities: ${lifecycleActivitiesError.message}`);
  }

  function rowsForClient<T extends { client_id: string | null }>(
    rows: T[] | null,
    clientId: string,
  ) {
    return (rows ?? []).filter((row) => row.client_id === clientId);
  }

  const clientsWithLifecycle: ClientRow[] = baseClients.map((client) => {
    const lifecycle = deriveClientLifecycle({
      clientStatus: client.status,
      createdAt: client.created_at,
      appointments: rowsForClient(
        lifecycleAppointments as Array<{
          client_id: string | null;
          appointment_type: string;
          status: string;
          starts_at: string;
        }> | null,
        client.id,
      ),
      packages: rowsForClient(
        lifecyclePackages as Array<{
          client_id: string | null;
          active: boolean;
          purchase_date: string | null;
          created_at: string | null;
        }> | null,
        client.id,
      ),
      memberships: rowsForClient(
        lifecycleMemberships as Array<{
          client_id: string | null;
          status: string;
          starts_on: string | null;
          created_at: string | null;
          cancel_at_period_end: boolean | null;
        }> | null,
        client.id,
      ),
      payments: rowsForClient(
        lifecyclePayments as Array<{
          client_id: string | null;
          status: string;
          created_at: string;
          payment_type: string | null;
        }> | null,
        client.id,
      ),
      leadActivities: rowsForClient(
        lifecycleActivities as Array<{
          client_id: string | null;
          created_at: string;
          activity_type: string | null;
          follow_up_due_at: string | null;
          completed_at: string | null;
        }> | null,
        client.id,
      ),
    });

    return {
      ...client,
      lifecycle_stage: lifecycle.stage,
      lifecycle_label: lifecycle.label,
      lifecycle_description: lifecycle.description,
      lifecycle_last_activity_at: lifecycle.lastMeaningfulActivityAt,
      lifecycle_next_step: lifecycle.nextExpectedStep,
      lifecycle_risk: lifecycle.risk,
      lifecycle_risk_reason: lifecycle.riskReason,
    };
  });

  const typedClients = clientsWithLifecycle
    .filter((client) => {
      if (!queryText) return true;

      const haystack = [
        client.first_name,
        client.last_name,
        `${client.first_name} ${client.last_name}`,
        `${client.last_name} ${client.first_name}`,
        client.email ?? "",
        client.phone ?? "",
        client.dance_interests ?? "",
        client.referral_source ?? "",
        client.skill_level ?? "",
        client.status,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(queryText);
    })
    .sort((a, b) => {
      const firstNameCompare = a.first_name.localeCompare(b.first_name, undefined, {
        sensitivity: "base",
      });

      if (firstNameCompare !== 0) return firstNameCompare;

      const lastNameCompare = a.last_name.localeCompare(b.last_name, undefined, {
        sensitivity: "base",
      });

      if (lastNameCompare !== 0) return lastNameCompare;

      return a.created_at.localeCompare(b.created_at);
    });

  const activeCount = typedClients.filter((client) =>
    ["active_student", "new_student", "recovered"].includes(client.lifecycle_stage)
  ).length;
  const leadCount = typedClients.filter((client) =>
    ["new_lead", "contacted", "intro_scheduled", "conversion_pending"].includes(
      client.lifecycle_stage,
    )
  ).length;
  const rebookingCount = typedClients.filter(
    (client) => client.lifecycle_stage === "needs_rebooking",
  ).length;
  const riskCount = typedClients.filter(
    (client) => client.lifecycle_stage === "retention_risk",
  ).length;
  const filtersApplied = Boolean(selectedStatus || queryText);

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.08),transparent_28%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.09),transparent_26%),linear-gradient(180deg,#fff7ed_0%,var(--brand-surface)_30%,#ffffff_100%)]">
      <section className="border-b border-orange-200/70 bg-[linear-gradient(180deg,rgba(255,247,237,0.95)_0%,rgba(255,255,255,0.98)_70%)]">
        <WorkspaceHeader
          eyebrow="Studio relationships"
          title="Clients"
          description="Search, review, and act on client relationships without losing your place."
          actions={
            <>
              <Link
                href="/app/leads"
                className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
              >
                Leads
              </Link>
              <Link
                href="/app/clients/new"
                className="rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-110"
              >
                New client
              </Link>
            </>
          }
        />

        <CompactSummaryStrip
          items={[
            {
              key: "visible",
              label: "Visible",
              value: typedClients.length,
              detail: filtersApplied ? "Matching filters" : "Client records",
            },
            {
              key: "active",
              label: "Active",
              value: activeCount,
              detail: "Current clients",
              tone: activeCount > 0 ? "success" : "default",
            },
            {
              key: "leads",
              label: "Leads",
              value: leadCount,
              detail: "Needs conversion",
              tone: leadCount > 0 ? "info" : "default",
            },
            {
              key: "rebooking",
              label: "Needs rebooking",
              value: rebookingCount,
              detail: "Recent clients without a next visit",
              tone: rebookingCount > 0 ? "warning" : "default",
            },
            {
              key: "risk",
              label: "Retention risk",
              value: riskCount,
              detail: "Needs recovery attention",
              tone: riskCount > 0 ? "danger" : "default",
            },
          ]}
        />

        <form method="get" className="border-t border-[var(--brand-border)]">
          <WorkspaceToolbar
            primary={
              <label className="relative block">
                <span className="sr-only">Search clients</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--brand-muted)]" />
                <input
                  id="q"
                  name="q"
                  defaultValue={resolvedSearchParams.q ?? ""}
                  placeholder="Search name, email, phone, interests, or referral..."
                  className="w-full rounded-xl border border-[var(--brand-border)] bg-white py-2 pl-9 pr-3 text-sm text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                />
              </label>
            }
            filters={
              <select
                id="status"
                name="status"
                aria-label="Filter clients by status"
                defaultValue={selectedStatus}
                className="rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
              >
                {statusOptions.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            }
            actions={
              <>
                <button
                  type="submit"
                  className="rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-110"
                >
                  Apply
                </button>
                {filtersApplied ? (
                  <Link
                    href="/app/clients"
                    className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
                  >
                    Clear
                  </Link>
                ) : null}
              </>
            }
          />
        </form>
      </section>

      <section className="p-4 sm:p-6 lg:p-8">
        <div className="overflow-hidden rounded-3xl border border-violet-200/70 bg-white shadow-[0_18px_50px_rgba(76,29,149,0.08)]">
          <div className="flex items-center justify-between border-b border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_70%,#ffffff_100%)] px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-semibold text-[var(--brand-text)]">Client records</h2>
              <p className="mt-0.5 text-xs text-[var(--brand-muted)]">
                Compact rows keep contact details and lifecycle status visible.
              </p>
            </div>
            <span className="rounded-full bg-[var(--brand-primary-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--brand-primary)]">
              {typedClients.length}
            </span>
          </div>

          {typedClients.length === 0 ? (
            <WorkspaceEmptyState
              icon={<Users className="h-5 w-5" />}
              title={filtersApplied ? "No clients match these filters" : "No clients yet"}
              description={
                filtersApplied
                  ? "Clear or adjust the current search and status filters."
                  : "Add the first client to begin building your studio relationship workspace."
              }
              action={
                filtersApplied ? (
                  <Link
                    href="/app/clients"
                    className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)]"
                  >
                    Clear filters
                  </Link>
                ) : (
                  <Link
                    href="/app/clients/new"
                    className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white"
                  >
                    Add client
                  </Link>
                )
              }
            />
          ) : (
            <ClientWorkspaceList clients={typedClients} />
          )}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Link
            href="/app/leads"
            className="flex items-center gap-3 rounded-2xl border border-[var(--brand-border)] bg-white p-4 text-sm font-semibold text-[var(--brand-text)] shadow-sm hover:bg-[var(--brand-primary-soft)]"
          >
            <Sparkles className="h-4 w-4 text-sky-700" />
            Review lead pipeline
          </Link>
          <Link
            href="/app/clients?status=active"
            className="flex items-center gap-3 rounded-2xl border border-[var(--brand-border)] bg-white p-4 text-sm font-semibold text-[var(--brand-text)] shadow-sm hover:bg-[var(--brand-primary-soft)]"
          >
            <UserRoundCheck className="h-4 w-4 text-emerald-700" />
            View active clients
          </Link>
          <Link
            href="/app/clients?status=inactive"
            className="flex items-center gap-3 rounded-2xl border border-[var(--brand-border)] bg-white p-4 text-sm font-semibold text-[var(--brand-text)] shadow-sm hover:bg-[var(--brand-primary-soft)]"
          >
            <UserRoundX className="h-4 w-4 text-amber-700" />
            Review inactive clients
          </Link>
        </div>
      </section>
    </main>
  );
}
