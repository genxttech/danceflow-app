"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";

const PLATFORM_STUDIO_COOKIE = "platform_selected_studio_id";

export async function enterStudioContextAction(formData: FormData) {
  await requirePlatformAdmin();

  const studioId = String(formData.get("studioId") ?? "").trim();
  if (!studioId) {
    redirect("/platform/studios");
  }

  const supabase = await createClient();
  const { data: studio, error } = await supabase
    .from("studios")
    .select("id")
    .eq("id", studioId)
    .maybeSingle();

  if (error || !studio) {
    redirect("/platform/studios");
  }

  const cookieStore = await cookies();
  cookieStore.set(PLATFORM_STUDIO_COOKIE, studioId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  redirect("/app");
}

export async function clearStudioContextAction() {
  await requirePlatformAdmin();

  const cookieStore = await cookies();
  cookieStore.delete(PLATFORM_STUDIO_COOKIE);

  redirect("/platform");
}

export async function getPlatformSelectedStudioId() {
  const cookieStore = await cookies();
  return cookieStore.get(PLATFORM_STUDIO_COOKIE)?.value ?? null;
}