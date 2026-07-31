import { danceflowApiFetch } from "@/lib/danceflowApi";
import { supabase } from "@/lib/supabase";

const partnerMessagingDb = supabase as any;

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

export type PartnerConversationThread = {
  id: string;
  partnerProfileId: string;
  requesterUserId: string;
  partnerUserId: string;
  status: string;
  lastMessageAt: string | null;
  partnerDisplayName: string;
  partnerPhotoUrl: string | null;
  partnerHeadline: string | null;
};

export type PartnerConversationMessage = {
  id: string;
  threadId: string;
  senderUserId: string;
  body: string;
  createdAt: string;
};

type PartnerConversationThreadRow = {
  id: string;
  partner_profile_id: string;
  requester_user_id: string;
  partner_user_id: string;
  status: string | null;
  last_message_at: string | null;
  dancer_partner_profiles:
    | {
        display_name: string | null;
        photo_url: string | null;
        headline: string | null;
      }
    | Array<{
        display_name: string | null;
        photo_url: string | null;
        headline: string | null;
      }>
    | null;
};

type PartnerConversationMessageRow = {
  id: string;
  thread_id: string;
  sender_user_id: string;
  body: string;
  created_at: string;
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

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function rowToThread(row: PartnerConversationThreadRow): PartnerConversationThread {
  const profile = firstJoin(row.dancer_partner_profiles);

  return {
    id: row.id,
    partnerProfileId: row.partner_profile_id,
    requesterUserId: row.requester_user_id,
    partnerUserId: row.partner_user_id,
    status: row.status ?? "active",
    lastMessageAt: row.last_message_at,
    partnerDisplayName: profile?.display_name ?? "Dance partner",
    partnerPhotoUrl: profile?.photo_url ?? null,
    partnerHeadline: profile?.headline ?? null
  };
}

function rowToMessage(row: PartnerConversationMessageRow): PartnerConversationMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    senderUserId: row.sender_user_id,
    body: row.body,
    createdAt: row.created_at
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
      profile.availabilityNotes
    ].join(" ")
  );
}

function photoExtension(contentType: string | null | undefined) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/heic") return "heic";
  return "jpg";
}

export async function uploadPartnerProfilePhoto({
  contentType,
  uri,
  userId
}: {
  contentType?: string | null;
  uri: string;
  userId: string;
}) {
  const response = await fetch(uri);
  const blob = await response.blob();
  const filePath = `${userId}/profile-${Date.now()}.${photoExtension(contentType)}`;

  const { error } = await supabase.storage
    .from("partner-profile-photos")
    .upload(filePath, blob, {
      cacheControl: "3600",
      contentType: contentType || "image/jpeg",
      upsert: true
    });

  if (error) throw error;

  const { data } = supabase.storage.from("partner-profile-photos").getPublicUrl(filePath);
  return data.publicUrl;
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
  requesterUserId: _requesterUserId
}: {
  message: string;
  partnerProfileId: string;
  requesterUserId: string;
}) {
  const cleanMessage = message.trim();

  if (!cleanMessage) {
    throw new Error("Add a message first.");
  }

  const result = await danceflowApiFetch<{ messageId: string; threadId: string }>(
    "/api/student/partners/messages",
    {
      body: JSON.stringify({
        body: cleanMessage,
        partnerProfileId
      }),
      method: "POST"
    }
  );

  return result.threadId;
}

export async function reportPartnerProfile({
  partnerProfileId,
  reason = "Reported from Partner Search"
}: {
  partnerProfileId: string;
  reason?: string;
}) {
  const { error } = await supabase.rpc("report_partner_profile", {
    target_partner_profile_id: partnerProfileId,
    report_reason: reason.trim() || "Reported from Partner Search"
  });

  if (error) throw error;
}

export async function blockPartnerProfile(partnerProfileId: string) {
  const { error } = await supabase.rpc("block_partner_profile", {
    target_partner_profile_id: partnerProfileId
  });

  if (error) throw error;
}

export async function loadPartnerThread(threadId: string, userId: string) {
  const { data, error } = await partnerMessagingDb
    .from("partner_conversation_threads")
    .select(
      "id, partner_profile_id, requester_user_id, partner_user_id, status, last_message_at, dancer_partner_profiles(display_name, photo_url, headline)"
    )
    .eq("id", threadId)
    .single();

  if (error) throw error;

  if (data.requester_user_id !== userId && data.partner_user_id !== userId) {
    throw new Error("You do not have access to this conversation.");
  }

  return rowToThread(data as PartnerConversationThreadRow);
}

export async function loadMyPartnerThreads(userId: string) {
  const { data, error } = await partnerMessagingDb
    .from("partner_conversation_threads")
    .select(
      "id, partner_profile_id, requester_user_id, partner_user_id, status, last_message_at, dancer_partner_profiles(display_name, photo_url, headline)"
    )
    .or(`requester_user_id.eq.${userId},partner_user_id.eq.${userId}`)
    .order("last_message_at", { ascending: false, nullsFirst: false });

  if (error) throw error;
  return ((data ?? []) as PartnerConversationThreadRow[]).map(rowToThread);
}

export async function loadPartnerThreadMessages(threadId: string, userId: string) {
  await loadPartnerThread(threadId, userId);

  const { data, error } = await partnerMessagingDb
    .from("partner_conversation_messages")
    .select("id, thread_id, sender_user_id, body, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return ((data ?? []) as PartnerConversationMessageRow[]).map(rowToMessage);
}

export async function sendPartnerThreadMessage({
  body,
  threadId,
  userId: _userId
}: {
  body: string;
  threadId: string;
  userId: string;
}) {
  const cleanBody = body.trim();

  if (!cleanBody) {
    throw new Error("Add a message first.");
  }

  await danceflowApiFetch<{ messageId: string; threadId: string }>(
    "/api/student/partners/messages",
    {
      body: JSON.stringify({
        body: cleanBody,
        threadId
      }),
      method: "POST"
    }
  );
}

export async function reportPartnerThread({
  reason,
  threadId,
  userId
}: {
  reason: string;
  threadId: string;
  userId: string;
}) {
  await loadPartnerThread(threadId, userId);

  const { error } = await partnerMessagingDb.from("partner_conversation_reports").insert({
    reason: reason.trim() || "Reported from mobile app",
    reporter_user_id: userId,
    thread_id: threadId
  });

  if (error) throw error;
}

export async function blockPartnerThread({
  blockedUserId,
  threadId,
  userId
}: {
  blockedUserId: string;
  threadId: string;
  userId: string;
}) {
  const thread = await loadPartnerThread(threadId, userId);
  const otherUserId =
    thread.requesterUserId === userId ? thread.partnerUserId : thread.requesterUserId;

  if (blockedUserId !== otherUserId) {
    throw new Error("You can only block the other dancer in this conversation.");
  }

  const { error } = await supabase.rpc("block_partner_user", {
    target_user_id: blockedUserId,
    target_thread_id: threadId
  });

  if (error) throw error;
}
