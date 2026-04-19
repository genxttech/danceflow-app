"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { detectAppointmentConflicts } from "@/lib/schedule/conflicts";
import { generateWeeklyOccurrenceDates } from "@/lib/utils/recurrence";
import {
  requireAppointmentCreateAccess,
  requireAppointmentEditAccess,
  requireAttendanceAccess,
} from "@/lib/auth/serverRoleGuard";

type ActionState = {
  error: string;
};

type PackageValidationResult = {
  ok: boolean;
  error?: string;
};

type LessonRecapValidationResult = {
  ok: boolean;
  error?: string;
  appointment?: {
    id: string;
    studio_id: string;
    client_id: string | null;
    instructor_id: string | null;
    appointment_type: string;
    status: string;
  };
};

type FloorRentalSlot = {
  date: string;
  startTime: string;
  endTime: string;
};

const LESSON_RECAP_VIDEO_BUCKET = "lesson-recap-videos";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getNullableString(formData: FormData, key: string) {
  const value = getString(formData, key);
  return value || null;
}

function getNumberOrNull(value: string) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBoolean(formData: FormData, key: string) {
  const value = formData.get(key);
  return value === "on" || value === "true" || value === "1";
}

function toIsoDateTime(date: string, time: string) {
  return `${date}T${time}:00`;
}

function toIsoFromLocalDateTime(value: string) {
  if (!value) return null;
  return value.length === 16 ? `${value}:00` : value;
}

function datePart(value: string) {
  return value.slice(0, 10);
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function getSuccessRedirect(formData: FormData, fallback: string, successCode: string) {
  const returnTo = getString(formData, "returnTo");
  return appendQueryParam(returnTo || fallback, "success", successCode);
}

function getErrorRedirect(formData: FormData, fallback: string, errorCode: string) {
  const returnTo = getString(formData, "returnTo");
  return appendQueryParam(returnTo || fallback, "error", errorCode);
}

function isFloorSpaceRental(appointmentType: string) {
  return appointmentType === "floor_space_rental";
}

function parseSlotsJson(raw: string): FloorRentalSlot[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => ({
        date: typeof item?.date === "string" ? item.date.trim() : "",
        startTime: typeof item?.startTime === "string" ? item.startTime.trim() : "",
        endTime: typeof item?.endTime === "string" ? item.endTime.trim() : "",
      }))
      .filter((item) => item.date && item.startTime && item.endTime);
  } catch {
    return [];
  }
}

function normalizeAppointmentRelations(params: {
  appointmentType: string;
  instructorId: string | null;
  roomId: string | null;
  clientPackageId: string | null;
}) {
  const { appointmentType, instructorId, roomId, clientPackageId } = params;

  if (isFloorSpaceRental(appointmentType)) {
    return {
      instructor_id: instructorId,
      room_id: roomId,
      client_package_id: null,
    };
  }

  return {
    instructor_id: instructorId,
    room_id: roomId,
    client_package_id: clientPackageId,
  };
}

function firstRelationRow<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "practice_party") return "Practice Party";
  if (value === "coaching") return "Coaching";
  if (value === "floor_space_rental") return "Floor Space Rental";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizePhoneForDelivery(value: string | null | undefined) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits || null;
}

function rethrowIfRedirect(error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  ) {
    throw error;
  }
}

async function queueAppointmentOutboundDelivery(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentEditAccess>>["supabase"];
  studioId: string;
  appointmentId: string;
  reason: "confirmed" | "rescheduled" | "cancelled";
}) {
  const { supabase, studioId, appointmentId, reason } = params;

  try {
    const { data: appointment, error } = await supabase
      .from("appointments")
      .select(
        `
        id,
        studio_id,
        client_id,
        partner_client_id,
        instructor_id,
        room_id,
        title,
        appointment_type,
        status,
        starts_at,
        ends_at,
        notes
      `
      )
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .single();

    if (error || !appointment) {
      console.error("Could not load appointment for outbound delivery:", error?.message);
      return;
    }

    const startsAt = new Date(String(appointment.starts_at));
    if (Number.isNaN(startsAt.getTime())) return;
    if (startsAt.getTime() < Date.now()) return;

    const clientId =
      typeof appointment.client_id === "string" ? appointment.client_id : null;
    const partnerClientId =
      typeof appointment.partner_client_id === "string"
        ? appointment.partner_client_id
        : null;
    const instructorId =
      typeof appointment.instructor_id === "string" ? appointment.instructor_id : null;
    const roomId =
      typeof appointment.room_id === "string" ? appointment.room_id : null;

    type NotificationClient = {
      first_name?: string | null;
      last_name?: string | null;
      email?: string | null;
      phone?: string | null;
    };

    let client: NotificationClient | null = null;
    let partnerClient: NotificationClient | null = null;
    let instructor:
      | {
          first_name?: string | null;
          last_name?: string | null;
        }
      | null = null;
    let room:
      | {
          name?: string | null;
        }
      | null = null;

    if (clientId) {
      const { data } = await supabase
        .from("clients")
        .select("first_name, last_name, email, phone")
        .eq("id", clientId)
        .maybeSingle();

      client = data ?? null;
    }

    if (partnerClientId) {
      const { data } = await supabase
        .from("clients")
        .select("first_name, last_name, email, phone")
        .eq("id", partnerClientId)
        .maybeSingle();

      partnerClient = data ?? null;
    }

    if (instructorId) {
      const { data } = await supabase
        .from("staff")
        .select("first_name, last_name")
        .eq("id", instructorId)
        .maybeSingle();

      instructor = data ?? null;
    }

    if (roomId) {
      const { data } = await supabase
        .from("rooms")
        .select("name")
        .eq("id", roomId)
        .maybeSingle();

      room = data ?? null;
    }

    const templateKey =
      reason === "cancelled"
        ? "appointment_cancelled"
        : reason === "rescheduled"
          ? "appointment_rescheduled"
          : "appointment_confirmed";

    const appointmentLabel =
      (typeof appointment.title === "string" && appointment.title.trim().length > 0
        ? appointment.title.trim()
        : appointmentTypeLabel(String(appointment.appointment_type))) || "Appointment";

    const basePayload = {
      appointmentId: String(appointment.id),
      appointmentType: String(appointment.appointment_type),
      appointmentLabel,
      status: String(appointment.status),
      startsAt: String(appointment.starts_at),
      endsAt: String(appointment.ends_at),
      notes: appointment.notes ?? null,
      clientFirstName: client?.first_name ?? null,
      clientLastName: client?.last_name ?? null,
      partnerFirstName: partnerClient?.first_name ?? null,
      partnerLastName: partnerClient?.last_name ?? null,
      instructorFirstName: instructor?.first_name ?? null,
      instructorLastName: instructor?.last_name ?? null,
      roomName: room?.name ?? null,
      reason,
    };

    const rows: Array<Record<string, unknown>> = [];
    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();

    function queueRecipient(
      recipient: NotificationClient | null,
      recipientRole: "primary" | "partner"
    ) {
      const recipientEmail =
        typeof recipient?.email === "string" && recipient.email.trim().length > 0
          ? recipient.email.trim()
          : null;

      const recipientPhone = normalizePhoneForDelivery(recipient?.phone ?? null);

      const payload = {
        ...basePayload,
        recipientRole,
      };

      if (recipientEmail && !seenEmails.has(recipientEmail)) {
        seenEmails.add(recipientEmail);
        rows.push({
          studio_id: studioId,
          channel: "email",
          template_key: templateKey,
          recipient_email: recipientEmail,
          recipient_phone: null,
          status: "queued",
          related_table: "appointments",
          related_id: appointmentId,
          payload,
        });
      }

      if (recipientPhone && !seenPhones.has(recipientPhone)) {
        seenPhones.add(recipientPhone);
        rows.push({
          studio_id: studioId,
          channel: "sms",
          template_key: templateKey,
          recipient_email: null,
          recipient_phone: recipientPhone,
          status: "queued",
          related_table: "appointments",
          related_id: appointmentId,
          payload,
        });
      }
    }

    queueRecipient(client, "primary");

    if (
      String(appointment.appointment_type) === "private_lesson" &&
      partnerClientId
    ) {
      queueRecipient(partnerClient, "partner");
    }

    if (rows.length === 0) return;

    const { error: insertError } = await supabase
      .from("outbound_deliveries")
      .insert(rows);

    if (insertError) {
      console.error("Could not queue appointment outbound delivery:", insertError.message);
    }
  } catch (error) {
    rethrowIfRedirect(error);
    console.error("Unexpected error queuing appointment outbound delivery:", error);
  }
}

