import { explainCode } from "./errorCatalog";
import type { RunOutcome } from "./runner";

/** Platform-console wording for a run outcome. No identifiers, no personal data; `detail` is a short sanitized code. */
const TEXT: Record<RunOutcome, string> = {
  brand_submitted: "Profile, trust product and brand were submitted to Twilio. The brand is now in review.",
  brand_in_review: "The brand is still in review at Twilio. Nothing was created.",
  brand_approved: "The brand is approved. The studio's EIN was erased. Next: campaign and number (slice R2).",
  waiting_submission_confirmation: "Stopped before an irreversible submission to Twilio (S11 = the business profile, T6 = the A2P trust product). Nothing was submitted. A run that has just performed the evaluation always stops here first; if the code shows :review, the evaluation passed. Tick that confirmation, type SUBMIT and run again.",
  status_checked: "Status checked at Twilio (read-only). Nothing was created, submitted or paid.",
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
  const code = String(detail ?? "").replace(/[^A-Za-z0-9_:,.;=-]/g, "").slice(0, 120);
  let base = (TEXT as Record<string, string>)[outcome] ?? "Unknown result.";
  if (outcome === "waiting_submission_confirmation" && code.endsWith(":attempt_unresolved")) {
    base = "A previous attempt at this submission did not finish cleanly and may already have reached Twilio. Check the status at Twilio before confirming again. Nothing was submitted by this run.";
  } else if ((outcome === "exception" || outcome === "needs_info") && code.endsWith(":evaluation_stale")) {
    base = "The evaluation can no longer authorize a submission (it has no recorded passing verdict, or the setup was sent back after it). The setup was sent back to the studio owner, who must resubmit so a fresh evaluation is made (nothing needs to be edited). Nothing was submitted.";
  }
  // the plain "what to do next" for the failure modes the catalog knows (waiting states already say it in the message)
  const entry = outcome === "exception" || outcome === "needs_info" ? explainCode(code) : null;
  const next = entry ? ` Next: ${entry.action}` : "";
  return code ? `${base}${next} (${code})` : `${base}${next}`;
}
