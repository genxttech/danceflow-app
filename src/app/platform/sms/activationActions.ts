"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { encodePanelFlash, PANEL_FLASH_MAX_AGE_SECONDS } from "@/lib/sms/twilioIsv/panelFlash";
import {
  ACTIVATION_FLASH_COOKIE, activate, activationCheck, activationErrorMessage, activationSenderReadProvider, attestOptOut, complianceReadRuntime, markReady,
  recordSenderFromLedger, runComplianceValidation, suspend, verifyForActivation, type OptOutChecklist,
} from "@/lib/sms/activation";

/**
 * TW-4F J4: platform-administrator activation console entry points (manual release only, owner decision D8). Every action runs `requirePlatformAdmin` FIRST
 * and takes the actor from that session. The browser supplies only a studio id (validated as a UUID), the administrator's written note or reason, the
 * Advanced Opt-Out checkboxes and an evidence reference; every provider identifier comes from the ledger (`tw4_act_check().ledger`) on the server. The
 * database re-checks the administrator, the state and the whole checklist on every call, so a button the console disabled is not trusted either way.
 * The only provider contact is the read-only, env-gated compliance and sender reads (switched off everywhere today). Nothing here writes to Twilio, sends
 * SMS, charges, or schedules anything. The result travels in a short-lived httpOnly cookie, never the URL.
 */

const RETURN_PATH = "/platform/sms";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKLIST_KEYS = ["advanced_opt_out_enabled", "stop_keyword_confirmed", "start_keyword_confirmed", "help_keyword_confirmed", "confirmation_replies_confirmed"] as const;
const CODE = /^[A-Za-z0-9_:.-]{1,60}$/;

type Result = { ok: boolean; message: string };

async function finish(result: Result): Promise<never> {
  (await cookies()).set(ACTIVATION_FLASH_COOKIE, encodePanelFlash(result), { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: RETURN_PATH, maxAge: PANEL_FLASH_MAX_AGE_SECONDS });
  revalidatePath(RETURN_PATH);
  // redirect throws: it stays outside any try/catch
  redirect(`${RETURN_PATH}?${result.ok ? "activation=1" : "activation_error=1"}#sms-activation`);
}

/** A trimmed text field with Unicode format characters (\p{Cf}: bidi overrides, zero-width marks) removed before any length check or database call. */
const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.replace(/\p{Cf}/gu, "").trim() : "";
};
const checked = (form: FormData, name: string) => ["on", "yes", "true", "1"].includes(field(form, name).toLowerCase());
const printable = (v: string, min: number, max: number) => v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const bad = (message: string): Result => ({ ok: false, message });
const refused = (res: { code: string; message?: string }): Result => bad(activationErrorMessage(res.code, res.message));
const safeCode = (c: string | null | undefined) => (c && CODE.test(c) ? c : "unknown");

function limited(adminId: string, scope: string, studioId: string, limit: number): boolean {
  return !checkRateLimit(rateLimitKey(`platform:activation:${scope}`, adminId, studioId), { limit, windowMs: 10 * 60 * 1000 }).allowed;
}

/** The common prelude: a well-formed studio id and the per-administrator, per-studio rate limit. */
function studioFrom(form: FormData, adminId: string, scope: string, limit: number): { studioId: string } | { refusal: Result } {
  const studioId = field(form, "studioId");
  if (!UUID.test(studioId)) return { refusal: bad("Choose a location from the list.") };
  if (limited(adminId, scope, studioId, limit)) return { refusal: bad("Too many attempts. Wait a few minutes and try again.") };
  return { studioId };
}

/** Records (pending) the sender from the ledger's own service, campaign and number. No identifier is read from the form. */
export async function recordActivationSenderAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const s = studioFrom(formData, admin.id, "record", 20);
  if ("refusal" in s) return finish(s.refusal);
  if (!checked(formData, "confirm")) return finish(bad("Confirm that the sender should be recorded from the ledger's identifiers."));
  const res = await recordSenderFromLedger(createAdminClient(), s.studioId, admin.id);
  if (!res.ok) return finish(refused(res));
  return finish({ ok: true, message: `Sender recorded from the ledger (${res.data.status === "approved" ? "already approved" : "pending verification"}). It sends nothing until it is verified and the location is active.` });
}

/** Advanced Opt-Out is a Twilio Console setting (D4): the administrator attests every item with an evidence reference. Nothing is read from or written to Twilio. */
export async function attestOptOutAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const s = studioFrom(formData, admin.id, "attest", 20);
  if ("refusal" in s) return finish(s.refusal);
  if (!CHECKLIST_KEYS.every((k) => checked(formData, k))) return finish(bad("Every Advanced Opt-Out item must be confirmed in the Twilio Console before attesting. Nothing was recorded."));
  const evidenceRef = field(formData, "evidenceRef");
  if (!printable(evidenceRef, 10, 300)) return finish(bad("Give an evidence reference of 10 to 300 characters (for example a screenshot location or ticket). Nothing was recorded."));
  const checklist: OptOutChecklist = { advanced_opt_out_enabled: true, stop_keyword_confirmed: true, start_keyword_confirmed: true, help_keyword_confirmed: true, confirmation_replies_confirmed: true };
  const res = await attestOptOut(createAdminClient(), { studioId: s.studioId, actorId: admin.id, checklist, evidenceRef });
  if (!res.ok) return finish(refused(res));
  return finish({ ok: true, message: "Advanced Opt-Out attestation recorded with your name and evidence reference. It is valid for 30 days." });
}