async function validateClientPackageForBooking(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentCreateAccess>>["supabase"];
  studioId: string;
  clientId: string;
  clientPackageId: string | null;
}): Promise<PackageValidationResult> {
  const { supabase, studioId, clientId, clientPackageId } = params;

  if (!clientPackageId) return { ok: true };

  const { data: studioSettings, error: settingsError } = await supabase
    .from("studio_settings")
    .select("block_depleted_package_booking")
    .eq("studio_id", studioId)
    .single();

  if (settingsError || !studioSettings) {
    return { ok: false, error: "Studio settings could not be loaded." };
  }

  const { data: pkg, error } = await supabase
    .from("client_packages")
    .select(
      `
      id,
      studio_id,
      client_id,
      active,
      client_package_items (
        usage_type,
        quantity_remaining,
        quantity_total,
        is_unlimited
      )
    `
    )
    .eq("id", clientPackageId)
    .eq("studio_id", studioId)
    .single();

  if (error || !pkg) {
    return { ok: false, error: "Selected package was not found." };
  }

  if (pkg.client_id !== clientId) {
    return {
      ok: false,
      error: "Selected package does not belong to the chosen client.",
    };
  }

  if (!pkg.active) {
    return {
      ok: false,
      error: "Selected package is inactive and cannot be used for booking.",
    };
  }

  const items = Array.isArray(pkg.client_package_items) ? pkg.client_package_items : [];
  const finiteItems = items.filter(
    (item) => !item.is_unlimited && typeof item.quantity_remaining === "number"
  );

  if (finiteItems.length === 0) {
    return { ok: true };
  }

  const lowestRemaining = Math.min(
    ...finiteItems.map((item) => Number(item.quantity_remaining ?? 0))
  );

  if (lowestRemaining <= 0 && studioSettings.block_depleted_package_booking) {
    return {
      ok: false,
      error: "Selected package has no remaining balance.",
    };
  }

  return { ok: true };
}

async function validateFloorRentalClient(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentCreateAccess>>["supabase"];
  studioId: string;
  clientId: string;
}) {
  const { supabase, studioId, clientId } = params;

  const { data: client, error } = await supabase
    .from("clients")
    .select("id, is_independent_instructor")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .single();

  if (error || !client) {
    return { ok: false, error: "Selected client was not found." };
  }

  if (!client.is_independent_instructor) {
    return {
      ok: false,
      error:
        "Floor space rentals can only be booked for clients marked as independent instructors.",
    };
  }

  return { ok: true };
}

async function validateAppointmentConflicts(params: {
  studioId: string;
  startsAt: string;
  endsAt: string;
  instructorId: string | null;
  roomId: string | null;
  clientId: string;
  excludeAppointmentId?: string;
  overrideRoomConflict?: boolean;
}) {
  return detectAppointmentConflicts({
    studioId: params.studioId,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    instructorId: params.instructorId,
    roomId: params.roomId,
    clientId: params.clientId,
    excludeAppointmentId: params.excludeAppointmentId,
  });
}

function getConflictErrorMessage(conflict: unknown) {
  if (!conflict) return "Scheduling conflict detected.";

  if (typeof conflict === "string") {
    return conflict;
  }

  if (typeof conflict === "object") {
    const value = conflict as {
      message?: string;
      error?: string;
      hasConflict?: boolean;
      roomConflict?: boolean;
      instructorConflict?: boolean;
      clientConflict?: boolean;
    };

    if (typeof value.message === "string" && value.message.trim()) {
      return value.message;
    }

    if (typeof value.error === "string" && value.error.trim()) {
      return value.error;
    }

    if (value.roomConflict || value.hasConflict) {
      return "There is a room conflict for the selected time.";
    }

    if (value.instructorConflict) {
      return "The selected instructor already has an appointment during that time.";
    }

    if (value.clientConflict) {
      return "The selected client already has an appointment during that time.";
    }
  }

  return "Scheduling conflict detected.";
}

async function promoteLeadClientAfterBookedAppointment(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentCreateAccess>>["supabase"];
  studioId: string;
  clientId: string;
  userId: string;
  appointmentType: string;
  startsAtIso: string;
  appointmentId: string;
  status: string;
}) {
  const {
    supabase,
    studioId,
    clientId,
    userId,
    appointmentType,
    startsAtIso,
    appointmentId,
    status,
  } = params;

  if (!clientId || status === "cancelled") return;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, status")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .single();

  if (clientError || !client || client.status !== "lead") return;

  const { error: updateError } = await supabase
    .from("clients")
    .update({
      status: "active",
      updated_at: new Date().toISOString(),
    })
    .eq("id", clientId)
    .eq("studio_id", studioId);

  if (updateError) {
    throw new Error(`Could not convert lead after booking: ${updateError.message}`);
  }

  const { error: activityError } = await supabase.from("lead_activities").insert({
    studio_id: studioId,
    client_id: clientId,
    activity_type: "note",
    note: `Lead converted to active client via booked appointment.\nAppointment type: ${appointmentType}\nScheduled for: ${startsAtIso}\nAppointment ID: ${appointmentId}`,
    follow_up_due_at: null,
    created_by: userId,
  });

  if (activityError) {
    console.error("Failed to create lead conversion activity:", activityError.message);
  }
}

