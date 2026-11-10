// Copied from mobile/student/src/lib/authLink.ts (draft PR #438). Keep the two in step until both move to mobile/shared.

import type { EmailOtpType } from "@supabase/supabase-js";

/*
  What the app accepts from an incoming authentication link: a PKCE code or an
  email token hash. Raw access_token / refresh_token values in a link are never
  read: any app or web page can open danceflow-business:// links, and accepting tokens
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
