import type { OnboardingDisplayState } from "@/lib/sms/onboarding/stateMachine";

/**
 * TW-4F R2c: the studio owner's provisioning journey as pure data. This module decides WHAT to show (stage statuses and the one next action); the
 * components only render it. It never calls a provider, never authorizes anything and never marks a stage complete on its own evidence: a stage is
 * "done" only when a database-derived fact says so (onboarding state, credit/authorization rows, or a provisioning fact supplied by R2a/R2b reads).
 *
 * `ProvisioningFacts` is the READ contract this slice expects from R2a (campaign) and R2b (number, sender, compliance). It is owner-safe: no SIDs,
 * no provider text beyond a sanitized rejection summary. `null` means the backend read is not connected in this build, and the affected stages
 * say so and offer no action. Do not populate it from anything that is not a database/provider read.
 */

/**
 * Campaign status as the database reports it from PROVIDER evidence (get_studio_sms_provisioning, R2c-I2):
 * preparing = DanceFlow is still preparing or confirming the submission (it is NOT yet known to be with the carriers); pending = a provider read shows it
 * in carrier review; approved/rejected = the provider's verdict as judged by the database; attention = DanceFlow needs to look (owner does nothing).
 */
export type CampaignFact = "not_started" | "preparing" | "pending" | "approved" | "rejected" | "attention";
export type MessagingServiceFact = "not_started" | "in_progress" | "ready" | "attention";
export type NumberFact = "not_started" | "options_available" | "awaiting_owner_approval" | "purchasing" | "secured" | "failed";
export type SenderFact = "not_ready" | "verifying" | "ready" | "failed_verification";
export type ComplianceFact = "pending" | "complete" | "attention";

export type ProvisioningFacts = {
  /** R2a/R2c-I2 owner-safe read. */
  campaign: { status: CampaignFact; rejectionSummary?: string | null };
  messagingService?: { status: MessagingServiceFact };
  /** R2b facts: until the authoritative R2b reads exist these stay undefined and number, sender and compliance render "not available yet". */
  number?: { status: NumberFact; priceCents?: number | null; /** Where the owner makes the choice/approval; supplied by R2b, never invented here. */ actionHref?: string | null };
  sender?: { status: SenderFact };
  compliance?: { status: ComplianceFact };
};

export type FinanceFacts = {
  /** The location belongs to a legal business with a credit account. */
  legalBusiness: boolean;
  availableCents: number;
  onHold: boolean;
  /** Pilot business: fees are approved one operation at a time by written approval, never by standing authorization. */
  pilotBusiness: boolean;
  /** Registration path's campaign monthly kind; null when the path is not verified (no campaign fee can be authorized). */
  campaignMonthlyKind: "monthly" | "monthly_low_volume" | null;
  hasActiveAuthorization: boolean;
  prices: { kind: string; customerPriceCents: number }[];
  /** Fail-closed switches for the owner's own controls: a link to a control is offered only when that control is actually usable. */
  purchasesOpen: boolean;
  /** The recurring-authorization panel is rendered AND its feature is on. */
  authorizationOpen: boolean;
};

export type StageKey = "business" | "eligibility" | "approvals" | "provider" | "number" | "sender" | "compliance" | "activation";
export type StageStatus = "done" | "current" | "waiting" | "attention" | "upcoming" | "unavailable";

export type Stage = { key: StageKey; label: string; status: StageStatus; detail: string };

export type NextAction = {
  stage: StageKey;
  /** owner = the owner can act now; waiting = someone else holds the next move; blocked = cannot proceed (owner or DanceFlow must change something); unavailable = not built/connected yet. */
  kind: "owner" | "waiting" | "blocked" | "unavailable" | "complete" | "stopped";
  title: string;
  detail: string;
  /** Only present when the owner can actually act; absent otherwise so no unavailable action is ever rendered clickable. */
  cta: { label: string; href: string } | null;
};

