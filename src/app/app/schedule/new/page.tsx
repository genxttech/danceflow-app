import AppointmentCreateForm from "./AppointmentCreateForm";
import { createClient } from "@/lib/supabase/server";
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

export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const { studioId } = await getCurrentStudioContext();
  const supabase = await createClient();
  const resolvedSearchParams = (await searchParams) ?? {};

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
    throw new Error(
      `Failed to load client packages: ${clientPackagesError.message}`
    );
  }

  if (clientMembershipsError) {
    throw new Error(
      `Failed to load client memberships: ${clientMembershipsError.message}`
    );
  }

  const membershipPlanIds = Array.from(
    new Set(
      (clientMemberships ?? [])
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

  const hydratedClientMemberships = (clientMemberships ?? []).map(
    (membership) => ({
      ...membership,
      benefits: membershipBenefits.filter(
        (benefit) =>
          benefit.membership_plan_id === membership.membership_plan_id
      ),
    })
  );

  const availableClients = (clients ?? []).filter(
    (client) => client.status !== "archived"
  );

  const availableInstructors = (instructors ?? []).filter(
    (instructor) => instructor.active === true
  );

  const availableRooms = (rooms ?? []).filter((room) => room.active === true);

  const validInitialClientId = availableClients.some(
    (client) => client.id === requestedClientId
  )
    ? requestedClientId
    : "";

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              New Appointment
            </h1>
            <p className="mt-2 text-slate-600">
              Schedule a private lesson, intro lesson, coaching session, event,
              group class, practice party, or floor space rental.
            </p>
          </div>
        </div>
      </div>

      <AppointmentCreateForm
        clients={availableClients}
        instructors={availableInstructors}
        rooms={availableRooms}
        clientPackages={(clientPackages ?? []) as any}
        clientMemberships={hydratedClientMemberships as any}
        initialClientId={validInitialClientId}
      />
    </div>
  );
}