"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  EVENT_VISIBILITY_OPTIONS,
  TIMEZONE_OPTIONS,
  US_STATE_OPTIONS,
  isAllowedOptionValue,
  normalizeOptionValue,
} from "@/lib/forms/options";

type ActionState = {
  error?: string;
  success?: string;
};

type WorkspaceRow = {
  id: string;
  name: string | null;
  billing_plan: string | null;
  subscription_status: string | null;
};

type SubscriptionRow = {
  status: string | null;
  subscription_plan_id: string | null;
};

type SubscriptionPlanRow = {
  code: string | null;
};

type OrganizerRow = {
  id: string;
  studio_id: string;
  name: string;
  slug: string;
  active: boolean;
};

type EventLocationSessionPayload = {
  sessionDate: string;
  startTime: string | null;
  endTime: string | null;
  sessionLabel: string;
  seriesLabel: string;
  capacity: number | null;
  sortOrder: number;
};

type EventLocationPayload = {
  locationName: string;
  venueName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  capacity: number | null;
  sortOrder: number;
  sessions: EventLocationSessionPayload[];
};

type EventScheduleItemPayload = {
  scheduleDate: string;
  startTime: string;
  endTime: string | null;
  title: string;
  description: string;
  presenterName: string;
  locationLabel: string;
  sortOrder: number;
};

type GuestCoachBlockPayload = {
  lessonDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  bufferMinutes: number;
  price: number;
  locationLabel: string;
  sortOrder: number;
};

type GuestCoachPayload = {
  id: string;
  name: string;
  bio: string;
  photoUrl: string;
  active: boolean;
  sortOrder: number;
  blocks: GuestCoachBlockPayload[];
};

const EVENT_IMAGE_BUCKET = "event-media";

const EVENT_SLUG_TAKEN_MESSAGE =
  "That event URL is already taken. Please choose a different event slug.";

type StyleOption = {
  key: string;
  label: string;
};

const DANCE_FOCUS_OPTIONS_BY_CATEGORY: Record<string, StyleOption[]> = {
  country: [
    { key: "country", label: "Country / Mixed Country" },
    { key: "country_two_step", label: "Two Step" },
    { key: "country_waltz", label: "Waltz" },
    { key: "country_east_coast_swing", label: "East Coast Swing" },
    { key: "country_west_coast_swing", label: "West Coast Swing" },
    { key: "country_nightclub_two_step", label: "Nightclub Two Step" },
    { key: "country_cha_cha", label: "Cha Cha" },
    { key: "country_polka", label: "Polka" },
    { key: "country_triple_two_step", label: "Triple Two Step" },
    { key: "country_swing", label: "Country Swing" },
    { key: "country_line_dance", label: "Line Dance" },
  ],
  ballroom: [
    { key: "ballroom", label: "Ballroom / Mixed Ballroom" },
    { key: "ballroom_waltz", label: "Waltz" },
    { key: "ballroom_tango", label: "Tango" },
    { key: "ballroom_foxtrot", label: "Foxtrot" },
    { key: "ballroom_viennese_waltz", label: "Viennese Waltz" },
    { key: "ballroom_quickstep", label: "Quickstep" },
    { key: "ballroom_cha_cha", label: "Cha Cha" },
    { key: "ballroom_rumba", label: "Rumba" },
    { key: "ballroom_east_coast_swing", label: "East Coast Swing" },
    { key: "ballroom_bolero", label: "Bolero" },
    { key: "ballroom_mambo", label: "Mambo" },
    { key: "ballroom_samba", label: "Samba" },
    { key: "ballroom_paso_doble", label: "Paso Doble" },
    { key: "ballroom_jive", label: "Jive" },
  ],
  club_latin: [
    { key: "latin", label: "Latin / Mixed Latin" },
    { key: "salsa", label: "Salsa" },
    { key: "bachata", label: "Bachata" },
    { key: "merengue", label: "Merengue" },
    { key: "kizomba", label: "Kizomba" },
    { key: "zouk", label: "Zouk" },
  ],
  swing: [
    { key: "swing", label: "Swing / Mixed Swing" },
    { key: "swing_west_coast_swing", label: "West Coast Swing" },
    { key: "west_coast_swing", label: "West Coast Swing (Legacy)" },
    { key: "swing_east_coast_swing", label: "East Coast Swing" },
    { key: "swing_lindy_hop", label: "Lindy Hop" },
    { key: "swing_balboa", label: "Balboa" },
    { key: "swing_shag", label: "Shag" },
  ],
  other: [
    { key: "other", label: "Other / Mixed Styles" },
    { key: "line_dance", label: "Line Dance (Legacy)" },
    { key: "nightclub_two_step", label: "Nightclub Two Step (Legacy)" },
    { key: "hip_hop", label: "Hip Hop" },
    { key: "contemporary", label: "Contemporary" },
    { key: "ballet", label: "Ballet" },
  ],
};

const STYLE_OPTIONS: StyleOption[] = Object.values(
  DANCE_FOCUS_OPTIONS_BY_CATEGORY,
).flat();

function getDanceCategoryForStyleKey(styleKey: string) {
  for (const [categoryKey, options] of Object.entries(
    DANCE_FOCUS_OPTIONS_BY_CATEGORY,
  )) {
    if (options.some((option) => option.key === styleKey)) {
      return categoryKey;
    }
  }

  return "other";
}

function getStyleCategoryCount(styleKeys: string[]) {
  return new Set(styleKeys.map(getDanceCategoryForStyleKey)).size;
}

const DB_EVENT_STATUSES = [
  "draft",
  "published",
  "cancelled",
  "completed",
] as const;

const DB_EVENT_TYPES = [
  "group_class",
  "workshop",
  "social_dance",
  "showcase",
  "competition",
  "intensive",
  "bootcamp",
  "party",
  "festival",
  "retreat",
  "special_event",
  "other",
] as const;

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getBoolean(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string") return false;
  return value === "true" || value === "on";
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

function parseOptionalNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
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

function normalizeEventSlug(params: {
  requestedSlug: string;
  fallbackName: string;
}) {
  const { requestedSlug, fallbackName } = params;
  return slugify(requestedSlug || fallbackName);
}

function isEventSlugUniqueError(
  error: { code?: string; message?: string } | null | undefined,
) {
  const message = error?.message?.toLowerCase() ?? "";

  return (
    error?.code === "23505" &&
    (message.includes("events_slug_lower_unique_idx") ||
      message.includes("slug"))
  );
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

  if (normalized === "event") return "other";

  if ((DB_EVENT_TYPES as readonly string[]).includes(normalized)) {
    return normalized;
  }

  return "other";
}

function isActiveOrTrialing(status: string | null | undefined) {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "active" || normalized === "trialing";
}

function getEffectiveBillingPlan(
  workspace: WorkspaceRow | null | undefined,
  subscriptionPlan: SubscriptionPlanRow | null | undefined,
) {
  return (
    subscriptionPlan?.code?.trim().toLowerCase() ||
    workspace?.billing_plan?.trim().toLowerCase() ||
    ""
  );
}

function getEffectiveSubscriptionStatus(
  workspace: WorkspaceRow | null | undefined,
  subscription: SubscriptionRow | null | undefined,
) {
  return (
    subscription?.status?.trim().toLowerCase() ||
    workspace?.subscription_status?.trim().toLowerCase() ||
    ""
  );
}

function isProStudioWorkspace(params: {
  workspace: WorkspaceRow | null | undefined;
  subscription: SubscriptionRow | null | undefined;
  subscriptionPlan: SubscriptionPlanRow | null | undefined;
}) {
  return (
    getEffectiveBillingPlan(params.workspace, params.subscriptionPlan) ===
      "pro" &&
    isActiveOrTrialing(
      getEffectiveSubscriptionStatus(params.workspace, params.subscription),
    )
  );
}

function isOrganizerWorkspaceName(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized) return false;

  return (
    normalized.endsWith(" organizer") ||
    normalized.includes(" organizer ") ||
    normalized.endsWith(" events")
  );
}

