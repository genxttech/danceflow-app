import type { SenderOverviewRow } from "@/lib/sms/senderVerification";
import type { RunnerStatus } from "@/lib/sms/twilioIsv/store";
import type { OnboardingDisplayState } from "@/lib/sms/onboarding/stateMachine";

/**
 * TW-4F R2c: the platform-admin provisioning summary for one studio, as pure data. It reads what the existing panels already load (onboarding row,
 * runner evidence, sender overview) plus an OPTIONAL provisioning-ledger read (`operations`) that R2a will supply. It performs no action itself:
 * every `href` points at a control that already exists and enforces platform-admin authorization, so this view can neither widen access nor claim
 * that something happened. `operations === null` means the ledger read is not connected, which is shown as such.
 */

export type OperationKind = "messaging_service" | "campaign" | "number" | "number_attach";
export type OperationStatus = "in_flight" | "succeeded" | "failed" | "unknown_outcome" | "abandoned";
export type ProvisioningResourceView = { status: string | null; mismatchCode: string | null; providerStatus: string | null; failureReasons: string | null; observedAt: string | null; source: string | null };
export type ProvisioningOperationView = {
  id: string;
  kind: OperationKind | string;
  /** The ledger's own status. An unrecognized value is kept verbatim and treated as needing investigation, never as success or failure. */
  status: OperationStatus | string;
  feeBearing: boolean;
  attemptedAt: string | null;
  errorCode: string | null;
  // platform-admin-only detail (the ledger read is admin-only; none of this is ever sent to a studio owner)
  attempt?: number | null;
  providerSid?: string | null;
  feeKinds?: string[];
  errorDetail?: string | null;
  finishedAt?: string | null;
  superseded?: boolean;
  resolutionNote?: string | null;
  resolved?: boolean;
  resource?: ProvisioningResourceView | null;
};

export type AdminProvisioningInput = {
  studioId: string;
  state: OnboardingDisplayState | string | null;
  accessEnabled: boolean;
  evidence: RunnerStatus | undefined;
  sender: SenderOverviewRow | null;
  /** null = the ledger is not loaded for this studio. */
  operations: ProvisioningOperationView[] | null;
  /** True when the ledger read was attempted and failed: shown as unreadable, never as "no operations". */
  ledgerUnreadable?: boolean;
  /** False when the sender overview could not be loaded: sender chips then say "Not loaded" rather than "none recorded". Defaults to true. */
  sendersLoaded?: boolean;
};

export type AdminNext = {
  kind: "act" | "wait_studio" | "wait_provider" | "investigate" | "unavailable" | "done";
  title: string;
  detail: string;
  /** In-page anchor of an EXISTING control; null when there is nothing to click. */
  href: string | null;
};

export type AdminProvisioningView = {
  next: AdminNext;
  blockers: string[];
  unknownOutcomes: ProvisioningOperationView[];
  inFlight: ProvisioningOperationView[];
  campaign: { label: string; tone: "ok" | "wait" | "bad" | "idle" };
  number: { label: string; tone: "ok" | "wait" | "bad" | "idle" };
  optOut: { label: string; tone: "ok" | "wait" | "bad" | "idle" };
  sender: { label: string; tone: "ok" | "wait" | "bad" | "idle" };
};

const STUDIO_WAIT = new Set(["not_started", "draft", "needs_info"]);
const REVIEW = new Set(["submitted_for_checks", "profile_review"]);
const TROUBLE = new Set(["blocked", "exception", "suspended"]);

