"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePlatformStepUp } from "@/lib/auth/platform-assurance";
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { encodePanelFlash, PANEL_FLASH_MAX_AGE_SECONDS } from "@/lib/sms/twilioIsv/panelFlash";
import {
  configuredInboundRoute, CONTROLS_FLASH_COOKIE, pinInboundRoute, REASON_MAX, REASON_MIN, setBilledTextingSwitch, SWITCH_ON_PHRASE,
} from "@/lib/sms/activationControls";

/**
 * Platform-administrator entry points for the pinned inbound route and the billed texting switch. Every action runs the session guard FIRST and takes the
 * actor from that session. All input is validated before the service-role client is built. Pinning and switching ON open the way to billed texting, so they
 * need a recent authenticator code, like activation; switching OFF only stops spending, so it needs a verified session without the 15-minute window, like
 * suspend. The result travels in a short-lived httpOnly cookie, never the URL.
 */

const RETURN_PATH = "/platform/sms";
const ANCHOR = "#sms-activation-controls";

type Result = { ok: boolean; message: string };
const bad = (message: string): Result => ({ ok: false, message });

async function finish(result: Result): Promise<never> {
  (await cookies()).set(CONTROLS_FLASH_COOKIE, encodePanelFlash(result), { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: RETURN_PATH, maxAge: PANEL_FLASH_MAX_AGE_SECONDS });
  revalidatePath(RETURN_PATH);
  // redirect throws: it stays outside any try/catch
  redirect(`${RETURN_PATH}?${result.ok ? "controls=1" : "controls_error=1"}${ANCHOR}`);
}

/** A trimmed text field with Unicode format characters (bidi overrides, zero-width marks) removed before any check or database call. */
const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.replace(/\p{Cf}/gu, "").trim() : "";
};
const confirmed = (form: FormData) => ["on", "yes", "true", "1"].includes(field(form, "confirm").toLowerCase());

/** The written reason, or null. Length is counted in characters, as the database counts it. */
function reasonFrom(form: FormData): string | null {
  const v = field(form, "reason");
  const length = Array.from(v).length;
  return length >= REASON_MIN && length <= REASON_MAX && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
}

const BAD_REASON = `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters on one line. Nothing changed.`;
const TOO_MANY = "Too many attempts. Wait a few minutes and try again. Nothing changed.";

/** Counted only for well-formed submits, so a mistyped reason never uses up the OFF switch. */
function limited(adminId: string, scope: string, limit: number): boolean {
  return !checkRateLimit(rateLimitKey(`platform:sms-controls:${scope}`, adminId), { limit, windowMs: 10 * 60 * 1000 }).allowed;
}

/** Pins the application's own configured origin. The form only echoes what the page showed; a different or changed value is refused, never pinned. */
export async function pinInboundRouteAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("recent");
  const route = configuredInboundRoute(process.env);
  if (!route.ok) return finish(bad(`${route.message} Nothing changed.`));
  if (field(formData, "shownOrigin") !== route.origin) return finish(bad("The address shown on the page is not the configured one any more. Reload the page and check it. Nothing changed."));
  const reason = reasonFrom(formData);
  if (!reason) return finish(bad(BAD_REASON));
  if (!confirmed(formData)) return finish(bad("Confirm the address before pinning it. Nothing changed."));
  if (limited(admin.id, "pin", 10)) return finish(bad(TOO_MANY));
  const res = await pinInboundRoute(createAdminClient(), { actorId: admin.id, origin: route.origin, reason });
  if (!res.ok) return finish(bad(res.message));
  return finish({ ok: true, message: `Inbound route pinned. Compliance validation judged against any other address no longer counts: run it again where needed. Pinned: ${route.origin}` });
}

export async function switchBilledTextingOnAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("recent");
  const reason = reasonFrom(formData);
  if (!reason) return finish(bad(BAD_REASON));
  if (field(formData, "phrase") !== SWITCH_ON_PHRASE) return finish(bad(`Type ${SWITCH_ON_PHRASE} exactly to switch billed texting on. Nothing changed.`));
  if (!confirmed(formData)) return finish(bad("Confirm that billed texting should be switched on. Nothing changed."));
  if (limited(admin.id, "switch-on", 10)) return finish(bad(TOO_MANY));
  const res = await setBilledTextingSwitch(createAdminClient(), { actorId: admin.id, enabled: true, reason });
  if (!res.ok) return finish(bad(res.message));
  return finish({ ok: true, message: "Billed texting is now ON. This opens the database switch only: every text is still checked (active location and sender, price, credit, monthly limit, usage reconciler)." });
}

export async function switchBilledTextingOffAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("aal2");
  const reason = reasonFrom(formData);
  if (!reason) return finish(bad(BAD_REASON));
  if (!confirmed(formData)) return finish(bad("Confirm that billed texting should be switched off. Nothing changed."));
  if (limited(admin.id, "switch-off", 20)) return finish(bad(TOO_MANY));
  const res = await setBilledTextingSwitch(createAdminClient(), { actorId: admin.id, enabled: false, reason });
  if (!res.ok) return finish(bad(res.message));
  return finish({ ok: true, message: "Billed texting is now OFF. New billed texts are refused. Texts already reserved or sent are not recalled." });
}
