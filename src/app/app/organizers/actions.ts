"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getCurrentWorkspaceCapabilitiesForUser } from "@/lib/billing/access";
import {
  isOrganizerOwner,
  isPlatformAdmin,
} from "@/lib/auth/permissions";

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

async function getOrganizerWorkspaceContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const capabilities = await getCurrentWorkspaceCapabilitiesForUser();

  if (!capabilities || capabilities.studioId !== context.studioId) {
    throw new Error("Could not load workspace access.");
  }

  if (!capabilities.isActive || capabilities.planCode !== "organizer") {
    throw new Error("Organizer features require an active Organizer plan.");
  }

  if (
    !isOrganizerOwner(context.studioRole) &&
    !isPlatformAdmin(context.studioRole)
  ) {
    throw new Error("Only the organizer owner can create or manage the organizer profile.");
  }

  return {
    supabase,
    userId: user.id,
    studioId: context.studioId,
    studioRole: context.studioRole,
  };
}

function humanizeOrganizerInsertError(message: string) {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("organizers_one_per_workspace_idx") ||
    (normalized.includes("duplicate key") && normalized.includes("studio_id"))
  ) {
    return "This organizer account already has an organizer profile. Only one organizer profile is allowed per account.";
  }

  if (normalized.includes("duplicate key") && normalized.includes("slug")) {
    return "That organizer slug is already in use. Please choose a different slug.";
  }

  return message;
}

export async function createOrganizerAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const { supabase, studioId, userId } = await getOrganizerWorkspaceContext();

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

    const { data: existingOrganizer, error: existingOrganizerError } = await supabase
      .from("organizers")
      .select("id, name, slug")
      .eq("studio_id", studioId)
      .limit(1)
      .maybeSingle();

    if (existingOrganizerError) {
      return {
        error: `Could not validate organizer account: ${existingOrganizerError.message}`,
      };
    }

    if (existingOrganizer) {
      return {
        error:
          "This organizer account already has an organizer profile. Only one organizer profile is allowed per account.",
      };
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
        error: `Could not create organizer: ${humanizeOrganizerInsertError(
          organizerError?.message ?? "Unknown error."
        )}`,
      };
    }

    const { error: accessError } = await supabase.from("organizer_users").upsert(
      {
        organizer_id: organizer.id,
        user_id: userId,
        role: "organizer_admin",
        active: true,
      },
      {
        onConflict: "organizer_id,user_id",
      }
    );

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