export function buildAdminProvisioningView(input: AdminProvisioningInput): AdminProvisioningView {
  const { state, sender, operations, evidence } = input;
  const ops = operations ?? [];
  const unknownOutcomes = ops.filter((o) => o.status === "unknown_outcome");
  const inFlight = ops.filter((o) => o.status === "in_flight");
  const failed = ops.filter((o) => o.status === "failed");
  const campaignOp = ops.filter((o) => o.kind === "campaign").slice(-1)[0] ?? null;

  const blockers: string[] = [];
  if (input.ledgerUnreadable) blockers.push("The provisioning ledger could not be read. Do not assume nothing is in flight.");
  const unrecognized = ops.filter((o) => !["in_flight", "succeeded", "failed", "unknown_outcome", "abandoned"].includes(o.status));
  if (unrecognized.length) blockers.push(`${unrecognized.length} operation${unrecognized.length > 1 ? "s have" : " has"} a status this console does not recognize. Investigate before any action.`);
  if (!input.accessEnabled) blockers.push("Pilot access is off for this studio.");
  if (operations === null && !input.ledgerUnreadable && ["service_setup", "campaign_pending", "ready_for_activation"].includes(String(state))) blockers.push("The provisioning ledger is not loaded for this studio; operations cannot be tracked here.");
  if (unknownOutcomes.length) blockers.push(`${unknownOutcomes.length} provider operation${unknownOutcomes.length > 1 ? "s have" : " has"} an unknown outcome. Nothing further runs until a person resolves it.`);
  if (failed.some((o) => o.feeBearing)) blockers.push("A fee-bearing operation failed. A new explicit owner approval is needed before any retry.");
  if (evidence && evidence.steps.some((s) => s.status === "failed")) blockers.push("A registration step failed; see the run evidence below.");
  if (sender?.verificationOutcome === "failed") blockers.push("The last sender verification failed.");

  let next: AdminNext;
  const anchor = `#onboarding-row-${input.studioId}`;
  if (!input.accessEnabled && !input.ledgerUnreadable && unknownOutcomes.length === 0) next = { kind: "act", title: "Switch pilot access on", detail: "The studio cannot see its setup page until access is enabled.", href: "#onboarding-pilot" };
  else if (state == null || STUDIO_WAIT.has(String(state))) next = { kind: "wait_studio", title: "Waiting for the studio owner", detail: "The owner needs to finish or correct their information. Nothing for you to do.", href: null };
  else if (input.ledgerUnreadable) next = { kind: "investigate", title: "Reload: the provisioning ledger could not be read", detail: "Nothing can be resolved or started from here until the ledger reads cleanly.", href: null };
  else if (unknownOutcomes.length) next = { kind: "investigate", title: "Resolve the unknown provider outcome", detail: "Look the resource up at the provider (Twilio console), then record whether it was created. The provider may or may not hold it; nothing is assumed.", href: `#ledger-${input.studioId}` };
  else if (TROUBLE.has(String(state))) next = { kind: "investigate", title: "Investigate this onboarding", detail: "The setup is blocked, in exception or suspended. Review the evidence before any action.", href: anchor };
  else if (REVIEW.has(String(state))) next = { kind: "act", title: "Run the registration steps", detail: "Open the fee gate and run the next steps from the studio row.", href: anchor };
  else if (state === "brand_pending") next = { kind: "wait_provider", title: "Brand is under carrier review", detail: "Use Check status to read Twilio. Nothing is submitted or charged by a status check.", href: anchor };
  else if (state === "service_setup") next = { kind: "act", title: "Set up the Messaging Service, then submit the campaign", detail: "The Messaging Service is free. The campaign is fee-bearing: it needs the owner's approved fees and your confirmation on the run itself.", href: `#prov-run-${input.studioId}` };
  else if (state === "campaign_pending") next = campaignOp?.status === "failed"
    ? { kind: "investigate", title: "Campaign was refused", detail: "Review the rejection, then arrange a new owner approval before resubmitting.", href: null }
    : campaignOp?.resource?.status === "verified"
    ? { kind: "act", title: "Offer numbers to the owner, then buy the one they approve", detail: "Searching is free. The purchase runs only for the number the owner approved, with your typed confirmation of that number.", href: `#prov-run-${input.studioId}` }
    : { kind: "wait_provider", title: "Campaign is under carrier review", detail: "Approval is recorded only from provider reads, never from a submission response. Use Check provisioning status to read it.", href: `#prov-run-${input.studioId}` };
  else if (state === "ready_for_activation") next = sender?.ready ? { kind: "done", title: "Sender verified: ready to release", detail: "Release is a separate, deliberate step.", href: null } : { kind: "act", title: "Verify the sender", detail: sender ? "Verify the recorded sender, attesting Advanced Opt-Out." : "Record the sender in the studio's sender panel (under its legal business), then verify it, attesting Advanced Opt-Out.", href: sender ? `#sender-${input.studioId}` : null };
  else if (state === "active") next = { kind: "done", title: "Texting is active", detail: "Monitor sender verification and usage.", href: null };
  else next = { kind: "wait_studio", title: "Nothing to do", detail: "", href: null };

  const campaign: AdminProvisioningView["campaign"] =
    ["ready_for_activation", "active", "suspended"].includes(String(state)) ? { label: "Approved by carriers", tone: "ok" }
    : campaignOp?.status === "failed" ? { label: "Refused", tone: "bad" }
    : state === "campaign_pending" ? { label: "Under carrier review", tone: "wait" }
    : { label: "Not submitted", tone: "idle" };

  const loaded = input.sendersLoaded !== false;
  const number: AdminProvisioningView["number"] = !loaded ? { label: "Not loaded", tone: "idle" } : sender?.phoneNumberSid && sender.senderE164
    ? { label: `${sender.senderE164} recorded`, tone: "ok" }
    : { label: "No number recorded", tone: "idle" };

  const optOut: AdminProvisioningView["optOut"] = !loaded ? { label: "Not loaded", tone: "idle" } : sender?.verificationOutcome === "verified"
    ? { label: "Attested and verified", tone: "ok" }
    : sender?.verificationOutcome === "failed" ? { label: "Verification failed", tone: "bad" }
    : sender?.senderId ? { label: "Attestation required at verification", tone: "wait" }
    : { label: "Required before activation", tone: "idle" };

  const senderView: AdminProvisioningView["sender"] = !loaded ? { label: "Not loaded", tone: "idle" } : sender?.ready ? { label: "Ready", tone: "ok" }
    : sender?.status === "revoked" ? { label: "Revoked", tone: "bad" }
    : sender?.senderId ? { label: "Not ready", tone: "wait" }
    : { label: "No sender recorded", tone: "idle" };

  return { next, blockers, unknownOutcomes, inFlight, campaign, number, optOut, sender: senderView };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// TW-4F J1: which provisioning run controls the summary offers, and what a run's outcome means to a platform admin. Showing a control authorizes nothing:
// every action re-checks platform-admin access and the real-call switches on the server, and the runners and the database keep every fee gate.
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export type ProvisioningIntent = "service" | "campaign" | "refresh";
export type NumberIntent = "offer" | "acquire" | "refresh";
export type RunControls = { provisioning: ProvisioningIntent[]; numbers: NumberIntent[] };

const KNOWN_STATUS = new Set(["in_flight", "succeeded", "failed", "unknown_outcome", "abandoned"]);

/** Status checks stay available once provisioning has begun; a control that can start a provider operation is hidden while the ledger is unreadable or an outcome is unknown. */
export function runControls(input: Pick<AdminProvisioningInput, "state" | "accessEnabled" | "operations" | "ledgerUnreadable">): RunControls {
  const state = String(input.state ?? "");
  if (!input.accessEnabled) return { provisioning: [], numbers: [] };
  const ops = input.operations ?? [];
  const halted = Boolean(input.ledgerUnreadable) || ops.some((o) => o.status === "unknown_outcome" || !KNOWN_STATUS.has(o.status));
  if (state === "service_setup") return { provisioning: halted ? ["refresh"] : ["service", "campaign", "refresh"], numbers: [] };
  if (state === "campaign_pending") {
    // numbers are offered and bought only for a campaign the provider read verified (the database refuses otherwise; this only avoids a dead control)
    const verified = ops.some((o) => o.kind === "campaign" && o.status === "succeeded" && !o.superseded && o.resource?.status === "verified");
    return { provisioning: ["refresh"], numbers: halted ? ["refresh"] : verified ? ["offer", "acquire", "refresh"] : ["refresh"] };
  }
  if (["ready_for_activation", "active", "suspended"].includes(state)) return { provisioning: ["refresh"], numbers: ["refresh"] };
  return { provisioning: [], numbers: [] };
}

const PROVISION_TEXT: Record<string, string> = {
  service_ready: "The Messaging Service exists in the studio's subaccount and points at DanceFlow's inbound route. Nothing was charged.",
  campaign_submitted: "The campaign was submitted to the carriers and is under review. Its fees were taken under the owner's approval. Approval is recorded only from a later provider read.",
  campaign_pending: "The campaign is still under carrier review. Nothing was created or charged by this run.",
  campaign_verified: "The carriers approved the campaign. Next: offer numbers to the owner.",
  campaign_rejected: "The carriers refused the campaign. A resubmission needs a new owner approval; nothing further runs automatically.",
  waiting_fee_confirmation: "Stopped before the fee-bearing campaign: tick the fee confirmation and type SUBMIT to submit it. Nothing was reserved or charged.",
  package_invalid: "Stopped before the campaign: the campaign package did not pass review. Nothing was reserved or charged.",
  prerequisite_missing: "Stopped: a prerequisite is missing (an approved brand on this subaccount, or a provider resource that must be removed first). Nothing was charged.",
  entity_resource_exists: "Stopped: another location of this legal business already holds this resource. Nothing was created or charged.",
  unknown_outcome: "A fee-bearing request may or may not have reached the provider. It is never repeated automatically: resolve it in the ledger.",
  exception: "Stopped for a human to look at. Review the ledger; nothing further runs automatically.",
  retry_later: "The provider did not answer cleanly. Nothing was repeated blindly: run again to reconcile.",
  lease_busy: "Another run is already working on this studio. Nothing was started.",
  lease_lost: "The run lost its lease part-way. Nothing further was started; run again to reconcile.",
  runner_closed: "The runner window for this studio is closed. Open a window before running; nothing was created.",
  not_runnable: "This studio is not at a step this run can work on (or its pilot access is off). Nothing was called.",
  config_missing: "DanceFlow's public https app address is not configured, so the inbound route cannot be set. Nothing was called.",
  needs_subaccount: "This studio has no active Twilio subaccount for its legal business. Nothing was called.",
  account_mismatch: "Safety stop: the provider account in use is not the studio's own subaccount. Nothing was called. Do not retry; a developer must look at this.",
  spend_blocked: "Stopped before the fee: no owner-approved spend is available for it within the legal business's spend cap. Nothing was reserved or charged.",
  insufficient_credit: "Stopped before the fee: settled credit (or, for the pilot business, the remaining cumulative ceiling) does not cover it. Nothing was reserved or charged.",
  recurring_missing: "Stopped before the fee: the owner has no standing monthly authorization at the published price. Nothing was reserved or charged.",
  tier_unpriced: "Stopped before the fee: a fee of this registration path has no published price. Nothing was reserved or charged.",
  tier_ineligible: "Stopped before the fee: this location is not on a verified registration path. Nothing was reserved or charged.",
  pilot_conflict: "Stopped: the pilot business has a standing recurring authorization, which the pilot rule forbids. Nothing was reserved or charged.",
  record_failed: "The provider acted but the result could not be recorded. Start nothing new: run Check provisioning status to reconcile.",
  nothing_to_check: "Nothing has been created yet, so there is nothing to check.",
};

const NUMBER_TEXT: Record<string, string> = {
  offered: "Numbers were offered to the studio owner. Nothing was bought or reserved; the owner chooses and approves one.",
  no_numbers: "No eligible number was found for that search. Nothing was bought.",
  search_refused: "The provider refused the number search. Nothing was bought.",
  number_ready: "The owner-approved number is bought, confirmed in the studio's subaccount and attached to its Messaging Service.",
  purchase_confirmed: "The number is confirmed in the studio's subaccount; its attachment to the Messaging Service is not recorded yet.",
  waiting_fee_confirmation: "Stopped before the purchase: tick the fee confirmation and type the owner-approved number. Nothing was reserved or charged.",
  no_selection: "Stopped: the owner has not approved a number (or the approval expired or went stale). Nothing was reserved or charged.",
  selection_mismatch: "Stopped: the number you typed is not the number the owner approved. Nothing was reserved or charged.",
  prerequisite_missing: "Stopped: the campaign is not verified, or the subaccount inventory needs reconciling first. Nothing was charged.",
  release_current_number_first: "Stopped: this location still holds a number. Release it before buying another. Nothing was charged.",
  number_taken: "Stopped: that number is already spoken for. The owner needs to choose another. Nothing was charged.",
  unknown_outcome: "The purchase may or may not have reached the provider. It is never repeated automatically: a platform admin resolves it.",
  exception: "Stopped for a human to look at (unrecorded or mismatching numbers in the subaccount, or a refusal). Nothing further runs automatically.",
  retry_later: "The provider did not answer cleanly. Nothing was repeated blindly: run again to reconcile.",
  lease_busy: "Another run is already working on this studio. Nothing was started.",
  lease_lost: "The run lost its lease part-way. Nothing further was started; run again to reconcile.",
  runner_closed: "The runner window for this studio is closed. Open a window before running; nothing was bought.",
  not_runnable: "This studio is not at the number step (or its pilot access is off). Nothing was called.",
  needs_subaccount: "This studio has no active Twilio subaccount for its legal business. Nothing was called.",
  account_mismatch: "Safety stop: the provider account in use is not the studio's own subaccount. Nothing was called. Do not retry; a developer must look at this.",
  spend_blocked: "Stopped before the purchase: no owner-approved spend is available for it. Nothing was reserved or charged.",
  insufficient_credit: "Stopped before the purchase: settled credit (or, for the pilot business, the remaining cumulative ceiling) does not cover it, or the credit account is on hold. Nothing was reserved or charged.",
  recurring_missing: "Stopped before the purchase: the owner has no standing monthly number authorization at the published price. Nothing was reserved or charged.",
  price_unavailable: "Stopped before the purchase: the number price is not published, or it changed since the owner approved. Nothing was reserved or charged.",
  pilot_conflict: "Stopped: the pilot business has a standing recurring authorization, which the pilot rule forbids. Nothing was reserved or charged.",
  suspended: "Stopped: the studio's subaccount is not active. Nothing was called.",
  record_failed: "The provider acted but the result could not be recorded. Start nothing new: run Check number status to reconcile.",
  nothing_to_check: "No number has been bought yet, so there is nothing to check.",
};

const PROVISION_GOOD = new Set(["service_ready", "campaign_submitted", "campaign_pending", "campaign_verified", "nothing_to_check"]);
const NUMBER_GOOD = new Set(["offered", "number_ready", "purchase_confirmed", "nothing_to_check"]);
const safeCode = (detail?: string | null) => String(detail ?? "").replace(/[^A-Za-z0-9_:,.;=+-]/g, "").slice(0, 120);
const UNRECOGNIZED = "Unrecognized result: review the ledger before any further action.";

export function describeProvisioningOutcome(outcome: string, detail?: string | null): { ok: boolean; message: string } {
  const code = safeCode(detail);
  const base = PROVISION_TEXT[outcome] ?? UNRECOGNIZED;
  return { ok: PROVISION_GOOD.has(outcome), message: code ? `${base} (${code})` : base };
}

export function describeNumberOutcome(outcome: string, detail?: string | null): { ok: boolean; message: string } {
  const code = safeCode(detail);
  const base = NUMBER_TEXT[outcome] ?? UNRECOGNIZED;
  return { ok: NUMBER_GOOD.has(outcome), message: code ? `${base} (${code})` : base };
}
