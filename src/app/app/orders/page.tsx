import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import SellWorkspaceHeader from "@/components/app/sell/SellWorkspaceHeader";
import SellWorkspaceEmptyState from "@/components/app/sell/SellWorkspaceEmptyState";
import CompactSummaryStrip from "@/components/app/workspace/CompactSummaryStrip";
import { canViewCommerceOrders } from "@/lib/auth/permissions";

type CommerceOrder = {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  fulfillment_status: string;
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
      "id, order_number, status, payment_status, fulfillment_status, customer_type, guest_name, subtotal, discount_total, tax_total, total, currency, created_at, clients(first_name, last_name)",
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
      <SellWorkspaceHeader
        role={context.studioRole}
        isPlatformAdmin={context.isPlatformAdmin}
        eyebrow="Transaction operations"
        title="Orders"
        description="Review commerce orders, receipts, fulfillment, returns, and refunds from one order ledger."
        actions={(
          <Link href="/app/sell" className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-95">
            Start a sale
          </Link>
        )}
      />

      <CompactSummaryStrip
        className="rounded-2xl border border-[var(--brand-border)] bg-white"
        items={[
          { key: "orders", label: "Orders", value: orders.length, detail: "Visible records" },
          { key: "paid", label: "Paid", value: paid.length, detail: "Payment complete", tone: "success" as const },
          { key: "refunds", label: "Refund activity", value: refunded.length, detail: "Partial or full refunds", tone: refunded.length ? "warning" as const : "default" as const },
          { key: "fulfilled", label: "Fulfilled", value: orders.filter((order) => ["fulfilled", "not_required"].includes(order.fulfillment_status)).length, detail: "Complete or not required" },
        ]}
      />

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        {orders.length === 0 ? (
          <div className="p-4 sm:p-6">
            <SellWorkspaceEmptyState
              title="No orders yet"
              description="Completed physical-product and digital-content sales will appear here with payment and fulfillment status."
              action={
                <Link
                  href="/app/sell"
                  className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white"
                >
                  Start a sale
                </Link>
              }
            />
          </div>
        ) : (
          <>
            <div className="space-y-3 p-4 md:hidden">
              {orders.map((order) => (
                <Link
                  key={order.id}
                  href={`/app/orders/${order.id}`}
                  className="block rounded-2xl border border-slate-200 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-950">
                        {order.order_number}
                      </p>
                      <p className="mt-1 truncate text-sm text-slate-600">
                        {customer(order)}
                      </p>
                    </div>
                    <p className="shrink-0 font-semibold text-slate-950">
                      {money(order.total, order.currency)}
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 capitalize text-slate-700">
                      {order.status.replaceAll("_", " ")}
                    </span>
                    <span className="rounded-full bg-violet-50 px-2.5 py-1 capitalize text-violet-700">
                      {order.payment_status.replaceAll("_", " ")}
                    </span>
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 capitalize text-emerald-700">
                      {order.fulfillment_status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    {new Date(order.created_at).toLocaleString()}
                  </p>
                </Link>
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
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
          </>
        )}
      </section>
    </div>
  );
}
