/* eslint-disable @typescript-eslint/no-explicit-any -- loose PostgREST client shape */
import { generateFeedSecret } from "./token";
import type { SupabaseLike } from "./events";

/**
 * Management operations for calendar feeds (dark; CALENDAR_FEEDS_ENABLED + per-studio switch).
 * These take a SERVICE-ROLE client: callers (server actions) MUST authorize the user first. Every write goes through the
 * tenant-guarded SECURITY DEFINER functions from migration 20270223090000, which require the studio (and, for a
 * subject's own actions, the subject) to match the token row.
 */

export type FeedKind = "dancer_account" | "staff";
export type DetailLevel = "minimal" | "standard";

export type FeedStatus = {
  id: string;
  tokenPrefix: string;
  detailLevel: DetailLevel;
  includeClientIds: string[] | null;
  createdAt: string;
  lastAccessedAt: string | null;
  expiresAt: string;
};

export function feedsEnvEnabled(): boolean {
  return process.env.CALENDAR_FEEDS_ENABLED === "true";
}

export async function feedsEnabledForStudio(admin: SupabaseLike, studioId: string): Promise<boolean> {
  if (!feedsEnvEnabled()) return false;
  const { data, error } = await admin.from("calendar_feed_settings").select("enabled").eq("studio_id", studioId).maybeSingle();
  return !error && data?.enabled === true;
}

export function feedBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : null;
  } catch {
    return null;
  }
}

export function feedUrls(origin: string, secret: string): { https: string; webcal: string } {
  const https = `${origin}/calendar/feed/${secret}.ics`;
  return { https, webcal: https.replace(/^https?:/, "webcal:") };
}

/** Status of a subject's CURRENT feed. Never selects the token hash. */
export async function getFeedStatus(admin: SupabaseLike, studioId: string, kind: FeedKind, userId: string): Promise<FeedStatus | null> {
  const { data, error } = await admin
    .from("calendar_feed_tokens")
    .select("id, token_prefix, detail_level, include_client_ids, created_at, last_accessed_at, expires_at")
    .eq("studio_id", studioId)
    .eq("subject_kind", kind)
    .eq("subject_user_id", userId)
    .eq("status", "active")
    .is("superseded_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    tokenPrefix: data.token_prefix,
    detailLevel: data.detail_level === "standard" ? "standard" : "minimal",
    includeClientIds: Array.isArray(data.include_client_ids) ? data.include_client_ids : null,
    createdAt: data.created_at,
    lastAccessedAt: data.last_accessed_at ?? null,
    expiresAt: data.expires_at,
  };
}

/** Create or rotate. The plaintext secret is returned ONCE (to be shown to the user) and never stored. */
export async function issueFeed(
  admin: SupabaseLike,
  args: { studioId: string; kind: FeedKind; userId: string; detail: DetailLevel; includeClientIds: string[] | null; actorId: string; overlapSeconds?: number; origin: string },
): Promise<{ tokenId: string; urls: { https: string; webcal: string }; prefix: string }> {
  const { secret, hash, prefix } = generateFeedSecret();
  const { data, error } = await (admin as any).rpc("calendar_feed_issue_token", {
    p_studio: args.studioId,
    p_kind: args.kind,
    p_user: args.userId,
    p_token_hash: hash,
    p_prefix: prefix,
    p_detail: args.detail,
    p_include_client_ids: args.includeClientIds,
    p_actor: args.actorId,
    p_overlap_seconds: args.overlapSeconds ?? 0,
  });
  if (error || !data) throw new Error("Could not create the calendar link.");
  return { tokenId: String(data), urls: feedUrls(args.origin, secret), prefix };
}

export async function revokeFeed(
  admin: SupabaseLike,
  args: { tokenId: string; studioId: string; subjectUserId: string | null; reason: "user" | "admin"; actorId: string; actorKind: "user" | "admin" },
): Promise<boolean> {
  const { data, error } = await (admin as any).rpc("calendar_feed_revoke", {
    p_token_id: args.tokenId,
    p_studio: args.studioId,
    p_subject_user: args.subjectUserId,
    p_reason: args.reason,
    p_actor: args.actorId,
    p_actor_kind: args.actorKind,
  });
  if (error) throw new Error("Could not turn off the calendar link.");
  return data === true;
}

export async function setFeedDetail(
  admin: SupabaseLike,
  args: { tokenId: string; studioId: string; subjectUserId: string; detail: DetailLevel; includeClientIds: string[] | null; actorId: string },
): Promise<boolean> {
  const { data, error } = await (admin as any).rpc("calendar_feed_set_detail", {
    p_token_id: args.tokenId,
    p_studio: args.studioId,
    p_subject_user: args.subjectUserId,
    p_detail: args.detail,
    p_include_client_ids: args.includeClientIds,
    p_actor: args.actorId,
  });
  if (error) throw new Error("Could not update the calendar link.");
  return data === true;
}

export async function revokeAllStudioFeeds(admin: SupabaseLike, args: { studioId: string; actorId: string }): Promise<number> {
  const { data, error } = await (admin as any).rpc("calendar_feed_revoke_studio", { p_studio: args.studioId, p_reason: "incident", p_actor: args.actorId });
  if (error) throw new Error("Could not turn off the studio's calendar links.");
  return Number(data) || 0;
}

export type StaffFeedRow = { id: string; subjectUserId: string; name: string; tokenPrefix: string; detailLevel: DetailLevel; createdAt: string; lastAccessedAt: string | null };

/** Admin view: every live staff feed of the studio (no tokens, no hashes). */
export async function listStaffFeeds(admin: SupabaseLike, studioId: string): Promise<StaffFeedRow[]> {
  const { data, error } = await admin
    .from("calendar_feed_tokens")
    .select("id, subject_user_id, token_prefix, detail_level, created_at, last_accessed_at")
    .eq("studio_id", studioId)
    .eq("subject_kind", "staff")
    .eq("status", "active")
    .is("superseded_at", null);
  if (error || !data) return [];
  const userIds = data.map((r: any) => r.subject_user_id);
  const names = new Map<string, string>();
  if (userIds.length) {
    const { data: instructors } = await admin.from("instructors").select("user_id, first_name, last_name").eq("studio_id", studioId).in("user_id", userIds);
    for (const i of instructors ?? []) names.set(i.user_id, [i.first_name, i.last_name].filter(Boolean).join(" ").trim());
  }
  return data.map((r: any) => ({
    id: r.id,
    subjectUserId: r.subject_user_id,
    name: names.get(r.subject_user_id) || "Staff member",
    tokenPrefix: r.token_prefix,
    detailLevel: r.detail_level === "standard" ? "standard" : "minimal",
    createdAt: r.created_at,
    lastAccessedAt: r.last_accessed_at ?? null,
  }));
}

/** Is this user an active instructor of the studio (the only staff with a schedule to publish)? */
export async function isActiveInstructor(admin: SupabaseLike, studioId: string, userId: string): Promise<boolean> {
  const { data, error } = await admin.from("instructors").select("id").eq("studio_id", studioId).eq("user_id", userId).eq("active", true).limit(1);
  return !error && Array.isArray(data) && data.length > 0;
}
