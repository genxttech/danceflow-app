/**
 * Marketing M-0: unsubscribe links and RFC 8058 one-click headers.
 *
 * Every marketing message carries two forms of the same per-recipient token:
 *  - a human link in the footer, to a confirmation page that never changes anything on GET (mail scanners and link
 *    prefetchers open links); the page posts to the unsubscribe endpoint;
 *  - `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058) pointing at the same
 *    endpoint, which a mailbox provider POSTs to without cookies or login.
 * The token is an opaque random UUID; it is the only credential, and the endpoint discloses nothing about its owner.
 */

export type UnsubscribeLinkKind = "studio" | "organizer" | "message";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUnsubscribeToken(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

/** Canonical public origin for links in email (never a preview or request host). */
export function marketingSiteOrigin(env: NodeJS.ProcessEnv = process.env) {
  return (env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com").trim().replace(/\/+$/, "");
}

export function buildUnsubscribeLinks(
  token: string,
  kind: UnsubscribeLinkKind,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isUnsubscribeToken(token)) {
    throw new Error("A marketing message cannot be sent without a valid unsubscribe token.");
  }
  const origin = marketingSiteOrigin(env);
  const safe = encodeURIComponent(token.trim().toLowerCase());
  const pagePath = kind === "organizer" ? "/unsubscribe/organizer-marketing/" : "/unsubscribe/marketing/";
  return {
    pageUrl: `${origin}${pagePath}${safe}`,
    oneClickUrl: `${origin}/api/email/unsubscribe/${safe}`,
  };
}

/** RFC 2369 + RFC 8058 headers. The URL must be https in production (Gmail/Yahoo bulk-sender requirement). */
export function buildListUnsubscribeHeaders(oneClickUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${oneClickUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
