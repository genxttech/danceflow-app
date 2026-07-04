import { createClient } from "@/lib/supabase/server";

export type PartnerSearchProfile = {
  id: string;
  displayName: string;
  headline: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  location: string;
  leadFollowRole: string;
  danceStyles: string[];
  skillLevel: string;
  goals: string[];
  listingIntent: string;
  availabilityNotes: string | null;
  publishedAt: string | null;
};

type PartnerSearchProfileRow = {
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
  published_at: string | null;
};

function locationLabel(city: string | null, state: string | null) {
  return [city, state].filter(Boolean).join(", ") || "Location flexible";
}

function normalizeLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatPartnerRole(value: string) {
  if (value === "lead") return "Lead";
  if (value === "follow") return "Follow";
  if (value === "switch") return "Switch";
  if (value === "either") return "Lead or Follow";
  return normalizeLabel(value);
}

export function formatPartnerSkill(value: string) {
  return normalizeLabel(value);
}

export function formatPartnerIntent(value: string) {
  if (value === "practice") return "Practice Partner";
  if (value === "social") return "Social Dance Partner";
  if (value === "showcase") return "Showcase Partner";
  if (value === "competition") return "Competition Partner";
  return normalizeLabel(value);
}

export type PartnerSearchFilters = {
  intent?: string | string[];
  latitude?: number | null;
  longitude?: number | null;
  query?: string;
  radiusMiles?: number;
  role?: string;
  skill?: string;
  style?: string | string[];
};

const danceStyleGroups = [
  {
    label: "American Smooth",
    styles: ["Waltz", "Tango", "Foxtrot", "Viennese Waltz"],
  },
  {
    label: "American Rhythm",
    styles: ["Cha Cha", "Rumba", "East Coast Swing", "Bolero", "Mambo"],
  },
  {
    label: "International Ballroom",
    styles: ["Waltz", "Tango", "Viennese Waltz", "Foxtrot", "Quickstep"],
  },
  {
    label: "International Latin",
    styles: ["Cha Cha", "Samba", "Rumba", "Paso Doble", "Jive"],
  },
  {
    label: "Country",
    styles: [
      "Country Two Step",
      "West Coast Swing",
      "East Coast Swing",
      "Nightclub Two Step",
      "Country Waltz",
      "Polka",
    ],
  },
  {
    label: "Social / Club",
    styles: ["Salsa", "Bachata", "Argentine Tango", "Hustle", "Lindy Hop", "Zouk", "Kizomba"],
  },
];

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function styleFilterOptions(style: string | string[] | null | undefined) {
  const selectedStyles = Array.isArray(style) ? style : style ? [style] : [];
  const expanded = new Set<string>();

  selectedStyles.forEach((selectedStyle) => {
    const normalizedStyle = normalize(selectedStyle);

    if (!normalizedStyle) {
      return;
    }

    const group = danceStyleGroups.find(
      (item) => normalize(item.label) === normalizedStyle,
    );

    if (group) {
      expanded.add(group.label);
      group.styles.forEach((groupStyle) => expanded.add(groupStyle));
      return;
    }

    expanded.add(selectedStyle);
  });

  return Array.from(expanded);
}

function filterOptions(value: string | string[] | null | undefined) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function milesBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const earthRadiusMiles = 3958.8;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(h));
}

export async function getPublishedPartnerProfiles(filters: PartnerSearchFilters = {}) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("dancer_partner_profiles")
    .select(
      "id, display_name, headline, bio, city, state, latitude, longitude, lead_follow_role, dance_styles, skill_level, goals, listing_intent, availability_notes, published_at",
    )
    .eq("visibility", "published")
    .eq("moderation_status", "approved")
    .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
    .order("published_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`Failed to load partner profiles: ${error.message}`);
  }

  const profiles = ((data ?? []) as PartnerSearchProfileRow[]).map<PartnerSearchProfile>(
    (row) => ({
      id: row.id,
      displayName: row.display_name,
      headline: row.headline,
      bio: row.bio,
      city: row.city,
      state: row.state,
      latitude: row.latitude,
      longitude: row.longitude,
      location: locationLabel(row.city, row.state),
      leadFollowRole: row.lead_follow_role,
      danceStyles: row.dance_styles ?? [],
      skillLevel: row.skill_level,
      goals: row.goals ?? [],
      listingIntent: row.listing_intent ?? "practice",
      availabilityNotes: row.availability_notes,
      publishedAt: row.published_at,
    }),
  );

  return profiles.filter((profile) => {
    const search = normalize(filters.query);
    const styleOptions = styleFilterOptions(filters.style);
    const intentOptions = filterOptions(filters.intent);
    const matchesSearch =
      !search ||
      [
        profile.displayName,
        profile.headline,
        profile.bio,
        profile.location,
        profile.leadFollowRole,
        profile.skillLevel,
        profile.listingIntent,
        ...profile.danceStyles,
        ...profile.goals,
      ].some((value) => normalize(value).includes(search));

    const matchesDistance =
      filters.latitude === undefined ||
      filters.latitude === null ||
      filters.longitude === undefined ||
      filters.longitude === null ||
      (profile.latitude !== null &&
        profile.longitude !== null &&
        milesBetween(
          { latitude: filters.latitude, longitude: filters.longitude },
          { latitude: profile.latitude, longitude: profile.longitude },
        ) <= (filters.radiusMiles ?? 50));

    return (
      matchesSearch &&
      (!filters.role || profile.leadFollowRole === filters.role) &&
      (!filters.skill || profile.skillLevel === filters.skill) &&
      (intentOptions.length === 0 ||
        intentOptions.some((intent) => {
          const normalizedIntent = normalize(intent);
          return (
            normalize(profile.listingIntent) === normalizedIntent ||
            profile.goals.some((goal) => normalize(goal) === normalizedIntent)
          );
        })) &&
      (styleOptions.length === 0 ||
        styleOptions.some((style) => profile.danceStyles.includes(style))) &&
      matchesDistance
    );
  });
}
