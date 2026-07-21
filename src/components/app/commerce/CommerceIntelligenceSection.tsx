import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  CirclePlay,
  PackageCheck,
  ShoppingBag,
  TrendingUp,
} from "lucide-react";
import type { CommerceIntelligence } from "@/lib/commerce/intelligence";

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function percent(value: number) {
  return `${Math.round(value)}%`;
}

function recommendation(data: CommerceIntelligence) {
  if (data.strongestSignal === "fulfillment") {
    return {
      title: "Clear paid orders waiting on fulfillment.",
      detail: `${data.unfulfilledOrderCount} paid order${data.unfulfilledOrderCount === 1 ? " is" : "s are"} still waiting on fulfillment.`,
      href: "/app/orders",
      label: "Review orders",
    };
  }

  if (data.strongestSignal === "inventory") {
    return {
      title: "Restock before sales are interrupted.",
      detail: `${data.lowStockVariantCount} active variant${data.lowStockVariantCount === 1 ? " is" : "s are"} at or below the reorder threshold.`,
      href: "/app/catalog",
      label: "Review inventory",
    };
  }

  if (data.strongestSignal === "never_started") {
    return {
      title: "Help digital buyers start learning.",
      detail: `${data.digitalNeverStartedCount} digital purchase${data.digitalNeverStartedCount === 1 ? " has" : "s have"} not been started.`,
      href: "/app/orders",
      label: "Review digital buyers",
    };
  }

  if (data.strongestSignal === "low_completion") {
    return {
      title: "Review content with weak engagement.",
      detail: `${data.digitalLowCompletionCount} digital purchase${data.digitalLowCompletionCount === 1 ? " has" : "s have"} started but remains below 35% completion.`,
      href: "/app/catalog",
      label: "Review content",
    };
  }

  return {
    title: "Commerce is ready for growth.",
    detail:
      "No urgent fulfillment, inventory, or digital engagement issue is standing out.",
    href: "/app/catalog",
    label: "Grow the catalog",
  };
}

export default function CommerceIntelligenceSection({
  data,
  title = "Commerce and content intelligence",
}: {
  data: CommerceIntelligence;
  title?: string;
}) {
  const nextMove = recommendation(data);

  return (
    <section className="rounded-[32px] border border-violet-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
            ARIA Commerce Intelligence
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            {title}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Sales, fulfillment, inventory, and student content engagement are
            evaluated together so the next action links directly to Orders or
            Catalog.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/app/orders"
            className="rounded-xl border border-violet-200 bg-white px-4 py-2 text-sm font-semibold text-[#6B21A8] hover:bg-violet-50"
          >
            Orders
          </Link>
          <Link
            href="/app/catalog"
            className="rounded-xl bg-[#6B21A8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#581C87]"
          >
            Catalog
          </Link>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          {
            label: "Net commerce revenue",
            value: money(data.netRevenue),
            helper: `${data.completedOrderCount} completed orders`,
            icon: TrendingUp,
          },
          {
            label: "Average order",
            value: money(data.averageOrderValue),
            helper: `${money(data.refunds)} refunded`,
            icon: ShoppingBag,
          },
          {
            label: "Needs fulfillment",
            value: String(data.unfulfilledOrderCount),
            helper: "Paid orders requiring action",
            icon: PackageCheck,
          },
          {
            label: "Low stock",
            value: String(data.lowStockVariantCount),
            helper: "Variants at reorder level",
            icon: Boxes,
          },
          {
            label: "Content completion",
            value: percent(data.digitalCompletionRate),
            helper: `${percent(data.digitalStartRate)} started`,
            icon: CirclePlay,
          },
        ].map((metric) => {
          const Icon = metric.icon;
          return (
            <div
              key={metric.label}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
            >
              <Icon className="h-5 w-5 text-[#6B21A8]" />
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                {metric.label}
              </p>
              <p className="mt-1 text-2xl font-semibold text-slate-950">
                {metric.value}
              </p>
              <p className="mt-1 text-xs text-slate-500">{metric.helper}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.1fr_1fr_1fr]">
        <article className="rounded-3xl border border-pink-200 bg-pink-50/70 p-5">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pink-700">
            ARIA next move
          </p>
          <h3 className="mt-2 text-lg font-semibold text-slate-950">
            {nextMove.title}
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            {nextMove.detail}
          </p>
          <Link
            href={nextMove.href}
            className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-pink-800 hover:underline"
          >
            {nextMove.label}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </article>

        <article className="rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
            Top-selling items
          </p>
          <div className="mt-3 space-y-3">
            {data.topProducts.length ? (
              data.topProducts.slice(0, 4).map((item) => (
                <div
                  key={`${item.catalogItemId ?? item.name}`}
                  className="flex items-start justify-between gap-3"
                >
                  <div>
                    <Link
                      href={
                        item.catalogItemId
                          ? `/app/catalog/${item.catalogItemId}`
                          : "/app/catalog"
                      }
                      className="text-sm font-semibold text-slate-950 hover:text-[#6B21A8]"
                    >
                      {item.name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {item.units} unit{item.units === 1 ? "" : "s"}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-slate-700">
                    {money(item.revenue)}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-sm leading-6 text-slate-500">
                Top sellers will appear after catalog orders are completed.
              </p>
            )}
          </div>
        </article>

        <article className="rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
            Digital engagement
          </p>
          <div className="mt-3 space-y-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-slate-600">Purchases</span>
              <span className="font-semibold text-slate-950">
                {data.digitalEntitlementCount}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-600">Never started</span>
              <span className="font-semibold text-slate-950">
                {data.digitalNeverStartedCount}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-600">Low completion</span>
              <span className="font-semibold text-slate-950">
                {data.digitalLowCompletionCount}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-600">Completed</span>
              <span className="font-semibold text-slate-950">
                {data.digitalCompletedCount}
              </span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
