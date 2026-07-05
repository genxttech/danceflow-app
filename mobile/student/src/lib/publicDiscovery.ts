import { supabase } from "@/lib/supabase";

function danceFlowWebUrl() {
  return (process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL ?? "https://idanceflow.com").replace(/\/$/, "");
}

export type FavoriteTargetType = "studio" | "event" | "partner_profile";

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

  const idColumn =
    targetType === "studio"
      ? "studio_id"
      : targetType === "event"
        ? "event_id"
        : "partner_profile_id";

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

  const { error: insertError } = await supabase.from("user_favorites").insert({
    user_id: userId,
    target_type: targetType,
    ...(targetType === "studio"
      ? { studio_id: targetId }
      : targetType === "event"
        ? { event_id: targetId }
        : { partner_profile_id: targetId })
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

export type PublicEventTicketType = {
  id: string;
  name: string;
  description: string | null;
  ticketKind: string;
  price: number;
  regularPrice: number;
  currency: string;
  capacity: number | null;
  remainingAdmissionSpots: number | null;
  active: boolean;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  isEarlyBird: boolean;
  earlyBirdEndsAt: string | null;
  attendeesPerTicket: number;
};

export type PublicEventDocumentRequirement = {
  id: string;
  title: string;
  description: string | null;
  body: string;
  requiresSignature: boolean;
};

export type PublicPartnerProfileItem = {
  id: string;
  displayName: string;
  headline: string | null;
  bio: string | null;
  location: string;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  leadFollowRole: string;
  danceStyles: string[];
  skillLevel: string;
  goals: string[];
  listingIntent: string;
  availabilityNotes: string | null;
  favorited: boolean;
  webUrl: string;
};

export type PublicJobPostingItem = {
  id: string;
  studioId: string;
  studioName: string;
  studioSlug: string | null;
  title: string;
  roleType: string;
  employmentType: string;
  locationType: string;
  location: string;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  compensationSummary: string | null;
  danceStyles: string[];
  requirements: string | null;
  description: string | null;
  applyUrl: string | null;
  applyEmail: string | null;
  applyPhone: string | null;
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
  account_required_for_registration?: boolean | null;
  registration_opens_at?: string | null;
  registration_closes_at?: string | null;
  capacity?: number | null;
  waitlist_enabled?: boolean | null;
  beginner_friendly: boolean | null;
  public_directory_enabled: boolean | null;
  registration_required: boolean | null;
  latitude: number | null;
  longitude: number | null;
};

type TicketTypeRow = {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  ticket_kind: string | null;
  price: number | null;
  currency: string | null;
  capacity: number | null;
  active: boolean | null;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  early_bird_enabled: boolean | null;
  early_bird_price: number | null;
  early_bird_ends_at: string | null;
  attendees_per_ticket: number | null;
  sort_order?: number | null;
};

type TicketCapacityRegistrationRow = {
  ticket_type_id: string | null;
  quantity: number | null;
  event_ticket_types?: { attendees_per_ticket: number | null } | { attendees_per_ticket: number | null }[] | null;
};

function activeTicketPrice(ticket: TicketTypeRow) {
  const regularPrice = Number(ticket.price ?? 0);
  const earlyBirdPrice =
    ticket.early_bird_price === null || ticket.early_bird_price === undefined
      ? null
      : Number(ticket.early_bird_price);
  const earlyBirdEndsAt = ticket.early_bird_ends_at
    ? new Date(ticket.early_bird_ends_at).getTime()
    : null;

  if (
    ticket.early_bird_enabled &&
    earlyBirdPrice !== null &&
    Number.isFinite(earlyBirdPrice) &&
    earlyBirdPrice >= 0 &&
    earlyBirdEndsAt !== null &&
    earlyBirdEndsAt >= Date.now()
  ) {
    return {
      price: earlyBirdPrice,
      regularPrice,
      isEarlyBird: true,
      earlyBirdEndsAt: ticket.early_bird_ends_at
    };
  }

  return {
    price: regularPrice,
    regularPrice,
    isEarlyBird: false,
    earlyBirdEndsAt: ticket.early_bird_ends_at
  };
}

function admissionCountFor(row: TicketCapacityRegistrationRow) {
  const ticketType = firstJoin(row.event_ticket_types);
  const admitsPerTicket = Math.max(1, Number(ticketType?.attendees_per_ticket ?? 1) || 1);
  return Math.max(1, Number(row.quantity ?? 1) || 1) * admitsPerTicket;
}

async function loadTicketAdmissionCounts(ticketTypeIds: string[]) {
  if (!ticketTypeIds.length) return new Map<string, number>();

  const [confirmedResult, heldResult] = await Promise.all([
    supabase
      .from("event_registrations")
      .select("ticket_type_id, quantity, event_ticket_types ( attendees_per_ticket )")
      .in("ticket_type_id", ticketTypeIds)
      .or("payment_status.eq.paid,status.in.(confirmed,checked_in,attended)"),
    supabase
      .from("event_registrations")
      .select(
        `
        ticket_type_id,
        quantity,
        event_ticket_types (
          attendees_per_ticket
        ),
        event_orders!inner (
          status,
          payment_status,
          expires_at
        )
      `
      )
      .in("ticket_type_id", ticketTypeIds)
      .eq("status", "pending")
      .eq("payment_status", "pending")
      .eq("event_orders.status", "pending")
      .eq("event_orders.payment_status", "pending")
      .gt("event_orders.expires_at", new Date().toISOString())
  ]);

  if (confirmedResult.error) throw confirmedResult.error;
  if (heldResult.error) throw heldResult.error;

  const counts = new Map<string, number>();
  for (const row of [
    ...((confirmedResult.data ?? []) as TicketCapacityRegistrationRow[]),
    ...((heldResult.data ?? []) as TicketCapacityRegistrationRow[])
  ]) {
    if (!row.ticket_type_id) continue;
    counts.set(row.ticket_type_id, (counts.get(row.ticket_type_id) ?? 0) + admissionCountFor(row));
  }

  return counts;
}

function remainingAdmissionSpotsFor(ticket: TicketTypeRow, reservedAdmissionCount: number) {
  if (ticket.capacity == null) return null;
  return Math.max(0, Number(ticket.capacity) - reservedAdmissionCount);
}

type EventDocumentRequirementRow = {
  id: string;
  template_id: string;
  template_version_id: string | null;
  document_templates:
    | {
        title: string | null;
        description: string | null;
        body: string | null;
        requires_signature: boolean | null;
        is_active: boolean | null;
      }
    | {
        title: string | null;
        description: string | null;
        body: string | null;
        requires_signature: boolean | null;
        is_active: boolean | null;
      }[]
    | null;
  document_template_versions:
    | {
        title: string | null;
        description: string | null;
        body: string | null;
        requires_signature: boolean | null;
      }
    | {
        title: string | null;
        description: string | null;
        body: string | null;
        requires_signature: boolean | null;
      }[]
    | null;
};

type PartnerProfileRow = {
  id: string;
  display_name: string;
  headline: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  lead_follow_role: string;
  dance_styles: string[] | null;
  skill_level: string;
  goals: string[] | null;
  listing_intent: string | null;
  availability_notes: string | null;
};

type JobPostingRow = {
  id: string;
  studio_id: string;
  title: string;
  role_type: string;
  employment_type: string;
  location_type: string;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  compensation_summary: string | null;
  dance_styles: string[] | null;
  requirements: string | null;
  description: string | null;
  apply_url: string | null;
  apply_email: string | null;
  apply_phone: string | null;
  studios:
    | {
        slug: string | null;
        public_name: string | null;
        name: string;
      }
    | {
        slug: string | null;
        public_name: string | null;
        name: string;
      }[]
    | null;
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

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
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
  accountRequiredForRegistration: boolean;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  capacity: number | null;
  waitlistEnabled: boolean;
  registerUrl: string;
  ticketTypes: PublicEventTicketType[];
  requiredDocuments: PublicEventDocumentRequirement[];
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
  const [events, eventResult, ticketsResult, documentsResult] = await Promise.all([
    getPublicEventsForMobile(userId),
    supabase
      .from("events")
      .select(
        "id, account_required_for_registration, registration_opens_at, registration_closes_at, capacity, waitlist_enabled"
      )
      .eq("id", eventId)
      .maybeSingle(),
    supabase
      .from("event_ticket_types")
      .select(
        "id, event_id, name, description, ticket_kind, price, currency, capacity, active, sale_starts_at, sale_ends_at, early_bird_enabled, early_bird_price, early_bird_ends_at, attendees_per_ticket, sort_order"
      )
      .eq("event_id", eventId)
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("event_document_requirements")
      .select(
        `
        id,
        template_id,
        template_version_id,
        document_templates:template_id (
          title,
          description,
          body,
          requires_signature,
          is_active
        ),
        document_template_versions:template_version_id (
          title,
          description,
          body,
          requires_signature
        )
      `
      )
      .eq("event_id", eventId)
      .eq("active", true)
      .eq("is_required", true)
  ]);

  if (eventResult.error) throw eventResult.error;
  if (ticketsResult.error) throw ticketsResult.error;
  if (documentsResult.error) throw documentsResult.error;

  const event = events.find((item) => item.id === eventId);
  const eventRow = eventResult.data as Pick<
    EventRow,
    | "account_required_for_registration"
    | "registration_opens_at"
    | "registration_closes_at"
    | "capacity"
    | "waitlist_enabled"
  > | null;

  if (!event || !eventRow) return null;

  const ticketRows = (ticketsResult.data ?? []) as TicketTypeRow[];
  const admissionCounts = await loadTicketAdmissionCounts(ticketRows.map((ticket) => ticket.id));

  const ticketTypes = ticketRows.map((ticket) => {
    const activePrice = activeTicketPrice(ticket);

    return {
      id: ticket.id,
      name: ticket.name,
      description: ticket.description,
      ticketKind: ticket.ticket_kind ?? "general",
      price: activePrice.price,
      regularPrice: activePrice.regularPrice,
      currency: ticket.currency ?? "USD",
      capacity: ticket.capacity,
      remainingAdmissionSpots: remainingAdmissionSpotsFor(ticket, admissionCounts.get(ticket.id) ?? 0),
      active: ticket.active === true,
      saleStartsAt: ticket.sale_starts_at,
      saleEndsAt: ticket.sale_ends_at,
      isEarlyBird: activePrice.isEarlyBird,
      earlyBirdEndsAt: activePrice.earlyBirdEndsAt,
      attendeesPerTicket: Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1)
    };
  });

  const requiredDocuments = ((documentsResult.data ?? []) as EventDocumentRequirementRow[])
    .map((requirement) => {
      const template = firstJoin(requirement.document_templates);
      const version = firstJoin(requirement.document_template_versions);

      if (template?.is_active === false) return null;

      return {
        id: requirement.id,
        title: version?.title ?? template?.title ?? "Required document",
        description: version?.description ?? template?.description ?? null,
        body: version?.body ?? template?.body ?? "",
        requiresSignature: Boolean(version?.requires_signature ?? template?.requires_signature ?? true)
      };
    })
    .filter((document): document is PublicEventDocumentRequirement => Boolean(document));

  return {
    ...event,
    accountRequiredForRegistration: eventRow.account_required_for_registration === true,
    registrationOpensAt: eventRow.registration_opens_at ?? null,
    registrationClosesAt: eventRow.registration_closes_at ?? null,
    capacity: eventRow.capacity ?? null,
    waitlistEnabled: eventRow.waitlist_enabled === true,
    ticketTypes,
    requiredDocuments,
    registerUrl: `${danceFlowWebUrl()}/events/${event.slug}/register`
  };
}

export async function getPublicPartnerProfilesForMobile(userId?: string | null) {
  const { data, error } = await supabase
    .from("dancer_partner_profiles")
    .select(
      "id, display_name, headline, bio, city, state, latitude, longitude, lead_follow_role, dance_styles, skill_level, goals, listing_intent, availability_notes"
    )
    .eq("visibility", "published")
    .eq("moderation_status", "approved")
    .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
    .order("published_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  const rows = (data ?? []) as PartnerProfileRow[];
  const favoriteIds = new Set<string>();

  if (userId && rows.length) {
    const { data: favorites, error: favoritesError } = await supabase
      .from("user_favorites")
      .select("partner_profile_id")
      .eq("user_id", userId)
      .eq("target_type", "partner_profile")
      .in(
        "partner_profile_id",
        rows.map((profile) => profile.id)
      );

    if (favoritesError) throw favoritesError;

    for (const favorite of favorites ?? []) {
      if (favorite.partner_profile_id) favoriteIds.add(favorite.partner_profile_id);
    }
  }

  return rows.map<PublicPartnerProfileItem>((profile) => ({
    id: profile.id,
    displayName: profile.display_name,
    headline: profile.headline,
    bio: profile.bio,
    location: locationLabel(profile),
    city: profile.city,
    state: profile.state,
    latitude: profile.latitude,
    longitude: profile.longitude,
    leadFollowRole: profile.lead_follow_role,
    danceStyles: profile.dance_styles ?? [],
    skillLevel: profile.skill_level,
    goals: profile.goals ?? [],
    listingIntent: profile.listing_intent ?? "practice",
    availabilityNotes: profile.availability_notes,
    favorited: favoriteIds.has(profile.id),
    webUrl: `${danceFlowWebUrl()}/discover/partners`
  }));
}

export async function getPublicJobPostingsForMobile() {
  const { data, error } = await supabase
    .from("studio_job_postings")
    .select(
      `
      id,
      studio_id,
      title,
      role_type,
      employment_type,
      location_type,
      city,
      state,
      latitude,
      longitude,
      compensation_summary,
      dance_styles,
      requirements,
      description,
      apply_url,
      apply_email,
      apply_phone,
      studios (
        slug,
        public_name,
        name
      )
    `
    )
    .eq("status", "published")
    .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
    .order("published_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return ((data ?? []) as JobPostingRow[]).map<PublicJobPostingItem>((posting) => {
    const studio = firstJoin(posting.studios);
    const location =
      posting.location_type === "remote"
        ? "Remote"
        : [posting.city, posting.state].filter(Boolean).join(", ") || "Location coming soon";

    return {
      id: posting.id,
      studioId: posting.studio_id,
      studioName: studio?.public_name?.trim() || studio?.name || "Dance studio",
      studioSlug: studio?.slug ?? null,
      title: posting.title,
      roleType: posting.role_type,
      employmentType: posting.employment_type,
      locationType: posting.location_type,
      location,
      city: posting.city,
      state: posting.state,
      latitude: posting.latitude,
      longitude: posting.longitude,
      compensationSummary: posting.compensation_summary,
      danceStyles: posting.dance_styles ?? [],
      requirements: posting.requirements,
      description: posting.description,
      applyUrl: posting.apply_url,
      applyEmail: posting.apply_email,
      applyPhone: posting.apply_phone,
      webUrl: `${danceFlowWebUrl()}/discover/jobs`
    };
  });
}
