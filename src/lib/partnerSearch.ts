import { createClient } from "@/lib/supabase/server";

export type PartnerSearchProfile = {
  id: string;
  displayName: string;
  headline: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
  location: string;
  leadFollowRole: string;
  danceStyles: string[];
  skillLevel: string;
  goals: string[];
  availabilityNotes: string | null;
  contactPreference: string;
  contactEmail: string | null;
  contactPhone: string | null;
  publishedAt: string | null;
};

type PartnerSearchProfileRow = {
  id: string;
  display_name: string;
  headline: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
  lead_follow_role: string;
  dance_styles: string[] | null;
  skill_level: string;
  goals: string[] | null;
  availability_notes: string | null;
  contact_preference: string;
  contact_email: string | null;
  contact_phone: string | null;
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

export async function getPublishedPartnerProfiles() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("dancer_partner_profiles")
    .select(
      "id, display_name, headline, bio, city, state, lead_follow_role, dance_styles, skill_level, goals, availability_notes, contact_preference, contact_email, contact_phone, published_at",
    )
    .eq("visibility", "published")
    .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
    .order("published_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`Failed to load partner profiles: ${error.message}`);
  }

  return ((data ?? []) as PartnerSearchProfileRow[]).map<PartnerSearchProfile>(
    (row) => ({
      id: row.id,
      displayName: row.display_name,
      headline: row.headline,
      bio: row.bio,
      city: row.city,
      state: row.state,
      location: locationLabel(row.city, row.state),
      leadFollowRole: row.lead_follow_role,
      danceStyles: row.dance_styles ?? [],
      skillLevel: row.skill_level,
      goals: row.goals ?? [],
      availabilityNotes: row.availability_notes,
      contactPreference: row.contact_preference,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      publishedAt: row.published_at,
    }),
  );
}
