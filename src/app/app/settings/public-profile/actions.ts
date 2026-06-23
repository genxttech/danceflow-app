"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentStudioContext, requireStudioRole } from "@/lib/auth/studio";
import { buildStudioLocationQuery, geocodeAddress } from "@/lib/geocoding";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const STYLE_KEYS = ["country", "ballroom", "latin", "salsa", "bachata", "swing", "west_coast_swing", "hip_hop", "contemporary", "ballet"] as const;
const OFFERING_KEYS = ["private_lessons", "group_classes", "wedding_dance", "kids_classes", "socials", "competitive_coaching", "beginner_program", "floor_rental"] as const;
const ASSET_BUCKET = "studio-public-assets";

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optional(formData: FormData, key: string) {
  return text(formData, key) || null;
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function normalizeUrl(value: string) {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function displayName(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function integer(formData: FormData, key: string, fallback: number, minimum: number) {
  const value = Number.parseInt(text(formData, key) || String(fallback), 10);
  if (Number.isNaN(value) || value < minimum) throw new Error(`${key} must be ${minimum} or greater.`);
  return value;
}

function file(formData: FormData, key: string) {
  const value = formData.get(key);
  return value instanceof File && value.size > 0 ? value : null;
}

async function uploadImage(studioId: string, image: File, kind: "logo" | "hero") {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  const maxBytes = kind === "logo" ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
  if (!allowed.has(image.type)) throw new Error("Images must be PNG, JPG, or WebP files.");
  if (image.size > maxBytes) throw new Error(`${kind === "logo" ? "Logo" : "Hero image"} is too large.`);
  const extension = image.type === "image/png" ? "png" : image.type === "image/webp" ? "webp" : "jpg";
  const path = `${studioId}/${kind}-${Date.now()}.${extension}`;
  const admin = createAdminClient();
  const { error } = await admin.storage.from(ASSET_BUCKET).upload(path, image, { contentType: image.type, upsert: true });
  if (error) throw new Error(`Image upload failed: ${error.message}`);
  return admin.storage.from(ASSET_BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function savePublicProfileAction(formData: FormData) {
  await requireStudioRole(["studio_owner", "studio_admin"]);
  const { studioId } = await getCurrentStudioContext();
  const supabase = await createClient();

  const { data: existing, error: existingError } = await supabase
    .from("studios")
    .select("name, slug, city, state, postal_code, public_logo_url, public_hero_image_url")
    .eq("id", studioId)
    .single();
  if (existingError || !existing) throw new Error(existingError?.message ?? "Studio not found.");

  const publicName = optional(formData, "public_name");
  const generatedSlug = slugify(text(formData, "slug") || publicName || existing.name);
  if (!generatedSlug) throw new Error("A valid public slug is required.");

  const city = optional(formData, "city");
  const state = optional(formData, "state");
  const postalCode = optional(formData, "postal_code");
  const locationChanged = city !== existing.city || state !== existing.state || postalCode !== existing.postal_code;
  const locationQuery = buildStudioLocationQuery({ city: city ?? "", state: state ?? "", postalCode: postalCode ?? "" });
  const coordinates = locationChanged && locationQuery ? await geocodeAddress(locationQuery) : null;

  const primaryColor = text(formData, "public_primary_color") || "#5B197A";
  if (!/^#[0-9a-f]{6}$/i.test(primaryColor)) throw new Error("Brand color must be a six-digit hex color.");
  const startTime = text(formData, "booking_request_start_time") || "09:00";
  const endTime = text(formData, "booking_request_end_time") || "21:00";
  if (startTime >= endTime) throw new Error("Booking start time must be earlier than the end time.");

  const logo = file(formData, "public_logo_file");
  const hero = file(formData, "public_hero_image_file");
  const logoUrl = logo ? await uploadImage(studioId, logo, "logo") : existing.public_logo_url;
  const heroUrl = hero ? await uploadImage(studioId, hero, "hero") : existing.public_hero_image_url;

  const studioPayload = {
    slug: generatedSlug,
    public_directory_enabled: formData.get("public_directory_enabled") === "on",
    beginner_friendly: formData.get("beginner_friendly") === "on",
    public_name: publicName,
    public_short_description: optional(formData, "public_short_description"),
    public_about: optional(formData, "public_about"),
    city,
    state,
    postal_code: postalCode,
    public_phone: optional(formData, "public_phone"),
    public_email: optional(formData, "public_email"),
    public_website_url: normalizeUrl(text(formData, "public_website_url")),
    public_logo_url: logoUrl,
    public_hero_image_url: heroUrl,
    public_lead_enabled: formData.get("public_lead_enabled") === "on",
    public_lead_headline: optional(formData, "public_lead_headline"),
    public_lead_description: optional(formData, "public_lead_description"),
    public_primary_color: primaryColor,
    public_lead_cta_text: optional(formData, "public_lead_cta_text"),
    ...(locationChanged ? { latitude: coordinates?.latitude ?? null, longitude: coordinates?.longitude ?? null } : {}),
  };

  const weekdays = formData.getAll("booking_request_allowed_weekdays").map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
  const introPayload = {
    public_intro_booking_enabled: formData.get("public_intro_booking_enabled") === "on",
    intro_lesson_duration_minutes: integer(formData, "intro_lesson_duration_minutes", 30, 15),
    intro_booking_window_days: integer(formData, "intro_booking_window_days", 7, 1),
    intro_default_instructor_id: optional(formData, "intro_default_instructor_id"),
    intro_default_room_id: optional(formData, "intro_default_room_id"),
    booking_request_allowed_weekdays: weekdays.length ? Array.from(new Set(weekdays)).sort() : [1, 2, 3, 4, 5, 6],
    booking_request_start_time: startTime,
    booking_request_end_time: endTime,
    public_intro_bookable_instructor_ids: formData.getAll("public_intro_bookable_instructor_ids").map(String),
  };

  const [{ error: studioError }, { error: settingsError }] = await Promise.all([
    supabase.from("studios").update(studioPayload).eq("id", studioId),
    supabase.from("studio_settings").update(introPayload).eq("studio_id", studioId),
  ]);
  if (studioError) throw new Error(`Failed to save public presence: ${studioError.message}`);
  if (settingsError) throw new Error(`Failed to save intro booking: ${settingsError.message}`);

  const selectedStyles = STYLE_KEYS.filter((key) => formData.getAll("styles").includes(key));
  const selectedOfferings = OFFERING_KEYS.filter((key) => formData.getAll("offerings").includes(key));
  const [{ error: deleteStylesError }, { error: deleteOfferingsError }] = await Promise.all([
    supabase.from("studio_public_styles").delete().eq("studio_id", studioId),
    supabase.from("studio_public_offerings").delete().eq("studio_id", studioId),
  ]);
  if (deleteStylesError || deleteOfferingsError) throw new Error("Failed to refresh public categories.");

  if (selectedStyles.length) {
    const { error } = await supabase.from("studio_public_styles").insert(selectedStyles.map((style_key) => ({ studio_id: studioId, style_key, display_name: displayName(style_key) })));
    if (error) throw new Error(`Failed to save styles: ${error.message}`);
  }
  if (selectedOfferings.length) {
    const { error } = await supabase.from("studio_public_offerings").insert(selectedOfferings.map((offering_key) => ({ studio_id: studioId, offering_key, display_name: displayName(offering_key) })));
    if (error) throw new Error(`Failed to save offerings: ${error.message}`);
  }

  ["/app/settings/public-profile", "/discover", "/discover/studios", `/studios/${generatedSlug}`, `/lead/${generatedSlug}`, `/book/${generatedSlug}`].forEach((path) => revalidatePath(path));
  if (existing.slug && existing.slug !== generatedSlug) {
    revalidatePath(`/studios/${existing.slug}`);
    revalidatePath(`/lead/${existing.slug}`);
    revalidatePath(`/book/${existing.slug}`);
  }
  redirect("/app/settings/public-profile?saved=1");
}
