import type { FeeAttention, FeeFacts } from "@/lib/sms/provisioning/journey";

/**
 * TW-4F J2 (O-4): the owner's recurring service coverage (this month and next) for the location's live texting service and number, plus neutral notices.
 * Presentation only, from the owner texting-status read: no amounts, no provider identifiers, no buttons. An unexpected provider resource is DanceFlow's to
 * investigate and is never listed as a coverage item, so nothing here asks the owner to authorize, register, adopt or pay for it.
 */

const KIND: Record<FeeFacts["items"][number]["kind"], string> = { texting_service: "Monthly texting service", phone_number: "Texting phone number" };

const ATTENTION: Record<FeeAttention, string> = {
  none: "",
  authorization_needed: "Not covered yet: the monthly charge needs your authorization in Recurring service charges.",
  payment_processing: "The monthly charge is being processed.",
  funds_needed: "Your prepaid balance did not cover the monthly charge. Add funds in Prepaid texting credit.",
  contact_danceflow: "The monthly charge could not run. DanceFlow will contact you.",
  pilot_approval: "DanceFlow will record this month's written approval with you.",
  danceflow_review: "DanceFlow is reviewing this period. You do not need to do anything.",
};

// the same owner wording as the RFL owner notice (providerFeeAlerts/templates.ts, inventory_gap)
export const UNEXPECTED_HEADING = "We are looking into an unexpected texting resource";
export const UNEXPECTED_DETAIL = "An unexpected messaging resource was identified in connection with your studio, and DanceFlow is investigating. This notice is for your information only: no action is needed from you.";

const period = (p: "covered" | "not_covered") => (p === "covered" ? "Covered" : "Not covered yet");

export default function SmsServiceCoverage({ fees, unexpectedResourceReview }: { fees: FeeFacts; unexpectedResourceReview: boolean }) {
  if (!fees.items.length && !fees.textingPaused && !fees.cancellationInProgress && !unexpectedResourceReview) return null;
  return (
    <section aria-labelledby="sms-coverage-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" data-testid="sms-coverage">
      <h2 id="sms-coverage-heading" className="text-base font-semibold text-slate-950">Service coverage</h2>
      <p className="mt-1 text-xs text-slate-500">Whether this location&apos;s recurring texting charges are covered for this month and next.</p>

      {fees.textingPaused && !fees.cancellationInProgress ? (
        <p role="status" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="sms-coverage-paused">
          Texting is paused while DanceFlow confirms the monthly service coverage for this location.
        </p>
      ) : null}
      {fees.cancellationInProgress ? (
        <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="sms-coverage-cancelling">
          DanceFlow is cancelling a texting resource for this location. Texting stays off for it while that completes.
        </p>
      ) : null}

      {fees.items.length ? (
        <dl className="mt-3 divide-y divide-slate-100 text-sm">
          {fees.items.map((item, i) => (
            <div key={`${item.kind}-${i}`} className="grid gap-1 py-2 sm:grid-cols-[1fr_auto]" data-coverage={item.kind} data-attention={item.attention}>
              <dt>
                <span className="font-medium text-slate-900">{KIND[item.kind]}</span>
                {item.attention !== "none" ? <span className="block text-xs text-slate-600">{ATTENTION[item.attention]}</span> : null}
              </dt>
              <dd className="text-slate-800">
                <span className="block">This month: {period(item.currentPeriod)}</span>
                <span className="block">Next month: {period(item.nextPeriod)}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {unexpectedResourceReview ? (
        <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2" data-testid="sms-coverage-unexpected">
          <p className="text-sm font-semibold text-sky-950">{UNEXPECTED_HEADING}</p>
          <p className="mt-0.5 text-sm text-sky-900">{UNEXPECTED_DETAIL}</p>
        </div>
      ) : null}
    </section>
  );
}
