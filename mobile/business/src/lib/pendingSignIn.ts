import { secureSessionStorage } from "@/lib/secureSessionStorage";

// Same binding as the Student app (mobile/student/src/lib/pendingSignIn.ts). Keep the two in step until both move to mobile/shared.

/*
  An emailed sign-in link that carries a token hash is accepted only on a phone where this app asked for one, and only for the address it asked for. Any app or
  web page can open danceflow-business:// links, so without this a sender could sign a staff member's phone into the sender's account with the sender's own link.

  One pending request is kept (the latest wins), in secure storage. It is used up by the first successful sign-in that matches it and ignored after
  PENDING_SIGN_IN_TTL_MS. The PKCE `code` path is not affected: it is already bound to this device's code verifier.
*/

const KEY = "danceflow-business-pending-email-sign-in";
/** The auth server's longest email-link lifetime; a link older than this cannot verify anyway. */
export const PENDING_SIGN_IN_TTL_MS = 24 * 60 * 60 * 1000;

export type PendingSignIn = { email: string; requestedAt: number };

export const normalizeSignInEmail = (email: string) => email.trim().toLowerCase();

export async function markPendingSignIn(email: string, now = Date.now()) {
  const pending: PendingSignIn = { email: normalizeSignInEmail(email), requestedAt: now };
  await secureSessionStorage.setItem(KEY, JSON.stringify(pending));
}

/** The pending request, or null when there is none, it is too old, or it cannot be read (fail closed). */
export async function readPendingSignIn(now = Date.now()): Promise<PendingSignIn | null> {
  try {
    const stored = await secureSessionStorage.getItem(KEY);
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<PendingSignIn>;
    if (typeof value.email !== "string" || !value.email || typeof value.requestedAt !== "number") return null;
    const age = now - value.requestedAt;
    // A clock set back a little must not lock a person out; a request "from the far future" is not trusted.
    if (age > PENDING_SIGN_IN_TTL_MS || age < -PENDING_SIGN_IN_TTL_MS) return null;
    return { email: value.email, requestedAt: value.requestedAt };
  } catch {
    return null;
  }
}

export async function clearPendingSignIn() {
  await secureSessionStorage.removeItem(KEY);
}
