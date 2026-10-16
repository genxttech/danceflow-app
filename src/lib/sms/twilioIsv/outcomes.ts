import type { RunOutcome } from "./runner";

/** Platform-console wording for a run outcome. No identifiers, no personal data; `detail` is a short sanitized code. */
const TEXT: Record<RunOutcome, string> = {
  brand_submitted: "Profile, trust product and brand were submitted to Twilio. The brand is now in review.",
  brand_in_review: "The brand is still in review at Twilio. Nothing was created.",
  brand_approved: "The brand is approved. The studio's EIN was erased. Next: campaign and number (slice R2).",
  waiting_fee_confirmation: "Stopped before the paid brand step. Tick the fee confirmation and run again to continue.",
  needs_info: "Twilio's checks need a correction. The studio owner has been asked to fix the highlighted field.",
  exception: "Stopped for a human to look at. See the step list; nothing further will run automatically.",
  retry_later: "Twilio did not answer cleanly. Nothing was repeated blindly: run again to reconcile and continue.",
  lease_busy: "Another run is already working on this studio.",
  runner_closed: "The runner window for this studio is closed. Open a window (up to 72 hours) before running; nothing was created.",
  not_runnable: "This studio is not in a state the runner can work on (it must be submitted, with the pilot switch on).",
  config_missing: "Twilio registration is not configured in this environment.",
};

export function describeOutcome(outcome: string, detail?: string | null): string {
  const base = (TEXT as Record<string, string>)[outcome] ?? "Unknown result.";
  const code = String(detail ?? "").replace(/[^A-Za-z0-9_:,.\-]/g, "").slice(0, 80);
  return code ? `${base} (${code})` : base;
}
