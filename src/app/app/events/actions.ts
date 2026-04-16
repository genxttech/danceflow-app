"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  EVENT_VISIBILITY_OPTIONS,
  TIMEZONE_OPTIONS,
  US_STATE_OPTIONS,
  isAllowedOptionValue,
  normalizeOptionValue,
} from "@/lib/forms/options";

type ActionState = {
  error: string;
};

const EVENT_IMAGE_BUCKET = "event-media";

const STYLE_OPTIONS = [
  { key: "country", label: "Country" },
  { key: "ballroom", label: "Ballroom" },
  { key: "latin", label: "Latin" },
  { key: "salsa", label: "Salsa" },
  { key: "bachata", label: "Bachata" },
  { key: "swing", label: "Swing" },
  { key: "west_coast_swing", label: "West Coast Swing" },
  { key: "hip_hop", label: "Hip Hop" },
  { key: "contemporary", label: "Contemporary" },
  { key: "ballet", label: "Ballet" },
] as const;

const DB_EVENT_STATUSES = [
  "draft",
  "published",
  "cancelled",
  "completed",
] as const;

const DB_EVENT_TYPES = [
  "workshop",
  "social_dance",
  "showcase",
  "competition",
  "intensive",
  "bootcamp",
  "party",
  "festival",
  "retreat",
  "other",
] as const;

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getBoolean(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value === "string") {
    return value === "true" || value === "on";
  }
  return value === "on";
}

function getFile(formData: FormData, key: string) {
  const value = formData.get(key);
  return value instanceof File && value.size > 0 ? value : null;
}