async function getStudioContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  return {
    supabase,
    studioId: context.studioId,
    userId: user.id,
    error: null as string | null,
  };
}

function parseEventLocations(formData: FormData): EventLocationPayload[] {
  const locationCount =
    parseOptionalInteger(getString(formData, "locationCount")) ?? 0;
  const locations: EventLocationPayload[] = [];

  for (
    let locationIndex = 0;
    locationIndex < locationCount;
    locationIndex += 1
  ) {
    const locationName = getString(
      formData,
      `location_${locationIndex}_locationName`,
    );
    const venueName = getString(
      formData,
      `location_${locationIndex}_venueName`,
    );
    const addressLine1 = getString(
      formData,
      `location_${locationIndex}_addressLine1`,
    );
    const addressLine2 = getString(
      formData,
      `location_${locationIndex}_addressLine2`,
    );
    const city = getString(formData, `location_${locationIndex}_city`);
    const state = getString(formData, `location_${locationIndex}_state`);
    const postalCode = getString(
      formData,
      `location_${locationIndex}_postalCode`,
    );
    const country =
      getString(formData, `location_${locationIndex}_country`) || "US";
    const capacity = parseOptionalInteger(
      getString(formData, `location_${locationIndex}_capacity`),
    );
    const sortOrder =
      parseOptionalInteger(
        getString(formData, `location_${locationIndex}_sortOrder`),
      ) ?? locationIndex;

    const sessionCount =
      parseOptionalInteger(
        getString(formData, `location_${locationIndex}_sessionCount`),
      ) ?? 0;

    const sessions: EventLocationSessionPayload[] = [];

    for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
      const sessionDate = getString(
        formData,
        `location_${locationIndex}_session_${sessionIndex}_date`,
      );
      const startTime =
        getString(
          formData,
          `location_${locationIndex}_session_${sessionIndex}_startTime`,
        ) || null;
      const endTime =
        getString(
          formData,
          `location_${locationIndex}_session_${sessionIndex}_endTime`,
        ) || null;
      const sessionLabel = getString(
        formData,
        `location_${locationIndex}_session_${sessionIndex}_label`,
      );
      const seriesLabel = getString(
        formData,
        `location_${locationIndex}_session_${sessionIndex}_seriesLabel`,
      );
      const sessionCapacity = parseOptionalInteger(
        getString(
          formData,
          `location_${locationIndex}_session_${sessionIndex}_capacity`,
        ),
      );
      const sessionSortOrder =
        parseOptionalInteger(
          getString(
            formData,
            `location_${locationIndex}_session_${sessionIndex}_sortOrder`,
          ),
        ) ?? sessionIndex;

      const hasSessionDetails = Boolean(
        sessionDate ||
        startTime ||
        endTime ||
        sessionLabel ||
        seriesLabel ||
        sessionCapacity != null,
      );

      if (!hasSessionDetails) {
        continue;
      }

      sessions.push({
        sessionDate,
        startTime,
        endTime,
        sessionLabel,
        seriesLabel,
        capacity: sessionCapacity,
        sortOrder: sessionSortOrder,
      });
    }

    const hasLocationDetails = Boolean(
      locationName ||
      venueName ||
      addressLine1 ||
      addressLine2 ||
      city ||
      state ||
      postalCode ||
      capacity != null ||
      sessions.length > 0,
    );

    if (!hasLocationDetails) {
      continue;
    }

    locations.push({
      locationName:
        locationName || venueName || `Location ${locationIndex + 1}`,
      venueName,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      capacity,
      sortOrder,
      sessions,
    });
  }

  return locations;
}

function parseEventScheduleItems(
  formData: FormData,
): EventScheduleItemPayload[] {
  const itemCount =
    parseOptionalInteger(getString(formData, "scheduleItemCount")) ?? 0;
  const items: EventScheduleItemPayload[] = [];

  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const scheduleDate = getString(formData, `scheduleItem_${itemIndex}_date`);
    const startTime = getString(
      formData,
      `scheduleItem_${itemIndex}_startTime`,
    );
    const endTime =
      getString(formData, `scheduleItem_${itemIndex}_endTime`) || null;
    const title = getString(formData, `scheduleItem_${itemIndex}_title`);
    const description = getString(
      formData,
      `scheduleItem_${itemIndex}_description`,
    );
    const presenterName = getString(
      formData,
      `scheduleItem_${itemIndex}_presenterName`,
    );
    const locationLabel = getString(
      formData,
      `scheduleItem_${itemIndex}_locationLabel`,
    );
    const sortOrder =
      parseOptionalInteger(
        getString(formData, `scheduleItem_${itemIndex}_sortOrder`),
      ) ?? itemIndex;

    const hasItemDetails = Boolean(
      scheduleDate ||
      startTime ||
      endTime ||
      title ||
      description ||
      presenterName ||
      locationLabel,
    );

    if (!hasItemDetails) {
      continue;
    }

    items.push({
      scheduleDate,
      startTime,
      endTime,
      title,
      description,
      presenterName,
      locationLabel,
      sortOrder,
    });
  }

  return items;
}

function parseGuestCoaches(formData: FormData): GuestCoachPayload[] {
  const coachCount =
    parseOptionalInteger(getString(formData, "guestCoachCount")) ?? 0;
  const coaches: GuestCoachPayload[] = [];

  for (let coachIndex = 0; coachIndex < coachCount; coachIndex += 1) {
    const name = getString(formData, `guestCoach_${coachIndex}_name`);
    const bio = getString(formData, `guestCoach_${coachIndex}_bio`);
    const photoUrl = getString(formData, `guestCoach_${coachIndex}_photoUrl`);
    const id = getString(formData, `guestCoach_${coachIndex}_id`);
    const active = getBoolean(formData, `guestCoach_${coachIndex}_active`);

    const blockCount =
      parseOptionalInteger(
        getString(formData, `guestCoach_${coachIndex}_blockCount`),
      ) ?? 0;

    const blocks: GuestCoachBlockPayload[] = [];

    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const lessonDate = getString(
        formData,
        `guestCoach_${coachIndex}_block_${blockIndex}_lessonDate`,
      );
      const startTime = getString(
        formData,
        `guestCoach_${coachIndex}_block_${blockIndex}_startTime`,
      );
      const endTime = getString(
        formData,
        `guestCoach_${coachIndex}_block_${blockIndex}_endTime`,
      );
      const durationMinutes =
        parseOptionalInteger(
          getString(
            formData,
            `guestCoach_${coachIndex}_block_${blockIndex}_durationMinutes`,
          ),
        ) ?? 45;
      const bufferMinutes =
        parseOptionalInteger(
          getString(
            formData,
            `guestCoach_${coachIndex}_block_${blockIndex}_bufferMinutes`,
          ),
        ) ?? 0;
      const price =
        parseOptionalNumber(
          getString(formData, `guestCoach_${coachIndex}_block_${blockIndex}_price`),
        ) ?? 0;
      const locationLabel = getString(
        formData,
        `guestCoach_${coachIndex}_block_${blockIndex}_locationLabel`,
      );

      if (!lessonDate || !startTime || !endTime || durationMinutes <= 0) {
        continue;
      }

      blocks.push({
        lessonDate,
        startTime,
        endTime,
        durationMinutes,
        bufferMinutes: Math.max(0, bufferMinutes),
        price: Math.max(0, price),
        locationLabel,
        sortOrder: blockIndex,
      });
    }

    if (!name && blocks.length === 0) {
      continue;
    }

    if (!name) {
      throw new Error("Guest coach name is required when adding lesson slots.");
    }

    coaches.push({
      id,
      name,
      bio,
      photoUrl,
      active,
      sortOrder: coachIndex,
      blocks,
    });
  }

  return coaches;
}


