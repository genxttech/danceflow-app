import type { EmailOtpType } from "@supabase/supabase-js";

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

export const LINK_EXPIRED_MESSAGE =
  "That sign-in link has expired or was already used. Request a new link to continue.";
export const LINK_FAILED_MESSAGE =
  "We could not finish signing you in from that link. Request a new link and try again.";

/** Turns a provider error (code and/or message) into words for a dancer; never echoes provider text. */
export function friendlyAuthLinkError(code: string | null | undefined, message?: string | null): string {
  const haystack = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  if (/otp_expired|expired|invalid|already|used|not found/.test(haystack)) return LINK_EXPIRED_MESSAGE;

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

    return { code, message: friendlyAuthLinkError(code ?? error, read("error_description")) };
  } catch {
    return null;
  }
}
