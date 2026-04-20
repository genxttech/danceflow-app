import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import EventForm from "../EventForm";

type OrganizerOption = {
  id: string;
  name: string;
  active: boolean;
};

export default async function NewEventPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const { data: organizers, error: organizersError } = await supabase
    .from("organizers")
    .select("id, name, active")
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("name", { ascending: true });

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  const typedOrganizers = (organizers ?? []) as OrganizerOption[];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">New Event</h2>
          <p className="mt-2 text-slate-600">
            Create an organizer-linked event and optionally publish it into the public dance directory.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/events"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Events
          </Link>
        </div>
      </div>

      {typedOrganizers.length === 0 ? (
        <div className="rounded-2xl border bg-white p-8 text-center">
          <p className="text-base font-medium text-slate-900">
            Create an organizer first
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Public events in the dance directory must belong to an organizer.
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
        <EventForm
  mode="create"
  organizers={typedOrganizers}
  initialValues={{
    visibility: "public",
    publicDirectoryEnabled: false,
    beginnerFriendly: false,
    waitlistEnabled: false,
  }}
/>
      )}
    </div>
  );
}