function normalizeStyleKeysForSingleCategory(styleKeys: string[]) {
  const uniqueStyleKeys = Array.from(
    new Set(styleKeys.map((styleKey) => styleKey.trim()).filter(Boolean)),
  );

  if (uniqueStyleKeys.length === 0) {
    return [];
  }

  const selectedCategory = getDanceCategoryForStyleKey(uniqueStyleKeys[0]);

  return uniqueStyleKeys.filter(
    (styleKey) => getDanceCategoryForStyleKey(styleKey) === selectedCategory,
  );
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
  const computedVisibility = publicDirectoryEnabled
    ? "public"
    : requestedVisibility;

  return {
    organizerId: getString(formData, "organizerId"),
    name: rawName,
    slug: normalizeEventSlug({
      requestedSlug: rawSlug,
      fallbackName: rawName,
    }),
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
      "accountRequiredForRegistration",
    ),
    registrationOpensAt: parseOptionalDateTimeLocal(
      getString(formData, "registrationOpensAt"),
    ),
    registrationClosesAt: parseOptionalDateTimeLocal(
      getString(formData, "registrationClosesAt"),
    ),
    capacity,
    waitlistEnabled,
    refundPolicy: getString(formData, "refundPolicy"),
    faq: getString(formData, "faq"),
    tags: normalizeTags(getString(formData, "tags")),
    styleKeys: normalizeStyleKeysForSingleCategory(
      formData
        .getAll("styleKeys")
        .map((value) => String(value).trim())
        .filter((value) =>
          STYLE_OPTIONS.some((option) => option.key === value),
        ),
    ),
    eventLocations: parseEventLocations(formData),
    eventScheduleItems: parseEventScheduleItems(formData),
    guestCoaches: parseGuestCoaches(formData),
  };
}

function validateEventEnums(payload: ReturnType<typeof buildEventPayload>) {
  if (
    !payload.visibility ||
    !isAllowedOptionValue(EVENT_VISIBILITY_OPTIONS, payload.visibility)
  ) {
    return "Invalid visibility.";
  }

  if (
    !payload.timezone ||
    !isAllowedOptionValue(TIMEZONE_OPTIONS, payload.timezone)
  ) {
    return "Invalid timezone.";
  }

  if (payload.state && !isAllowedOptionValue(US_STATE_OPTIONS, payload.state)) {
    return "Invalid state.";
  }

  return null;
}

function validateEventPayload(payload: ReturnType<typeof buildEventPayload>) {
  if (!payload.name) return "Event name is required.";
  if (!payload.slug) return "Event slug is required.";
  if (!payload.startDate) return "Start date is required.";
  if (!payload.endDate && payload.eventType !== "group_class") {
    return "End date is required.";
  }

  const enumError = validateEventEnums(payload);
  if (enumError) return enumError;

  if (payload.endDate && payload.endDate < payload.startDate) {
    return "End date cannot be before start date.";
  }

  if (payload.capacity != null && payload.capacity < 0) {
    return "Capacity cannot be negative.";
  }

  if (getStyleCategoryCount(payload.styleKeys) > 1) {
    return "Choose dance focus options from one dance category only.";
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

  for (const location of payload.eventLocations) {
    if (
      location.state &&
      !isAllowedOptionValue(US_STATE_OPTIONS, location.state)
    ) {
      return "Invalid location state.";
    }

    if (!location.locationName) {
      return "Each event location needs a location label.";
    }

    if (location.capacity != null && location.capacity < 0) {
      return "Location capacity cannot be negative.";
    }

    for (const session of location.sessions) {
      if (!session.sessionDate) {
        return "Each location date/time row needs a date.";
      }

      if (session.capacity != null && session.capacity < 0) {
        return "Session capacity cannot be negative.";
      }
    }
  }

  for (const scheduleItem of payload.eventScheduleItems) {
    if (!scheduleItem.scheduleDate) {
      return "Each event schedule item needs a date.";
    }

    if (!scheduleItem.startTime) {
      return "Each event schedule item needs a start time.";
    }

    if (!scheduleItem.title) {
      return "Each event schedule item needs a title.";
    }
  }

  return null;
}

async function ensureSlugAvailable(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  slug: string;
  excludeEventId?: string;
}) {
  const { supabase, slug, excludeEventId } = params;

  let query = supabase.from("events").select("id").ilike("slug", slug).limit(1);

  if (excludeEventId) {
    query = query.neq("id", excludeEventId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return !data;
}

async function generateUniqueDuplicateEventSlug(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  baseSlug: string;
}) {
  const { supabase, baseSlug } = params;

  const cleanBase = slugify(baseSlug || "event") || "event";

  const candidates = [
    `${cleanBase}-copy`,
    ...Array.from(
      { length: 49 },
      (_, index) => `${cleanBase}-copy-${index + 2}`,
    ),
  ];

  for (const candidate of candidates) {
    const available = await ensureSlugAvailable({
      supabase,
      slug: candidate,
    });

    if (available) {
      return candidate;
    }
  }

  return `${cleanBase}-copy-${Date.now()}`;
}

async function ensureOrganizerValid(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  organizerId: string;
}) {
  const { supabase, studioId, organizerId } = params;

  if (!organizerId) {
    return true;
  }

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

async function getWorkspaceAndOrganizerPolicy(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
}) {
  const { supabase, studioId } = params;

  const { data: workspace, error: workspaceError } = await supabase
    .from("studios")
    .select("id, name, billing_plan, subscription_status")
    .eq("id", studioId)
    .maybeSingle<WorkspaceRow>();

  if (workspaceError) {
    throw new Error(
      `Failed to load workspace policy: ${workspaceError.message}`,
    );
  }

  const { data: subscriptionRows, error: subscriptionsError } = await supabase
    .from("studio_subscriptions")
    .select("status, subscription_plan_id")
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (subscriptionsError) {
    throw new Error(
      `Failed to load subscription policy: ${subscriptionsError.message}`,
    );
  }

  const latestSubscription =
    ((subscriptionRows ?? []) as SubscriptionRow[])[0] ?? null;
  let subscriptionPlan: SubscriptionPlanRow | null = null;

  if (latestSubscription?.subscription_plan_id) {
    const { data: plan, error: planError } = await supabase
      .from("subscription_plans")
      .select("code")
      .eq("id", latestSubscription.subscription_plan_id)
      .maybeSingle<SubscriptionPlanRow>();

    if (planError) {
      throw new Error(
        `Failed to load subscription plan policy: ${planError.message}`,
      );
    }

    subscriptionPlan = plan;
  }

  const effectiveBillingPlan = getEffectiveBillingPlan(
    workspace,
    subscriptionPlan,
  );
  const organizerWorkspace =
    effectiveBillingPlan === "organizer" ||
    isOrganizerWorkspaceName(workspace?.name);
  const studioHostedEvents =
    !organizerWorkspace &&
    isProStudioWorkspace({
      workspace,
      subscription: latestSubscription,
      subscriptionPlan,
    });

  const { data: organizers, error: organizersError } = await supabase
    .from("organizers")
    .select("id, studio_id, name, slug, active")
    .eq("studio_id", studioId)
    .order("name", { ascending: true });

  if (organizersError) {
    throw new Error(
      `Failed to load organizer policy: ${organizersError.message}`,
    );
  }

  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const singleOrganizer =
    typedOrganizers.length === 1 ? typedOrganizers[0] : null;

  return {
    organizerWorkspace,
    organizers: typedOrganizers,
    singleOrganizer,
    studioHostedEvents,
  };
}

