import {
  describeCampaignAllowanceBlock,
  type CampaignAllowanceDecision,
} from "@/lib/usage/campaignAllowance";

const num = (value: number) => value.toLocaleString("en-US");

/**
 * ENT-1: the monthly email allowance state next to the send form, shared by the studio and organizer campaign pages.
 * Informational only: the server-side send path is authoritative and re-checks atomically.
 */
export default function CampaignAllowancePanel({
  decision,
}: {
  decision: CampaignAllowanceDecision;
}) {
  const { state, recipients } = decision;
  const tone = decision.allowed
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : "border-red-200 bg-red-50 text-red-800";

  return (
    <div
      className={`mt-3 rounded-xl border p-3 text-xs leading-5 ${tone}`}
      data-testid="campaign-allowance-panel"
    >
      <p className="font-bold">Monthly email allowance</p>
      {state.entitled ? (
        <>
          <p className="mt-1">
            {num(recipients)} recipient{recipients === 1 ? "" : "s"}
            <br />
            {num(state.totalAllowance)} monthly allowance
            <br />
            {decision.allowed
              ? `${num(decision.remainingAfterSend ?? 0)} remaining after this send`
              : `${num(state.remaining)} remaining this month`}
          </p>
          {decision.allowed ? null : (
            <p className="mt-2 font-semibold">
              This campaign exceeds your remaining monthly email allowance.
              Nothing will be sent. Upgrade your plan to increase your monthly
              allowance.
            </p>
          )}
        </>
      ) : (
        <p className="mt-1">
          {describeCampaignAllowanceBlock({
            reason: state.blockedReason ?? "lookup_failed",
            recipients,
            planName: state.planName,
            allowance: state.totalAllowance,
            used: state.used + state.reserved,
            remaining: state.remaining,
          })}
        </p>
      )}
    </div>
  );
}
