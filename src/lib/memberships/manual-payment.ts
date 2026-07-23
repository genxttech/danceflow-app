import type { SupabaseClient } from "@supabase/supabase-js";

type MembershipPaymentInput = {
  supabase: SupabaseClient;
  studioId: string;
  userId: string;
  clientId: string;
  clientMembershipId: string;
  amount: number;
  paymentMethod: string;
  paidAtIso: string;
  externalReference?: string | null;
  notes?: string | null;
};

type MembershipRow = {
  id: string;
  client_id: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  price_snapshot: number | string | null;
  name_snapshot: string;
  billing_interval_snapshot: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
};

type PeriodRow = {
  id: string;
  amount_due: number | string | null;
  amount_paid: number | string | null;
  payment_status: string;
};

function addDays(dateOnly: string, days: number) {
  const date = new Date(`${dateOnly}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calculateNextPeriod(periodEnd: string, billingInterval: string) {
  const start = addDays(periodEnd, 1);
  const end = new Date(`${start}T12:00:00.000Z`);

  if (billingInterval === "quarterly") end.setUTCMonth(end.getUTCMonth() + 3);
  else if (billingInterval === "yearly") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);

  end.setUTCDate(end.getUTCDate() - 1);
  return { periodStart: start, periodEnd: end.toISOString().slice(0, 10) };
}

export async function recordManualMembershipPayment(input: MembershipPaymentInput) {
  const {
    supabase,
    studioId,
    userId,
    clientId,
    clientMembershipId,
    amount,
    paymentMethod,
    paidAtIso,
    externalReference = null,
    notes = null,
  } = input;

  const paymentDate = paidAtIso.slice(0, 10);
  const { data: rawMembership, error: membershipError } = await supabase
    .from("client_memberships")
    .select("id, client_id, status, current_period_start, current_period_end, price_snapshot, name_snapshot, billing_interval_snapshot, auto_renew, cancel_at_period_end")
    .eq("id", clientMembershipId)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .single();

  if (membershipError || !rawMembership) throw new Error("Membership was not found for this client.");
  const membership = rawMembership as MembershipRow;

  const loadPeriod = async (periodStart: string, periodEnd: string) => {
    const { data, error } = await supabase
      .from("client_membership_periods")
      .select("id, amount_due, amount_paid, payment_status")
      .eq("client_membership_id", membership.id)
      .eq("period_start", periodStart)
      .eq("period_end", periodEnd)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data ?? null) as PeriodRow | null;
  };

  let targetStart = membership.current_period_start;
  let targetEnd = membership.current_period_end;
  let targetPeriod = await loadPeriod(targetStart, targetEnd);
  let advancedPeriod = false;

  const currentIsReconciled = ["paid", "waived"].includes(targetPeriod?.payment_status ?? "due");
  if (
    currentIsReconciled &&
    targetEnd < paymentDate &&
    membership.auto_renew &&
    !membership.cancel_at_period_end
  ) {
    const next = calculateNextPeriod(targetEnd, membership.billing_interval_snapshot);
    targetStart = next.periodStart;
    targetEnd = next.periodEnd;
    targetPeriod = await loadPeriod(targetStart, targetEnd);
    advancedPeriod = true;
  }

  if (["paid", "waived"].includes(targetPeriod?.payment_status ?? "")) {
    throw new Error("The membership period covering this payment is already paid or waived.");
  }

  const amountDue = Number(targetPeriod?.amount_due ?? membership.price_snapshot ?? 0);
  const priorPaid = Number(targetPeriod?.amount_paid ?? 0);
  const nextPaid = Math.round((priorPaid + amount) * 100) / 100;
  if (amountDue > 0 && nextPaid > amountDue) {
    throw new Error("This payment is greater than the remaining membership balance.");
  }

  const nextStatus = amountDue <= 0 || nextPaid >= amountDue ? "paid" : "partial";
  const { data: payment, error: paymentError } = await supabase
    .from("payments")
    .insert({
      studio_id: studioId,
      client_id: clientId,
      client_membership_id: membership.id,
      amount,
      payment_method: paymentMethod,
      status: "paid",
      paid_at: paidAtIso,
      created_by: userId,
      payment_type: "membership",
      accounting_category: "membership_revenue",
      source: "manual",
      payment_channel: "manual",
      currency: "usd",
      external_reference: externalReference,
      notes: notes || `External membership payment for ${membership.name_snapshot}, ${targetStart} through ${targetEnd}.`,
    })
    .select("id")
    .single();

  if (paymentError || !payment) throw new Error(paymentError?.message ?? "Membership payment could not be recorded.");

  const payload = {
    studio_id: studioId,
    client_id: clientId,
    client_membership_id: membership.id,
    period_start: targetStart,
    period_end: targetEnd,
    amount_due: amountDue,
    amount_paid: nextPaid,
    currency: "usd",
    payment_status: nextStatus,
    payment_id: payment.id,
    payment_due_at: `${targetStart}T00:00:00.000Z`,
    paid_at: nextStatus === "paid" ? paidAtIso : null,
    created_by: userId,
    updated_at: new Date().toISOString(),
  };

  const { error: periodError } = targetPeriod
    ? await supabase.from("client_membership_periods").update(payload).eq("id", targetPeriod.id)
    : await supabase.from("client_membership_periods").insert(payload);

  if (periodError) {
    await supabase.from("payments").delete().eq("id", payment.id).eq("studio_id", studioId);
    throw new Error(periodError.message);
  }

  const membershipUpdate: Record<string, unknown> = {
    status: "active",
    updated_at: new Date().toISOString(),
  };
  if (advancedPeriod) {
    membershipUpdate.current_period_start = targetStart;
    membershipUpdate.current_period_end = targetEnd;
  }

  const { error: membershipUpdateError } = await supabase
    .from("client_memberships")
    .update(membershipUpdate)
    .eq("id", membership.id)
    .eq("studio_id", studioId);
  if (membershipUpdateError) throw new Error(membershipUpdateError.message);

  return { paymentId: payment.id, periodStart: targetStart, periodEnd: targetEnd, paymentStatus: nextStatus };
}
