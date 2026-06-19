import Link from "next/link";
import { redirect } from "next/navigation";
import { Zap } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { canViewPayments } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import QuickChargeClient from "./QuickChargeClient";

type ReaderRow = {
  id: string;
  label: string | null;
  status: string | null;
  device_type: string | null;
  active: boolean | null;
};

function canCollectTerminal(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return ["studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export default async function QuickChargePage() {
  const supabase = createAdminClient();
  const context = await getCurrentStudioContext();

  if (!canViewPayments(context.studioRole ?? "")) {
    redirect("/app");
  }

  if (!canCollectTerminal(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app/payments?error=terminal_access_denied");
  }

  const { data: readers, error: readersError } = await supabase
    .from("stripe_terminal_readers")
    .select("id, label, status, device_type, active")
    .eq("studio_id", context.studioId)
    .eq("active", true)
    .order("updated_at", { ascending: false });

  if (readersError) {
    throw new Error(`Failed to load Stripe readers: ${readersError.message}`);
  }

  const activeReaders = (readers ?? []) as ReaderRow[];

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Payments
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
                  Quick Charge
                </h1>
                <span className="rounded-full border border-white/30 bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-white">
                  Beta · Reader required
                </span>
              </div>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Use this for fast in-studio payments like group class drop-ins,
                social party entrances, practice parties, floor fees, and other
                ad hoc front desk charges. This flow starts in DanceFlow and sends
                the sale to a registered physical Stripe Terminal reader.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/payments"
                className="rounded-xl border border-white/30 px-4 py-2 text-sm font-medium text-white hover:bg-white/10"
              >
                Payment History
              </Link>
              <Link
                href="/app/settings/billing"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-slate-950 hover:bg-white/90"
              >
                Card Readers
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-green-200 bg-green-50 p-5">
              <h2 className="text-lg font-semibold text-green-950">One-screen collection</h2>
              <p className="mt-2 text-sm leading-7 text-green-900">
                Pick a preset and DanceFlow sends the payment directly to the selected reader.
              </p>
            </div>
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
              <h2 className="text-lg font-semibold text-indigo-950">No required client</h2>
              <p className="mt-2 text-sm leading-7 text-indigo-900">
                Walk-in and guest payments can be recorded without slowing down the door.
              </p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">Physical reader required</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Use a supported Stripe Terminal smart reader such as Stripe Reader S700/S710 or BBPOS WisePOS E.
              </p>
            </div>
          </div>
        </div>
      </section>

      {activeReaders.length === 0 ? (
        <section className="rounded-[28px] border border-amber-200 bg-amber-50 p-6 text-amber-950 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-white p-3 text-amber-700">
              <Zap className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">No active reader is registered yet</h2>
              <p className="mt-2 text-sm leading-7">
                DanceFlow Quick Charge cannot use the Stripe Dashboard mobile app as the reader. Register a supported
                physical Stripe Terminal smart reader before using this one-screen card collection flow.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href="/app/settings/billing"
                  className="inline-flex rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Open Card Reader Settings
                </Link>
                <Link
                  href="/app/help?query=in-person%20payments"
                  className="inline-flex rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
                >
                  Read payment options
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <QuickChargeClient
          readers={activeReaders.map((reader) => ({
            id: reader.id,
            label: reader.label,
            status: reader.status,
            device_type: reader.device_type,
          }))}
        />
      )}
    </div>
  );
}
