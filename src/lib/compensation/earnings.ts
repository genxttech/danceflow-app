import type { SupabaseClient } from "@supabase/supabase-js";

type AppointmentRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  instructor_id: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number | null;
  price_amount: number | string | null;
  payment_status: string | null;
  billing_type: string | null;
};

type CompensationRuleRow = {
  id: string;
  private_lesson_pay_mode: string;
  private_lesson_flat_amount: number | string | null;
  private_lesson_percentage: number | string | null;
  private_lesson_duration_rates_enabled?: boolean | null;
  private_lesson_30_min_flat_amount?: number | string | null;
  private_lesson_45_min_flat_amount?: number | string | null;
  private_lesson_60_min_flat_amount?: number | string | null;
  group_class_pay_mode: string;
  group_class_flat_amount: number | string | null;
  group_class_percentage: number | string | null;
  group_class_per_attendee_amount: number | string | null;
  active: boolean;
};

type ExistingEarningRow = {
  id: string;
  status: string;
};

type StageInstructorEarningInput = {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
  createdBy?: string | null;
};

type GenerateInstructorEarningsInput = {
  supabase: SupabaseClient;
  studioId: string;
  fromDate?: string | null;
  toDate?: string | null;
  createdBy?: string | null;
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function numberValue(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function earningDateFromIso(value: string) {
  return value.slice(0, 10);
}

function appointmentDurationMinutes(appointment: AppointmentRow) {
  const explicit = Number(appointment.duration_minutes ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const start = new Date(appointment.starts_at).getTime();
  const end = new Date(appointment.ends_at).getTime();
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return Math.round((end - start) / 60000);
  }

  return 0;
}

function durationFlatRateForPrivateLesson(rule: CompensationRuleRow, durationMinutes: number) {
  const defaultFlat = roundMoney(Math.max(numberValue(rule.private_lesson_flat_amount), 0));
  if (!rule.private_lesson_duration_rates_enabled) {
    return { amount: defaultFlat, label: null as string | null };
  }

  const rate30 = roundMoney(Math.max(numberValue(rule.private_lesson_30_min_flat_amount), 0));
  const rate45 = roundMoney(Math.max(numberValue(rule.private_lesson_45_min_flat_amount), 0));
  const rate60 = roundMoney(Math.max(numberValue(rule.private_lesson_60_min_flat_amount), 0));

  if (durationMinutes > 0 && durationMinutes <= 35 && rate30 > 0) {
    return { amount: rate30, label: "30-minute duration rate" };
  }
  if (durationMinutes > 0 && durationMinutes <= 52 && rate45 > 0) {
    return { amount: rate45, label: "45-minute duration rate" };
  }
  if (durationMinutes > 0 && rate60 > 0) {
    return { amount: rate60, label: "60-minute duration rate" };
  }

  return { amount: defaultFlat, label: defaultFlat > 0 ? "default private lesson flat rate" : null };
}

function isPrivateLessonType(appointmentType: string) {
  return appointmentType === "private_lesson" || appointmentType === "intro_lesson" || appointmentType === "coaching";
}

function isGroupClassType(appointmentType: string) {
  return appointmentType === "group_class" || appointmentType === "practice_party";
}

function isEligibleAppointment(appointment: AppointmentRow) {
  if (!appointment.instructor_id) return false;
  if (!isPrivateLessonType(appointment.appointment_type) && !isGroupClassType(appointment.appointment_type)) {
    return false;
  }

  const status = (appointment.status ?? "").toLowerCase();
  const paymentStatus = (appointment.payment_status ?? "").toLowerCase();
  const billingType = (appointment.billing_type ?? "").toLowerCase();

  if (status === "attended" || status === "completed") return true;
  if (billingType === "pay_as_you_go" && paymentStatus === "paid") return true;

  return false;
}

async function getAttendanceCount({
  supabase,
  studioId,
  appointmentId,
}: {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
}) {
  const { count, error } = await supabase
    .from("attendance_records")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId)
    .eq("status", "attended");

  if (error) return 0;
  return count ?? 0;
}

function calculateEarning({
  appointment,
  rule,
  attendanceCount,
}: {
  appointment: AppointmentRow;
  rule: CompensationRuleRow;
  attendanceCount: number;
}) {
  const grossRevenueBasis = roundMoney(Math.max(numberValue(appointment.price_amount), 0));

  if (isGroupClassType(appointment.appointment_type)) {
    const payMode = rule.group_class_pay_mode || "none";
    const flatAmount = roundMoney(Math.max(numberValue(rule.group_class_flat_amount), 0));
    const percentage = Math.max(numberValue(rule.group_class_percentage), 0);
    const perAttendeeAmount = roundMoney(Math.max(numberValue(rule.group_class_per_attendee_amount), 0));

    if (payMode === "flat") {
      return {
        payMode,
        grossRevenueBasis,
        payRateAmount: flatAmount,
        payPercentage: 0,
        attendanceCount,
        earningAmount: flatAmount,
      };
    }

    if (payMode === "percentage") {
      return {
        payMode,
        grossRevenueBasis,
        payRateAmount: 0,
        payPercentage: percentage,
        attendanceCount,
        earningAmount: roundMoney(grossRevenueBasis * (percentage / 100)),
      };
    }

    if (payMode === "per_attendee") {
      return {
        payMode,
        grossRevenueBasis,
        payRateAmount: perAttendeeAmount,
        payPercentage: 0,
        attendanceCount,
        earningAmount: roundMoney(perAttendeeAmount * attendanceCount),
      };
    }

    return null;
  }

  const payMode = rule.private_lesson_pay_mode || "none";
  const durationMinutes = appointmentDurationMinutes(appointment);
  const durationRate = durationFlatRateForPrivateLesson(rule, durationMinutes);
  const percentage = Math.max(numberValue(rule.private_lesson_percentage), 0);

  if (payMode === "flat") {
    return {
      payMode,
      grossRevenueBasis,
      payRateAmount: durationRate.amount,
      payPercentage: 0,
      attendanceCount: 0,
      earningAmount: durationRate.amount,
      ruleDetail: durationRate.label,
    };
  }

  if (payMode === "percentage") {
    return {
      payMode,
      grossRevenueBasis,
      payRateAmount: 0,
      payPercentage: percentage,
      attendanceCount: 0,
      earningAmount: roundMoney(grossRevenueBasis * (percentage / 100)),
    };
  }

  return null;
}

export async function stageInstructorEarningForAppointment({
  supabase,
  studioId,
  appointmentId,
  createdBy = null,
}: StageInstructorEarningInput) {
  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .select("id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, duration_minutes, price_amount, payment_status, billing_type")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .maybeSingle();

  const typedAppointment = appointment as AppointmentRow | null;

  if (appointmentError || !typedAppointment || !isEligibleAppointment(typedAppointment)) {
    return { staged: false, reason: "appointment_not_eligible" };
  }

  const { data: rule, error: ruleError } = await supabase
    .from("instructor_compensation_rules")
    .select("id, private_lesson_pay_mode, private_lesson_flat_amount, private_lesson_percentage, private_lesson_duration_rates_enabled, private_lesson_30_min_flat_amount, private_lesson_45_min_flat_amount, private_lesson_60_min_flat_amount, group_class_pay_mode, group_class_flat_amount, group_class_percentage, group_class_per_attendee_amount, active")
    .eq("studio_id", studioId)
    .eq("instructor_id", typedAppointment.instructor_id)
    .eq("active", true)
    .maybeSingle();

  const typedRule = rule as CompensationRuleRow | null;

  if (ruleError || !typedRule) {
    return { staged: false, reason: "rule_not_found" };
  }

  const { data: existing } = await supabase
    .from("instructor_earnings")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("appointment_id", typedAppointment.id)
    .eq("instructor_id", typedAppointment.instructor_id)
    .maybeSingle();

  const typedExisting = existing as ExistingEarningRow | null;

  if (typedExisting && typedExisting.status !== "pending") {
    return { staged: false, reason: "earning_locked" };
  }

  const attendanceCount = isGroupClassType(typedAppointment.appointment_type)
    ? await getAttendanceCount({ supabase, studioId, appointmentId: typedAppointment.id })
    : 0;

  const calculation = calculateEarning({ appointment: typedAppointment, rule: typedRule, attendanceCount });

  if (!calculation || calculation.earningAmount <= 0) {
    return { staged: false, reason: "no_earning_amount" };
  }

  const sourceNote = (() => {
    if (calculation.payMode === "flat") return calculation.ruleDetail ? `Auto-staged from the completed lesson or class using the ${calculation.ruleDetail}.` : "Auto-staged from the completed lesson or class using a flat-rate instructor compensation rule.";
    if (calculation.payMode === "percentage") return `Auto-staged from the completed lesson or class using ${calculation.payPercentage}% of the lesson or class value.`;
    if (calculation.payMode === "per_attendee") return `Auto-staged from the completed class using ${calculation.attendanceCount} attended student${calculation.attendanceCount === 1 ? "" : "s"}.`;
    return "Auto-staged from the completed lesson or class using the instructor compensation rule.";
  })();

  const payload = {
    studio_id: studioId,
    instructor_id: typedAppointment.instructor_id,
    appointment_id: typedAppointment.id,
    client_id: typedAppointment.client_id,
    earning_date: earningDateFromIso(typedAppointment.starts_at),
    source_type: "appointment",
    appointment_type: typedAppointment.appointment_type,
    gross_revenue_basis: calculation.grossRevenueBasis,
    pay_mode: calculation.payMode,
    pay_rate_amount: calculation.payRateAmount,
    pay_percentage: calculation.payPercentage,
    attendance_count: calculation.attendanceCount,
    earning_amount: calculation.earningAmount,
    status: "pending",
    notes: sourceNote,
    created_by: createdBy,
    updated_at: new Date().toISOString(),
  };

  if (typedExisting) {
    const { error: updateError } = await supabase
      .from("instructor_earnings")
      .update(payload)
      .eq("id", typedExisting.id)
      .eq("status", "pending");

    if (updateError) {
      return { staged: false, reason: updateError.message };
    }

    return { staged: true, action: "updated" };
  }

  const { error: insertError } = await supabase.from("instructor_earnings").insert(payload);

  if (insertError) {
    return { staged: false, reason: insertError.message };
  }

  return { staged: true, action: "created" };
}

export async function generateInstructorEarningsForCompletedAppointments({
  supabase,
  studioId,
  fromDate = null,
  toDate = null,
  createdBy = null,
}: GenerateInstructorEarningsInput) {
  let query = supabase
    .from("appointments")
    .select("id")
    .eq("studio_id", studioId)
    .not("instructor_id", "is", null)
    .in("appointment_type", [
      "private_lesson",
      "intro_lesson",
      "coaching",
      "group_class",
      "practice_party",
    ])
    .or("status.eq.attended,status.eq.completed,payment_status.eq.paid")
    .order("starts_at", { ascending: false })
    .limit(500);

  if (fromDate) query = query.gte("starts_at", `${fromDate}T00:00:00`);
  if (toDate) query = query.lte("starts_at", `${toDate}T23:59:59`);

  const { data: appointments, error } = await query;

  if (error) {
    return { scanned: 0, staged: 0, skipped: 0, error: error.message };
  }

  let staged = 0;
  let skipped = 0;

  for (const appointment of appointments ?? []) {
    const result = await stageInstructorEarningForAppointment({
      supabase,
      studioId,
      appointmentId: appointment.id,
      createdBy,
    });

    if (result.staged) staged += 1;
    else skipped += 1;
  }

  return { scanned: appointments?.length ?? 0, staged, skipped, error: null };
}
