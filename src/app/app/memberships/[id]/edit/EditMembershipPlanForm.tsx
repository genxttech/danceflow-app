"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { updateMembershipPlanAction } from "../../actions";

type BenefitRow = {
  id: string;
  benefitType: string;
  quantity: string;
  discountPercent: string;
  discountAmount: string;
  usagePeriod: string;
  appliesTo: string;
};

type MembershipPlan = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  billing_interval: string;
  price: number;
  signup_fee: number | null;
  auto_renew_default: boolean;
  visibility: string;
  sort_order: number;
};

type MembershipBenefit = {
  id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string;
  applies_to: string | null;
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

function normalizeBenefit(benefit: MembershipBenefit): BenefitRow {
  return {
    id: benefit.id,
    benefitType: benefit.benefit_type,
    quantity: benefit.quantity == null ? "" : String(benefit.quantity),
    discountPercent:
      benefit.discount_percent == null ? "" : String(benefit.discount_percent),
    discountAmount:
      benefit.discount_amount == null ? "" : String(benefit.discount_amount),
    usagePeriod: benefit.usage_period,
    appliesTo: benefit.applies_to ?? "",
  };
}

export default function EditMembershipPlanForm({
  plan,
  benefits,
}: {
  plan: MembershipPlan;
  benefits: MembershipBenefit[];
}) {
  const [state, formAction, pending] = useActionState(
    updateMembershipPlanAction,
    initialState
  );

  const [rows, setRows] = useState<BenefitRow[]>(
    benefits.length > 0 ? benefits.map(normalizeBenefit) : [makeBenefit()]
  );

  const benefitsJson = useMemo(() => {
    return JSON.stringify(
      rows.map((benefit) => ({
        benefitType: benefit.benefitType,
        quantity: benefit.quantity,
        discountPercent: benefit.discountPercent,
        discountAmount: benefit.discountAmount,
        usagePeriod: benefit.usagePeriod,
        appliesTo: benefit.appliesTo,
      }))
    );
  }, [rows]);

  function addBenefit() {
    setRows((current) => [...current, makeBenefit()]);
  }

  function removeBenefit(id: string) {
    setRows((current) => {
      if (current.length === 1) return current;
      return current.filter((benefit) => benefit.id !== id);
    });
  }

  function updateBenefit(id: string, patch: Partial<BenefitRow>) {
    setRows((current) =>
      current.map((benefit) =>
        benefit.id === id ? { ...benefit, ...patch } : benefit
      )
    );
  }

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-[var(--brand-surface)] shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary),var(--brand-accent))] px-6 py-7 text-white md:px-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/75">
                DanceFlow Memberships
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
                Edit membership plan
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/85">
                Update pricing, portal visibility, renewal defaults, and included benefits for this membership.
              </p>
            </div>

            <Link
              href={`/app/memberships/${plan.id}`}
              className="inline-flex items-center justify-center rounded-2xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20"
            >
              Back to Plan
            </Link>
          </div>
        </div>

        <div className="grid gap-4 bg-white/80 px-6 py-5 md:grid-cols-4 md:px-8">
          <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</p>
            <p className="mt-1 text-lg font-semibold text-[var(--brand-text)]">
              {plan.active ? "Active" : "Inactive"}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Billing</p>
            <p className="mt-1 text-lg font-semibold text-[var(--brand-text)]">
              ${Number(plan.price ?? 0).toFixed(2)} / {plan.billing_interval.replaceAll("_", " ")}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Visibility</p>
            <p className="mt-1 text-lg font-semibold capitalize text-[var(--brand-text)]">
              {plan.visibility}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Benefits</p>
            <p className="mt-1 text-lg font-semibold text-[var(--brand-text)]">
              {rows.length}
            </p>
          </div>
        </div>
      </section>

      <form action={formAction} className="space-y-8 rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm md:p-6">
        <input type="hidden" name="id" value={plan.id} />
        <input type="hidden" name="benefitsJson" value={benefitsJson} />

        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-[var(--brand-text)]">Plan details</h2>
            <p className="mt-1 text-sm text-slate-600">
              Keep the public-facing name, pricing, and sales settings clear for staff and clients.
            </p>
          </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="name" className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
              Plan name
            </label>
            <input
              id="name"
              name="name"
              required
              defaultValue={plan.name}
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
            />
          </div>

          <div>
            <label
              htmlFor="billingInterval"
              className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]"
            >
              Billing interval
            </label>
            <select
              id="billingInterval"
              name="billingInterval"
              defaultValue={plan.billing_interval}
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>

          <div>
            <label htmlFor="price" className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
              Price
            </label>
            <input
              id="price"
              name="price"
              type="number"
              step="0.01"
              min="0"
              required
              defaultValue={plan.price}
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
            />
          </div>

          <div>
            <label htmlFor="signupFee" className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
              Signup fee
            </label>
            <input
              id="signupFee"
              name="signupFee"
              type="number"
              step="0.01"
              min="0"
              defaultValue={plan.signup_fee ?? ""}
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
            />
          </div>

          <div>
            <label htmlFor="visibility" className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
              Visibility
            </label>
            <select
              id="visibility"
              name="visibility"
              defaultValue={plan.visibility}
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </div>

          <div>
            <label htmlFor="sortOrder" className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
              Sort order
            </label>
            <input
              id="sortOrder"
              name="sortOrder"
              type="number"
              defaultValue={plan.sort_order}
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
            />
          </div>
        </div>

        <div>
          <label htmlFor="description" className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            defaultValue={plan.description ?? ""}
            className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
          />
        </div>

        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-[var(--brand-text)]">Sales defaults</h2>
            <p className="mt-1 text-sm text-slate-600">
              Control whether this membership is currently sold and how new memberships renew.
            </p>
          </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex items-start gap-3 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-muted)]/40 p-4">
            <input
              type="checkbox"
              name="active"
              defaultChecked={plan.active}
              className="mt-1 h-4 w-4 rounded border-[var(--brand-border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            />
            <div>
              <p className="font-semibold text-[var(--brand-text)]">Active plan</p>
              <p className="mt-1 text-sm text-slate-600">
                Inactive plans stay in the system but are not sold by default.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-muted)]/40 p-4">
            <input
              type="checkbox"
              name="autoRenewDefault"
              defaultChecked={plan.auto_renew_default}
              className="mt-1 h-4 w-4 rounded border-[var(--brand-border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            />
            <div>
              <p className="font-semibold text-[var(--brand-text)]">Auto renew by default</p>
              <p className="mt-1 text-sm text-slate-600">
                New client memberships created from this plan will default to auto renew.
              </p>
            </div>
          </label>
        </div>

        </section>

        <section className="rounded-3xl border border-[var(--brand-border)] bg-[var(--brand-muted)]/35 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-[var(--brand-text)]">Benefits</h3>
              <p className="mt-1 text-sm text-slate-600">
                Update included lessons, class access, event perks, and member discounts.
              </p>
            </div>

            <button
              type="button"
              onClick={addBenefit}
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)] transition hover:bg-[var(--brand-muted)]"
            >
              Add Benefit
            </button>
          </div>

          <div className="mt-5 space-y-4">
            {rows.map((benefit, index) => (
              <div
                key={benefit.id}
                className="rounded-3xl border border-[var(--brand-border)] bg-white p-4 shadow-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-[var(--brand-text)]">
                    Benefit {index + 1}
                  </p>

                  <button
                    type="button"
                    onClick={() => removeBenefit(benefit.id)}
                    disabled={rows.length === 1}
                    className="rounded-2xl border border-[var(--brand-border)] px-3 py-1.5 text-sm font-semibold text-slate-600 transition hover:bg-[var(--brand-muted)] disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
                      Benefit Type
                    </label>
                    <select
                      value={benefit.benefitType}
                      onChange={(e) =>
                        updateBenefit(benefit.id, { benefitType: e.target.value })
                      }
                      className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                    >
                      <option value="unlimited_group_classes">
                        Unlimited Group Classes
                      </option>
                      <option value="included_group_classes">
                        Included Group Classes
                      </option>
                      <option value="unlimited_practice_parties">
                        Unlimited Practice Parties
                      </option>
                      <option value="included_private_lessons">
                        Included Private Lessons
                      </option>
                      <option value="discount_private_lessons_percent">
                        Private Lesson Discount Percent
                      </option>
                      <option value="discount_private_lessons_fixed">
                        Private Lesson Fixed Discount
                      </option>
                      <option value="event_discount_percent">
                        Event Discount Percent
                      </option>
                      <option value="floor_rental_discount_percent">
                        Floor Rental Discount Percent
                      </option>
                      <option value="discount_floor_rental_fixed">
                        Floor Rental Fixed Discount
                      </option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
                      Usage Period
                    </label>
                    <select
                      value={benefit.usagePeriod}
                      onChange={(e) =>
                        updateBenefit(benefit.id, { usagePeriod: e.target.value })
                      }
                      className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                    >
                      <option value="billing_cycle">Billing Cycle</option>
                      <option value="monthly">Monthly</option>
                      <option value="unlimited">Unlimited</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
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
                      className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
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
                      className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
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
                      className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-[var(--brand-text)]">
                      Applies To
                    </label>
                    <input
                      value={benefit.appliesTo}
                      onChange={(e) =>
                        updateBenefit(benefit.id, { appliesTo: e.target.value })
                      }
                      placeholder="Leave blank for all applicable appointments"
                      className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2.5 text-[var(--brand-text)] outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Use this only when a benefit should apply to one specific appointment type.
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {state.error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-2xl bg-[var(--brand-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save Membership Plan"}
          </button>

          <Link
            href={`/app/memberships/${plan.id}`}
            className="rounded-2xl border border-[var(--brand-border)] px-5 py-2.5 text-sm font-semibold text-[var(--brand-text)] transition hover:bg-[var(--brand-muted)]"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}