import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canSellCommerce } from "@/lib/auth/permissions";
import TerminalOrderClient from "./TerminalOrderClient";

type Params = Promise<{ id: string }>;

type OrderRow = {
  id: string;
  payment_id: string | null;
  total: number | string;
  status: string;
  payment_status: string;
  commerce_order_items:
    | { name_snapshot: string; quantity: number }[]
    | { name_snapshot: string; quantity: number }
    | null;
};

export default async function TerminalOrderPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (
    !context.isPlatformAdmin &&
    !canSellCommerce(context.studioRole)
  ) {
    redirect("/app");
  }

  const [
    { data: order, error: orderError },
    { data: readers, error: readersError },
  ] = await Promise.all([
    supabase
      .from("commerce_orders")
      .select(
        "id, payment_id, total, status, payment_status, commerce_order_items(name_snapshot, quantity)",
      )
      .eq("id", id)
      .eq("studio_id", context.studioId)
      .maybeSingle(),
    supabase
      .from("stripe_terminal_readers")
      .select("id, label, status")
      .eq("studio_id", context.studioId)
      .eq("active", true)
      .order("updated_at", { ascending: false }),
  ]);

  if (orderError) {
    throw new Error(`Order failed to load: ${orderError.message}`);
  }

  if (readersError) {
    throw new Error(`Readers failed to load: ${readersError.message}`);
  }

  if (!order) notFound();

  const typedOrder = order as OrderRow;

  if (
    !typedOrder.payment_id ||
    typedOrder.status !== "open" ||
    typedOrder.payment_status !== "pending"
  ) {
    redirect(`/app/orders/${typedOrder.id}`);
  }

  const items = Array.isArray(typedOrder.commerce_order_items)
    ? typedOrder.commerce_order_items
    : typedOrder.commerce_order_items
      ? [typedOrder.commerce_order_items]
      : [];

  return (
    <div className="space-y-6 p-1">
      <section className="rounded-[32px] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
          Commerce checkout
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
          Card reader payment
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-white/80">
          Complete the prepared order on a registered Stripe Terminal reader.
        </p>
      </section>

      <TerminalOrderClient
        order={{
          orderId: typedOrder.id,
          paymentId: typedOrder.payment_id,
          amount: Number(typedOrder.total ?? 0),
          description:
            items.map((item) => `${item.quantity} × ${item.name_snapshot}`).join(", ") ||
            "Retail order",
        }}
        readers={(readers ?? []).map((reader) => ({
          id: reader.id,
          label: reader.label,
          status: reader.status,
        }))}
      />
    </div>
  );
}