async function resolveEffectiveOrganizerId(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  requestedOrganizerId: string;
}) {
  const { supabase, studioId, requestedOrganizerId } = params;

  const policy = await getWorkspaceAndOrganizerPolicy({
    supabase,
    studioId,
  });

  if (policy.organizerWorkspace) {
    if (!policy.singleOrganizer) {
      return {
        organizerId: "",
        error:
          "Organizer workspaces must have exactly one organizer profile before events can be created or edited.",
      };
    }

    return {
      organizerId: policy.singleOrganizer.id,
      error: null as string | null,
    };
  }

  if (!requestedOrganizerId) {
    if (policy.studioHostedEvents) {
      return {
        organizerId: "",
        error: null as string | null,
      };
    }

    return {
      organizerId: "",
      error: "Organizer is required.",
    };
  }

  return {
    organizerId: requestedOrganizerId,
    error: null as string | null,
  };
}

async function replaceEventStyles(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  styleKeys: string[];
}) {
  const { supabase, eventId } = params;

  const styleKeys = Array.from(
    new Set(
      params.styleKeys.map((styleKey) => styleKey.trim()).filter(Boolean),
    ),
  );

  const { data: existingRows, error: existingError } = await supabase
    .from("event_public_styles")
    .select("id, style_key")
    .eq("event_id", eventId);

  if (existingError) {
    throw new Error(`Failed to load event styles: ${existingError.message}`);
  }

  const existingStyleKeys = new Set(
    (existingRows ?? []).map((row) => String(row.style_key)),
  );

  const styleKeysToRemove = (existingRows ?? [])
    .filter((row) => !styleKeys.includes(String(row.style_key)))
    .map((row) => row.id);

  if (styleKeysToRemove.length > 0) {
    const { error: deleteError } = await supabase
      .from("event_public_styles")
      .delete()
      .in("id", styleKeysToRemove);

    if (deleteError) {
      throw new Error(
        `Failed to clear old event styles: ${deleteError.message}`,
      );
    }
  }

  if (styleKeys.length === 0) {
    return;
  }

  const rows = styleKeys.map((styleKey) => ({
    event_id: eventId,
    style_key: styleKey,
    display_name:
      STYLE_OPTIONS.find((option) => option.key === styleKey)?.label ??
      styleKey,
  }));

  const { error: upsertError } = await supabase
    .from("event_public_styles")
    .upsert(rows, {
      onConflict: "event_id,style_key",
    });

  if (upsertError) {
    throw new Error(`Failed to save event styles: ${upsertError.message}`);
  }
}

const ONGOING_GROUP_CLASS_INITIAL_WEEKS = 12;

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function buildWeeklyGroupClassSessions(
  payload: ReturnType<typeof buildEventPayload>,
) {
  if (payload.eventType !== "group_class" || !payload.startDate) {
    return [];
  }

  const start = new Date(`${payload.startDate}T00:00:00`);

  if (Number.isNaN(start.getTime())) {
    return [];
  }

  const end = payload.endDate
    ? new Date(`${payload.endDate}T00:00:00`)
    : addDays(start, 7 * (ONGOING_GROUP_CLASS_INITIAL_WEEKS - 1));

  if (Number.isNaN(end.getTime()) || end < start) {
    return [];
  }

  const sessions: Array<{
    session_date: string;
    start_time: string | null;
    end_time: string | null;
    session_label: string;
    status: string;
  }> = [];

  let cursor = start;
  let week = 1;

  while (cursor <= end) {
    sessions.push({
      session_date: toDateValue(cursor),
      start_time: payload.startTime,
      end_time: payload.endTime,
      session_label: `Week ${week}`,
      status: "scheduled",
    });

    cursor = addDays(cursor, 7);
    week += 1;
  }

  return sessions;
}

async function syncEventSessionsForGroupClass(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  studioId: string;
  payload: ReturnType<typeof buildEventPayload>;
}) {
  const { supabase, eventId, studioId, payload } = params;

  if (payload.eventType !== "group_class") {
    const { error } = await supabase
      .from("event_sessions")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("event_id", eventId)
      .eq("studio_id", studioId)
      .eq("status", "scheduled");

    if (error) {
      throw new Error(
        `Could not cancel old group class sessions: ${error.message}`,
      );
    }

    return;
  }

  const sessions = buildWeeklyGroupClassSessions(payload);

  if (sessions.length === 0) {
    return;
  }

  const rows = sessions.map((session) => ({
    event_id: eventId,
    studio_id: studioId,
    ...session,
    updated_at: new Date().toISOString(),
  }));

  const { error: upsertError } = await supabase
    .from("event_sessions")
    .upsert(rows, {
      onConflict: "event_id,session_date",
    });

  if (upsertError) {
    throw new Error(
      `Could not save group class sessions: ${upsertError.message}`,
    );
  }

  const activeSessionDates = sessions.map((session) => session.session_date);

  const { error: existingError, data: existingRows } = await supabase
    .from("event_sessions")
    .select("id, session_date")
    .eq("event_id", eventId)
    .eq("studio_id", studioId)
    .eq("status", "scheduled");

  if (existingError) {
    throw new Error(
      `Could not review group class sessions: ${existingError.message}`,
    );
  }

  const obsoleteIds = (existingRows ?? [])
    .filter((row) => !activeSessionDates.includes(row.session_date))
    .map((row) => row.id);

  if (obsoleteIds.length > 0) {
    const { error: cancelError } = await supabase
      .from("event_sessions")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .in("id", obsoleteIds);

    if (cancelError) {
      throw new Error(
        `Could not cancel obsolete group class sessions: ${cancelError.message}`,
      );
    }
  }
}

async function replaceEventLocationSchedule(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  studioId: string;
  eventLocations: EventLocationPayload[];
}) {
  const { supabase, eventId, studioId, eventLocations } = params;

  if (eventLocations.length === 0) {
    return;
  }

  const { error: deleteError } = await supabase
    .from("event_locations")
    .delete()
    .eq("event_id", eventId)
    .eq("studio_id", studioId);

  if (deleteError) {
    throw new Error(
      `Could not clear old event locations: ${deleteError.message}`,
    );
  }

  const { data: insertedLocations, error: locationsError } = await supabase
    .from("event_locations")
    .insert(
      eventLocations.map((location) => ({
        event_id: eventId,
        studio_id: studioId,
        location_name: location.locationName,
        venue_name: location.venueName || null,
        address_line_1: location.addressLine1 || null,
        address_line_2: location.addressLine2 || null,
        city: location.city || null,
        state: location.state || null,
        postal_code: location.postalCode || null,
        country: location.country || "US",
        capacity: location.capacity,
        sort_order: location.sortOrder,
        active: true,
      })),
    )
    .select("id, sort_order");

  if (locationsError || !insertedLocations) {
    throw new Error(
      `Could not save event locations: ${locationsError?.message ?? "Unknown error."}`,
    );
  }

  const locationIdBySortOrder = new Map<number, string>();

  insertedLocations.forEach((location) => {
    locationIdBySortOrder.set(Number(location.sort_order), String(location.id));
  });

  const sessionRows = eventLocations.flatMap((location) => {
    const eventLocationId = locationIdBySortOrder.get(location.sortOrder);

    if (!eventLocationId) {
      return [];
    }

    return location.sessions.map((session) => ({
      event_id: eventId,
      event_location_id: eventLocationId,
      studio_id: studioId,
      session_date: session.sessionDate,
      start_time: session.startTime,
      end_time: session.endTime,
      session_label: session.sessionLabel || null,
      series_label: session.seriesLabel || null,
      capacity: session.capacity,
      status: "scheduled",
      sort_order: session.sortOrder,
    }));
  });

  if (sessionRows.length === 0) {
    return;
  }

  const { error: sessionsError } = await supabase
    .from("event_location_sessions")
    .insert(sessionRows);

  if (sessionsError) {
    throw new Error(
      `Could not save event location dates: ${sessionsError.message}`,
    );
  }
}

