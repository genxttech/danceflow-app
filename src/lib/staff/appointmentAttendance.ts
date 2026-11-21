import type { SupabaseClient } from "@supabase/supabase-js";
import { stageInstructorEarningForAppointment } from "@/lib/compensation/earnings";
import { validateMembershipEntitlement } from "@/lib/memberships/entitlements";
import { reconcileClientPackageLifecycle } from "@/lib/packages/lifecycle";
import { packageUsageTypeForAppointment } from "@/lib/packages/entitlement";
import { requireAppointmentRelationshipAccess } from "@/lib/auth/appointmentAccess";

/**
 * One-to-one appointment (private lesson / intro lesson / coaching) attendance: attended and no-show.
 *
 * Extracted from src/app/app/schedule/actions.ts so the web server actions and the staff API (PUT .../appointments/{id}/attendance) run the same code. The helpers
 * below the marker are moved verbatim from that file (types widened to SupabaseClient). Everything runs on the CALLER'S client (cookie client on the web, bearer client
 * in the API), so RLS applies exactly as before; nothing here uses the service role.
 *
 * Exactly-once package deduction is a database guarantee, not an application one: the deduct_package_credit_when_appointment_attended trigger and the
 * deduct_package_credit_for_appointment RPC lock the package item and look for a prior deduction marker, so retries and concurrent submits cannot take a second credit.
 * Status transitions are guarded by enforce_private_lesson_attendance_lifecycle: attended and no_show are terminal for these appointment types. There is therefore no
 * "reset" operation (the web has none either; a correction workflow is a separate, undesigned product feature).
 */

export const PRIVATE_LESSON_APPOINTMENT_TYPES = ["private_lesson", "intro_lesson", "coaching"] as const;
export type MissedAppointmentCharge = "none" | "package" | "membership";
export type AppointmentAttendanceStatus = "attended" | "no_show";

export type AppointmentAttendanceActor = {
  userId: string;
  studioRole: string | null | undefined;
  isPlatformAdmin: boolean;
};

export type AppointmentAttendanceResult =
  | {
      ok: true;
      appointmentId: string;
      clientId: string | null;
      status: AppointmentAttendanceStatus;
      /** True when the appointment already had this status: nothing new was written for the status itself. */
      alreadyApplied: boolean;
      /** Attended only: the package or membership deduction did not complete. The status is recorded; repeating the same request completes it. */
      usageSyncPending: boolean;
      /** Attended only, with usageSyncPending: the package has no credit left (a lost race for the last credit), so repeating the request cannot succeed. */
      packageExhausted?: boolean;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_markable"
        | "attended_cannot_be_marked_no_show"
        | "no_show_cannot_be_marked_attended"
        | "payment_required"
        | "charge_changed"
        | "package_changed"
        | "write_failed"
        | "charge_failed";
      /** charge_failed only: the same message the web action shows. */
      message?: string;
    };

type AppointmentRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  instructor_id: string | null;
  appointment_type: string;
  starts_at: string;
  title: string | null;
  client_package_id: string | null;
  client_membership_id: string | null;
  price_amount: number | string | null;
  payment_status: string | null;
  billing_type: string | null;
  status: string;
};

const SELECT = "starts_at, title, client_package_id, client_membership_id, price_amount, payment_status, billing_type, status";

function isTerminalType(appointmentType: string) {
  return (PRIVATE_LESSON_APPOINTMENT_TYPES as readonly string[]).includes(appointmentType);
}

/**
 * restrictToPrivateLessons: the staff API restricts this operation to one-to-one appointment types (group classes have their own per-dancer route). The web
 * action leaves it off and keeps its existing reach.
 */
