import AppointmentCreateForm from "./AppointmentCreateForm";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type SearchParams = Promise<{
  clientId?: string;
}>;

type MembershipBenefit = {
  membership_plan_id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string;
  applies_to: string | null;
};

type ClientRelationshipRow = {
  client_id: string;
  related_client_id: string;
  relationship_type: string;
};

type ClientOption = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
};

type InstructorOption = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  active: boolean | null;
};

type RoomOption = {
  id: string;
  name: string;
  active: boolean | null;
};

type ClientPackageItemRow = {
  usage_type: string | null;
  quantity_remaining: number | null;
  quantity_total: number | null;
  is_unlimited: boolean | null;
};

type ClientPackageRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  active: boolean | null;
  expiration_date: string | null;
  client_package_items: ClientPackageItemRow[] | null;
};

type ClientMembershipRow = {
  id: string;
  client_id: string | null;
  membership_plan_id: string;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  auto_renew: boolean | null;
  cancel_at_period_end: boolean | null;
  name_snapshot: string | null;
  price_snapshot: number | null;
  billing_interval_snapshot: string | null;
};

type LinkedHostStudioRoomRow = {
  id: string;
  name: string;
  active: boolean | null;
};

type LinkedHostStudioRow = {
  id: string;
  slug: string;
  name: string | null;
  public_name: string | null;
  rooms: LinkedHostStudioRoomRow[];
};

export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const context = await getCurrentStudioContext();
  const { studioId } = context;
  const supabase = await createClient();
  const resolvedSearchParams = (await searchParams) ?? {};

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const requestedClientId =
    typeof resolvedSearchParams.clientId === "string"
      ? resolvedSearchParams.clientId
      : "";

  const [
    { data: clients, error: clientsError },
    { data: instructors, error: instructorsError },
    { data: rooms, error: roomsError },
    { data: clientPackages, error: clientPackagesError },
    { data: clientMemberships, error: clientMembershipsError },
    { data: clientRelationships, error: clientRelationshipsError },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, first_name, last_name, status")
      .eq("studio_id", studioId)
      .order("first_name", { ascending: true }),

    supabase
      .from("instructors")
      .select("id, first_name, last_name, active")
      .eq("studio_id", studioId)
      .order("first_name", { ascending: true }),

    supabase
      .from("rooms")
      .select("id, name, active")
      .eq("studio_id", studioId)
      .order("name", { ascending: true }),

    supabase
      .from("client_packages")
      .select(`
        id,
        client_id,
        name_snapshot,
        active,
        expiration_date,
        client_package_items (
          usage_type,
          quantity_remaining,
          quantity_total,
          is_unlimited
        )
      `)
      .eq("studio_id", studioId)
      .order("purchase_date", { ascending: false }),

    supabase
      .from("client_memberships")
      .select(`
        id,
        client_id,
        membership_plan_id,
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
      `)
      .eq("studio_id", studioId)
      .in("status", ["active", "past_due", "cancel_scheduled"])
      .order("created_at", { ascending: false }),

    supabase
      .from("client_relationships")
      .select("client_id, related_client_id, relationship_type")
      .eq("studio_id", studioId)
      .in("relationship_type", ["partner", "spouse"]),
  ]);

  if (clientsError) {
    throw new Error(`Failed to load clients: ${clientsError.message}`);
  }

  if (instructorsError) {
    throw new Error(`Failed to load instructors: ${instructorsError.message}`);
  }

  if (roomsError) {
    throw new Error(`Failed to load rooms: ${roomsError.message}`);
  }

  if (clientPackagesError) {
    throw new Error(`Failed to load client packages: ${clientPackagesError.message}`);
  }

  if (clientMembershipsError) {
    throw new Error(
      `Failed to load client memberships: ${clientMembershipsError.message}`
    );
  }

  if (clientRelationshipsError) {
    throw new Error(
      `Failed to load client relationships: ${clientRelationshipsError.message}`
    );
  }

  const membershipPlanIds = Array.from(
    new Set(
      ((clientMemberships ?? []) as ClientMembershipRow[])
        .map((membership) => membership.membership_plan_id)
        .filter(Boolean)
    )
  );

  let membershipBenefits: MembershipBenefit[] = [];

  if (membershipPlanIds.length > 0) {
    const { data: membershipBenefitsData, error: membershipBenefitsError } =
      await supabase
        .from("membership_plan_benefits")
        .select(`
          membership_plan_id,
          benefit_type,
          quantity,
          discount_percent,
          discount_amount,
          usage_period,
          applies_to
        `)
        .in("membership_plan_id", membershipPlanIds);

    if (membershipBenefitsError) {
      throw new Error(
        `Failed to load membership benefits: ${membershipBenefitsError.message}`
      );
    }

    membershipBenefits = (membershipBenefitsData ?? []) as MembershipBenefit[];
  }

  const availableClients = ((clients ?? []) as ClientOption[]).filter(
    (client) => client.status !== "archived"
  );

  const availableInstructors = ((instructors ?? []) as InstructorOption[]).filter(
    (instructor) => instructor.active === true
  );

  const availableRooms = ((rooms ?? []) as RoomOption[]).filter(
    (room) => room.active === true
  );

  const validInitialClientId = availableClients.some(
    (client) => client.id === requestedClientId
  )
    ? requestedClientId
    : "";

  const clientPackagesByClientId: Record<string, ClientPackageRow[]> = {};

  for (const client of availableClients) {
    clientPackagesByClientId[client.id] = [];
  }

  for (const clientPackage of (clientPackages ?? []) as ClientPackageRow[]) {
    if (!clientPackage.client_id) continue;
    clientPackagesByClientId[clientPackage.client_id] ??= [];
    clientPackagesByClientId[clientPackage.client_id].push(clientPackage);
  }

  const hydratedClientMembershipsByClientId: Record<
    string,
    Array<
      ClientMembershipRow & {
        membership_plan_benefits: MembershipBenefit[];
      }
    >
  > = {};

  for (const client of availableClients) {
    hydratedClientMembershipsByClientId[client.id] = [];
  }

  for (const membership of (clientMemberships ?? []) as ClientMembershipRow[]) {
    if (!membership.client_id) continue;

    hydratedClientMembershipsByClientId[membership.client_id] ??= [];
    hydratedClientMembershipsByClientId[membership.client_id].push({
      ...membership,
      membership_plan_benefits: membershipBenefits.filter(
        (benefit) => benefit.membership_plan_id === membership.membership_plan_id
      ),
    });
  }

  const clientLookup = new Map(
    availableClients.map((client) => [client.id, client] as const)
  );

  const linkedPartnersByClientId: Record<string, ClientOption[]> = {};

  for (const relationship of (clientRelationships ?? []) as ClientRelationshipRow[]) {
    const primary = clientLookup.get(relationship.client_id);
    const related = clientLookup.get(relationship.related_client_id);

    if (primary && related) {
      linkedPartnersByClientId[primary.id] ??= [];
      if (!linkedPartnersByClientId[primary.id].some((item) => item.id === related.id)) {
        linkedPartnersByClientId[primary.id].push(related);
      }
    }

    if (primary && related) {
      linkedPartnersByClientId[related.id] ??= [];
      if (!linkedPartnersByClientId[related.id].some((item) => item.id === primary.id)) {
        linkedPartnersByClientId[related.id].push(primary);
      }
    }
  }

  let linkedHostStudios: LinkedHostStudioRow[] = [];

