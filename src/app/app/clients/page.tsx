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
  if (status === "lead") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "contacted") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "consultation_booked") return "border-violet-200 bg-violet-50 text-violet-700";
  if (status === "converted") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "lost") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "active") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "inactive") return "border-slate-200 bg-slate-100 text-slate-700";
  if (status === "archived") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function statusLabel(status: string) {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function initialsFor(client: Pick<ClientRow, "first_name" | "last_name">) {
  return `${client.first_name.charAt(0)}${client.last_name.charAt(0)}`.toUpperCase();
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
    <div className="rounded-3xl border border-[var(--brand-border)] bg-white/90 p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)] ring-1 ring-[var(--brand-border)]">
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

  const typedClients = ((clients ?? []) as ClientRow[])
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

  if (firstNameCompare !== 0) {
    return firstNameCompare;
  }

  const lastNameCompare = a.last_name.localeCompare(b.last_name, undefined, {
    sensitivity: "base",
  });

  if (lastNameCompare !== 0) {
    return lastNameCompare;
  }

  return a.created_at.localeCompare(b.created_at);
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

      <div className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
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
                className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-slate-900 outline-none transition focus:border-[var(--brand-primary)] focus:bg-white focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
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
                className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-slate-900 outline-none transition focus:border-[var(--brand-primary)] focus:bg-white focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
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
                className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 font-medium text-white hover:opacity-90"
              >
                Apply
              </button>

              <Link
                href="/app/clients"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
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
              className="group overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--brand-border)] hover:shadow-md"
            >
              <div className="h-1.5 bg-[linear-gradient(90deg,var(--brand-primary)_0%,#7c3aed_48%,#f97316_100%)]" />
              <div className="p-5">
                <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                  <div className="flex min-w-0 gap-4">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] text-lg font-semibold text-white shadow-sm">
                      {initialsFor(client)}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-3">
                        <Link
                          href={`/app/clients/${client.id}`}
                          className="text-xl font-semibold tracking-tight text-slate-950 hover:text-[var(--brand-primary)]"
                        >
                          {client.first_name} {client.last_name}
                        </Link>

                        <span
                          className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${statusBadgeClass(
                            client.status
                          )}`}
                        >
                          {statusLabel(client.status)}
                        </span>

                        {client.skill_level ? (
                          <span className="inline-flex rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                            {client.skill_level}
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
                        <div className="min-w-0 rounded-2xl border border-slate-100 bg-slate-50/80 p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Email</p>
                          <p className="mt-1 break-words text-sm font-semibold text-slate-900">
                            {client.email ?? "Not added"}
                          </p>
                        </div>

                        <div className="min-w-0 rounded-2xl border border-slate-100 bg-slate-50/80 p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Phone</p>
                          <p className="mt-1 break-words text-sm font-semibold text-slate-900">
                            {client.phone ?? "Not added"}
                          </p>
                        </div>

                        <div className="min-w-0 rounded-2xl border border-orange-100 bg-orange-50/70 p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-500">
                            Dance Interests
                          </p>
                          <p className="mt-1 break-words text-sm font-semibold text-orange-950">
                            {client.dance_interests ?? "Not added"}
                          </p>
                        </div>

                        <div className="min-w-0 rounded-2xl border border-violet-100 bg-violet-50/70 p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-500">
                            Referral Source
                          </p>
                          <p className="mt-1 break-words text-sm font-semibold text-violet-950">
                            {client.referral_source ?? "Not added"}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3 xl:justify-end">
                    <Link
                      href={`/app/clients/${client.id}`}
                      className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
                    >
                      View
                    </Link>

                    <Link
                      href={`/app/clients/${client.id}/edit`}
                      className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                    >
                      Edit
                    </Link>

                    {client.status !== "archived" ? (
                      <form action={archiveClientAction}>
                        <input type="hidden" name="clientId" value={client.id} />
                        <button
                          type="submit"
                          className="rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                        >
                          Archive
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