export async function markAppointmentAttendance(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
  status: AppointmentAttendanceStatus;
  actor: AppointmentAttendanceActor;
  missedAppointmentCharge?: string;
  restrictToPrivateLessons?: boolean;
  now?: () => string;
}): Promise<AppointmentAttendanceResult> {
  const { supabase, studioId, appointmentId, status, actor, restrictToPrivateLessons = false } = params;
  const missedAppointmentCharge = params.missedAppointmentCharge || "none";
  const now = params.now ?? (() => new Date().toISOString());

  // Relationship authorization comes before any mutation or deduction: an instructor may only act on an appointment currently assigned to them.
  const access = await requireAppointmentRelationshipAccess<AppointmentRow>({
    supabase: supabase as never,
    studioId,
    studioRole: actor.studioRole,
    isPlatformAdmin: actor.isPlatformAdmin,
    userId: actor.userId,
    appointmentId,
    select: SELECT,
  });
  if (!access.ok) return { ok: false, reason: "not_found" };
  if (restrictToPrivateLessons && access.scope === "own-floor-rental") return { ok: false, reason: "not_found" };

  const appointment = access.appointment;
  if (restrictToPrivateLessons && (!isTerminalType(String(appointment.appointment_type)) || appointment.status === "cancelled")) {
    return { ok: false, reason: "not_markable" };
  }

  return status === "attended"
    ? markAttended({ supabase, studioId, appointment, now })
    : markNoShow({ supabase, studioId, appointment, actor, missedAppointmentCharge, now, notesVisible: access.scope === "broad" });
}

async function markAttended(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointment: AppointmentRow;
  now: () => string;
}): Promise<AppointmentAttendanceResult> {
  const { supabase, studioId, appointment, now } = params;
  const appointmentId = appointment.id;

  // Product decision (terminal attendance lifecycle): a no-show cannot be reclassified as attended. Backstopped by enforce_private_lesson_attendance_lifecycle.
  if (isTerminalType(String(appointment.appointment_type)) && appointment.status === "no_show") {
    return { ok: false, reason: "no_show_cannot_be_marked_attended" };
  }

  // Already attended: a replay (double submit, retry, re-tap after a failed sync). Do not re-run the payment gate or rewrite the status, but DO attempt the package or
  // membership sync again: it is idempotent (the RPC locks and re-checks its marker), so a completed deduction is a no-op and a stranded one gets completed.
  const alreadyAttended = appointment.status === "attended";

  if (!alreadyAttended) {
    const canComplete = await canMarkAppointmentAttendedWithoutPaymentWarning({ supabase, studioId, appointment });
    if (!canComplete) return { ok: false, reason: "payment_required" };

    const attendedAt = now();
    const { data: written, error } = await supabase
      .from("appointments")
      .update({ status: "attended", attendance_marked_at: attendedAt, updated_at: attendedAt })
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .select("id");
    if (error) return { ok: false, reason: "write_failed" };
    // Exactly one row, or nothing may follow: a zero-row update (RLS, a vanished row) must never reach the SECURITY DEFINER deduction RPC.
    if (!written || written.length !== 1) return { ok: false, reason: written && written.length === 0 ? "not_found" : "write_failed" };
  } else if (billingTypeOf(appointment) === "package_credit" && appointment.client_package_id) {
    // A replay must not take a second credit from a DIFFERENT package: if the lesson was already charged to another package and its package link was changed
    // afterwards, refuse instead of syncing against the new package.
    const charged = await chargedPackageIds(supabase, appointmentId);
    if (charged.length > 0 && !charged.includes(appointment.client_package_id)) return { ok: false, reason: "package_changed" };
  }

  const billingType = billingTypeOf(appointment);
  let usageSyncPending = false;
  let packageExhausted = false;

  try {
    if (billingType === "membership" && appointment.client_id) {
      await syncMembershipUsageForAppointment({
        supabase,
        studioId,
        appointmentId,
        clientId: appointment.client_id,
        appointmentType: appointment.appointment_type,
        status: "attended",
        startsAtIso: appointment.starts_at,
        clientMembershipId: appointment.client_membership_id ?? null,
      });
    }

    if (billingType === "package_credit" && appointment.client_id) {
      await syncPackageUsageForAttendedAppointment({
        supabase,
        studioId,
        appointmentId,
        clientId: appointment.client_id,
        appointmentType: appointment.appointment_type,
        clientPackageId: appointment.client_package_id,
      });
    }
  } catch (syncError) {
    usageSyncPending = true;
    packageExhausted = syncError instanceof Error && PACKAGE_EXHAUSTED_MESSAGES.some((text) => syncError.message.includes(text));
    console.error(
      alreadyAttended
        ? "Attendance retry could not complete the pending package/membership sync."
        : "Attendance was marked, but usage sync failed.",
      syncError,
    );
  }

  try {
    await stageInstructorEarningForAppointment({ supabase: supabase as never, studioId, appointmentId });
  } catch (earningError) {
    console.error("Attendance was marked, but instructor earning staging failed.", earningError);
  }

  return {
    ok: true,
    appointmentId,
    clientId: appointment.client_id,
    status: "attended",
    alreadyApplied: alreadyAttended,
    usageSyncPending,
    ...(packageExhausted ? { packageExhausted: true } : {}),
  };
}

