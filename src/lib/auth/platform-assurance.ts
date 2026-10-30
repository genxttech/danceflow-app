import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";

/**
 * TW-4F: server-side session assurance for platform-admin server actions.
 *
 * The /platform layout already sends an aal1 session to the MFA challenge, but a layout redirect does not protect a server action: an action is a POST
 * endpoint that can be invoked without rendering the page. Every state-changing TW-4F action therefore calls `requirePlatformStepUp` FIRST. It is the one
 * definition of the rule (see docs/twilio/TW-4F_Platform_Admin_AAL2.md):
 *
 *  1. `requirePlatformAdmin()` (role) - unchanged and always first, so a non-admin is refused before any assurance is read;
 *  2. the session's JWT claims are VERIFIED by `auth.getClaims()` (signature checked against the project's keys, or by the Auth server for a symmetric
 *     secret). The unverified cookie contents are never trusted;
 *  3. tier "aal2": the verified claims say `aal === "aal2"`, the token has not expired, the subject is the admin from step 1, and a TOTP method is in `amr`;
 *  4. tier "recent": additionally the newest TOTP entry in `amr` is at most STEP_UP_WINDOW_SECONDS old. Refreshing the session keeps the original `amr`
 *     timestamp, so only a fresh authenticator code (the challenge page with `stepup=1`) renews it.
 *
 * Fail closed: anything missing, malformed, unknown, unverifiable or errored is a refusal that redirects to the MFA challenge (or, with no verified
 * factor, the existing enrolment page). It never returns normally on a refusal and never falls back to the role alone. Call it OUTSIDE any try/catch
 * (a redirect is a thrown signal). A server action invoked outside the panel hits the same function, because the check lives in the action.
 */

/** How long after a TOTP verification a "recent" action is allowed. Not configurable by environment on purpose: a mis-set value must not weaken it. */
export const STEP_UP_WINDOW_SECONDS = 15 * 60;
/** Clock skew tolerated between this server and the Auth server when a `timestamp` is slightly in the future. */
export const STEP_UP_SKEW_SECONDS = 60;

export type AssuranceTier = "aal2" | "recent";

export type AssuranceRefusal = "claims_unavailable" | "subject_mismatch" | "session_expired" | "aal1" | "no_totp" | "stale";

export type AssuranceDecision = { ok: true } | { ok: false; reason: AssuranceRefusal };

type Claims = Record<string, unknown> | null | undefined;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** TOTP entries in `amr`. The detailed format carries timestamps; the string format (RFC 8176) cannot prove recency, so it yields `null` timestamps. */
function totpTimestamps(amr: unknown): (number | null)[] {
  if (!Array.isArray(amr)) return [];
  const out: (number | null)[] = [];
  for (const entry of amr) {
    if (typeof entry === "string") {
      if (entry === "totp") out.push(null);
    } else if (isRecord(entry) && entry.method === "totp") {
      out.push(typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp) ? entry.timestamp : null);
    }
  }
  return out;
}

/** Pure decision over VERIFIED claims. Exported for tests; production code calls `requirePlatformStepUp`. */
export function evaluateAssurance(claims: Claims, nowSeconds: number, tier: AssuranceTier, expectedSubject: string): AssuranceDecision {
  if (!isRecord(claims)) return { ok: false, reason: "claims_unavailable" };
  if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub !== expectedSubject) return { ok: false, reason: "subject_mismatch" };
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return { ok: false, reason: "session_expired" };
  if (claims.aal !== "aal2") return { ok: false, reason: "aal1" };

  const stamps = totpTimestamps(claims.amr);
  if (stamps.length === 0) return { ok: false, reason: "no_totp" };
  if (tier === "aal2") return { ok: true };

  const known = stamps.filter((t): t is number => t !== null);
  if (known.length === 0) return { ok: false, reason: "stale" };
  const newest = Math.max(...known);
  if (newest > nowSeconds + STEP_UP_SKEW_SECONDS) return { ok: false, reason: "stale" };
  if (nowSeconds - newest > STEP_UP_WINDOW_SECONDS) return { ok: false, reason: "stale" };
  return { ok: true };
}

/** Only a path inside the platform panel may be a return target: no scheme, no host, no backslash, no traversal, no encoded characters. */
export function safePlatformReturnPath(candidate: unknown, fallback = "/platform/sms"): string {
  if (typeof candidate !== "string") return fallback;
  if (!/^\/platform(\/[A-Za-z0-9_-]+)*$/.test(candidate)) return fallback;
  return candidate;
}

export function stepUpChallengeUrl(reason: AssuranceRefusal, returnTo: string): string {
  return `/platform-mfa/challenge?stepup=1&reason=${reason}&next=${encodeURIComponent(safePlatformReturnPath(returnTo))}`;
}

export async function requirePlatformStepUp(tier: AssuranceTier, returnTo = "/platform/sms") {
  const admin = await requirePlatformAdmin();

  let decision: AssuranceDecision;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    decision = error || !data ? { ok: false, reason: "claims_unavailable" } : evaluateAssurance(data.claims as Claims, Math.floor(Date.now() / 1000), tier, admin.id);
  } catch {
    decision = { ok: false, reason: "claims_unavailable" };
  }

  if (!decision.ok) redirect(stepUpChallengeUrl(decision.reason, returnTo));
  return admin;
}

/** The sentence the challenge page shows for a refusal reason. Unknown reasons get the generic sentence. */
export function stepUpMessage(reason: unknown): string | null {
  switch (reason) {
    case "stale":
      return "That action needs a fresh authenticator code. It was not performed. Enter a code to continue, then repeat the action.";
    case "aal1":
    case "no_totp":
      return "That action needs a session verified with your authenticator app. It was not performed. Enter a code to continue, then repeat the action.";
    case "claims_unavailable":
    case "subject_mismatch":
    case "session_expired":
      return "Your session could not be verified, so the action was not performed. Enter a code (or sign in again) to continue.";
    default:
      return null;
  }
}
