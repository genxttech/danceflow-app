import { createHash, randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const CONFIRMABLE_STATUSES = new Set(["scheduled", "rescheduled", "confirmed"]);

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function appointmentConfirmationSiteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://idanceflow.com"
  ).replace(/\/$/, "");
}

export async function createAppointmentConfirmationToken(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
  clientId: string;
  recipientEmail?: string | null;
  expiresAt?: string;
}) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt =
    params.expiresAt ??
    new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  const { error } = await params.supabase
    .from("appointment_confirmation_tokens")
    .insert({
      studio_id: params.studioId,
      appointment_id: params.appointmentId,
      client_id: params.clientId,
      token_hash: tokenHash(token),
      recipient_email: params.recipientEmail ?? null,
      expires_at: expiresAt,
    });

  if (error) {
    throw new Error(`Could not create confirmation link: ${error.message}`);
  }

  return {
    token,
    expiresAt,
    confirmUrl: `${appointmentConfirmationSiteUrl()}/appointments/confirm/${encodeURIComponent(token)}`,
  };
}

async function invalidateOtherTokens(
  supabase: SupabaseClient,
  appointmentId: string,
  exceptTokenId?: string,
) {
  let query = supabase
    .from("appointment_confirmation_tokens")
    .update({ invalidated_at: new Date().toISOString() })
    .eq("appointment_id", appointmentId)
    .is("invalidated_at", null)
    .is("confirmed_at", null);

  if (exceptTokenId) query = query.neq("id", exceptTokenId);

  const { error } = await query;
  if (error) {
    console.error("Could not invalidate older appointment confirmation links:", error.message);
  }
}

async function applyConfirmation(params: {
  supabase: SupabaseClient;
  appointment: {
    id: string;
    studio_id: string;
    client_id: string | null;
    starts_at: string;
    status: string | null;
  };
  source: "email_link" | "student_portal" | "student_mobile";
  actorUserId?: string | null;
}) {
  const currentStatus = params.appointment.status ?? "scheduled";

  if (!CONFIRMABLE_STATUSES.has(currentStatus)) {
    throw new Error("This appointment can no longer be confirmed.");
  }

  if (new Date(params.appointment.starts_at).getTime() <= Date.now()) {
    throw new Error("This appointment has already started.");
  }

  if (currentStatus === "confirmed") {
    return {
      appointmentId: params.appointment.id,
      status: "confirmed",
      alreadyConfirmed: true,
    };
  }

  const confirmedAt = new Date().toISOString();
  const { error } = await params.supabase
    .from("appointments")
    .update({
      status: "confirmed",
      confirmed_at: confirmedAt,
      confirmation_source: params.source,
      confirmation_actor_user_id: params.actorUserId ?? null,
      updated_at: confirmedAt,
    })
    .eq("id", params.appointment.id)
    .in("status", ["scheduled", "rescheduled"]);

  if (error) {
    throw new Error(`Could not confirm appointment: ${error.message}`);
  }

  return {
    appointmentId: params.appointment.id,
    status: "confirmed",
    confirmedAt,
    alreadyConfirmed: false,
  };
}

export async function confirmAppointmentByToken(params: {
  supabase: SupabaseClient;
  token: string;
}) {
  const now = new Date();
  const { data: tokenRow, error: tokenError } = await params.supabase
    .from("appointment_confirmation_tokens")
    .select("id, appointment_id, client_id, expires_at, confirmed_at, invalidated_at")
    .eq("token_hash", tokenHash(params.token))
    .maybeSingle();

  if (tokenError || !tokenRow) {
    throw new Error("This confirmation link is invalid.");
  }

  if (tokenRow.invalidated_at) {
    throw new Error("This confirmation link is no longer active.");
  }

  if (new Date(tokenRow.expires_at).getTime() < now.getTime()) {
    throw new Error("This confirmation link has expired.");
  }

  const { data: appointment, error: appointmentError } = await params.supabase
    .from("appointments")
    .select("id, studio_id, client_id, starts_at, status")
    .eq("id", tokenRow.appointment_id)
    .eq("client_id", tokenRow.client_id)
    .maybeSingle();

  if (appointmentError || !appointment) {
    throw new Error("This appointment could not be found.");
  }

  const result = await applyConfirmation({
    supabase: params.supabase,
    appointment,
    source: "email_link",
  });

  const confirmedAt =
    result.confirmedAt ?? tokenRow.confirmed_at ?? new Date().toISOString();

  await params.supabase
    .from("appointment_confirmation_tokens")
    .update({ confirmed_at: confirmedAt })
    .eq("id", tokenRow.id);

  await invalidateOtherTokens(params.supabase, appointment.id, tokenRow.id);

  return result;
}

export async function confirmOwnedAppointment(params: {
  supabase: SupabaseClient;
  userId: string;
  appointmentId: string;
  source: "student_portal" | "student_mobile";
}) {
  const { data: appointment, error: appointmentError } = await params.supabase
    .from("appointments")
    .select("id, studio_id, client_id, starts_at, status")
    .eq("id", params.appointmentId)
    .maybeSingle();

  if (appointmentError || !appointment?.client_id) {
    throw new Error("Appointment not found.");
  }

  const { data: relationship, error: relationshipError } = await params.supabase
    .from("client_account_links")
    .select("id")
    .eq("user_id", params.userId)
    .eq("studio_id", appointment.studio_id)
    .eq("client_id", appointment.client_id)
    .eq("status", "linked")
    .eq("can_view_schedule", true)
    .limit(1)
    .maybeSingle();

  if (relationshipError || !relationship) {
    throw new Error("Appointment not found.");
  }

  const result = await applyConfirmation({
    supabase: params.supabase,
    appointment,
    source: params.source,
    actorUserId: params.userId,
  });

  await invalidateOtherTokens(params.supabase, appointment.id);
  return result;
}