async function markNoShow(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointment: AppointmentRow;
  actor: AppointmentAttendanceActor;
  missedAppointmentCharge: string;
  now: () => string;
  /** The no-show note is the persisted decision. An instructor's client rows and notes are hidden by RLS (they cannot read or write it), so for them it cannot be consulted. */
  notesVisible: boolean;
}): Promise<AppointmentAttendanceResult> {
  const { supabase, studioId, appointment, actor, missedAppointmentCharge, now, notesVisible } = params;
  const appointmentId = appointment.id;

  if (isTerminalType(String(appointment.appointment_type)) && appointment.status === "attended") {
    return { ok: false, reason: "attended_cannot_be_marked_no_show" };
  }

  // The decision is persisted in the ONE no-show note (it carries the appointment id), written right after the status change and BEFORE the charge, so a retry can
  // tell "decided none" from "charge requested, not applied" with no migration. Replay rules: only a change AWAY FROM AN APPLIED decision conflicts. (1) An applied
  // charge may only be repeated. (2) With nothing applied, a note that says "no deduction" (or "deducted") may not become a charge: the note would lie. (3) No note (a
  // crash between the status write and the note, or a request still in flight) or a note that says "requested, not applied": the charge may be attempted again, or
  // changed; the database makes the deduction itself idempotent.
  const alreadyApplied = appointment.status === "no_show";
  const markedAt = now();
  const chargeKind = missedAppointmentCharge === "package" || missedAppointmentCharge === "membership" ? missedAppointmentCharge : null;

  let note: NoteRow | null = null;
  if (alreadyApplied) {
    const appliedKind = await appliedChargeKind(supabase, appointmentId);
    note = await noShowNote(supabase, studioId, appointment);
    if (appliedKind) {
      if (missedAppointmentCharge !== appliedKind) return { ok: false, reason: "charge_changed" };
      // The deduction marker is per (appointment, package): if the lesson was relinked to another package since, repeating the charge would take a SECOND credit
      // from the new package for the same lesson.
      if (appliedKind === "package" && !(await chargedPackageIds(supabase, appointmentId)).includes(String(appointment.client_package_id))) {
        return { ok: false, reason: "package_changed" };
      }
    } else if (chargeKind && note && !note.body.includes(NOT_APPLIED_TEXT)) {
      return { ok: false, reason: "charge_changed" };
    } else if (chargeKind && !notesVisible) {
      // Fail safe: with the note unreadable, a charge that has not been applied cannot be told apart from a decision not to charge.
      return { ok: false, reason: "charge_changed" };
    }
  } else {
    const { data: written, error } = await supabase
      .from("appointments")
      .update({ status: "no_show", updated_at: markedAt })
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .select("id");
    if (error) return { ok: false, reason: "write_failed" };
    if (!written || written.length !== 1) return { ok: false, reason: written && written.length === 0 ? "not_found" : "write_failed" };

    await clearMembershipUsageForAppointment({ supabase, appointmentId });
  }

  // A "no charge" decision after a failed charge request: record it, so a later charge request is a conflict.
  if (alreadyApplied && !chargeKind && note && note.body.includes(NOT_APPLIED_TEXT) && !(await appliedChargeKind(supabase, appointmentId))) {
    await rewriteNotePolicy(supabase, note, "No lesson deduction");
    return { ok: true, appointmentId, clientId: appointment.client_id, status: "no_show", alreadyApplied, usageSyncPending: false };
  }

  // Ensure the note exists before the charge is attempted.
  if (!note && appointment.client_id) {
    const label =
      typeof appointment.title === "string" && appointment.title.trim()
        ? appointment.title.trim()
        : appointmentTypeLabel(String(appointment.appointment_type));
    const chargeLabel = chargeKind ? `${chargeName(chargeKind)} ${NOT_APPLIED_TEXT}` : "No lesson deduction";
    const { data: inserted, error } = await supabase
      .from("client_activity_notes")
      .insert({
        studio_id: studioId,
        client_id: appointment.client_id,
        note_type: "general",
        body: [`Appointment marked no-show: ${label}`, `Charge policy: ${chargeLabel}`, `${NOTE_REF_PREFIX}${appointmentId}`].join("\n"),
        occurred_at: markedAt,
        created_by: actor.userId,
      })
      .select("id, body");
    if (error) {
      console.error("Appointment was marked no-show, but the client activity note failed:", error.message);
    } else {
      note = ((inserted ?? [])[0] as NoteRow | undefined) ?? null;
    }
  }

  let chargeFailure: string | null = null;
  try {
    await applyMissedAppointmentCharge({ supabase, studioId, appointment, chargeSource: missedAppointmentCharge });
  } catch (chargeError) {
    console.error("Appointment marked no-show, but deduction failed:", chargeError);
    chargeFailure = safeChargeMessage(chargeError);
    // The database may have committed the deduction before a later step threw (for example the package lifecycle reconcile). Trust the marker, not the exception.
    if (chargeKind && (await appliedChargeKind(supabase, appointmentId).catch(() => null)) === chargeKind) chargeFailure = null;
  }

  if (chargeFailure) return { ok: false, reason: "charge_failed", message: chargeFailure };

  // The charge is applied: the one note says so (best effort; the deduction is what matters).
  if (chargeKind) await markNoteApplied(supabase, note, chargeKind);

  return { ok: true, appointmentId, clientId: appointment.client_id, status: "no_show", alreadyApplied, usageSyncPending: false };
}

