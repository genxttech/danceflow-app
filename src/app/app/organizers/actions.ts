"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type ActionState = {
  error: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeUrl(value: string) {
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `https://${value}`;
}

async function getStudioContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    redirect("/login");
  }

  return {
    supabase,
    userId: user.id,
    studioId: roleRow.studio_id as string,
  };
}

export async function createOrganizerAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const { supabase, studioId, userId } = await getStudioContext();

    const name = getString(formData, "name");
    const slugInput = getString(formData, "slug");
    const description = getString(formData, "description");
    const contactEmail = getString(formData, "contactEmail");
    const contactPhone = getString(formData, "contactPhone");
    const logoUrl = getString(formData, "logoUrl");
    const coverImageUrl = getString(formData, "coverImageUrl");
    const websiteUrl = getString(formData, "websiteUrl");
    const city = getString(formData, "city");
    const state = getString(formData, "state");
    const active = formData.get("active") === "on";

    if (!name) {
      return { error: "Organizer name is required." };
    }

    const slug = slugify(slugInput || name);

    if (!slug) {
      return { error: "Organizer slug is required." };
    }

    const { data: organizer, error: organizerError } = await supabase
      .from("organizers")
      .insert({
        studio_id: studioId,
        name,
        slug,
        description: description || null,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
        logo_url: logoUrl || null,
        cover_image_url: coverImageUrl || null,
        website_url: normalizeUrl(websiteUrl),
        city: city || null,
        state: state || null,
        active,
      })
      .select("id")
      .single();

    if (organizerError || !organizer) {
      return {
        error: `Could not create organizer: ${
          organizerError?.message ?? "Unknown error."
        }`,
      };
    }

    const { error: accessError } = await supabase.from("organizer_users").insert({
      organizer_id: organizer.id,
      user_id: userId,
      role: "organizer_admin",
      active: true,
    });

    if (accessError) {
      return {
        error: `Organizer created, but organizer access failed: ${accessError.message}`,
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/organizers");
}