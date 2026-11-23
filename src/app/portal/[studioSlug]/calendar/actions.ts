"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  allowMint,
  feedBaseUrl,
  feedsEnabledForStudio,
  getFeedStatus,
  issueFeed,
  revokeSubjectFeeds,
  setFeedDetail,
} from "@/lib/calendar-feeds/service";
import { parseDetail, resolveDancerProfiles, resolveSelection } from "@/lib/calendar-feeds/authz";

export type FeedActionState = {
  op?: "create" | "revoke" | "update";
  error?: string;
  message?: string;
  urls?: { https: string; webcal: string };
  prefix?: string;
};

const GENERIC = "Calendar links are not available right now.";

/** Signed-in user + the studio resolved from the slug. Used on its own for turning a link OFF (must work even if the switch was turned off). */
async function authenticate(studioSlug: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const { data: studio } = await admin.from("studios").select("id").eq("slug", studioSlug).maybeSingle();
  if (!studio) return null;
  return { admin, user, studioId: studio.id as string };
}

/** Full authorization for creating or changing a link: flag + studio switch + a linked profile with schedule visibility. */
async function authorize(studioSlug: string) {
  const base = await authenticate(studioSlug);
  if (!base) return null;
  if (!(await feedsEnabledForStudio(base.admin, base.studioId))) return null;
  const profiles = await resolveDancerProfiles(base.admin, base.studioId, base.user.id);
  if (!profiles.length) return null;
  return { ...base, profiles };
}

function requestedProfiles(formData: FormData) {
  return formData.getAll("includeClientId").map((v) => String(v));
}

function refresh(studioSlug: string) {
  revalidatePath(`/portal/${encodeURIComponent(studioSlug)}/calendar`);
}

export async function createOrRotateDancerFeedAction(_prev: FeedActionState, formData: FormData): Promise<FeedActionState> {
  const studioSlug = String(formData.get("studioSlug") ?? "");
  const ctx = await authorize(studioSlug);
  const origin = feedBaseUrl();
  if (!ctx || !origin) return { op: "create", error: GENERIC };
  const selection = resolveSelection(requestedProfiles(formData), ctx.profiles.map((p) => p.id));
  if (!selection.ok) return { op: "create", error: "Choose at least one profile to include." };
  if (!(await allowMint(ctx.admin, ctx.user.id))) return { op: "create", error: "Too many changes just now. Please try again later." };
  try {
    const existing = await getFeedStatus(ctx.admin, ctx.studioId, "dancer_account", ctx.user.id);
    const issued = await issueFeed(ctx.admin, {
      studioId: ctx.studioId,
      kind: "dancer_account",
      userId: ctx.user.id,
      detail: parseDetail(formData.get("detailLevel")),
      includeClientIds: selection.includeClientIds,
      actorId: ctx.user.id,
      overlapSeconds: existing && formData.get("keepOldLink") === "on" ? 3600 : 0,
      origin,
    });
    refresh(studioSlug);
    return {
      op: "create",
      urls: issued.urls,
      prefix: issued.prefix,
      message: existing ? "Your calendar link was replaced. Copy the new link now: it is shown only once." : "Your calendar link is ready. Copy it now: it is shown only once.",
    };
  } catch {
    return { op: "create", error: "Could not create the calendar link. Please try again." };
  }
}

export async function revokeDancerFeedAction(_prev: FeedActionState, formData: FormData): Promise<FeedActionState> {
  const studioSlug = String(formData.get("studioSlug") ?? "");
  const ctx = await authenticate(studioSlug);
  if (!ctx) return { op: "revoke", error: GENERIC };
  try {
    // Every live link of this person in this studio: the current one and any previous link still inside its overlap.
    const count = await revokeSubjectFeeds(ctx.admin, { studioId: ctx.studioId, kind: "dancer_account", subjectUserId: ctx.user.id, reason: "user", actorId: ctx.user.id, actorKind: "user" });
    refresh(studioSlug);
    return { op: "revoke", message: count > 0 ? "Calendar link turned off. Calendars that used it will stop updating." : "Calendar link is already off." };
  } catch {
    return { op: "revoke", error: "Could not turn off the calendar link. Please try again." };
  }
}

export async function updateDancerFeedAction(_prev: FeedActionState, formData: FormData): Promise<FeedActionState> {
  const studioSlug = String(formData.get("studioSlug") ?? "");
  const ctx = await authorize(studioSlug);
  if (!ctx) return { op: "update", error: GENERIC };
  const selection = resolveSelection(requestedProfiles(formData), ctx.profiles.map((p) => p.id));
  if (!selection.ok) return { op: "update", error: "Choose at least one profile to include." };
  try {
    const status = await getFeedStatus(ctx.admin, ctx.studioId, "dancer_account", ctx.user.id);
    if (!status) return { op: "update", error: "Create a calendar link first." };
    const changed = await setFeedDetail(ctx.admin, {
      tokenId: status.id,
      studioId: ctx.studioId,
      subjectUserId: ctx.user.id,
      detail: parseDetail(formData.get("detailLevel")),
      includeClientIds: selection.includeClientIds,
      actorId: ctx.user.id,
    });
    refresh(studioSlug);
    return changed ? { op: "update", message: "Calendar settings saved." } : { op: "update", error: "This link has changed. Reload the page and try again." };
  } catch {
    return { op: "update", error: "Could not save the calendar settings. Please try again." };
  }
}