export type JourneyInput = {
  state: OnboardingDisplayState;
  textingOn: boolean;
  paused: boolean;
  isOwner: boolean;
  finance: FinanceFacts | null;
  provisioning: ProvisioningFacts | null;
  /** The setup form is rendered and editable for this viewer (the #sms-setup target exists). */
  canEditForm: boolean;
};

export type Journey = { stages: Stage[]; next: NextAction };

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const price = (finance: FinanceFacts | null, kind: string) => finance?.prices.find((p) => p.kind === kind && p.customerPriceCents > 0)?.customerPriceCents ?? null;

export type ChargeLine = { key: string; label: string; amount: string; when: string };

/**
 * Every charge that applies to this owner's path, with the published price. A charge whose price is not published is listed as such (never
 * guessed). Brand fee kinds are shown only for the path in use. Nothing here is a request to pay: authorization is a separate explicit act.
 */
export function chargeLines(finance: FinanceFacts | null): ChargeLine[] {
  const lowVolume = finance?.campaignMonthlyKind === "monthly_low_volume";
  const rows: { key: string; label: string; kind: string; when: string }[] = [
    { key: "brand", label: "Business brand registration", kind: lowVolume ? "brand_low_volume" : "brand", when: "One time, when your registration is submitted to the carriers. Not refundable if the carriers reject it." },
    { key: "campaign_vetting", label: "Campaign review", kind: "campaign_vetting", when: "One time, when your messaging campaign is submitted. Not refundable if the carriers reject it." },
    { key: "monthly", label: "Monthly texting service", kind: lowVolume ? "monthly_low_volume" : "monthly", when: "Every month while texting stays set up." },
    { key: "number", label: "Texting phone number", kind: "number", when: "Rent for the number you choose, billed monthly. You approve the specific number first." },
  ];
  return rows.map((row) => {
    const pathDependent = row.key === "brand" || row.key === "monthly";
    if (finance && finance.campaignMonthlyKind == null && pathDependent) return { key: row.key, label: row.label, amount: "Depends on your registration path", when: row.when };
    const cents = price(finance, row.kind);
    return { key: row.key, label: row.label, amount: cents == null ? "Price not published yet" : usd(cents), when: row.when };
  });
}

/** What the owner still needs to cover before the first fee-bearing step, from published prices only. null = cannot be computed (a price is missing). */
export function requiredFundingCents(finance: FinanceFacts | null): number | null {
  if (!finance || finance.campaignMonthlyKind == null) return null;
  const lowVolume = finance.campaignMonthlyKind === "monthly_low_volume";
  const parts = [price(finance, lowVolume ? "brand_low_volume" : "brand"), price(finance, "campaign_vetting"), price(finance, lowVolume ? "monthly_low_volume" : "monthly")];
  if (parts.some((p) => p == null)) return null;
  return (parts as number[]).reduce((a, b) => a + b, 0);
}

const BEFORE_REVIEW: OnboardingDisplayState[] = ["not_started", "draft", "needs_info"];
const FEE_STATES: OnboardingDisplayState[] = ["brand_pending", "service_setup", "campaign_pending", "ready_for_activation", "active", "suspended"];
const TROUBLE: OnboardingDisplayState[] = ["blocked", "exception"];