const KNOWN_CHARGE_MESSAGES = [
  "This appointment is not linked to a client.",
  "No package is linked to this appointment.",
  "No eligible membership benefit was found for this appointment.",
  "Choose a valid missed-appointment deduction option.",
];
const GENERIC_CHARGE_MESSAGE = "The missed-lesson charge could not be applied.";

/** Only the app-level messages applyMissedAppointmentCharge itself raises pass through; anything else (database text) becomes a fixed sentence. */
function safeChargeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return KNOWN_CHARGE_MESSAGES.includes(message) ? message : GENERIC_CHARGE_MESSAGE;
}

function billingTypeOf(appointment: AppointmentRow) {
  return normalizeLessonBillingType(appointment.billing_type, appointment.appointment_type);
}

const PACKAGE_EXHAUSTED_MESSAGES = ["No matching active package credit was found for this appointment.", "The selected package has no remaining credits."];
const NOTE_REF_PREFIX = "Appointment ref: ";

/** The charge actually applied to this appointment, from the deduction marker or the membership usage row (null = nothing applied). */
async function appliedChargeKind(supabase: SupabaseClient, appointmentId: string): Promise<"package" | "membership" | null> {
  if ((await chargedPackageIds(supabase, appointmentId)).length > 0) return "package";
  const { data, error } = await supabase.from("client_membership_usage").select("id").eq("reference_type", "appointment").eq("reference_id", appointmentId).limit(1);
  if (error) throw new Error(`Usage lookup failed: ${error.message}`);
  return (data ?? []).length > 0 ? "membership" : null;
}

type NoteRow = { id: string; body: string };

async function noShowNote(supabase: SupabaseClient, studioId: string, appointment: AppointmentRow): Promise<NoteRow | null> {
  if (!appointment.client_id) return null;
  const ref = `${NOTE_REF_PREFIX}${appointment.id}`;
  // The OLDEST note that quotes the ref, validated in code: it must be the system's own shape (first line "Appointment marked no-show", last line exactly the ref), so an
  // ordinary note that merely quotes the id, or a later copy, cannot decide.
  const { data, error } = await supabase
    .from("client_activity_notes")
    .select("id, body")
    .eq("studio_id", studioId)
    .eq("client_id", appointment.client_id)
    .like("body", `%${ref}%`)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw new Error(`Note lookup failed: ${error.message}`);
  const rows = (data ?? []) as NoteRow[];
  return (
    rows.find((row) => {
      const lines = String(row.body).split("\n");
      return lines[0].startsWith("Appointment marked no-show") && lines[lines.length - 1] === ref;
    }) ?? null
  );
}

