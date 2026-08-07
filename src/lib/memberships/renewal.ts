import type { SupabaseClient } from "@supabase/supabase-js";

type MembershipRow = {
  id: string;
  studio_id: string;
  client_id: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  price_snapshot: number | string | null;
  billing_interval_snapshot: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  created_by: string | null;
};

function addDays(dateOnly: string, days: number) {
  const date = new Date(`${dateOnly}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calculateNextPeriod(periodEnd: string, billingInterval: string) {
  const periodStart = addDays(periodEnd, 1);
  const end = new Date(`${periodStart}T12:00:00.000Z`);

  if (billingInterval === "quarterly") {
    end.setUTCMonth(end.getUTCMonth() + 3);
  } else if (billingInterval === "yearly") {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  } else {
    end.setUTCMonth(end.getUTCMonth() + 1);
  }

  end.setUTCDate(end.getUTCDate() - 1);

  return {
    periodStart,
    periodEnd: end.toISOString().slice(0, 10),
  };
}

async function hasStripeSubscription(
  supabase: SupabaseClient,
  studioId: string,
  membershipId: string,
) {
  const { data, error } = await supabase
    .from("stripe_subscriptions")
    .select("id")
    .eq("studio_id", studioId)
    .eq("client_membership_id", membershipId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Could not check Stripe membership linkage: ${error.message}`,
    );
  }

  return Boolean(data?.id);
}

export async function ensureMembershipPeriodForDate(params: {
  supabase: SupabaseClient;
  studioId: string;
  membershipId: string;
  throughDate: string;
}) {
  const { supabase, studioId, membershipId, throughDate } = params;

  const { data, error } = await supabase
    .from("client_memberships")
    .select(
      "id, studio_id, client_id, status, current_period_start, current_period_end, price_snapshot, billing_interval_snapshot, auto_renew, cancel_at_period_end, created_by",
    )
    .eq("id", membershipId)
    .eq("studio_id", studioId)
    .single();

  if (error || !data) {
    throw new Error("Membership could not be loaded for renewal.");
  }

  const membership = data as MembershipRow;

  if (
    !membership.auto_renew ||
    membership.cancel_at_period_end ||
    !["active", "past_due", "unpaid"].includes(membership.status)
  ) {
    return {
      advanced: false,
      currentPeriodStart: membership.current_period_start,
      currentPeriodEnd: membership.current_period_end,
    };
  }

  // Stripe-backed memberships are advanced by Stripe/webhook synchronization.
  // Local renewal reconciliation must never race that source of truth.
  if (await hasStripeSubscription(supabase, studioId, membership.id)) {
    return {
      advanced: false,
      currentPeriodStart: membership.current_period_start,
      currentPeriodEnd: membership.current_period_end,
    };
  }

  let currentStart = membership.current_period_start;
  let currentEnd = membership.current_period_end;
  let advanced = false;
  let safety = 0;

  while (currentEnd < throughDate && safety < 24) {
    safety += 1;

    const next = calculateNextPeriod(
      currentEnd,
      membership.billing_interval_snapshot,
    );

    const nowIso = new Date().toISOString();

    const { error: periodError } = await supabase
      .from("client_membership_periods")
      .upsert(
        {
          studio_id: membership.studio_id,
          client_id: membership.client_id,
          client_membership_id: membership.id,
          period_start: next.periodStart,
          period_end: next.periodEnd,
          amount_due: Number(membership.price_snapshot ?? 0),
          amount_paid: 0,
          currency: "usd",
          payment_status: "due",
          payment_due_at: `${next.periodStart}T00:00:00.000Z`,
          created_by: membership.created_by,
          updated_at: nowIso,
        },
        {
          onConflict: "client_membership_id,period_start,period_end",
          ignoreDuplicates: true,
        },
      );

    if (periodError) {
      throw new Error(
        `Could not create membership renewal period: ${periodError.message}`,
      );
    }

    currentStart = next.periodStart;
    currentEnd = next.periodEnd;
    advanced = true;
  }

  if (advanced) {
    const { error: membershipUpdateError } = await supabase
      .from("client_memberships")
      .update({
        current_period_start: currentStart,
        current_period_end: currentEnd,
        updated_at: new Date().toISOString(),
      })
      .eq("id", membership.id)
      .eq("studio_id", studioId);

    if (membershipUpdateError) {
      throw new Error(
        `Could not advance membership renewal dates: ${membershipUpdateError.message}`,
      );
    }
  }

  return {
    advanced,
    currentPeriodStart: currentStart,
    currentPeriodEnd: currentEnd,
  };
}

export async function reconcileStudioMembershipPeriods(params: {
  supabase: SupabaseClient;
  studioId: string;
  throughDate?: string;
}) {
  const {
    supabase,
    studioId,
    throughDate = new Date().toISOString().slice(0, 10),
  } = params;

  const { data: memberships, error } = await supabase
    .from("client_memberships")
    .select("id, current_period_end")
    .eq("studio_id", studioId)
    .eq("auto_renew", true)
    .eq("cancel_at_period_end", false)
    .in("status", ["active", "past_due", "unpaid"])
    .lt("current_period_end", throughDate);

  if (error) {
    throw new Error(
      `Could not load memberships needing renewal: ${error.message}`,
    );
  }

  let advancedCount = 0;

  for (const membership of memberships ?? []) {
    const result = await ensureMembershipPeriodForDate({
      supabase,
      studioId,
      membershipId: String(membership.id),
      throughDate,
    });

    if (result.advanced) {
      advancedCount += 1;
    }
  }

  return {
    checkedCount: memberships?.length ?? 0,
    advancedCount,
    throughDate,
  };
}