function financeStage(input: JourneyInput): Stage {
  const { finance, state } = input;
  const label = "Financial approvals";
  if (!finance || !finance.legalBusiness) {
    return { key: "approvals", label, status: finance ? "attention" : "unavailable", detail: finance ? "This location is not linked to a legal business yet, so no fee can be approved." : "Charges and approvals are not available to your role." };
  }
  if (finance.pilotBusiness) {
    return { key: "approvals", label, status: FEE_STATES.includes(state) ? "done" : "upcoming", detail: FEE_STATES.includes(state) ? "Your fee approvals for this step are recorded with DanceFlow. Later fees are approved with you one at a time." : "DanceFlow records each fee approval with you one at a time. Nothing is charged without your written approval." };
  }
  const need = requiredFundingCents(finance);
  const preFee = !FEE_STATES.includes(state);
  if (finance.campaignMonthlyKind == null && preFee) return { key: "approvals", label, status: "upcoming", detail: "Fees are confirmed after DanceFlow verifies your registration path. You approve each one before it is charged." };
  if (finance.onHold) return { key: "approvals", label, status: "attention", detail: "Your prepaid balance is on hold. Contact DanceFlow before any fee can be approved." };
  if (!preFee) {
    if (!finance.hasActiveAuthorization && price(finance, finance.campaignMonthlyKind === "monthly_low_volume" ? "monthly_low_volume" : "monthly") == null) return { key: "approvals", label, status: "unavailable", detail: "The monthly price is not published for your registration path yet, so nothing can be authorized." };
    return finance.hasActiveAuthorization
      ? { key: "approvals", label, status: "done", detail: "Fees for this step are approved and the monthly service is authorized." }
      : { key: "approvals", label, status: "current", detail: state === "brand_pending" || state === "service_setup" ? "Authorize the monthly texting service so the campaign can be submitted. You see every charge first." : "No active monthly texting service authorization is on file. Reauthorize to keep texting set up; you see every charge first." };
  }
  if (need == null) return { key: "approvals", label, status: "unavailable", detail: "Fee prices are not published for your registration path yet, so nothing can be approved." };
  if (finance.availableCents < need) {
    return { key: "approvals", label, status: "attention", detail: `Your available balance is ${usd(finance.availableCents)}; setup needs at least ${usd(need)} before the first fee. Add funds to continue.` };
  }
  if (!finance.hasActiveAuthorization) return { key: "approvals", label, status: "current", detail: "Authorize the monthly texting service so the campaign can be submitted. You see every charge first." };
  return { key: "approvals", label, status: "done", detail: "Funding is available and the monthly service is authorized." };
}