function parseOptionalDateTimeLocal(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function parseOptionalInteger(value: string) {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeFileName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeDbEventStatus(value: string) {
  const normalized = value.trim().toLowerCase();

  if (normalized === "open") return "published";
  if ((DB_EVENT_STATUSES as readonly string[]).includes(normalized)) {
    return normalized;
  }

  return "draft";
}

function normalizeDbEventType(value: string) {
  const normalized = value.trim().toLowerCase();

  if (normalized === "group_class") return "workshop";
  if (normalized === "special_event") return "other";
  if (normalized === "event") return "other";

  if ((DB_EVENT_TYPES as readonly string[]).includes(normalized)) {
    return normalized;
  }

  return "other";
}

async function getStudioContext() {
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

  if (roleError || !roleRow?.studio_id) {
    return {
      supabase,
      studioId: "",
      userId: user.id,
      error: "No active studio role found for this user.",
    };
  }

  return {
    supabase,
    studioId: roleRow.studio_id as string,
    userId: user.id,
    error: null as string | null,
  };
}

function buildEventPayload(formData: FormData) {
  const rawName = getString(formData, "name");
  const rawSlug = getString(formData, "slug");

  const capacity = parseOptionalInteger(getString(formData, "capacity"));
  const waitlistEnabled =
    capacity != null && capacity > 0
      ? getBoolean(formData, "waitlistEnabled")
      : false;

  const publicDirectoryEnabled = getBoolean(formData, "publicDirectoryEnabled");
  const requestedVisibility = getString(formData, "visibility") || "public";
  const computedVisibility = publicDirectoryEnabled ? "public" : requestedVisibility;

  return {
    organizerId: getString(formData, "organizerId"),
    name: rawName,
    slug: rawSlug || slugify(rawName),
    eventType: getString(formData, "eventType") || "workshop",
    shortDescription: getString(formData, "shortDescription"),
    description: getString(formData, "description"),
    venueName: getString(formData, "venueName"),
    addressLine1: getString(formData, "addressLine1"),
    addressLine2: getString(formData, "addressLine2"),
    city: getString(formData, "city"),
    state: getString(formData, "state"),
    postalCode: getString(formData, "postalCode"),
    timezone: getString(formData, "timezone") || "America/New_York",
    startDate: getString(formData, "startDate"),
    endDate: getString(formData, "endDate"),
    startTime: getString(formData, "startTime") || null,
    endTime: getString(formData, "endTime") || null,
    coverImageUrl: getString(formData, "coverImageUrl"),
    coverImageFile: getFile(formData, "coverImageFile"),
    visibility: computedVisibility,
    featured: getBoolean(formData, "featured"),
    beginnerFriendly: getBoolean(formData, "beginnerFriendly"),
    publicDirectoryEnabled,
    status: getString(formData, "status") || "draft",
    registrationRequired: getBoolean(formData, "registrationRequired"),
    accountRequiredForRegistration: getBoolean(
      formData,
      "accountRequiredForRegistration"
    ),
    registrationOpensAt: parseOptionalDateTimeLocal(
      getString(formData, "registrationOpensAt")
    ),
    registrationClosesAt: parseOptionalDateTimeLocal(
      getString(formData, "registrationClosesAt")
    ),
    capacity,
    waitlistEnabled,
    refundPolicy: getString(formData, "refundPolicy"),
    faq: getString(formData, "faq"),
    tags: normalizeTags(getString(formData, "tags")),
    styleKeys: Array.from(
      new Set(
        formData
          .getAll("styleKeys")
          .map((value) => String(value).trim())
          .filter((value) =>
            STYLE_OPTIONS.some((option) => option.key === value)
          )
      )
    ),
  };
}

function validateEventEnums(payload: ReturnType<typeof buildEventPayload>) {
  if (!payload.visibility || !isAllowedOptionValue(EVENT_VISIBILITY_OPTIONS, payload.visibility)) {
    return "Invalid visibility.";
  }

  if (!payload.timezone || !isAllowedOptionValue(TIMEZONE_OPTIONS, payload.timezone)) {
    return "Invalid timezone.";
  }

  if (!payload.state || !isAllowedOptionValue(US_STATE_OPTIONS, payload.state)) {
    return "Invalid state.";
  }

  return null;
}

function validateEventPayload(payload: ReturnType<typeof buildEventPayload>) {
  if (!payload.organizerId) return "Organizer is required.";
  if (!payload.name) return "Event name is required.";
  if (!payload.slug) return "Event slug is required.";
  if (!payload.startDate) return "Start date is required.";
  if (!payload.endDate) return "End date is required.";

  const enumError = validateEventEnums(payload);
  if (enumError) return enumError;

  if (payload.endDate < payload.startDate) {
    return "End date cannot be before start date.";
  }

  if (payload.capacity != null && payload.capacity < 0) {
    return "Capacity cannot be negative.";
  }

  if (
    payload.registrationOpensAt &&
    payload.registrationClosesAt &&
    payload.registrationClosesAt < payload.registrationOpensAt
  ) {
    return "Registration close must be after registration open.";
  }

  if (payload.coverImageFile) {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
    if (!allowed.includes(payload.coverImageFile.type)) {
      return "Cover image must be a JPG, PNG, or WEBP file.";
    }

    const maxBytes = 10 * 1024 * 1024;
    if (payload.coverImageFile.size > maxBytes) {
      return "Cover image must be 10 MB or smaller.";
    }
  }

  return null;
}

async function ensureSlugAvailable(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  slug: string;
  excludeEventId?: string;
}) {
  const { supabase, studioId, slug, excludeEventId } = params;

  let query = supabase
    .from("events")
    .select("id")
    .eq("studio_id", studioId)
    .eq("slug", slug)
    .limit(1);

  if (excludeEventId) {
    query = query.neq("id", excludeEventId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return !data;
}

async function ensureOrganizerValid(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  organizerId: string;
}) {
  const { supabase, studioId, organizerId } = params;

  const { data: organizer, error: organizerError } = await supabase
    .from("organizers")
    .select("id, studio_id")
    .eq("id", organizerId)
    .eq("studio_id", studioId)
    .single();

  if (organizerError || !organizer) {
    return false;
  }

  return true;
}

async function replaceEventStyles(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  styleKeys: string[];
}) {
  const { supabase, eventId, styleKeys } = params;

  const { error: deleteError } = await supabase
    .from("event_public_styles")
    .delete()
    .eq("event_id", eventId);

  if (deleteError) {
    throw new Error(`Failed to clear event styles: ${deleteError.message}`);
  }

  if (styleKeys.length === 0) {
    return;
  }

  const rows = styleKeys.map((styleKey) => ({
    event_id: eventId,
    style_key: styleKey,
    display_name:
      STYLE_OPTIONS.find((option) => option.key === styleKey)?.label ?? styleKey,
  }));

  const { error: insertError } = await supabase
    .from("event_public_styles")
    .insert(rows);

  if (insertError) {
    throw new Error(`Failed to save event styles: ${insertError.message}`);
  }
}

async function uploadEventCoverImage(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  slug: string;
  file: File;
}) {
  const { supabase, studioId, slug, file } = params;

  const safeName = sanitizeFileName(file.name || "cover-image");
  const extension = safeName.includes(".")
    ? safeName.split(".").pop()
    : "jpg";

  const path = `${studioId}/${slug}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const arrayBuffer = await file.arrayBuffer();
  const fileBuffer = new Uint8Array(arrayBuffer);

  const { error: uploadError } = await supabase.storage
    .from(EVENT_IMAGE_BUCKET)
    .upload(path, fileBuffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Image upload failed: ${uploadError.message}`);
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(EVENT_IMAGE_BUCKET).getPublicUrl(path);

  return publicUrl;
}

