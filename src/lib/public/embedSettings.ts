/**
 * Website Embeds: the studio's stored embed settings (migration 20270216090000_website_embed_settings.sql).
 *
 * Reads go through public_studio_embed_settings(slug), which only answers for a public, active studio. A failed read FAILS CLOSED:
 * if the settings cannot be read (for example the migration is not applied yet) the embed is not served, so a studio that switched its
 * embeds off can never be shown by an outage. A studio with no saved row has embeds on, events on, and class description and price off.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeAccent, type EmbedAppearanceDefaults, type EmbedTheme, type EmbedView, EMBED_VIEWS } from "@/lib/public/embedOptions";

export type EmbedSettings = {
  embedsEnabled: boolean;
  showEvents: boolean;
  showClassDescription: boolean;
  showClassPrice: boolean;
  defaultView: EmbedView;
  defaultTheme: EmbedTheme;
  defaultAccent: string | null;
};

export const DEFAULT_EMBED_SETTINGS: EmbedSettings = {
  embedsEnabled: true,
  showEvents: true,
  showClassDescription: false,
  showClassPrice: false,
  defaultView: "agenda",
  defaultTheme: "light",
  defaultAccent: null,
};

/**
 * Release gate. Website Embeds ship DARK: nothing is served, listed or savable until the server environment says WEBSITE_EMBEDS=on.
 * Read at request time on the server only; the owner turns it on as a separate step from deploying and from applying the migration.
 */
export function websiteEmbedsAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.WEBSITE_EMBEDS ?? "").trim().toLowerCase() === "on";
}

export type EmbedGate = { state: "ok"; settings: EmbedSettings } | { state: "off" } | { state: "unavailable" };

/** Strict row parser: a malformed row is rejected rather than guessed at. */
export function parseEmbedSettings(row: unknown): EmbedSettings | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const embedsEnabled = bool(r.embeds_enabled);
  const showEvents = bool(r.show_events);
  const showClassDescription = bool(r.show_class_description);
  const showClassPrice = bool(r.show_class_price);
  if (embedsEnabled === null || showEvents === null || showClassDescription === null || showClassPrice === null) return null;
  if (!(EMBED_VIEWS as readonly string[]).includes(String(r.default_view))) return null;
  if (r.default_theme !== "light" && r.default_theme !== "dark") return null;
  const accent = r.default_accent === null || r.default_accent === undefined ? null : normalizeAccent(String(r.default_accent));
  if (r.default_accent && !accent) return null;
  return {
    embedsEnabled,
    showEvents,
    showClassDescription,
    showClassPrice,
    defaultView: r.default_view as EmbedView,
    defaultTheme: r.default_theme,
    defaultAccent: accent,
  };
}

export function appearanceDefaults(settings: EmbedSettings): EmbedAppearanceDefaults {
  return { accent: settings.defaultAccent, theme: settings.defaultTheme, view: settings.defaultView };
}

/** Decide whether a studio's embeds may be served. Zero rows (not public) and read errors both mean "do not serve". */
export function embedGate(result: { data: unknown; error: unknown }): EmbedGate {
  if (result.error) return { state: "unavailable" };
  const rows = Array.isArray(result.data) ? result.data : [];
  if (rows.length === 0) return { state: "unavailable" };
  const settings = parseEmbedSettings(rows[0]);
  if (!settings) return { state: "unavailable" };
  return settings.embedsEnabled ? { state: "ok", settings } : { state: "off" };
}

export async function fetchEmbedGate(
  supabase: SupabaseClient,
  studioSlug: string,
  env: Record<string, string | undefined> = process.env,
): Promise<EmbedGate> {
  if (!websiteEmbedsAvailable(env)) return { state: "unavailable" }; // dark: no database call, the page answers 404
  try {
    const result = await supabase.rpc("public_studio_embed_settings", { p_studio_slug: studioSlug });
    return embedGate(result);
  } catch {
    return { state: "unavailable" };
  }
}

export type EmbedSettingsInput = EmbedSettings;

/** Validate what the builder form posts. Anything unexpected is an error, never a silent default. */
export function parseSettingsForm(form: FormData): { ok: true; value: EmbedSettings } | { ok: false; error: string } {
  const flag = (name: string) => form.get(name) === "on";
  const view = String(form.get("defaultView") ?? "");
  const theme = String(form.get("defaultTheme") ?? "");
  const accentRaw = String(form.get("defaultAccent") ?? "").trim();
  if (!(EMBED_VIEWS as readonly string[]).includes(view)) return { ok: false, error: "Choose a starting view." };
  if (theme !== "light" && theme !== "dark") return { ok: false, error: "Choose a background." };
  const accent = accentRaw === "" ? null : normalizeAccent(accentRaw);
  if (accentRaw !== "" && !accent) return { ok: false, error: "Use a 6-digit color such as #7a1f5c." };
  return {
    ok: true,
    value: {
      embedsEnabled: flag("embedsEnabled"),
      showEvents: flag("showEvents"),
      showClassDescription: flag("showClassDescription"),
      showClassPrice: flag("showClassPrice"),
      defaultView: view as EmbedView,
      defaultTheme: theme,
      defaultAccent: accent,
    },
  };
}