function getUsageBenefitTypeForAppointmentType(appointmentType: string) {
  switch (appointmentType) {
    case "private_lesson":
      return "private_lesson";
    case "group_class":
      return "group_class";
    default:
      return null;
  }
}

async function clearMembershipUsageForAppointment(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentCreateAccess>>["supabase"];
  studioId: string;
  appointmentId: string;
}) {
  const { supabase, studioId, appointmentId } = params;

  const { error } = await supabase
    .from("client_membership_usage")
    .delete()
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId);

  if (error) {
    throw new Error(`Could not clear membership usage: ${error.message}`);
  }
}

async function syncMembershipUsageForAppointment(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentCreateAccess>>["supabase"];
  studioId: string;
  appointmentId: string;
  clientId: string;
  appointmentType: string;
  status: string;
  startsAtIso: string;
}) {
  const {
    supabase,
    studioId,
    appointmentId,
    clientId,
    appointmentType,
    status,
    startsAtIso,
  } = params;

  await clearMembershipUsageForAppointment({
    supabase,
    studioId,
    appointmentId,
  });

  if (status !== "attended") return;

  const usageType = getUsageBenefitTypeForAppointmentType(appointmentType);
  if (!usageType) return;

  const usageDate = datePart(startsAtIso);

  const { data: activeMemberships, error: membershipsError } = await supabase
    .from("client_memberships")
    .select("id, membership_plan_id, current_period_start, current_period_end")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("status", "active");

  if (membershipsError) {
    throw new Error(`Could not load active memberships: ${membershipsError.message}`);
  }

  const matchingMembership = (activeMemberships ?? []).find((membership) => {
    const startsOk =
      !membership.current_period_start || membership.current_period_start <= usageDate;
    const endsOk =
      !membership.current_period_end || membership.current_period_end >= usageDate;
    return startsOk && endsOk;
  });

  if (!matchingMembership) return;

  const { data: planBenefits, error: benefitsError } = await supabase
    .from("membership_plan_benefits")
    .select("id, benefit_type, quantity")
    .eq("membership_plan_id", matchingMembership.membership_plan_id)
    .eq("benefit_type", usageType)
    .limit(1);

  if (benefitsError) {
    throw new Error(`Could not load membership benefits: ${benefitsError.message}`);
  }

  const benefit = planBenefits?.[0];
  if (!benefit) return;

  const { error: usageInsertError } = await supabase
    .from("client_membership_usage")
    .insert({
      studio_id: studioId,
      client_membership_id: matchingMembership.id,
      client_id: clientId,
      appointment_id: appointmentId,
      benefit_type: usageType,
      quantity_used: 1,
      usage_date: usageDate,
      notes: `Auto-recorded from ${appointmentType} attendance.`,
    });

  if (usageInsertError) {
    throw new Error(`Could not record membership usage: ${usageInsertError.message}`);
  }
}

async function recomputeFloorRentalPaymentStatus(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentEditAccess>>["supabase"];
  studioId: string;
  appointmentId: string;
}) {
  const { supabase, studioId, appointmentId } = params;

  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .select("id, appointment_type, price_amount")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .single();

  if (appointmentError || !appointment) {
    throw new Error("Appointment not found for payment status refresh.");
  }

  if (appointment.appointment_type !== "floor_space_rental") return;

  const amountDue = Number(appointment.price_amount ?? 0);

  const { data: payments, error: paymentsError } = await supabase
    .from("payments")
    .select("amount, status")
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId);

  if (paymentsError) {
    throw new Error(`Could not load floor rental payments: ${paymentsError.message}`);
  }

  const paidTotal = (payments ?? [])
    .filter((payment) => payment.status === "processed")
    .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);

  let paymentStatus = "unpaid";
  if (amountDue <= 0) {
    paymentStatus = "waived";
  } else if (paidTotal >= amountDue) {
    paymentStatus = "paid";
  } else if (paidTotal > 0) {
    paymentStatus = "partial";
  }

  const { error: updateError } = await supabase
    .from("appointments")
    .update({
      payment_status: paymentStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", appointmentId)
    .eq("studio_id", studioId);

  if (updateError) {
    throw new Error(`Could not update rental payment status: ${updateError.message}`);
  }
}

async function validateLessonRecapAppointment(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentEditAccess>>["supabase"];
  studioId: string;
  appointmentId: string;
}): Promise<LessonRecapValidationResult> {
  const { supabase, studioId, appointmentId } = params;

  const { data: appointment, error } = await supabase
    .from("appointments")
    .select("id, studio_id, client_id, instructor_id, appointment_type, status")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .single();

  if (error || !appointment) {
    return { ok: false, error: "Appointment not found." };
  }

  if (appointment.appointment_type !== "private_lesson") {
    return {
      ok: false,
      error: "Lesson recaps are only available for private lessons.",
    };
  }

  return {
    ok: true,
    appointment,
  };
}

async function getOrCreateLessonRecap(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentEditAccess>>["supabase"];
  studioId: string;
  appointmentId: string;
  clientId: string | null;
  instructorId: string | null;
  userId: string;
}) {
  const { supabase, studioId, appointmentId, clientId, instructorId, userId } = params;

  const { data: existingRecap, error: existingRecapError } = await supabase
    .from("lesson_recaps")
    .select("id")
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId)
    .maybeSingle();

  if (existingRecapError) {
    throw new Error(`Could not load lesson recap: ${existingRecapError.message}`);
  }

  if (existingRecap?.id) {
    return existingRecap.id;
  }

  const { data: insertedRecap, error: insertError } = await supabase
    .from("lesson_recaps")
    .insert({
      studio_id: studioId,
      appointment_id: appointmentId,
      client_id: clientId,
      instructor_id: instructorId,
      created_by: userId,
      summary: null,
      homework: null,
      next_focus: null,
      visible_to_client: false,
    })
    .select("id")
    .single();

  if (insertError || !insertedRecap) {
    throw new Error(`Could not create lesson recap: ${insertError?.message ?? "Unknown error."}`);
  }

  return insertedRecap.id;
}

