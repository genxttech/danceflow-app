import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  PackageCheck,
  Receipt,
  UserRound,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canViewCommerceOrders } from "@/lib/auth/permissions";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ error?: string; success?: string }>;

type OrderItem = {
  id: string;
  name_snapshot: string;
  sku_snapshot: string | null;
  quantity: number;
  unit_price: number | string;
  discount_total: number | string;
  tax_total: number | string;
  line_total: number | string;
  fulfillment_status: string;
  unit_cost_snapshot: number | string | null;
};

type OrderRow = {
  id: string;
  order_number: string;
  client_id: string | null;
  customer_type: string;
  guest_name: string | null;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  subtotal: number | string;
  discount_total: number | string;
  tax_total: number | string;
  refund_total: number | string;
  total: number | string;
  currency: string;
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  clients:
    | {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }
    | {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }[]
    | null;
  commerce_order_items: OrderItem[] | OrderItem | null;
  payments:
    | {
        payment_method: string | null;
        status: string | null;
        external_reference: string | null;
        paid_at: string | null;
      }
    | {
        payment_method: string | null;
        status: string | null;
        external_reference: string | null;
        paid_at: string | null;
      }[]
    | null;
};

function money(value: number | string | null, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(Number(value ?? 0));
}

function one<T>(value: T | T[] | null) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const messages = await searchParams;
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
      `
        id,
        order_number,
        client_id,
        customer_type,
        guest_name,
        status,
        payment_status,
        fulfillment_status,
        subtotal,
        discount_total,
        tax_total,
        refund_total,
        total,
        currency,
        notes,
        created_at,
        completed_at,
        clients(first_name, last_name, email),
        commerce_order_items(
          id,
          name_snapshot,
          sku_snapshot,
          quantity,
          unit_price,
          discount_total,
          tax_total,
          line_total,
          fulfillment_status,
          unit_cost_snapshot
        ),
        payments(payment_method, status, external_reference, paid_at)
      `,
    )
    .eq("id", id)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (error) {
    throw new Error(`Order failed to load: ${error.message}`);
  }

  if (!data) notFound();

  const order = data as OrderRow;
  const client = one(order.clients);
  const payment = one(order.payments);
  const items = Array.isArray(order.commerce_order_items)
    ? order.commerce_order_items
    : order.commerce_order_items
      ? [order.commerce_order_items]
      : [];
  const customerName =
    order.guest_name ||
    (client
      ? `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim()
      : "") ||
    "Walk-in / Guest";

  return (
    <div className="space-y-6 p-1">
      <section className="rounded-[32px] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white shadow-sm md:p-8">
        <Link
          href="/app/orders"
          className="inline-flex items-center gap-2 text-sm font-semibold text-white/80"
        >
          <ArrowLeft className="h-4 w-4" />
          Orders
        </Link>

        <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
              Commerce order
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              {order.order_number}
            </h1>
            <p className="mt-3 text-sm text-white/80">
              {new Date(order.created_at).toLocaleString()}
            </p>
          </div>

          <div className="rounded-2xl border border-white/15 bg-white/10 p-4">
            <p className="text-sm text-white/70">Order total</p>
            <p className="mt-1 text-3xl font-semibold">
              {money(order.total, order.currency)}
            </p>
          </div>
        </div>
      </section>

      {messages.success ? (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-5 w-5" />
          <p className="text-sm">Order completed and inventory updated.</p>
        </div>
      ) : null}

      {messages.error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {decodeURIComponent(messages.error)}
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <UserRound className="h-5 w-5 text-[var(--brand-primary)]" />
          <p className="mt-4 text-sm text-slate-500">Customer</p>
          <p className="mt-1 font-semibold text-slate-950">{customerName}</p>
          <p className="mt-1 text-xs text-slate-500">
            {client?.email || order.customer_type.replaceAll("_", " ")}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <Receipt className="h-5 w-5 text-[var(--brand-primary)]" />
          <p className="mt-4 text-sm text-slate-500">Payment</p>
          <p className="mt-1 font-semibold capitalize text-slate-950">
            {order.payment_status.replaceAll("_", " ")}
          </p>
          <p className="mt-1 text-xs capitalize text-slate-500">
            {(payment?.payment_method || "Not collected").replaceAll("_", " ")}
            {payment?.external_reference
              ? ` · ${payment.external_reference}`
              : ""}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <PackageCheck className="h-5 w-5 text-[var(--brand-primary)]" />
          <p className="mt-4 text-sm text-slate-500">Fulfillment</p>
          <p className="mt-1 font-semibold capitalize text-slate-950">
            {order.fulfillment_status.replaceAll("_", " ")}
          </p>
          <p className="mt-1 text-xs capitalize text-slate-500">
            {order.status.replaceAll("_", " ")}
          </p>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">Receipt</h2>

        <div className="mt-5 space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-start justify-between gap-4 rounded-2xl bg-slate-50 p-4"
            >
              <div>
                <p className="font-semibold text-slate-950">
                  {item.quantity} × {item.name_snapshot}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {item.sku_snapshot || "No SKU"} ·{" "}
                  {money(item.unit_price, order.currency)} each
                </p>
              </div>
              <p className="font-semibold text-slate-950">
                {money(item.line_total, order.currency)}
              </p>
            </div>
          ))}
        </div>

        <div className="ml-auto mt-6 max-w-sm space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-slate-500">Subtotal</span>
            <span className="font-semibold text-slate-950">
              {money(order.subtotal, order.currency)}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-slate-500">Discount</span>
            <span className="font-semibold text-slate-950">
              -{money(order.discount_total, order.currency)}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-slate-500">Tax</span>
            <span className="font-semibold text-slate-950">
              {money(order.tax_total, order.currency)}
            </span>
          </div>
          <div className="flex justify-between gap-4 border-t border-slate-200 pt-3 text-base">
            <span className="font-semibold text-slate-950">Total</span>
            <span className="font-semibold text-slate-950">
              {money(order.total, order.currency)}
            </span>
          </div>
        </div>

        {order.notes ? (
          <p className="mt-6 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
            {order.notes}
          </p>
        ) : null}
      </section>
    </div>
  );
}
