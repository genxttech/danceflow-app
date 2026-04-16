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

export default function NewMembershipPlanPage() {
  const [state, formAction, pending] = useActionState(
    createMembershipPlanAction,
    initialState
  );

  const [benefits, setBenefits] = useState<BenefitRow[]>([makeBenefit()]);

  const benefitsJson = useMemo(() => {
    return JSON.stringify(
      benefits.map((benefit) => ({
        benefitType: benefit.benefitType,
        quantity: benefit.quantity,
        discountPercent: benefit.discountPercent,
        discountAmount: benefit.discountAmount,
        usagePeriod: benefit.usagePeriod,
        appliesTo: benefit.appliesTo,
      }))
    );
  }, [benefits]);

  function addBenefit() {
    setBenefits((current) => [...current, makeBenefit()]);
  }

  function removeBenefit(id: string) {
    setBenefits((current) => {
      if (current.length === 1) return current;
      return current.filter((benefit) => benefit.id !== id);
    });
  }

  function updateBenefit(id: string, patch: Partial<BenefitRow>) {
    setBenefits((current) =>
      current.map((benefit) =>
        benefit.id === id ? { ...benefit, ...patch } : benefit
      )
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">
            New Membership Plan
          </h2>
          <p className="mt-2 text-slate-600">
            Create a recurring membership plan with included benefits and discounts.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/memberships"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Memberships
          </Link>
        </div>
      </div>

      <form action={formAction} className="space-y-8 rounded-2xl border bg-white p-6">
        <input type="hidden" name="benefitsJson" value={benefitsJson} />

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="name" className="mb-1 block text-sm font-medium">
              Plan Name
            </label>
            <input
              id="name"
              name="name"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="VIP Membership"
            />
          </div>

          <div>
            <label
              htmlFor="billingInterval"
              className="mb-1 block text-sm font-medium"
            >
              Billing Interval
            </label>
            <select
              id="billingInterval"
              name="billingInterval"
              defaultValue="monthly"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>

          <div>
            <label htmlFor="price" className="mb-1 block text-sm font-medium">
              Price
            </label>
            <input
              id="price"
              name="price"
              type="number"
              step="0.01"
              min="0"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="99.00"
            />
          </div>

          <div>
            <label htmlFor="signupFee" className="mb-1 block text-sm font-medium">
              Signup Fee
            </label>
            <input
              id="signupFee"
              name="signupFee"
              type="number"
              step="0.01"
              min="0"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Optional"
            />
          </div>

          <div>
            <label htmlFor="visibility" className="mb-1 block text-sm font-medium">
              Visibility
            </label>
            <select
              id="visibility"
              name="visibility"
              defaultValue="public"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </div>

          <div>
            <label htmlFor="sortOrder" className="mb-1 block text-sm font-medium">
              Sort Order
            </label>
            <input
              id="sortOrder"
              name="sortOrder"
              type="number"
              defaultValue="0"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>

        <div>
          <label htmlFor="description" className="mb-1 block text-sm font-medium">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Describe the membership and who it is for."
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
            <input
              type="checkbox"
              name="active"
              defaultChecked
              className="mt-1"
            />
            <div>
              <p className="font-medium text-slate-900">Active plan</p>
              <p className="mt-1 text-sm text-slate-600">
                Inactive plans stay in the system but are not sold by default.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
            <input
              type="checkbox"
              name="autoRenewDefault"
              defaultChecked
              className="mt-1"
            />
            <div>
              <p className="font-medium text-slate-900">Auto renew by default</p>
              <p className="mt-1 text-sm text-slate-600">
                New client memberships created from this plan will default to auto renew.
              </p>
            </div>
          </label>
        </div>

        <div className="rounded-2xl border bg-slate-50 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Benefits</h3>
              <p className="mt-1 text-sm text-slate-600">
                Add included access, lesson allowances, and membership discounts.
              </p>
            </div>

            <button
              type="button"
              onClick={addBenefit}
              className="rounded-xl border px-4 py-2 hover:bg-white"
            >
              Add Benefit
            </button>
          </div>

          <div className="mt-5 space-y-4">
            {benefits.map((benefit, index) => (
              <div
                key={benefit.id}
                className="rounded-2xl border border-slate-200 bg-white p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-slate-900">
                    Benefit {index + 1}
                  </p>

                  <button
                    type="button"
                    onClick={() => removeBenefit(benefit.id)}
                    disabled={benefits.length === 1}
                    className="rounded-xl border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Benefit Type
                    </label>
                    <select
                      value={benefit.benefitType}
                      onChange={(e) =>
                        updateBenefit(benefit.id, { benefitType: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    >
                      <option value="unlimited_group_classes">
                        Unlimited Group Classes
                      </option>
                      <option value="unlimited_practice_parties">
                        Unlimited Practice Parties
                      </option>
                      <option value="included_private_lessons">
                        Included Private Lessons
                      </option>
                      <option value="event_discount_percent">
                        Event Discount Percent
                      </option>
                      <option value="floor_rental_discount_percent">
                        Floor Rental Discount Percent
                      </option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Usage Period
                    </label>
                    <select
                      value={benefit.usagePeriod}
                      onChange={(e) =>
                        updateBenefit(benefit.id, { usagePeriod: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    >
                      <option value="billing_cycle">Billing Cycle</option>
                      <option value="monthly">Monthly</option>
                      <option value="unlimited">Unlimited</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Quantity
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={benefit.quantity}
                      onChange={(e) =>
                        updateBenefit(benefit.id, { quantity: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      placeholder="Optional"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Discount Percent
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
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      placeholder="Optional"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Discount Amount
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
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      placeholder="Optional"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Applies To
                    </label>
                    <input
                      value={benefit.appliesTo}
                      onChange={(e) =>
                        updateBenefit(benefit.id, { appliesTo: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      placeholder="Optional"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {state.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Creating..." : "Create Membership Plan"}
          </button>

          <Link
            href="/app/memberships"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}