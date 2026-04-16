"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type ActionState = {
  error: string;
  success: string;
};

type RentalSlot = {
  date: string;
  startTime: string;
  endTime: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function toIsoDateTime(date: string, time: string) {
  return `${date}T${time}:00`;
}

function parseSlotsJson(raw: string): RentalSlot[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => ({
        date: typeof item?.date === "string" ? item.date.trim() : "",
        startTime:
          typeof item?.startTime === "string" ? item.startTime.trim() : "",
        endTime:
          typeof item?.endTime === "string" ? item.endTime.trim() : "",
      }))
      .filter((item) => item.date && item.startTime && item.endTime);
  } catch {
    return [];
  }
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "floor_space_rental") return "Floor Space Rental";
  if (value === "event") return "Event";
  return value.replaceAll("_", " ");
}

async function requireIndependentInstructorPortalAccess(studioSlug: string) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug, name")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    throw new Error("Studio not found.");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select(
      "id, studio_id, first_name, last_name, is_independent_instructor, linked_instructor_id"
    )
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client) {
    throw new Error(
      "No instructor profile is linked to this account for this studio."
    );
  }

  if (!client.is_independent_instructor) {
    throw new Error(
      "This account is not enabled for floor space rental booking."
    );
  }

  return { supabase, user, studio, client };
}

async function getRoomOverlapWarning(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  roomId: string | null;
  startsAt: string;
  endsAt: string;
}) {
  const { supabase, studioId, roomId, startsAt, endsAt } = params;

  if (!roomId) {
    return { hasConflict: false as const };
  }

  const { data, error } = await supabase
    .from("appointments")
    .select(`
      id,
      title,
      appointment_type,
      starts_at,
      ends_at,
      clients ( first_name, last_name )
    `)
    .eq("studio_id", studioId)
    .eq("room_id", roomId)
    .neq("status", "cancelled")
    .lt("starts_at", endsAt)
    .gt("ends_at", startsAt)
    .limit(1);

  if (error) {
    throw new Error(`Failed to check room overlap: ${error.message}`);
  }

  const match = data?.[0];
  if (!match) {
    return { hasConflict: false as const };
  }

  const client = Array.isArray(match.clients) ? match.clients[0] : match.clients;
  const clientName = client
    ? `${client.first_name} ${client.last_name}`
    : "another client";

  const label = match.title || appointmentTypeLabel(match.appointment_type);

  return {
    hasConflict: true as const,
    message: `Selected room already has an overlapping ${label} for ${clientName}. Check override room conflict warning to continue.`,
  };
}

async function getClientOverlapWarning(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  clientId: string;
  startsAt: string;
  endsAt: string;
}) {
  const { supabase, studioId, clientId, startsAt, endsAt } = params;

  const { data, error } = await supabase
    .from("appointments")
    .select(`
      id,
      title,
      appointment_type,
      starts_at,
      ends_at
    `)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .neq("status", "cancelled")
    .lt("starts_at", endsAt)
    .gt("ends_at", startsAt)
    .limit(1);

  if (error) {
    throw new Error(`Failed to check booking overlap: ${error.message}`);
  }

  const match = data?.[0];
  if (!match) {
    return { hasConflict: false as const };
  }

  const label = match.title || appointmentTypeLabel(match.appointment_type);

  return {
    hasConflict: true as const,
    message: `You already have an overlapping booking during this time (${label}).`,
  };
}