async function replaceEventScheduleItems(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  studioId: string;
  organizerId: string | null;
  scheduleItems: EventScheduleItemPayload[];
}) {
  const { supabase, eventId, studioId, organizerId, scheduleItems } = params;

  const { error: deleteError } = await supabase
    .from("event_schedule_items")
    .delete()
    .eq("event_id", eventId)
    .eq("studio_id", studioId);

  if (deleteError) {
    throw new Error(
      `Could not clear old event schedule: ${deleteError.message}`,
    );
  }

  if (scheduleItems.length === 0) {
    return;
  }

  const { error: insertError } = await supabase
    .from("event_schedule_items")
    .insert(
      scheduleItems.map((item) => ({
        event_id: eventId,
        studio_id: studioId,
        organizer_id: organizerId || null,
        schedule_date: item.scheduleDate,
        start_time: item.startTime,
        end_time: item.endTime || null,
        title: item.title,
        description: item.description || null,
        presenter_name: item.presenterName || null,
        location_label: item.locationLabel || null,
        sort_order: item.sortOrder,
        active: true,
        updated_at: new Date().toISOString(),
      })),
    );

  if (insertError) {
    throw new Error(`Could not save event schedule: ${insertError.message}`);
  }
}

function normalizeTimeForDateTime(time: string) {
  const trimmed = time.trim();

  if (/^\d{2}:\d{2}$/.test(trimmed)) {
    return `${trimmed}:00`;
  }

  if (/^\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(/^(\d{2}:\d{2}:\d{2})/);
  return match?.[1] ?? trimmed;
}

function parseDateParts(value: string) {
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));

  if (!year || !month || !day) {
    return null;
  }

  return { year, month, day };
}

function parseTimeParts(value: string) {
  const normalizedTime = normalizeTimeForDateTime(value);
  const [hour, minute, second] = normalizedTime
    .split(":")
    .map((part) => Number.parseInt(part, 10));

  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }

  return { hour, minute, second };
}

function getTimeZoneOffsetMs(timeZone: string, date: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );

  return asUtc - date.getTime();
}

function toSlotDateTimeIso(lessonDate: string, time: string, timeZone: string) {
  const dateParts = parseDateParts(lessonDate);
  const timeParts = parseTimeParts(time);

  if (!dateParts || !timeParts) {
    return null;
  }

  const utcGuess = new Date(
    Date.UTC(
      dateParts.year,
      dateParts.month - 1,
      dateParts.day,
      timeParts.hour,
      timeParts.minute,
      timeParts.second,
    ),
  );

  const offset = getTimeZoneOffsetMs(timeZone || "America/New_York", utcGuess);
  const zonedDate = new Date(utcGuess.getTime() - offset);

  if (Number.isNaN(zonedDate.getTime())) {
    return null;
  }

  return zonedDate.toISOString();
}

function addMinutesIso(isoValue: string, minutes: number) {
  const parsed = new Date(isoValue);
  parsed.setMinutes(parsed.getMinutes() + minutes);
  return parsed.toISOString();
}

function buildPrivateLessonSlotRows(params: {
  eventId: string;
  coachId: string;
  blockId: string;
  studioId: string;
  organizerId: string | null;
  block: GuestCoachBlockPayload;
  timezone: string;
}) {
  const { eventId, coachId, blockId, studioId, organizerId, block, timezone } = params;
  const firstStartIso = toSlotDateTimeIso(block.lessonDate, block.startTime, timezone);
  const blockEndIso = toSlotDateTimeIso(block.lessonDate, block.endTime, timezone);

  if (!firstStartIso || !blockEndIso) {
    return [];
  }

  const rows = [];
  const stepMinutes = block.durationMinutes + block.bufferMinutes;
  let slotStartIso = firstStartIso;

  while (new Date(addMinutesIso(slotStartIso, block.durationMinutes)) <= new Date(blockEndIso)) {
    const slotEndIso = addMinutesIso(slotStartIso, block.durationMinutes);

    rows.push({
      event_id: eventId,
      coach_id: coachId,
      block_id: blockId,
      studio_id: studioId,
      organizer_id: organizerId,
      starts_at: slotStartIso,
      ends_at: slotEndIso,
      price: block.price,
      location_label: block.locationLabel || null,
      status: "available",
      payment_status: "unpaid",
      updated_at: new Date().toISOString(),
    });

    slotStartIso = addMinutesIso(slotStartIso, Math.max(5, stepMinutes));
  }

  return rows;
}

