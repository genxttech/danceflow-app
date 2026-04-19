import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import AppointmentEditForm from "./AppointmentEditForm";

type Params = Promise<{
  id: string;
}>;

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  status?: string | null;
};

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
};

type RoomOption = {
  id: string;
  name: string;
};

type ClientPackageItem = {
  usage_type: string;
  quantity_remaining: number | null;
  quantity_total?: number | null;
  is_unlimited: boolean;
};

type ClientPackageOption = {
  id: string;
  client_id: string;
  name_snapshot: string;
  active: boolean;
  expiration_date?: string | null;
  client_package_items: ClientPackageItem[];
};

type MembershipBenefit = {
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string;
  applies_to: string | null;
};

type ClientMembershipOption = {
  id: string;
  client_id: string;
  status: string;
  starts_on: string;
  ends_on: string | null;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  name_snapshot: string;
  price_snapshot: number;
  billing_interval_snapshot: string;
  membership_plan_id: string;
  benefits: MembershipBenefit[];
};

type Appointment = {
  id: string;
  title: string | null;
  appointment_type: string;
  client_id: string | null;
  partner_client_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  notes: string | null;
  client_package_id: string | null;
};

type ClientRelationshipRow = {
  client_id: string;
  related_client_id: string;
  relationship_type: string;
};

export default async function EditAppointmentPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const { studioId } = await getCurrentStudioContext();
  const supabase = await createClient();

  const [
    { data: appointment, error: appointmentError },
    { data: clients, error: clientsError },
    { data: instructors, error: instructorsError },
    { data: rooms, error: roomsError },
    { data: clientPackages, error: clientPackagesError },
    { data: clientMembershipsRaw, error: clientMembershipsError },
    { data: membershipBenefitsRaw, error: membershipBenefitsError },
    { data: clientRelationships, error: clientRelationshipsError },
  ] = await Promise.all([
    supabase
      .from("appointments")
      .select(`
        id,
        title,
        appointment_type,
        client_id,
        partner_client_id,
        instructor_id,
        room_id,
        starts_at,
        ends_at,
        status,
        notes,
        client_package_id
      `)
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("clients")
      .select("id, first_name, last_name, status")
      .eq("studio_id", studioId)
      .in("status", ["active", "lead"])
      .order("first_name", { ascending: true }),

    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("first_name", { ascending: true }),

    supabase
      .from("rooms")
      .select("id, name")
      .eq("studio_id", studioId)
      .eq("active", true)
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
        status,
        starts_on,
        ends_on,
        current_period_start,
        current_period_end,
        auto_renew,
        cancel_at_period_end,
        name_snapshot,
        price_snapshot,
        billing_interval_snapshot,
        membership_plan_id
      `)
      .eq("studio_id", studioId)
      .eq("status", "active"),

    supabase
      .from("membership_plan_benefits")
      .select(`
        membership_plan_id,
        benefit_type,
        quantity,
        discount_percent,
        discount_amount,
        usage_period,
        applies_to,
        sort_order
      `),

    supabase
      .from("client_relationships")
      .select("client_id, related_client_id, relationship_type")
      .eq("studio_id", studioId)
      .in("relationship_type", ["partner", "spouse"]),
  ]);

  if (appointmentError || !appointment) {
    notFound();
  }

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
    throw new Error(`Failed to load client memberships: ${clientMembershipsError.message}`);
  }

  if (membershipBenefitsError) {
    throw new Error(`Failed to load membership benefits: ${membershipBenefitsError.message}`);
  }

  if (clientRelationshipsError) {
    throw new Error(`Failed to load client relationships: ${clientRelationshipsError.message}`);
  }

  const benefitsByPlan = new Map<string, MembershipBenefit[]>();

  for (const row of membershipBenefitsRaw ?? []) {
    const planId = row.membership_plan_id as string;
    const benefit: MembershipBenefit = {
      benefit_type: row.benefit_type,
      quantity: row.quantity,
      discount_percent: row.discount_percent,
      discount_amount: row.discount_amount,
      usage_period: row.usage_period,
      applies_to: row.applies_to,
    };

    const current = benefitsByPlan.get(planId) ?? [];
    current.push(benefit);
    benefitsByPlan.set(planId, current);
  }

  const clientMemberships: ClientMembershipOption[] = (clientMembershipsRaw ?? []).map(
    (membership) => ({
      id: membership.id,
      client_id: membership.client_id,
      status: membership.status,
      starts_on: membership.starts_on,
      ends_on: membership.ends_on,
      current_period_start: membership.current_period_start,
      current_period_end: membership.current_period_end,
      auto_renew: membership.auto_renew,
      cancel_at_period_end: membership.cancel_at_period_end,
      name_snapshot: membership.name_snapshot,
      price_snapshot: membership.price_snapshot,
      billing_interval_snapshot: membership.billing_interval_snapshot,
      membership_plan_id: membership.membership_plan_id,
      benefits: benefitsByPlan.get(membership.membership_plan_id) ?? [],
    })
  );

  const availableClients = ((clients ?? []) as ClientOption[]).filter(
    (client) => client.status !== "archived"
  );

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

      linkedPartnersByClientId[related.id] ??= [];
      if (!linkedPartnersByClientId[related.id].some((item) => item.id === primary.id)) {
        linkedPartnersByClientId[related.id].push(primary);
      }
    }
  }

  return (
    <AppointmentEditForm
      appointment={appointment as Appointment}
      clients={availableClients}
      instructors={(instructors ?? []) as InstructorOption[]}
      rooms={(rooms ?? []) as RoomOption[]}
      clientPackages={(clientPackages ?? []) as ClientPackageOption[]}
      clientMemberships={clientMemberships}
      linkedPartnersByClientId={linkedPartnersByClientId}
    />
  );
}
