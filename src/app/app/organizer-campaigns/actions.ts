"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageOrganizerCampaigns } from "@/lib/auth/permissions";
import {
  ORGANIZER_CREATE_AUDIENCE_TYPES,
  ORGANIZER_CREATE_EVENT_REQUIRED_AUDIENCES,
  hasOrganizerRequiredContent,
  normalizeCampaignCtaUrl,
  readTrimmedFormString,
} from "@/lib/marketing/campaignContent";
import { isMarketingSendPaused } from "@/lib/marketing/compliance/sendFreeze";

function getString(formData: FormData, key: string) {
  return readTrimmedFormString(formData, key);
}

function appendQuery(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

async function requireOrganizerAccess(organizerId: string) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  const [
    { data: organizer, error: organizerError },
    { data: organizerUser, error: organizerUserError },
    { data: platformAdmin },
  ] = await Promise.all([
    supabase
      .from("organizers")
      .select("id, studio_id")
      .eq("id", organizerId)
      .maybeSingle(),
    supabase
      .from("organizer_users")
      .select("organizer_id, role, active")
      .eq("organizer_id", organizerId)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle(),
    supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (organizerError || organizerUserError || !organizer) {
    console.error("Failed to check organizer campaign access", { organizerError, organizerUserError });
    redirect("/app/organizer-campaigns?campaign_error=access_check_failed");
  }

  const hasStudioScopedAccess =
    organizer.studio_id === context.studioId &&
    canManageOrganizerCampaigns(context.studioRole, context.isPlatformAdmin);

  if (!organizerUser && !platformAdmin && !hasStudioScopedAccess) {
    redirect("/app/organizer-campaigns?campaign_error=not_allowed");
  }

  return { supabase, user };
}

export async function createOrganizerCampaignDraftAction(formData: FormData) {
  const organizerId = getString(formData, "organizerId");
  const name = getString(formData, "name");
  const subject = getString(formData, "subject");
  const previewText = getString(formData, "previewText");
  const bodyText = getString(formData, "bodyText");
  const ctaLabel = getString(formData, "ctaLabel");
  const rawCtaUrl = getString(formData, "ctaUrl");
  const ctaUrl = normalizeCampaignCtaUrl(rawCtaUrl);
  const audienceType = getString(formData, "audienceType") || "all_organizer_contacts";
  const audienceEventId = getString(formData, "audienceEventId");
  const source = getString(formData, "source");

  let redirectTo = "/app/organizer-campaigns";

  if (organizerId) {
    redirectTo = appendQuery(redirectTo, "organizer", organizerId);
  }

  if (!organizerId || !hasOrganizerRequiredContent({ name, subject, bodyText })) {
    redirect(appendQuery(redirectTo, "campaign_error", "missing_required_fields"));
  }

  if (rawCtaUrl && !ctaUrl) {
    redirect(appendQuery(redirectTo, "campaign_error", "invalid_cta_url"));
  }

  if (!ORGANIZER_CREATE_AUDIENCE_TYPES.has(audienceType)) {
    redirect(appendQuery(redirectTo, "campaign_error", "invalid_audience"));
  }

  if (ORGANIZER_CREATE_EVENT_REQUIRED_AUDIENCES.has(audienceType) && !audienceEventId) {
    redirect(appendQuery(redirectTo, "campaign_error", "event_required"));
  }

  const { supabase, user } = await requireOrganizerAccess(organizerId);

  // M-0 F4: while frozen the database hides campaigns, so a new draft would fail with a generic error.
  if (await isMarketingSendPaused(supabase)) {
    redirect(appendQuery(redirectTo, "campaign_error", "marketing_paused"));
  }

  if (audienceEventId) {
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, organizer_id")
      .eq("id", audienceEventId)
      .eq("organizer_id", organizerId)
      .maybeSingle();

    if (eventError || !event) {
      console.error("Organizer campaign event access check failed", eventError);
      redirect(appendQuery(redirectTo, "campaign_error", "invalid_event"));
    }
  }

  const { data: insertedCampaign, error } = await supabase
    .from("organizer_marketing_campaigns")
    .insert({
      organizer_id: organizerId,
      name,
      subject,
      preview_text: previewText || null,
      body_text: bodyText,
      cta_label: ctaLabel || null,
      cta_url: ctaUrl || null,
      audience_type: audienceType,
      audience_event_id: audienceEventId || null,
      status: "draft",
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !insertedCampaign) {
    console.error("Failed to create organizer campaign draft", error);
    redirect(appendQuery(redirectTo, "campaign_error", "draft_save_failed"));
  }

  let campaignDetailUrl = appendQuery(
    `/app/organizer-campaigns/${insertedCampaign.id}`,
    "campaign_saved",
    "1",
  );

  if (source === "aria-follow-up") {
    campaignDetailUrl = appendQuery(campaignDetailUrl, "source", "aria-follow-up");
  }

  redirect(campaignDetailUrl);
}

