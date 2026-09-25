import "server-only";

import { validateRequest } from "twilio/lib/webhooks/webhooks";

/**
 * A2P-1A: Twilio webhook request-signature verification.
 *
 * Twilio signs every webhook with HMAC-SHA1 over the exact URL it called (including the
 * query string) plus the sorted POST parameters, keyed by the account auth token. Routes
 * must parse `request.formData()` once, convert it with `twilioFormParams`, and call
 * `verifyTwilioWebhook` before any database access.
 *
 * Nothing here logs the auth token, the received signature, or an expected signature.
 */

export type TwilioWebhookVerification =
  | { ok: true }
  | { ok: false; status: 403 | 503; reason: "twilio_auth_token_missing" | "twilio_signature_missing" | "twilio_signature_invalid" };

export function twilioFormParams(formData: FormData): Record<string, string> {
  const params: Record<string, string> = {};

  formData.forEach((value, key) => {
    if (typeof value === "string") {
      params[key] = value;
    }
  });

  return params;
}

function firstHeaderValue(value: string | null) {
  const first = String(value ?? "").split(",")[0]?.trim();
  return first || null;
}

/**
 * Rebuilds the externally visible URL Twilio signed. Behind the hosting proxy the
 * forwarded proto/host describe the public request; the path and query come from the
 * request itself. Forging these headers does not help an attacker: a matching signature
 * still requires the auth token.
 */
export function resolveTwilioSignedUrl(request: Request) {
  const url = new URL(request.url);
  const protocol =
    firstHeaderValue(request.headers.get("x-forwarded-proto")) ?? url.protocol.replace(/:$/, "");
  const host = firstHeaderValue(request.headers.get("x-forwarded-host")) ?? url.host;

  return `${protocol}://${host}${url.pathname}${url.search}`;
}

export function verifyTwilioWebhook(
  request: Request,
  params: Record<string, string>,
): TwilioWebhookVerification {
  const authToken = String(process.env.TWILIO_AUTH_TOKEN ?? "").trim();

  if (!authToken) {
    return { ok: false, status: 503, reason: "twilio_auth_token_missing" };
  }

  const signature = String(request.headers.get("x-twilio-signature") ?? "").trim();

  if (!signature) {
    return { ok: false, status: 403, reason: "twilio_signature_missing" };
  }

  let valid = false;

  try {
    valid = validateRequest(authToken, signature, resolveTwilioSignedUrl(request), params);
  } catch {
    valid = false;
  }

  if (!valid) {
    return { ok: false, status: 403, reason: "twilio_signature_invalid" };
  }

  return { ok: true };
}
