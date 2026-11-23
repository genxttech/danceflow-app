"use server";

import { revalidatePath } from "next/cache";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageSettings } from "@/lib/auth/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { feedBaseUrl, feedsEnabledForStudio, getFeedStatus, isActiveInstructor, issueFeed, revokeAllStudioFeeds, revokeFeed, setFeedDetail } from "@/lib/calendar-feeds/service";
import { parseDetail } from "@/lib/calendar-feeds/authz";

export type StaffFeedActionState = {
  error?: string;
  message?: string;
  urls?: { https: string; webcal: string };
  prefix?: string;
};

const GENERIC = "Calendar links are not available right now.";

async function authorizeSelf() {
  const context = await getCurrentStudioContext();
  const admin = createAdminClient();
  if (!(await feedsEnabledForStudio(admin, context.studioId))) return null;
  if (!(await isActiveInstructor(admin, context.studioId, context.userId))) return null;
  return { admin, studioId: context.studioId, userId: context.userId };
}

export async function createOrRotateStaffFeedAction(_prev: StaffFeedActionState, formData: FormData): Promise<StaffFeedActionState> {
  const ctx = await authorizeSelf();
  const origin = feedBaseUrl();
  if (!ctx || !origin) return { error: GENERIC };
  try {
    const existing = await getFeedStatus(ctx.admin, ctx.studioId, "staff", ctx.userId);
    const issued = await issueFeed(ctx.admin, {
      studioId: ctx.studioId,
      kind: "staff",
      userId: ctx.userId,
      detail: parseDetail(formData.get("detailLevel")),
      includeClientIds: null,
      actorId: ctx.userId,
      overlapSeconds: existing && formData.get("keepOldLink") === "on" ? 3600 : 0,
      origin,
    });
    revalidatePath("/app/settings/calendar-feed");
    return { urls: issued.urls, prefix: issued.prefix, message: existing ? "Your calendar link was replaced. Copy the new link now: it is shown only once." : "Your calendar link is ready. Copy it now: it is shown only once." };
  } catch {
    return { error: "Could not create the calendar link. Please try again." };
  }
}

export async function revokeStaffFeedAction(_prev: StaffFeedActionState, _formData: FormData): Promise<StaffFeedActionState> {
  void _formData;
  const ctx = await authorizeSelf();
  if (!ctx) return { error: GENERIC };
  try {
    const status = await getFeedStatus(ctx.admin, ctx.studioId, "staff", ctx.userId);
    if (!status) return { message: "Calendar link is already off." };
    await revokeFeed(ctx.admin, { tokenId: status.id, studioId: ctx.studioId, subjectUserId: ctx.userId, reason: "user", actorId: ctx.userId, actorKind: "user" });
    revalidatePath("/app/settings/calendar-feed");
    return { message: "Calendar link turned off. Calendars that used it will stop updating." };
  } catch {
    return { error: "Could not turn off the calendar link. Please try again." };
  }
}

export async function updateStaffFeedAction(_prev: StaffFeedActionState, formData: FormData): Promise<StaffFeedActionState> {
  const ctx = await authorizeSelf();
  if (!ctx) return { error: GENERIC };
  try {
    const status = await getFeedStatus(ctx.admin, ctx.studioId, "staff", ctx.userId);
    if (!status) return { error: "Create a calendar link first." };
    await setFeedDetail(ctx.admin, { tokenId: status.id, studioId: ctx.studioId, subjectUserId: ctx.userId, detail: parseDetail(formData.get("detailLevel")), includeClientIds: null, actorId: ctx.userId });
    revalidatePath("/app/settings/calendar-feed");
    return { message: "Calendar settings saved." };
  } catch {
    return { error: "Could not save the calendar settings. Please try again." };
  }
}

async function authorizeManager() {
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) return null;
  const admin = createAdminClient();
  if (!(await feedsEnabledForStudio(admin, context.studioId))) return null;
  return { admin, studioId: context.studioId, userId: context.userId };
}

/** Owner/admin: turn off one staff member's link. The admin cannot see or recover the link itself. */
export async function adminRevokeStaffFeedAction(formData: FormData): Promise<void> {
  const ctx = await authorizeManager();
  if (!ctx) return;
  const tokenId = String(formData.get("tokenId") ?? "");
  const subjectUserId = String(formData.get("subjectUserId") ?? "");
  if (!tokenId || !subjectUserId) return;
  await revokeFeed(ctx.admin, { tokenId, studioId: ctx.studioId, subjectUserId, reason: "admin", actorId: ctx.userId, actorKind: "admin" });
  revalidatePath("/app/settings/calendar-feed");
}

/** Owner/admin incident action: turn off every calendar link in this studio (staff and dancers). */
export async function adminRevokeAllFeedsAction(): Promise<void> {
  const ctx = await authorizeManager();
  if (!ctx) return;
  await revokeAllStudioFeeds(ctx.admin, { studioId: ctx.studioId, actorId: ctx.userId });
  revalidatePath("/app/settings/calendar-feed");
}
