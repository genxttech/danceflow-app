"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function addIntervalDays(startDate: string, billingInterval: string) {
  const date = new Date(`${startDate}T00:00:00`);

  if (billingInterval === "monthly") {
    date.setMonth(date.getMonth() + 1);
  } else if (billingInterval === "quarterly") {
    date.setMonth(date.getMonth() + 3);
  } else if (billingInterval === "yearly") {
    date.setFullYear(date.getFullYear() + 1);
  } else {
    date.setMonth(date.getMonth() + 1);
  }

  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function getStudioContext() {
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

  return {
    supabase,
    studioId: roleRow.studio_id as string,
    userId: user.id,
  };
}

export async function assignClientMembershipAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const membershipPlanId = getString(formData, "membershipPlanId");
  const startsOn = getString(formData, "startsOn");
  const autoRenew = formData.get("autoRenew") === "on";

  if (!clientId) {
    redirect("/app/clients");
  }

  try {
    const { supabase, studioId, userId } = await getStudioContext();

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, studio_id")
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .single();

    if (clientError || !client) {
      redirect(`/app/clients/${clientId}?error=client_not_found`);
    }

    if (!membershipPlanId) {
      redirect(`/app/clients/${clientId}?error=membership_plan_not_found`);
    }

    if (!startsOn) {
      redirect(`/app/clients/${clientId}?error=missing_membership_start`);
    }

    const { data: activeExisting, error: existingError } = await supabase
      .from("client_memberships")
      .select("id")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .eq("status", "active")
      .maybeSingle();

    if (existingError) {
      redirect(`/app/clients/${clientId}?error=membership_assign_failed`);
    }

    if (activeExisting) {
      redirect(`/app/clients/${clientId}?error=active_membership_exists`);
    }

    const { data: plan, error: planError } = await supabase
      .from("membership_plans")
      .select(`
        id,
        studio_id,
        name,
        description,
        billing_interval,
        price,
        signup_fee,
        auto_renew_default
      `)
      .eq("id", membershipPlanId)
      .eq("studio_id", studioId)
      .eq("active", true)
      .single();

    if (planError || !plan) {
      redirect(`/app/clients/${clientId}?error=membership_plan_not_found`);
    }

    const currentPeriodEnd = addIntervalDays(startsOn, plan.billing_interval);

    const { error: insertError } = await supabase.from("client_memberships").insert({
      studio_id: studioId,
      client_id: clientId,
      membership_plan_id: plan.id,
      status: "active",
      starts_on: startsOn,
      ends_on: null,
      current_period_start: startsOn,
      current_period_end: currentPeriodEnd,
      auto_renew,
      cancel_at_period_end: false,
      name_snapshot: plan.name,
      description_snapshot: plan.description,
      price_snapshot: plan.price,
      signup_fee_snapshot: plan.signup_fee,
      billing_interval_snapshot: plan.billing_interval,
      created_by: userId,
    });

    if (insertError) {
      redirect(`/app/clients/${clientId}?error=membership_assign_failed`);
    }
  } catch {
    redirect(`/app/clients/${clientId}?error=membership_assign_failed`);
  }

  redirect(`/app/clients/${clientId}?success=membership_assigned`);
}

export async function cancelClientMembershipAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const clientMembershipId = getString(formData, "clientMembershipId");

  if (!clientId || !clientMembershipId) {
    redirect("/app/clients");
  }

  try {
    const { supabase, studioId } = await getStudioContext();

    const { data: existingMembership, error: membershipError } = await supabase
      .from("client_memberships")
      .select("id, status, current_period_end, auto_renew, cancel_at_period_end")
      .eq("id", clientMembershipId)
      .eq("client_id", clientId)
      .eq("studio_id", studioId)
      .single();

    if (membershipError || !existingMembership) {
      redirect(`/app/clients/${clientId}?error=membership_cancel_failed`);
    }

    if (existingMembership.status !== "active") {
      redirect(`/app/clients/${clientId}?error=membership_cancel_failed`);
    }

    if (existingMembership.cancel_at_period_end) {
      redirect(`/app/clients/${clientId}?success=membership_cancelled`);
    }

    const { error } = await supabase
      .from("client_memberships")
      .update({
        auto_renew: false,
        cancel_at_period_end: true,
        ends_on: existingMembership.current_period_end,
      })
      .eq("id", clientMembershipId)
      .eq("client_id", clientId)
      .eq("studio_id", studioId);

    if (error) {
      redirect(`/app/clients/${clientId}?error=membership_cancel_failed`);
    }
  } catch {
    redirect(`/app/clients/${clientId}?error=membership_cancel_failed`);
  }

  redirect(`/app/clients/${clientId}?success=membership_cancelled`);
}