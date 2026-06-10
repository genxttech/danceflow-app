"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { createMembershipPlanAction } from "../actions";

type BenefitRow = {
  id: string;
  benefitType: string;
  quantity: string;
  discountPercent: string;
  discountAmount: string;
  usagePeriod: string;
  appliesTo: string;
};

type ActionState = {
  error: string;
};

const initialState: ActionState = {
  error: "",
};

const benefitTypeOptions = [
  {
    value: "unlimited_group_classes",
    label: "Unlimited group classes",
    helper:
      "Clients can attend eligible group classes during the billing period.",
  },
  {
    value: "unlimited_practice_parties",
    label: "Unlimited practice parties",
    helper:
      "Clients can attend eligible practice parties during the billing period.",
  },
  {
    value: "included_private_lessons",
    label: "Included private lessons",
    helper: "Adds a set number of private lessons per billing period.",
  },
  {
    value: "event_discount_percent",
    label: "Event discount",
    helper: "Applies a percentage or dollar discount to eligible events.",
  },
  {
    value: "floor_rental_discount_percent",
    label: "Floor rental discount",
    helper:
      "Applies a percentage or dollar discount to eligible floor rentals.",
  },
];

function makeBenefit(): BenefitRow {
  return {
    id: crypto.randomUUID(),
    benefitType: "unlimited_group_classes",
    quantity: "",
    discountPercent: "",
    discountAmount: "",
    usagePeriod: "billing_cycle",
    appliesTo: "",
  };
}

function benefitTypeLabel(value: string) {
  return (
    benefitTypeOptions.find((option) => option.value === value)?.label ??
    value.replaceAll("_", " ")
  );
}