export async function createFloorSpaceRentalAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const studioSlug = getString(formData, "studioSlug");
  const notes = getString(formData, "notes");
  const roomIdRaw = getString(formData, "roomId");
  const slotsJson = getString(formData, "slotsJson");
  const overrideRoomConflict = formData.get("overrideRoomConflict") === "on";
  const roomId = roomIdRaw || null;

  if (!studioSlug) {
    return { error: "Missing studio slug.", success: "" };
  }

  try {
    const { supabase, studio, client, user } =
      await requireIndependentInstructorPortalAccess(studioSlug);

    if (roomId) {
      const { data: room, error: roomError } = await supabase
        .from("rooms")
        .select("id, studio_id, active")
        .eq("id", roomId)
        .eq("studio_id", studio.id)
        .single();

      if (roomError || !room || room.active !== true) {
        return {
          error: "Selected room is invalid.",
          success: "",
        };
      }
    }

    const slots = parseSlotsJson(slotsJson);

    if (slots.length === 0) {
      return { error: "Add at least one time slot.", success: "" };
    }

    const now = new Date();
    const seen = new Set<string>();
    const rows = [];

    for (const slot of slots) {
      const startsAt = toIsoDateTime(slot.date, slot.startTime);
      const endsAt = toIsoDateTime(slot.date, slot.endTime);

      const startDate = new Date(startsAt);
      const endDate = new Date(endsAt);

      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return {
          error: `Invalid date or time for ${slot.date}.`,
          success: "",
        };
      }

      if (endDate <= startDate) {
        return {
          error: `End time must be later than start time for ${slot.date}.`,
          success: "",
        };
      }

      if (startDate < now) {
        return {
          error: `Past time slots are not allowed (${slot.date} ${slot.startTime}).`,
          success: "",
        };
      }

      const dedupeKey = `${slot.date}|${slot.startTime}|${slot.endTime}`;
      if (seen.has(dedupeKey)) {
        return {
          error: `Duplicate time slot detected for ${slot.date} ${slot.startTime}-${slot.endTime}.`,
          success: "",
        };
      }

      seen.add(dedupeKey);

      const clientOverlap = await getClientOverlapWarning({
        supabase,
        studioId: studio.id,
        clientId: client.id,
        startsAt,
        endsAt,
      });

      if (clientOverlap.hasConflict) {
        return {
          error: clientOverlap.message,
          success: "",
        };
      }

      const roomWarning = await getRoomOverlapWarning({
        supabase,
        studioId: studio.id,
        roomId,
        startsAt,
        endsAt,
      });

      if (roomWarning.hasConflict && !overrideRoomConflict) {
        return {
          error:
            roomWarning.message ??
            "Selected room has an overlapping booking. Check override room conflict warning to continue.",
          success: "",
        };
      }

      rows.push({
        studio_id: studio.id,
        client_id: client.id,
        instructor_id: client.linked_instructor_id ?? null,
        room_id: roomId,
        client_package_id: null,
        appointment_type: "floor_space_rental",
        title: "Floor Space Rental",
        notes: notes || null,
        starts_at: startsAt,
        ends_at: endsAt,
        status: "scheduled",
        is_recurring: false,
        created_by: user.id,
      });
    }

    const { error: insertError } = await supabase.from("appointments").insert(rows);

    if (insertError) {
      return {
        error: `Floor space rental booking failed: ${insertError.message}`,
        success: "",
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
      success: "",
    };
  }

  redirect(
    `/portal/${encodeURIComponent(studioSlug)}/floor-space?success=booked`
  );
}

export async function cancelFloorSpaceRentalAction(formData: FormData) {
  const studioSlug = getString(formData, "studioSlug");
  const appointmentId = getString(formData, "appointmentId");
  const returnTo =
    getString(formData, "returnTo") ||
    `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals`;

  if (!studioSlug) {
    redirect("/login");
  }

  if (!appointmentId) {
    redirect(appendQueryParam(returnTo, "error", "missing_appointment"));
  }

  try {
    const { supabase, studio, client } =
      await requireIndependentInstructorPortalAccess(studioSlug);

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, studio_id, client_id, appointment_type, status, starts_at")
      .eq("id", appointmentId)
      .eq("studio_id", studio.id)
      .single();

    if (appointmentError || !appointment) {
      redirect(appendQueryParam(returnTo, "error", "not_found"));
    }

    if (appointment.client_id !== client.id) {
      redirect(appendQueryParam(returnTo, "error", "unauthorized"));
    }

    if (appointment.appointment_type !== "floor_space_rental") {
      redirect(appendQueryParam(returnTo, "error", "invalid_type"));
    }

    if (appointment.status === "cancelled") {
      redirect(appendQueryParam(returnTo, "success", "already_cancelled"));
    }

    if (new Date(appointment.starts_at) < new Date()) {
      redirect(appendQueryParam(returnTo, "error", "past_rental"));
    }

    const { error: updateError } = await supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", appointment.id)
      .eq("studio_id", studio.id);

    if (updateError) {
      redirect(appendQueryParam(returnTo, "error", "cancel_failed"));
    }
  } catch {
    redirect(appendQueryParam(returnTo, "error", "cancel_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "cancelled"));
}