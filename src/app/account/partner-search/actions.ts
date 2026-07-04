"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const ADVERTISING_PATTERN =
  /(private lessons?|book (a )?(lesson|session)|rates?|pricing|coach(ing)?|instructor available|studio owner|dm me|follow me|https?:\/\/|www\.|@[a-z0-9_.-]+|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getOptionalString(formData: FormData, key: string) {
  const value = getString(formData, key);
  return value.length ? value : null;
}

function getMultiList(formData: FormData, key: string) {
  return Array.from(
    new Set(
      formData
        .getAll(key)
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function hasAdvertisingRisk(values: Array<string | null | undefined>) {
  return ADVERTISING_PATTERN.test(values.filter(Boolean).join(" "));
}

export async function savePartnerSearchProfileAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account/partner-search");
  }

  const displayName = getString(formData, "displayName");
  const headline = getOptionalString(formData, "headline");
  const bio = getOptionalString(formData, "bio");
  const city = getOptionalString(formData, "city");
  const state = getOptionalString(formData, "state");
  const danceStyles = getMultiList(formData, "danceStyles");
  const goals = getMultiList(formData, "goals");
  const listingIntent = getString(formData, "listingIntent") || "practice";
  const availabilityNotes = getOptionalString(formData, "availabilityNotes");
  const wantsVisible = getString(formData, "profileVisible") === "on";

  if (!displayName) {
    redirect("/account/partner-search?error=missing_name");
  }

  const advertisingRisk = hasAdvertisingRisk([
    displayName,
    headline,
    bio,
    danceStyles.join(" "),
    goals.join(" "),
    availabilityNotes,
  ]);
  const visibility = advertisingRisk ? "draft" : wantsVisible ? "published" : "paused";
  const now = new Date().toISOString();

  const { data: existing, error: existingError } = await supabase
    .from("dancer_partner_profiles")
    .select("id, moderation_status, terms_accepted_at")
    .eq("user_id", user.id)
    .maybeSingle<{
      id: string;
      moderation_status: string | null;
      terms_accepted_at: string | null;
    }>();

  if (existingError) {
    redirect("/account/partner-search?error=save_failed");
  }

  const payload = {
    user_id: user.id,
    display_name: displayName,
    headline,
    bio,
    city,
    state,
    lead_follow_role: getString(formData, "leadFollowRole") || "either",
    dance_styles: danceStyles,
    skill_level: getString(formData, "skillLevel") || "social",
    goals,
    listing_intent: listingIntent,
    availability_notes: availabilityNotes,
    visibility,
    moderation_status:
      visibility === "published" ? "pending" : existing?.moderation_status || "pending",
    moderation_reason: advertisingRisk
      ? "Listing may include lesson advertising, service promotion, external contact, or booking language."
      : null,
    allow_studio_badge: false,
    terms_accepted_at: existing?.terms_accepted_at ?? now,
    published_at: visibility === "published" ? now : null,
    updated_at: now,
  };

  const { error } = existing?.id
    ? await supabase
        .from("dancer_partner_profiles")
        .update(payload)
        .eq("id", existing.id)
        .eq("user_id", user.id)
    : await supabase.from("dancer_partner_profiles").insert({
        ...payload,
        created_at: now,
      });

  if (error) {
    redirect("/account/partner-search?error=save_failed");
  }

  revalidatePath("/account/partner-search");
  revalidatePath("/discover/partners");

  if (advertisingRisk) {
    redirect("/account/partner-search?success=draft_review");
  }

  redirect(
    visibility === "paused"
      ? "/account/partner-search?success=hidden"
      : "/account/partner-search?success=submitted",
  );
}
