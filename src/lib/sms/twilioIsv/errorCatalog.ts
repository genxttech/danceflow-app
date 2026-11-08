/**
 * TW-4F-2b: the error-to-action catalog. Every code the registration runner can leave on a step or in a run result maps to WHO has to act
 * and WHAT to do, in plain words. Studios never see Twilio terms: the owner entries talk about the studio's own details only. The catalog is
 * pinned against the runner source by a test (a code the runner can produce but the catalog does not know fails the build of the tests),
 * so a new failure mode cannot ship without its explanation.
 */

export type CatalogEntry = {
  /** Who has to act: the studio owner, DanceFlow's platform admin, or nobody (Twilio is reviewing). */
  who: "owner" | "platform" | "twilio";
  summary: string;
  action: string;
};

const owner = (summary: string, action: string): CatalogEntry => ({ who: "owner", summary, action });
const platform = (summary: string, action: string): CatalogEntry => ({ who: "platform", summary, action });
const twilio = (summary: string, action: string): CatalogEntry => ({ who: "twilio", summary, action });

export const ERROR_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  // --- the studio's own details
  noncompliant: owner("The registration check found details that do not match.", "Ask the owner to correct the highlighted detail and submit again."),
  payload: owner("A detail is missing or in a form the registration cannot use.", "Ask the owner to complete the highlighted detail and submit again."),
  preverify_noncompliant: owner("The final check before submitting found a mismatch.", "Ask the owner to correct the highlighted detail and submit again. Nothing was submitted."),
  evaluation_stale: owner("The earlier check can no longer be relied on, so nothing was submitted.", "Ask the owner to submit again; nothing needs to change. A fresh check is made."),
  // --- needs DanceFlow
  noncompliant_unmapped: platform("Twilio rejected a detail we cannot point the owner to.", "Open the step evidence, read the failing field, and decide with the owner what to change."),
  evaluation_unrecognized: platform("Twilio's check answered in a form we do not trust, so nothing was submitted.", "Look at the step evidence. Do not submit. Retry later or ask Twilio."),
  preverify_unrecognized: platform("The final check answered in a form we do not trust, so nothing was submitted.", "Look at the step evidence. Do not submit. Retry later or ask Twilio."),
  confirmation_missing: platform("The database refused the submission because no fresh confirmation was held.", "Confirm the submission again in a new run. Nothing was submitted."),
  attempt_unresolved: platform("An earlier attempt at this submission did not finish cleanly and may have reached Twilio.", "Check the status at Twilio first; confirm again only if it did not go through."),
  review: platform("The check passed and the run stopped on purpose before an irreversible submission.", "Read the evaluation in the step evidence, then run again with the confirmation and SUBMIT."),
  dependency_missing: platform("A step ran before the step it depends on.", "Do not continue. Report it to engineering; this should not happen."),
  api: platform("Twilio refused a request.", "Read the step evidence and the code, fix the cause, then run again."),
  ambiguous_rejected: platform("Twilio refused a request after an unclear earlier attempt.", "Look at Twilio for what exists before running again."),
  ambiguous_match: platform("More than one Twilio resource matches this step.", "Do not continue. A person must pick the right one at Twilio."),
  ambiguous_fee_step: platform("A paid step ended unclearly, so it will not be repeated.", "Look at Twilio for the brand before doing anything; never create a second one."),
  unclear_outcome: platform("Twilio did not answer clearly, so the result is unknown.", "Run again later; the runner checks what exists before it repeats anything."),
  reconcile_failed: platform("Could not look up what an earlier attempt created.", "Run again later; nothing was repeated."),
  lookup_failed: platform("Could not look up existing resources before creating one.", "Run again later; nothing was created."),
  brand_exists: platform("This studio already has a brand registration or an unresolved attempt.", "Do not create another. Check the existing brand at Twilio."),
  brand_unexpected_status: platform("The brand has a status we do not recognise.", "Look at the brand at Twilio before doing anything."),
  brand_mirror_failed: platform("The brand exists at Twilio but could not be recorded here.", "The step list still holds its id. Report it to engineering; do not create another brand."),
  // --- Twilio's review
  profile_rejected: platform("Twilio rejected the business profile.", "Read Twilio's reason, decide with the owner whether to correct and start a new attempt. Nothing is resubmitted automatically."),
  trust_product_rejected: platform("Twilio rejected the A2P trust product.", "Read Twilio's reason, correct it, and start a new attempt. Nothing is resubmitted automatically."),
  brand_rejected: platform("Twilio rejected the brand.", "Read Twilio's reason and decide with the owner. No second brand is created automatically."),
  brand_suspended: platform("Twilio suspended the brand.", "Contact Twilio; texting must not be turned on."),
  rejected: platform("Twilio rejected the brand.", "Read Twilio's reason and decide with the owner. No second brand is created automatically."),
  suspended: platform("Twilio suspended the brand.", "Contact Twilio; texting must not be turned on."),
  unexpected_status: platform("The brand has a status we do not recognise.", "Look at the brand at Twilio before doing anything."),
  // --- waiting
  "pending-review": twilio("Twilio has the submission and has not started reviewing it.", "Nothing to do. Check the status again later."),
  "in-review": twilio("Twilio is reviewing the submission.", "Nothing to do. Reviews take from minutes to several business days."),
  "twilio-approved": twilio("Twilio approved it.", "Nothing to do."),
};

/**
 * Finds the catalog entry for a run result detail or a ledger error code, e.g. "S10:noncompliant:email", "S11:review",
 * "preverify:S10:...", "brand:rejected", "profile_rejected;profile=twilio-rejected". The first token the catalog knows wins.
 */
export function explainCode(raw: string | null | undefined): CatalogEntry | null {
  const tokens = String(raw ?? "").split(/[:;,\s=]+/).filter(Boolean);
  for (const token of tokens) {
    const entry = ERROR_CATALOG[token];
    if (entry) return entry;
  }
  return null;
}
