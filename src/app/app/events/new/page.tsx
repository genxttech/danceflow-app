import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import EventForm from "../EventForm";
import { getCurrentWorkspaceCapabilitiesForUser } from "@/lib/billing/access";
import { COMPETITIONS_HREF } from "@/lib/competition/workspaceLink";

type OrganizerOption = {
  id: string;
  name: string;
  active: boolean;
};

type WorkspaceRow = {
  id: string;
  name: string | null;
  public_name: string | null;
};

function isOrganizerWorkspaceRole(role: string | null | undefined) {
  return role === "organizer_owner" || role === "organizer_admin";
}

function canManageEvents(
  role: string | null | undefined,
  isPlatformAdminRole: boolean,
) {
  if (isPlatformAdminRole) return true;

  return (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "organizer_owner" ||
    role === "organizer_admin"
  );
}

function canManageOrganizers(
  role: string | null | undefined,
  isPlatformAdminRole: boolean,
) {
  if (isPlatformAdminRole) return true;
  return role === "organizer_owner" || role === "organizer_admin";
}

export default async function NewEventPage({
  searchParams,
}: {
  searchParams?: Promise<{ type?: string }>;
}) {
  // 10C.1: Competitions -> New Competition opens this same form preselected to Competition.
  const startAsCompetition = (await searchParams)?.type === "competition";
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  if (!canManageEvents(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app/events");
  }

  const [
    { error: workspaceError },
    { data: organizers, error: organizersError },
    capabilities,
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, public_name")
      .eq("id", studioId)
      .maybeSingle<WorkspaceRow>(),

    supabase
      .from("organizers")
      .select("id, name, active")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),

    getCurrentWorkspaceCapabilitiesForUser(),
  ]);

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  const organizerWorkspace = isOrganizerWorkspaceRole(context.studioRole);
  const studioHostedEvents =
    !organizerWorkspace && Boolean(capabilities?.canCreateBasicEventListings);
  const eventCommerceEnabled = Boolean(
    context.isPlatformAdmin ||
    organizerWorkspace ||
    capabilities?.hasOrganizerSuite ||
    capabilities?.canUseEventCommerce ||
    capabilities?.canUseEventOperations,
  );
  const canCreateOrganizer = canManageOrganizers(
    context.studioRole,
    context.isPlatformAdmin,
  );

  const typedOrganizers = (organizers ?? []) as OrganizerOption[];
  const singleOrganizer = typedOrganizers[0] ?? null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-1 pb-10">
      <header className="space-y-2">
        <Link
          href={startAsCompetition ? COMPETITIONS_HREF : "/app/events"}
          className="text-sm font-medium text-slate-600 hover:text-slate-950"
        >
          {startAsCompetition ? "Back to Competitions" : "Back to Events"}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
          {startAsCompetition ? "New Competition" : "New Event"}
        </h1>
        <p className="text-sm leading-6 text-slate-600">
          {startAsCompetition
            ? "Start with the basics. Competition setup comes next."
            : organizerWorkspace
              ? "Create an Organizer Suite event under your organizer profile."
              : studioHostedEvents
                ? "Create an event hosted by your studio."
                : "Create an event and choose who can find it."}
        </p>
      </header>

      {typedOrganizers.length === 0 && !studioHostedEvents ? (
        <div className="rounded-[32px] border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-base font-medium text-slate-900">
            Create an organizer first
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Public events in the dance directory must belong to an organizer.
          </p>

          {canCreateOrganizer ? (
            <div className="mt-6">
              <Link
                href="/app/organizers/new"
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                Create Organizer
              </Link>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-6">
          <EventForm
            mode="create"
            organizers={typedOrganizers}
            organizerWorkspace={organizerWorkspace}
            eventCommerceEnabled={eventCommerceEnabled}
            initialValues={{
              organizerId:
                organizerWorkspace && singleOrganizer
                  ? singleOrganizer.id
                  : undefined,
              visibility: "public",
              ...(startAsCompetition ? { eventType: "competition" } : {}),
              publicDirectoryEnabled: false,
              beginnerFriendly: false,
              waitlistEnabled: false,
            }}
          />
        </div>
      )}
    </div>
  );
}
