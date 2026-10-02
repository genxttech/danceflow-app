/*
  LAUNCH-SEC-1C-A1: build the DanceFlow /callback link for a server-generated
  Supabase email token.

  The link's `type` must be the verification type the Supabase admin link
  generator actually issued (properties.verification_type). For a brand-new
  address generateLink({ type: "magiclink" }) issues a `signup` token, and
  verifying it as `magiclink` fails (otp_expired). The type always comes from
  that trusted server-side generator output, never from client input, and only
  the two types these flows legitimately produce are allowed; anything else
  fails closed (no link).
*/

export const CALLBACK_VERIFICATION_TYPES = ["signup", "magiclink"] as const;

export type CallbackVerificationType = (typeof CALLBACK_VERIFICATION_TYPES)[number];

export function isCallbackVerificationType(value: unknown): value is CallbackVerificationType {
  return (
    typeof value === "string" &&
    (CALLBACK_VERIFICATION_TYPES as readonly string[]).includes(value)
  );
}

export function buildTokenHashCallbackUrl(params: {
  baseUrl: string;
  tokenHash: string | null | undefined;
  verificationType: unknown;
  nextPath: string;
}): string | null {
  if (!params.tokenHash || !isCallbackVerificationType(params.verificationType)) {
    return null;
  }

  return `${params.baseUrl}/callback?token_hash=${encodeURIComponent(
    params.tokenHash,
  )}&type=${params.verificationType}&next=${encodeURIComponent(params.nextPath)}`;
}
