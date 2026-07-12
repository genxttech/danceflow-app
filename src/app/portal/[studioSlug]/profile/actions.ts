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

function safeProfileReturnTo(studioSlug: string, requestedReturnTo: string) {
  const fallback = `/portal/${encodeURIComponent(studioSlug)}/profile`;
  if (!requestedReturnTo) return fallback;

  try {
    const decoded = decodeURIComponent(requestedReturnTo);
    if (decoded === fallback || decoded.startsWith(`${fallback}?`)) return decoded;
  } catch {
    return fallback;
  }

  return fallback;
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

async function requireIndependentInstructorPortalAccess(studioSlug: string) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug, name")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    throw new Error("Studio not found.");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, studio_id, is_independent_instructor")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client || !client.is_independent_instructor) {
    throw new Error("This portal account is not enabled for independent instructor access.");
  }

  return { supabase, studio, client };
}

export async function updateInstructorPortalProfileAction(formData: FormData) {
  const studioSlug = normalizeSlug(getString(formData, "studioSlug"));
  const email = normalizeEmail(getString(formData, "email"));
  const phone = normalizePhone(getString(formData, "phone"));
  const returnTo = safeProfileReturnTo(
    studioSlug,
    getString(formData, "returnTo"),
  );

  if (!studioSlug) {
    redirect("/login");
  }

  if (email === null || phone === null) {
    redirect(appendQueryParam(returnTo, "error", "profile_update_failed"));
  }

  try {
    const { supabase, studio, client } =
      await requireIndependentInstructorPortalAccess(studioSlug);

    const { error } = await supabase
      .from("clients")
      .update({
        email: email || null,
        phone: phone || null,
      })
      .eq("id", client.id)
      .eq("studio_id", studio.id);

    if (error) {
      redirect(appendQueryParam(returnTo, "error", "profile_update_failed"));
    }
  } catch {
    redirect(appendQueryParam(returnTo, "error", "profile_update_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "profile_updated"));
}