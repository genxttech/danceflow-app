"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit";

/**
 * Billed-text reconciliation, platform-admin resolution of one stuck attempt. The actor always comes from the session. The database enforces the rest
 * (platform admin, 15 minutes after the dispatch marker, release only without a provider message, charge / close only with one). Database error text
 * is never shown: errcodes map to fixed short codes.
 */

const RETURN = "/platform/sms";
const ANCHOR = "#usage-reconciliation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set(["released", "charged", "not_charged"]);

function errorCode(code: string | undefined): string {
  if (code === "42501") return "not_allowed";
  if (code === "22023") return "not_resolvable";
  return "failed";
}

export async function resolveUsageAttemptAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const attemptId = String(formData.get("attemptId") ?? "").trim();
  const outcome = String(formData.get("outcome") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const rawSegments = String(formData.get("segments") ?? "").trim();
  const segments = /^\d{1,2}$/.test(rawSegments) ? Number(rawSegments) : null;

  let failure: string | null = null;
  if (!UUID.test(attemptId) || !OUTCOMES.has(outcome) || reason.length < 10 || reason.length > 300) failure = "invalid";
  else if (outcome === "charged" && (segments === null || segments < 1 || segments > 10)) failure = "invalid";
  else if (!checkRateLimit(rateLimitKey("platform:usage:resolve", admin.id, attemptId), { limit: 10, windowMs: 10 * 60 * 1000 }).allowed) failure = "rate_limited";

  if (!failure) {
    const { error } = await createAdminClient().rpc("tw4_usage_resolve", {
      p_attempt_id: attemptId,
      p_actor: admin.id,
      p_outcome: outcome,
      p_segments: outcome === "charged" ? segments : null,
      p_reason: reason,
    });
    if (error) failure = errorCode((error as { code?: string }).code);
  }

  revalidatePath(RETURN);
  // redirect throws: it stays outside any try/catch
  redirect(failure ? `${RETURN}?usage_error=${failure}${ANCHOR}` : `${RETURN}?usage=resolved${ANCHOR}`);
}
