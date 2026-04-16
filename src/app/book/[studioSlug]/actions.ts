"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";

type StudioRow = {
  id: string;
  name: string;
  slug: string;
};

type StudioSettingsRow = {
  booking_lead_time_hours: number | null;
  public_intro_booking_enabled: boolean | null;
  intro_lesson_duration_minutes: number | null;
  intro_booking_window_days: number | null;
  intro_default_instructor_id: string | null;
  intro_default_room_id: string | null;
};

type AppointmentRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
};

type SlotRow = {
  start: string;
  end: string;
};

const INTRO_SLOT_TEMPLATES: Record<number, string[]> = {
  0: [],
  1: ["13:00", "15:00", "18:00"],
  2: ["13:00", "15:00", "18:00"],
  3: ["13:00", "15:00", "18:00"],
  4: ["13:00", "15:00", "18:00"],
  5: ["13:00", "15:00", "18:00"],
  6: ["11:00", "13:00"],
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function toLocalDateParts(date: Date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
  };
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function buildLocalDateTime(date: Date, time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const { year, month, day } = toLocalDateParts(date);
  return new Date(year, month, day, hours, minutes, 0, 0);
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart;
}

async function getStudioAndSettings(studioSlug: string) {
  const supabase = createAdminClient();

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    throw new Error("Studio not found.");
  }

  const { data: settings, error: settingsError } = await supabase
    .from("studio_settings")
    .select(`
      booking_lead_time_hours,
      public_intro_booking_enabled,
      intro_lesson_duration_minutes,
      intro_booking_window_days,
      intro_default_instructor_id,
      intro_default_room_id
    `)
    .eq("studio_id", studio.id)
    .single();

  if (settingsError || !settings) {
    throw new Error("Studio settings not found.");
  }

  return {
    supabase,
    studio: studio as StudioRow,
    settings: settings as StudioSettingsRow,
  };
}

async function getAvailableSlots(studioSlug: string): Promise<SlotRow[]> {
  const { supabase, studio, settings } = await getStudioAndSettings(studioSlug);

  if (!settings.public_intro_booking_enabled) {
    return [];
  }

  const bookingWindowDays = settings.intro_booking_window_days ?? 7;
  const lessonDurationMinutes = settings.intro_lesson_duration_minutes ?? 30;
  const bookingLeadTimeHours = settings.booking_lead_time_hours ?? 0;

  const today = startOfTodayLocal();
  const rangeStart = today.toISOString();
  const rangeEnd = addDays(today, bookingWindowDays + 1).toISOString();

  let appointmentsQuery = supabase
    .from("appointments")
    .select("id, starts_at, ends_at, status")
    .eq("studio_id", studio.id)
    .gte("starts_at", rangeStart)
    .lt("starts_at", rangeEnd)
    .neq("status", "cancelled");

  if (settings.intro_default_instructor_id) {
    appointmentsQuery = appointmentsQuery.eq(
      "instructor_id",
      settings.intro_default_instructor_id
    );
  }

  if (settings.intro_default_room_id) {
    appointmentsQuery = appointmentsQuery.eq("room_id", settings.intro_default_room_id);
  }

  const { data: appointments, error: appointmentsError } = await appointmentsQuery;

  if (appointmentsError) {
    throw new Error(`Failed to load public intro availability: ${appointmentsError.message}`);
  }

  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const leadTimeCutoff = new Date(Date.now() + bookingLeadTimeHours * 60 * 60 * 1000);

  const generatedSlots: SlotRow[] = [];

  for (let dayOffset = 0; dayOffset < bookingWindowDays; dayOffset++) {
    const dayDate = addDays(today, dayOffset);
    const dayOfWeek = dayDate.getDay();
    const times = INTRO_SLOT_TEMPLATES[dayOfWeek] ?? [];

    for (const time of times) {
      const start = buildLocalDateTime(dayDate, time);
      const end = addMinutes(start, lessonDurationMinutes);

      if (start < leadTimeCutoff) {
        continue;
      }

      const hasConflict = typedAppointments.some((appointment) => {
        const apptStart = new Date(appointment.starts_at);
        const apptEnd = new Date(appointment.ends_at);

        return overlaps(start, end, apptStart, apptEnd);
      });

      if (!hasConflict) {
        generatedSlots.push({
          start: start.toISOString(),
          end: end.toISOString(),
        });
      }
    }
  }

  return generatedSlots;
}

async function findStudioOwnerOrAdminUserId(studioId: string) {
  const supabase = createAdminClient();

  const { data } = await supabase
    .from("user_studio_roles")
    .select("user_id")
    .eq("studio_id", studioId)
    .eq("active", true)
    .in("role", ["studio_owner", "studio_admin", "platform_admin"])
    .limit(1)
    .maybeSingle();

  return data?.user_id ?? null;
}

