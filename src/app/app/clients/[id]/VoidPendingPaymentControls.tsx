"use client";

import { useActionState } from "react";
import { voidPendingPaymentAction } from "./actions";

const initialState = { error: "" };

/**
 * PKG-P1 section 14: staff-initiated void of a stale `pending` payment --
 * distinct from Refund (which only ever applies to a `'paid'` payment).
 * `showPackageDeactivationWarning` is computed server-side by the page from
 * the canonical `would_package_remain_settled_without_payment` RPC (never
 * re-derived here) -- when true, this payment is the package's last valid
 * settlement basis, and voiding it will atomically deactivate that package
 * in the same action.
 */
export default function VoidPendingPaymentControls({
  clientId,
  paymentId,
  showPackageDeactivationWarning,
}: {
  clientId: string;
  paymentId: string;
  showPackageDeactivationWarning: boolean;
}) {
  const [state, formAction, pending] = useActionState(voidPendingPaymentAction, initialState);

  return (
    <details className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <summary className="cursor-pointer text-sm font-semibold text-slate-800">
        Void this pending payment
      </summary>
      <form action={formAction} className="mt-3 space-y-3">
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="paymentId" value={paymentId} />

        <p className="text-sm leading-6 text-slate-600">
          Use this when this payment never actually settled (an abandoned checkout, a stuck
          terminal attempt) and you want DanceFlow to stop treating it as open. This does not
          contact Stripe -- if money was genuinely captured, use Refund instead.
        </p>

        {showPackageDeactivationWarning ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Voiding this payment will also deactivate the linked package, because no other valid
            payment or entitlement basis covers it.
          </div>
        ) : null}

        <div>
          <label htmlFor={`void-reason-${paymentId}`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Reason (required)
          </label>
          <input
            id={`void-reason-${paymentId}`}
            name="reason"
            type="text"
            required
            maxLength={500}
            placeholder="e.g. customer abandoned checkout, confirmed no charge in Stripe"
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        {state?.error ? <p className="text-sm text-red-700">{state.error}</p> : null}

        <button
          type="submit"
          disabled={pending}
          className="rounded-xl border border-slate-400 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Voiding..." : "Void payment"}
        </button>
      </form>
    </details>
  );
}