const NOT_APPLIED_TEXT = "requested, not applied";
const chargeName = (kind: "package" | "membership") => (kind === "package" ? "Package credit" : "Membership benefit");

async function rewriteNotePolicy(supabase: SupabaseClient, note: NoteRow, policy: string) {
  try {
    await supabase
      .from("client_activity_notes")
      .update({ body: note.body.replace(/Charge policy: .*/, `Charge policy: ${policy}`) })
      .eq("id", note.id);
  } catch (error) {
    console.error("The no-show note could not be updated.", error);
  }
}

async function markNoteApplied(supabase: SupabaseClient, note: NoteRow | null, kind: "package" | "membership") {
  if (!note || !note.body.includes(NOT_APPLIED_TEXT)) return;
  try {
    await supabase
      .from("client_activity_notes")
      .update({ body: note.body.replace(/Charge policy: .*/, `Charge policy: ${chargeName(kind)} deducted`) })
      .eq("id", note.id);
  } catch (error) {
    console.error("The no-show note could not be updated after the charge.", error);
  }
}

const DEDUCTION_TYPES = ["lesson_deduction", "appointment_attendance"];

async function chargedPackageIds(supabase: SupabaseClient, appointmentId: string): Promise<string[]> {
  const { data, error } = await supabase.from("lesson_transactions").select("client_package_id, transaction_type").eq("appointment_id", appointmentId);
  if (error) throw new Error(`Deduction lookup failed: ${error.message}`);
  return (data ?? [])
    .filter((row: { transaction_type: string }) => DEDUCTION_TYPES.includes(String(row.transaction_type)))
    .map((row: { client_package_id: string | null }) => row.client_package_id)
    .filter((value: string | null): value is string => Boolean(value));
}

// ---- Moved verbatim from src/app/app/schedule/actions.ts (supabase param types widened to SupabaseClient) ----

export function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "practice_party") return "Practice Party";
  if (value === "coaching") return "Coaching";
  if (value === "floor_space_rental") return "Floor Space Rental";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export type LessonBillingType =
  | "package_credit"
  | "membership"
  | "pay_as_you_go"
  | "free_comped";

export function normalizeLessonBillingType(
  value: string | null,
  appointmentType: string,
): LessonBillingType {
  if (
    appointmentType === "floor_space_rental" ||
    appointmentType === "room_unavailable"
  ) {
    return "package_credit";
  }

  if (
    value === "package_credit" ||
    value === "membership" ||
    value === "pay_as_you_go" ||
    value === "free_comped"
  ) {
    return value;
  }

  return "package_credit";
}

function datePart(value: string) {
  return value.slice(0, 10);
}

function getUsageBenefitTypeForAppointmentType(appointmentType: string) {
  switch (appointmentType) {
    case "private_lesson":
    case "intro_lesson":
    case "coaching":
      return "private_lesson";
    case "group_class":
      return "group_class";
    default:
      return null;
  }
}

function getMembershipBenefitTypesForAppointmentType(appointmentType: string) {
  const usageType = getUsageBenefitTypeForAppointmentType(appointmentType);

  if (usageType === "private_lesson") {
    return [
      "included_private_lessons",
      "discount_private_lessons_percent",
      "discount_private_lessons_fixed",
    ];
  }

  if (usageType === "group_class") {
    return [
      "included_group_classes",
      "discount_group_classes_percent",
      "discount_group_classes_fixed",
    ];
  }

  return [];
}

function membershipBenefitAppliesToAppointmentType(
  benefit: { applies_to?: string | null },
  appointmentType: string,
) {
  const appliesTo = benefit.applies_to?.trim();
  if (!appliesTo || appliesTo === "all") return true;

  const usageType = getUsageBenefitTypeForAppointmentType(appointmentType);

  return (
    appliesTo === appointmentType ||
    Boolean(usageType && appliesTo === usageType)
  );
}

