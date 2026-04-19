"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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

function normalizePath(path?: string) {
  if (!path || !path.startsWith("/")) return "/";
  return path;
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

  if (!targetId) {
    return {
      ok: false,
      favorited: false,
      error: "Missing favorite target.",
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