/** Build the eight stages and the single next action. Pure. */
export function buildJourney(input: JourneyInput): Journey {
  const { state, provisioning } = input;
  const beforeReview = BEFORE_REVIEW.includes(state);
  const trouble = TROUBLE.includes(state);
  const past = (s: OnboardingDisplayState[]) => s.includes(state);

  // business information
  const business: Stage = {
    key: "business",
    label: "Business and registration information",
    status: state === "needs_info" ? "attention" : beforeReview ? "current" : state === "cancelled" ? "upcoming" : "done",
    detail: state === "needs_info" ? "Something needs another look before DanceFlow can continue." : beforeReview ? "Tell us about your business and submit it for checking." : "Submitted.",
  };
  // eligibility & tier: checked by DanceFlow
  const eligibility: Stage = {
    key: "eligibility",
    label: "Registration eligibility and tier",
    status: beforeReview || state === "cancelled" ? "upcoming" : state === "submitted_for_checks" || state === "profile_review" ? "waiting" : trouble ? "attention" : "done",
    detail: state === "submitted_for_checks" || state === "profile_review" ? "DanceFlow is verifying your business and choosing the registration path. This is not a carrier approval." : trouble ? "This needs DanceFlow. You do not need to do anything." : "Your registration path is set.",
  };
  const approvals = financeStage(input);
  if (beforeReview || state === "submitted_for_checks" || state === "profile_review") {
    if (approvals.status === "current") approvals.status = "upcoming";
  }

  // provider review: brand + campaign. Submitting is never approval.
  const campaign = provisioning?.campaign;
  let providerStatus: StageStatus = "upcoming";
  let providerDetail = "Carrier review starts after your registration is verified and fees are approved.";
  if (past(["brand_pending"])) { providerStatus = "waiting"; providerDetail = "Your business brand is under carrier review. Submitting is not approval; this can take minutes to days."; }
  else if (past(["service_setup"])) { providerStatus = "waiting"; providerDetail = "Your brand is approved. DanceFlow is connecting messaging."; }
  else if (past(["campaign_pending"])) {
    if (campaign?.status === "rejected") { providerStatus = "attention"; providerDetail = campaign.rejectionSummary ? `The carriers did not approve the campaign: ${campaign.rejectionSummary}` : "The carriers did not approve the campaign. DanceFlow will contact you."; }
    else { providerStatus = "waiting"; providerDetail = "Your messaging campaign is under carrier review. Submitting is not approval; this usually takes days, sometimes weeks."; }
  } else if (past(["ready_for_activation", "active", "suspended"])) { providerStatus = "done"; providerDetail = "Brand and campaign are approved by the carriers."; }
  else if (trouble) { providerStatus = "attention"; providerDetail = "This needs DanceFlow. You do not need to do anything."; }
  // database-reported campaign evidence (R2c-I2) is more specific than the onboarding state alone
  if (campaign && (past(["service_setup", "campaign_pending"]) || state === "exception")) {
    const o = campaignStage(campaign);
    if (o) { providerStatus = o.status; providerDetail = o.detail; }
  }
  const provider: Stage = { key: "provider", label: "Provider review and approval", status: providerStatus, detail: providerDetail };

  // number / sender / compliance come only from R2b facts
  const reachedNumber = (past(["ready_for_activation", "active", "suspended"]) || (past(["campaign_pending"]) && (!campaign || campaign.status === "approved"))) && campaign?.status !== "rejected";
  const unconnected = (label: string, key: StageKey): Stage => ({ key, label, status: "unavailable", detail: "Not available yet. DanceFlow will let you know when this step opens." });
  let number: Stage; let sender: Stage; let compliance: Stage;
  const r2b = provisioning?.number && provisioning.sender && provisioning.compliance ? { number: provisioning.number, sender: provisioning.sender, compliance: provisioning.compliance } : null;
  if (!r2b) {
    number = unconnected("Phone number", "number"); sender = unconnected("Sender readiness", "sender"); compliance = unconnected("Compliance setup", "compliance");
    if (state === "active" || input.textingOn) { number.status = "done"; number.detail = "Your texting number is in place."; sender.status = "done"; sender.detail = "Your sender is verified."; compliance.status = "done"; compliance.detail = "Compliance checks are complete."; }
  } else {
    const n = r2b.number;
    const nStatus: StageStatus = n.status === "secured" ? "done" : n.status === "failed" ? "attention" : n.status === "purchasing" ? "waiting" : n.status === "options_available" || n.status === "awaiting_owner_approval" ? (reachedNumber ? "current" : "upcoming") : reachedNumber ? "waiting" : "upcoming";
    const nDetail = n.status === "secured" ? "Your texting number is in place." : n.status === "failed" ? "The number could not be secured. Nothing further was charged; DanceFlow will follow up." : n.status === "purchasing" ? "Your number is being secured. This is not complete until confirmed." : n.status === "awaiting_owner_approval" ? `Review and approve your number${n.priceCents ? ` (${usd(n.priceCents)} per month)` : ""}.` : n.status === "options_available" ? "Number options are ready to choose from." : "Number selection opens after your campaign is approved.";
    number = { key: "number", label: "Phone number selection and approval", status: nStatus, detail: nDetail };
    const s = r2b.sender.status;
    sender = { key: "sender", label: "Sender readiness", status: s === "ready" ? "done" : s === "failed_verification" ? "attention" : s === "verifying" ? "waiting" : "upcoming", detail: s === "ready" ? "Your sender is verified." : s === "failed_verification" ? "Sender verification did not pass. DanceFlow is looking into it; texting stays off." : s === "verifying" ? "DanceFlow is verifying your sender." : "Starts once your number is secured." };
    const c = r2b.compliance.status;
    compliance = { key: "compliance", label: "Compliance setup", status: c === "complete" ? "done" : c === "attention" ? "attention" : "upcoming", detail: c === "complete" ? "Opt-out and help handling are confirmed." : c === "attention" ? "A compliance check needs attention. DanceFlow will follow up." : "Opt-out and help handling are confirmed before texting turns on." };
  }

  const activation: Stage = {
    key: "activation",
    label: "Activation readiness",
    status: input.textingOn || state === "active" ? "done" : state === "suspended" ? "attention" : state === "ready_for_activation" ? "waiting" : "upcoming",
    detail: input.textingOn || state === "active" ? "Texting is on." : state === "suspended" ? "Texting is paused. DanceFlow will contact you if anything is needed." : state === "ready_for_activation" ? "Carrier approvals are in. DanceFlow still has to confirm your number, sender and compliance before texting turns on." : "Texting turns on only after every step above is complete.",
  };

  const stages = [business, eligibility, approvals, provider, number, sender, compliance, activation];
  return { stages, next: pickNext(input, stages) };
}