export async function clearMembershipUsageForAppointment(params: {
  supabase: SupabaseClient;
  appointmentId: string;
}) {
  const { supabase, appointmentId } = params;

  const { error } = await supabase
    .from("client_membership_usage")
    .delete()
    .eq("reference_type", "appointment")
    .eq("reference_id", appointmentId);

  if (error) {
    throw new Error(`Could not clear membership usage: ${error.message}`);
  }
}

export async function syncMembershipUsageForAppointment(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
  clientId: string;
  appointmentType: string;
  status: string;
  startsAtIso: string;
  clientMembershipId?: string | null;
}) {
  const {
    supabase,
    studioId,
    appointmentId,
    clientId,
    appointmentType,
    status,
    startsAtIso,
    clientMembershipId = null,
  } = params;

  const usageType = getUsageBenefitTypeForAppointmentType(appointmentType);

  // Membership Usage-Period Alignment / P6d/P6e: private-lesson membership
  // usage (included_private_lessons on private_lesson/intro_lesson/
  // coaching) is now owned EXCLUSIVELY by the canonical DB trigger
  // (sync_membership_usage_for_private_lesson_appointment), which is
  // preservation-first (P6d: never deletes existing usage automatically)
  // and backstopped by enforce_private_lesson_membership_capacity and
  // enforce_private_lesson_attendance_lifecycle (P6e). This check MUST
  // run before the unconditional clear below, not after it -- a prior
  // version of this function cleared first and checked the type second,
  // which meant every call from markAppointmentAttendedAction for a
  // membership-funded private lesson immediately deleted the usage row
  // the DB trigger had just correctly created moments earlier in the same
  // action, silently defeating the entire DB-side sync for its most
  // common case. This function now never touches client_membership_usage
  // at all for private-lesson-family types -- it only ever acts on
  // appointment types the DB engine does not yet own (e.g. group_class).
  if (usageType === "private_lesson") return;

  await clearMembershipUsageForAppointment({
    supabase,
    appointmentId,
  });

  if (status !== "attended") return;
  if (!usageType) return;

  const usageDate = datePart(startsAtIso);

  const { data: activeMemberships, error: membershipsError } = await supabase
    .from("client_memberships")
    .select("id, membership_plan_id, current_period_start, current_period_end")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .in("status", ["active", "trialing", "past_due", "unpaid"]);

  if (membershipsError) {
    throw new Error(
      `Could not load active memberships: ${membershipsError.message}`,
    );
  }

  const matchingMembership = (activeMemberships ?? []).find((membership) => {
    if (clientMembershipId && membership.id !== clientMembershipId) return false;
    const startsOk =
      !membership.current_period_start ||
      membership.current_period_start <= usageDate;
    const endsOk =
      !membership.current_period_end ||
      membership.current_period_end >= usageDate;
    return startsOk && endsOk;
  });

  if (!matchingMembership) return;

  const membershipBenefitTypes = getMembershipBenefitTypesForAppointmentType(
    appointmentType,
  );

  if (membershipBenefitTypes.length === 0) return;

  const { data: planBenefits, error: benefitsError } = await supabase
    .from("membership_plan_benefits")
    .select("id, benefit_type, applies_to")
    .eq("membership_plan_id", matchingMembership.membership_plan_id)
    .in("benefit_type", membershipBenefitTypes);

  if (benefitsError) {
    throw new Error(
      `Could not load membership benefits: ${benefitsError.message}`,
    );
  }

  const benefit = (planBenefits ?? []).find((candidate) =>
    membershipBenefitAppliesToAppointmentType(candidate, appointmentType),
  );
  if (!benefit) return;

  const { data: membershipPeriod, error: periodError } = await supabase
    .from("client_membership_periods")
    .select("id, payment_status")
    .eq("client_membership_id", matchingMembership.id)
    .lte("period_start", usageDate)
    .gte("period_end", usageDate)
    .limit(1)
    .maybeSingle();

  if (periodError) {
    throw new Error(`Could not load membership period: ${periodError.message}`);
  }

  if (!membershipPeriod) {
    throw new Error("Membership usage cannot be recorded because no renewal period covers this appointment.");
  }

  const { data: membershipSettings, error: membershipSettingsError } = await supabase
    .from("studio_settings")
    .select("block_unpaid_membership_booking")
    .eq("studio_id", studioId)
    .single();

  if (membershipSettingsError || !membershipSettings) {
    throw new Error("Studio membership booking settings could not be loaded.");
  }

  const paymentStatus = String(membershipPeriod.payment_status ?? "due");
  if (["void"].includes(paymentStatus)) {
    throw new Error("Membership usage cannot be recorded against a void renewal period.");
  }
  if (
    membershipSettings.block_unpaid_membership_booking &&
    !["paid", "waived"].includes(paymentStatus)
  ) {
    throw new Error("Membership usage cannot be recorded against an unpaid renewal period.");
  }

  const { error: usageInsertError } = await supabase
    .from("client_membership_usage")
    .insert({
      client_membership_id: matchingMembership.id,
      client_membership_period_id: membershipPeriod.id,
      membership_plan_benefit_id: benefit.id,
      usage_date: usageDate,
      quantity_used: 1,
      reference_type: "appointment",
      reference_id: appointmentId,
    });

  if (usageInsertError) {
    throw new Error(
      `Could not record membership usage: ${usageInsertError.message}`,
    );
  }
}

