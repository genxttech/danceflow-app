import type { EmailOtpType } from "@supabase/supabase-js";
import { authErrorFacts } from "@/lib/errorKind";

/*
  What the app accepts from an incoming authentication link: a PKCE code or an
  email token hash. Raw access_token / refresh_token values in a link are never
  read: any app or web page can open danceflow:// links, and accepting tokens
  from one would sign the device into whatever account the sender chose.

  A brand-new address receives a `signup` token and verifying it as `magiclink`
  fails, so the link's own type is used. Unknown types fail closed.
*/

const EMAIL_OTP_TYPES: readonly EmailOtpType[] = ["magiclink", "signup", "email", "recovery"];

export type AuthLinkParams = {
  code: string | null;
  tokenHash: string | null;
  type: string | null;
};

export function parseAuthLink(url: string): AuthLinkParams {
  try {
    const parsed = new URL(url);
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const read = (name: string) => parsed.searchParams.get(name) ?? hash.get(name);

    return { code: read("code"), tokenHash: read("token_hash"), type: read("type") };
  } catch {
    return { code: null, tokenHash: null, type: null };
  }
}

/** A link without a type is a magic link (the web bridge page defaults it the same way); null means refuse. */
export function resolveEmailOtpType(type: string | null): EmailOtpType | null {
  if (!type) return "magiclink";

  return EMAIL_OTP_TYPES.find((allowed) => allowed === type) ?? null;
}

export type AuthLinkError = { code: string | null; message: string };

export const LINK_NOT_REQUESTED_MESSAGE =
  "To keep your account safe, a sign-in link only works on the phone where you asked for it. Request a new link here, then open it on this phone.";

/** An emailed link this phone did not ask for, or one for a different address than the one it asked for. */
export class LinkNotRequestedError extends Error {
  constructor() {
    super("This sign-in link was not requested on this device.");
    this.name = "LinkNotRequestedError";
  }
}

export const LINK_EXPIRED_MESSAGE =
  "That sign-in link has expired or was already used. Request a new link to continue.";
export const LINK_OFFLINE_MESSAGE =
  "We could not reach DanceFlow to finish signing you in. Check your connection, then open the link again or request a new one.";
export const LINK_FAILED_MESSAGE =
  "We could not finish signing you in from that link. Request a new link and try again.";

// Codes the auth server uses for a link that cannot be used any more (expired, already used, unknown or stale flow).
// `access_denied` is the redirect’s generic `error` value that accompanies them; this app has no other flow that
// could produce it, so it reads as an unusable link too.
// `user_not_found` (the account behind the link is gone) and `validation_failed` (the token is malformed or rejected) kept the
// "expired or already used" wording before codes were used, and a dancer with a dead link should be told to request a new one.
const UNUSABLE_LINK_CODES = new Set(["otp_expired", "flow_state_expired", "flow_state_not_found", "user_not_found", "validation_failed", "access_denied"]);

/**
 * Turns a failed link into words for a dancer; never echoes provider text. Takes the caught error (or, for an
 * error the auth server redirected back with, its code string) and decides from the error’s code and its
 * connection-failure kind only, never from the vendor’s message wording.
 */
export function friendlyAuthLinkError(error: unknown): string {
  if (typeof error === "string") return UNUSABLE_LINK_CODES.has(error) ? LINK_EXPIRED_MESSAGE : LINK_FAILED_MESSAGE;
  if (error instanceof LinkNotRequestedError) return LINK_NOT_REQUESTED_MESSAGE;
  const { code, network } = authErrorFacts(error);
  if (network) return LINK_OFFLINE_MESSAGE;
  if (code !== null && UNUSABLE_LINK_CODES.has(code)) return LINK_EXPIRED_MESSAGE;

  return LINK_FAILED_MESSAGE;
}

/**
 * An error the auth server redirected back with (`#error=access_denied&error_code=otp_expired&...`).
 * Null when the link carries none.
 */
export function parseAuthLinkError(url: string): AuthLinkError | null {
  try {
    const parsed = new URL(url);
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const read = (name: string) => parsed.searchParams.get(name) ?? hash.get(name);
    const error = read("error");
    const code = read("error_code");
    if (!error && !code) return null;

    return { code, message: friendlyAuthLinkError(code ?? error) };
  } catch {
    return null;
  }
}