async function replaceGuestCoachPrivateLessons(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  studioId: string;
  organizerId: string | null;
  guestCoaches: GuestCoachPayload[];
  timezone: string;
}) {
  const { supabase, eventId, studioId, organizerId, guestCoaches, timezone } = params;

  const { error: deleteError } = await supabase
    .from("event_guest_coaches")
    .delete()
    .eq("event_id", eventId)
    .eq("studio_id", studioId);

  if (deleteError) {
    throw new Error(`Could not clear old guest coaches: ${deleteError.message}`);
  }

  for (const coach of guestCoaches) {
    const { data: insertedCoach, error: coachError } = await supabase
      .from("event_guest_coaches")
      .insert({
        event_id: eventId,
        studio_id: studioId,
        organizer_id: organizerId,
        name: coach.name,
        bio: coach.bio || null,
        photo_url: coach.photoUrl || null,
        active: coach.active,
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (coachError || !insertedCoach) {
      throw new Error(
        `Could not save guest coach: ${coachError?.message ?? "Unknown error."}`,
      );
    }

    for (const block of coach.blocks) {
      const { data: insertedBlock, error: blockError } = await supabase
        .from("event_private_lesson_blocks")
        .insert({
          event_id: eventId,
          coach_id: insertedCoach.id,
          studio_id: studioId,
          organizer_id: organizerId,
          lesson_date: block.lessonDate,
          start_time: block.startTime,
          end_time: block.endTime,
          duration_minutes: block.durationMinutes,
          buffer_minutes: block.bufferMinutes,
          price: block.price,
          location_label: block.locationLabel || null,
          active: coach.active,
          updated_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (blockError || !insertedBlock) {
        throw new Error(
          `Could not save guest coach availability: ${blockError?.message ?? "Unknown error."}`,
        );
      }

      const slotRows = buildPrivateLessonSlotRows({
        eventId,
        coachId: insertedCoach.id,
        blockId: insertedBlock.id,
        studioId,
        organizerId,
        block,
        timezone,
      });

      if (slotRows.length === 0) {
        continue;
      }

      const { error: slotsError } = await supabase
        .from("event_private_lesson_slots")
        .insert(slotRows);

      if (slotsError) {
        throw new Error(`Could not generate private lesson slots: ${slotsError.message}`);
      }
    }
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
  const extension = safeName.includes(".") ? safeName.split(".").pop() : "jpg";

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
  organizerId: string | null;
  resolvedCoverImageUrl: string | null;
}) {
  const { payload, studioId, organizerId, resolvedCoverImageUrl } = params;

  return {
    organizer_id: organizerId || null,
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
      normalizeOptionValue(TIMEZONE_OPTIONS, payload.timezone) ??
      "America/New_York",
    start_date: payload.startDate,
    end_date: payload.endDate || null,
    start_time: payload.startTime,
    end_time: payload.endTime,
    cover_image_url: resolvedCoverImageUrl,
    public_cover_image_url: resolvedCoverImageUrl,
    visibility:
      normalizeOptionValue(EVENT_VISIBILITY_OPTIONS, payload.visibility) ??
      "public",
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


function getSafeReturnTo(formData: FormData, fallback: string) {
  const rawReturnTo = getString(formData, "returnTo");
  if (!rawReturnTo.startsWith("/app/")) {
    return fallback;
  }

  return rawReturnTo;
}

function redirectWithSlotMessage(
  formData: FormData,
  fallback: string,
  messageParam: string,
) {
  const returnTo = getSafeReturnTo(formData, fallback);
  const separator = returnTo.includes("?") ? "&" : "?";
  redirect(`${returnTo}${separator}${messageParam}`);
}

async function requirePrivateLessonSlotAccess(formData: FormData) {
  const slotId = getString(formData, "slotId");
  const eventId = getString(formData, "eventId");

  if (!slotId || !eventId) {
    throw new Error("Missing private lesson slot information.");
  }

  const { supabase, studioId } = await getStudioContext();

  const { data: slot, error: slotError } = await supabase
    .from("event_private_lesson_slots")
    .select(
      `
      id,
      event_id,
      studio_id,
      status,
      payment_status,
      starts_at,
      ends_at
    `,
    )
    .eq("id", slotId)
    .eq("event_id", eventId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (slotError) {
    throw new Error(`Could not load private lesson slot: ${slotError.message}`);
  }

  if (!slot) {
    throw new Error("Private lesson slot not found.");
  }

  return {
    supabase,
    studioId,
    slotId,
    eventId,
    slot,
  };
}

export async function bookPrivateLessonSlotOfflineAction(formData: FormData) {
  const fallback = `/app/events/${getString(formData, "eventId")}/private-lessons`;
  const buyerName = getString(formData, "buyerName");
  const buyerEmail = getString(formData, "buyerEmail");
  const buyerPhone = getString(formData, "buyerPhone");
  const buyerNotes = getString(formData, "buyerNotes");
  const paymentStatus = getString(formData, "paymentStatus") || "paid";

  if (!buyerName) {
    redirectWithSlotMessage(formData, fallback, "private_lesson_error=buyer_name_required");
  }

  const validPaymentStatuses = new Set(["paid", "unpaid", "partial", "waived"]);
  const resolvedPaymentStatus = validPaymentStatuses.has(paymentStatus)
    ? paymentStatus
    : "paid";

  try {
    const { supabase, studioId, slotId } =
      await requirePrivateLessonSlotAccess(formData);

    const { error: updateError } = await supabase
      .from("event_private_lesson_slots")
      .update({
        status: "booked",
        payment_status: resolvedPaymentStatus,
        buyer_name: buyerName,
        buyer_email: buyerEmail || null,
        buyer_phone: buyerPhone || null,
        buyer_notes: buyerNotes || null,
        booked_at: new Date().toISOString(),
        held_until: null,
        hold_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", slotId)
      .eq("studio_id", studioId)
      .eq("status", "available");

    if (updateError) {
      throw new Error(`Could not book private lesson slot: ${updateError.message}`);
    }
  } catch (error) {
    redirectWithSlotMessage(formData, fallback, "private_lesson_error=book_failed");
  }

  redirectWithSlotMessage(formData, fallback, "private_lesson_booked=1");
}

export async function holdPrivateLessonSlotAction(formData: FormData) {
  const fallback = `/app/events/${getString(formData, "eventId")}/private-lessons`;
  const buyerNotes = getString(formData, "buyerNotes");

  try {
    const { supabase, studioId, slotId } =
      await requirePrivateLessonSlotAccess(formData);

    const { error: updateError } = await supabase
      .from("event_private_lesson_slots")
      .update({
        status: "held",
        payment_status: "waived",
        buyer_name: null,
        buyer_email: null,
        buyer_phone: null,
        buyer_notes: buyerNotes || "Blocked by studio.",
        booked_at: new Date().toISOString(),
        held_until: null,
        hold_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", slotId)
      .eq("studio_id", studioId)
      .eq("status", "available");

    if (updateError) {
      throw new Error(`Could not block private lesson slot: ${updateError.message}`);
    }
  } catch (error) {
    redirectWithSlotMessage(formData, fallback, "private_lesson_error=block_failed");
  }

  redirectWithSlotMessage(formData, fallback, "private_lesson_blocked=1");
}

export async function releasePrivateLessonSlotAction(formData: FormData) {
  const fallback = `/app/events/${getString(formData, "eventId")}/private-lessons`;

  try {
    const { supabase, studioId, slotId } =
      await requirePrivateLessonSlotAccess(formData);

    const { error: updateError } = await supabase
      .from("event_private_lesson_slots")
      .update({
        status: "available",
        payment_status: "unpaid",
        buyer_name: null,
        buyer_email: null,
        buyer_phone: null,
        buyer_notes: null,
        client_id: null,
        stripe_checkout_session_id: null,
        stripe_payment_intent_id: null,
        booked_at: null,
        held_until: null,
        hold_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", slotId)
      .eq("studio_id", studioId)
      .in("status", ["held", "booked", "cancelled"]);

    if (updateError) {
      throw new Error(`Could not release private lesson slot: ${updateError.message}`);
    }
  } catch (error) {
    redirectWithSlotMessage(formData, fallback, "private_lesson_error=release_failed");
  }

  redirectWithSlotMessage(formData, fallback, "private_lesson_released=1");
}


function createGuestCoachScheduleToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

async function requireGuestCoachScheduleAccess(formData: FormData) {
  const { supabase, studioId } = await getStudioContext();

  const coachId = getString(formData, "coachId");
  const eventId = getString(formData, "eventId");

  if (!coachId || !eventId) {
    throw new Error("Missing guest coach or event.");
  }

  const { data: coach, error: coachError } = await supabase
    .from("event_guest_coaches")
    .select("id, event_id, studio_id, schedule_token, active")
    .eq("id", coachId)
    .eq("event_id", eventId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (coachError) {
    throw new Error(`Could not load guest coach: ${coachError.message}`);
  }

  if (!coach) {
    throw new Error("Guest coach not found for this studio/event.");
  }

  return {
    supabase,
    studioId,
    coachId,
    eventId,
    coach,
  };
}

export async function regenerateGuestCoachScheduleTokenAction(formData: FormData) {
  const fallback = `/app/events/${getString(formData, "eventId")}/private-lessons`;

  try {
    const { supabase, studioId, coachId } =
      await requireGuestCoachScheduleAccess(formData);

    const { error: updateError } = await supabase
      .from("event_guest_coaches")
      .update({
        schedule_token: createGuestCoachScheduleToken(),
        schedule_token_enabled: true,
        schedule_token_created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", coachId)
      .eq("studio_id", studioId);

    if (updateError) {
      throw new Error(
        `Could not regenerate guest coach schedule link: ${updateError.message}`,
      );
    }
  } catch (error) {
    redirectWithSlotMessage(
      formData,
      fallback,
      "private_lesson_error=coach_schedule_link_failed",
    );
  }

  redirectWithSlotMessage(formData, fallback, "coach_schedule_link_regenerated=1");
}

export async function setGuestCoachScheduleLinkEnabledAction(formData: FormData) {
  const fallback = `/app/events/${getString(formData, "eventId")}/private-lessons`;
  const enabled = getString(formData, "enabled") === "true";

  try {
    const { supabase, studioId, coachId } =
      await requireGuestCoachScheduleAccess(formData);

    const { error: updateError } = await supabase
      .from("event_guest_coaches")
      .update({
        schedule_token_enabled: enabled,
        updated_at: new Date().toISOString(),
      })
      .eq("id", coachId)
      .eq("studio_id", studioId);

    if (updateError) {
      throw new Error(
        `Could not update guest coach schedule link: ${updateError.message}`,
      );
    }
  } catch (error) {
    redirectWithSlotMessage(
      formData,
      fallback,
      "private_lesson_error=coach_schedule_link_failed",
    );
  }

  redirectWithSlotMessage(
    formData,
    fallback,
    enabled ? "coach_schedule_link_enabled=1" : "coach_schedule_link_disabled=1",
  );
}

export async function createEventAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const {
      supabase,
      studioId,
      userId,
      error: studioError,
    } = await getStudioContext();

    if (studioError) {
      return { error: studioError };
    }

    const payload = buildEventPayload(formData);

    const organizerResolution = await resolveEffectiveOrganizerId({
      supabase,
      studioId,
      requestedOrganizerId: payload.organizerId,
    });

    if (organizerResolution.error) {
      return { error: organizerResolution.error };
    }

    const effectivePayload = {
      ...payload,
      organizerId: organizerResolution.organizerId,
    };

    const validationError = validateEventPayload(effectivePayload);

    if (validationError) {
      return { error: validationError };
    }

    const organizerValid = await ensureOrganizerValid({
      supabase,
      studioId,
      organizerId: effectivePayload.organizerId,
    });

    if (!organizerValid) {
      return { error: "Selected organizer is invalid." };
    }

    const slugAvailable = await ensureSlugAvailable({
      supabase,
      slug: effectivePayload.slug,
    });

    if (!slugAvailable) {
      return { error: EVENT_SLUG_TAKEN_MESSAGE };
    }

    const resolvedCoverImageUrl = await resolveCoverImageUrl({
      supabase,
      studioId,
      slug: effectivePayload.slug,
      existingUrl: null,
      payload: effectivePayload,
    });

    const insertPayload = {
      ...buildInsertUpdatePayload({
        payload: effectivePayload,
        studioId,
        organizerId: effectivePayload.organizerId,
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
      if (isEventSlugUniqueError(eventError)) {
        return { error: EVENT_SLUG_TAKEN_MESSAGE };
      }

      return {
        error: `Could not create event: ${
          eventError?.message ?? "Unknown error."
        }`,
      };
    }

    if (effectivePayload.tags.length > 0) {
      const { error: tagsError } = await supabase.from("event_tags").insert(
        effectivePayload.tags.map((tag) => ({
          event_id: event.id,
          tag,
        })),
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
      styleKeys: effectivePayload.styleKeys,
    });

    await syncEventSessionsForGroupClass({
      supabase,
      eventId: event.id,
      studioId,
      payload: effectivePayload,
    });

    await replaceEventLocationSchedule({
      supabase,
      eventId: event.id,
      studioId,
      eventLocations: effectivePayload.eventLocations,
    });

    await replaceEventScheduleItems({
      supabase,
      eventId: event.id,
      studioId,
      organizerId: effectivePayload.organizerId || null,
      scheduleItems: effectivePayload.eventScheduleItems,
    });

    await replaceGuestCoachPrivateLessons({
      supabase,
      eventId: event.id,
      studioId,
      organizerId: effectivePayload.organizerId || null,
      guestCoaches: effectivePayload.guestCoaches,
      timezone: effectivePayload.timezone,
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
  formData: FormData,
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

    const organizerResolution = await resolveEffectiveOrganizerId({
      supabase,
      studioId,
      requestedOrganizerId: payload.organizerId,
    });

    if (organizerResolution.error) {
      return { error: organizerResolution.error };
    }

    const effectivePayload = {
      ...payload,
      organizerId: organizerResolution.organizerId,
    };

    const validationError = validateEventPayload(effectivePayload);

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
      organizerId: effectivePayload.organizerId,
    });

    if (!organizerValid) {
      return { error: "Selected organizer is invalid." };
    }

    const slugAvailable = await ensureSlugAvailable({
      supabase,
      slug: effectivePayload.slug,
      excludeEventId: id,
    });

    if (!slugAvailable) {
      return { error: EVENT_SLUG_TAKEN_MESSAGE };
    }

    const resolvedCoverImageUrl = await resolveCoverImageUrl({
      supabase,
      studioId,
      slug: effectivePayload.slug,
      existingUrl:
        existingEvent.public_cover_image_url ??
        existingEvent.cover_image_url ??
        null,
      payload: effectivePayload,
    });

    const { error: updateError } = await supabase
      .from("events")
      .update({
        ...buildInsertUpdatePayload({
          payload: effectivePayload,
          studioId,
          organizerId: effectivePayload.organizerId,
          resolvedCoverImageUrl,
        }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("studio_id", studioId);

    if (updateError) {
      if (isEventSlugUniqueError(updateError)) {
        return { error: EVENT_SLUG_TAKEN_MESSAGE };
      }

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

    if (effectivePayload.tags.length > 0) {
      const { error: tagsError } = await supabase.from("event_tags").insert(
        effectivePayload.tags.map((tag) => ({
          event_id: id,
          tag,
        })),
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
      styleKeys: effectivePayload.styleKeys,
    });

    await syncEventSessionsForGroupClass({
      supabase,
      eventId: id,
      studioId,
      payload: effectivePayload,
    });

    await replaceEventLocationSchedule({
      supabase,
      eventId: id,
      studioId,
      eventLocations: effectivePayload.eventLocations,
    });

    await replaceEventScheduleItems({
      supabase,
      eventId: id,
      studioId,
      organizerId: effectivePayload.organizerId || null,
      scheduleItems: effectivePayload.eventScheduleItems,
    });

    await replaceGuestCoachPrivateLessons({
      supabase,
      eventId: id,
      studioId,
      organizerId: effectivePayload.organizerId || null,
      guestCoaches: effectivePayload.guestCoaches,
      timezone: effectivePayload.timezone,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect(`/app/events/${id}`);
}

export async function duplicateEventAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  let redirectTo = "/app/events";

  if (!eventId) {
    redirect("/app/events");
  }

  try {
    const {
      supabase,
      studioId,
      userId,
      error: studioError,
    } = await getStudioContext();

    if (studioError) {
      throw new Error(studioError);
    }

    const { data: sourceEvent, error: sourceEventError } = await supabase
      .from("events")
      .select(
        `
        organizer_id,
        studio_id,
        name,
        slug,
        event_type,
        short_description,
        description,
        public_summary,
        public_description,
        venue_name,
        address_line_1,
        address_line_2,
        city,
        state,
        postal_code,
        timezone,
        start_date,
        end_date,
        start_time,
        end_time,
        cover_image_url,
        public_cover_image_url,
        visibility,
        featured,
        beginner_friendly,
        public_directory_enabled,
        registration_required,
        account_required_for_registration,
        registration_opens_at,
        registration_closes_at,
        capacity,
        waitlist_enabled,
        refund_policy,
        faq
      `,
      )
      .eq("id", eventId)
      .eq("studio_id", studioId)
      .single();

    if (sourceEventError || !sourceEvent) {
      throw new Error("Event not found.");
    }

    const newSlug = await generateUniqueDuplicateEventSlug({
      supabase,
      baseSlug: sourceEvent.slug,
    });

    const { data: duplicatedEvent, error: duplicateError } = await supabase
      .from("events")
      .insert({
        organizer_id: sourceEvent.organizer_id,
        studio_id: studioId,
        name: `${sourceEvent.name} Copy`,
        slug: newSlug,
        event_type: sourceEvent.event_type,
        short_description: sourceEvent.short_description,
        description: sourceEvent.description,
        public_summary: sourceEvent.public_summary,
        public_description: sourceEvent.public_description,
        venue_name: sourceEvent.venue_name,
        address_line_1: sourceEvent.address_line_1,
        address_line_2: sourceEvent.address_line_2,
        city: sourceEvent.city,
        state: sourceEvent.state,
        postal_code: sourceEvent.postal_code,
        timezone: sourceEvent.timezone,
        start_date: sourceEvent.start_date,
        end_date: sourceEvent.end_date,
        start_time: sourceEvent.start_time,
        end_time: sourceEvent.end_time,
        cover_image_url: sourceEvent.cover_image_url,
        public_cover_image_url: sourceEvent.public_cover_image_url,
        visibility: "private",
        featured: false,
        beginner_friendly: sourceEvent.beginner_friendly,
        public_directory_enabled: false,
        status: "draft",
        registration_required: sourceEvent.registration_required,
        account_required_for_registration:
          sourceEvent.account_required_for_registration,
        registration_opens_at: sourceEvent.registration_opens_at,
        registration_closes_at: sourceEvent.registration_closes_at,
        capacity: sourceEvent.capacity,
        waitlist_enabled: sourceEvent.waitlist_enabled,
        refund_policy: sourceEvent.refund_policy,
        faq: sourceEvent.faq,
        created_by: userId,
      })
      .select("id")
      .single();

    if (duplicateError || !duplicatedEvent) {
      if (isEventSlugUniqueError(duplicateError)) {
        throw new Error(EVENT_SLUG_TAKEN_MESSAGE);
      }

      throw new Error(
        `Could not duplicate event: ${
          duplicateError?.message ?? "Unknown error."
        }`,
      );
    }

    const [
      { data: sourceTags, error: tagsError },
      { data: sourceStyles, error: stylesError },
      { data: sourceTickets, error: ticketsError },
      { data: sourceLocations, error: locationsError },
      { data: sourceScheduleItems, error: scheduleItemsError },
    ] = await Promise.all([
      supabase.from("event_tags").select("tag").eq("event_id", eventId),

      supabase
        .from("event_public_styles")
        .select("style_key, display_name")
        .eq("event_id", eventId),

      supabase
        .from("event_ticket_types")
        .select(
          `
          name,
          price,
          currency,
          capacity,
          active,
          sale_starts_at,
          sale_ends_at
        `,
        )
        .eq("event_id", eventId),

      supabase
        .from("event_locations")
        .select(
          `
          id,
          location_name,
          venue_name,
          address_line_1,
          address_line_2,
          city,
          state,
          postal_code,
          country,
          capacity,
          sort_order,
          active,
          event_location_sessions (
            session_date,
            start_time,
            end_time,
            session_label,
            series_label,
            capacity,
            status,
            sort_order
          )
        `,
        )
        .eq("event_id", eventId)
        .eq("studio_id", studioId)
        .order("sort_order", { ascending: true }),

      supabase
        .from("event_schedule_items")
        .select(
          `
          schedule_date,
          start_time,
          end_time,
          title,
          description,
          presenter_name,
          location_label,
          sort_order,
          active
        `,
        )
        .eq("event_id", eventId)
        .eq("studio_id", studioId)
        .eq("active", true)
        .order("schedule_date", { ascending: true })
        .order("start_time", { ascending: true })
        .order("sort_order", { ascending: true }),
    ]);

    if (tagsError) {
      throw new Error(
        `Event copied, but tags could not be loaded: ${tagsError.message}`,
      );
    }

    if (stylesError) {
      throw new Error(
        `Event copied, but styles could not be loaded: ${stylesError.message}`,
      );
    }

    if (ticketsError) {
      throw new Error(
        `Event copied, but ticket types could not be loaded: ${ticketsError.message}`,
      );
    }

    if (locationsError) {
      throw new Error(
        `Event copied, but locations could not be loaded: ${locationsError.message}`,
      );
    }

    if (scheduleItemsError) {
      throw new Error(
        `Event copied, but schedule items could not be loaded: ${scheduleItemsError.message}`,
      );
    }

    if ((sourceTags ?? []).length > 0) {
      const { error: insertTagsError } = await supabase
        .from("event_tags")
        .insert(
          (sourceTags ?? []).map((tag) => ({
            event_id: duplicatedEvent.id,
            tag: tag.tag,
          })),
        );

      if (insertTagsError) {
        throw new Error(
          `Event copied, but tags could not be saved: ${insertTagsError.message}`,
        );
      }
    }

    if ((sourceStyles ?? []).length > 0) {
      const { error: insertStylesError } = await supabase
        .from("event_public_styles")
        .insert(
          (sourceStyles ?? []).map((style) => ({
            event_id: duplicatedEvent.id,
            style_key: style.style_key,
            display_name: style.display_name,
          })),
        );

      if (insertStylesError) {
        throw new Error(
          `Event copied, but styles could not be saved: ${insertStylesError.message}`,
        );
      }
    }

    if ((sourceTickets ?? []).length > 0) {
      const { error: insertTicketsError } = await supabase
        .from("event_ticket_types")
        .insert(
          (sourceTickets ?? []).map((ticket) => ({
            event_id: duplicatedEvent.id,
            studio_id: studioId,
            name: ticket.name,
            price: ticket.price,
            currency: ticket.currency,
            capacity: ticket.capacity,
            active: ticket.active,
            sale_starts_at: ticket.sale_starts_at,
            sale_ends_at: ticket.sale_ends_at,
          })),
        );

      if (insertTicketsError) {
        throw new Error(
          `Event copied, but ticket types could not be saved: ${insertTicketsError.message}`,
        );
      }
    }

    if ((sourceLocations ?? []).length > 0) {
      const normalizedLocations: EventLocationPayload[] = (
        sourceLocations ?? []
      ).map((location: any, locationIndex: number) => ({
        locationName: location.location_name || `Location ${locationIndex + 1}`,
        venueName: location.venue_name || "",
        addressLine1: location.address_line_1 || "",
        addressLine2: location.address_line_2 || "",
        city: location.city || "",
        state: location.state || "",
        postalCode: location.postal_code || "",
        country: location.country || "US",
        capacity: location.capacity ?? null,
        sortOrder: location.sort_order ?? locationIndex,
        sessions: (location.event_location_sessions ?? [])
          .filter((session: any) => session.status !== "cancelled")
          .map((session: any, sessionIndex: number) => ({
            sessionDate: session.session_date,
            startTime: session.start_time ?? null,
            endTime: session.end_time ?? null,
            sessionLabel: session.session_label || "",
            seriesLabel: session.series_label || "",
            capacity: session.capacity ?? null,
            sortOrder: session.sort_order ?? sessionIndex,
          })),
      }));

      await replaceEventLocationSchedule({
        supabase,
        eventId: duplicatedEvent.id,
        studioId,
        eventLocations: normalizedLocations,
      });
    }

    if ((sourceScheduleItems ?? []).length > 0) {
      const { error: insertScheduleItemsError } = await supabase
        .from("event_schedule_items")
        .insert(
          (sourceScheduleItems ?? [])
            .filter((item: any) => item.active !== false)
            .map((item: any, itemIndex: number) => ({
              event_id: duplicatedEvent.id,
              studio_id: studioId,
              organizer_id: sourceEvent.organizer_id || null,
              schedule_date: item.schedule_date,
              start_time: item.start_time,
              end_time: item.end_time,
              title: item.title,
              description: item.description,
              presenter_name: item.presenter_name,
              location_label: item.location_label,
              sort_order: item.sort_order ?? itemIndex,
              active: true,
            })),
        );

      if (insertScheduleItemsError) {
        throw new Error(
          `Event copied, but schedule items could not be saved: ${insertScheduleItemsError.message}`,
        );
      }
    }

    redirectTo = `/app/events/${duplicatedEvent.id}/edit`;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not duplicate this event.";

    redirectTo = `/app/events/${encodeURIComponent(eventId)}?error=${encodeURIComponent(
      message,
    )}`;
  }

  redirect(redirectTo);
}


