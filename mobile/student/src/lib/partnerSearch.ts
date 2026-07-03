import { supabase } from "@/lib/supabase";

export type PartnerListingIntent = "practice" | "social" | "showcase" | "competition";
export type PartnerRole = "lead" | "follow" | "either" | "switch";
export type PartnerSkillLevel =
  | "newcomer"
  | "beginner"
  | "social"
  | "intermediate"
  | "advanced"
  | "professional";
export type PartnerVisibility = "draft" | "published" | "paused" | "archived";

export type DancerPartnerProfile = {
  id: string | null;
  displayName: string;
  headline: string;
  bio: string;
  city: string;
  state: string;
  leadFollowRole: PartnerRole;
  danceStyles: string;
  skillLevel: PartnerSkillLevel;
  goals: string;
  listingIntent: PartnerListingIntent;
  availabilityNotes: string;
  photoUrl: string;
  visibility: PartnerVisibility;
  moderationStatus: string;
  moderationReason: string;
  allowStudioBadge: boolean;
  termsAcceptedAt: string | null;
};

type PartnerProfileRow = {
  id: string;
  display_name: string;
  headline: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
  lead_follow_role: PartnerRole | null;
  dance_styles: string[] | null;
  skill_level: PartnerSkillLevel | null;
  goals: string[] | null;
  listing_intent: PartnerListingIntent | null;
  availability_notes: string | null;
  photo_url: string | null;
  visibility: PartnerVisibility | null;
  moderation_status: string | null;
  moderation_reason: string | null;
  allow_studio_badge: boolean | null;
  terms_accepted_at: string | null;
};

const ADVERTISING_PATTERN =
  /(private lessons?|book (a )?(lesson|session)|rates?|pricing|coach(ing)?|instructor available|studio owner|dm me|follow me|https?:\/\/|www\.|@[a-z0-9_.-]+|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

function listToText(value: string[] | null | undefined) {
  return (value ?? []).join(", ");
}

function textToList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyProfile(userEmail?: string | null): DancerPartnerProfile {
  return {
    id: null,
    displayName: userEmail?.split("@")[0] ?? "",
    headline: "",
    bio: "",
    city: "",
    state: "",
    leadFollowRole: "either",
    danceStyles: "",
    skillLevel: "social",
    goals: "Practice",
    listingIntent: "practice",
    availabilityNotes: "",
    photoUrl: "",
    visibility: "draft",
    moderationStatus: "pending",
    moderationReason: "",
    allowStudioBadge: false,
    termsAcceptedAt: null
  };
}

function rowToProfile(row: PartnerProfileRow): DancerPartnerProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    headline: row.headline ?? "",
    bio: row.bio ?? "",
    city: row.city ?? "",
    state: row.state ?? "",
    leadFollowRole: row.lead_follow_role ?? "either",
    danceStyles: listToText(row.dance_styles),
    skillLevel: row.skill_level ?? "social",
    goals: listToText(row.goals),
    listingIntent: row.listing_intent ?? "practice",
    availabilityNotes: row.availability_notes ?? "",
    photoUrl: row.photo_url ?? "",
    visibility: row.visibility ?? "draft",
    moderationStatus: row.moderation_status ?? "pending",
    moderationReason: row.moderation_reason ?? "",
    allowStudioBadge: row.allow_studio_badge === true,
    termsAcceptedAt: row.terms_accepted_at
  };
}

export function hasPartnerListingAdvertisingRisk(profile: DancerPartnerProfile) {
  return ADVERTISING_PATTERN.test(
    [
      profile.displayName,
      profile.headline,
      profile.bio,
      profile.danceStyles,
      profile.goals,
      profile.photoUrl,
      profile.availabilityNotes
    ].join(" ")
  );
}

export async function loadMyPartnerProfile(userId: string, userEmail?: string | null) {
  const { data, error } = await supabase
    .from("dancer_partner_profiles")
    .select(
      "id, display_name, headline, bio, city, state, lead_follow_role, dance_styles, skill_level, goals, listing_intent, availability_notes, photo_url, visibility, moderation_status, moderation_reason, allow_studio_badge, terms_accepted_at"
    )
    .eq("user_id", userId)
    .maybeSingle<PartnerProfileRow>();

  if (error) throw error;
  return data ? rowToProfile(data) : emptyProfile(userEmail);
}

export async function saveMyPartnerProfile(userId: string, profile: DancerPartnerProfile) {
  const now = new Date().toISOString();
  const advertisingRisk = hasPartnerListingAdvertisingRisk(profile);
  const nextVisibility: PartnerVisibility = advertisingRisk ? "draft" : profile.visibility;

  const payload = {
    user_id: userId,
    display_name: profile.displayName.trim(),
    headline: profile.headline.trim() || null,
    bio: profile.bio.trim() || null,
    city: profile.city.trim() || null,
    state: profile.state.trim() || null,
    lead_follow_role: profile.leadFollowRole,
    dance_styles: textToList(profile.danceStyles),
    skill_level: profile.skillLevel,
    goals: textToList(profile.goals),
    listing_intent: profile.listingIntent,
    availability_notes: profile.availabilityNotes.trim() || null,
    photo_url: profile.photoUrl.trim() || null,
    visibility: nextVisibility,
    moderation_status: nextVisibility === "published" ? "pending" : profile.moderationStatus || "pending",
    moderation_reason: advertisingRisk
      ? "Listing may include lesson advertising, service promotion, external contact, or booking language."
      : null,
    allow_studio_badge: profile.allowStudioBadge,
    terms_accepted_at: profile.termsAcceptedAt ?? now,
    updated_at: now
  };

  const { error } = profile.id
    ? await supabase
        .from("dancer_partner_profiles")
        .update(payload)
        .eq("id", profile.id)
        .eq("user_id", userId)
    : await supabase.from("dancer_partner_profiles").insert({
        ...payload,
        created_at: now
      });

  if (error) throw error;

  return {
    advertisingRisk,
    visibility: nextVisibility
  };
}

export async function requestPartnerConnection({
  message,
  partnerProfileId,
  requesterUserId
}: {
  message: string;
  partnerProfileId: string;
  requesterUserId: string;
}) {
  const { error } = await supabase.from("partner_connection_requests").insert({
    partner_profile_id: partnerProfileId,
    requester_user_id: requesterUserId,
    message: message.trim()
  });

  if (error) throw error;
}
