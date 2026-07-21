import type { SupabaseClient } from "@supabase/supabase-js";

export type MembershipEntitlementResult = {
  ok: boolean;
  error?: string;
  membershipId?: string;
  membershipPeriodId?: string;
  benefitId?: string;
  remaining?: number | null;
  paymentStatus?: string | null;
};

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function benefitTypesForAppointment(appointmentType: string) {
  if (["private_lesson", "intro_lesson", "coaching"].includes(appointmentType)) {
    return ["included_private_lessons"];
  }
  if (appointmentType === "group_class") return ["included_group_classes"];
  return [];
}

export async function validateMembershipEntitlement(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  appointmentType: string;
  startsAtIso: string;
  clientMembershipId?: string | null;
  excludeAppointmentId?: string | null;
  includeFutureReservations?: boolean;
}): Promise<MembershipEntitlementResult> {
  const {
    supabase,
    studioId,
    clientId,
    appointmentType,
    startsAtIso,
    clientMembershipId = null,
    excludeAppointmentId = null,
    includeFutureReservations = true,
  } = params;

  const usageDate = dateOnly(startsAtIso);
  const benefitTypes = benefitTypesForAppointment(appointmentType);
  if (benefitTypes.length === 0) {
    return { ok: false, error: "This appointment type is not covered by membership benefits." };
  }

  const { data: settings, error: settingsError } = await supabase
    .from("studio_settings")
    .select("block_depleted_membership_booking, block_unpaid_membership_booking")
    .eq("studio_id", studioId)
    .single();

  if (settingsError || !settings) {
    return { ok: false, error: "Studio membership booking settings could not be loaded." };
  }

  let membershipQuery = supabase
    .from("client_memberships")
    .select("id, membership_plan_id, status, current_period_start, current_period_end")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .lte("current_period_start", usageDate)
    .gte("current_period_end", usageDate)
    .order("current_period_start", { ascending: false })
    .limit(1);

  if (clientMembershipId) membershipQuery = membershipQuery.eq("id", clientMembershipId);

  const { data: memberships, error: membershipError } = await membershipQuery;
  if (membershipError) return { ok: false, error: membershipError.message };

  const membership = memberships?.[0] ?? null;
  if (!membership) {
    return { ok: false, error: "No membership covers the selected appointment date." };
  }

  if (!["active", "trialing", "past_due", "unpaid"].includes(membership.status)) {
    return { ok: false, error: "The selected membership is not active." };
  }

  const { data: period, error: periodError } = await supabase
    .from("client_membership_periods")
    .select("id, payment_status")
    .eq("client_membership_id", membership.id)
    .lte("period_start", usageDate)
    .gte("period_end", usageDate)
    .limit(1)
    .maybeSingle();

  if (periodError) return { ok: false, error: periodError.message };

  const paymentStatus = period?.payment_status ?? (membership.status === "trialing" ? "waived" : "due");
  if (
    settings.block_unpaid_membership_booking &&
    !["paid", "waived"].includes(paymentStatus)
  ) {
    return {
      ok: false,
      membershipId: membership.id,
      membershipPeriodId: period?.id,
      paymentStatus,
      error: "The membership renewal covering this date has not been paid or waived.",
    };
  }

  const { data: benefits, error: benefitError } = await supabase
    .from("membership_plan_benefits")
    .select("id, quantity, benefit_type, applies_to")
    .eq("membership_plan_id", membership.membership_plan_id)
    .in("benefit_type", benefitTypes)
    .order("sort_order", { ascending: true });

  if (benefitError) return { ok: false, error: benefitError.message };

  const benefit = (benefits ?? []).find((row) => {
    const appliesTo = String(row.applies_to ?? "").trim();
    return !appliesTo || appliesTo === "all" || appliesTo === appointmentType;
  });

  if (!benefit) {
    return { ok: false, error: "This membership does not include the selected lesson type." };
  }

  if (benefit.quantity == null) {
    return {
      ok: true,
      membershipId: membership.id,
      membershipPeriodId: period?.id,
      benefitId: benefit.id,
      remaining: null,
      paymentStatus,
    };
  }

  const { data: usageRows, error: usageError } = await supabase
    .from("client_membership_usage")
    .select("quantity_used")
    .eq("client_membership_id", membership.id)
    .eq("membership_plan_benefit_id", benefit.id)
    .gte("usage_date", membership.current_period_start)
    .lte("usage_date", membership.current_period_end);

  if (usageError) return { ok: false, error: usageError.message };

  let consumed = (usageRows ?? []).reduce(
    (sum, row) => sum + Number(row.quantity_used ?? 0),
    0,
  );

  if (includeFutureReservations) {
    let reservationQuery = supabase
      .from("appointments")
      .select("id")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .eq("client_membership_id", membership.id)
      .eq("billing_type", "membership")
      .in("status", ["scheduled", "confirmed"])
      .gte("starts_at", `${membership.current_period_start}T00:00:00.000Z`)
      .lt("starts_at", `${membership.current_period_end}T23:59:59.999Z`);

    if (excludeAppointmentId) reservationQuery = reservationQuery.neq("id", excludeAppointmentId);
    const { data: reservations, error: reservationError } = await reservationQuery;
    if (reservationError) return { ok: false, error: reservationError.message };
    consumed += reservations?.length ?? 0;
  }

  const remaining = Number(benefit.quantity) - consumed;
  if (remaining <= 0 && settings.block_depleted_membership_booking) {
    return {
      ok: false,
      membershipId: membership.id,
      membershipPeriodId: period?.id,
      benefitId: benefit.id,
      remaining,
      paymentStatus,
      error: "This membership has no included lessons remaining for the current period.",
    };
  }

  return {
    ok: true,
    membershipId: membership.id,
    membershipPeriodId: period?.id,
    benefitId: benefit.id,
    remaining,
    paymentStatus,
  };
}