async function deleteLessonRecapVideoByPath(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentEditAccess>>["supabase"];
  storagePath: string | null;
}) {
  const { supabase, storagePath } = params;
  if (!storagePath) return;

  const { error } = await supabase.storage
    .from(LESSON_RECAP_VIDEO_BUCKET)
    .remove([storagePath]);

  if (error) {
    console.error("Failed to delete lesson recap video from storage:", error.message);
  }
}

export async function createAppointmentAction(
  _: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const { supabase, studioId, user } = await requireAppointmentCreateAccess();

    const clientId = getString(formData, "clientId");
    const partnerClientId = getNullableString(formData, "partnerClientId");
    const appointmentType = getString(formData, "appointmentType");
    const title = getString(formData, "title");
    const notes = getString(formData, "notes");
    const status = "scheduled";
    const instructorId = getNullableString(formData, "instructorId");
    const roomId = getNullableString(formData, "roomId");
    const clientPackageId = getNullableString(formData, "clientPackageId");
    const priceAmount = getNumberOrNull(getString(formData, "priceAmount"));
    const paymentStatus = getNullableString(formData, "paymentStatus");
    const overrideRoomConflict = getBoolean(formData, "overrideRoomConflict");

    if (!clientId || !appointmentType) {
      return { error: "Client and appointment type are required." };
    }

    if (partnerClientId && partnerClientId === clientId) {
      return { error: "Partner must be different from the primary client." };
    }

    const relations = normalizeAppointmentRelations({
      appointmentType,
      instructorId,
      roomId,
      clientPackageId,
    });

    if (isFloorSpaceRental(appointmentType)) {
      const floorRentalClientValidation = await validateFloorRentalClient({
        supabase,
        studioId,
        clientId,
      });

      if (!floorRentalClientValidation.ok) {
        return { error: floorRentalClientValidation.error ?? "Invalid client." };
      }

      const slots = parseSlotsJson(getString(formData, "slotsJson"));
      if (slots.length === 0) {
        return { error: "Add at least one floor rental time slot." };
      }

      const rows: Array<Record<string, unknown>> = [];

      for (const slot of slots) {
        const startsAt = toIsoDateTime(slot.date, slot.startTime);
        const endsAt = toIsoDateTime(slot.date, slot.endTime);

        if (new Date(endsAt) <= new Date(startsAt)) {
          return { error: "Each floor rental slot must end after it starts." };
        }

        const conflict = await validateAppointmentConflicts({
          studioId,
          startsAt,
          endsAt,
          instructorId: relations.instructor_id,
          roomId: relations.room_id,
          clientId,
          overrideRoomConflict,
        });

        if (conflict?.hasConflict) {
  return { error: getConflictErrorMessage(conflict) };
}

        rows.push({
          studio_id: studioId,
          client_id: clientId,
          partner_client_id: null,
          title: title || "Floor Space Rental",
          appointment_type: appointmentType,
          starts_at: startsAt,
          ends_at: endsAt,
          status,
          notes: notes || null,
          price_amount: priceAmount,
          payment_status:
            paymentStatus ??
            (priceAmount && priceAmount > 0 ? "unpaid" : "waived"),
          created_by: user.id,
          ...relations,
        });
      }

      const { data: insertedRows, error: insertError } = await supabase
        .from("appointments")
        .insert(rows)
        .select("id, starts_at");

      if (insertError || !insertedRows?.length) {
        return {
          error: `Could not create floor rentals: ${insertError?.message ?? "Unknown error."}`,
        };
      }

      for (const row of insertedRows) {
        await promoteLeadClientAfterBookedAppointment({
          supabase,
          studioId,
          clientId,
          userId: user.id,
          appointmentType,
          startsAtIso: String(row.starts_at),
          appointmentId: String(row.id),
          status,
        });

        await queueAppointmentOutboundDelivery({
          supabase,
          studioId,
          appointmentId: String(row.id),
          reason: "confirmed",
        });
      }

      revalidatePath("/app/schedule");
      revalidatePath(`/app/clients/${clientId}`);
      redirect(`/app/schedule/${insertedRows[0].id}`);
    }

    const packageValidation = await validateClientPackageForBooking({
      supabase,
      studioId,
      clientId,
      clientPackageId: relations.client_package_id,
    });

    if (!packageValidation.ok) {
      return { error: packageValidation.error ?? "Package cannot be used." };
    }

    const startsAt =
      toIsoFromLocalDateTime(getString(formData, "startsAt")) ??
      toIsoDateTime(getString(formData, "date"), getString(formData, "startTime"));
    const endsAt =
      toIsoFromLocalDateTime(getString(formData, "endsAt")) ??
      toIsoDateTime(getString(formData, "date"), getString(formData, "endTime"));

    if (!startsAt || !endsAt) {
      return { error: "Date, start time, and end time are required." };
    }

    if (new Date(endsAt) <= new Date(startsAt)) {
      return { error: "Appointment must end after it starts." };
    }

    const isRecurring = getBoolean(formData, "isRecurring");
    const recurrenceFrequency = getString(formData, "recurrenceFrequency") || "weekly";
    const recurrenceInterval = Math.max(
      1,
      Number(getString(formData, "recurrenceInterval") || "1")
    );
    const recurrenceEndsMode = getString(formData, "recurrenceEndsMode") || "count";
    const recurrenceEndDate = getString(formData, "recurrenceEndDate");
    const recurrenceOccurrenceCount = Math.max(
      1,
      Number(getString(formData, "recurrenceOccurrenceCount") || "1")
    );

    if (!isRecurring) {
      const conflict = await validateAppointmentConflicts({
        studioId,
        startsAt,
        endsAt,
        instructorId: relations.instructor_id,
        roomId: relations.room_id,
        clientId,
        overrideRoomConflict,
      });

      if (conflict?.hasConflict) {
  return { error: getConflictErrorMessage(conflict) };
}

      const { data: appointment, error: insertError } = await supabase
        .from("appointments")
        .insert({
          studio_id: studioId,
          client_id: clientId,
          partner_client_id:
            appointmentType === "private_lesson" ? partnerClientId : null,
          title,
          appointment_type: appointmentType,
          starts_at: startsAt,
          ends_at: endsAt,
          status,
          notes: notes || null,
          created_by: user.id,
          ...relations,
        })
        .select("id")
        .single();

      if (insertError || !appointment) {
        return {
          error: `Could not create appointment: ${insertError?.message ?? "Unknown error."}`,
        };
      }

      await promoteLeadClientAfterBookedAppointment({
        supabase,
        studioId,
        clientId,
        userId: user.id,
        appointmentType,
        startsAtIso: startsAt,
        appointmentId: appointment.id,
        status,
      });

      await queueAppointmentOutboundDelivery({
        supabase,
        studioId,
        appointmentId: appointment.id,
        reason: "confirmed",
      });

      revalidatePath("/app/schedule");
      revalidatePath(`/app/clients/${clientId}`);
      redirect(`/app/schedule/${appointment.id}`);
    }

    if (recurrenceFrequency !== "weekly") {
      return { error: "Only weekly recurrence is supported right now." };
    }

    const startDate = datePart(startsAt);

    const occurrenceDates = generateWeeklyOccurrenceDates({
      startDate,
      endDate:
        recurrenceEndsMode === "date" ? recurrenceEndDate || undefined : undefined,
      occurrenceCount:
        recurrenceEndsMode === "count" ? recurrenceOccurrenceCount : undefined,
    });

    if (!occurrenceDates.length) {
      return { error: "No recurring dates were generated." };
    }

    const startTime = new Date(startsAt).toISOString().slice(11, 16);
    const durationMs = new Date(endsAt).getTime() - new Date(startsAt).getTime();
    const recurrenceSeriesId = crypto.randomUUID();
    const rows: Array<Record<string, unknown>> = [];

    for (const occurrenceDate of occurrenceDates) {
      const occurrenceStart = toIsoDateTime(occurrenceDate, startTime);
      const occurrenceEnd = new Date(
        new Date(occurrenceStart).getTime() + durationMs
      )
        .toISOString()
        .slice(0, 19);

      const conflict = await validateAppointmentConflicts({
        studioId,
        startsAt: occurrenceStart,
        endsAt: occurrenceEnd,
        instructorId: relations.instructor_id,
        roomId: relations.room_id,
        clientId,
        overrideRoomConflict,
      });

      if (conflict?.hasConflict) {
  return { error: getConflictErrorMessage(conflict) };
}

      rows.push({
        studio_id: studioId,
        client_id: clientId,
        partner_client_id:
          appointmentType === "private_lesson" ? partnerClientId : null,
        title,
        appointment_type: appointmentType,
        starts_at: occurrenceStart,
        ends_at: occurrenceEnd,
        status,
        notes: notes || null,
        created_by: user.id,
        recurrence_series_id: recurrenceSeriesId,
        recurrence_frequency: recurrenceFrequency,
        recurrence_interval: recurrenceInterval,
        recurrence_count: occurrenceDates.length,
        recurrence_ends_on:
          recurrenceEndsMode === "date" && recurrenceEndDate
            ? recurrenceEndDate
            : occurrenceDates[occurrenceDates.length - 1],
        ...relations,
      });
    }

    const { data: insertedRows, error: insertError } = await supabase
      .from("appointments")
      .insert(rows)
      .select("id, starts_at");

    if (insertError || !insertedRows?.length) {
      return {
        error: `Could not create recurring appointments: ${
          insertError?.message ?? "Unknown error."
        }`,
      };
    }

    for (const row of insertedRows) {
      await promoteLeadClientAfterBookedAppointment({
        supabase,
        studioId,
        clientId,
        userId: user.id,
        appointmentType,
        startsAtIso: String(row.starts_at),
        appointmentId: String(row.id),
        status,
      });
    }

    revalidatePath("/app/schedule");
    revalidatePath(`/app/clients/${clientId}`);
    redirect(`/app/schedule/${insertedRows[0].id}`);
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
}

