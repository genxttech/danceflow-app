import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IsvNumberAdapter } from "./twilioIsv/numberTypes";
import { buildSenderEvidence, digestOf, expectedInboundUrl, type SenderReadProvider } from "./senderVerification";

/**
 * TW-4F R2b: the server half of sender activation. Every function here is a thin, typed round trip to a service-role `tw4_num_*` / `tw4_act_*` function: the
 * DATABASE decides every outcome (compliance verdict, attestation validity, sender verification, the activation checklist). Nothing here writes to Twilio, sends
 * SMS, charges, or schedules anything. Identifiers always come from the provisioning LEDGER (`tw4_act_check().ledger`), never from a form.
 *
 * PR #251 integration: after `activate`, the sender stays an `approved` PR #249 sender; the scheduled re-verification of PR #251 (and `tw4_sender_reverify`)
 * keeps its verification fresh. This module has no scheduler of its own.
 */

export type ActivationItem = { id: string; ok: boolean; detail: string };
export type ActivationLedger = {
  accountSid: string | null; messagingServiceSid: string | null; campaignSid: string | null; phoneNumberSid: string | null; e164: string | null; senderId: string | null;
};
export type ActivationCheck = { state: string | null; items: ActivationItem[]; ready: boolean; ledger: ActivationLedger };

export type StepResult<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; code: string };

type Client = Pick<SupabaseClient, "rpc">;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

async function rpc<T>(admin: Client, fn: string, args: Record<string, unknown>): Promise<StepResult<T>> {
  const { data, error } = (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
  if (error) return { ok: false, code: String(error.code ?? "unknown") };
  return { ok: true, data: data as T };
}

export function parseActivationCheck(raw: unknown): ActivationCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const l = (o.ledger && typeof o.ledger === "object" ? o.ledger : {}) as Record<string, unknown>;
  const items = Array.isArray(o.items)
    ? o.items.map((item) => {
        const i = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return { id: String(i.id ?? ""), ok: i.ok === true, detail: String(i.detail ?? "") };
      })
    : [];
  return {
    state: str(o.state), items, ready: o.ready === true,
    ledger: { accountSid: str(l.account_sid), messagingServiceSid: str(l.messaging_service_sid), campaignSid: str(l.campaign_sid), phoneNumberSid: str(l.phone_number_sid), e164: str(l.e164), senderId: str(l.sender_id) },
  };
}

export async function activationCheck(admin: Client, studioId: string, actorId: string): Promise<StepResult<ActivationCheck>> {
  const res = await rpc<unknown>(admin, "tw4_act_check", { p_studio_id: studioId, p_actor: actorId });
  if (!res.ok) return res;
  const parsed = parseActivationCheck(res.data);
  return parsed ? { ok: true, data: parsed } : { ok: false, code: "unexpected_answer" };
}

/** Records the sender (pending) in the PR #249 registry from the ledger's own identifiers. Idempotent. */
export async function recordSenderFromLedger(admin: Client, studioId: string, actorId: string): Promise<StepResult<{ sender_id: string; status: string }>> {
  return rpc(admin, "tw4_num_record_sender", { p_studio_id: studioId, p_actor: actorId });
}

export type OptOutChecklist = {
  advanced_opt_out_enabled: true; stop_keyword_confirmed: true; start_keyword_confirmed: true; help_keyword_confirmed: true; confirmation_replies_confirmed: true;
};

/** Advanced Opt-Out is a console setting Twilio does not expose to the API: a platform admin attests it, every item, with an evidence reference. */
export async function attestOptOut(admin: Client, input: { studioId: string; actorId: string; checklist: OptOutChecklist; evidenceRef: string }): Promise<StepResult<{ attestation_id: string }>> {
  return rpc(admin, "tw4_act_attest", { p_studio_id: input.studioId, p_actor: input.actorId, p_checklist: input.checklist, p_evidence_ref: input.evidenceRef });
}

export type ComplianceResult = { outcome: "passed" | "failed"; codes: string[] };

/**
 * Compliance validation: reads the campaign's opt-in / opt-out / help keywords and reply messages and the service route from the provider (subaccount
 * credentials, GET only) and hands the NORMALIZED facts to the database, which computes passed / failed. A failed read is an error, never a pass.
 */
