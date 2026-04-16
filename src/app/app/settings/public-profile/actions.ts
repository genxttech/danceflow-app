"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext, requireStudioRole } from "@/lib/auth/studio";

function normalizeOptionalText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeUrl(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return `https://${raw}`;
}

const STYLE_OPTIONS = [
  { key: "country", label: "Country" },
  { key: "ballroom", label: "Ballroom" },
  { key: "latin", label: "Latin" },
  { key: "salsa", label: "Salsa" },
  { key: "bachata", label: "Bachata" },
  { key: "swing", label: "Swing" },
  { key: "west_coast_swing", label: "West Coast Swing" },
  { key: "hip_hop", label: "Hip Hop" },
  { key: "contemporary", label: "Contemporary" },
  { key: "ballet", label: "Ballet" },
] as const;

const OFFERING_OPTIONS = [
  { key: "private_lessons", label: "Private Lessons" },
  { key: "group_classes", label: "Group Classes" },
  { key: "wedding_dance", label: "Wedding Dance" },
  { key: "kids_classes", label: "Kids Classes" },
  { key: "socials", label: "Social Dancing" },
  { key: "competitive_coaching", label: "Competitive Coaching" },
  { key: "beginner_program", label: "Beginner Program" },
  { key: "floor_rental", label: "Floor Rental" },
] as const;

export async function savePublicProfileAction(formData: FormData) {
  await requireStudioRole(["studio_owner", "studio_admin"]);

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const supabase = await createClient();

  const studioNameFallback = normalizeOptionalText(formData.get("studio_name_fallback"));
  const publicName = normalizeOptionalText(formData.get("public_name"));
  const requestedSlug = normalizeOptionalText(formData.get("slug"));

  const generatedSlug = slugify(
    requestedSlug || publicName || studioNameFallback || "studio"
  );

  if (!generatedSlug) {
    throw new Error("A valid public slug is required.");
  }

  const publicDirectoryEnabled =
    formData.get("public_directory_enabled") === "on";
  const beginnerFriendly = formData.get("beginner_friendly") === "on";

  const payload = {
    slug: generatedSlug,
    public_directory_enabled: publicDirectoryEnabled,
    public_name: publicName,
    public_short_description: normalizeOptionalText(
      formData.get("public_short_description")
    ),
    public_about: normalizeOptionalText(formData.get("public_about")),
    city: normalizeOptionalText(formData.get("city")),
    state: normalizeOptionalText(formData.get("state")),
    postal_code: normalizeOptionalText(formData.get("postal_code")),
    public_phone: normalizeOptionalText(formData.get("public_phone")),
    public_email: normalizeOptionalText(formData.get("public_email")),
    public_website_url: normalizeUrl(formData.get("public_website_url")),
    public_logo_url: normalizeUrl(formData.get("public_logo_url")),
    public_hero_image_url: normalizeUrl(formData.get("public_hero_image_url")),
    beginner_friendly: beginnerFriendly,
  };

  const { data: updatedStudio, error: updateError } = await supabase
  .from("studios")
  .update(payload)
  .eq("id", studioId)
  .select("id, slug, public_name, city, state, public_phone, public_email, public_website_url")
  .single();

if (updateError) {
  throw new Error(`Failed to save public profile: ${updateError.message}`);
}

if (!updatedStudio) {
  throw new Error(
    "Public profile update was blocked. Check RLS policy on public.studios."
  );
}

  const selectedStyleKeys = STYLE_OPTIONS.map((option) => option.key).filter((key) =>
    formData.getAll("styles").includes(key)
  );

  const selectedOfferingKeys = OFFERING_OPTIONS.map((option) => option.key).filter(
    (key) => formData.getAll("offerings").includes(key)
  );

  const { error: deleteStylesError } = await supabase
    .from("studio_public_styles")
    .delete()
    .eq("studio_id", studioId);

  if (deleteStylesError) {
    throw new Error(`Failed to update styles: ${deleteStylesError.message}`);
  }

  if (selectedStyleKeys.length > 0) {
    const { error: insertStylesError } = await supabase
      .from("studio_public_styles")
      .insert(
        selectedStyleKeys.map((key) => ({
          studio_id: studioId,
          style_key: key,
          display_name:
            STYLE_OPTIONS.find((option) => option.key === key)?.label ?? key,
        }))
      );

    if (insertStylesError) {
      throw new Error(`Failed to save styles: ${insertStylesError.message}`);
    }
  }

  const { error: deleteOfferingsError } = await supabase
    .from("studio_public_offerings")
    .delete()
    .eq("studio_id", studioId);

  if (deleteOfferingsError) {
    throw new Error(
      `Failed to update offerings: ${deleteOfferingsError.message}`
    );
  }

  if (selectedOfferingKeys.length > 0) {
    const { error: insertOfferingsError } = await supabase
      .from("studio_public_offerings")
      .insert(
        selectedOfferingKeys.map((key) => ({
          studio_id: studioId,
          offering_key: key,
          display_name:
            OFFERING_OPTIONS.find((option) => option.key === key)?.label ?? key,
        }))
      );

    if (insertOfferingsError) {
      throw new Error(
        `Failed to save offerings: ${insertOfferingsError.message}`
      );
    }
  }

  revalidatePath("/app/settings/public-profile");
  revalidatePath("/discover");
  revalidatePath("/discover/studios");
  revalidatePath(`/studios/${generatedSlug}`);

  redirect("/app/settings/public-profile?saved=1");
}