/**
 * BR-4C: first-touch campaign attribution for future QR / collateral / launch campaigns.
 *
 * Deliberately small:
 *  - Only six allowlisted query parameters are ever read: utm_source, utm_medium, utm_campaign,
 *    utm_content, utm_term and ref. Everything else in the URL is ignored.
 *  - Values are trimmed, stripped to a small safe character set, length-capped, and dropped when
 *    empty or email-like. The full landing URL and the HTTP referrer are never stored.
 *  - One first-party cookie (`df_attr`, 30 days, SameSite=Lax, Secure on https, path /) holds the
 *    FIRST-TOUCH attribution. Rule: first touch wins. An existing valid cookie is never
 *    overwritten, by internal navigation or by a later campaign link. (Latest-touch tracking is
 *    intentionally not built.)
 *  - At signup the server re-validates the cookie (it is client-controlled) and copies only the
 *    allowlisted fields into auth user metadata under the `attribution_` prefix.
 *
 * Nothing here is sent to a third party and nothing here is a general analytics framework.
 */

export const ATTRIBUTION_COOKIE_NAME = "df_attr";

/** 30 days. */
export const ATTRIBUTION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ref",
] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

export type AttributionValues = Partial<Record<AttributionKey, string>>;

/** Cookie payload: the validated values plus the capture date (UTC, YYYY-MM-DD). */
export type Attribution = AttributionValues & { captured_on: string };

/** Longest value kept; longer input is truncated before any other processing. */
export const MAX_ATTRIBUTION_VALUE_LENGTH = 64;

/** Prefix for the flat auth user-metadata keys written at signup. */
export const ATTRIBUTION_METADATA_PREFIX = "attribution_";

const ALLOWED_CHARACTERS = /[^A-Za-z0-9 ._~-]/g;
/** URL-like input is rejected so a campaign value can never become a stored link. */
const URL_LIKE = /:\/\/|^\s*www\.|\/\//i;
const CAPTURED_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isAttributionKey(key: string): key is AttributionKey {
  return (ATTRIBUTION_KEYS as readonly string[]).includes(key);
}

/**
 * Normalizes one value, or returns null when nothing safe remains.
 * Email-like input (contains "@") and URL-like input ("://", "//", "www.") are rejected outright
 * so a campaign link can never smuggle an address or a link into the cookie or into account
 * metadata. Allowed characters: letters, digits, space, and . _ ~ -
 */
export function normalizeAttributionValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const capped = raw.slice(0, MAX_ATTRIBUTION_VALUE_LENGTH * 4);
  if (capped.includes("@") || URL_LIKE.test(capped)) return null;

  const cleaned = capped
    .replace(/\s+/g, " ")
    .replace(ALLOWED_CHARACTERS, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, MAX_ATTRIBUTION_VALUE_LENGTH)
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Reads the allowlisted keys from a query string (or any key/value source). Unknown keys are
 * ignored; the first occurrence of a repeated key wins.
 */
export function parseAttributionParams(
  source: string | URLSearchParams | Record<string, unknown>,
): AttributionValues {
  const out: AttributionValues = {};

  const take = (key: string, value: unknown) => {
    if (!isAttributionKey(key) || out[key] !== undefined) return;
    const normalized = normalizeAttributionValue(Array.isArray(value) ? value[0] : value);
    if (normalized) out[key] = normalized;
  };

  if (typeof source === "string" || source instanceof URLSearchParams) {
    const params = typeof source === "string" ? new URLSearchParams(source) : source;
    for (const key of ATTRIBUTION_KEYS) take(key, params.get(key));
  } else {
    for (const key of ATTRIBUTION_KEYS) take(key, source[key]);
  }

  return out;
}

export function hasAttribution(values: AttributionValues | null | undefined): boolean {
  return Boolean(values) && ATTRIBUTION_KEYS.some((key) => Boolean(values?.[key]));
}

function utcDate(now: Date) {
  return now.toISOString().slice(0, 10);
}

/** Serializes first-touch attribution for the cookie value (URL-encoded JSON, well under 1 KB). */
export function serializeAttribution(values: AttributionValues, now: Date = new Date()): string | null {
  if (!hasAttribution(values)) return null;

  const payload: Attribution = { captured_on: utcDate(now) };
  for (const key of ATTRIBUTION_KEYS) {
    const value = values[key];
    if (value) payload[key] = value;
  }

  return encodeURIComponent(JSON.stringify(payload));
}

/**
 * Parses and RE-VALIDATES a cookie value. The cookie is client-controlled, so every value is
 * normalized again, unknown keys are dropped, and anything malformed returns null.
 */
export function parseAttributionCookie(raw: string | null | undefined): Attribution | null {
  if (!raw || raw.length > 2048) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;

  const record = decoded as Record<string, unknown>;
  const values = parseAttributionParams(record);
  if (!hasAttribution(values)) return null;

  const capturedOn =
    typeof record.captured_on === "string" && CAPTURED_ON_PATTERN.test(record.captured_on)
      ? record.captured_on
      : null;
  if (!capturedOn) return null;

  return { ...values, captured_on: capturedOn };
}

export type CaptureDecision =
  | { action: "none"; reason: "no_campaign_params" | "first_touch_exists" }
  | { action: "set"; cookie: string };

/**
 * First-touch capture rule, shared by the browser capture component. Returns the full
 * `document.cookie` assignment string when a new cookie should be written.
 */
export function decideAttributionCapture(input: {
  search: string;
  existingCookieValue: string | null | undefined;
  secure: boolean;
  now?: Date;
}): CaptureDecision {
  const values = parseAttributionParams(input.search);
  if (!hasAttribution(values)) return { action: "none", reason: "no_campaign_params" };

  // First touch wins: a valid existing cookie is never replaced.
  if (parseAttributionCookie(input.existingCookieValue)) {
    return { action: "none", reason: "first_touch_exists" };
  }

  const serialized = serializeAttribution(values, input.now);
  if (!serialized) return { action: "none", reason: "no_campaign_params" };

  const parts = [
    `${ATTRIBUTION_COOKIE_NAME}=${serialized}`,
    `Max-Age=${ATTRIBUTION_MAX_AGE_SECONDS}`,
    "Path=/",
    "SameSite=Lax",
  ];
  if (input.secure) parts.push("Secure");

  return { action: "set", cookie: parts.join("; ") };
}

/**
 * Flat, namespaced auth user-metadata for signup. Only validated allowlisted fields are
 * emitted, each under `attribution_<key>`, plus `attribution_captured_on`. Returns {} when
 * there is no valid attribution, so signup behaves exactly as before.
 */
export function attributionUserMetadata(
  attribution: Attribution | null | undefined,
): Record<string, string> {
  if (!attribution || !hasAttribution(attribution)) return {};

  const out: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = attribution[key];
    if (value) out[`${ATTRIBUTION_METADATA_PREFIX}${key}`] = value;
  }
  if (CAPTURED_ON_PATTERN.test(attribution.captured_on)) {
    out[`${ATTRIBUTION_METADATA_PREFIX}captured_on`] = attribution.captured_on;
  }

  return out;
}