async function resolveCoverImageUrl(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  slug: string;
  existingUrl?: string | null;
  payload: ReturnType<typeof buildEventPayload>;
}) {
  const { supabase, studioId, slug, existingUrl, payload } = params;

  if (payload.coverImageFile) {
    return await uploadEventCoverImage({
      supabase,
      studioId,
      slug,
      file: payload.coverImageFile,
    });
  }

  if (payload.coverImageUrl) {
    return payload.coverImageUrl;
  }

  return existingUrl ?? null;
}

function buildInsertUpdatePayload(params: {
  payload: ReturnType<typeof buildEventPayload>;
  studioId: string;
  resolvedCoverImageUrl: string | null;
}) {
  const { payload, studioId, resolvedCoverImageUrl } = params;

  return {
    organizer_id: payload.organizerId,
    studio_id: studioId,
    name: payload.name,
    slug: payload.slug,
    event_type: normalizeDbEventType(payload.eventType),
    short_description: payload.shortDescription || null,
    description: payload.description || null,
    public_summary: payload.shortDescription || null,
    public_description: payload.description || null,
    venue_name: payload.venueName || null,
    address_line_1: payload.addressLine1 || null,
    address_line_2: payload.addressLine2 || null,
    city: payload.city || null,
    state: normalizeOptionValue(US_STATE_OPTIONS, payload.state),
    postal_code: payload.postalCode || null,
    timezone:
      normalizeOptionValue(TIMEZONE_OPTIONS, payload.timezone) ?? "America/New_York",
    start_date: payload.startDate,
    end_date: payload.endDate,
    start_time: payload.startTime,
    end_time: payload.endTime,
    cover_image_url: resolvedCoverImageUrl,
    public_cover_image_url: resolvedCoverImageUrl,
    visibility:
      normalizeOptionValue(EVENT_VISIBILITY_OPTIONS, payload.visibility) ?? "public",
    featured: payload.featured,
    beginner_friendly: payload.beginnerFriendly,
    public_directory_enabled: payload.publicDirectoryEnabled,
    status: normalizeDbEventStatus(payload.status),
    registration_required: payload.registrationRequired,
    account_required_for_registration: payload.accountRequiredForRegistration,
    registration_opens_at: payload.registrationOpensAt,
    registration_closes_at: payload.registrationClosesAt,
    capacity: payload.capacity,
    waitlist_enabled: payload.waitlistEnabled,
    refund_policy: payload.refundPolicy || null,
    faq: payload.faq || null,
  };
}

