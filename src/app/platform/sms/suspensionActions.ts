"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePlatformStepUp } from "@/lib/auth/platform-assurance";
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { encodePanelFlash, PANEL_FLASH_MAX_AGE_SECONDS } from "@/lib/sms/twilioIsv/panelFlash";
import { runSubaccountStatusChange, runSubaccountVerification, suspensionCallsAllowed, suspensionMessage, type SuspensionAction } from "@/lib/sms/twilioIsv/suspension";
import { createRealSuspensionProvider } from "@/lib/sms/twilioIsv/suspensionReal";

/**
 * TW-4F slice E: the ONLY entry points to the DanceFlow traffic hold and the EMERGENCY Twilio subaccount suspension / reactivation
 * (docs/twilio/TW-4F_Emergency_Subaccount_Suspension.md). DARK: suspension needs the database switch AND TW4_SUBACCOUNT_SUSPENSION_CALLS=on, both off.
 * No page renders these actions yet (follow-up F-2). Every action runs the step-up guard FIRST and takes the actor from that session; the database derives
 * the actor again from the administrator's own token for suspension. Suspension is NOT a spending ceiling and NOT a response to low credit.
 */

const RETURN_PATH = "/platform/sms";
const SUSPENSION_FLASH_COOKIE = "tw4_suspension_flash";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{16,80}$/;

type Result = { ok: boolean; message: string };

async function finish(result: Result): Promise<never> {
  (await cookies()).set(SUSPENSION_FLASH_COOKIE, encodePanelFlash(result), { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: RETURN_PATH, maxAge: PANEL_FLASH_MAX_AGE_SECONDS });
  revalidatePath(RETURN_PATH);
  // redirect throws: it stays outside any try/catch
  redirect(`${RETURN_PATH}?${result.ok ? "suspension=1" : "suspension_error=1"}#sms-suspension`);
}

/** A trimmed text field with Unicode format characters removed before any check or database call. */
const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.replace(/\p{Cf}/gu, "").trim() : "";
};
const printable = (v: string, min: number, max: number) => v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const bad = (message: string): Result => ({ ok: false, message });
const limited = (adminId: string, scope: string, studioId: string) =>
  !checkRateLimit(rateLimitKey(`platform:suspension:${scope}`, adminId, studioId), { limit: 6, windowMs: 10 * 60 * 1000 }).allowed;

/** The deployment's parent account and its credentials (never logged, never put in a message). */
function parentCredentials(): { accountSid: string; authToken: string } {
  return { accountSid: String(process.env.TWILIO_ACCOUNT_SID ?? "").trim(), authToken: String(process.env.TWILIO_AUTH_TOKEN ?? "").trim() };
}

async function changeStatus(adminId: string, form: FormData, action: SuspensionAction): Promise<Result> {
  const studioId = field(form, "studioId");
  if (!UUID.test(studioId)) return bad("Choose a location from the list. Nothing changed.");
  const input = {
    studioId, action,
    studioName: field(form, "confirmStudioName"),
    sidTail: field(form, "confirmSidTail"),
    authorizationRef: field(form, "authorizationRef"),
    reason: field(form, "reason"),
    idempotencyKey: field(form, "idempotencyKey"),
  };
  if (!KEY.test(input.idempotencyKey)) return bad("The form is out of date. Reload the page and try again. Nothing changed.");
  if (!printable(input.authorizationRef, 6, 120) || !printable(input.reason, 10, 300)) return bad(suspensionMessage({ kind: "refused", code: "missing_reason_or_authorization" }).message);
  if (!/^[0-9a-fA-F]{6}$/.test(input.sidTail) || !input.studioName) return bad("Type the location name and the last 6 characters of the subaccount SID. Nothing changed.");
  if (limited(adminId, action, studioId)) return bad("Too many attempts. Wait a few minutes and try again.");
  // gate 2 (environment) before anything else is touched
  if (!suspensionCallsAllowed(process.env).allowed) return bad(suspensionMessage({ kind: "refused", code: "disabled" }).message);
  const admin = createAdminClient();
  const creds = parentCredentials();
  let provider;
  try {
    provider = await createRealSuspensionProvider(admin, creds); // gate 1 (database switch) is read here
  } catch {
    return bad(suspensionMessage({ kind: "refused", code: "switched_off" }).message);
  }
  const result = await runSubaccountStatusChange({ user: await createClient(), admin, provider, parentSid: creds.accountSid }, input);
  return suspensionMessage(result);
}

/** EMERGENCY suspension of the location's business's Twilio subaccount. Blocks inbound too (STOP may not reach DanceFlow); number fees continue. */
export async function suspendSubaccountAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("fresh");
  return finish(await changeStatus(admin.id, formData, "suspend"));
}

/** Reactivation after a CONFIRMED suspension. It does not lift the traffic hold (reconcile opt-outs first; runbook 5.2). Never offers "closed". */
export async function reactivateSubaccountAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("fresh");
  return finish(await changeStatus(admin.id, formData, "reactivate"));
}

/** Read-only verification of an open attempt (unknown outcome or stuck): GET only, the observed state is recorded. */
export async function verifySubaccountAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("fresh");
  const studioId = field(formData, "studioId");
  if (!UUID.test(studioId)) return finish(bad("Choose a location from the list."));
  const reason = field(formData, "reason");
  if (!printable(reason, 10, 300)) return finish(bad("Give a reason of 10 to 300 characters."));
  if (limited(admin.id, "verify", studioId)) return finish(bad("Too many attempts. Wait a few minutes and try again."));
  if (!suspensionCallsAllowed(process.env).allowed) return finish(bad(suspensionMessage({ kind: "refused", code: "disabled" }).message));
  const db = createAdminClient();
  const creds = parentCredentials();
  let provider;
  try {
    provider = await createRealSuspensionProvider(db, creds);
  } catch {
    return finish(bad(suspensionMessage({ kind: "refused", code: "switched_off" }).message));
  }
  return finish(suspensionMessage(await runSubaccountVerification({ user: await createClient(), admin: db, provider, parentSid: creds.accountSid }, { studioId, reason })));
}

async function setHold(adminId: string, formData: FormData, hold: boolean): Promise<Result> {
  const studioId = field(formData, "studioId");
  if (!UUID.test(studioId)) return bad("Choose a location from the list. Nothing changed.");
  const reason = field(formData, "reason");
  if (!printable(reason, 10, 300)) return bad("Give a reason of 10 to 300 characters. Nothing changed.");
  if (limited(adminId, hold ? "hold" : "release", studioId)) return bad("Too many attempts. Wait a few minutes and try again.");
  const res = await createAdminClient().rpc("tw4_traffic_hold_set", { p_studio_id: studioId, p_hold: hold, p_actor: adminId, p_reason: reason });
  if (res.error) return bad("The hold could not be changed. Nothing changed.");
  return hold
    ? { ok: true, message: "DanceFlow traffic hold placed: no billed text is reserved or dispatched for this location and optional error replies stop. STOP, START and HELP still work. Twilio is not involved and continuing provider fees are not stopped." }
    : { ok: true, message: "DanceFlow traffic hold lifted for this location. Billed texts follow the usual checks again." };
}

/** DanceFlow-level hold (safe direction): plain aal2, like the other emergency stops. */
export async function placeTrafficHoldAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("aal2");
  return finish(await setHold(admin.id, formData, true));
}

/** Lifting the hold resumes traffic: fresh step-up. After a suspension, only after the opt-out reconciliation (runbook 5.2). */
export async function releaseTrafficHoldAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("fresh");
  return finish(await setHold(admin.id, formData, false));
}
