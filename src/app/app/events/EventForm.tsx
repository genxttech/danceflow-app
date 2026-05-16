"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { createEventAction, updateEventAction } from "./actions";

type OrganizerOption = {
  id: string;
  name: string;
};

type EventLocationSessionFormValue = {
  sessionDate: string;
  startTime: string;
  endTime: string;
  sessionLabel: string;
  seriesLabel: string;
  capacity: string;
};

type EventLocationFormValue = {
  locationName: string;
  venueName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  capacity: string;
  sessions: EventLocationSessionFormValue[];
};

type EventScheduleItemFormValue = {
  scheduleDate: string;
  startTime: string;
  endTime: string;
  title: string;
  description: string;
  presenterName: string;
  locationLabel: string;
};

type GuestCoachBlockFormValue = {
  lessonDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: string;
  bufferMinutes: string;
  price: string;
  locationLabel: string;
};

type GuestCoachFormValue = {
  id?: string;
  name: string;
  bio: string;
  photoUrl: string;
  scheduleToken?: string;
  active: boolean;
  blocks: GuestCoachBlockFormValue[];
};

type EventFormState = {
  error?: string;
  success?: string;
};

type ScheduleMode = "single" | "multi";

type EventFormInitialValues = {
  id?: string;
  name?: string;
  slug?: string;
  organizerId?: string;
  eventType?: string;
  status?: string;
  visibility?: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  venueName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  coverImageUrl?: string;
  shortDescription?: string;
  description?: string;
  refundPolicy?: string;
  faq?: string;
  tags?: string;
  capacity?: number | null;
  featured?: boolean;
  registrationRequired?: boolean;
  accountRequiredForRegistration?: boolean;
  waitlistEnabled?: boolean;
  registrationOpensAt?: string;
  registrationClosesAt?: string;
  publicDirectoryEnabled?: boolean;
  beginnerFriendly?: boolean;
  styleKeys?: string[];
  eventLocations?: EventLocationFormValue[];
  eventScheduleItems?: EventScheduleItemFormValue[];
  guestCoaches?: GuestCoachFormValue[];
};

type EventFormProps = {
  mode: "create" | "edit";
  organizers: OrganizerOption[];
  initialValues?: EventFormInitialValues;
  organizerWorkspace?: boolean;
};

function RequiredAsterisk() {
  return <span className="ml-1 text-red-500">*</span>;
}

const EVENT_TYPE_OPTIONS = [
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

const EVENT_STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

const EVENT_VISIBILITY_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "unlisted", label: "Unlisted" },
  { value: "public", label: "Public" },
] as const;

type StyleOption = {
  key: string;
  label: string;
};

type DanceCategoryOption = {
  key: string;
  label: string;
  helper: string;
};

const DANCE_CATEGORY_OPTIONS: DanceCategoryOption[] = [
  {
    key: "country",
    label: "Country",
    helper: "Two Step, country Waltz, line dance, and country social dances.",
  },
  {
    key: "ballroom",
    label: "Ballroom",
    helper: "Smooth, Standard, Rhythm, and Latin ballroom dances.",
  },
  {
    key: "club_latin",
    label: "Club / Social Latin",
    helper: "Salsa, Bachata, Merengue, Kizomba, and Zouk.",
  },
  {
    key: "swing",
    label: "Swing",
    helper:
      "West Coast Swing, East Coast Swing, Lindy Hop, and related dances.",
  },
  {
    key: "other",
    label: "Other / Mixed",
    helper: "Use this for mixed events or styles outside the main categories.",
  },
];

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

function getInitialDanceCategory(styleKeys: string[]) {
  const firstStyleKey = styleKeys.find((styleKey) =>
    STYLE_OPTIONS.some((option) => option.key === styleKey),
  );

  return firstStyleKey ? getDanceCategoryForStyleKey(firstStyleKey) : "country";
}

const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
] as const;

const US_STATE_OPTIONS = [
  { value: "AL", label: "Alabama" },
  { value: "AK", label: "Alaska" },
  { value: "AZ", label: "Arizona" },
  { value: "AR", label: "Arkansas" },
  { value: "CA", label: "California" },
  { value: "CO", label: "Colorado" },
  { value: "CT", label: "Connecticut" },
  { value: "DE", label: "Delaware" },
  { value: "FL", label: "Florida" },
  { value: "GA", label: "Georgia" },
  { value: "HI", label: "Hawaii" },
  { value: "ID", label: "Idaho" },
  { value: "IL", label: "Illinois" },
  { value: "IN", label: "Indiana" },
  { value: "IA", label: "Iowa" },
  { value: "KS", label: "Kansas" },
  { value: "KY", label: "Kentucky" },
  { value: "LA", label: "Louisiana" },
  { value: "ME", label: "Maine" },
  { value: "MD", label: "Maryland" },
  { value: "MA", label: "Massachusetts" },
  { value: "MI", label: "Michigan" },
  { value: "MN", label: "Minnesota" },
  { value: "MS", label: "Mississippi" },
  { value: "MO", label: "Missouri" },
  { value: "MT", label: "Montana" },
  { value: "NE", label: "Nebraska" },
  { value: "NV", label: "Nevada" },
  { value: "NH", label: "New Hampshire" },
  { value: "NJ", label: "New Jersey" },
  { value: "NM", label: "New Mexico" },
  { value: "NY", label: "New York" },
  { value: "NC", label: "North Carolina" },
  { value: "ND", label: "North Dakota" },
  { value: "OH", label: "Ohio" },
  { value: "OK", label: "Oklahoma" },
  { value: "OR", label: "Oregon" },
  { value: "PA", label: "Pennsylvania" },
  { value: "RI", label: "Rhode Island" },
  { value: "SC", label: "South Carolina" },
  { value: "SD", label: "South Dakota" },
  { value: "TN", label: "Tennessee" },
  { value: "TX", label: "Texas" },
  { value: "UT", label: "Utah" },
  { value: "VT", label: "Vermont" },
  { value: "VA", label: "Virginia" },
  { value: "WA", label: "Washington" },
  { value: "WV", label: "West Virginia" },
  { value: "WI", label: "Wisconsin" },
  { value: "WY", label: "Wyoming" },
];

