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
        email: string | null;
        first_name: string | null;
        last_name: string | null;
      }
    | {
        id: string;
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

type GroupRecapSyllabusInput = {
  stepId: string;
  progressStatus: "introduced" | "practiced" | "needs_review" | "assigned" | "mastered";
  recapNote: string | null;
  practiceGuidance: string | null;
  studentVisible: boolean;
};

function parseGroupRecapSyllabusRows(formData: FormData): GroupRecapSyllabusInput[] {
  const raw = getString(formData, "syllabusStepRowsJson");
  if (!raw) return [];

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const statuses = new Set([
    "introduced",
    "practiced",
    "needs_review",
    "assigned",
    "mastered",
  ]);

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const unique = new Map<string, GroupRecapSyllabusInput>();

    for (const item of parsed) {
      const stepId = typeof item?.stepId === "string" ? item.stepId.trim() : "";
      const progressStatus =
        typeof item?.progressStatus === "string"
          ? item.progressStatus.trim()
          : "practiced";

      if (!uuidPattern.test(stepId) || !statuses.has(progressStatus)) continue;

      unique.set(stepId, {
        stepId,
        progressStatus: progressStatus as GroupRecapSyllabusInput["progressStatus"],
        recapNote:
          typeof item?.recapNote === "string" && item.recapNote.trim()
            ? item.recapNote.trim()
            : null,
        practiceGuidance:
          typeof item?.practiceGuidance === "string" &&
          item.practiceGuidance.trim()
            ? item.practiceGuidance.trim()
            : null,
        studentVisible: item?.studentVisible !== false,
      });
    }

    return Array.from(unique.values());
  } catch {
    return [];
  }
}

async function syncGroupRecapSyllabusRows(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  recapId: string;
  userId: string;
  rows: GroupRecapSyllabusInput[];
}) {
  const { supabase, studioId, recapId, userId, rows } = params;

  const { error: clearError } = await supabase
    .from("group_lesson_recap_syllabus_steps")
    .delete()
    .eq("studio_id", studioId)
    .eq("group_lesson_recap_id", recapId);

  if (clearError) throw clearError;
  if (rows.length === 0) return;

  const { data: validSteps, error: lookupError } = await supabase
    .from("syllabus_steps")
    .select("id")
    .eq("studio_id", studioId)
    .eq("status", "active")
    .in("id", rows.map((row) => row.stepId));

  if (lookupError) throw lookupError;

  const validIds = new Set((validSteps ?? []).map((step) => step.id));
  const insertRows = rows
    .filter((row) => validIds.has(row.stepId))
    .map((row) => ({
      studio_id: studioId,
      group_lesson_recap_id: recapId,
      syllabus_step_id: row.stepId,
      progress_status: row.progressStatus,
      recap_note: row.recapNote,
      practice_guidance: row.practiceGuidance,
      student_visible: row.studentVisible,
      created_by: userId,
    }));

  if (insertRows.length === 0) return;

  const { error: insertError } = await supabase
    .from("group_lesson_recap_syllabus_steps")
    .insert(insertRows);

  if (insertError) throw insertError;
}

async function assignGroupRecapStepsToClients(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  recapId: string;
  clientIds: string[];
  userId: string;
}) {
  const { supabase, studioId, recapId, clientIds, userId } = params;
  if (clientIds.length === 0) return;

  const { data: stepRows, error: stepError } = await supabase
    .from("group_lesson_recap_syllabus_steps")
    .select("syllabus_step_id, progress_status, practice_guidance, student_visible")
    .eq("studio_id", studioId)
    .eq("group_lesson_recap_id", recapId)
    .eq("student_visible", true);

  if (stepError) throw stepError;
  if (!stepRows?.length) return;

  const now = new Date().toISOString();
  const assignmentRows = clientIds.flatMap((clientId) =>
    stepRows.map((step) => ({
      studio_id: studioId,
      client_id: clientId,
      syllabus_step_id: step.syllabus_step_id,
      assigned_by: userId,
      assigned_at: now,
      priority:
        step.progress_status === "needs_review" ||
        step.progress_status === "assigned"
          ? "high"
          : "normal",
      status:
        step.progress_status === "mastered"
          ? "mastered"
          : step.progress_status === "introduced"
            ? "introduced"
            : "practicing",
      practice_note: step.practice_guidance ?? null,
      student_visible: true,
      completed_at:
        step.progress_status === "mastered" ? now : null,
      archived_at: null,
      updated_at: now,
    })),
  );

  const { error: assignmentError } = await supabase
    .from("client_syllabus_step_assignments")
    .upsert(assignmentRows, {
      onConflict: "client_id,syllabus_step_id",
    });

  if (assignmentError) throw assignmentError;
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

    const syllabusRows = parseGroupRecapSyllabusRows(formData);

    const { data: recap, error } = await supabase
      .from("group_lesson_recaps")
      .upsert(
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
        { onConflict: "appointment_id" },
      )
      .select("id")
      .single();

    if (error || !recap) throw error ?? new Error("Recap could not be saved.");

    await syncGroupRecapSyllabusRows({
      supabase,
      studioId,
      recapId: recap.id,
      userId: user.id,
      rows: syllabusRows,
    });
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
          email,
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .eq("appointment_id", appointmentId)
      .in("status", ["checked_in", "attended"]);

    if (rowsError) throw rowsError;

    const linkedClientIds = Array.from(
      new Set(
        ((rows ?? []) as AttendanceRecipientRow[])
          .map((row) => row.client_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const { data: accountLinks } = linkedClientIds.length
      ? await supabase
          .from("client_account_links")
          .select("client_id, user_id")
          .eq("studio_id", studioId)
          .in("client_id", linkedClientIds)
          .eq("status", "linked")
          .eq("can_view_schedule", true)
      : { data: [] };

    const linkedUserByClientId = new Map<string, string>();
    for (const link of (accountLinks ?? []) as Array<{ client_id: string; user_id: string | null }>) {
      if (link.user_id && !linkedUserByClientId.has(link.client_id)) {
        linkedUserByClientId.set(link.client_id, link.user_id);
      }
    }

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
          user_id: linkedUserByClientId.get(row.client_id) ?? null,
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

    await assignGroupRecapStepsToClients({
      supabase,
      studioId,
      recapId: recap.id,
      clientIds: linkedClientIds,
      userId: user.id,
    });

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