export async function updateAppointmentAction(
  _: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const { supabase, studioId, user } = await requireAppointmentEditAccess();

    const appointmentId = getString(formData, "appointmentId");
    const clientId = getString(formData, "clientId");
    const partnerClientId = getNullableString(formData, "partnerClientId");
    const appointmentType = getString(formData, "appointmentType");
    const title = getString(formData, "title");
    const notes = getString(formData, "notes");
    const submittedStatus = getString(formData, "status");
    const scope = getString(formData, "scope") || getString(formData, "cancelScope") || "this_instance";

    const instructorId = getNullableString(formData, "instructorId");
    const roomId = getNullableString(formData, "roomId");
    const clientPackageId = getNullableString(formData, "clientPackageId");
    const priceAmount = getNumberOrNull(getString(formData, "priceAmount"));
    const paymentStatus = getNullableString(formData, "paymentStatus");
    const overrideRoomConflict = getBoolean(formData, "overrideRoomConflict");

    if (!appointmentId || !clientId || !appointmentType) {
      return { error: "Missing required appointment fields." };
    }

    if (partnerClientId && partnerClientId === clientId) {
      return { error: "Partner must be different from the primary client." };
    }

    const relations = normalizeAppointmentRelations({
      appointmentType,
      instructorId,
      roomId,
      clientPackageId,
    });

    const startsAt =
      toIsoFromLocalDateTime(getString(formData, "startsAt")) ??
      toIsoDateTime(getString(formData, "date"), getString(formData, "startTime"));
    const endsAt =
      toIsoFromLocalDateTime(getString(formData, "endsAt")) ??
      toIsoDateTime(getString(formData, "date"), getString(formData, "endTime"));

    if (!startsAt || !endsAt) {
      return { error: "Date, start time, and end time are required." };
    }

    if (new Date(endsAt) <= new Date(startsAt)) {
      return { error: "Appointment must end after it starts." };
    }

    if (isFloorSpaceRental(appointmentType)) {
      const floorRentalClientValidation = await validateFloorRentalClient({
        supabase,
        studioId,
        clientId,
      });

      if (!floorRentalClientValidation.ok) {
        return { error: floorRentalClientValidation.error ?? "Invalid client." };
      }
    } else {
      const packageValidation = await validateClientPackageForBooking({
        supabase,
        studioId,
        clientId,
        clientPackageId: relations.client_package_id,
      });

      if (!packageValidation.ok) {
        return { error: packageValidation.error ?? "Package cannot be used." };
      }
    }

    const { data: existingAppointment, error: existingError } = await supabase
      .from("appointments")
      .select("id, recurrence_series_id, starts_at, ends_at, status, payment_status")
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .single();

    if (existingError || !existingAppointment) {
      return { error: "Appointment not found." };
    }

    const timeChanged =
      String(existingAppointment.starts_at) !== startsAt ||
      String(existingAppointment.ends_at) !== endsAt;

    const status =
      existingAppointment.status === "attended" ||
      existingAppointment.status === "no_show" ||
      existingAppointment.status === "cancelled"
        ? existingAppointment.status
        : timeChanged
          ? "rescheduled"
          : existingAppointment.status === "rescheduled"
            ? "rescheduled"
            : "scheduled";

    const conflict = await validateAppointmentConflicts({
      studioId,
      startsAt,
      endsAt,
      instructorId: relations.instructor_id,
      roomId: relations.room_id,
      clientId,
      excludeAppointmentId: appointmentId,
      overrideRoomConflict,
    });

    if (conflict?.hasConflict) {
  return { error: getConflictErrorMessage(conflict) };
}

    const updatePayload = {
      client_id: clientId,
      partner_client_id:
        appointmentType === "private_lesson" ? partnerClientId : null,
      title,
      appointment_type: appointmentType,
      starts_at: startsAt,
      ends_at: endsAt,
      status,
      notes: notes || null,
      price_amount: isFloorSpaceRental(appointmentType) ? priceAmount : null,
      payment_status: isFloorSpaceRental(appointmentType)
        ? paymentStatus ?? (priceAmount && priceAmount > 0 ? "unpaid" : "waived")
        : null,
      updated_at: new Date().toISOString(),
      ...relations,
    };

    if (scope === "this_and_future" && existingAppointment.recurrence_series_id) {
      const { error: updateSeriesError } = await supabase
        .from("appointments")
        .update(updatePayload)
        .eq("studio_id", studioId)
        .eq("recurrence_series_id", existingAppointment.recurrence_series_id)
        .gte("starts_at", existingAppointment.starts_at);

      if (updateSeriesError) {
        return {
          error: `Could not update recurring appointments: ${updateSeriesError.message}`,
        };
      }

      const { data: updatedRows, error: updatedRowsError } = await supabase
        .from("appointments")
        .select("id, starts_at")
        .eq("studio_id", studioId)
        .eq("recurrence_series_id", existingAppointment.recurrence_series_id)
        .gte("starts_at", existingAppointment.starts_at);

      if (updatedRowsError) {
        return {
          error: `Appointments updated, but verification failed: ${updatedRowsError.message}`,
        };
      }

      for (const row of updatedRows ?? []) {
        await syncMembershipUsageForAppointment({
          supabase,
          studioId,
          appointmentId: row.id,
          clientId,
          appointmentType,
          status,
          startsAtIso: String(row.starts_at),
        });

        await promoteLeadClientAfterBookedAppointment({
          supabase,
          studioId,
          clientId,
          userId: user.id,
          appointmentType,
          startsAtIso: String(row.starts_at),
          appointmentId: row.id,
          status,
        });
      }
    } else {
      const { error: updateError } = await supabase
        .from("appointments")
        .update(updatePayload)
        .eq("id", appointmentId)
        .eq("studio_id", studioId);

      if (updateError) {
        return {
          error: `Could not update appointment: ${updateError.message}`,
        };
      }

      await syncMembershipUsageForAppointment({
        supabase,
        studioId,
        appointmentId,
        clientId,
        appointmentType,
        status,
        startsAtIso: startsAt,
      });

      await promoteLeadClientAfterBookedAppointment({
        supabase,
        studioId,
        clientId,
        userId: user.id,
        appointmentType,
        startsAtIso: startsAt,
        appointmentId,
        status,
      });

      if (timeChanged) {
        await queueAppointmentOutboundDelivery({
          supabase,
          studioId,
          appointmentId,
          reason: "rescheduled",
        });
      }
    }

    revalidatePath("/app/schedule");
    revalidatePath(`/app/schedule/${appointmentId}`);
    revalidatePath(`/app/clients/${clientId}`);
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  const appointmentId = getString(formData, "appointmentId");
  redirect(`/app/schedule/${appointmentId}`);
}

