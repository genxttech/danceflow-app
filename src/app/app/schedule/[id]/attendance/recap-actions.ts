"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";
import { createClient } from "@/lib/supabase/server";

type AppointmentRow = {
  id: string;
  studio_id: string;
  appointment_type: string | null;
  title: string | null;
};

type AttendanceRecipientRow = {
  client_id: string | null;
  status: string | null;
  clients:
    | {
        id: string;
        portal_user_id: string | null;
        email: string | null;
        first_name: string | null;
        last_name: string | null;
      }
    | {
        id: string;
        portal_user_id: string | null;
        email: string | null;
        first_name: string | null;
        last_name: string | null;
      }[]
    | null;
};

type GroupLessonRecapRecipient = {
  recap_id: string;
  studio_id: string;
  appointment_id: string;
  client_id: string;
  user_id: string | null;
  guest_email: null;
  guest_name: string | null;
  source: string;
  delivery_status: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getOptionalString(formData: FormData, key: string) {
  const value = getString(formData, key);
  return value.length ? value : null;
}

function getMediaLinks(value: string | null) {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isGroupLessonRecapRecipient(
  recipient: GroupLessonRecapRecipient | null
): recipient is GroupLessonRecapRecipient {
  return recipient !== null;
}

async function sendLearningRecapPushes(params: {
  recapTitle: string;
  recipients: GroupLessonRecapRecipient[];
}) {
  const userIds = Array.from(
    new Set(params.recipients.map((recipient) => recipient.user_id).filter((id): id is string => Boolean(id)))
  );

  await Promise.all(
    userIds.map((userId) =>
      sendMobilePushToUser({
        userId,
        category: "learning",
        title: "New group recap",
        body: `${params.recapTitle} is ready to review.`,
        data: {
          source: "group_lesson_recap_published",
        },
      }).catch((error) => {
        console.error("Failed to send group recap mobile push", error);
      })
    )
  );
}

async function requireStudioAccess(appointmentId: string) {
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

  const studioId = roleRow.studio_id as string;

  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .select("id, studio_id, appointment_type, title")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .single<AppointmentRow>();

  if (appointmentError || !appointment) {
    throw new Error(appointmentError?.message ?? "Appointment not found.");
  }

  if (appointment.appointment_type !== "group_class") {
    throw new Error("Group lesson recaps can only be created for group classes.");
  }

  return { supabase, user, studioId, appointment };
}

export async function saveGroupLessonRecapAction(formData: FormData) {
  const appointmentId = getString(formData, "appointmentId");
  const title = getString(formData, "title");
  const returnTo = getString(formData, "returnTo") || `/app/schedule/${appointmentId}/attendance`;

  if (!appointmentId || !title) {
    redirect(`${returnTo}?error=recap_save_failed`);
  }

  try {
    const { supabase, user, studioId } = await requireStudioAccess(appointmentId);

    const { error } = await supabase.from("group_lesson_recaps").upsert(
      {
        studio_id: studioId,
        appointment_id: appointmentId,
        title,
        summary: getOptionalString(formData, "summary"),
        technique_notes: getOptionalString(formData, "techniqueNotes"),
        safety_notes: getOptionalString(formData, "safetyNotes"),
        practice_assignment: getOptionalString(formData, "practiceAssignment"),
        media_links: getMediaLinks(getOptionalString(formData, "mediaLinks")),
        status: "draft",
        created_by: user.id,
        updated_by: user.id,
        published_by: null,
        published_at: null,
      },
      { onConflict: "appointment_id" }
    );

    if (error) throw error;
  } catch (error) {
    console.error("Save group lesson recap failed", error);
    redirect(`${returnTo}?error=recap_save_failed`);
  }

  revalidatePath(returnTo);
  redirect(`${returnTo}?success=recap_saved`);
}

export async function publishGroupLessonRecapAction(formData: FormData) {
  const appointmentId = getString(formData, "appointmentId");
  const returnTo = getString(formData, "returnTo") || `/app/schedule/${appointmentId}/attendance`;

  if (!appointmentId) {
    redirect(`${returnTo}?error=recap_publish_failed`);
  }

  try {
    const { supabase, user, studioId, appointment } = await requireStudioAccess(appointmentId);

    const { data: recap, error: recapError } = await supabase
      .from("group_lesson_recaps")
      .select("id")
      .eq("studio_id", studioId)
      .eq("appointment_id", appointmentId)
      .maybeSingle<{ id: string }>();

    if (recapError || !recap) {
      throw new Error(recapError?.message ?? "Save a draft before publishing.");
    }

    const { data: rows, error: rowsError } = await supabase
      .from("attendance_records")
      .select(`
        client_id,
        status,
        clients (
          id,
          portal_user_id,
          email,
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .eq("appointment_id", appointmentId)
      .in("status", ["checked_in", "attended"]);

    if (rowsError) throw rowsError;

    const recipients = ((rows ?? []) as AttendanceRecipientRow[])
      .map((row) => {
        const client = firstJoin(row.clients);
        if (!row.client_id || !client) return null;

        const guestName = [client.first_name, client.last_name].filter(Boolean).join(" ").trim();

        return {
          recap_id: recap.id,
          studio_id: studioId,
          appointment_id: appointmentId,
          client_id: row.client_id,
          user_id: client.portal_user_id,
          guest_email: null,
          guest_name: guestName || null,
          source: row.status === "attended" ? "attended" : "checked_in",
          delivery_status: "available",
        };
      })
      .filter(isGroupLessonRecapRecipient);

    if (recipients.length > 0) {
      const { error: recipientError } = await supabase
        .from("group_lesson_recap_recipients")
        .upsert(recipients, { onConflict: "recap_id,client_id" });

      if (recipientError) throw recipientError;
    }

    const { error: publishError } = await supabase
      .from("group_lesson_recaps")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        published_by: user.id,
        updated_by: user.id,
      })
      .eq("id", recap.id)
      .eq("studio_id", studioId);

    if (publishError) throw publishError;

    await sendLearningRecapPushes({
      recapTitle: appointment.title || "Group lesson recap",
      recipients,
    });
  } catch (error) {
    console.error("Publish group lesson recap failed", error);
    redirect(`${returnTo}?error=recap_publish_failed`);
  }

  revalidatePath(returnTo);
  redirect(`${returnTo}?success=recap_published`);
}

export async function unpublishGroupLessonRecapAction(formData: FormData) {
  const appointmentId = getString(formData, "appointmentId");
  const returnTo = getString(formData, "returnTo") || `/app/schedule/${appointmentId}/attendance`;

  if (!appointmentId) {
    redirect(`${returnTo}?error=recap_unpublish_failed`);
  }

  try {
    const { supabase, user, studioId } = await requireStudioAccess(appointmentId);

    const { error } = await supabase
      .from("group_lesson_recaps")
      .update({
        status: "unpublished",
        updated_by: user.id,
      })
      .eq("studio_id", studioId)
      .eq("appointment_id", appointmentId);

    if (error) throw error;
  } catch (error) {
    console.error("Unpublish group lesson recap failed", error);
    redirect(`${returnTo}?error=recap_unpublish_failed`);
  }

  revalidatePath(returnTo);
  redirect(`${returnTo}?success=recap_unpublished`);
}
