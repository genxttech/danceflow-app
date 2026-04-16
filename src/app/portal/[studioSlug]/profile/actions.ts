"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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
  const studioSlug = getString(formData, "studioSlug");
  const email = getString(formData, "email");
  const phone = getString(formData, "phone");
  const returnTo =
    getString(formData, "returnTo") ||
    `/portal/${encodeURIComponent(studioSlug)}/profile`;

  if (!studioSlug) {
    redirect("/login");
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