export async function cancelAppointmentAction(formData: FormData) {
  const fallback = "/app/schedule";

  try {
    const { supabase, studioId } = await requireAppointmentEditAccess();

    const appointmentId = getString(formData, "appointmentId");
    const scope = getString(formData, "cancelScope") || getString(formData, "scope") || "this_instance";

    if (!appointmentId) {
      redirect(getErrorRedirect(formData, fallback, "missing_appointment"));
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, client_id, recurrence_series_id, starts_at")
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .single();

    if (appointmentError || !appointment) {
      redirect(getErrorRedirect(formData, fallback, "appointment_not_found"));
    }

    if (scope === "this_and_future" && appointment.recurrence_series_id) {
      const { error: updateError } = await supabase
        .from("appointments")
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .eq("studio_id", studioId)
        .eq("recurrence_series_id", appointment.recurrence_series_id)
        .gte("starts_at", appointment.starts_at);

      if (updateError) {
        redirect(getErrorRedirect(formData, fallback, "cancel_failed"));
      }

      const { data: rowsToClear } = await supabase
        .from("appointments")
        .select("id")
        .eq("studio_id", studioId)
        .eq("recurrence_series_id", appointment.recurrence_series_id)
        .gte("starts_at", appointment.starts_at);

      for (const row of rowsToClear ?? []) {
        await clearMembershipUsageForAppointment({
          supabase,
          studioId,
          appointmentId: row.id,
        });
      }
    } else {
      const { error: updateError } = await supabase
        .from("appointments")
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .eq("id", appointmentId)
        .eq("studio_id", studioId);

      if (updateError) {
        redirect(getErrorRedirect(formData, fallback, "cancel_failed"));
      }

      await clearMembershipUsageForAppointment({
        supabase,
        studioId,
        appointmentId,
      });

      await queueAppointmentOutboundDelivery({
        supabase,
        studioId,
        appointmentId,
        reason: "cancelled",
      });
    }

    revalidatePath("/app/schedule");
    revalidatePath(`/app/schedule/${appointmentId}`);
    revalidatePath(`/app/clients/${appointment.client_id}`);
    redirect(getSuccessRedirect(formData, fallback, "appointment_cancelled"));
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    redirect(getErrorRedirect(formData, fallback, "cancel_failed"));
  }
}

export async function markAppointmentAttendedAction(formData: FormData) {
  const fallback = "/app/schedule";

  try {
    const { supabase, studioId } = await requireAttendanceAccess();

    const appointmentId = getString(formData, "appointmentId");
    if (!appointmentId) {
      redirect(getErrorRedirect(formData, fallback, "missing_appointment"));
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, client_id, appointment_type, starts_at")
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .single();

    if (appointmentError || !appointment) {
      redirect(getErrorRedirect(formData, fallback, "appointment_not_found"));
    }

    const { error: updateError } = await supabase
      .from("appointments")
      .update({
        status: "attended",
        updated_at: new Date().toISOString(),
      })
      .eq("id", appointmentId)
      .eq("studio_id", studioId);

    if (updateError) {
      redirect(getErrorRedirect(formData, fallback, "attendance_failed"));
    }

    await syncMembershipUsageForAppointment({
      supabase,
      studioId,
      appointmentId,
      clientId: appointment.client_id,
      appointmentType: appointment.appointment_type,
      status: "attended",
      startsAtIso: appointment.starts_at,
    });

    revalidatePath("/app/schedule");
    revalidatePath(`/app/schedule/${appointmentId}`);
    revalidatePath(`/app/clients/${appointment.client_id}`);
    redirect(getSuccessRedirect(formData, fallback, "appointment_attended"));
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    redirect(getErrorRedirect(formData, fallback, "attendance_failed"));
  }
}

export async function markAppointmentNoShowAction(formData: FormData) {
  const fallback = "/app/schedule";

  try {
    const { supabase, studioId } = await requireAttendanceAccess();

    const appointmentId = getString(formData, "appointmentId");
    if (!appointmentId) {
      redirect(getErrorRedirect(formData, fallback, "missing_appointment"));
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, client_id")
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .single();

    if (appointmentError || !appointment) {
      redirect(getErrorRedirect(formData, fallback, "appointment_not_found"));
    }

    const { error: updateError } = await supabase
      .from("appointments")
      .update({
        status: "no_show",
        updated_at: new Date().toISOString(),
      })
      .eq("id", appointmentId)
      .eq("studio_id", studioId);

    if (updateError) {
      redirect(getErrorRedirect(formData, fallback, "no_show_failed"));
    }

    await clearMembershipUsageForAppointment({
      supabase,
      studioId,
      appointmentId,
    });

    revalidatePath("/app/schedule");
    revalidatePath(`/app/schedule/${appointmentId}`);
    revalidatePath(`/app/clients/${appointment.client_id}`);
    redirect(getSuccessRedirect(formData, fallback, "appointment_no_show"));
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    redirect(getErrorRedirect(formData, fallback, "no_show_failed"));
  }
}

export async function recordFloorRentalPaymentAction(formData: FormData) {
  const fallback = "/app/schedule";

  try {
    const { supabase, studioId, user } = await requireAppointmentEditAccess();

    const appointmentId = getString(formData, "appointmentId");
    const clientId = getString(formData, "clientId");
    const amount = getNumberOrNull(getString(formData, "amount"));
    const paymentMethod = getString(formData, "paymentMethod") || "other";
    const notes = getString(formData, "notes");

    if (!appointmentId || !clientId) {
      redirect(getErrorRedirect(formData, fallback, "missing_payment_target"));
    }

    if (!amount || amount <= 0) {
      redirect(getErrorRedirect(formData, fallback, "invalid_payment_amount"));
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, appointment_type")
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .single();

    if (appointmentError || !appointment) {
      redirect(getErrorRedirect(formData, fallback, "appointment_not_found"));
    }

    if (appointment.appointment_type !== "floor_space_rental") {
      redirect(getErrorRedirect(formData, fallback, "not_floor_rental"));
    }

    const { error: insertError } = await supabase.from("payments").insert({
      studio_id: studioId,
      client_id: clientId,
      appointment_id: appointmentId,
      amount,
      payment_method: paymentMethod,
      status: "processed",
      notes: notes || null,
      paid_at: new Date().toISOString(),
      created_by: user.id,
      payment_type: "floor_space_rental",
      source: "appointment",
    });

    if (insertError) {
      redirect(getErrorRedirect(formData, fallback, "payment_record_failed"));
    }

    await recomputeFloorRentalPaymentStatus({
      supabase,
      studioId,
      appointmentId,
    });

    revalidatePath("/app/schedule");
    revalidatePath(`/app/schedule/${appointmentId}`);
    revalidatePath(`/app/clients/${clientId}`);
    redirect(getSuccessRedirect(formData, fallback, "payment_recorded"));
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    redirect(getErrorRedirect(formData, fallback, "payment_record_failed"));
  }
}

export async function markFloorRentalWaivedAction(formData: FormData) {
  const fallback = "/app/schedule";

  try {
    const { supabase, studioId } = await requireAppointmentEditAccess();

    const appointmentId = getString(formData, "appointmentId");
    if (!appointmentId) {
      redirect(getErrorRedirect(formData, fallback, "missing_appointment"));
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, appointment_type, client_id")
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .single();

    if (appointmentError || !appointment) {
      redirect(getErrorRedirect(formData, fallback, "appointment_not_found"));
    }

    if (appointment.appointment_type !== "floor_space_rental") {
      redirect(getErrorRedirect(formData, fallback, "not_floor_rental"));
    }

    const { error: updateError } = await supabase
      .from("appointments")
      .update({
        price_amount: 0,
        payment_status: "waived",
        updated_at: new Date().toISOString(),
      })
      .eq("id", appointmentId)
      .eq("studio_id", studioId);

    if (updateError) {
      redirect(getErrorRedirect(formData, fallback, "waive_failed"));
    }

    revalidatePath("/app/schedule");
    revalidatePath(`/app/schedule/${appointmentId}`);
    revalidatePath(`/app/clients/${appointment.client_id}`);
    redirect(getSuccessRedirect(formData, fallback, "rental_waived"));
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    redirect(getErrorRedirect(formData, fallback, "waive_failed"));
  }
}

export async function upsertLessonRecapAction(
  _: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const { supabase, studioId, user } = await requireAppointmentEditAccess();

    const appointmentId = getString(formData, "appointmentId");
    const summary = getString(formData, "summary");
    const homework = getString(formData, "homework");
    const nextFocus = getString(formData, "nextFocus");
    const visibleToClient = getBoolean(formData, "visibleToClient");

    if (!appointmentId) {
      return { error: "Missing appointment id." };
    }

    const validation = await validateLessonRecapAppointment({
      supabase,
      studioId,
      appointmentId,
    });

    if (!validation.ok || !validation.appointment) {
      return { error: validation.error ?? "Appointment not found." };
    }

    const recapId = await getOrCreateLessonRecap({
      supabase,
      studioId,
      appointmentId,
      clientId: validation.appointment.client_id,
      instructorId: validation.appointment.instructor_id,
      userId: user.id,
    });

    const { error: updateError } = await supabase
      .from("lesson_recaps")
      .update({
        summary: summary || null,
        homework: homework || null,
        next_focus: nextFocus || null,
        visible_to_client: visibleToClient,
        updated_at: new Date().toISOString(),
      })
      .eq("id", recapId)
      .eq("studio_id", studioId);

    if (updateError) {
      return { error: `Could not save lesson recap: ${updateError.message}` };
    }

    revalidatePath(`/app/schedule/${appointmentId}`);
    if (validation.appointment.client_id) {
      revalidatePath(`/app/clients/${validation.appointment.client_id}`);
    }

    return { error: "" };
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
}

export async function uploadLessonRecapVideoAction(formData: FormData) {
  const fallback = "/app/schedule";

  try {
    const { supabase, studioId, user } = await requireAppointmentEditAccess();

    const appointmentId = getString(formData, "appointmentId");
    const file = formData.get("video");

    if (!appointmentId) {
      redirect(getErrorRedirect(formData, fallback, "missing_appointment"));
    }

    if (!(file instanceof File) || file.size === 0) {
      redirect(getErrorRedirect(formData, fallback, "missing_video"));
    }

    const validation = await validateLessonRecapAppointment({
      supabase,
      studioId,
      appointmentId,
    });

    if (!validation.ok || !validation.appointment) {
      redirect(getErrorRedirect(formData, fallback, "appointment_not_found"));
    }

    const recapId = await getOrCreateLessonRecap({
      supabase,
      studioId,
      appointmentId,
      clientId: validation.appointment.client_id,
      instructorId: validation.appointment.instructor_id,
      userId: user.id,
    });

    const { data: existingRecap, error: existingError } = await supabase
      .from("lesson_recaps")
      .select("video_storage_path")
      .eq("id", recapId)
      .eq("studio_id", studioId)
      .single();

    if (existingError) {
      redirect(getErrorRedirect(formData, fallback, "lesson_recap_not_found"));
    }

    const extension = file.name.includes(".")
      ? file.name.split(".").pop()
      : "mp4";
    const storagePath = `${studioId}/${appointmentId}/${crypto.randomUUID()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from(LESSON_RECAP_VIDEO_BUCKET)
      .upload(storagePath, file, {
        contentType: file.type || "video/mp4",
        upsert: false,
      });

    if (uploadError) {
      redirect(getErrorRedirect(formData, fallback, "video_upload_failed"));
    }

    const { error: updateError } = await supabase
      .from("lesson_recaps")
      .update({
        video_storage_path: storagePath,
        video_original_name: file.name,
        video_mime_type: file.type || null,
        video_size_bytes: file.size,
        video_uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", recapId)
      .eq("studio_id", studioId);

    if (updateError) {
      await deleteLessonRecapVideoByPath({
        supabase,
        storagePath,
      });

      redirect(getErrorRedirect(formData, fallback, "video_save_failed"));
    }

    await deleteLessonRecapVideoByPath({
      supabase,
      storagePath: existingRecap.video_storage_path,
    });

    revalidatePath(`/app/schedule/${appointmentId}`);
    if (validation.appointment.client_id) {
      revalidatePath(`/app/clients/${validation.appointment.client_id}`);
    }

    redirect(getSuccessRedirect(formData, fallback, "video_uploaded"));
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    redirect(getErrorRedirect(formData, fallback, "video_upload_failed"));
  }
}

export async function deleteLessonRecapVideoAction(formData: FormData) {
  const fallback = "/app/schedule";

  try {
    const { supabase, studioId } = await requireAppointmentEditAccess();

    const appointmentId = getString(formData, "appointmentId");
    if (!appointmentId) {
      redirect(getErrorRedirect(formData, fallback, "missing_appointment"));
    }

    const validation = await validateLessonRecapAppointment({
      supabase,
      studioId,
      appointmentId,
    });

    if (!validation.ok || !validation.appointment) {
      redirect(getErrorRedirect(formData, fallback, "appointment_not_found"));
    }

    const { data: recap, error: recapError } = await supabase
      .from("lesson_recaps")
      .select("id, video_storage_path")
      .eq("studio_id", studioId)
      .eq("appointment_id", appointmentId)
      .maybeSingle();

    if (recapError || !recap) {
      redirect(getErrorRedirect(formData, fallback, "lesson_recap_not_found"));
    }

    await deleteLessonRecapVideoByPath({
      supabase,
      storagePath: recap.video_storage_path,
    });

    const { error: updateError } = await supabase
      .from("lesson_recaps")
      .update({
        video_storage_path: null,
        video_original_name: null,
        video_mime_type: null,
        video_size_bytes: null,
        video_uploaded_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", recap.id)
      .eq("studio_id", studioId);

    if (updateError) {
      redirect(getErrorRedirect(formData, fallback, "delete_video_failed"));
    }

    revalidatePath(`/app/schedule/${appointmentId}`);
    if (validation.appointment.client_id) {
      revalidatePath(`/app/clients/${validation.appointment.client_id}`);
    }

    redirect(getSuccessRedirect(formData, fallback, "video_deleted"));
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    redirect(getErrorRedirect(formData, fallback, "delete_video_failed"));
  }
}

export async function deleteLessonRecapAction(formData: FormData) {
  const fallback = "/app/schedule";

  try {
    const { supabase, studioId } = await requireAppointmentEditAccess();

    const appointmentId = getString(formData, "appointmentId");
    if (!appointmentId) {
      redirect(getErrorRedirect(formData, fallback, "missing_appointment"));
    }

    const validation = await validateLessonRecapAppointment({
      supabase,
      studioId,
      appointmentId,
    });

    if (!validation.ok || !validation.appointment) {
      redirect(getErrorRedirect(formData, fallback, "appointment_not_found"));
    }

    const { data: recap, error: recapError } = await supabase
      .from("lesson_recaps")
      .select("id, video_storage_path")
      .eq("studio_id", studioId)
      .eq("appointment_id", appointmentId)
      .maybeSingle();

    if (recapError) {
      redirect(getErrorRedirect(formData, fallback, "delete_recap_failed"));
    }

    if (recap?.video_storage_path) {
      await deleteLessonRecapVideoByPath({
        supabase,
        storagePath: recap.video_storage_path,
      });
    }

    const { error: deleteError } = await supabase
      .from("lesson_recaps")
      .delete()
      .eq("studio_id", studioId)
      .eq("appointment_id", appointmentId);

    if (deleteError) {
      redirect(getErrorRedirect(formData, fallback, "delete_recap_failed"));
    }

    revalidatePath(`/app/schedule/${appointmentId}`);
    if (validation.appointment.client_id) {
      revalidatePath(`/app/clients/${validation.appointment.client_id}`);
    }

    redirect(getSuccessRedirect(formData, fallback, "lesson_recap_deleted"));
  } catch (error) {
    rethrowIfRedirect(error);
    if (isRedirectError(error)) throw error;
    redirect(getErrorRedirect(formData, fallback, "delete_recap_failed"));
  }
}