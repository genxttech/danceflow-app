"use server";

import { revalidatePath } from "next/cache";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageSettings } from "@/lib/auth/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  allowMint,
  feedBaseUrl,
  feedsEnabledForStudio,
  getFeedStatus,
  isActiveInstructor,
  isUuid,
  issueFeed,
  revokeAllStudioFeeds,
  revokeSubjectFeeds,
  setFeedDetail,
} from "@/lib/calendar-feeds/service";
import { parseDetail } from "@/lib/calendar-feeds/authz";

export type StaffFeedActionState = {
  op?: "create" | "revoke" | "update";
  error?: string;
  message?: string;
  urls?: { https: string; webcal: string };
  prefix?: string;
};

const GENERIC = "Calendar links are not available right now.";
const PATH = "/app/settings/calendar-feed";

/** Creating or changing: flag + studio switch + an active instructor profile. */
async function authorizeSelf() {
  const context = await getCurrentStudioContext();
  const admin = createAdminClient();
  if (!(await feedsEnabledForStudio(admin, context.studioId))) return null;
  if (!(await isActiveInstructor(admin, context.studioId, context.userId))) return null;
  return { admin, studioId: context.studioId, userId: context.userId };
}

/** Turning OFF needs only the signed-in staff context (it must work even when the switch was turned off). */
async function authenticateSelf() {
  const context = await getCurrentStudioContext();
  return { admin: createAdminClient(), studioId: context.studioId, userId: context.userId };
}

export async function createOrRotateStaffFeedAction(_prev: StaffFeedActionState, formData: FormData): Promise<StaffFeedActionState> {
  const ctx = await authorizeSelf();
  const origin = feedBaseUrl();
  if (!ctx || !origin) return { op: "create", error: GENERIC };
  if (!(await allowMint(ctx.admin, ctx.userId))) return { op: "create", error: "Too many changes just now. Please try again later." };
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
    revalidatePath(PATH);
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

export async function revokeStaffFeedAction(_prev: StaffFeedActionState, _formData: FormData): Promise<StaffFeedActionState> {
  void _formData;
  const ctx = await authenticateSelf();
  try {
    const count = await revokeSubjectFeeds(ctx.admin, { studioId: ctx.studioId, kind: "staff", subjectUserId: ctx.userId, reason: "user", actorId: ctx.userId, actorKind: "user" });
    revalidatePath(PATH);
    return { op: "revoke", message: count > 0 ? "Calendar link turned off. Calendars that used it will stop updating." : "Calendar link is already off." };
  } catch {
    return { op: "revoke", error: "Could not turn off the calendar link. Please try again." };
  }
}

export async function updateStaffFeedAction(_prev: StaffFeedActionState, formData: FormData): Promise<StaffFeedActionState> {
  const ctx = await authorizeSelf();
  if (!ctx) return { op: "update", error: GENERIC };
  try {
    const status = await getFeedStatus(ctx.admin, ctx.studioId, "staff", ctx.userId);
    if (!status) return { op: "update", error: "Create a calendar link first." };
    const changed = await setFeedDetail(ctx.admin, { tokenId: status.id, studioId: ctx.studioId, subjectUserId: ctx.userId, detail: parseDetail(formData.get("detailLevel")), includeClientIds: null, actorId: ctx.userId });
    revalidatePath(PATH);
    return changed ? { op: "update", message: "Calendar settings saved." } : { op: "update", error: "This link has changed. Reload the page and try again." };
  } catch {
    return { op: "update", error: "Could not save the calendar settings. Please try again." };
  }
}

async function authorizeManager() {
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) return null;
  return { admin: createAdminClient(), studioId: context.studioId, userId: context.userId };
}

/** Owner/admin: turn off one staff member's links (current and overlapping). Cannot see or recover the link. Needs no flag so an incident is never blocked. */
export async function adminRevokeStaffFeedAction(formData: FormData): Promise<void> {
  const ctx = await authorizeManager();
  if (!ctx) return;
  const subjectUserId = String(formData.get("subjectUserId") ?? "");
  if (!isUuid(subjectUserId)) return;
  try {
    await revokeSubjectFeeds(ctx.admin, { studioId: ctx.studioId, kind: "staff", subjectUserId, reason: "admin", actorId: ctx.userId, actorKind: "admin" });
  } catch {
    // generic: the list below still shows the link if it was not turned off
  }
  revalidatePath(PATH);
}

/** Owner/admin incident action: turn off EVERY calendar link in this studio (staff and dancers). */
export async function adminRevokeAllFeedsAction(): Promise<void> {
  const ctx = await authorizeManager();
  if (!ctx) return;
  try {
    await revokeAllStudioFeeds(ctx.admin, { studioId: ctx.studioId, actorId: ctx.userId });
  } catch {
    // generic
  }
  revalidatePath(PATH);
}