function pickNext(input: JourneyInput, stages: Stage[]): NextAction {
  const { state, isOwner, paused } = input;
  if (state === "cancelled") return { stage: "business", kind: "stopped", title: "This setup was cancelled", detail: "Contact DanceFlow if you want to start again.", cta: null };
  if (paused) return { stage: "business", kind: "stopped", title: "Texting setup is paused", detail: "Your information is kept. Nothing is needed from you right now.", cta: null };
  if (input.textingOn || state === "active") return { stage: "activation", kind: "complete", title: "Texting is on", detail: "Appointment texts are being sent to clients who opted in.", cta: null };
  if (state === "suspended") return { stage: "activation", kind: "blocked", title: "Texting is paused", detail: "DanceFlow will contact you if anything is needed.", cta: null };
  if (input.provisioning?.campaign.status === "rejected" && (state === "exception" || state === "campaign_pending")) {
    const why = input.provisioning.campaign.rejectionSummary;
    return { stage: "provider", kind: "blocked", title: "The carriers did not approve your campaign", detail: why ? `${why} DanceFlow will contact you; you do not need to do anything yet.` : "DanceFlow will contact you; you do not need to do anything yet.", cta: null };
  }
  if (state === "blocked" || state === "exception") return { stage: "eligibility", kind: "blocked", title: "DanceFlow is looking into this", detail: "You do not need to do anything. We will reach out if we need you.", cta: null };

  // while DanceFlow checks the business, a funding shortfall is still the owner's to fix and outranks the wait
  const approvalsStage = stages.find((s) => s.key === "approvals");
  const first = (state === "submitted_for_checks" || state === "profile_review") && approvalsStage?.status === "attention" ? approvalsStage : stages.find((s) => s.status !== "done");
  if (!first) return { stage: "activation", kind: "complete", title: "Everything is complete", detail: "Texting is ready.", cta: null };
  const ownerOnly = (cta: NextAction["cta"]) => (isOwner ? cta : null);
  const notOwner = (n: NextAction): NextAction => (isOwner || n.kind !== "owner" ? n : { ...n, kind: "waiting", title: `Waiting for the studio owner: ${n.title.toLowerCase()}`, cta: null });

  switch (first.key) {
    case "business":
      return notOwner({ stage: "business", kind: "owner", title: state === "needs_info" ? "Review your information and submit again" : state === "not_started" ? "Start your texting setup" : "Finish your information and submit", detail: first.detail, cta: ownerOnly(input.canEditForm ? { label: state === "needs_info" ? "Review answers" : "Open the form", href: "#sms-setup" } : null) });
    case "eligibility":
      return { stage: "eligibility", kind: "waiting", title: "DanceFlow is checking your business", detail: first.detail, cta: null };
    case "approvals": {
      if (first.status === "current") {
        if (!input.finance?.authorizationOpen) return { stage: "approvals", kind: "unavailable", title: "Authorizing the monthly service is not open yet", detail: first.detail, cta: null };
        return notOwner({ stage: "approvals", kind: "owner", title: "Authorize the monthly texting service", detail: first.detail, cta: ownerOnly({ label: "Review charges", href: "#sms-recurring" }) });
      }
      if (first.status === "attention" && input.finance?.legalBusiness && !input.finance.onHold && !input.finance.purchasesOpen) return { stage: "approvals", kind: "unavailable", title: "Adding funds is not open yet", detail: first.detail, cta: null };
      if (first.status === "attention" && input.finance?.legalBusiness && !input.finance.onHold) return notOwner({ stage: "approvals", kind: "owner", title: "Add funds to continue", detail: first.detail, cta: ownerOnly({ label: "Add funds", href: "#sms-credit" }) });
      if (first.status === "attention") return { stage: "approvals", kind: "blocked", title: "Fees cannot be approved yet", detail: first.detail, cta: null };
      if (first.status === "unavailable") return { stage: "approvals", kind: "unavailable", title: "Fee approval is not available yet", detail: first.detail, cta: null };
      return { stage: "approvals", kind: "waiting", title: "DanceFlow will confirm your fee approvals", detail: first.detail, cta: null };
    }
    case "provider":
      if (first.status === "attention") return { stage: "provider", kind: "blocked", title: "The carriers need something changed", detail: first.detail, cta: null };
      return { stage: "provider", kind: "waiting", title: input.provisioning?.campaign.status === "preparing" ? "DanceFlow is preparing your campaign" : "Waiting for carrier review", detail: first.detail, cta: null };
    case "number": {
      const href = input.provisioning?.number?.actionHref ?? null;
      const st = input.provisioning?.number?.status;
      if (first.status === "current" && href && (st === "options_available" || st === "awaiting_owner_approval")) return notOwner({ stage: "number", kind: "owner", title: st === "awaiting_owner_approval" ? "Approve your texting number" : "Choose your texting number", detail: first.detail, cta: ownerOnly({ label: st === "awaiting_owner_approval" ? "Review and approve" : "Choose a number", href }) });
      if (first.status === "unavailable") return { stage: "number", kind: "unavailable", title: "Number selection is not available yet", detail: first.detail, cta: null };
      if (first.status === "attention") return { stage: "number", kind: "blocked", title: "Your number needs attention", detail: first.detail, cta: null };
      return { stage: "number", kind: "waiting", title: "Your number is being arranged", detail: first.detail, cta: null };
    }
    case "sender":
    case "compliance":
    case "activation": {
      if (first.status === "unavailable") return { stage: first.key, kind: "unavailable", title: `${first.label} is not available yet`, detail: first.detail, cta: null };
      if (first.status === "attention") return { stage: first.key, kind: "blocked", title: `${first.label} needs attention`, detail: first.detail, cta: null };
      return { stage: first.key, kind: "waiting", title: first.key === "activation" ? "DanceFlow will turn texting on" : `${first.label}: DanceFlow is on it`, detail: first.detail, cta: null };
    }
  }
}

