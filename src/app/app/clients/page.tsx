import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Filter, Sparkles, Users, UserRoundCheck, UserRoundX } from "lucide-react";
import { archiveClientAction } from "./actions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type SearchParams = Promise<{
  status?: string;
  q?: string;
}>;

type ClientRow = {
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
};

function statusBadgeClass(status: string) {
  if (status === "lead") return "bg-blue-50 text-blue-700";
  if (status === "contacted") return "bg-amber-50 text-amber-700";
  if (status === "consultation_booked") return "bg-purple-50 text-purple-700";
  if (status === "converted") return "bg-green-50 text-green-700";
  if (status === "lost") return "bg-red-50 text-red-700";
  if (status === "active") return "bg-green-50 text-green-700";
  if (status === "inactive") return "bg-slate-100 text-slate-700";
  if (status === "archived") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

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
    .order("created_at", { ascending: false });

  if (selectedStatus) {
    query = query.eq("status", selectedStatus);
  }

  const { data: clients, error } = await query;

  if (error) {
    throw new Error(`Failed to load clients: ${error.message}`);
  }

  const typedClients = ((clients ?? []) as ClientRow[]).filter((client) => {
    if (!queryText) return true;

    const haystack = [
      client.first_name,
      client.last_name,
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
  });

  const activeCount = typedClients.filter((client) => client.status === "active").length;
  const leadCount = typedClients.filter((client) => client.status === "lead").length;
  const inactiveCount = typedClients.filter((client) => client.status === "inactive").length;
  const archivedCount = typedClients.filter((client) => client.status === "archived").length;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Clients
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Client Relationship Workspace
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Manage leads, active clients, communication details, and lifecycle status from one branded studio workspace.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/leads"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Leads
              </Link>

              <Link
                href="/app/clients/new"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                New Client
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">Lead-to-client visibility</h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Keep inquiry traffic, active students, and lifecycle follow-up visible from the same operating view.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">Clear front desk workflow</h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Make it easy for staff to search records, open client details, and move quickly into sales and service tasks.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">Status-driven management</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Track lead conversion, inactive clients, and archived records without losing the operational picture.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Visible Clients" value={typedClients.length} icon={Users} />
        <StatCard label="Active" value={activeCount} icon={UserRoundCheck} />
        <StatCard label="Leads" value={leadCount} icon={Sparkles} />
        <StatCard label="Inactive / Archived" value={inactiveCount + archivedCount} icon={UserRoundX} />
      </div>

      <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Filter className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Filter the client list</h2>
            <p className="mt-1 text-sm text-slate-500">
              Search by name, contact info, interests, referral source, or narrow the list by lifecycle status.
            </p>
          </div>
        </div>

        <form method="get" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[1.6fr_320px_auto]">
            <div>
              <label htmlFor="q" className="mb-1 block text-sm font-medium">
                Search Clients
              </label>
              <input
                id="q"
                name="q"
                defaultValue={resolvedSearchParams.q ?? ""}
                placeholder="Name, email, phone, interests, referral..."
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label htmlFor="status" className="mb-1 block text-sm font-medium">
                Filter by Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={selectedStatus}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                {statusOptions.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end gap-2">
              <button
                type="submit"
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                Apply
              </button>

              <Link
                href="/app/clients"
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Reset
              </Link>
            </div>
          </div>
        </form>
      </div>

      <div className="space-y-4">
        {typedClients.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-slate-500 shadow-sm">
            <p className="text-base font-medium text-slate-900">No clients match your current filters.</p>
            <p className="mt-2 text-sm text-slate-500">
              Adjust the search or status filter to broaden the results.
            </p>
          </div>
        ) : (
          typedClients.map((client) => (
            <div
              key={client.id}
              className="rounded-2xl border bg-white p-5 shadow-sm"
            >
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      href={`/app/clients/${client.id}`}
                      className="text-lg font-semibold text-slate-900 hover:underline"
                    >
                      {client.first_name} {client.last_name}
                    </Link>

                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                        client.status
                      )}`}
                    >
                      {client.status}
                    </span>

                    {client.skill_level ? (
                      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                        {client.skill_level}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2 2xl:grid-cols-4">
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-wide text-slate-400">Email</p>
                      <p className="mt-1 break-words text-sm font-medium text-slate-900">
                        {client.email ?? "—"}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-wide text-slate-400">Phone</p>
                      <p className="mt-1 break-words text-sm font-medium text-slate-900">
                        {client.phone ?? "—"}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        Dance Interests
                      </p>
                      <p className="mt-1 break-words text-sm font-medium text-slate-900">
                        {client.dance_interests ?? "—"}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        Referral Source
                      </p>
                      <p className="mt-1 break-words text-sm font-medium text-slate-900">
                        {client.referral_source ?? "—"}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-3 xl:justify-end">
                  <Link
                    href={`/app/clients/${client.id}`}
                    className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                  >
                    View
                  </Link>

                  <Link
                    href={`/app/clients/${client.id}/edit`}
                    className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                  >
                    Edit
                  </Link>

                  {client.status !== "archived" ? (
                    <form action={archiveClientAction}>
                      <input type="hidden" name="clientId" value={client.id} />
                      <button
                        type="submit"
                        className="rounded-xl border border-red-200 px-4 py-2 text-red-700 hover:bg-red-50"
                      >
                        Archive
                      </button>
                    </form>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}