/**
 * Package credit deduction for an attended appointment is performed
 * atomically and idempotently by the `deduct_package_credit_when_appointment_attended`
 * database trigger (fires on `appointments.status -> 'attended'`), which marks
 * its work with a `lesson_transactions` row of `transaction_type: "lesson_deduction"`.
 *
 * This function defers to the `deduct_package_credit_for_appointment` RPC for
 * the actual deduction, rather than doing its own read-then-write against
 * `client_package_items`, so the two mechanisms can never deduct
 * independently for the same appointment and two concurrent deductions
 * against the same package (e.g. this function running for one appointment
 * while the trigger fires for a different one) can't race and lose an
 * update:
 *   - Normal attendance marking: the trigger already ran (synchronously, as
 *     part of the preceding `appointments` update) by the time this function
 *     is called, so the RPC finds its marker already present and only
 *     mirrors the resulting balance into the legacy `client_packages.lessons_*`
 *     columns.
 *   - Missed-appointment charges applied on cancel/no-show (`applyMissedAppointmentCharge`):
 *     the appointment's status is `cancelled`/`no_show`, not `attended`, so the
 *     trigger never fires. The RPC performs the single deduction itself,
 *     under a row lock on the package item, so a later genuine `attended`
 *     transition (or a replay of this same call) is correctly recognized as
 *     already handled.
 *
 * The RPC recognizes both the current (`lesson_deduction`) and legacy
 * (`appointment_attendance`) transaction markers as evidence of a prior
 * deduction, so replaying this for an appointment attended before the
 * `lesson_deduction` marker existed cannot consume a second credit.
 */
export async function syncPackageUsageForAttendedAppointment(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
  clientId: string | null;
  appointmentType: string;
  clientPackageId: string | null;
}) {
  const {
    supabase,
    studioId,
    appointmentId,
    clientId,
    appointmentType,
    clientPackageId,
  } = params;

  if (!clientId || !clientPackageId) return;

  const usageType = packageUsageTypeForAppointment(appointmentType);
  if (!usageType) return;

  const { data, error } = await supabase.rpc(
    "deduct_package_credit_for_appointment",
    {
      p_studio_id: studioId,
      p_client_id: clientId,
      p_client_package_id: clientPackageId,
      p_appointment_id: appointmentId,
      p_usage_type: usageType,
    },
  );

  if (error) {
    throw new Error(error.message);
  }

  const result = Array.isArray(data) ? data[0] : data;

  if (!result?.found_item) {
    // Already deducted and the package has since been reconciled to
    // inactive (e.g. it was fully depleted) — nothing left to do.
    return;
  }

  if (result.is_unlimited) return;

  await reconcileClientPackageLifecycle({
    supabase,
    studioId,
    clientId,
    clientPackageId,
  });
}

