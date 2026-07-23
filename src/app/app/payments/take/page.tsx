import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, PackagePlus, Receipt, Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canViewPayments } from "@/lib/auth/permissions";
import TakePaymentForm from "./TakePaymentForm";

export default async function TakePaymentPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewPayments(context.studioRole ?? "")) {
    redirect("/app");
  }

  const [
    { data: clients, error },
    { data: arrangements, error: arrangementsError },
    { data: memberships, error: membershipsError },
  ] = await Promise.all([
    supabase
    .from("clients")
    .select("id, first_name, last_name, email, status")
    .eq("studio_id", context.studioId)
    .neq("status", "inactive")
    .order("last_name", { ascending: true })
    .order("first_name", { ascending: true }),
    supabase
      .from("payment_arrangements")
      .select(`
        id,
        client_id,
        remaining_balance,
        first_due_date,
        client_packages (name_snapshot)
      `)
      .eq("studio_id", context.studioId)
      .eq("status", "active")
      .order("first_due_date", { ascending: true }),
    supabase
      .from("client_memberships")
      .select("id, client_id, name_snapshot, price_snapshot, current_period_start, current_period_end, status, auto_renew, cancel_at_period_end")
      .eq("studio_id", context.studioId)
      .in("status", ["active", "past_due", "unpaid"])
      .order("current_period_start", { ascending: false }),
  ]);

  if (error) {
    throw new Error(`Failed to load clients: ${error.message}`);
  }

  if (arrangementsError) {
    throw new Error(`Failed to load payment arrangements: ${arrangementsError.message}`);
  }

  if (membershipsError) {
    throw new Error(`Failed to load client memberships: ${membershipsError.message}`);
  }

  return (
    <div className="space-y-6 p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Revenue
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Take Payment
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Choose the client, describe what they are paying for, and collect or request payment from one front-desk workflow.
              </p>
            </div>

            <Link
              href="/app/payments"
              className="inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
            >
              <ArrowLeft className="h-4 w-4" />
              Payment Ledger
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        <Link
          href="/app/sales/new"
          className="rounded-2xl border border-cyan-200 bg-cyan-50 p-4 transition hover:border-cyan-300"
        >
          <PackagePlus className="h-5 w-5 text-cyan-700" />
          <p className="mt-3 font-semibold text-cyan-950">Sell a package or membership</p>
          <p className="mt-1 text-sm leading-6 text-cyan-800">
            Use the full sale workflow, including split package payments.
          </p>
        </Link>

        <Link
          href="/app/payments/quick-charge"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 transition hover:border-amber-300"
        >
          <Zap className="h-5 w-5 text-amber-700" />
          <p className="mt-3 font-semibold text-amber-950">Quick Charge</p>
          <p className="mt-1 text-sm leading-6 text-amber-800">
            Collect a fast walk-in or ad-hoc payment.
          </p>
        </Link>

        <Link
          href="/app/payments"
          className="rounded-2xl border border-violet-200 bg-violet-50 p-4 transition hover:border-violet-300"
        >
          <Receipt className="h-5 w-5 text-violet-700" />
          <p className="mt-3 font-semibold text-violet-950">Review the ledger</p>
          <p className="mt-1 text-sm leading-6 text-violet-800">
            Search completed, pending, failed, and refunded payments.
          </p>
        </Link>
      </section>

      <TakePaymentForm
        clients={(clients ?? []).map((client) => ({
          id: client.id,
          first_name: client.first_name,
          last_name: client.last_name,
          email: client.email,
        }))}
        memberships={(memberships ?? []).map((membership) => ({
          id: membership.id,
          client_id: membership.client_id,
          name: membership.name_snapshot,
          price: Number(membership.price_snapshot ?? 0),
          current_period_start: membership.current_period_start,
          current_period_end: membership.current_period_end,
          status: membership.status,
          auto_renew: membership.auto_renew,
          cancel_at_period_end: membership.cancel_at_period_end,
        }))}
        arrangements={(arrangements ?? []).map((arrangement) => {
          const pkg = Array.isArray(arrangement.client_packages)
            ? arrangement.client_packages[0]
            : arrangement.client_packages;
          return {
            id: arrangement.id,
            client_id: arrangement.client_id,
            remaining_balance: Number(arrangement.remaining_balance ?? 0),
            first_due_date: arrangement.first_due_date,
            package_name: pkg?.name_snapshot ?? "Package",
          };
        })}
      />
    </div>
  );
}
