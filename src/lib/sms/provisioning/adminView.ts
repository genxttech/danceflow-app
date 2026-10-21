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
export type ProvisioningOperationView = { id: string; kind: OperationKind | string; status: OperationStatus | string; feeBearing: boolean; attemptedAt: string | null; errorCode: string | null };

export type AdminProvisioningInput = {
  studioId: string;
  state: OnboardingDisplayState | string | null;
  accessEnabled: boolean;
  evidence: RunnerStatus | undefined;
  sender: SenderOverviewRow | null;
  operations: ProvisioningOperationView[] | null;
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
  if (!input.accessEnabled) blockers.push("Pilot access is off for this studio.");
  if (operations === null && ["service_setup", "campaign_pending", "ready_for_activation"].includes(String(state))) blockers.push("The provisioning ledger is not connected in this build; operations cannot be tracked here.");
  if (unknownOutcomes.length) blockers.push(`${unknownOutcomes.length} provider operation${unknownOutcomes.length > 1 ? "s have" : " has"} an unknown outcome. Nothing further runs until a person resolves it.`);
  if (failed.some((o) => o.feeBearing)) blockers.push("A fee-bearing operation failed. A new explicit owner approval is needed before any retry.");
  if (evidence && evidence.steps.some((s) => s.status === "failed")) blockers.push("A registration step failed; see the run evidence below.");
  if (sender?.verificationOutcome === "failed") blockers.push("The last sender verification failed.");

  let next: AdminNext;
  const anchor = `#onboarding-row-${input.studioId}`;
  if (!input.accessEnabled) next = { kind: "act", title: "Switch pilot access on", detail: "The studio cannot see its setup page until access is enabled.", href: "#onboarding-pilot" };
  else if (state == null || STUDIO_WAIT.has(String(state))) next = { kind: "wait_studio", title: "Waiting for the studio owner", detail: "The owner needs to finish or correct their information. Nothing for you to do.", href: null };
  else if (unknownOutcomes.length) next = { kind: "investigate", title: "Resolve the unknown provider outcome", detail: "Look the resource up at the provider, then record whether it was created. Resolution is not wired into this panel yet.", href: null };
  else if (TROUBLE.has(String(state))) next = { kind: "investigate", title: "Investigate this onboarding", detail: "The setup is blocked, in exception or suspended. Review the evidence before any action.", href: anchor };
  else if (REVIEW.has(String(state))) next = { kind: "act", title: "Run the registration steps", detail: "Open the fee gate and run the next steps from the studio row.", href: anchor };
  else if (state === "brand_pending") next = { kind: "wait_provider", title: "Brand is under carrier review", detail: "Use Check status to read Twilio. Nothing is submitted or charged by a status check.", href: anchor };
  else if (state === "service_setup") next = { kind: "unavailable", title: "Messaging Service setup is not wired to this panel", detail: "The provisioning runner has no platform action in this build, so nothing can be started from here.", href: null };
  else if (state === "campaign_pending") next = campaignOp?.status === "failed"
    ? { kind: "investigate", title: "Campaign was refused", detail: "Review the rejection, then arrange a new owner approval before resubmitting.", href: null }
    : { kind: "wait_provider", title: "Campaign is under carrier review", detail: "Approval is recorded only from provider reads, never from a submission response.", href: null };
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
