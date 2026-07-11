const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_ERROR_CODE_PATTERN = /^[a-z0-9_-]{1,80}$/i;
const SAFE_HOST_PATTERN = /^[a-z0-9.-]+(?::\d+)?$/i;

export function normalizeLocalRedirectPath(
  value: string | null | undefined,
  fallback = "",
) {
  const trimmed = String(value ?? "").trim();

  if (!trimmed) return fallback;
  if (trimmed.length > 1000) return fallback;
  if (CONTROL_CHARACTERS.test(trimmed)) return fallback;
  if (trimmed.includes("\\")) return fallback;
  if (!trimmed.startsWith("/")) return fallback;
  if (trimmed.startsWith("//")) return fallback;
  if (PROTOCOL_PATTERN.test(trimmed)) return fallback;

  return trimmed;
}

export function normalizeRedirectParam(
  value: string | null | undefined,
  currentOrigin: string,
  fallback: string | null = null,
) {
  const localPath = normalizeLocalRedirectPath(value ?? "", "");
  if (localPath) return localPath;

  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 1000 || CONTROL_CHARACTERS.test(raw)) {
    return fallback;
  }

  try {
    const parsed = new URL(raw);
    const origin = new URL(currentOrigin);

    if (parsed.origin !== origin.origin) {
      return fallback;
    }

    return normalizeLocalRedirectPath(
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
      fallback ?? "",
    ) || fallback;
  } catch {
    return fallback;
  }
}

export function getTrustedSiteOrigin(fallback = "http://localhost:3000") {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || "";

  try {
    const url = new URL(configured);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.origin;
    }
  } catch {
    // Fall through to the safe local development fallback.
  }

  return fallback;
}

export function getTrustedRequestOrigin(
  headerStore: { get(name: string): string | null },
  fallback = "http://localhost:3000",
) {
  const configuredOrigin = getTrustedSiteOrigin(fallback);

  if (process.env.NODE_ENV === "production") {
    return configuredOrigin;
  }

  const host =
    headerStore.get("x-forwarded-host")?.trim() || headerStore.get("host")?.trim();
  const proto =
    headerStore.get("x-forwarded-proto")?.trim().toLowerCase() || "http";

  if (!host || !SAFE_HOST_PATTERN.test(host)) {
    return configuredOrigin;
  }

  if (proto !== "http" && proto !== "https") {
    return configuredOrigin;
  }

  return `${proto}://${host}`;
}

export function safeAuthErrorCode(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SAFE_ERROR_CODE_PATTERN.test(normalized) ? normalized : "auth-failed";
}

export function buildLoginErrorPath(errorCode: string) {
  const search = new URLSearchParams({ error: safeAuthErrorCode(errorCode) });
  return `/login?${search.toString()}`;
}
