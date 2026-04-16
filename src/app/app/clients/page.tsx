import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
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
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Clients</h2>
          <p className="mt-2 text-slate-600">
            Manage client records, leads, statuses, and contact details.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/leads"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Leads
          </Link>

          <Link
            href="/app/clients/new"
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            New Client
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Visible Clients</p>
          <p className="mt-2 text-3xl font-semibold">{typedClients.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-semibold">{activeCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Leads</p>
          <p className="mt-2 text-3xl font-semibold">{leadCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Inactive / Archived</p>
          <p className="mt-2 text-3xl font-semibold">{inactiveCount + archivedCount}</p>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-5">
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
          <div className="rounded-2xl border bg-white p-8 text-center text-slate-500">
            No clients match your current filters.
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