const userEmail = user.email?.trim().toLowerCase() ?? "";

const hostClientQuery = supabase
  .from("clients")
  .select("studio_id")
  .eq("is_independent_instructor", true)
  .neq("studio_id", studioId);

const { data: hostClientRows, error: hostClientRowsError } = userEmail
  ? await hostClientQuery.or(
      `portal_user_id.eq.${user.id},email.eq.${userEmail}`
    )
  : await hostClientQuery.eq("portal_user_id", user.id);

if (hostClientRowsError) {
  throw new Error(
    `Failed to load linked host studios: ${hostClientRowsError.message}`
  );
}

const hostStudioIds = Array.from(
  new Set(
    (hostClientRows ?? [])
      .map((row) => row.studio_id as string | null)
      .filter((value): value is string => Boolean(value))
  )
);

if (hostStudioIds.length > 0) {
  /*
    The independent instructor is allowed to see these host studios because
    the portal-linked client record matched this signed-in user.

    They should not have app workspace access to the host studio, so host
    studio rooms are loaded with the admin client after that link is validated.
  */
  const adminSupabase = createAdminClient();

  const { data: hostStudios, error: hostStudiosError } = await adminSupabase
    .from("studios")
    .select("id, slug, name, public_name")
    .in("id", hostStudioIds)
    .order("name", { ascending: true });

  if (hostStudiosError) {
    throw new Error(
      `Failed to load host studio details: ${hostStudiosError.message}`
    );
  }

  const hostRoomsByStudioId: Record<string, LinkedHostStudioRoomRow[]> = {};

  const { data: hostRooms, error: hostRoomsError } = await adminSupabase
    .from("rooms")
    .select("id, studio_id, name, active")
    .in("studio_id", hostStudioIds)
    .eq("active", true)
    .order("name", { ascending: true });

  if (hostRoomsError) {
    throw new Error(
      `Failed to load host studio rooms: ${hostRoomsError.message}`
    );
  }

  for (const room of hostRooms ?? []) {
    const studioRoomId = room.studio_id as string | null;
    if (!studioRoomId) continue;

    hostRoomsByStudioId[studioRoomId] ??= [];
    hostRoomsByStudioId[studioRoomId].push({
      id: room.id as string,
      name: room.name as string,
      active: room.active as boolean | null,
    });
  }

  linkedHostStudios = (hostStudios ?? []).map((studio) => ({
    id: studio.id as string,
    slug: studio.slug as string,
    name: studio.name as string | null,
    public_name: studio.public_name as string | null,
    rooms: hostRoomsByStudioId[studio.id as string] ?? [],
  }));
}

  const canBookHostStudioFloorSpace = linkedHostStudios.length > 0;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              DanceFlow Scheduling
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              New Appointment
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
              Use this page to book a lesson, coaching session, floor rental, class,
              party, or other appointment.
            </p>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                Pick the right appointment type
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Choose the option that best matches what you are booking so the schedule
                and payment details stay accurate.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">
                Use a room and instructor when needed
              </h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Adding the room and instructor helps avoid double-booking and keeps everyone on the same page.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">
                Check packages and memberships
              </h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                If the client has lessons or membership benefits available, use them here so the appointment is recorded the right way.
              </p>
            </div>
          </div>

          {canBookHostStudioFloorSpace ? (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
              <h2 className="text-lg font-semibold text-emerald-950">
                Floor space booking is available
              </h2>
              <p className="mt-2 text-sm leading-7 text-emerald-900">
                You can also book floor space at a linked host studio from this scheduling flow when needed.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <AppointmentCreateForm
        clients={availableClients as any}
        instructors={availableInstructors as any}
        rooms={availableRooms as any}
        clientPackagesByClientId={clientPackagesByClientId as any}
        clientMembershipsByClientId={hydratedClientMembershipsByClientId as any}
        initialClientId={validInitialClientId}
        linkedPartnersByClientId={linkedPartnersByClientId as any}
        canBookHostStudioFloorSpace={canBookHostStudioFloorSpace}
        linkedHostStudios={linkedHostStudios}
      />
    </div>
  );
}

