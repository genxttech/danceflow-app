import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";

type SchedulePushReason = "confirmed" | "rescheduled" | "cancelled";

type AppointmentPushRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  partner_client_id: string | null;
  title: string | null;
  appointment_type: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status: string | null;
  clients:
    | {
        first_name: string | null;
        last_name: string | null;
        portal_user_id: string | null;
      }
    | {
        first_name: string | null;
        last_name: string | null;
        portal_user_id: string | null;
      }[]
    | null;
  partner_client:
    | {
        first_name: string | null;
        last_name: string | null;
        portal_user_id: string | null;
      }
    | {
        first_name: string | null;
        last_name: string | null;
        portal_user_id: string | null;
      }[]
    | null;
  studios:
    | {
        name: string | null;
        public_name: string | null;
      }
    | {
        name: string | null;
        public_name: string | null;
      }[]
    | null;
};

const DEFAULT_TIME_ZONE = "America/New_York";

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function appointmentTypeLabel(value: string | null | undefined) {
  if (value === "private_lesson") return "Private lesson";
  if (value === "group_class") return "Group class";
  if (value === "intro_lesson") return "Intro lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice party";
  if (value === "event") return "Event";
  if (value === "floor_space_rental") return "Floor space rental";

  return "Lesson";
}

function isPushEligibleAppointmentType(value: string | null | undefined) {
  return (
    value === "private_lesson" ||
    value === "group_class" ||
    value === "intro_lesson" ||
    value === "coaching" ||
    value === "practice_party" ||
    value === "event" ||
    value === "floor_space_rental"
  );
}

function formatAppointmentTime(value: string | null | undefined, timeZone: string) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function studioDisplayName(row: AppointmentPushRow) {
  const studio = firstJoin(row.studios);
  return studio?.public_name || studio?.name || "your studio";
}

function appointmentLabel(row: AppointmentPushRow) {
  const title = typeof row.title === "string" ? row.title.trim() : "";
  return title || appointmentTypeLabel(row.appointment_type);
}

function buildSchedulePushMessage(params: {
  row: AppointmentPushRow;
  reason: SchedulePushReason;
  timeZone: string;
}) {
  const { row, reason, timeZone } = params;
  const label = appointmentLabel(row);
  const studioName = studioDisplayName(row);
  const startsAt = formatAppointmentTime(row.starts_at, timeZone);

  if (reason === "cancelled") {
    return {
      title: "Lesson cancelled",
      body: startsAt
        ? `${label} at ${studioName} on ${startsAt} was cancelled.`
        : `${label} at ${studioName} was cancelled.`,
    };
  }

  if (reason === "rescheduled") {
    return {
      title: "Lesson updated",
      body: startsAt
        ? `${label} at ${studioName} was moved to ${startsAt}.`
        : `${label} at ${studioName} was updated.`,
    };
  }

  return {
    title: "New lesson scheduled",
    body: startsAt
      ? `${label} at ${studioName} is scheduled for ${startsAt}.`
      : `${label} at ${studioName} was scheduled.`,
  };
}

async function getStudioTimeZone(
  supabase: SupabaseClient,
  studioId: string,
) {
  const { data, error } = await supabase
    .from("studio_settings")
    .select("timezone")
    .eq("studio_id", studioId)
    .maybeSingle<{ timezone: string | null }>();

  if (error) {
    console.error("Could not load studio timezone for schedule push:", error.message);
  }

  return data?.timezone || DEFAULT_TIME_ZONE;
}

async function sendToPortalUser(params: {
  userId: string | null | undefined;
  title: string;
  body: string;
  appointmentId: string;
  studioId: string;
  reason: SchedulePushReason;
  recipientRole: "primary" | "partner";
}) {
  const userId = params.userId?.trim();
  if (!userId) return;

  try {
    await sendMobilePushToUser({
      userId,
      category: "schedule",
      title: params.title,
      body: params.body,
      data: {
        screen: "appointment",
        appointmentId: params.appointmentId,
        studioId: params.studioId,
        reason: params.reason,
        recipientRole: params.recipientRole,
      },
    });
  } catch (error) {
    console.error("Could not send schedule push notification:", error);
  }
}

export async function sendAppointmentSchedulePush(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
  reason: SchedulePushReason;
}) {
  const { supabase, studioId, appointmentId, reason } = params;

  const { data, error } = await supabase
    .from("appointments")
    .select(
      `
      id,
      studio_id,
      client_id,
      partner_client_id,
      title,
      appointment_type,
      starts_at,
      ends_at,
      status,
      clients (
        first_name,
        last_name,
        portal_user_id
      ),
      partner_client:clients!appointments_partner_client_id_fkey (
        first_name,
        last_name,
        portal_user_id
      ),
      studios (
        name,
        public_name
      )
    `,
    )
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (error || !data) {
    console.error("Could not load appointment for schedule push:", error?.message);
    return;
  }

  const row = data as unknown as AppointmentPushRow;

  if (!isPushEligibleAppointmentType(row.appointment_type)) return;

  const startsAt = row.starts_at ? new Date(row.starts_at) : null;
  if (startsAt && !Number.isNaN(startsAt.getTime()) && startsAt.getTime() < Date.now()) {
    return;
  }

  const timeZone = await getStudioTimeZone(supabase, studioId);
  const message = buildSchedulePushMessage({ row, reason, timeZone });

  const primaryClient = firstJoin(row.clients);
  const partnerClient = firstJoin(row.partner_client);

  await sendToPortalUser({
    userId: primaryClient?.portal_user_id,
    title: message.title,
    body: message.body,
    appointmentId: row.id,
    studioId,
    reason,
    recipientRole: "primary",
  });

  if (row.appointment_type === "private_lesson" && row.partner_client_id) {
    await sendToPortalUser({
      userId: partnerClient?.portal_user_id,
      title: message.title,
      body: message.body,
      appointmentId: row.id,
      studioId,
      reason,
      recipientRole: "partner",
    });
  }
}