/** True when this location holds a live (unrevoked, unexpired) recurring authorization of the campaign monthly kind. `now` is injectable for tests. */
export function hasLiveCampaignAuthorization(
  authorizations: { kind: string; status: string; thisLocation: boolean; expiresAt: string }[] | undefined,
  kind: string | null,
  now: number = Date.now(),
): boolean {
  if (!kind || !authorizations) return false;
  return authorizations.some((a) => a.kind === kind && a.status === "active" && a.thisLocation && new Date(a.expiresAt).getTime() > now);
}

function campaignStage(campaign: NonNullable<ProvisioningFacts["campaign"]>): { status: StageStatus; detail: string } | null {
  switch (campaign.status) {
    case "preparing": return { status: "waiting", detail: "DanceFlow is preparing your campaign submission. It has not been confirmed with the carriers yet." };
    case "pending": return { status: "waiting", detail: "Your messaging campaign is under carrier review. Submitting is not approval; this usually takes days, sometimes weeks." };
    case "approved": return { status: "done", detail: "Your brand and campaign are approved by the carriers." };
    case "rejected": return { status: "attention", detail: campaign.rejectionSummary ? `The carriers did not approve the campaign: ${campaign.rejectionSummary}` : "The carriers did not approve the campaign. DanceFlow will contact you." };
    case "attention": return { status: "attention", detail: "DanceFlow is reviewing your campaign setup. You do not need to do anything." };
    default: return null;
  }
}
