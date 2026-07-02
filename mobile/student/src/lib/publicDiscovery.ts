import { supabase } from "@/lib/supabase";

function danceFlowWebUrl() {
  return (process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL ?? "https://idanceflow.com").replace(/\/$/, "");
}

export type FavoriteTargetType = "studio" | "event";

export async function setPublicFavoriteForMobile({
  favorited,
  targetId,
  targetType,
  userId
}: {
  favorited: boolean;
  targetId: string;
  targetType: FavoriteTargetType;
  userId?: string | null;
}) {
  if (!userId) {
    throw new Error("Sign in to save favorites.");
  }

  const idColumn = targetType === "studio" ? "studio_id" : "event_id";

  const deleteQuery = supabase
    .from("user_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("target_type", targetType)
    .eq(idColumn, targetId);

  const { error: deleteError } = await deleteQuery;

  if (deleteError) {
    throw deleteError;
  }

  if (!favorited) {
    return false;
  }

  if (targetType === "studio") {
    const { error: insertError } = await supabase.from("user_favorites").insert({
      user_id: userId,
      target_type: "studio",
      studio_id: targetId
    });

    if (insertError) {
      throw insertError;
    }

    return true;
  }

  const { error: insertError } = await supabase.from("user_favorites").insert({
    user_id: userId,
    target_type: "event",
    event_id: targetId
  });

  if (insertError) {
    throw insertError;
  }

  return true;
}

export type PublicStudioItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  location: string;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  beginnerFriendly: boolean;
  favorited: boolean;
  webUrl: string;
};

export type PublicEventItem = {
  id: string;
  slug: string;
  name: string;
  hostName: string;
  schedule: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  summary: string | null;
  beginnerFriendly: boolean;
  registrationRequired: boolean;
  favorited: boolean;
  webUrl: string;
};

type StudioRow = {
  id: string;
  slug: string | null;
  public_name: string | null;
  name: string;
  public_short_description: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  beginner_friendly: boolean | null;
  public_directory_enabled: boolean | null;
  billing_plan: string | null;
  subscription_status: string | null;
};

type EventRow = {
  id: string;
  slug: string | null;
  studio_id: string | null;
  organizer_id: string | null;
  name: string;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  visibility: string | null;
  status: string | null;
  public_summary: string | null;
  public_description: string | null;
  beginner_friendly: boolean | null;
  public_directory_enabled: boolean | null;
  registration_required: boolean | null;
  latitude: number | null;
  longitude: number | null;
};

type OrganizerRow = {
  id: string;
  name: string;
  active: boolean | null;
};

type EventLocationRow = {
  event_id: string;
  location_name: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  sort_order: number | null;
};

function hasActivePublicAccess(studio: {
  subscription_status?: string | null;
}) {
  const status = (studio.subscription_status ?? "").trim().toLowerCase();
  return status === "active" || status === "trialing";
}

function studioTitle(studio: StudioRow) {
  return studio.public_name?.trim() || studio.name;
}

function locationLabel(value: {
  city?: string | null;
  state?: string | null;
  venue_name?: string | null;
  location_name?: string | null;
}) {
  const venue = value.venue_name?.trim() || value.location_name?.trim();
  const cityState = [value.city, value.state].filter(Boolean).join(", ");
  if (venue && cityState) return `${venue} · ${cityState}`;
  return venue || cityState || "Location coming soon";
}

function formatDate(value: string | null) {
  if (!value) return "Date coming soon";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(`${value}T00:00:00`));
}

function formatDateRange(startDate: string | null, endDate: string | null) {
  if (!startDate) return "Date coming soon";
  if (!endDate || endDate === startDate) return formatDate(startDate);
  return `${formatDate(startDate)} - ${formatDate(endDate)}`;
}