export async function runComplianceValidation(
  admin: Client,
  adapter: IsvNumberAdapter,
  input: { studioId: string; actorId: string; inboundUrl?: string | null },
): Promise<StepResult<ComplianceResult>> {
  const inboundUrl = input.inboundUrl === undefined ? expectedInboundUrl() : input.inboundUrl;
  if (!inboundUrl) return { ok: false, code: "app_url_not_configured" };
  const check = await activationCheck(admin, input.studioId, input.actorId);
  if (!check.ok) return check;
  const { accountSid, messagingServiceSid, campaignSid } = check.data.ledger;
  if (!accountSid || !messagingServiceSid || !campaignSid) return { ok: false, code: "campaign_not_verified" };
  // the adapter must be the studio's own subaccount: a read made in another account proves nothing about this business
  if (adapter.accountSid !== accountSid) return { ok: false, code: "account_mismatch" };
  let campaign;
  let service;
  try {
    [campaign, service] = await Promise.all([adapter.getCampaignCompliance(messagingServiceSid, campaignSid), adapter.getServiceRoute(messagingServiceSid)]);
  } catch {
    return { ok: false, code: "provider_read_failed" };
  }
  const facts = { campaign, service };
  const res = await rpc<{ outcome: "passed" | "failed"; codes: string[] }>(admin, "tw4_act_compliance_record", {
    p_studio_id: input.studioId, p_actor: input.actorId, p_facts: facts, p_expected_inbound: inboundUrl, p_source: adapter.evidenceSource, p_digest: digestOf(facts),
  });
  if (!res.ok) return res;
  return { ok: true, data: { outcome: res.data.outcome === "passed" ? "passed" : "failed", codes: Array.isArray(res.data.codes) ? res.data.codes : [] } };
}

export type VerifyForActivation = { outcome: "verified" | "failed" | "inconclusive" | "skipped"; code: string | null };

/**
 * Verifies the current sender with provider reads (PR #249's evidence) through `tw4_act_verify_sender`, which derives the Advanced Opt-Out attestation itself
 * from a current attestation plus a passed compliance validation for the sender's own service and campaign. Without them the database refuses (TW041).
 */
export async function verifyForActivation(
  admin: Client,
  provider: SenderReadProvider,
  input: { studioId: string; actorId: string; inboundUrl?: string | null },
): Promise<StepResult<VerifyForActivation>> {
  const inboundUrl = input.inboundUrl === undefined ? expectedInboundUrl() : input.inboundUrl;
  if (!inboundUrl) return { ok: false, code: "app_url_not_configured" };
  const check = await activationCheck(admin, input.studioId, input.actorId);
  if (!check.ok) return check;
  const { accountSid, messagingServiceSid, campaignSid, phoneNumberSid, senderId } = check.data.ledger;
  if (!accountSid || !messagingServiceSid || !campaignSid || !phoneNumberSid) return { ok: false, code: "ledger_incomplete" };
  if (!senderId) return { ok: false, code: "sender_not_recorded" };
  const evidence = await buildSenderEvidence(provider, { accountSid, messagingServiceSid, campaignSid, phoneNumberSid }, inboundUrl);
  const res = await rpc<{ outcome: string; code: string | null }>(admin, "tw4_act_verify_sender", {
    p_studio_id: input.studioId, p_sender_id: senderId, p_actor: input.actorId, p_evidence: evidence, p_source: provider.isFake ? "fake" : "provider_read",
  });
  if (!res.ok) return res;
  const outcome = res.data.outcome;
  if (outcome !== "verified" && outcome !== "failed" && outcome !== "inconclusive" && outcome !== "skipped") return { ok: false, code: "unexpected_answer" };
  return { ok: true, data: { outcome, code: str(res.data.code) } };
}

export async function markReady(admin: Client, studioId: string, actorId: string, note: string): Promise<StepResult<{ state: string }>> {
  return rpc(admin, "tw4_act_mark_ready", { p_studio_id: studioId, p_actor: actorId, p_note: note });
}

/** `active` is reached only here, after the database re-evaluates the whole checklist in the same transaction as the state change. */
export async function activate(admin: Client, studioId: string, actorId: string, note: string): Promise<StepResult<{ state: string }>> {
  return rpc(admin, "tw4_act_activate", { p_studio_id: studioId, p_actor: actorId, p_note: note });
}

export async function suspend(admin: Client, studioId: string, actorId: string, reason: string): Promise<StepResult<{ state: string }>> {
  return rpc(admin, "tw4_act_suspend", { p_studio_id: studioId, p_actor: actorId, p_reason: reason });
}
