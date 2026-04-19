"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type FavoriteTargetType = "studio" | "event";

export async function toggleFavoriteAction(params: {
  targetType: FavoriteTargetType;
  targetId: string;
  returnPath: string;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return;
  }

  if (params.targetType === "studio") {
    const { data: existing } = await supabase
      .from("user_favorites")
      .select("id")
      .eq("user_id", user.id)
      .eq("studio_id", params.targetId)
      .maybeSingle();

    if (existing?.id) {
      await supabase.from("user_favorites").delete().eq("id", existing.id);
    } else {
      await supabase.from("user_favorites").insert({
        user_id: user.id,
        target_type: "studio",
        studio_id: params.targetId,
      });
    }
  }

  if (params.targetType === "event") {
    const { data: existing } = await supabase
      .from("user_favorites")
      .select("id")
      .eq("user_id", user.id)
      .eq("event_id", params.targetId)
      .maybeSingle();

    if (existing?.id) {
      await supabase.from("user_favorites").delete().eq("id", existing.id);
    } else {
      await supabase.from("user_favorites").insert({
        user_id: user.id,
        target_type: "event",
        event_id: params.targetId,
      });
    }
  }

  revalidatePath(params.returnPath);
  revalidatePath("/discover");
  revalidatePath("/discover/studios");
  revalidatePath("/discover/events");
}