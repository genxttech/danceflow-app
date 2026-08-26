"use client";

import { useActionState } from "react";
import QuickActionPanel from "@/components/ui/QuickActionPanel";

const initialState = { error: "" };

type FiniteItem = {
  id: string;
  usage_type: string;
  quantity_total: number | null;
  quantity_used: number | null;
  quantity_remaining: number | null;
};

type BoundReviewAction = (
  prevState: { error: string },
  formData: FormData,
) => Promise<{ error: string }>;

function fmtCurrency(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function titleCaseLabel(value: string) {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Package Refund P0, Slice 2c-2: the staff review surface for a
 * `pending_review` package refund reconciliation -- Case C from Slice 2c-1
 * (any partial refund, or a refund against a package with unknown/zero
 * price), the state a human must resolve. Wrapped in QuickActionPanel --
 * this tab's established progressive-disclosure idiom (see "Pay-as-you-go
 * Lessons" and "Package Count Correction" elsewhere on this page) -- rather
 * than always-expanded inline content, so the affordance and its
 * expanded/collapsed state are obvious and consistent with the rest of the
 * Billing tab. `defaultOpen` is unconditionally true here, matching the
 * "Pay-as-you-go Lessons" panel's own precedent (`defaultOpen={unpaidPayAsYouGoLessons.length
 * > 0}` -- open specifically because there's actionable content): this
 * component is only ever rendered at all when a real pending_review row
 * exists, so by construction there's always something actionable inside it.
 *
 * `boundAction` is `resolvePartialRefundCreditReviewAction` pre-bound to the
 * current client's id via `.bind(null, id)` in page.tsx (a Server
 * Component) -- see that action's own doc comment for why this specific
 * binding, rather than a hidden form field, is what makes the client-context
 * check underneath it trustworthy.
 */
export default function PartialRefundReviewControls({
  reconciliationId,
  boundAction,
  refundAmountCents,
  refundStatus,
  reconciliationOutcome,
  classification,
  reviewReason,
  items,
}: {
  reconciliationId: string;
  boundAction: BoundReviewAction;
  refundAmountCents: number;
  refundStatus: string;
  reconciliationOutcome: string;
  classification: string | null;
  reviewReason: string | null;
  items: FiniteItem[];
}) {
  const [state, formAction, pending] = useActionState(boundAction, initialState);

  return (
    <div className="mt-3">
      <QuickActionPanel
        title="Partial refund review needed"
        description="This refund was not automatically applied to package credits and needs a staff decision."
        defaultOpen
      >
        <div className="space-y-3">
          {/* Financial/reconciliation context -- four distinct, separately
              labeled fields. Never conflated: Stripe's own refund status,
              the package's structured financial classification (from the
              shared get_client_package_refund_financial_state helper, not
              re-derived here), the staff reconciliation state, and the
              reconciliation row's own free-text explanation are each a
              different concept. */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-amber-200 bg-white p-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Refund amount</dt>
              <dd className="mt-0.5 font-medium text-[var(--brand-text)]">{fmtCurrency(refundAmountCents)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Stripe refund status</dt>
              <dd className="mt-0.5 font-medium text-[var(--brand-text)]">{titleCaseLabel(refundStatus)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Package financial state</dt>
              <dd className="mt-0.5 font-medium text-[var(--brand-text)]">
                {classification ? titleCaseLabel(classification) : "Unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Staff reconciliation state</dt>
              <dd className="mt-0.5 font-medium text-[var(--brand-text)]">{titleCaseLabel(reconciliationOutcome)}</dd>
            </div>
          </dl>

          {reviewReason ? (
            <p className="text-sm leading-6 text-amber-900">
              <span className="font-medium">Why this needs review: </span>
              {reviewReason}
            </p>
          ) : null}

          <form action={formAction} className="space-y-3">
            <input type="hidden" name="reconciliationId" value={reconciliationId} />

            {items.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-amber-200 bg-white">
                <table className="min-w-full divide-y divide-amber-100 text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="px-3 py-2">Usage type</th>
                      <th className="px-3 py-2">Purchased</th>
                      <th className="px-3 py-2">Used</th>
                      <th className="px-3 py-2">Remaining</th>
                      <th className="px-3 py-2">Quantity to void</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-100">
                    {items.map((item) => {
                      const remaining = Number(item.quantity_remaining ?? 0);
                      return (
                        <tr key={item.id}>
                          <td className="px-3 py-2">{titleCaseLabel(item.usage_type)}</td>
                          <td className="px-3 py-2">{item.quantity_total ?? "—"}</td>
                          <td className="px-3 py-2">{item.quantity_used ?? "—"}</td>
                          <td className="px-3 py-2">{remaining}</td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              name={`void_${item.id}`}
                              min={0}
                              max={remaining}
                              defaultValue={0}
                              className="w-20 rounded-lg border border-[var(--brand-border)] px-2 py-1"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                This package has no finite credit items to void.
              </p>
            )}

            <textarea
              name="reviewerNotes"
              maxLength={1000}
              placeholder="Notes for this decision (optional)"
              className="w-full rounded-lg border border-[var(--brand-border)] px-3 py-2 text-sm"
              rows={2}
            />

            {/* Two explicit, separate controls -- one RPC, distinguished by
                `intent`. The server action forces p_voids=[] whenever
                intent="decline", regardless of any quantities entered above,
                so a stale or manipulated form can never turn a Decline into
                a partial apply. */}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                name="intent"
                value="apply"
                disabled={pending}
                className="whitespace-nowrap rounded-full bg-amber-900 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "Applying..." : "Apply credit adjustment"}
              </button>
              <button
                type="submit"
                name="intent"
                value="decline"
                disabled={pending}
                className="whitespace-nowrap rounded-full border border-amber-300 bg-white px-4 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "Saving..." : "Decline — no credit adjustment"}
              </button>
            </div>
          </form>

          {state?.error ? <p className="text-sm text-red-700">{state.error}</p> : null}
        </div>
      </QuickActionPanel>
    </div>
  );
}