export async function createPublicIntroBookingAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const studioSlug = getString(formData, "studioSlug");
    const slotStart = getString(formData, "slotStart");
    const firstName = getString(formData, "firstName");
    const lastName = getString(formData, "lastName");
    const email = getString(formData, "email").toLowerCase();
    const phone = getString(formData, "phone");
    const danceInterests = getString(formData, "danceInterests");
    const notes = getString(formData, "notes");

    if (!studioSlug) {
      return { error: "Missing studio slug." };
    }

    if (!slotStart) {
      return { error: "Please choose an intro lesson time." };
    }

    if (!firstName || !lastName || !email) {
      return { error: "First name, last name, and email are required." };
    }

    const { supabase, studio, settings } = await getStudioAndSettings(studioSlug);

    if (!settings.public_intro_booking_enabled) {
      return { error: "Intro lesson booking is not enabled for this studio." };
    }

    const availableSlots = await getAvailableSlots(studioSlug);
    const chosenSlot = availableSlots.find((slot) => slot.start === slotStart);

    if (!chosenSlot) {
      return {
        error: "That intro lesson slot is no longer available. Please choose another time.",
      };
    }

    let clientId: string | null = null;

    const { data: existingClientByEmail } = await supabase
      .from("clients")
      .select("id")
      .eq("studio_id", studio.id)
      .eq("email", email)
      .limit(1)
      .maybeSingle();

    if (existingClientByEmail?.id) {
      clientId = existingClientByEmail.id;
    } else {
      const { data: insertedClient, error: clientInsertError } = await supabase
        .from("clients")
        .insert({
          studio_id: studio.id,
          first_name: firstName,
          last_name: lastName,
          email,
          phone: phone || null,
          status: "lead",
          dance_interests: danceInterests || null,
          notes: notes || null,
          referral_source: "public_intro_booking",
        })
        .select("id")
        .single();

      if (clientInsertError || !insertedClient) {
        return {
          error: `Could not create lead: ${
            clientInsertError?.message ?? "Unknown error."
          }`,
        };
      }

      clientId = insertedClient.id;
    }

    const { data: duplicateAppointment } = await supabase
      .from("appointments")
      .select("id")
      .eq("studio_id", studio.id)
      .eq("client_id", clientId)
      .eq("appointment_type", "intro_lesson")
      .eq("starts_at", chosenSlot.start)
      .neq("status", "cancelled")
      .limit(1)
      .maybeSingle();

    if (duplicateAppointment?.id) {
      redirect(`/book/${studioSlug}?success=intro_booked`);
    }

    const appointmentNotes = [
      "Booked from public intro lesson page.",
      danceInterests ? `Dance interests: ${danceInterests}` : null,
      notes ? `Notes: ${notes}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const { data: insertedAppointment, error: appointmentError } = await supabase
      .from("appointments")
      .insert({
        studio_id: studio.id,
        client_id: clientId,
        instructor_id: settings.intro_default_instructor_id || null,
        room_id: settings.intro_default_room_id || null,
        appointment_type: "intro_lesson",
        title: "Intro Lesson",
        notes: appointmentNotes || null,
        starts_at: chosenSlot.start,
        ends_at: chosenSlot.end,
        status: "scheduled",
        is_recurring: false,
      })
      .select("id")
      .single();

    if (appointmentError || !insertedAppointment) {
      return {
        error: `Could not create intro lesson appointment: ${
          appointmentError?.message ?? "Unknown error."
        }`,
      };
    }

    const activityOwnerUserId = await findStudioOwnerOrAdminUserId(studio.id);

    const leadActivityNote = [
      "Public intro lesson booked.",
      `Slot: ${new Date(chosenSlot.start).toLocaleString()}`,
      danceInterests ? `Dance interests: ${danceInterests}` : null,
      notes ? `Notes: ${notes}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const { error: leadActivityError } = await supabase.from("lead_activities").insert({
      studio_id: studio.id,
      client_id: clientId,
      activity_type: "follow_up",
      note: leadActivityNote,
      follow_up_due_at: chosenSlot.start,
      created_by: activityOwnerUserId,
    });

    if (leadActivityError) {
      return {
        error: `Appointment was created, but lead activity logging failed: ${leadActivityError.message}`,
      };
    }

    const notificationBodyParts = [
      `${firstName} ${lastName} booked an intro lesson.`,
      `Scheduled for ${new Date(chosenSlot.start).toLocaleString()}.`,
      danceInterests ? `Interests: ${danceInterests}.` : null,
    ].filter(Boolean);

    const { error: notificationError } = await supabase.from("notifications").insert({
      studio_id: studio.id,
      type: "public_intro_booking",
      title: "New public intro booking",
      body: notificationBodyParts.join(" "),
      client_id: clientId,
      appointment_id: insertedAppointment.id,
    });

    if (notificationError) {
      return {
        error: `Booking was created, but notification logging failed: ${notificationError.message}`,
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect(`/book/${getString(formData, "studioSlug")}?success=intro_booked`);
}