function formatTime(value: string | null) {
  if (!value) return "";
  const date = new Date(`2000-01-01T${value}`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatSchedule(event: EventRow) {
  const dateRange = formatDateRange(event.start_date, event.end_date);
  const start = formatTime(event.start_time);
  const end = formatTime(event.end_time);
  const timeRange = start && end ? `${start} - ${end}` : start || end;
  return [dateRange, timeRange].filter(Boolean).join(" · ");
}

export async function getPublicStudiosForMobile(userId?: string | null) {
  const { data, error } = await supabase
    .from("studios")
    .select(
      "id, slug, public_name, name, public_short_description, city, state, latitude, longitude, beginner_friendly, public_directory_enabled, billing_plan, subscription_status"
    )
    .eq("public_directory_enabled", true)
    .order("public_name", { ascending: true })
    .limit(100);

  if (error) throw error;

  const rows = ((data ?? []) as StudioRow[]).filter(
    (studio) => studio.slug && hasActivePublicAccess(studio)
  );

  const favoriteIds = new Set<string>();

  if (userId && rows.length) {
    const { data: favorites, error: favoritesError } = await supabase
      .from("user_favorites")
      .select("studio_id")
      .eq("user_id", userId)
      .eq("target_type", "studio")
      .in(
        "studio_id",
        rows.map((studio) => studio.id)
      );

    if (favoritesError) throw favoritesError;

    for (const favorite of favorites ?? []) {
      if (favorite.studio_id) favoriteIds.add(favorite.studio_id);
    }
  }

  return rows.map<PublicStudioItem>((studio) => ({
    id: studio.id,
    slug: studio.slug!,
    name: studioTitle(studio),
    description: studio.public_short_description,
    location: locationLabel(studio),
    city: studio.city,
    state: studio.state,
    latitude: studio.latitude,
    longitude: studio.longitude,
    beginnerFriendly: studio.beginner_friendly === true,
    favorited: favoriteIds.has(studio.id),
    webUrl: `${danceFlowWebUrl()}/studios/${studio.slug}`
  }));
}

export async function getPublicEventsForMobile(userId?: string | null) {
  const [
    { data: events, error: eventsError },
    { data: studios, error: studiosError },
    { data: organizers, error: organizersError },
    { data: locations, error: locationsError }
  ] = await Promise.all([
    supabase
      .from("events")
      .select(
        "id, slug, studio_id, organizer_id, name, start_date, end_date, start_time, end_time, visibility, status, public_summary, public_description, beginner_friendly, public_directory_enabled, registration_required, latitude, longitude"
      )
      .eq("visibility", "public")
      .eq("public_directory_enabled", true)
      .in("status", ["published", "open"])
      .order("start_date", { ascending: true })
      .limit(100),
    supabase
      .from("studios")
      .select(
        "id, slug, public_name, name, public_short_description, city, state, latitude, longitude, beginner_friendly, public_directory_enabled, billing_plan, subscription_status"
      ),
    supabase.from("organizers").select("id, name, active").eq("active", true),
    supabase
      .from("event_locations")
      .select("event_id, location_name, venue_name, city, state, latitude, longitude, sort_order")
      .order("sort_order", { ascending: true })
  ]);

  if (eventsError) throw eventsError;
  if (studiosError) throw studiosError;
  if (organizersError) throw organizersError;
  if (locationsError) throw locationsError;

  const studioById = new Map(
    ((studios ?? []) as StudioRow[])
      .filter((studio) => studio.public_directory_enabled && hasActivePublicAccess(studio))
      .map((studio) => [studio.id, studio])
  );
  const organizerById = new Map(
    ((organizers ?? []) as OrganizerRow[])
      .filter((organizer) => organizer.active)
      .map((organizer) => [organizer.id, organizer])
  );
  const locationsByEventId = new Map<string, EventLocationRow[]>();

  for (const location of (locations ?? []) as EventLocationRow[]) {
    const current = locationsByEventId.get(location.event_id) ?? [];
    current.push(location);
    locationsByEventId.set(location.event_id, current);
  }

  const rows = ((events ?? []) as EventRow[]).filter((event) => {
    if (!event.slug || !event.public_directory_enabled) return false;
    if (!event.studio_id || !studioById.has(event.studio_id)) return false;
    if (event.organizer_id && !organizerById.has(event.organizer_id)) return false;
    return true;
  });

  const favoriteIds = new Set<string>();

  if (userId && rows.length) {
    const { data: favorites, error: favoritesError } = await supabase
      .from("user_favorites")
      .select("event_id")
      .eq("user_id", userId)
      .eq("target_type", "event")
      .in(
        "event_id",
        rows.map((event) => event.id)
      );

    if (favoritesError) throw favoritesError;

    for (const favorite of favorites ?? []) {
      if (favorite.event_id) favoriteIds.add(favorite.event_id);
    }
  }

  return rows.map<PublicEventItem>((event) => {
    const studio = event.studio_id ? studioById.get(event.studio_id) : null;
    const organizer = event.organizer_id ? organizerById.get(event.organizer_id) : null;
    const firstLocation = locationsByEventId.get(event.id)?.[0] ?? null;
    const latitude = event.latitude ?? firstLocation?.latitude ?? studio?.latitude ?? null;
    const longitude = event.longitude ?? firstLocation?.longitude ?? studio?.longitude ?? null;

    return {
      id: event.id,
      slug: event.slug!,
      name: event.name,
      hostName: organizer?.name || (studio ? studioTitle(studio) : "DanceFlow event"),
      schedule: formatSchedule(event),
      location: firstLocation ? locationLabel(firstLocation) : locationLabel(studio ?? {}),
      latitude,
      longitude,
      summary: event.public_summary || event.public_description,
      beginnerFriendly: event.beginner_friendly === true,
      registrationRequired: event.registration_required === true,
      favorited: favoriteIds.has(event.id),
      webUrl: `${danceFlowWebUrl()}/events/${event.slug}`
    };
  });
}

export type PublicStudioDetail = PublicStudioItem & {
  upcomingEvents: PublicEventItem[];
};

export type PublicEventDetail = PublicEventItem & {
  registerUrl: string;
};

export async function getPublicStudioDetailForMobile(
  studioId: string,
  userId?: string | null
): Promise<PublicStudioDetail | null> {
  const [studios, events] = await Promise.all([
    getPublicStudiosForMobile(userId),
    getPublicEventsForMobile(userId)
  ]);

  const studio = studios.find((item) => item.id === studioId);
  if (!studio) return null;

  const upcomingEvents = events
    .filter((event) => event.hostName === studio.name || event.location.includes(studio.city ?? "__none__"))
    .slice(0, 10);

  return {
    ...studio,
    upcomingEvents
  };
}

export async function getPublicEventDetailForMobile(
  eventId: string,
  userId?: string | null
): Promise<PublicEventDetail | null> {
  const events = await getPublicEventsForMobile(userId);
  const event = events.find((item) => item.id === eventId);
  if (!event) return null;

  return {
    ...event,
    registerUrl: `${danceFlowWebUrl()}/events/${event.slug}/register`
  };
}
