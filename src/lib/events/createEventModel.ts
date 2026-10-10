/**
 * 10C.2: organizer-intent model for the Create Event form.
 *
 * Pure helpers over the EXISTING stored fields (events.event_type, status, visibility,
 * public_directory_enabled). Nothing here adds a type or a column; it only groups the stored event
 * types for display and maps two organizer choices (who can find it + publish now/draft) onto the
 * same three stored flags the form always submitted.
 */

export const EVENT_TYPE_OPTIONS = [
  { value: "group_class", label: "Group Class" },
  { value: "social_dance", label: "Social Dance" },
  { value: "workshop", label: "Workshop" },
  { value: "party", label: "Party" },
  { value: "competition", label: "Competition" },
  { value: "showcase", label: "Showcase" },
  { value: "festival", label: "Festival" },
  { value: "special_event", label: "Special Event" },
  { value: "other", label: "Other" },
] as const;

export type EventTypeValue = (typeof EVENT_TYPE_OPTIONS)[number]["value"];

export type EventTypeCategory = {
  key: string;
  label: string;
  description: string;
  /** First entry is the default stored type when the category is picked. */
  types: ReadonlyArray<{ value: EventTypeValue; label: string }>;
};

/** Top-level choices. Every stored type appears in exactly one category. */
export const EVENT_TYPE_CATEGORIES: ReadonlyArray<EventTypeCategory> = [
  {
    key: "class",
    label: "Group Class",
    description: "A weekly class or series with a roster.",
    types: [{ value: "group_class", label: "Group Class" }],
  },
  {
    key: "social",
    label: "Social or Party",
    description: "A dance night, open social or party.",
    types: [
      { value: "social_dance", label: "Social Dance" },
      { value: "party", label: "Party" },
    ],
  },
  {
    key: "workshop",
    label: "Workshop or Festival",
    description: "Focused training, or a multi-day dance weekend.",
    types: [
      { value: "workshop", label: "Workshop" },
      { value: "festival", label: "Festival" },
    ],
  },
  {
    key: "competition",
    label: "Competition",
    description: "Judged entries. You set up categories and prices next.",
    types: [{ value: "competition", label: "Competition" }],
  },
  {
    key: "showcase",
    label: "Showcase",
    description: "A performance or recital.",
    types: [{ value: "showcase", label: "Showcase" }],
  },
  {
    key: "other",
    label: "Special Event or Other",
    description: "Anything that doesn't fit the others.",
    types: [
      { value: "special_event", label: "Special Event" },
      { value: "other", label: "Other" },
    ],
  },
];

export function categoryForEventType(eventType: string | null | undefined): EventTypeCategory {
  const normalized = (eventType ?? "").trim().toLowerCase();
  return (
    EVENT_TYPE_CATEGORIES.find((category) => category.types.some((type) => type.value === normalized)) ??
    EVENT_TYPE_CATEGORIES[EVENT_TYPE_CATEGORIES.length - 1]
  );
}

export function defaultTypeForCategory(categoryKey: string): EventTypeValue {
  const category = EVENT_TYPE_CATEGORIES.find((item) => item.key === categoryKey) ?? EVENT_TYPE_CATEGORIES[0];
  return category.types[0].value;
}

/* ---------------------------------------------------------------- who can find it */

export type EventAudience = "public" | "link" | "studio";

export type EventVisibilityIntent = {
  audience: EventAudience;
  /** Only meaningful for the public audience. */
  discovery: boolean;
  publishNow: boolean;
};

export type EventVisibilityFields = {
  status: string;
  visibility: string;
  publicDirectoryEnabled: boolean;
};

/**
 * Organizer intent -> stored flags.
 *  - public  -> visibility "public"; Discovery adds public_directory_enabled
 *  - link    -> visibility "unlisted"
 *  - studio  -> visibility "private"
 *  - draft   -> status "draft" (lifecycle, independent of the audience)
 *  - publish -> status "open" when registration is on (so it accepts registration inside its window),
 *               otherwise "published"
 * Discovery is stored only with the public audience, exactly as the server already enforces
 * (public_directory_enabled forces visibility public).
 */
export function resolveVisibilityFields(
  intent: EventVisibilityIntent,
  registrationRequired: boolean,
): EventVisibilityFields {
  const publicAudience = intent.audience === "public";
  return {
    status: intent.publishNow ? (registrationRequired ? "open" : "published") : "draft",
    visibility: publicAudience ? "public" : intent.audience === "link" ? "unlisted" : "private",
    publicDirectoryEnabled: publicAudience && intent.discovery,
  };
}

/** Stored flags -> organizer intent (used to seed the form and for round-trip tests). */
export function intentFromFields(fields: EventVisibilityFields): EventVisibilityIntent {
  const audience: EventAudience =
    fields.publicDirectoryEnabled || fields.visibility === "public"
      ? "public"
      : fields.visibility === "unlisted"
        ? "link"
        : "studio";
  return {
    audience,
    discovery: audience === "public" && fields.publicDirectoryEnabled,
    publishNow: fields.status !== "draft",
  };
}

/* ---------------------------------------------------------------- inline validation */

export type EventFieldKey = "name" | "slug" | "dates" | "host" | "location" | "capacity" | "registration";

/**
 * The create action returns one error string. Map the known messages to the field they belong to so the
 * form can show them next to that field instead of in a banner. Unknown messages return null.
 */
export function fieldForEventError(error: string | null | undefined): EventFieldKey | null {
  const text = (error ?? "").toLowerCase();
  if (!text) return null;
  if (text.includes("slug") || text.includes("already in use") || text.includes("already taken")) return "slug";
  if (text.startsWith("event name")) return "name";
  if (text.includes("start date") || text.includes("end date") || text.includes("timezone")) return "dates";
  if (text.includes("organizer")) return "host";
  if (text.includes("state") || text.includes("location")) return "location";
  if (text.includes("capacity")) return "capacity";
  if (text.includes("registration")) return "registration";
  return null;
}