/** Read-only compliance validation: GET reads of the ledger's campaign and service in the ledger's subaccount; the database judges the facts. */
export async function runComplianceAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const s = studioFrom(formData, admin.id, "compliance", 6);
  if ("refusal" in s) return finish(s.refusal);
  const runtime = complianceReadRuntime(process.env);
  if (!runtime.ok) return finish(bad(activationErrorMessage("provider_reads_disabled")));
  const db = createAdminClient();
  const check = await activationCheck(db, s.studioId, admin.id);
  if (!check.ok) return finish(refused(check));
  const accountSid = check.data.ledger.accountSid;
  if (!accountSid || !check.data.ledger.messagingServiceSid || !check.data.ledger.campaignSid) return finish(bad(activationErrorMessage("campaign_not_verified")));
  let adapter;
  try {
    adapter = await runtime.adapterFor(accountSid);
  } catch {
    return finish(bad(activationErrorMessage("provider_read_failed")));
  }
  const res = await runComplianceValidation(db, adapter, { studioId: s.studioId, actorId: admin.id });
  if (!res.ok) return finish(refused(res));
  if (res.data.outcome === "passed") return finish({ ok: true, message: `Compliance validation passed (${runtime.mode === "fake" ? "local fake provider" : "provider read"}). It is valid for 24 hours.` });
  const codes = res.data.codes.slice(0, 10).map(safeCode).join(", ");
  return finish(bad(`Compliance validation failed${codes ? ` (${codes})` : ""}. The result was recorded; fix the campaign or service in Twilio and run it again.`));
}

/** Read-only sender verification for activation (PR #249 evidence); the database derives the opt-out attestation itself and refuses without it (TW041). */
export async function verifyActivationSenderAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const s = studioFrom(formData, admin.id, "verify", 6);
  if ("refusal" in s) return finish(s.refusal);
  const provider = activationSenderReadProvider(process.env);
  if (!provider) return finish(bad(activationErrorMessage("provider_reads_disabled")));
  const res = await verifyForActivation(createAdminClient(), provider, { studioId: s.studioId, actorId: admin.id });
  if (!res.ok) return finish(refused(res));
  switch (res.data.outcome) {
    case "verified": return finish({ ok: true, message: `Sender verified (${provider.isFake ? "local fake provider" : "provider read"}). The location still sends nothing until it is activated.` });
    case "failed": return finish(bad(`Sender verification failed (${safeCode(res.data.code)}). The sender is not ready.`));
    case "inconclusive": return finish(bad(`Twilio could not be read completely (${safeCode(res.data.code)}). Nothing changed; try again shortly.`));
    default: return finish(bad("Sender verification was skipped. Nothing changed."));
  }
}

/** Mark ready: campaign_pending -> ready_for_activation. The database re-evaluates the checklist and refuses with TW042 if anything is unmet. */
export async function markReadyAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const s = studioFrom(formData, admin.id, "ready", 20);
  if ("refusal" in s) return finish(s.refusal);
  const note = field(formData, "note");
  if (!printable(note, 10, 300)) return finish(bad("Write a note of 10 to 300 characters. Nothing changed."));
  if (!checked(formData, "confirm")) return finish(bad("Confirm that you reviewed the checklist. Nothing changed."));
  const res = await markReady(createAdminClient(), s.studioId, admin.id, note);
  if (!res.ok) return finish(refused(res));
  return finish({ ok: true, message: "Marked ready for activation. Your name and note were recorded. Nothing was sent or charged." });
}

/** Manual activation: ready_for_activation or suspended -> active, only after the database re-checks the whole checklist in the same transaction. */
export async function activateAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const s = studioFrom(formData, admin.id, "activate", 10);
  if ("refusal" in s) return finish(s.refusal);
  const note = field(formData, "note");
  if (!printable(note, 10, 300)) return finish(bad("Write a note of 10 to 300 characters. Nothing changed."));
  if (!checked(formData, "confirm")) return finish(bad("Confirm the manual activation. Nothing changed."));
  const res = await activate(createAdminClient(), s.studioId, admin.id, note);
  if (!res.ok) return finish(refused(res));
  return finish({ ok: true, message: "Location activated. Your name and note were recorded. It can now send billed texts through its verified sender." });
}

/** Immediate stop: the sender is revoked and the location suspended. Always available for an active location (the pilot included); a reason is required. */
export async function suspendAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  // the emergency stop counts only well-formed submits against the rate limit: a mistyped reason never uses up the stop
  const studioId = field(formData, "studioId");
  if (!UUID.test(studioId)) return finish(bad("Choose a location from the list."));
  const reason = field(formData, "reason");
  if (!printable(reason, 10, 300)) return finish(bad("Give a reason of 10 to 300 characters. Nothing changed."));
  if (limited(admin.id, "suspend", studioId, 20)) return finish(bad("Too many attempts. Wait a few minutes and try again."));
  const res = await suspend(createAdminClient(), studioId, admin.id, reason);
  if (!res.ok) return finish(refused(res));
  return finish({ ok: true, message: "Location suspended and its sender revoked. Nothing can be sent. Reactivation needs the full checklist again." });
}
