/**
 * BR-3 shared email brand foundation.
 *
 * Dependency-free single source for email presentation helpers: palette tokens, legal/footer strings,
 * HTML escaping, identity resolution, subject/URL sanitizers and canonical asset/app URL builders.
 * The application palette is authoritative. Nothing outside it (alternate palettes, web fonts, alternate
 * lockups) is used here.
 */

/** Current DanceFlow application palette (mirrors `src/app/globals.css` `--brand-*`). */
export const EMAIL_TOKENS = {
  primary: "#5b145e",
  primaryDark: "#431046",
  primarySoft: "#f6edf7",
  accent: "#d88a2d",
  accentDark: "#b86f18",
  accentSoft: "#f7e2c4",
  surface: "#fff9f3",
  border: "#ead9cb",
  text: "#2b1b2a",
  muted: "#6f5b6b",
  white: "#ffffff",
} as const;

/** Email-safe stack. No web fonts. */
export const EMAIL_FONT_STACK = "Arial, Helvetica, sans-serif";

/** Canonical production origin for email assets and customer links (matches the app's own canonical host). */
export const EMAIL_CANONICAL_ORIGIN = "https://www.idanceflow.com";

export const EMAIL_LEGAL_LINE = "DanceFlow is a product of GenX TotalTech LLC.";
export const EMAIL_SYSTEM_FOOTER_TEXT = "This is a system message from DanceFlow.";
export const STUDIO_NAME_FALLBACK = "Your dance studio";
export const ORGANIZER_NAME_FALLBACK = "Your event organizer";

export const EMAIL_SUBJECT_MAX_LENGTH = 200;
export const EMAIL_SUBJECT_FALLBACK = "DanceFlow Notification";

const MAX_URL_LENGTH = 2048;

/** `Sent by {Name} through DanceFlow.` (studio/organizer attribution; DanceFlow stays secondary). */
export function emailAttribution(name: string) {
  return `Sent by ${name} through DanceFlow.`;
}

/** Footer lines for plain-text email parts, so text bodies can carry the same attribution + legal line. */
export function emailFooterLines(
  mode: "system" | "studio" | "organizer",
  name?: string | null,
) {
  const attribution =
    mode === "system"
      ? EMAIL_SYSTEM_FOOTER_TEXT
      : emailAttribution(
          (name ?? "").trim() ||
            (mode === "organizer" ? ORGANIZER_NAME_FALLBACK : STUDIO_NAME_FALLBACK),
        );
  return [attribution, EMAIL_LEGAL_LINE];
}

/** The one HTML escaper for email presentation code. */
export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** `public_name?.trim() || name`, with one shared fallback. */
export function resolveStudioDisplayName(
  studio: { public_name?: string | null; name?: string | null } | null | undefined,
  fallback: string = STUDIO_NAME_FALLBACK,
) {
  return studio?.public_name?.trim() || studio?.name?.trim() || fallback;
}

/** First letter/digit of a name, uppercased, for the initial tile. */
export function resolveInitial(name: string | null | undefined, fallback = "S") {
  for (const char of Array.from((name ?? "").trim())) {
    if (/[\p{L}\p{N}]/u.test(char)) return char.toUpperCase();
  }
  return fallback;
}

// C0 + C1 controls, DEL, and Unicode line/paragraph separators.
// Built from char codes so no literal control characters or escapes live in the source.
export const EMAIL_CONTROL_CHAR_CLASS = [
  `${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}`,
  `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`,
  String.fromCharCode(0x2028),
  String.fromCharCode(0x2029),
].join("");
const CONTROL_CHARS = new RegExp(`[${EMAIL_CONTROL_CHAR_CLASS}]`, "g");
const CONTROL_OR_SPACE = new RegExp(`[\\s${EMAIL_CONTROL_CHAR_CLASS}]`);

