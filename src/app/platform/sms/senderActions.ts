"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit";
import { senderReadProviderFromEnv, verifySender, type SenderTokenProvider } from "@/lib/sms/senderVerification";
import { normalizeSmsPhone } from "@/lib/sms/compliance";
import { messagingTokenProvider } from "@/lib/sms/twilioIsv/real";
import { encodePanelFlash, PANEL_FLASH_COOKIE, PANEL_FLASH_MAX_AGE_SECONDS } from "@/lib/sms/twilioIsv/panelFlash";

/**
 * TW-4F sender readiness, platform-admin actions. The actor always comes from the session. Verification performs its provider reads on the server:
 * nothing the form carries is ever evidence (only the studio, the sender row and the opt-out attestation checkbox are read from it).
 */

const RETURN_PATH = "/platform/sms";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MG = /^MG[0-9a-fA-F]{32}$/;
const QE = /^QE[0-9a-fA-F]{32}$/;
const PN = /^PN[0-9a-fA-F]{32}$/;

type Result = { ok: boolean; message: string };

/**
 * The subaccount token source for the real read provider: the process-wide messaging token provider (memory only, 60 s, spaced re-reads; gated by a
 * production deployment and SMS_SENDER_VERIFY_READS / SMS_BILLED_REAL_SEND). Null elsewhere: then only the local fake can verify.
 */
function senderTokens(): SenderTokenProvider | null {
  return messagingTokenProvider(process.env);
}

async function finish(result: Result, studioId: string): Promise<never> {
  revalidatePath(RETURN_PATH);
  (await cookies()).set(PANEL_FLASH_COOKIE, encodePanelFlash(result), {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: RETURN_PATH, maxAge: PANEL_FLASH_MAX_AGE_SECONDS,
  });
  const focus = UUID.test(studioId) ? `&studio=${studioId}` : "";
  redirect(`${RETURN_PATH}?${result.ok ? "panel" : "panel_error"}=1${focus}#subaccount-panel`);
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();

function limited(adminId: string, scope: string, studioId: string, limit: number): boolean {
  return !checkRateLimit(rateLimitKey(`platform:sender:${scope}`, adminId, studioId), { limit, windowMs: 10 * 60 * 1000 }).allowed;
}

function recordFailure(code: string | undefined): string {
  if (code === "23505") return "That phone number, Messaging Service or campaign is already in use by another location or business. Nothing was recorded.";
  if (code === "TW015") return "This legal business has no active subaccount yet. Nothing was recorded.";
  if (code === "22023") return "Check the identifiers (Messaging Service, campaign, phone number SID, a US number) and give a reason of at least 10 characters.";
  return "The sender could not be recorded. Nothing changed.";
}

export async function recordSenderAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const studioId = text(formData, "studioId");
  if (!UUID.test(studioId)) return finish({ ok: false, message: "That studio could not be identified." }, studioId);
  const messagingServiceSid = text(formData, "messagingServiceSid");
  const campaignSid = text(formData, "campaignSid");
  const phoneNumberSid = text(formData, "phoneNumberSid");
  const e164 = normalizeSmsPhone(text(formData, "senderE164"));
  const reason = text(formData, "reason");
  if (!MG.test(messagingServiceSid) || !QE.test(campaignSid) || !PN.test(phoneNumberSid) || !e164 || reason.length < 10 || reason.length > 300) {
    return finish({ ok: false, message: "Enter a Messaging Service (MG...), campaign (QE...), phone number SID (PN...), the number in +1 form, and a reason of 10 to 300 characters." }, studioId);
  }
  if (limited(admin.id, "record", studioId, 20)) return finish({ ok: false, message: "Too many attempts. Wait a few minutes and try again." }, studioId);
  const { error } = await createAdminClient().rpc("tw4_sender_record", {
    p_studio_id: studioId, p_actor: admin.id, p_messaging_service_sid: messagingServiceSid, p_campaign_sid: campaignSid,
    p_phone_number_sid: phoneNumberSid, p_sender_e164: e164, p_reason: reason,
  });
  if (error) return finish({ ok: false, message: recordFailure(String(error.code ?? "")) }, studioId);
  return finish({ ok: true, message: "Sender recorded as pending. It sends nothing until it is verified." }, studioId);
}

export async function verifySenderAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const studioId = text(formData, "studioId");
  const senderId = text(formData, "senderId");
  if (!UUID.test(studioId) || !UUID.test(senderId)) return finish({ ok: false, message: "That sender could not be identified." }, studioId);
  if (limited(admin.id, "verify", studioId, 6)) return finish({ ok: false, message: "Too many verification attempts. Wait a few minutes and try again." }, studioId);
  const provider = senderReadProviderFromEnv(process.env, senderTokens());
  if (!provider) return finish({ ok: false, message: "Sender verification is not enabled in this environment. Nothing was checked." }, studioId);
  // only the checkbox comes from the form; the evidence is read here, from the provider
  const result = await verifySender(createAdminClient(), provider, { studioId, senderId, actorId: admin.id, attestedOptOut: formData.get("attestedOptOut") === "on" });
  switch (result.outcome) {
    case "verified": return finish({ ok: true, message: "Sender verified. This location can now send billed texts through it." }, studioId);
    case "failed": return finish({ ok: false, message: `Verification failed (${result.code ?? "unknown"}). The sender is not ready.` }, studioId);
    case "inconclusive": return finish({ ok: false, message: `Twilio could not be read right now (${result.code ?? "unknown"}). Nothing changed; try again shortly.` }, studioId);
    default: return finish({ ok: false, message: "Verification could not be completed. Nothing changed." }, studioId);
  }
}

export async function revokeSenderAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const studioId = text(formData, "studioId");
  const reason = text(formData, "reason");
  if (!UUID.test(studioId)) return finish({ ok: false, message: "That studio could not be identified." }, studioId);
  if (reason.length < 10 || reason.length > 300) return finish({ ok: false, message: "Give a reason of 10 to 300 characters." }, studioId);
  if (limited(admin.id, "revoke", studioId, 20)) return finish({ ok: false, message: "Too many attempts. Wait a few minutes and try again." }, studioId);
  const release = formData.get("release") === "on";
  const { error } = await createAdminClient().rpc("tw4_sender_revoke", { p_studio_id: studioId, p_actor: admin.id, p_reason: reason, p_release: release });
  if (error) return finish({ ok: false, message: "The sender could not be revoked. Nothing changed." }, studioId);
  return finish({ ok: true, message: release ? "Sender released. Its identifiers can be used again." : "Sender revoked. No billed text can be sent through it." }, studioId);
}
