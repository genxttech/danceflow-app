"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+0-9().\s-]{0,30}$/;

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function cleanText(value: string, maxLength: number) {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeSlug(value: string) {
  const slug = cleanText(value, 80);
  return SLUG_PATTERN.test(slug) ? slug : "";
}

function normalizeEmail(value: string) {
  const email = cleanText(value, 254).toLowerCase();
  return !email || EMAIL_PATTERN.test(email) ? email : null;
}

function normalizePhone(value: string) {
  const phone = cleanText(value, 30);
  return PHONE_PATTERN.test(phone) ? phone : null;
}

function returnPath(studioSlug: string) {
  return `/portal/${encodeURIComponent(studioSlug)}/profile`;
}

export async function updatePortalStudioContactAction(formData: FormData) {
  const studioSlug = normalizeSlug(getString(formData, "studioSlug"));
  const email = normalizeEmail(getString(formData, "email"));
  const phone = normalizePhone(getString(formData, "phone"));

  if (!studioSlug) redirect("/login");
  const destination = returnPath(studioSlug);

  if (email === null || phone === null) {
    redirect(`${destination}?error=contact_update_failed`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?intent=public&next=${encodeURIComponent(destination)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id")
    .eq("slug", studioSlug)
    .maybeSingle();

  if (studioError || !studio) {
    redirect(`${destination}?error=contact_update_failed`);
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .maybeSingle();

  if (clientError || !client) {
    redirect(`${destination}?error=contact_update_failed`);
  }

  const { error } = await supabase
    .from("clients")
    .update({
      email: email || null,
      phone: phone || null,
    })
    .eq("id", client.id)
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id);

  if (error) {
    redirect(`${destination}?error=contact_update_failed`);
  }

  redirect(`${destination}?success=contact_updated`);
}

// Temporary compatibility export for older imports.
export const updateInstructorPortalProfileAction =
  updatePortalStudioContactAction;
