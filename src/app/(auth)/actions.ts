"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { slugify } from "@/lib/utils/slug";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function generateUniqueStudioSlug(baseName: string) {
  const supabase = await createClient();
  const baseSlug = slugify(baseName);
  let slug = baseSlug || "studio";
  let counter = 2;

  while (true) {
    const { data, error } = await supabase
      .from("studios")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      throw new Error(`Could not validate studio slug: ${error.message}`);
    }

    if (!data) return slug;

    slug = `${baseSlug}-${counter}`;
    counter++;
  }
}

export async function signupAction(formData: FormData) {
  const fullName = getString(formData, "fullName");
  const email = getString(formData, "email").toLowerCase();
  const password = getString(formData, "password");
  const studioName = getString(formData, "studioName");

  if (!fullName || !email || !password || !studioName) {
    return { error: "All fields are required." };
  }

  const supabase = await createClient();

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
  });

  if (signUpError) {
    return { error: signUpError.message };
  }

  const user = signUpData.user;

  if (!user) {
    return { error: "User account was not created." };
  }

  const slug = await generateUniqueStudioSlug(studioName);

  const { error: profileError } = await supabase.from("profiles").insert({
    id: user.id,
    full_name: fullName,
    email,
  });

  if (profileError) {
    return { error: `Profile creation failed: ${profileError.message}` };
  }

  console.log("About to create studio", { studioName, email, slug });

const { error: studioInsertError } = await supabase.from("studios").insert({
  name: studioName,
  slug,
  email,
  timezone: "America/New_York",
  billing_plan: "starter",
  subscription_status: "trialing",
});

console.log("Studio insert result", { studioInsertError });

if (studioInsertError) {
  return {
    error: `Studio creation failed: ${studioInsertError.message}`,
  };
}

const { data: createdStudio, error: studioFetchError } = await supabase
  .from("studios")
  .select("id, name, slug")
  .eq("slug", slug)
  .single();

console.log("Studio fetch result", { createdStudio, studioFetchError });

if (studioFetchError || !createdStudio) {
  return {
    error: `Studio lookup failed after insert: ${studioFetchError?.message ?? "Unknown error"}`,
  };
}

  const { error: settingsError } = await supabase.from("studio_settings").insert({
    studio_id: createdStudio.id,
    cancellation_window_hours: 24,
    no_show_deducts_lesson: true,
    allow_negative_balance: false,
    package_expiration_enabled: true,
    couples_can_share_packages: false,
    group_classes_use_package_credits: false,
    allow_booking_without_balance: false,
    default_currency: "USD",
    booking_window_days: 60,
  });

  if (settingsError) {
    return { error: `Studio settings creation failed: ${settingsError.message}` };
  }

  const { error: roleError } = await supabase.from("user_studio_roles").insert({
    user_id: user.id,
    studio_id: createdStudio.id,
    role: "studio_owner",
    active: true,
  });

  if (roleError) {
    return { error: `Studio owner role creation failed: ${roleError.message}` };
  }

  redirect("/app");
}

export async function loginAction(formData: FormData) {
  const email = getString(formData, "email").toLowerCase();
  const password = getString(formData, "password");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const supabase = await createClient();

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { error: error.message };
  }

  redirect("/app");
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}