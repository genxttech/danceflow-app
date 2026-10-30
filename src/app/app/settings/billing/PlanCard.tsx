import { ArrowRight } from "lucide-react";
import {
  formatPlanMoney,
  type BillingPlan,
  type PlanAudience,
} from "@/lib/billing/plans";
import {
  resolveDisplayedMonthlyPriceCents,
  resolveTransparentPricingNote,
} from "@/lib/billing/founderPricing";
import { resolvePlanCardCta } from "@/lib/billing/billingPortalErrors";

export function badgeClasses(
  tone: "green" | "yellow" | "red" | "slate" | "violet" | "sky",
) {
  switch (tone) {
    case "green":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
    case "yellow":
      return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    case "red":
      return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
    case "violet":
      return "bg-violet-50 text-violet-700 ring-1 ring-violet-200";
    case "sky":
      return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
    default:
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
}

export function PlanCard({
  plan,
  selectedAudience,
  isCurrent,
  isRecommended,
  entryMode,
  hasManagedSubscription,
}: {
  plan: BillingPlan;
  selectedAudience: PlanAudience;
  isCurrent: boolean;
  isRecommended: boolean;
  entryMode: string;
  hasManagedSubscription: boolean;
}) {
  const cta = resolvePlanCardCta({
    isCurrent,
    hasManagedSubscription,
    planLabel: plan.label,
  });

  return (
    <div
      className={[
        "rounded-[28px] border bg-white p-6 shadow-sm",
        isRecommended
          ? "border-violet-300 ring-2 ring-violet-100"
          : "border-slate-200",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
            {plan.audience === "organizer" ? "Organizer Plan" : "Studio Plan"}
          </p>
          <h3 className="mt-2 text-2xl font-semibold text-slate-950">
            {plan.label}
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {plan.description}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          {isCurrent ? (
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                "green",
              )}`}
            >
              Current plan
            </span>
          ) : null}

          {isRecommended ? (
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                "violet",
              )}`}
            >
              Recommended
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        <p className="text-3xl font-semibold text-slate-950">
          {formatPlanMoney(resolveDisplayedMonthlyPriceCents(plan))}
          <span className="ml-1 text-base font-medium text-slate-500">
            /month
          </span>
        </p>
        <p className="mt-2 text-sm text-slate-500">
          {plan.trialDays}-day free trial
        </p>
      </div>

      <ul className="mt-6 space-y-2 text-sm text-slate-600">
        {plan.highlights.map((highlight) => (
          <li key={highlight}>• {highlight}</li>
        ))}
      </ul>

      {resolveTransparentPricingNote(plan) ? (
        <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-800">
          {resolveTransparentPricingNote(plan)}
        </div>
      ) : null}

      {cta.kind === "contact_support" ? (
        <div className="mt-6">
          <a
            href={cta.mailto}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            <span>{cta.label}</span>
          </a>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Plan changes are reviewed individually by our team. Your plan and
            price do not change until we confirm with you.
          </p>
        </div>
      ) : (
        <form action="/api/billing/checkout" method="post" className="mt-6">
          <input type="hidden" name="planCode" value={plan.code} />
          <input type="hidden" name="path" value={selectedAudience} />
          <input type="hidden" name="entry" value={entryMode} />
          <input type="hidden" name="billingInterval" value="month" />

          <button
            type="submit"
            disabled={isCurrent}
            className={[
              "inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition",
              isCurrent
                ? "cursor-not-allowed border border-slate-300 bg-white text-slate-500"
                : "bg-slate-900 text-white hover:bg-slate-800",
            ].join(" ")}
          >
            <span>{cta.label}</span>
            {!isCurrent ? <ArrowRight className="h-4 w-4" /> : null}
          </button>
        </form>
      )}
    </div>
  );
}
