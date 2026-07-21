import { redirect } from "next/navigation";
import Link from "next/link";
import { PackageCheck, Receipt, RotateCcw, ShoppingCart } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canViewCommerceOrders } from "@/lib/auth/permissions";

type CommerceOrder = {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  customer_type: string;
  guest_name: string | null;
  subtotal: number | string;
  discount_total: number | string;
  tax_total: number | string;
  total: number | string;
  currency: string;
  created_at: string;
  clients:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
};

function money(value: number | string, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
}

function customer(order: CommerceOrder) {
  if (order.guest_name) return order.guest_name;
  const client = Array.isArray(order.clients) ? order.clients[0] : order.clients;
  return client
    ? `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || "Client"
    : "Walk-in / Guest";
}

export default async function OrdersPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (
    !context.isPlatformAdmin &&
    !canViewCommerceOrders(context.studioRole)
  ) {
    redirect("/app");
  }

  const { data, error } = await supabase
    .from("commerce_orders")
    .select(
      "id, order_number, status, payment_status, customer_type, guest_name, subtotal, discount_total, tax_total, total, currency, created_at, clients(first_name, last_name)",
    )
    .eq("studio_id", context.studioId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    throw new Error(`Orders failed to load: ${error.message}`);
  }

  const orders = (data ?? []) as CommerceOrder[];
  const paid = orders.filter((order) => order.payment_status === "paid");
  const refunded = orders.filter((order) =>
    ["partially_refunded", "refunded"].includes(order.payment_status),
  );

  return (
    <div className="space-y-6 p-1">
      <section className="rounded-[32px] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white shadow-sm md:p-8">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
              Commerce
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              Orders
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/80">
              One order ledger for physical products, digital content, services,
              receipts, fulfillment, returns, and refunds.
            </p>
          </div>
          <Link
            href="/app/sell"
            className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-primary)]"
          >
            Start a sale
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            title: "Orders",
            value: orders.length,
            icon: ShoppingCart,
          },
          {
            title: "Paid",
            value: paid.length,
            icon: Receipt,
          },
          {
            title: "Refund activity",
            value: refunded.length,
            icon: RotateCcw,
          },
          {
            title: "Fulfilled",
            value: orders.filter((order) => order.status === "fulfilled").length,
            icon: PackageCheck,
          },
        ].map((stat) => {
          const Icon = stat.icon;

          return (
            <div
              key={stat.title}
              className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <Icon className="h-5 w-5 text-[var(--brand-primary)]" />
              <p className="mt-4 text-sm text-slate-500">{stat.title}</p>
              <p className="mt-1 text-3xl font-semibold text-slate-950">
                {stat.value}
              </p>
            </div>
          );
        })}
      </section>

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        {orders.length === 0 ? (
          <div className="p-10 text-center">
            <h2 className="text-xl font-semibold text-slate-950">No commerce orders yet</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
              Existing package, membership, payment, and event histories remain
              in their current ledgers. New catalog checkout will begin writing
              to this shared order foundation in the next commerce slices.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Order</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Payment</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-t border-slate-100">
                    <td className="px-4 py-4 font-semibold text-slate-950">
                      <Link
                        href={`/app/orders/${order.id}`}
                        className="hover:text-[var(--brand-primary)]"
                      >
                        {order.order_number}
                      </Link>
                    </td>
                    <td className="px-4 py-4 text-slate-700">{customer(order)}</td>
                    <td className="px-4 py-4 capitalize text-slate-700">{order.status.replaceAll("_", " ")}</td>
                    <td className="px-4 py-4 capitalize text-slate-700">{order.payment_status.replaceAll("_", " ")}</td>
                    <td className="px-4 py-4 text-right font-semibold text-slate-950">{money(order.total, order.currency)}</td>
                    <td className="px-4 py-4 text-slate-600">{new Date(order.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