export default function NewMembershipPlanPage() {
  const [state, formAction, pending] = useActionState(
    createMembershipPlanAction,
    initialState,
  );

  const [benefits, setBenefits] = useState<BenefitRow[]>([]);
  const [showPortal, setShowPortal] = useState(true);

  const benefitsJson = useMemo(() => {
    return JSON.stringify(
      benefits.map((benefit) => ({
        benefitType: benefit.benefitType,
        quantity: benefit.quantity,
        discountPercent: benefit.discountPercent,
        discountAmount: benefit.discountAmount,
        usagePeriod: benefit.usagePeriod,
        appliesTo: benefit.appliesTo,
      })),
    );
  }, [benefits]);

  function addBenefit() {
    setBenefits((current) => [...current, makeBenefit()]);
  }

  function removeBenefit(id: string) {
    setBenefits((current) => current.filter((benefit) => benefit.id !== id));
  }

  function updateBenefit(id: string, patch: Partial<BenefitRow>) {
    setBenefits((current) =>
      current.map((benefit) =>
        benefit.id === id ? { ...benefit, ...patch } : benefit,
      ),
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-violet-100 bg-gradient-to-br from-slate-950 via-violet-950 to-fuchsia-900 p-6 text-white shadow-sm md:p-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-amber-200">
              DanceFlow Memberships
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              Create a membership people understand before they buy
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-violet-100">
              Set the price, explain what is included, then choose whether
              clients can see it in the portal. Keep this page focused on what
              the studio is selling—not internal setup details.
            </p>
          </div>

          <Link
            href="/app/memberships"
            className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
          >
            Back to Memberships
          </Link>
        </div>
      </section>

      <form action={formAction} className="space-y-8">
        <input type="hidden" name="benefitsJson" value={benefitsJson} />
        <input
          type="hidden"
          name="visibility"
          value={showPortal ? "public" : "private"}
        />

        <section className="rounded-3xl border bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 border-b pb-5">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
              Step 1
            </p>
            <h2 className="text-2xl font-semibold text-slate-950">
              Basic details
            </h2>
            <p className="text-sm text-slate-600">
              Name the plan and set how often the client is billed.
            </p>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="name"
                className="mb-1 block text-sm font-medium text-slate-800"
              >
                Membership name
              </label>
              <input
                id="name"
                name="name"
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                placeholder="VIP Membership"
              />
            </div>

            <div>
              <label
                htmlFor="billingInterval"
                className="mb-1 block text-sm font-medium text-slate-800"
              >
                Billing interval
              </label>
              <select
                id="billingInterval"
                name="billingInterval"
                defaultValue="monthly"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="price"
                className="mb-1 block text-sm font-medium text-slate-800"
              >
                Recurring price
              </label>
              <input
                id="price"
                name="price"
                type="number"
                step="0.01"
                min="0"
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                placeholder="99.00"
              />
            </div>

            <div>
              <label
                htmlFor="signupFee"
                className="mb-1 block text-sm font-medium text-slate-800"
              >
                One-time signup fee
              </label>
              <input
                id="signupFee"
                name="signupFee"
                type="number"
                step="0.01"
                min="0"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                placeholder="Optional"
              />
            </div>
          </div>

          <div className="mt-5">
            <label
              htmlFor="description"
              className="mb-1 block text-sm font-medium text-slate-800"
            >
              Short description
            </label>
            <textarea
              id="description"
              name="description"
              rows={4}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
              placeholder="Describe who this membership is for and what makes it valuable."
            />
          </div>
        </section>

        <section className="rounded-3xl border bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 border-b pb-5 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
                Step 2
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Included benefits
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">
                Add only the benefits clients receive. Removed benefits are no
                longer saved with the plan.
              </p>
            </div>

            <button
              type="button"
              onClick={addBenefit}
              className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-800 hover:bg-violet-100"
            >
              Add Benefit
            </button>
          </div>

          {benefits.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
              <h3 className="text-lg font-semibold text-slate-900">
                No benefits added yet
              </h3>
              <p className="mx-auto mt-2 max-w-xl text-sm text-slate-600">
                That is okay for a simple recurring membership. Add benefits
                when the plan includes classes, lessons, discounts, or other
                perks.
              </p>
              <button
                type="button"
                onClick={addBenefit}
                className="mt-5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Add First Benefit
              </button>
            </div>
          ) : (
            <div className="mt-6 space-y-4">
              {benefits.map((benefit, index) => (
                <div
                  key={benefit.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900">
                        Benefit {index + 1}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {benefitTypeLabel(benefit.benefitType)}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => removeBenefit(benefit.id)}
                      className="rounded-xl border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-800">
                        Benefit type
                      </label>
                      <select
                        value={benefit.benefitType}
                        onChange={(e) =>
                          updateBenefit(benefit.id, {
                            benefitType: e.target.value,
                          })
                        }
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                      >
                        {benefitTypeOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-slate-500">
                        {
                          benefitTypeOptions.find(
                            (option) => option.value === benefit.benefitType,
                          )?.helper
                        }
                      </p>
                    </div>

                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-800">
                        Usage period
                      </label>
                      <select
                        value={benefit.usagePeriod}
                        onChange={(e) =>
                          updateBenefit(benefit.id, {
                            usagePeriod: e.target.value,
                          })
                        }
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                      >
                        <option value="billing_cycle">
                          Each billing cycle
                        </option>
                        <option value="monthly">Each month</option>
                        <option value="unlimited">Unlimited</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-800">
                        Quantity
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={benefit.quantity}
                        onChange={(e) =>
                          updateBenefit(benefit.id, {
                            quantity: e.target.value,
                          })
                        }
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                        placeholder="Optional"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-800">
                        Discount percent
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={benefit.discountPercent}
                        onChange={(e) =>
                          updateBenefit(benefit.id, {
                            discountPercent: e.target.value,
                          })
                        }
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                        placeholder="Optional"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-800">
                        Discount amount
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={benefit.discountAmount}
                        onChange={(e) =>
                          updateBenefit(benefit.id, {
                            discountAmount: e.target.value,
                          })
                        }
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                        placeholder="Optional"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-800">
                        Applies to
                      </label>
                      <input
                        value={benefit.appliesTo}
                        onChange={(e) =>
                          updateBenefit(benefit.id, {
                            appliesTo: e.target.value,
                          })
                        }
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                        placeholder="Optional notes, class type, or event type"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-3xl border bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 border-b pb-5">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
              Step 3
            </p>
            <h2 className="text-2xl font-semibold text-slate-950">
              Selling settings
            </h2>
            <p className="text-sm text-slate-600">
              Choose whether this plan is available and whether clients can see
              it in the portal.
            </p>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <label className="flex items-start gap-3 rounded-2xl border bg-slate-50 p-4">
              <input
                type="checkbox"
                name="active"
                defaultChecked
                className="mt-1"
              />
              <div>
                <p className="font-medium text-slate-900">
                  Available for staff to sell
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  Turn this off when the plan should be retired but kept for
                  reporting history.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 rounded-2xl border bg-slate-50 p-4">
              <input
                type="checkbox"
                checked={showPortal}
                onChange={(e) => setShowPortal(e.target.checked)}
                className="mt-1"
              />
              <div>
                <p className="font-medium text-slate-900">
                  Show in client portal
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  Clients can view or purchase this plan from client-facing
                  membership screens when portal sales are enabled.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 rounded-2xl border bg-slate-50 p-4">
              <input
                type="checkbox"
                name="autoRenewDefault"
                defaultChecked
                className="mt-1"
              />
              <div>
                <p className="font-medium text-slate-900">
                  Auto renew by default
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  New client memberships created from this plan default to
                  renewing each billing period.
                </p>
              </div>
            </label>

            <div>
              <label
                htmlFor="sortOrder"
                className="mb-1 block text-sm font-medium text-slate-800"
              >
                Display order
              </label>
              <input
                id="sortOrder"
                name="sortOrder"
                type="number"
                defaultValue="0"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
              />
              <p className="mt-1 text-xs text-slate-500">
                Lower numbers appear first.
              </p>
            </div>
          </div>
        </section>

        {state.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-2xl border bg-white/95 p-4 shadow-lg backdrop-blur md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-slate-600">
            Review the plan, then create it. You can edit benefits later.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/memberships"
              className="rounded-xl border px-4 py-2 text-sm font-medium hover:bg-slate-50"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={pending}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {pending ? "Creating..." : "Create Membership Plan"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
