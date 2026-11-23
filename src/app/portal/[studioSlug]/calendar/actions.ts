"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { feedBaseUrl, feedsEnabledForStudio, getFeedStatus, issueFeed, revokeFeed, setFeedDetail } from "@/lib/calendar-feeds/service";
import { parseDetail, pickIncludedProfiles, resolveDancerProfiles } from "@/lib/calendar-feeds/authz";

export type FeedActionState = {
  error?: string;
  message?: string;
  urls?: { https: string; webcal: string };
  prefix?: string;
};

const GENERIC = "Calendar links are not available right now.";

async function authorize(studioSlug: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const { data: studio } = await admin.from("studios").select("id").eq("slug", studioSlug).maybeSingle();
  if (!studio) return null;
  if (!(await feedsEnabledForStudio(admin, studio.id))) return null;
  const profiles = await resolveDancerProfiles(admin, studio.id, user.id);
  if (!profiles.length) return null;
  return { admin, user, studioId: studio.id as string, profiles };
}

function requestedProfiles(formData: FormData) {
  return formData.getAll("includeClientId").map((v) => String(v));
}

export async function createOrRotateDancerFeedAction(_prev: FeedActionState, formData: FormData): Promise<FeedActionState> {
  const studioSlug = String(formData.get("studioSlug") ?? "");
  const ctx = await authorize(studioSlug);
  if (!ctx) return { error: GENERIC };
  const origin = feedBaseUrl();
  if (!origin) return { error: GENERIC };
  try {
    const existing = await getFeedStatus(ctx.admin, ctx.studioId, "dancer_account", ctx.user.id);
    const overlap = formData.get("keepOldLink") === "on" ? 3600 : 0;
    const issued = await issueFeed(ctx.admin, {
      studioId: ctx.studioId,
      kind: "dancer_account",
      userId: ctx.user.id,
      detail: parseDetail(formData.get("detailLevel")) as "minimal" | "standard",
      includeClientIds: pickIncludedProfiles(requestedProfiles(formData), ctx.profiles.map((p) => p.id)),
      actorId: ctx.user.id,
      overlapSeconds: existing ? overlap : 0,
      origin,
    });
    return { urls: issued.urls, prefix: issued.prefix, message: existing ? "Your calendar link was replaced. Copy the new link now: it is shown only once." : "Your calendar link is ready. Copy it now: it is shown only once." };
  } catch {
    return { error: "Could not create the calendar link. Please try again." };
  }
}

export async function revokeDancerFeedAction(_prev: FeedActionState, formData: FormData): Promise<FeedActionState> {
  const ctx = await authorize(String(formData.get("studioSlug") ?? ""));
  if (!ctx) return { error: GENERIC };
  try {
    const status = await getFeedStatus(ctx.admin, ctx.studioId, "dancer_account", ctx.user.id);
    if (!status) return { message: "Calendar link is already off." };
    await revokeFeed(ctx.admin, { tokenId: status.id, studioId: ctx.studioId, subjectUserId: ctx.user.id, reason: "user", actorId: ctx.user.id, actorKind: "user" });
    return { message: "Calendar link turned off. Calendars that used it will stop updating." };
  } catch {
    return { error: "Could not turn off the calendar link. Please try again." };
  }
}

export async function updateDancerFeedAction(_prev: FeedActionState, formData: FormData): Promise<FeedActionState> {
  const ctx = await authorize(String(formData.get("studioSlug") ?? ""));
  if (!ctx) return { error: GENERIC };
  try {
    const status = await getFeedStatus(ctx.admin, ctx.studioId, "dancer_account", ctx.user.id);
    if (!status) return { error: "Create a calendar link first." };
    await setFeedDetail(ctx.admin, {
      tokenId: status.id,
      studioId: ctx.studioId,
      subjectUserId: ctx.user.id,
      detail: parseDetail(formData.get("detailLevel")) as "minimal" | "standard",
      includeClientIds: pickIncludedProfiles(requestedProfiles(formData), ctx.profiles.map((p) => p.id)),
      actorId: ctx.user.id,
    });
    return { message: "Calendar settings saved." };
  } catch {
    return { error: "Could not save the calendar settings. Please try again." };
  }
}