export async function applyMissedAppointmentCharge(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointment: {
    id: string;
    client_id: string | null;
    appointment_type: string;
    starts_at: string;
    client_package_id: string | null;
    billing_type: string | null;
    client_membership_id?: string | null;
  };
  chargeSource: string;
}) {
  const { supabase, studioId, appointment, chargeSource } = params;

  if (chargeSource === "none") return;

  if (!appointment.client_id) {
    throw new Error("This appointment is not linked to a client.");
  }

  if (chargeSource === "package") {
    if (!appointment.client_package_id) {
      throw new Error("No package is linked to this appointment.");
    }

    await syncPackageUsageForAttendedAppointment({
      supabase,
      studioId,
      appointmentId: appointment.id,
      clientId: appointment.client_id,
      appointmentType: appointment.appointment_type,
      clientPackageId: appointment.client_package_id,
    });

    return;
  }

  if (chargeSource === "membership") {
    await syncMembershipUsageForAppointment({
      supabase,
      studioId,
      appointmentId: appointment.id,
      clientId: appointment.client_id,
      appointmentType: appointment.appointment_type,
      status: "attended",
      startsAtIso: appointment.starts_at,
      clientMembershipId: appointment.client_membership_id ?? null,
    });

    const { data: usageRows, error: usageLookupError } = await supabase
      .from("client_membership_usage")
      .select("id")
      .eq("reference_type", "appointment")
      .eq("reference_id", appointment.id)
      .limit(1);

    if (usageLookupError) {
      throw new Error(
        `Could not verify membership deduction: ${usageLookupError.message}`,
      );
    }

    if ((usageRows ?? []).length === 0) {
      throw new Error(
        "No eligible membership benefit was found for this appointment.",
      );
    }

    return;
  }

  throw new Error("Choose a valid missed-appointment deduction option.");
}

async function packageHasAvailableCreditForAttendance(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string | null;
  appointmentType: string;
  clientPackageId: string | null;
}) {
  const { supabase, studioId, clientId, appointmentType, clientPackageId } =
    params;

  if (!clientId || !clientPackageId) return false;

  const usageType = packageUsageTypeForAppointment(appointmentType);
  if (!usageType) return false;

  const { data: packageItem, error: packageItemError } = await supabase
    .from("client_package_items")
    .select(
      `
      id,
      quantity_remaining,
      is_unlimited,
      client_packages!inner (
        id,
        studio_id,
        client_id,
        active
      )
    `,
    )
    .eq("client_package_id", clientPackageId)
    .eq("usage_type", usageType)
    .eq("client_packages.studio_id", studioId)
    .eq("client_packages.client_id", clientId)
    .eq("client_packages.active", true)
    .limit(1)
    .maybeSingle();

  if (packageItemError) {
    throw new Error(
      `Could not load package credit: ${packageItemError.message}`,
    );
  }

  if (!packageItem) return false;
  if (packageItem.is_unlimited) return true;

  return Number(packageItem.quantity_remaining ?? 0) > 0;
}

export async function canMarkAppointmentAttendedWithoutPaymentWarning(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointment: {
    id: string;
    client_id: string | null;
    appointment_type: string;
    starts_at: string;
    client_package_id: string | null;
    client_membership_id: string | null;
    price_amount: number | string | null;
    payment_status: string | null;
    billing_type: string | null;
  };
}) {
  const { supabase, studioId, appointment } = params;

  const usageType = packageUsageTypeForAppointment(
    appointment.appointment_type,
  );
  if (!usageType) return true;

  const billingType = normalizeLessonBillingType(
    appointment.billing_type,
    appointment.appointment_type,
  );
  const paymentStatus = (appointment.payment_status ?? "").toLowerCase();

  if (billingType === "free_comped") {
    return true;
  }

  if (billingType === "pay_as_you_go") {
    return paymentStatus === "paid";
  }

  if (billingType === "membership") {
    const validation = await validateMembershipEntitlement({
      supabase,
      studioId,
      clientId: appointment.client_id ?? "",
      appointmentType: appointment.appointment_type,
      startsAtIso: appointment.starts_at,
      clientMembershipId: appointment.client_membership_id ?? null,
      excludeAppointmentId: appointment.id,
      includeFutureReservations: false,
    });
    return validation.ok;
  }

  return packageHasAvailableCreditForAttendance({
    supabase,
    studioId,
    clientId: appointment.client_id,
    appointmentType: appointment.appointment_type,
    clientPackageId: appointment.client_package_id,
  });
}
