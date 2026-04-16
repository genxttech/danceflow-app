import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type PlatformProfileRow = {
  id: string;
  email: string | null;
  platform_role: string | null;
};

export async function getCurrentUserProfile() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, email, platform_role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !profile) {
    return null;
  }

  return profile as PlatformProfileRow;
}

export async function getCurrentUserPlatformRole() {
  const profile = await getCurrentUserProfile();
  return profile?.platform_role ?? null;
}

export async function isPlatformAdmin() {
  const platformRole = await getCurrentUserPlatformRole();
  return platformRole === "platform_admin";
}

export async function requireAuthenticatedUser() {
  const profile = await getCurrentUserProfile();

  if (!profile) {
    redirect("/login");
  }

  return profile;
}

export async function requirePlatformAdmin() {
  const profile = await requireAuthenticatedUser();

  if (profile.platform_role !== "platform_admin") {
    redirect("/app");
  }

  return profile;
}