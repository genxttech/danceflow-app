import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IsvNumberAdapter } from "./twilioIsv/numberTypes";
import { buildSenderEvidence, digestOf, expectedInboundUrl, senderReadProviderFromEnv, senderVerifyReadsAllowed, type SenderReadProvider } from "./senderVerification";
import { SubaccountTokenProvider } from "./twilioIsv/account";
import { fakeAdapterAllowed, loadIsvConfig, numberCallsAllowed } from "./twilioIsv/config";
import { FakeNumberHub } from "./twilioIsv/fakeNumbers";
import { createRealIsvParent, createScopedNumberAdapter, messagingTokenProvider } from "./twilioIsv/real";
import { rotatingSubaccountAdapter } from "./twilioIsv/rotation";
import { IsvApiError } from "./twilioIsv/types";

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

/** On failure, `message` carries the database's own text for PARSING only (the TW042 unmet list); it is never shown to anyone verbatim. */
export type StepResult<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; code: string; message?: string };

type Client = Pick<SupabaseClient, "rpc">;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

async function rpc<T>(admin: Client, fn: string, args: Record<string, unknown>): Promise<StepResult<T>> {
  const { data, error } = (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  if (error) return typeof error.message === "string" ? { ok: false, code: String(error.code ?? "unknown"), message: error.message } : { ok: false, code: String(error.code ?? "unknown") };
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

/** The only part of a number adapter compliance validation may use: two GET reads plus its identity. No purchase, attach or release method is reachable. */
export type ComplianceReadAdapter = Pick<IsvNumberAdapter, "accountSid" | "evidenceSource" | "getCampaignCompliance" | "getServiceRoute">;

/**
 * Compliance validation: reads the campaign's opt-in / opt-out / help keywords and reply messages and the service route from the provider (subaccount
 * credentials, GET only) and hands the NORMALIZED facts to the database, which computes passed / failed. A failed read is an error, never a pass.
 */
export async function runComplianceValidation(
  admin: Client,
  adapter: ComplianceReadAdapter,
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// TW-4F J4: the platform-admin activation console (labels, refusal messages, the panel loader and the env-gated provider reads)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export const ACTIVATION_FLASH_COOKIE = "tw4_activation_flash";

/** Onboarding states the console lists: from "campaign verified" onwards. Nothing earlier can reach activation. */
export const ACTIVATION_STATES: readonly string[] = ["campaign_pending", "ready_for_activation", "active", "suspended"];

/** What each checklist item means. An id that is not listed here is still shown (generic label plus its raw detail), never hidden. */
export const ACTIVATION_ITEM_LABELS: Record<string, string> = {
  subaccount_active: "The business's Twilio subaccount is active",
  service_ready: "The location's Messaging Service is confirmed by the provider",
  campaign_verified: "The A2P campaign is verified",
  number_owned: "The phone number is owned by the subaccount",
  number_attached: "The phone number is attached to the Messaging Service",
  sender_ready: "The sender is verified and matches the ledger",
  opt_out_attested: "Advanced Opt-Out is attested (within 30 days)",
  compliance_passed: "Compliance validation passed (within 24 hours)",
  rfl_ready: "The recurring provider-fee lifecycle covers this number and campaign",
  inventory_reconciled: "The provider inventory was reconciled with the ledger (within 24 hours)",
  inbound_route_pinned: "The inbound webhook route is pinned",
  usage_reconciler_ready: "Billed usage is reconciled with the provider on schedule",
  funding_continuity: "Provider fees are funded for the current period",
  pilot_ki1_redecided: "Pilot ceiling issue KI-1 is re-decided by the owner",
};

export function activationItemLabel(id: string): string {
  return ACTIVATION_ITEM_LABELS[id] ?? `Checklist item "${id || "?"}"`;
}

const KI1_REASON = "The owner has not re-decided KI-1 (pilot ceiling double capture). No flag, switch or admin action lifts this: only the owner's re-decision followed by a later migration.";

const DETAIL_REASONS: Record<string, string> = {
  ok: "Met.",
  no_active_subaccount: "The business has no active Twilio subaccount.",
  service_not_ready: "No provider-confirmed Messaging Service for this location.",
  campaign_not_verified: "The campaign is not verified yet.",
  no_purchase: "No provider-confirmed number purchase in the ledger.",
  no_attachment: "The number is not attached to the Messaging Service.",
  ownership_not_confirmed: "The provider's read-back no longer confirms that the subaccount owns the purchased number.",
  attachment_differs_from_purchase: "The attachment in the ledger is for a different number than the purchase.",
  attachment_not_confirmed: "The provider's read-back no longer confirms the number is attached to the Messaging Service.",
  sender_not_verified_or_stale: "The sender is not verified, or its verification is stale. Record it from the ledger, then verify it.",
  sender_differs_from_ledger: "The ready sender does not match the ledger's service, campaign or number.",
  attestation_missing_or_stale: "No current Advanced Opt-Out attestation for this service and campaign.",
  no_compliance_check: "Compliance validation has not been run.",
  compliance_failed_or_stale: "The last compliance validation failed, is older than 24 hours, or was judged against another inbound route.",
  rfl_not_installed: "The recurring provider-fee lifecycle is not installed in this database.",
  rfl_inventory_differs_from_ledger: "The provider-fee inventory does not hold this ledger's number and campaign.",
  no_inventory_check: "The provider inventory has never been reconciled for this business.",
  inventory_has_unknown_numbers: "The provider inventory holds numbers the ledger does not know.",
  inventory_missing_ledger_numbers: "Ledger numbers are missing from the provider inventory.",
  inventory_account_differs: "The inventory was read in a different account.",
  inventory_check_stale: "The last inventory reconciliation is older than 24 hours.",
  inbound_route_not_pinned: "The inbound webhook route is not pinned.",
  // usage reconciler readiness
  reconciler_gate_not_installed: "The usage reconciler readiness check is not installed in this database.",
  reconciler_error: "The usage reconciler readiness could not be read.",
  reconciler_not_ready: "The usage reconciler is not ready.",
  no_completed_run: "The usage reconciler has never completed a run.",
  no_evidence_reads: "The usage reconciler has no provider evidence reads.",
  evidence_failing: "The usage reconciler's provider evidence reads are failing.",
  stale: "The last usage reconciliation is too old.",
  stuck_lease: "A usage reconciler run is stuck holding its lease.",
  // funding continuity (non-pilot)
  campaign_authorization_short_or_missing: "The owner's recurring authorization for campaign fees is missing or too short.",
  number_authorization_short_or_missing: "The owner's recurring authorization for number rent is missing or too short.",
  campaign_rent_unfunded: "The campaign fee for the current period is not funded.",
  number_rent_unfunded: "The number rent for the current period is not funded.",
  charge_unfunded: "A provider charge is not funded.",
  no_registration_path: "The business has no verified registration path.",
  no_legal_entity: "The location is not linked to a legal business.",
  credit_on_hold: "The business's credit account is on hold.",
  // funding continuity (pilot business)
  pilot_current_period_unapproved: "Pilot: the current period's provider fees are not approved or covered.",
  pilot_number_not_registered: "Pilot: the number is not registered in the provider-fee inventory.",
  pilot_campaign_not_registered: "Pilot: the campaign is not registered in the provider-fee inventory.",
  pilot_resources_unconfirmed: "Pilot: the number or campaign is not confirmed by the provider.",
  pilot_ceiling_exceeded: "Pilot: the pilot spending ceiling would be exceeded.",
  pilot_standing_authorization_present: "Pilot: a standing recurring authorization exists, which the pilot business may not have.",
  pilot_approval_needed: "Pilot: an owner approval is needed.",
  pilot_month_two_undefined: "Pilot: funding beyond the first month is not defined.",
  // KI-1 (20261226)
  ki1_owner_redecision_pending: KI1_REASON,
  "ki1_owner_redecision_pending:lifted_only_by_migration": KI1_REASON,
  not_pilot: "Not the pilot business; this does not apply.",
};

/** A plain reason for a detail code. Unknown codes fall back to a generic line; the raw code is always shown next to it by the UI. */
export function activationDetailReason(detail: string, ok: boolean): string {
  if (Object.hasOwn(DETAIL_REASONS, detail)) return DETAIL_REASONS[detail];
  if (detail.startsWith("rfl_blockers:")) return "The recurring provider-fee lifecycle reports blockers (listed in the code).";
  if (detail.startsWith("ki1_owner_redecision_pending")) return KI1_REASON;
  return ok ? "Met." : "Not met (see the code).";
}

/** The KI-1 gate is closed for this location: the item is present and not ok. The database enforces it; the console only explains it. */
export function ki1Blocking(items: ActivationItem[]): boolean {
  return items.some((i) => i.id === "pilot_ki1_redecided" && !i.ok);
}

const ITEM_ID = /^([a-z][a-z0-9_]{0,63}):(.*)$/;
const printableDetail = (v: string) => v.replace(/[^\x20-\x7e]/g, " ").slice(0, 120);

/**
 * The unmet items of a TW042 refusal ("activation checklist unmet: id:detail,id:detail"). A detail may itself contain commas (rfl_blockers:[...]), so a piece
 * that does not start a new "id:" is appended to the previous detail. A message without the expected prefix gives an empty list (never a guess).
 */
export function parseUnmetItems(message: string | null | undefined): { id: string; detail: string }[] {
  if (typeof message !== "string") return [];
  const marker = "activation checklist unmet:";
  const at = message.indexOf(marker);
  if (at < 0) return [];
  const out: { id: string; detail: string }[] = [];
  for (const piece of message.slice(at + marker.length, at + marker.length + 2000).trim().split(",")) {
    const m = ITEM_ID.exec(piece.trim());
    if (m) {
      if (out.length >= 30) break;
      out.push({ id: m[1], detail: m[2] });
    } else if (out.length) {
      out[out.length - 1].detail += `,${piece}`;
    }
  }
  return out.map((i) => ({ id: i.id, detail: printableDetail(i.detail) }));
}

/** The flash banner holds at most this many characters (panelFlash.ts truncates at 400). */
export const ACTIVATION_MESSAGE_MAX = 400;
const KI1_LINE = " KI-1 (pilot ceiling double capture) must be re-decided by the owner; only a later migration lifts it.";

/**
 * The TW042 message, always within the flash cap: the KI-1 line first when that item is unmet, then "N items unmet: ..." with as many items as fit (the
 * rest summarized by "…"), and "Nothing changed." always last. Truncation only ever shortens the item list.
 */
export function checklistUnmetMessage(unmet: { id: string; detail: string }[]): string {
  const head = "The activation checklist is not met.";
  const tail = " Nothing changed.";
  const ki1 = unmet.some((i) => i.id === "pilot_ki1_redecided");
  const items = [...unmet.filter((i) => i.id === "pilot_ki1_redecided"), ...unmet.filter((i) => i.id !== "pilot_ki1_redecided")];
  const prefix = head + (ki1 ? KI1_LINE : "");
  if (items.length === 0) return prefix + tail;
  const intro = ` ${items.length} item${items.length === 1 ? "" : "s"} unmet: `;
  const budget = ACTIVATION_MESSAGE_MAX - prefix.length - tail.length - intro.length - 2; // room for "…" / "."
  let list = "";
  let shown = 0;
  for (const i of items) {
    const entry = `${shown ? "; " : ""}${activationItemLabel(i.id)} (${i.detail || "?"})`;
    if (list.length + entry.length > budget) break;
    list += entry;
    shown += 1;
  }
  if (shown === 0) list = items.map((i) => i.id).join(", ").slice(0, Math.max(0, budget));
  const more = shown < items.length;
  return `${prefix}${intro}${list}${more ? " …" : "."}${tail}`;
}

/** Plain-language mapping of a refusal (database codes and this module's own codes). Database text is never forwarded; only the parsed TW042 item list is. */
export function activationErrorMessage(code: string, message?: string): string {
  switch (code) {
    case "42501": return "Not authorized, or activation is not available for this studio. Nothing changed.";
    case "TW030": return "The location is not in an onboarding state that allows this step. Reload the page. Nothing changed.";
    case "55P03": return "A provisioning run holds this studio's lease right now. Try again when it finishes. Nothing changed.";
    case "TW041": return "The Advanced Opt-Out attestation or a passed compliance validation for this service and campaign is missing. Nothing changed.";
    case "TW042": return checklistUnmetMessage(parseUnmetItems(message));
    case "TW044": return "The inbound route is not pinned, or the service's inbound route differs from the pin. Nothing changed.";
    case "TW032": return "The Messaging Service, campaign or number is not confirmed by the provider. Nothing changed.";
    case "TW021": return "The sender row is not the current one for this location. Reload the page. Nothing changed.";
    case "22023": return "The database refused the input (check the note, the checklist and the evidence reference). Nothing changed.";
    case "provider_reads_disabled": return "Provider reads are not enabled in this environment. Nothing was read or recorded.";
    case "app_url_not_configured": return "The application URL is not configured, so the inbound route cannot be checked. Nothing was recorded.";
    case "campaign_not_verified": return "The ledger has no verified service and campaign to validate. Nothing was recorded.";
    case "account_mismatch": return "The provider read would run in a different account than the ledger's subaccount. Nothing was recorded.";
    case "provider_read_failed": return "The provider could not be read. A failed read is never a pass; nothing was recorded. Try again later.";
    case "ledger_incomplete": return "The ledger does not hold a complete service, campaign and number yet. Nothing was recorded.";
    case "sender_not_recorded": return "No current sender is recorded. Record the sender from the ledger first. Nothing was recorded.";
    default: return "The action failed. Nothing changed; reload and check the current state before trying again.";
  }
}

export type ActivationOverview = Record<string, ActivationCheck | "unavailable">;

/** One checklist per studio; each read degrades on its own to "unavailable" (an unreadable checklist must never look ready or empty). */
export async function loadActivationOverview(admin: Client, actorId: string, studioIds: string[]): Promise<ActivationOverview> {
  const out: ActivationOverview = {};
  await Promise.all(
    studioIds.map(async (studioId) => {
      try {
        const res = await activationCheck(admin, studioId, actorId);
        out[studioId] = res.ok ? res.data : "unavailable";
      } catch {
        out[studioId] = "unavailable";
      }
    }),
  );
  return out;
}

type Env = Record<string, string | undefined>;

export type ComplianceReadRuntime = { ok: true; mode: "fake" | "real"; adapterFor(accountSid: string): Promise<ComplianceReadAdapter> } | { ok: false; reason: string };

/** A read-only view of an adapter: a new object holding only the two GET reads, so the purchase methods are unreachable at run time as well as by type. */
function readOnly(adapter: IsvNumberAdapter): ComplianceReadAdapter {
  return Object.freeze({
    accountSid: adapter.accountSid,
    evidenceSource: adapter.evidenceSource,
    getCampaignCompliance: (messagingServiceSid: string, campaignSid: string) => adapter.getCampaignCompliance(messagingServiceSid, campaignSid),
    getServiceRoute: (messagingServiceSid: string) => adapter.getServiceRoute(messagingServiceSid),
  });
}

const globalForCompliance = globalThis as unknown as { __tw4ComplianceHub?: FakeNumberHub; __tw4ComplianceTokens?: SubaccountTokenProvider };

/**
 * The read-only number adapter compliance validation reads the campaign and the service route with (GET only). Built from the existing gates, like the F4
 * evidence console: non-production + TW4_ISV_FAKE=on + a loopback database -> the local fake (its evidence is `fake`, accepted only on a local QA database);
 * the real adapter only where `createScopedNumberAdapter` itself allows one (production + every number gate on + complete configuration). Anything else,
 * which is every environment today, is a refusal: nothing is constructed and nothing is called.
 *
 * GATE COUPLING (owner-accepted activation prerequisite, pending a dedicated read-only gate): no read-only gate exists for number adapters yet, so REAL
 * compliance reads currently require the number-call switches TW4_ISV_REAL_CALLS, TW4_PROVISIONING_REAL_CALLS and TW4_NUMBER_REAL_CALLS (plus a production
 * build and deployment), the same switches that allow buying numbers. The adapter handed out is narrowed to the two GET reads (`readOnly`), so nothing
 * here can purchase, attach or release a number even with those switches on.
 */
export function complianceReadRuntime(env: Env = process.env): ComplianceReadRuntime {
  if (fakeAdapterAllowed(env)) {
    const hub = (globalForCompliance.__tw4ComplianceHub ??= new FakeNumberHub());
    return { ok: true, mode: "fake", adapterFor: async (accountSid) => readOnly(hub.adapterFor(accountSid)) };
  }
  const gate = numberCallsAllowed(env);
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  const loaded = loadIsvConfig(env);
  if (!loaded.ok) return { ok: false, reason: `Twilio is not configured (missing: ${loaded.missing.join(", ")}).` };
  const parent = createRealIsvParent(loaded.config, env);
  const tokens = (globalForCompliance.__tw4ComplianceTokens ??= new SubaccountTokenProvider(parent, { refreshIntervalMs: 0 }));
  return {
    ok: true,
    mode: "real",
    adapterFor: async (accountSid) =>
      readOnly(await rotatingSubaccountAdapter(accountSid, tokens, (sid, secret) => {
        try {
          return createScopedNumberAdapter(loaded.config, sid, secret.reveal(), env);
        } catch (error) {
          throw error instanceof IsvApiError ? error : new IsvApiError("account", null, null, "subaccount adapter unavailable");
        }
      })),
  };
}

/** The sender read provider for activation: exactly what the sender-readiness actions use (the fake only where allowed, real reads only when gated on). */
export function activationSenderReadProvider(env: Env = process.env): SenderReadProvider | null {
  return senderReadProviderFromEnv(env, messagingTokenProvider(env));
}

/** Whether each provider read is enabled here, for the console's explanation only (the actions decide again on every call). Constructs nothing. */
export function activationProviderReads(env: Env = process.env): { compliance: { enabled: boolean; reason: string | null }; sender: { enabled: boolean; reason: string | null } } {
  if (fakeAdapterAllowed(env)) return { compliance: { enabled: true, reason: null }, sender: { enabled: true, reason: null } };
  const number = numberCallsAllowed(env);
  const sender = senderVerifyReadsAllowed(env);
  return {
    compliance: number.allowed ? { enabled: true, reason: null } : { enabled: false, reason: number.reason },
    sender: sender.allowed ? { enabled: true, reason: null } : { enabled: false, reason: sender.reason },
  };
}
