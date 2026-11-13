"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext, requireStudioRole } from "@/lib/auth/studio";
import { parseSettingsForm } from "@/lib/public/embedSettings";

export type EmbedSettingsActionState = { ok: boolean; message: string } | null;

/**
 * Save the studio's embed settings. The studio is derived on the server from the signed-in user's own studio context, never from the
 * form, and the database function re-checks that the caller is an active owner or admin of that studio.
 */
export async function saveEmbedSettingsAction(_prev: EmbedSettingsActionState, form: FormData): Promise<EmbedSettingsActionState> {
  await requireStudioRole(["studio_owner", "studio_admin"]);
  const context = await getCurrentStudioContext();
  const parsed = parseSettingsForm(form);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  const s = parsed.value;

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_studio_embed_settings", {
    p_studio_id: context.studioId,
    p_embeds_enabled: s.embedsEnabled,
    p_show_events: s.showEvents,
    p_show_class_description: s.showClassDescription,
    p_show_class_price: s.showClassPrice,
    p_default_view: s.defaultView,
    p_default_theme: s.defaultTheme,
    p_default_accent: s.defaultAccent,
  });
  if (error) {
    // Fixed copy only; raw database text never reaches the page.
    console.error("Embed settings save failed:", error.code);
    return {
      ok: false,
      message: error.code === "42501" ? "Only a studio owner or admin can change website embed settings." : "Could not save your settings. Please try again.",
    };
  }
  revalidatePath("/app/settings/embeds");
  return { ok: true, message: s.embedsEnabled ? "Saved. Your embeds are on." : "Saved. Your embeds are now off and show nothing on your website." };
}