const initialState: EventFormState = {
  error: "",
  success: "",
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getTodayDateValue() {
  return new Date().toISOString().slice(0, 10);
}

function formatPreviewDate(value: string) {
  if (!value) return "";

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatWeekdayPlural(value: string) {
  if (!value) return "";

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const weekday = date.toLocaleDateString([], { weekday: "long" });
  return `${weekday}s`;
}

function calculateWeeklySeriesCount(startDate: string, endDate: string) {
  if (!startDate || !endDate) return null;

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  if (end < start) return null;

  const days = Math.round(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
  );

  return Math.floor(days / 7) + 1;
}

function getLocalDateTimeInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function getEventTypeHelpText(eventType: string) {
  switch (eventType) {
    case "group_class":
      return "Best for classes that may be public, private, or unlisted and can support registration.";
    case "social_dance":
      return "Best for dance nights, open socials, and community gatherings.";
    case "workshop":
      return "Best for educational intensives, seminars, and focused training blocks.";
    case "competition":
      return "Best for competitive events, heats, and judged formats.";
    default:
      return "Choose the closest event category for search and reporting.";
  }
}

function getStatusHelpText(status: string) {
  switch (status) {
    case "draft":
      return "Visible only internally until you are ready to publish.";
    case "published":
      return "Published and ready to appear where allowed by visibility.";
    case "open":
      return "Published and actively open for registration.";
    case "closed":
      return "Not accepting new registrations.";
    case "cancelled":
      return "Cancelled and should no longer be promoted.";
    default:
      return "";
  }
}

function makeBlankSession(
  params?: Partial<EventLocationSessionFormValue>,
): EventLocationSessionFormValue {
  return {
    sessionDate: params?.sessionDate ?? "",
    startTime: params?.startTime ?? "",
    endTime: params?.endTime ?? "",
    sessionLabel: params?.sessionLabel ?? "",
    seriesLabel: params?.seriesLabel ?? "",
    capacity: params?.capacity ?? "",
  };
}

function makeBlankLocation(
  params?: Partial<EventLocationFormValue>,
): EventLocationFormValue {
  return {
    locationName: params?.locationName ?? "",
    venueName: params?.venueName ?? "",
    addressLine1: params?.addressLine1 ?? "",
    addressLine2: params?.addressLine2 ?? "",
    city: params?.city ?? "",
    state: params?.state ?? "",
    postalCode: params?.postalCode ?? "",
    country: params?.country ?? "US",
    capacity: params?.capacity ?? "",
    sessions: params?.sessions?.length ? params.sessions : [makeBlankSession()],
  };
}

function makeBlankEventScheduleItem(): EventScheduleItemFormValue {
  return {
    scheduleDate: getTodayDateValue(),
    startTime: "",
    endTime: "",
    title: "",
    description: "",
    presenterName: "",
    locationLabel: "",
  };
}

function buildInitialEventScheduleItems(
  initialValues: EventFormInitialValues | undefined,
): EventScheduleItemFormValue[] {
  return initialValues?.eventScheduleItems?.length
    ? initialValues.eventScheduleItems.map((item) => ({
        scheduleDate: item.scheduleDate ?? getTodayDateValue(),
        startTime: item.startTime ?? "",
        endTime: item.endTime ?? "",
        title: item.title ?? "",
        description: item.description ?? "",
        presenterName: item.presenterName ?? "",
        locationLabel: item.locationLabel ?? "",
      }))
    : [];
}

function makeBlankGuestCoachBlock(
  params?: Partial<GuestCoachBlockFormValue>,
): GuestCoachBlockFormValue {
  return {
    lessonDate: params?.lessonDate ?? getTodayDateValue(),
    startTime: params?.startTime ?? "",
    endTime: params?.endTime ?? "",
    durationMinutes: params?.durationMinutes ?? "45",
    bufferMinutes: params?.bufferMinutes ?? "0",
    price: params?.price ?? "",
    locationLabel: params?.locationLabel ?? "",
  };
}

function makeBlankGuestCoach(
  params?: Partial<GuestCoachFormValue>,
): GuestCoachFormValue {
  return {
    id: params?.id,
    name: params?.name ?? "",
    bio: params?.bio ?? "",
    photoUrl: params?.photoUrl ?? "",
    active: params?.active ?? true,
    blocks: params?.blocks?.length
      ? params.blocks.map((block) => makeBlankGuestCoachBlock(block))
      : [makeBlankGuestCoachBlock()],
  };
}

function buildInitialGuestCoaches(
  initialValues: EventFormInitialValues | undefined,
): GuestCoachFormValue[] {
  return (initialValues?.guestCoaches ?? []).map((coach) =>
    makeBlankGuestCoach(coach),
  );
}

function buildInitialEventLocations(
  initialValues: EventFormInitialValues | undefined,
): EventLocationFormValue[] {
  if (initialValues?.eventLocations?.length) {
    return initialValues.eventLocations.map((location) =>
      makeBlankLocation({
        ...location,
        sessions: location.sessions?.length
          ? location.sessions.map((session) => makeBlankSession(session))
          : [
              makeBlankSession({
                sessionDate: initialValues.startDate ?? "",
                startTime: initialValues.startTime ?? "",
                endTime: initialValues.endTime ?? "",
              }),
            ],
      }),
    );
  }

  return [
    makeBlankLocation({
      locationName: initialValues?.venueName ?? "Primary Location",
      venueName: initialValues?.venueName ?? "",
      addressLine1: initialValues?.addressLine1 ?? "",
      addressLine2: initialValues?.addressLine2 ?? "",
      city: initialValues?.city ?? "",
      state: initialValues?.state ?? "",
      postalCode: initialValues?.postalCode ?? "",
      country: "US",
      capacity:
        initialValues?.capacity != null ? String(initialValues.capacity) : "",
      sessions: [
        makeBlankSession({
          sessionDate: initialValues?.startDate ?? getTodayDateValue(),
          startTime: initialValues?.startTime ?? "",
          endTime: initialValues?.endTime ?? "",
          seriesLabel: initialValues?.endDate ? "Series 1" : "",
        }),
      ],
    }),
  ];
}

function shouldUseMultiLocationMode(
  initialValues: EventFormInitialValues | undefined,
): boolean {
  const locations = initialValues?.eventLocations ?? [];

  return locations.length > 0;
}

export default function EventForm({
  mode,
  organizers,
  initialValues,
  organizerWorkspace = false,
}: EventFormProps) {
  const action = mode === "edit" ? updateEventAction : createEventAction;
  const [state, formAction, pending] = useActionState(action, initialState);

  const [name, setName] = useState(initialValues?.name ?? "");
  const [slug, setSlug] = useState(initialValues?.slug ?? "");
  const [eventType, setEventType] = useState(
    initialValues?.eventType ?? "group_class",
  );
  const [status, setStatus] = useState(initialValues?.status ?? "draft");
  const [visibility, setVisibility] = useState(
    initialValues?.visibility ?? "private",
  );
  const [capacity, setCapacity] = useState(
    initialValues?.capacity != null ? String(initialValues.capacity) : "",
  );
  const [registrationRequired, setRegistrationRequired] = useState(
    initialValues?.registrationRequired ?? true,
  );
  const [accountRequiredForRegistration, setAccountRequiredForRegistration] =
    useState(initialValues?.accountRequiredForRegistration ?? false);
  const [waitlistEnabled, setWaitlistEnabled] = useState(
    initialValues?.waitlistEnabled ?? false,
  );
  const [publicDirectoryEnabled, setPublicDirectoryEnabled] = useState(
    initialValues?.publicDirectoryEnabled ?? false,
  );
  const [beginnerFriendly, setBeginnerFriendly] = useState(
    initialValues?.beginnerFriendly ?? false,
  );
  const [selectedStyleKeys, setSelectedStyleKeys] = useState<string[]>(() => {
    const initialStyleKeys = initialValues?.styleKeys ?? [];
    const initialCategory = getInitialDanceCategory(initialStyleKeys);

    return initialStyleKeys.filter(
      (styleKey) => getDanceCategoryForStyleKey(styleKey) === initialCategory,
    );
  });
  const [danceCategory, setDanceCategory] = useState(() =>
    getInitialDanceCategory(selectedStyleKeys),
  );
  const visibleDanceFocusOptions =
    DANCE_FOCUS_OPTIONS_BY_CATEGORY[danceCategory] ??
    DANCE_FOCUS_OPTIONS_BY_CATEGORY.country;
  const selectedDanceCategory =
    DANCE_CATEGORY_OPTIONS.find((option) => option.key === danceCategory) ??
    DANCE_CATEGORY_OPTIONS[0];
  const [tags, setTags] = useState(initialValues?.tags ?? "");
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(() =>
    shouldUseMultiLocationMode(initialValues) ? "multi" : "single",
  );
  const [startDate, setStartDate] = useState(
    initialValues?.startDate ?? getTodayDateValue(),
  );
  const [endDate, setEndDate] = useState(initialValues?.endDate ?? "");
  const [startTime, setStartTime] = useState(initialValues?.startTime ?? "");
  const [endTime, setEndTime] = useState(initialValues?.endTime ?? "");
  const [eventLocations, setEventLocations] = useState<
    EventLocationFormValue[]
  >(() => buildInitialEventLocations(initialValues));
  const [eventScheduleItems, setEventScheduleItems] = useState<
    EventScheduleItemFormValue[]
  >(() => buildInitialEventScheduleItems(initialValues));
  const [guestCoaches, setGuestCoaches] = useState<GuestCoachFormValue[]>(() =>
    buildInitialGuestCoaches(initialValues),
  );

  const primaryLocation = eventLocations[0] ?? makeBlankLocation();
  const primarySession = primaryLocation.sessions[0] ?? makeBlankSession();
  const fallbackStartDate =
    primarySession.sessionDate || startDate || getTodayDateValue();
  const fallbackEndDate =
    eventLocations
      .flatMap((location) =>
        location.sessions.map((session) => session.sessionDate),
      )
      .filter(Boolean)
      .sort()
      .at(-1) ||
    endDate ||
    fallbackStartDate;
  const fallbackStartTime = primarySession.startTime || startTime;
  const fallbackEndTime = primarySession.endTime || endTime;

  const suggestedSlug = useMemo(() => slugify(name), [name]);
  const isGroupClass = eventType === "group_class";
  const hasCapacity = capacity.trim() !== "" && Number(capacity) > 0;
  const groupClassWeekday = isGroupClass ? formatWeekdayPlural(startDate) : "";
  const groupClassSeriesCount =
    isGroupClass && endDate
      ? calculateWeeklySeriesCount(startDate, endDate)
      : null;
  const groupClassDatePreview = isGroupClass
    ? endDate
      ? `${groupClassWeekday || "Weekly"} · ${formatPreviewDate(
          startDate,
        )} – ${formatPreviewDate(endDate)}${
          groupClassSeriesCount ? ` · ${groupClassSeriesCount}-week series` : ""
        }`
      : `${groupClassWeekday || "Weekly"} · Starts ${formatPreviewDate(
          startDate,
        )} · Ongoing weekly class`
    : "";

  const singleOrganizer = organizers.length === 1 ? organizers[0] : null;
  const isStudioHostedEvent = !organizerWorkspace && organizers.length === 0;
  const organizerDefaultValue =
    initialValues?.organizerId ?? singleOrganizer?.id ?? "";
  const organizerSelectionLocked =
    organizerWorkspace && Boolean(singleOrganizer);

  const visibilitySummary = useMemo(() => {
    if (publicDirectoryEnabled) {
      return "Public directory enabled overrides visibility to make the event discoverable.";
    }

    switch (visibility) {
      case "public":
        return "Public pages can show this event when organizer and publication rules allow it.";
      case "unlisted":
        return "The event can be shared by direct link but is not listed in discovery.";
      default:
        return "Private events stay internal and out of public discovery.";
    }
  }, [publicDirectoryEnabled, visibility]);

  function handleDanceCategoryChange(categoryKey: string) {
    setDanceCategory(categoryKey);
    setSelectedStyleKeys((current) =>
      current.filter(
        (styleKey) => getDanceCategoryForStyleKey(styleKey) === categoryKey,
      ),
    );
  }

  function toggleStyleKey(styleKey: string, checked: boolean) {
    const styleCategory = getDanceCategoryForStyleKey(styleKey);

    setDanceCategory(styleCategory);
    setSelectedStyleKeys((current) => {
      const currentCategoryOnly = current.filter(
        (item) => getDanceCategoryForStyleKey(item) === styleCategory,
      );

      return checked
        ? Array.from(new Set([...currentCategoryOnly, styleKey]))
        : currentCategoryOnly.filter((item) => item !== styleKey);
    });
  }

  function updateLocationField(
    locationIndex: number,
    field: keyof Omit<EventLocationFormValue, "sessions">,
    value: string,
  ) {
    setEventLocations((current) =>
      current.map((location, index) =>
        index === locationIndex ? { ...location, [field]: value } : location,
      ),
    );
  }

  function updateSessionField(
    locationIndex: number,
    sessionIndex: number,
    field: keyof EventLocationSessionFormValue,
    value: string,
  ) {
    setEventLocations((current) =>
      current.map((location, index) => {
        if (index !== locationIndex) return location;

        return {
          ...location,
          sessions: location.sessions.map((session, nestedIndex) =>
            nestedIndex === sessionIndex
              ? { ...session, [field]: value }
              : session,
          ),
        };
      }),
    );
  }

  function addEventLocation() {
    setEventLocations((current) => [
      ...current,
      makeBlankLocation({
        locationName: `Location ${current.length + 1}`,
        sessions: [
          makeBlankSession({
            sessionDate: startDate,
            startTime,
            endTime,
          }),
        ],
      }),
    ]);
  }

  function removeEventLocation(locationIndex: number) {
    setEventLocations((current) =>
      current.length <= 1
        ? current
        : current.filter((_, index) => index !== locationIndex),
    );
  }

  function addLocationSession(locationIndex: number) {
    setEventLocations((current) =>
      current.map((location, index) =>
        index === locationIndex
          ? {
              ...location,
              sessions: [
                ...location.sessions,
                makeBlankSession({
                  sessionDate: startDate,
                  startTime,
                  endTime,
                }),
              ],
            }
          : location,
      ),
    );
  }

  function removeLocationSession(locationIndex: number, sessionIndex: number) {
    setEventLocations((current) =>
      current.map((location, index) => {
        if (index !== locationIndex) return location;

        return {
          ...location,
          sessions:
            location.sessions.length <= 1
              ? location.sessions
              : location.sessions.filter(
                  (_, nestedIndex) => nestedIndex !== sessionIndex,
                ),
        };
      }),
    );
  }

  function addEventScheduleItem() {
    setEventScheduleItems((current) => [
      ...current,
      {
        ...makeBlankEventScheduleItem(),
        scheduleDate:
          current.at(-1)?.scheduleDate || startDate || getTodayDateValue(),
      },
    ]);
  }

  function updateEventScheduleItem(
    itemIndex: number,
    field: keyof EventScheduleItemFormValue,
    value: string,
  ) {
    setEventScheduleItems((current) =>
      current.map((item, index) =>
        index === itemIndex ? { ...item, [field]: value } : item,
      ),
    );
  }

  function removeEventScheduleItem(itemIndex: number) {
    setEventScheduleItems((current) =>
      current.filter((_, index) => index !== itemIndex),
    );
  }

  function addGuestCoach() {
    setGuestCoaches((current) => [...current, makeBlankGuestCoach()]);
  }

  function removeGuestCoach(coachIndex: number) {
    setGuestCoaches((current) =>
      current.filter((_, index) => index !== coachIndex),
    );
  }

  function updateGuestCoach(
    coachIndex: number,
    field: keyof Omit<GuestCoachFormValue, "blocks">,
    value: string | boolean,
  ) {
    setGuestCoaches((current) =>
      current.map((coach, index) =>
        index === coachIndex ? { ...coach, [field]: value } : coach,
      ),
    );
  }

  function addGuestCoachBlock(coachIndex: number) {
    setGuestCoaches((current) =>
      current.map((coach, index) =>
        index === coachIndex
          ? { ...coach, blocks: [...coach.blocks, makeBlankGuestCoachBlock()] }
          : coach,
      ),
    );
  }

  function removeGuestCoachBlock(coachIndex: number, blockIndex: number) {
    setGuestCoaches((current) =>
      current.map((coach, index) => {
        if (index !== coachIndex) return coach;
        return {
          ...coach,
          blocks:
            coach.blocks.length <= 1
              ? coach.blocks
              : coach.blocks.filter(
                  (_, nestedIndex) => nestedIndex !== blockIndex,
                ),
        };
      }),
    );
  }

  function updateGuestCoachBlock(
    coachIndex: number,
    blockIndex: number,
    field: keyof GuestCoachBlockFormValue,
    value: string,
  ) {
    setGuestCoaches((current) =>
      current.map((coach, index) => {
        if (index !== coachIndex) return coach;
        return {
          ...coach,
          blocks: coach.blocks.map((block, nestedIndex) =>
            nestedIndex === blockIndex ? { ...block, [field]: value } : block,
          ),
        };
      }),
    );
  }

  return (
    <form action={formAction} className="space-y-5 md:space-y-6">
      {mode === "edit" && initialValues?.id ? (
        <input type="hidden" name="id" value={initialValues.id} />
      ) : null}

      <input
        type="hidden"
        name="waitlistEnabled"
        value={waitlistEnabled ? "true" : "false"}
      />

      <input
        type="hidden"
        name="locationCount"
        value={scheduleMode === "multi" ? eventLocations.length : 0}
      />
      <input
        type="hidden"
        name="scheduleItemCount"
        value={eventScheduleItems.length}
      />
      {eventLocations.map((location, locationIndex) => (
        <div key={`location-hidden-${locationIndex}`}>
          <input
            type="hidden"
            name={`location_${locationIndex}_sessionCount`}
            value={location.sessions.length}
          />
        </div>
      ))}

      <input type="hidden" name="guestCoachCount" value={guestCoaches.length} />
      {guestCoaches.map((coach, coachIndex) => (
        <input
          key={`guest-coach-${coachIndex}-block-count`}
          type="hidden"
          name={`guestCoach_${coachIndex}_blockCount`}
          value={coach.blocks.length}
        />
      ))}

      {selectedStyleKeys.map((styleKey) => (
        <input key={styleKey} type="hidden" name="styleKeys" value={styleKey} />
      ))}

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 md:text-3xl">
              {mode === "edit" ? "Edit Event" : "New Event"}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
              Create public or internal offerings like group classes, socials,
              workshops, and special events. Pro studios can publish
              studio-hosted events using the studio name as the public host.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:min-w-[280px]">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Fields marked with * are required.
            </div>

            <Link
              href={
                mode === "edit" && initialValues?.id
                  ? `/app/events/${initialValues.id}`
                  : "/app/events"
              }
              className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </Link>
          </div>
        </div>

        {state.error ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error} Check required fields marked with * and try again.
          </div>
        ) : null}
      </div>

      {state.success ? (
        <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {state.success}
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr] xl:items-start">
        <div className="space-y-5">
          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
                Core Setup
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Define the event identity, schedule, organizer, and location.
              </p>
            </div>

            {isGroupClass ? (
              <div className="mb-4 rounded-2xl border border-green-200 bg-green-50 p-4">
                <h4 className="text-base font-semibold text-green-900">
                  Group Class Mode
                </h4>
                <p className="mt-2 text-sm text-green-800">
                  Group classes are created here as events, not as standard
                  appointments. After creation, the class can be published
                  publicly, shared by unlisted link, or kept private for
                  internal scheduling and roster management.
                </p>
              </div>
            ) : null}

            {organizerSelectionLocked && singleOrganizer ? (
              <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <h4 className="text-base font-semibold text-emerald-900">
                  Organizer-linked event
                </h4>
                <p className="mt-2 text-sm text-emerald-800">
                  This event will be created under{" "}
                  <span className="font-medium">{singleOrganizer.name}</span>.
                  Organizer accounts cannot create events under multiple
                  organizer brands.
                </p>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label
                  htmlFor="name"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Event Name
                  <RequiredAsterisk />
                </label>
                <input
                  id="name"
                  name="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={
                    isGroupClass ? "Beginner Two Step Class" : "Event name"
                  }
                />
              </div>

              <div>
                <label
                  htmlFor="slug"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Slug
                </label>
                <input
                  id="slug"
                  name="slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={suggestedSlug || "generated-from-name"}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Leave blank to use: {suggestedSlug || "generated-from-name"}
                </p>
              </div>

              <div>
                <label
                  htmlFor="organizerId"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Event Host
                  {!isStudioHostedEvent && organizers.length > 0 ? (
                    <RequiredAsterisk />
                  ) : null}
                </label>

                {isStudioHostedEvent ? (
                  <div className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3">
                    <input type="hidden" name="organizerId" value="" />
                    <p className="text-sm font-medium text-violet-900">
                      Studio-hosted event
                    </p>
                    <p className="mt-1 text-xs text-violet-800">
                      This Pro studio event will use your studio name as the
                      public event host. No separate organizer is required.
                    </p>
                  </div>
                ) : organizerSelectionLocked && singleOrganizer ? (
                  <>
                    <input
                      type="hidden"
                      name="organizerId"
                      value={singleOrganizer.id}
                    />
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                      <p className="text-sm font-medium text-emerald-900">
                        {singleOrganizer.name}
                      </p>
                      <p className="mt-1 text-xs text-emerald-800">
                        This organizer workspace is locked to its single
                        organizer profile.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <select
                      id="organizerId"
                      name="organizerId"
                      required={organizers.length > 0}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                      defaultValue={organizerDefaultValue}
                    >
                      <option value="">Select organizer</option>
                      {organizers.map((organizer) => (
                        <option key={organizer.id} value={organizer.id}>
                          {organizer.name}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-slate-500">
                      Choose the organizer brand this event belongs to.
                    </p>
                  </>
                )}
              </div>

              <div>
                <label
                  htmlFor="eventType"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Event Type
                  <RequiredAsterisk />
                </label>
                <select
                  id="eventType"
                  name="eventType"
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  {EVENT_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {getEventTypeHelpText(eventType)}
                </p>
              </div>

              <div>
                <label
                  htmlFor="status"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Status
                  <RequiredAsterisk />
                </label>
                <select
                  id="status"
                  name="status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  {EVENT_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {getStatusHelpText(status)}
                </p>
              </div>

              <div>
                <label
                  htmlFor="visibility"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Visibility
                  <RequiredAsterisk />
                </label>
                <select
                  id="visibility"
                  name="visibility"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                  disabled={publicDirectoryEnabled}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm disabled:bg-slate-100"
                >
                  {EVENT_VISIBILITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {visibilitySummary}
                </p>
              </div>

              <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h4 className="text-base font-semibold text-slate-950">
                      Event Schedule & Locations
                    </h4>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      Choose the simple schedule for one location, or use the
                      multi-location builder when the same event runs across
                      different places, dates, or quarterly series.
                    </p>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2 md:min-w-[360px]">
                    <button
                      type="button"
                      onClick={() => setScheduleMode("single")}
                      className={`rounded-xl border px-4 py-3 text-left text-sm font-medium ${
                        scheduleMode === "single"
                          ? "border-violet-300 bg-violet-50 text-violet-950"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      Single location
                    </button>
                    <button
                      type="button"
                      onClick={() => setScheduleMode("multi")}
                      className={`rounded-xl border px-4 py-3 text-left text-sm font-medium ${
                        scheduleMode === "multi"
                          ? "border-indigo-300 bg-indigo-50 text-indigo-950"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      Multi-location / dates
                    </button>
                  </div>
                </div>
              </div>

              {scheduleMode === "multi" ? (
                <>
                  <input
                    type="hidden"
                    name="startDate"
                    value={fallbackStartDate}
                  />
                  <input type="hidden" name="endDate" value={fallbackEndDate} />
                  <input
                    type="hidden"
                    name="startTime"
                    value={fallbackStartTime}
                  />
                  <input type="hidden" name="endTime" value={fallbackEndTime} />
                  <input
                    type="hidden"
                    name="venueName"
                    value={primaryLocation.venueName}
                  />
                  <input
                    type="hidden"
                    name="addressLine1"
                    value={primaryLocation.addressLine1}
                  />
                  <input
                    type="hidden"
                    name="addressLine2"
                    value={primaryLocation.addressLine2}
                  />
                  <input
                    type="hidden"
                    name="city"
                    value={primaryLocation.city}
                  />
                  <input
                    type="hidden"
                    name="state"
                    value={primaryLocation.state}
                  />
                  <input
                    type="hidden"
                    name="postalCode"
                    value={primaryLocation.postalCode}
                  />
                </>
              ) : null}

              {scheduleMode === "single" ? (
                <>
                  <div>
                    <label
                      htmlFor="startDate"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      {isGroupClass ? "First Class Date" : "Start Date"}
                      <RequiredAsterisk />
                    </label>
                    <input
                      id="startDate"
                      name="startDate"
                      type="date"
                      required
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                    {isGroupClass ? (
                      <p className="mt-1 text-xs text-slate-500">
                        DanceFlow uses this date to determine the weekly class
                        day.
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <label
                      htmlFor="endDate"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      {isGroupClass ? "Final Class Date" : "End Date"}
                      {!isGroupClass ? <RequiredAsterisk /> : null}
                    </label>
                    <input
                      id="endDate"
                      name="endDate"
                      type="date"
                      required={!isGroupClass}
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                    {isGroupClass ? (
                      <p className="mt-1 text-xs text-slate-500">
                        Leave this blank for an ongoing weekly class. Add a
                        final date for a limited weekly series.
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <label
                      htmlFor="startTime"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      Start Time
                    </label>
                    <input
                      id="startTime"
                      name="startTime"
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="endTime"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      End Time
                    </label>
                    <input
                      id="endTime"
                      name="endTime"
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                  </div>

                  {isGroupClass ? (
                    <div className="md:col-span-2 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
                      <p className="font-semibold">Group class schedule</p>
                      <p className="mt-1 leading-6">
                        Group classes meet weekly on the day of the first class
                        date. Use a final class date for a limited series, or
                        leave it blank for an ongoing weekly class.
                      </p>
                      {startDate ? (
                        <p className="mt-3 rounded-xl bg-white px-3 py-2 font-medium text-slate-800">
                          Preview: {groupClassDatePreview}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <div>
                    <label
                      htmlFor="venueName"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      Venue Name
                    </label>
                    <input
                      id="venueName"
                      name="venueName"
                      defaultValue={initialValues?.venueName ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                      placeholder={
                        isGroupClass
                          ? "Main Studio"
                          : "Studio / Hotel / Ballroom / Venue"
                      }
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="addressLine1"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      Address Line 1
                    </label>
                    <input
                      id="addressLine1"
                      name="addressLine1"
                      defaultValue={initialValues?.addressLine1 ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="addressLine2"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      Address Line 2
                    </label>
                    <input
                      id="addressLine2"
                      name="addressLine2"
                      defaultValue={initialValues?.addressLine2 ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="city"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      City
                    </label>
                    <input
                      id="city"
                      name="city"
                      defaultValue={initialValues?.city ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="state"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      State
                    </label>
                    <select
                      id="state"
                      name="state"
                      defaultValue={initialValues?.state ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    >
                      <option value="">Select state</option>
                      {US_STATE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="postalCode"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      Postal Code
                    </label>
                    <input
                      id="postalCode"
                      name="postalCode"
                      defaultValue={initialValues?.postalCode ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                  </div>
                </>
              ) : null}

              <div>
                <label
                  htmlFor="timezone"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Time Zone
                  <RequiredAsterisk />
                </label>
                <select
                  id="timezone"
                  name="timezone"
                  defaultValue={initialValues?.timezone ?? "America/New_York"}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  {TIMEZONE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {scheduleMode === "multi" ? (
                <div className="md:col-span-2 rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h4 className="text-base font-semibold text-indigo-950">
                        Multi-location Schedule Builder
                      </h4>
                      <p className="mt-1 text-sm leading-6 text-indigo-800">
                        Add each real location, then add the dates and times for
                        that location. Location 1 is the first event location;
                        it is not separate from the old venue fields.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={addEventLocation}
                      className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-indigo-900 shadow-sm ring-1 ring-indigo-200 hover:bg-indigo-100"
                    >
                      Add Location
                    </button>
                  </div>

                  <div className="mt-4 space-y-4">
                    {eventLocations.map((location, locationIndex) => (
                      <div
                        key={`event-location-${locationIndex}`}
                        className="rounded-2xl border border-indigo-200 bg-white p-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-slate-950">
                              Location {locationIndex + 1}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              Use names like Dublin January Series or Sunbury
                              April Series if that helps your staff.
                            </p>
                          </div>

                          {eventLocations.length > 1 ? (
                            <button
                              type="button"
                              onClick={() => removeEventLocation(locationIndex)}
                              className="rounded-xl border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                            >
                              Remove Location
                            </button>
                          ) : null}
                        </div>

                        <input
                          type="hidden"
                          name={`location_${locationIndex}_sortOrder`}
                          value={locationIndex}
                        />

                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Location Label
                              <RequiredAsterisk />
                            </label>
                            <input
                              name={`location_${locationIndex}_locationName`}
                              required
                              value={location.locationName}
                              onChange={(e) =>
                                updateLocationField(
                                  locationIndex,
                                  "locationName",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                              placeholder="Dublin series / Sunbury series"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Venue Name
                            </label>
                            <input
                              name={`location_${locationIndex}_venueName`}
                              value={location.venueName}
                              onChange={(e) =>
                                updateLocationField(
                                  locationIndex,
                                  "venueName",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                              placeholder="Studio / ballroom / venue"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Address Line 1
                            </label>
                            <input
                              name={`location_${locationIndex}_addressLine1`}
                              value={location.addressLine1}
                              onChange={(e) =>
                                updateLocationField(
                                  locationIndex,
                                  "addressLine1",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Address Line 2
                            </label>
                            <input
                              name={`location_${locationIndex}_addressLine2`}
                              value={location.addressLine2}
                              onChange={(e) =>
                                updateLocationField(
                                  locationIndex,
                                  "addressLine2",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              City
                            </label>
                            <input
                              name={`location_${locationIndex}_city`}
                              value={location.city}
                              onChange={(e) =>
                                updateLocationField(
                                  locationIndex,
                                  "city",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              State
                            </label>
                            <select
                              name={`location_${locationIndex}_state`}
                              value={location.state}
                              onChange={(e) =>
                                updateLocationField(
                                  locationIndex,
                                  "state",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                            >
                              <option value="">Select state</option>
                              {US_STATE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Postal Code
                            </label>
                            <input
                              name={`location_${locationIndex}_postalCode`}
                              value={location.postalCode}
                              onChange={(e) =>
                                updateLocationField(
                                  locationIndex,
                                  "postalCode",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Location Capacity
                            </label>
                            <input
                              name={`location_${locationIndex}_capacity`}
                              type="number"
                              min="0"
                              value={location.capacity}
                              onChange={(e) =>
                                updateLocationField(
                                  locationIndex,
                                  "capacity",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                              placeholder="Optional"
                            />
                          </div>
                        </div>

                        <div className="mt-5 space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-semibold text-slate-950">
                              Dates & Times
                            </p>
                            <button
                              type="button"
                              onClick={() => addLocationSession(locationIndex)}
                              className="rounded-xl border border-indigo-200 px-3 py-2 text-sm font-medium text-indigo-900 hover:bg-indigo-50"
                            >
                              Add Date/Time
                            </button>
                          </div>

                          {location.sessions.map((session, sessionIndex) => (
                            <div
                              key={`event-location-${locationIndex}-session-${sessionIndex}`}
                              className="rounded-xl border border-slate-200 bg-slate-50 p-3"
                            >
                              <input
                                type="hidden"
                                name={`location_${locationIndex}_session_${sessionIndex}_sortOrder`}
                                value={sessionIndex}
                              />

                              <div className="grid gap-3 md:grid-cols-2">
                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">
                                    Date
                                    <RequiredAsterisk />
                                  </label>
                                  <input
                                    name={`location_${locationIndex}_session_${sessionIndex}_date`}
                                    type="date"
                                    required
                                    value={session.sessionDate}
                                    onChange={(e) =>
                                      updateSessionField(
                                        locationIndex,
                                        sessionIndex,
                                        "sessionDate",
                                        e.target.value,
                                      )
                                    }
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                  />
                                </div>

                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">
                                    Series Label
                                  </label>
                                  <input
                                    name={`location_${locationIndex}_session_${sessionIndex}_seriesLabel`}
                                    value={session.seriesLabel}
                                    onChange={(e) =>
                                      updateSessionField(
                                        locationIndex,
                                        sessionIndex,
                                        "seriesLabel",
                                        e.target.value,
                                      )
                                    }
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                    placeholder="January series / April series"
                                  />
                                </div>

                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">
                                    Start Time
                                  </label>
                                  <input
                                    name={`location_${locationIndex}_session_${sessionIndex}_startTime`}
                                    type="time"
                                    value={session.startTime}
                                    onChange={(e) =>
                                      updateSessionField(
                                        locationIndex,
                                        sessionIndex,
                                        "startTime",
                                        e.target.value,
                                      )
                                    }
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                  />
                                </div>

                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">
                                    End Time
                                  </label>
                                  <input
                                    name={`location_${locationIndex}_session_${sessionIndex}_endTime`}
                                    type="time"
                                    value={session.endTime}
                                    onChange={(e) =>
                                      updateSessionField(
                                        locationIndex,
                                        sessionIndex,
                                        "endTime",
                                        e.target.value,
                                      )
                                    }
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                  />
                                </div>

                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">
                                    Session Label
                                  </label>
                                  <input
                                    name={`location_${locationIndex}_session_${sessionIndex}_label`}
                                    value={session.sessionLabel}
                                    onChange={(e) =>
                                      updateSessionField(
                                        locationIndex,
                                        sessionIndex,
                                        "sessionLabel",
                                        e.target.value,
                                      )
                                    }
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                    placeholder="Week 1 / Day 1 / Optional"
                                  />
                                </div>

                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">
                                    Session Capacity
                                  </label>
                                  <input
                                    name={`location_${locationIndex}_session_${sessionIndex}_capacity`}
                                    type="number"
                                    min="0"
                                    value={session.capacity}
                                    onChange={(e) =>
                                      updateSessionField(
                                        locationIndex,
                                        sessionIndex,
                                        "capacity",
                                        e.target.value,
                                      )
                                    }
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                    placeholder="Optional"
                                  />
                                </div>
                              </div>

                              {location.sessions.length > 1 ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    removeLocationSession(
                                      locationIndex,
                                      sessionIndex,
                                    )
                                  }
                                  className="mt-3 rounded-xl border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                                >
                                  Remove Date/Time
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-base font-semibold text-slate-950">
                      Optional Event Schedule
                    </h4>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      Add a public agenda for workshops, socials, competitions,
                      showcases, festivals, or multi-day events. Items are
                      grouped by date on the public event page.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={addEventScheduleItem}
                    className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-100"
                  >
                    Add Schedule Item
                  </button>
                </div>

                {eventScheduleItems.length === 0 ? (
                  <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-500">
                    No schedule items added. The public Event Schedule card will
                    stay hidden.
                  </p>
                ) : (
                  <div className="mt-4 space-y-4">
                    {eventScheduleItems.map((item, itemIndex) => (
                      <div
                        key={`event-schedule-item-${itemIndex}`}
                        className="rounded-2xl border border-slate-200 bg-white p-4"
                      >
                        <input
                          type="hidden"
                          name={`scheduleItem_${itemIndex}_sortOrder`}
                          value={itemIndex}
                        />

                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-slate-950">
                              Schedule Item {itemIndex + 1}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              Date, start time, and title are required when an
                              item is added.
                            </p>
                          </div>

                          <button
                            type="button"
                            onClick={() => removeEventScheduleItem(itemIndex)}
                            className="rounded-xl border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                          >
                            Remove Item
                          </button>
                        </div>

                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Schedule Date
                              <RequiredAsterisk />
                            </label>
                            <input
                              name={`scheduleItem_${itemIndex}_date`}
                              type="date"
                              required
                              value={item.scheduleDate}
                              onChange={(e) =>
                                updateEventScheduleItem(
                                  itemIndex,
                                  "scheduleDate",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Title
                              <RequiredAsterisk />
                            </label>
                            <input
                              name={`scheduleItem_${itemIndex}_title`}
                              required
                              value={item.title}
                              onChange={(e) =>
                                updateEventScheduleItem(
                                  itemIndex,
                                  "title",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                              placeholder="Beginner Salsa Class"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Start Time
                              <RequiredAsterisk />
                            </label>
                            <input
                              name={`scheduleItem_${itemIndex}_startTime`}
                              type="time"
                              required
                              value={item.startTime}
                              onChange={(e) =>
                                updateEventScheduleItem(
                                  itemIndex,
                                  "startTime",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              End Time
                            </label>
                            <input
                              name={`scheduleItem_${itemIndex}_endTime`}
                              type="time"
                              value={item.endTime}
                              onChange={(e) =>
                                updateEventScheduleItem(
                                  itemIndex,
                                  "endTime",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Presenter / Instructor
                            </label>
                            <input
                              name={`scheduleItem_${itemIndex}_presenterName`}
                              value={item.presenterName}
                              onChange={(e) =>
                                updateEventScheduleItem(
                                  itemIndex,
                                  "presenterName",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                              placeholder="Optional"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-sm font-medium">
                              Room / Location Label
                            </label>
                            <input
                              name={`scheduleItem_${itemIndex}_locationLabel`}
                              value={item.locationLabel}
                              onChange={(e) =>
                                updateEventScheduleItem(
                                  itemIndex,
                                  "locationLabel",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                              placeholder="Main Ballroom / Studio B / Optional"
                            />
                          </div>

                          <div className="md:col-span-2">
                            <label className="mb-1.5 block text-sm font-medium">
                              Description
                            </label>
                            <textarea
                              name={`scheduleItem_${itemIndex}_description`}
                              rows={3}
                              value={item.description}
                              onChange={(e) =>
                                updateEventScheduleItem(
                                  itemIndex,
                                  "description",
                                  e.target.value,
                                )
                              }
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                              placeholder="Optional details for this block."
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-base font-semibold text-slate-950">
                      Guest Coach Private Lessons
                    </h4>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      Optional. Add guest coaches and availability blocks. Slots are
                      generated from each block when the event is saved.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addGuestCoach}
                    className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-100"
                  >
                    Add Guest Coach
                  </button>
                </div>

                {guestCoaches.length === 0 ? (
                  <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                    No guest coach lesson slots added.
                  </p>
                ) : (
                  <div className="mt-5 space-y-5">
                    {guestCoaches.map((coach, coachIndex) => (
                      <div key={`guest-coach-${coachIndex}`} className="rounded-2xl border border-slate-200 bg-white p-4">
                        <input type="hidden" name={`guestCoach_${coachIndex}_id`} value={coach.id ?? ""} />
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Guest Coach {coachIndex + 1}
                            </p>
                            <h5 className="mt-1 text-base font-semibold text-slate-950">
                              {coach.name || "New Guest Coach"}
                            </h5>
                            {mode === "edit" && coach.scheduleToken ? (
                              <div className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-sm text-indigo-950">
                                <p className="font-semibold">Private coach schedule link</p>
                                <p className="mt-1 text-xs leading-5 text-indigo-800">
                                  Send this read-only link to the coach so they can see booked lessons for this event.
                                </p>
                                <Link
                                  href={`/coach-schedule/${coach.scheduleToken}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 inline-flex rounded-lg bg-white px-3 py-2 text-xs font-semibold text-indigo-800 shadow-sm ring-1 ring-indigo-100 hover:bg-indigo-100"
                                >
                                  Open coach schedule
                                </Link>
                              </div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={() => removeGuestCoach(coachIndex)}
                            className="rounded-xl border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                          >
                            Remove Coach
                          </button>
                        </div>

                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                          <div>
                            <label className="mb-1.5 block text-sm font-medium">Coach Name</label>
                            <input
                              name={`guestCoach_${coachIndex}_name`}
                              value={coach.name}
                              onChange={(e) => updateGuestCoach(coachIndex, "name", e.target.value)}
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                              placeholder="Guest coach name"
                            />
                          </div>
                          <div>
                            <label className="mb-1.5 block text-sm font-medium">Photo URL, optional</label>
                            <input
                              name={`guestCoach_${coachIndex}_photoUrl`}
                              value={coach.photoUrl}
                              onChange={(e) => updateGuestCoach(coachIndex, "photoUrl", e.target.value)}
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                              placeholder="https://..."
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="mb-1.5 block text-sm font-medium">Coach Bio, optional</label>
                            <textarea
                              name={`guestCoach_${coachIndex}_bio`}
                              value={coach.bio}
                              onChange={(e) => updateGuestCoach(coachIndex, "bio", e.target.value)}
                              rows={3}
                              className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                            />
                          </div>
                          <label className="flex items-center gap-3 rounded-xl border bg-slate-50 p-3 text-sm">
                            <input
                              type="checkbox"
                              name={`guestCoach_${coachIndex}_active`}
                              checked={coach.active}
                              onChange={(e) => updateGuestCoach(coachIndex, "active", e.target.checked)}
                            />
                            Active / visible
                          </label>
                        </div>

                        <div className="mt-5 space-y-4">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="text-sm font-semibold text-slate-900">Availability Blocks</p>
                              <p className="text-xs text-slate-500">Each block creates fixed purchasable lesson slots.</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => addGuestCoachBlock(coachIndex)}
                              className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                            >
                              Add Block
                            </button>
                          </div>

                          {coach.blocks.map((block, blockIndex) => (
                            <div key={`guest-coach-${coachIndex}-block-${blockIndex}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-semibold text-slate-900">Block {blockIndex + 1}</p>
                                <button
                                  type="button"
                                  onClick={() => removeGuestCoachBlock(coachIndex, blockIndex)}
                                  className="text-sm font-medium text-red-600 hover:text-red-700"
                                >
                                  Remove
                                </button>
                              </div>

                              <div className="mt-4 grid gap-4 md:grid-cols-3">
                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">Date</label>
                                  <input
                                    type="date"
                                    name={`guestCoach_${coachIndex}_block_${blockIndex}_lessonDate`}
                                    value={block.lessonDate}
                                    onChange={(e) => updateGuestCoachBlock(coachIndex, blockIndex, "lessonDate", e.target.value)}
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">Start Time</label>
                                  <input
                                    type="time"
                                    name={`guestCoach_${coachIndex}_block_${blockIndex}_startTime`}
                                    value={block.startTime}
                                    onChange={(e) => updateGuestCoachBlock(coachIndex, blockIndex, "startTime", e.target.value)}
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">End Time</label>
                                  <input
                                    type="time"
                                    name={`guestCoach_${coachIndex}_block_${blockIndex}_endTime`}
                                    value={block.endTime}
                                    onChange={(e) => updateGuestCoachBlock(coachIndex, blockIndex, "endTime", e.target.value)}
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">Lesson Length</label>
                                  <input
                                    type="number"
                                    min="5"
                                    step="5"
                                    name={`guestCoach_${coachIndex}_block_${blockIndex}_durationMinutes`}
                                    value={block.durationMinutes}
                                    onChange={(e) => updateGuestCoachBlock(coachIndex, blockIndex, "durationMinutes", e.target.value)}
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">Buffer Minutes</label>
                                  <input
                                    type="number"
                                    min="0"
                                    step="5"
                                    name={`guestCoach_${coachIndex}_block_${blockIndex}_bufferMinutes`}
                                    value={block.bufferMinutes}
                                    onChange={(e) => updateGuestCoachBlock(coachIndex, blockIndex, "bufferMinutes", e.target.value)}
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="mb-1.5 block text-sm font-medium">Price</label>
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    name={`guestCoach_${coachIndex}_block_${blockIndex}_price`}
                                    value={block.price}
                                    onChange={(e) => updateGuestCoachBlock(coachIndex, blockIndex, "price", e.target.value)}
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                    placeholder="150.00"
                                  />
                                </div>
                                <div className="md:col-span-3">
                                  <label className="mb-1.5 block text-sm font-medium">Room / Location Label, optional</label>
                                  <input
                                    name={`guestCoach_${coachIndex}_block_${blockIndex}_locationLabel`}
                                    value={block.locationLabel}
                                    onChange={(e) => updateGuestCoachBlock(coachIndex, blockIndex, "locationLabel", e.target.value)}
                                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                                    placeholder="Main Ballroom, Studio B, etc."
                                  />
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label
                  htmlFor="coverImageFile"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Cover Image Upload
                </label>
                <input
                  id="coverImageFile"
                  name="coverImageFile"
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp"
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Upload a JPG, PNG, or WEBP image. Recommended for the public
                  event page and discovery cards.
                </p>
              </div>

              <div>
                <label
                  htmlFor="coverImageUrl"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Cover Image URL
                </label>
                <input
                  id="coverImageUrl"
                  name="coverImageUrl"
                  defaultValue={initialValues?.coverImageUrl ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder="Optional fallback URL"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Optional advanced fallback. If you upload a file, the upload
                  will be used instead.
                </p>
              </div>

              <div>
                <label
                  htmlFor="capacity"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Capacity
                </label>
                <input
                  id="capacity"
                  name="capacity"
                  type="number"
                  min="0"
                  defaultValue={initialValues?.capacity ?? ""}
                  onChange={(e) => setCapacity(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={isGroupClass ? "20" : "Optional"}
                />
              </div>

              <div>
                <label
                  htmlFor="tags"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Tags
                </label>
                <input
                  id="tags"
                  name="tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={
                    isGroupClass
                      ? "group class, beginner, country, ballroom"
                      : "beginner, country, ballroom, members"
                  }
                />
                <p className="mt-1 text-xs text-slate-500">
                  Comma-separated tags for discovery and filtering.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
                Public Content
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Control the event copy shown on discovery cards and the public
                event page.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="shortDescription"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Public Summary
                </label>
                <textarea
                  id="shortDescription"
                  name="shortDescription"
                  rows={3}
                  defaultValue={initialValues?.shortDescription ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={
                    isGroupClass
                      ? "Short summary for the class card and public event directory."
                      : "Short summary for public event cards and discovery pages."
                  }
                />
              </div>

              <div>
                <label
                  htmlFor="description"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Public Description
                </label>
                <textarea
                  id="description"
                  name="description"
                  rows={6}
                  defaultValue={initialValues?.description ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={
                    isGroupClass
                      ? "Describe the class level, style, what students should expect, and any dress or partner requirements."
                      : "Full public event description, schedule notes, what to expect, and important details."
                  }
                />
              </div>

              <div>
                <label
                  htmlFor="refundPolicy"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Refund Policy
                </label>
                <textarea
                  id="refundPolicy"
                  name="refundPolicy"
                  rows={4}
                  defaultValue={initialValues?.refundPolicy ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder="Optional refund policy text."
                />
              </div>

              <div>
                <label
                  htmlFor="faq"
                  className="mb-1.5 block text-sm font-medium"
                >
                  FAQ
                </label>
                <textarea
                  id="faq"
                  name="faq"
                  rows={4}
                  defaultValue={initialValues?.faq ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder="Optional FAQ text."
                />
              </div>
            </div>
          </section>
        </div>

        <div className="space-y-5 xl:sticky xl:top-6">
          <section className="rounded-3xl border border-orange-200 bg-orange-50 p-4 shadow-sm md:p-6">
            <h3 className="text-lg font-semibold text-orange-900">
              Public Discovery
            </h3>
            <p className="mt-2 text-sm text-orange-800">
              Use these settings to control whether this event appears in the
              public dance directory.
            </p>

            <div className="mt-4 space-y-3">
              <label className="flex items-start gap-3 rounded-xl border border-orange-200 bg-white p-4">
                <input
                  type="checkbox"
                  name="publicDirectoryEnabled"
                  checked={publicDirectoryEnabled}
                  onChange={(e) => setPublicDirectoryEnabled(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">
                    Show in public dance directory
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Published/open events with this enabled can appear in public
                    event discovery.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border border-orange-200 bg-white p-4">
                <input
                  type="checkbox"
                  name="beginnerFriendly"
                  checked={beginnerFriendly}
                  onChange={(e) => setBeginnerFriendly(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">
                    Beginner-friendly
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Add a beginner-friendly badge in public event discovery.
                  </p>
                </div>
              </label>
            </div>
          </section>

          <section className="rounded-3xl border border-sky-200 bg-sky-50 p-4 shadow-sm md:p-6">
            <h3 className="text-lg font-semibold text-sky-900">
              Dance Category & Focus
            </h3>
            <p className="mt-2 text-sm text-sky-800">
              Choose the dance world first, then choose the specific dance or
              dances this class or event will focus on. This keeps a Ballroom
              class from accidentally being tagged as Country Two Step.
            </p>

            <div className="mt-5 space-y-5">
              <div>
                <p className="text-sm font-semibold text-sky-950">
                  Dance Category <RequiredAsterisk />
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {DANCE_CATEGORY_OPTIONS.map((category) => {
                    const selected = danceCategory === category.key;

                    return (
                      <label
                        key={category.key}
                        className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition ${
                          selected
                            ? "border-sky-500 bg-white shadow-sm"
                            : "border-sky-200 bg-white/80 hover:bg-white"
                        }`}
                      >
                        <input
                          type="radio"
                          name="danceCategory"
                          value={category.key}
                          checked={selected}
                          onChange={() =>
                            handleDanceCategoryChange(category.key)
                          }
                          className="mt-1 h-4 w-4"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-slate-900">
                            {category.label}
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-slate-600">
                            {category.helper}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-sky-950">
                      Dance Focus
                      <RequiredAsterisk />
                    </p>
                    <p className="mt-1 text-xs text-sky-800">
                      Showing options for {selectedDanceCategory.label}. Switch
                      the category above to choose a different dance family.
                    </p>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleDanceFocusOptions.map((style) => {
                    const checked = selectedStyleKeys.includes(style.key);

                    return (
                      <label
                        key={style.key}
                        className="flex items-center gap-3 rounded-xl border border-sky-200 bg-white p-3"
                      >
                        <input
                          type="checkbox"
                          value={style.key}
                          checked={checked}
                          onChange={(e) =>
                            toggleStyleKey(style.key, e.target.checked)
                          }
                          className="h-4 w-4"
                        />
                        <span className="text-sm font-medium text-slate-800">
                          {style.label}
                        </span>
                      </label>
                    );
                  })}
                </div>

                {selectedStyleKeys.length === 0 ? (
                  <p className="mt-3 rounded-xl border border-sky-200 bg-white/80 px-3 py-2 text-xs text-sky-800">
                    Pick at least one dance focus if you want this event to show
                    in style-based public discovery filters.
                  </p>
                ) : null}
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
              Registration & Access
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              Control enrollment behavior, waitlist access, and registration
              timing.
            </p>

            <div className="mt-4 space-y-3">
              <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  name="featured"
                  defaultChecked={initialValues?.featured ?? false}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">Featured event</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Featured events can be promoted higher in public listings
                    later.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  name="registrationRequired"
                  checked={registrationRequired}
                  onChange={(e) => setRegistrationRequired(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">
                    Registration required
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Turn this on for offerings that should manage enrollment,
                    roster, and attendance through event registration.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  name="accountRequiredForRegistration"
                  checked={accountRequiredForRegistration}
                  onChange={(e) =>
                    setAccountRequiredForRegistration(e.target.checked)
                  }
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">
                    Account required for registration
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Require a signed-in account before someone can register or
                    enroll.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  checked={waitlistEnabled}
                  onChange={(e) => setWaitlistEnabled(e.target.checked)}
                  disabled={!hasCapacity}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">Enable waitlist</p>
                  <p className="mt-1 text-sm text-slate-600">
                    When capacity is full, new registrants can join the waitlist
                    instead of being blocked.
                  </p>
                  {!hasCapacity ? (
                    <p className="mt-2 text-xs text-slate-500">
                      Add a capacity limit to use waitlist mode.
                    </p>
                  ) : null}
                </div>
              </label>
            </div>

            <div className="mt-4 grid gap-4">
              <div>
                <label
                  htmlFor="registrationOpensAt"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Registration Opens At
                </label>
                <input
                  id="registrationOpensAt"
                  name="registrationOpensAt"
                  type="datetime-local"
                  defaultValue={
                    initialValues?.registrationOpensAt ??
                    getLocalDateTimeInputValue()
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>

              <div>
                <label
                  htmlFor="registrationClosesAt"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Registration Closes At
                </label>
                <input
                  id="registrationClosesAt"
                  name="registrationClosesAt"
                  type="datetime-local"
                  defaultValue={initialValues?.registrationClosesAt ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                />
              </div>
            </div>
          </section>

          {isGroupClass ? (
            <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <p className="font-medium">Group class publishing model</p>
              <ul className="mt-2 space-y-1 text-blue-800">
                <li>
                  • Public classes can appear in offerings and event discovery.
                </li>
                <li>
                  • Unlisted classes stay hidden from listings but can be shared
                  directly.
                </li>
                <li>
                  • Private classes are internal or invite-only and not shown
                  publicly.
                </li>
              </ul>
            </div>
          ) : null}

          {publicDirectoryEnabled ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-medium">Public directory enabled</p>
              <p className="mt-2 text-emerald-800">
                This event will be eligible for the public dance directory when
                saved with a public host, published/open status, and public
                discovery enabled.
              </p>
            </div>
          ) : null}

          {waitlistEnabled ? (
            <div className="rounded-2xl border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900">
              <p className="font-medium">Waitlist is enabled</p>
              <p className="mt-2 text-purple-800">
                When this event sells out, new registrants will be added to the
                waitlist and will not be charged until staff promotes them.
              </p>
            </div>
          ) : null}

          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending
                ? mode === "edit"
                  ? "Saving event..."
                  : "Creating event..."
                : mode === "edit"
                  ? "Save Event Changes"
                  : "Create Event"}
            </button>

            <p className="mt-3 text-center text-xs leading-5 text-slate-500">
              You can save as a draft first, then publish when the event details
              are ready.
            </p>
          </section>
        </div>
      </div>
    </form>
  );
}








