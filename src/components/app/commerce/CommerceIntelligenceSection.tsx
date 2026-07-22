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
    const first = data.unfulfilledOrders[0];
    return {
      title: "Clear paid orders waiting on fulfillment.",
      detail: `${data.unfulfilledOrderCount} paid order${data.unfulfilledOrderCount === 1 ? " is" : "s are"} still waiting on fulfillment.`,
      href: first ? `/app/orders/${first.orderId}` : "/app/orders",
      label: first ? `Open order ${first.orderNumber}` : "Review orders",
    };
  }

  if (data.strongestSignal === "inventory") {
    const first = data.lowStockVariants[0];
    return {
      title: "Restock before sales are interrupted.",
      detail: `${data.lowStockVariantCount} active variant${data.lowStockVariantCount === 1 ? " is" : "s are"} at or below the reorder threshold.`,
      href: first ? `/app/catalog/${first.catalogItemId}` : "/app/catalog",
      label: first ? `Open ${first.name}` : "Review inventory",
    };
  }

  if (data.strongestSignal === "never_started") {
    const first = data.purchasedNeverStarted[0];
    return {
      title: "Help digital buyers start learning.",
      detail: `${data.digitalNeverStartedCount} digital purchase${data.digitalNeverStartedCount === 1 ? " has" : "s have"} not been started.`,
      href: first?.orderId
        ? `/app/orders/${first.orderId}`
        : first
          ? `/app/catalog/${first.catalogItemId}`
          : "/app/orders",
      label: first ? `Review ${first.name}` : "Review digital buyers",
    };
  }

  if (data.strongestSignal === "low_completion") {
    const first = data.lowCompletionContent[0];
    return {
      title: "Review content with weak engagement.",
      detail: `${data.digitalLowCompletionCount} digital purchase${data.digitalLowCompletionCount === 1 ? " has" : "s have"} started but remains below 35% completion.`,
      href: first ? `/app/catalog/${first.catalogItemId}` : "/app/catalog",
      label: first ? `Open ${first.name}` : "Review content",
    };
  }

  if (data.strongestSignal === "conversion") {
    return {
      title: "Reduce Marketplace checkout drop-off.",
      detail: `${data.completedMarketplaceOrderCount} of ${data.marketplaceCheckoutCount} Marketplace checkouts completed in this range.`,
      href: "/app/analytics",
      label: "Review conversion",
    };
  }

  return {
    title: "Commerce is ready for growth.",
    detail:
      "No urgent fulfillment, inventory, engagement, or conversion issue is standing out.",
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

  const attentionRecords = [
    ...data.unfulfilledOrders.slice(0, 2).map((order) => ({
      key: `order-${order.orderId}`,
      label: `Order ${order.orderNumber}`,
      detail: "Paid and waiting on fulfillment",
      href: `/app/orders/${order.orderId}`,
    })),
    ...data.lowStockVariants.slice(0, 2).map((variant) => ({
      key: `stock-${variant.inventoryId}`,
      label: variant.name,
      detail: `${variant.quantityOnHand} on hand · reorder at ${variant.reorderThreshold}`,
      href: `/app/catalog/${variant.catalogItemId}`,
    })),
    ...data.purchasedNeverStarted.slice(0, 2).map((item) => ({
      key: `never-${item.entitlementId}`,
      label: item.name,
      detail: "Purchased but never started",
      href: item.orderId
        ? `/app/orders/${item.orderId}`
        : `/app/catalog/${item.catalogItemId}`,
    })),
    ...data.lowCompletionContent.slice(0, 2).map((item) => ({
      key: `low-${item.entitlementId}`,
      label: item.name,
      detail: `${Math.round(item.percentComplete)}% complete`,
      href: `/app/catalog/${item.catalogItemId}`,
    })),
  ].slice(0, 6);

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
            Sales, Marketplace conversion, fulfillment, inventory, and student
            content engagement use the same range and link directly to the
            records that need attention.
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

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {[
          {
            label: "Net commerce revenue",
            value: money(data.netRevenue),
            helper: `${data.completedOrderCount} completed orders`,
            icon: TrendingUp,
          },
          {
            label: "Digital revenue",
            value: money(data.digitalRevenue),
            helper: `${money(data.physicalRevenue)} physical`,
            icon: CirclePlay,
          },
          {
            label: "Average order",
            value: money(data.averageOrderValue),
            helper: `${money(data.refunds)} refunded`,
            icon: ShoppingBag,
          },
          {
            label: "Marketplace conversion",
            value: percent(data.marketplaceConversionRate),
            helper: `${data.completedMarketplaceOrderCount} of ${data.marketplaceCheckoutCount} completed`,
            icon: TrendingUp,
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
                      {item.units} unit{item.units === 1 ? "" : "s"} ·{" "}
                      {item.itemType.replaceAll("_", " ")}
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
            {[
              ["Purchases", data.digitalEntitlementCount],
              ["Started", data.digitalStartedCount],
              ["Never started", data.digitalNeverStartedCount],
              ["Low completion", data.digitalLowCompletionCount],
              ["Completed", data.digitalCompletedCount],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex justify-between gap-3">
                <span className="text-slate-600">{label}</span>
                <span className="font-semibold text-slate-950">{value}</span>
              </div>
            ))}
          </div>
        </article>
      </div>

      <article className="mt-4 rounded-3xl border border-slate-200 bg-slate-50 p-5">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
          Records needing attention
        </p>
        {attentionRecords.length ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {attentionRecords.map((record) => (
              <Link
                key={record.key}
                href={record.href}
                className="rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-violet-300 hover:shadow-sm"
              >
                <p className="text-sm font-semibold text-slate-950">
                  {record.label}
                </p>
                <p className="mt-1 text-xs text-slate-500">{record.detail}</p>
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            No commerce records currently require urgent review.
          </p>
        )}
      </article>
    </section>
  );
}