export async function createEventAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const { supabase, studioId, userId, error: studioError } =
      await getStudioContext();

    if (studioError) {
      return { error: studioError };
    }

    const payload = buildEventPayload(formData);
    const validationError = validateEventPayload(payload);

    if (validationError) {
      return { error: validationError };
    }

    const organizerValid = await ensureOrganizerValid({
      supabase,
      studioId,
      organizerId: payload.organizerId,
    });

    if (!organizerValid) {
      return { error: "Selected organizer is invalid." };
    }

    const slugAvailable = await ensureSlugAvailable({
      supabase,
      studioId,
      slug: payload.slug,
    });

    if (!slugAvailable) {
      return { error: "That event slug is already in use." };
    }

    const resolvedCoverImageUrl = await resolveCoverImageUrl({
      supabase,
      studioId,
      slug: payload.slug,
      existingUrl: null,
      payload,
    });

    const insertPayload = {
      ...buildInsertUpdatePayload({
        payload,
        studioId,
        resolvedCoverImageUrl,
      }),
      created_by: userId,
    };

    const { data: event, error: eventError } = await supabase
      .from("events")
      .insert(insertPayload)
      .select("id")
      .single();

    if (eventError || !event) {
      return {
        error: `Could not create event: ${eventError?.message ?? "Unknown error."}`,
      };
    }

    if (payload.tags.length > 0) {
      const { error: tagsError } = await supabase.from("event_tags").insert(
        payload.tags.map((tag) => ({
          event_id: event.id,
          tag,
        }))
      );

      if (tagsError) {
        return {
          error: `Event created, but tags failed to save: ${tagsError.message}`,
        };
      }
    }

    await replaceEventStyles({
      supabase,
      eventId: event.id,
      styleKeys: payload.styleKeys,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/events");
}

export async function updateEventAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const id = getString(formData, "id");

  if (!id) {
    return { error: "Missing event id." };
  }

  try {
    const { supabase, studioId, error: studioError } = await getStudioContext();

    if (studioError) {
      return { error: studioError };
    }

    const payload = buildEventPayload(formData);
    const validationError = validateEventPayload(payload);

    if (validationError) {
      return { error: validationError };
    }

    const { data: existingEvent, error: existingEventError } = await supabase
      .from("events")
      .select("id, cover_image_url, public_cover_image_url")
      .eq("id", id)
      .eq("studio_id", studioId)
      .single();

    if (existingEventError || !existingEvent) {
      return { error: "Event not found." };
    }

    const organizerValid = await ensureOrganizerValid({
      supabase,
      studioId,
      organizerId: payload.organizerId,
    });

    if (!organizerValid) {
      return { error: "Selected organizer is invalid." };
    }

    const slugAvailable = await ensureSlugAvailable({
      supabase,
      studioId,
      slug: payload.slug,
      excludeEventId: id,
    });

    if (!slugAvailable) {
      return { error: "That event slug is already in use." };
    }

    const resolvedCoverImageUrl = await resolveCoverImageUrl({
      supabase,
      studioId,
      slug: payload.slug,
      existingUrl:
        existingEvent.public_cover_image_url ?? existingEvent.cover_image_url ?? null,
      payload,
    });

    const { error: updateError } = await supabase
      .from("events")
      .update({
        ...buildInsertUpdatePayload({
          payload,
          studioId,
          resolvedCoverImageUrl,
        }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("studio_id", studioId);

    if (updateError) {
      return {
        error: `Could not update event: ${updateError.message}`,
      };
    }

    const { error: deleteTagsError } = await supabase
      .from("event_tags")
      .delete()
      .eq("event_id", id);

    if (deleteTagsError) {
      return {
        error: `Event updated, but old tags could not be cleared: ${deleteTagsError.message}`,
      };
    }

    if (payload.tags.length > 0) {
      const { error: tagsError } = await supabase.from("event_tags").insert(
        payload.tags.map((tag) => ({
          event_id: id,
          tag,
        }))
      );

      if (tagsError) {
        return {
          error: `Event updated, but tags failed to save: ${tagsError.message}`,
        };
      }
    }

    await replaceEventStyles({
      supabase,
      eventId: id,
      styleKeys: payload.styleKeys,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect(`/app/events/${id}`);
}