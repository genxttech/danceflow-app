import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  contact_email: string | null;
  city: string | null;
  state: string | null;
  active: boolean;
  created_at: string;
};

function activeBadgeClass(active: boolean) {
  return active
    ? "bg-green-50 text-green-700"
    : "bg-slate-100 text-slate-700";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function OrganizersPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    redirect("/login");
  }

  const studioId = roleRow.studio_id as string;

  const { data: organizers, error: organizersError } = await supabase
    .from("organizers")
    .select(`
      id,
      name,
      slug,
      description,
      contact_email,
      city,
      state,
      active,
      created_at
    `)
    .eq("studio_id", studioId)
    .order("name", { ascending: true });

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const activeCount = typedOrganizers.filter((item) => item.active).length;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Organizers</h2>
          <p className="mt-2 text-slate-600">
            Manage organizer profiles that own and publish events.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Dashboard
          </Link>

          <Link
            href="/app/organizers/new"
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            New Organizer
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Total Organizers</p>
          <p className="mt-2 text-3xl font-semibold">{typedOrganizers.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Active Organizers</p>
          <p className="mt-2 text-3xl font-semibold">{activeCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Event Module</p>
          <p className="mt-2 text-xl font-semibold">Phase 1</p>
        </div>
      </div>

      <div className="rounded-2xl border bg-white shadow-sm">
        <div className="border-b px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-900">
            Organizer Profiles
          </h3>
        </div>

        {typedOrganizers.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-base font-medium text-slate-900">
              No organizers yet
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Create your first organizer before publishing events.
            </p>

            <div className="mt-6">
              <Link
                href="/app/organizers/new"
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                Create Organizer
              </Link>
            </div>
          </div>
        ) : (
          <div className="divide-y">
            {typedOrganizers.map((organizer) => (
              <div key={organizer.id} className="px-6 py-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-lg font-semibold text-slate-900">
                        {organizer.name}
                      </h4>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${activeBadgeClass(
                          organizer.active
                        )}`}
                      >
                        {organizer.active ? "Active" : "Inactive"}
                      </span>
                    </div>

                    <p className="mt-2 text-sm text-slate-500">
                      /organizers/{organizer.slug}
                    </p>

                    {organizer.description ? (
                      <p className="mt-2 max-w-2xl text-sm text-slate-600">
                        {organizer.description}
                      </p>
                    ) : null}

                    <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-500">
                      <span>
                        {organizer.city || organizer.state
                          ? [organizer.city, organizer.state].filter(Boolean).join(", ")
                          : "No location"}
                      </span>
                      <span>{organizer.contact_email || "No contact email"}</span>
                    </div>
                  </div>

                  <div className="shrink-0 text-left lg:text-right">
                    <p className="text-sm text-slate-500">Created</p>
                    <p className="mt-1 font-medium text-slate-900">
                      {formatDateTime(organizer.created_at)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}