/**
 * Website Embeds: option parsing and embed-code building. Pure helpers (no I/O) so they can be unit tested and shared by the
 * public embed pages and the studio-side builder.
 *
 * Embeds are stateless: the only things carried in an embed URL are appearance options, validated here against a strict
 * allow-list. What is PUBLIC is never decided here; it is decided by the database read model behind
 * public_group_class_occurrences (publicly_discoverable + public studio + active subscription).
 */

export type EmbedView = "agenda" | "month" | "week";
export type EmbedTheme = "light" | "dark";

export type EmbedOptions = {
  accent: string; // #rrggbb, lowercase
  theme: EmbedTheme;
  view: EmbedView;
  instructor: string | null;
  /** Anchor day, YYYY-MM-DD, or null for "today in the studio's time zone". */
  date: string | null;
};

export const DEFAULT_ACCENT = "#1e293b";
export const EMBED_VIEWS: readonly EmbedView[] = ["agenda", "month", "week"];

type Raw = Record<string, string | string[] | undefined> | URLSearchParams;

function first(raw: Raw, key: string): string | undefined {
  if (raw instanceof URLSearchParams) return raw.get(key) ?? undefined;
  const v = raw[key];
  return Array.isArray(v) ? v[0] : v;
}

/** "#1e90ff", "1E90FF" -> "#1e90ff"; anything else -> null. 3-digit forms are rejected on purpose (one canonical shape). */
export function normalizeAccent(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** Real calendar date check, so 2026-02-31 is rejected rather than rolled over. */
export function normalizeDateParam(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? value : null;
}

/** Appearance defaults a studio stored for its embeds; an explicit, valid URL option always wins over them. */
export type EmbedAppearanceDefaults = { accent?: string | null; theme?: EmbedTheme; view?: EmbedView };

export function parseEmbedOptions(raw: Raw, defaults: EmbedAppearanceDefaults = {}): EmbedOptions {
  const view = first(raw, "view");
  const theme = first(raw, "theme");
  const instructor = (first(raw, "instructor") ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80);
  return {
    accent: normalizeAccent(first(raw, "accent")) ?? normalizeAccent(defaults.accent) ?? DEFAULT_ACCENT,
    theme: theme === "dark" || theme === "light" ? theme : defaults.theme === "dark" ? "dark" : "light",
    view: (EMBED_VIEWS as readonly string[]).includes(view ?? "") ? (view as EmbedView) : defaults.view ?? "agenda",
    instructor: instructor || null,
    date: normalizeDateParam(first(raw, "date")),
  };
}

/** Black or white text for a #rrggbb background (WCAG relative luminance, threshold tuned so mid colors get white). */
export function readableTextOn(accent: string): "#ffffff" | "#0f172a" {
  const n = parseInt(accent.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum > 0.4 ? "#0f172a" : "#ffffff";
}

/**
 * Query string for an embed URL. A value equal to the baseline (the studio's stored default, else the built-in default) is omitted,
 * so codes stay short and follow later changes to the stored default; a value that differs is written out explicitly.
 */
export function embedQuery(options: Partial<EmbedOptions>, baseline: EmbedAppearanceDefaults = {}): string {
  const q = new URLSearchParams();
  const baseAccent = normalizeAccent(baseline.accent) ?? DEFAULT_ACCENT;
  const baseTheme = baseline.theme ?? "light";
  const baseView = baseline.view ?? "agenda";
  if (options.accent && options.accent !== baseAccent) q.set("accent", options.accent.replace("#", ""));
  if (options.theme && options.theme !== baseTheme) q.set("theme", options.theme);
  if (options.view && options.view !== baseView) q.set("view", options.view);
  if (options.instructor) q.set("instructor", options.instructor);
  if (options.date) q.set("date", options.date);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const embedClassPath = (appointmentId: string, options: Partial<EmbedOptions> = {}, baseline: EmbedAppearanceDefaults = {}) =>
  `/embed/class/${appointmentId}${embedQuery(options, baseline)}`;
export const embedCalendarPath = (studioSlug: string, options: Partial<EmbedOptions> = {}, baseline: EmbedAppearanceDefaults = {}) =>
  `/embed/calendar/${encodeURIComponent(studioSlug)}${embedQuery(options, baseline)}`;

/** Message the embed posts to its host page so the iframe can grow to fit. Height only: no data crosses the frame. */
export const EMBED_HEIGHT_MESSAGE = "danceflow:embed:height";

export function escapeAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Copy-paste code for a studio's website. A plain iframe works on WordPress ("Custom HTML"), Wix ("Embed a site"/HTML),
 * Squarespace ("Code" block) and ordinary HTML. The tiny listener resizes the frame from the height message and only
 * trusts messages that come from this exact iframe's window and the DanceFlow origin.
 */
export function buildEmbedCode(args: { origin: string; path: string; title: string; minHeight?: number }): string {
  const { origin, path, title } = args;
  const minHeight = args.minHeight ?? 480;
  const src = `${origin}${path}`;
  const id = `danceflow-embed-${Math.abs(hash(path)).toString(36)}`;
  return [
    // width/height/frameborder attributes (not only style) so the frame still sizes correctly on websites whose own CSP forbids inline styles.
    `<iframe id="${id}" src="${escapeAttr(src)}" title="${escapeAttr(title)}" width="100%" height="${minHeight}" frameborder="0" loading="lazy"`,
    `  style="width:100%;border:0;" referrerpolicy="strict-origin-when-cross-origin"></iframe>`,
    `<script>`,
    `window.addEventListener("message",function(e){`,
    `  var f=document.getElementById("${id}");`,
    `  if(!f||e.source!==f.contentWindow||e.origin!=="${origin}")return;`,
    `  var d=e.data;if(d&&d.type==="${EMBED_HEIGHT_MESSAGE}"&&typeof d.height==="number"&&d.height>0&&d.height<20000){f.setAttribute("height",String(Math.ceil(d.height)));}`,
    `});`,
    `</script>`,
  ].join("\n");
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
