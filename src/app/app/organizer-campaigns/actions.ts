"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

const AUDIENCE_TYPES = new Set([
  "all_organizer_contacts",
  "specific_event_registrants",
  "specific_event_ticket_buyers",
  "specific_event_checked_in",
  "specific_event_no_shows",
  "paid_registration_contacts",
]);

const EVENT_REQUIRED_AUDIENCES = new Set([
  "specific_event_registrants",
  "specific_event_ticket_buyers",
  "specific_event_checked_in",
  "specific_event_no_shows",
]);

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUrl(url: string) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://${url}`;
}

function appendQuery(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function canManageOrganizerMarketing(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return [
    "studio_owner",
    "studio_admin",
    "front_desk",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(role ?? "");
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
    canManageOrganizerMarketing(context.studioRole, context.isPlatformAdmin);

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
  const ctaUrl = normalizeUrl(getString(formData, "ctaUrl"));
  const audienceType = getString(formData, "audienceType") || "all_organizer_contacts";
  const audienceEventId = getString(formData, "audienceEventId");

  let redirectTo = "/app/organizer-campaigns";

  if (organizerId) {
    redirectTo = appendQuery(redirectTo, "organizer", organizerId);
  }

  if (!organizerId || !name || !subject || !bodyText) {
    redirect(appendQuery(redirectTo, "campaign_error", "missing_required_fields"));
  }

  if (!AUDIENCE_TYPES.has(audienceType)) {
    redirect(appendQuery(redirectTo, "campaign_error", "invalid_audience"));
  }

  if (EVENT_REQUIRED_AUDIENCES.has(audienceType) && !audienceEventId) {
    redirect(appendQuery(redirectTo, "campaign_error", "event_required"));
  }

  const { supabase, user } = await requireOrganizerAccess(organizerId);

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

  redirect(appendQuery(`/app/organizer-campaigns/${insertedCampaign.id}`, "campaign_saved", "1"));
}

