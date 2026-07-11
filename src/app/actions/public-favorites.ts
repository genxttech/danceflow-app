"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, getServerActionRateLimitKey, rateLimitErrorMessage } from "@/lib/security/rate-limit";

type FavoriteTargetType = "studio" | "event";

type ToggleFavoriteParams = {
  targetType: FavoriteTargetType;
  targetId: string;
  returnPath?: string;
};

type ToggleFavoriteResult = {
  ok: boolean;
  favorited: boolean;
  error?: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

function normalizePath(path?: string) {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  return path.slice(0, 300);
}

function hasActivePublicAccess(studio: { subscription_status?: string | null } | null | undefined) {
  const status = (studio?.subscription_status ?? "").trim().toLowerCase();
  return status === "active" || status === "trialing";
}

export async function toggleFavoriteAction(
  params: ToggleFavoriteParams
): Promise<ToggleFavoriteResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      ok: false,
      favorited: false,
      error: "You must be logged in to save favorites.",
    };
  }

  const targetType = params.targetType;
  const targetId = params.targetId?.trim();
  const returnPath = normalizePath(params.returnPath);

  if (!targetId || !UUID_PATTERN.test(targetId)) {
    return {
      ok: false,
      favorited: false,
      error: "Missing favorite target.",
    };
  }

  const favoriteRateLimit = checkRateLimit(
    await getServerActionRateLimitKey("public:favorites", [user.id]),
    { limit: 30, windowMs: 10 * 60 * 1000 },
  );

  if (!favoriteRateLimit.allowed) {
    return {
      ok: false,
      favorited: false,
      error: rateLimitErrorMessage(favoriteRateLimit),
    };
  }

  if (targetType !== "studio" && targetType !== "event") {
    return {
      ok: false,
      favorited: false,
      error: "Invalid favorite target type.",
    };
  }

  if (targetType === "studio") {
    const { data: studioTarget, error: studioTargetError } = await supabase
      .from("studios")
      .select("id, subscription_status")
      .eq("id", targetId)
      .eq("public_directory_enabled", true)
      .maybeSingle<{ id: string; subscription_status: string | null }>();

    if (studioTargetError || !studioTarget || !hasActivePublicAccess(studioTarget)) {
      return {
        ok: false,
        favorited: false,
        error: "Favorite target was not found.",
      };
    }

    const { data: existing, error: existingError } = await supabase
      .from("user_favorites")
      .select("id")
      .eq("user_id", user.id)
      .eq("target_type", "studio")
      .eq("studio_id", targetId)
      .limit(1)
      .maybeSingle();

    if (existingError) {
      return {
        ok: false,
        favorited: false,
        error: existingError.message,
      };
    }

    if (existing?.id) {
      const { error: deleteError } = await supabase
        .from("user_favorites")
        .delete()
        .eq("id", existing.id);

      if (deleteError) {
        return {
          ok: false,
          favorited: true,
          error: deleteError.message,
        };
      }

      revalidatePath(returnPath);
      revalidatePath("/favorites");
      revalidatePath("/account");
      revalidatePath("/discover");
      revalidatePath("/discover/studios");
      revalidatePath("/discover/events");

      return {
        ok: true,
        favorited: false,
      };
    }

    const { error: insertError } = await supabase
      .from("user_favorites")
      .insert({
        user_id: user.id,
        target_type: "studio",
        studio_id: targetId,
        event_id: null,
      });

    if (insertError) {
      return {
        ok: false,
        favorited: false,
        error: insertError.message,
      };
    }

    revalidatePath(returnPath);
    revalidatePath("/favorites");
    revalidatePath("/account");
    revalidatePath("/discover");
    revalidatePath("/discover/studios");
    revalidatePath("/discover/events");

    return {
      ok: true,
      favorited: true,
    };
  }

  const { data: eventTarget, error: eventTargetError } = await supabase
    .from("events")
    .select("id, status, visibility")
    .eq("id", targetId)
    .in("status", ["published", "open"])
    .in("visibility", ["public", "unlisted"])
    .maybeSingle<{ id: string; status: string | null; visibility: string | null }>();

  if (eventTargetError || !eventTarget) {
    return {
      ok: false,
      favorited: false,
      error: "Favorite target was not found.",
    };
  }

  const { data: existing, error: existingError } = await supabase
    .from("user_favorites")
    .select("id")
    .eq("user_id", user.id)
    .eq("target_type", "event")
    .eq("event_id", targetId)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    return {
      ok: false,
      favorited: false,
      error: existingError.message,
    };
  }

  if (existing?.id) {
    const { error: deleteError } = await supabase
      .from("user_favorites")
      .delete()
      .eq("id", existing.id);

    if (deleteError) {
      return {
        ok: false,
        favorited: true,
        error: deleteError.message,
      };
    }

    revalidatePath(returnPath);
    revalidatePath("/favorites");
    revalidatePath("/account");
    revalidatePath("/discover");
    revalidatePath("/discover/studios");
    revalidatePath("/discover/events");

    return {
      ok: true,
      favorited: false,
    };
  }

  const { error: insertError } = await supabase
    .from("user_favorites")
    .insert({
      user_id: user.id,
      target_type: "event",
      studio_id: null,
      event_id: targetId,
    });

  if (insertError) {
    return {
      ok: false,
      favorited: false,
      error: insertError.message,
    };
  }

  revalidatePath(returnPath);
  revalidatePath("/favorites");
  revalidatePath("/account");
  revalidatePath("/discover");
  revalidatePath("/discover/studios");
  revalidatePath("/discover/events");

  return {
    ok: true,
    favorited: true,
  };
}