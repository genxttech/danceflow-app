/**
 * TW-4A: the onboarding state machine as the application sees it. The database enforces the same graph with a trigger
 * (`public._sms_onb_transition_allowed`); this mirror drives the owner-facing tracker and is pinned against the SQL by a test.
 * Studios never see Twilio terms or identifiers: labels and details here are plain language.
 */

export const ONBOARDING_STATES = [
  "draft",
  "submitted_for_checks",
  "needs_info",
  "profile_review",
  "brand_pending",
  "service_setup",
  "campaign_pending",
  "ready_for_activation",
  "active",
  "suspended",
  "blocked",
  "exception",
  "cancelled",
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];
/** What the status RPC reports before any record exists. */
export type OnboardingDisplayState = OnboardingState | "not_started";

export const ALLOWED_TRANSITIONS: Readonly<Record<OnboardingState, readonly OnboardingState[]>> = {
  draft: ["submitted_for_checks", "cancelled"],
  submitted_for_checks: ["needs_info", "profile_review", "exception", "cancelled"],
  needs_info: ["submitted_for_checks", "cancelled"],
  profile_review: ["brand_pending", "needs_info", "blocked", "exception", "cancelled"],
  brand_pending: ["service_setup", "needs_info", "blocked", "exception"],
  service_setup: ["campaign_pending", "exception"],
  campaign_pending: ["ready_for_activation", "needs_info", "blocked", "exception"],
  ready_for_activation: ["active", "exception"],
  active: ["suspended", "exception"],
  suspended: ["active", "exception"],
  exception: ["needs_info", "submitted_for_checks", "profile_review", "brand_pending", "service_setup", "campaign_pending", "ready_for_activation", "blocked", "cancelled"],
  blocked: ["exception", "cancelled"],
  cancelled: [],
};

export function canTransition(from: OnboardingState, to: OnboardingState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isOnboardingState(value: unknown): value is OnboardingState {
  return typeof value === "string" && (ONBOARDING_STATES as readonly string[]).includes(value);
}

/** The owner may edit the draft, and cancel, only in these states (the DB enforces both). */
export const OWNER_EDIT_STATES: readonly OnboardingState[] = ["draft", "needs_info"];
export const OWNER_CANCEL_STATES: readonly OnboardingState[] = ["draft", "submitted_for_checks", "needs_info", "profile_review"];

export function ownerCanEdit(state: OnboardingDisplayState): boolean {
  return state === "not_started" || (OWNER_EDIT_STATES as readonly string[]).includes(state);
}
export function ownerCanCancel(state: OnboardingDisplayState): boolean {
  return state !== "not_started" && (OWNER_CANCEL_STATES as readonly string[]).includes(state);
}

export const STATE_LABELS: Record<OnboardingDisplayState, string> = {
  not_started: "Not started",
  draft: "Setup in progress",
  submitted_for_checks: "Submitted",
  needs_info: "Information needed",
  profile_review: "Business verification",
  brand_pending: "Brand review",
  service_setup: "Setting up messaging",
  campaign_pending: "Campaign review",
  ready_for_activation: "Ready to turn on",
  active: "Texting is on",
  suspended: "Texting is paused",
  blocked: "Needs DanceFlow help",
  exception: "We are working on it",
  cancelled: "Cancelled",
};

export const STATE_DETAILS: Record<OnboardingDisplayState, string> = {
  not_started: "Texting is not set up for your studio yet.",
  draft: "Your answers are saved. Finish the form and submit when you are ready.",
  submitted_for_checks: "We have your information. DanceFlow will check it and tell you what happens next.",
  needs_info: "Something needs another look. Check your answers, correct anything that is out of date, and submit again. If nothing needs to change, just submit again.",
  profile_review: "Your business details are being verified.",
  brand_pending: "Your business brand is being reviewed by the carriers. This can take from minutes to a few business days.",
  service_setup: "Your approved brand is being connected to messaging.",
  campaign_pending: "Your messaging campaign is under review. This usually takes days, sometimes weeks.",
  ready_for_activation: "Everything is approved. Texting is turned on once DanceFlow releases your studio.",
  active: "Appointment texts are being sent to clients who opted in.",
  suspended: "Texting is paused. DanceFlow will contact you if anything is needed.",
  blocked: "This setup cannot continue without DanceFlow. We will reach out.",
  exception: "Something needs a closer look. DanceFlow is on it; you do not need to do anything.",
  cancelled: "This setup was cancelled.",
};

export type TrackerStepKey = "business" | "brand" | "campaign" | "number" | "activate";
export type TrackerStepStatus = "done" | "current" | "upcoming" | "attention";
export type TrackerStep = { key: TrackerStepKey; label: string; status: TrackerStepStatus };

const TRACKER_LABELS: Record<TrackerStepKey, string> = {
  business: "Business verification",
  brand: "Brand approval",
  campaign: "Campaign approval",
  number: "Number ready",
  activate: "Turn on texting",
};
const ORDER: TrackerStepKey[] = ["business", "brand", "campaign", "number", "activate"];

/** Which tracker step each state belongs to (index into ORDER); -1 = before the first step, 5 = after the last. */
const POSITION: Record<OnboardingDisplayState, number> = {
  not_started: -1,
  draft: -1,
  submitted_for_checks: 0,
  needs_info: 0,
  profile_review: 0,
  brand_pending: 1,
  service_setup: 2,
  campaign_pending: 2,
  ready_for_activation: 4,
  active: 5,
  suspended: 4,
  blocked: 0,
  exception: 0,
  cancelled: -1,
};

export function trackerSteps(state: OnboardingDisplayState): TrackerStep[] {
  const position = POSITION[state];
  const trouble = state === "needs_info" || state === "blocked" || state === "exception" || state === "suspended";
  return ORDER.map((key, index) => {
    let status: TrackerStepStatus;
    if (state === "cancelled") status = "upcoming";
    else if (index < position) status = "done";
    else if (index === position) status = trouble ? "attention" : "current";
    else status = "upcoming";
    return { key, label: TRACKER_LABELS[key], status };
  });
}