function cleanInlineText(value: unknown) {
  return String(value ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips CR/LF and control characters, collapses whitespace, caps length, and never returns an empty subject. */
export function sanitizeEmailSubject(
  value: unknown,
  fallback: string = EMAIL_SUBJECT_FALLBACK,
) {
  const cleaned = cleanInlineText(value);
  const chosen = cleaned || cleanInlineText(fallback);
  const limited = Array.from(chosen).slice(0, EMAIL_SUBJECT_MAX_LENGTH).join("").trim();
  return limited;
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

function isLocalOrInternalHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  );
}

function parseUrlSafely(raw: string) {
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  if (CONTROL_OR_SPACE.test(raw)) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Validates a public image URL (studio logo) for use in email.
 * HTTPS only; rejects credentials, localhost/.local/.internal, single-label hosts and IP literals.
 * `allowInsecureImageUrls` is an explicit test-only switch and is never derived from the environment.
 */
export function sanitizePublicImageUrl(
  value: string | null | undefined,
  options: { allowInsecureImageUrls?: boolean } = {},
) {
  const parsed = parseUrlSafely(String(value ?? "").trim());
  if (!parsed) return null;

  const allowInsecure = options.allowInsecureImageUrls === true;
  if (parsed.protocol !== "https:" && !(allowInsecure && parsed.protocol === "http:")) {
    return null;
  }
  if (parsed.username || parsed.password) return null;

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return null;

  if (!allowInsecure) {
    if (isLocalOrInternalHost(hostname)) return null;
    if (hostname.startsWith("[") || hostname.includes(":")) return null; // IPv6 literal
    if (IPV4_LITERAL.test(hostname)) return null;
    if (!hostname.includes(".")) return null;
  }

  return parsed.toString();
}

/**
 * Validates a call-to-action URL. HTTPS always; `http://localhost` (or 127.0.0.1) only outside production,
 * so local DEV email keeps a working button without weakening production.
 */
export function sanitizeActionUrl(
  value: string | null | undefined,
  options: { allowLocalHttp?: boolean } = {},
) {
  const parsed = parseUrlSafely(String(value ?? "").trim());
  if (!parsed) return null;
  if (parsed.username || parsed.password) return null;

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return null;

  if (parsed.protocol === "https:") return parsed.toString();

  const allowLocalHttp = options.allowLocalHttp ?? process.env.NODE_ENV !== "production";
  if (
    parsed.protocol === "http:" &&
    allowLocalHttp &&
    (hostname === "localhost" || hostname === "127.0.0.1")
  ) {
    return parsed.toString();
  }
  return null;
}

/** Approved canonical logo family under `public/brand/logo/`. */
export const EMAIL_LOGO_FILES = {
  primary: "danceflow-logo-primary.png",
  "primary-640": "danceflow-logo-primary-640.png",
  "primary-320": "danceflow-logo-primary-320.png",
  "primary-white": "danceflow-logo-primary-white.png",
  "primary-mono-purple": "danceflow-logo-primary-mono-purple.png",
  symbol: "danceflow-symbol.png",
  "symbol-256": "danceflow-symbol-256.png",
  "symbol-128": "danceflow-symbol-128.png",
  "symbol-white": "danceflow-symbol-white.png",
  "symbol-mono-purple": "danceflow-symbol-mono-purple.png",
} as const;

export type EmailLogoAsset = keyof typeof EMAIL_LOGO_FILES;

function parseExplicitBaseUrl(baseUrl: string) {
  const parsed = parseUrlSafely(baseUrl.trim());
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new Error("Invalid email asset base URL override.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Invalid email asset base URL override.");
  }
  return parsed.origin;
}

/**
 * Absolute URL of an approved brand logo. Always the canonical production origin: never a preview host,
 * never localhost. `baseUrl` is an explicit override for tests and proof rendering only.
 */
export function emailAssetUrl(asset: EmailLogoAsset, options: { baseUrl?: string } = {}) {
  if (!Object.prototype.hasOwnProperty.call(EMAIL_LOGO_FILES, asset)) {
    throw new Error(`Unknown email logo asset: ${String(asset)}`);
  }
  const origin =
    options.baseUrl !== undefined
      ? parseExplicitBaseUrl(options.baseUrl)
      : EMAIL_CANONICAL_ORIGIN;
  return `${origin}/brand/logo/${EMAIL_LOGO_FILES[asset]}`;
}

type AppUrlEnv = { NODE_ENV?: string; NEXT_PUBLIC_SITE_URL?: string };

function resolveAppOrigin(env: AppUrlEnv) {
  // Production and Vercel preview executions both run with NODE_ENV=production, so previews can never
  // put a preview hostname in customer mail.
  if (env.NODE_ENV === "production") return EMAIL_CANONICAL_ORIGIN;

  const parsed = parseUrlSafely((env.NEXT_PUBLIC_SITE_URL ?? "").trim());
  if (!parsed || parsed.username || parsed.password) return EMAIL_CANONICAL_ORIGIN;

  const hostname = parsed.hostname.toLowerCase();
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (isLocal && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return parsed.origin;
  }
  return EMAIL_CANONICAL_ORIGIN;
}

/**
 * Customer-facing app link. Canonical `https://www.idanceflow.com` in production and on previews; only a local
 * non-production run may use a validated localhost site URL. `path` must be a same-origin absolute path.
 */
export function buildAppUrl(path: string, options: { env?: AppUrlEnv } = {}) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    CONTROL_OR_SPACE.test(path)
  ) {
    throw new Error("buildAppUrl requires a same-origin absolute path.");
  }

  const origin = resolveAppOrigin(options.env ?? process.env);
  const url = new URL(path, origin);
  if (url.origin !== origin) {
    throw new Error("buildAppUrl requires a same-origin absolute path.");
  }
  return url.toString();
}
