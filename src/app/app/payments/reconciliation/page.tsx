import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import ConflictRowActions from "./ConflictRowActions";

/**
 * PKG-P1: staff-visible "Needs Review" queue for payment_settlement_
 * conflicts -- a Stripe event reporting real settlement (success or
 * refund) against a payment DanceFlow's own record shows as already
 * closed (voided/failed/refunded-differently). Money may have moved with
 * no valid entitlement to attach it to; this page never auto-resolves,
 * auto-refunds, or auto-reactivates anything -- it only surfaces the
 * conflict and lets staff record a resolution once they've handled the
 * real-world mismatch (in Stripe/accounting) themselves.
 *
 * Deliberately its own small page rather than woven into the existing,
 * already-dense /app/payments workspace -- progressive disclosure, not
 * another dense admin dashboard. That page links here; this page never
 * duplicates its own general payment listing.
 */

type ConflictRow = {
  id: string;
  studio_id: string;
  payment_id: string;
  client_package_id: string | null;
  stripe_event_id: string;
  stripe_event_type: string;
  stripe_session_id: string | null;
  note: string | null;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  payments: { amount: number; payment_channel: string | null; client_id: string | null } | { amount: number; payment_channel: string | null; client_id: string | null }[] | null;
  client_packages: { name_snapshot: string | null } | { name_snapshot: string | null }[] | null;
};

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value ?? 0));
}

function formatDate(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function PaymentReconciliationPage() {
  const context = await getCurrentStudioContext();
  const { studioId, studioRole } = context;

  if (!["platform_admin", "studio_owner", "studio_admin"].includes(studioRole ?? "")) {
    redirect("/app/payments");
  }

  const supabase = await createClient();

  const { data: conflicts, error } = await supabase
    .from("payment_settlement_conflicts")
    .select(
      `
      id, studio_id, payment_id, client_package_id, stripe_event_id, stripe_event_type,
      stripe_session_id, note, status, resolved_by, resolved_at, resolution_note, created_at,
      payments ( amount, payment_channel, client_id ),
      client_packages ( name_snapshot )
    `,
    )
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    throw new Error(`Failed to load payment reconciliation conflicts: ${error.message}`);
  }

  const typedConflicts = (conflicts ?? []) as unknown as ConflictRow[];

  const clientIds = Array.from(
    new Set(
      typedConflicts
        .map((row) => firstJoin(row.payments)?.client_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const clientNameById = new Map<string, string>();
  if (clientIds.length > 0) {
    const { data: clientRows } = await supabase
      .from("clients")
      .select("id, first_name, last_name")
      .in("id", clientIds);
    for (const c of clientRows ?? []) {
      clientNameById.set(c.id as string, `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim());
    }
  }

  const pending = typedConflicts.filter((row) => row.status === "pending_review");
  const resolved = typedConflicts.filter((row) => row.status === "resolved");

  return (
    <div className="space-y-8 p-1">
      <section className="rounded-[32px] border border-[var(--brand-border)] bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
          <Link href="/app/payments" className="underline">
            Payments
          </Link>{" "}
          / Needs Review
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">
          Payment Reconciliation
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
          Stripe reported a payment succeeded (or was refunded) after DanceFlow had already closed
          the book on it. <strong>Money may have been captured with no valid entitlement attached</strong> --
          the linked package (if any) remains inactive until you resolve this. DanceFlow never
          auto-refunds or auto-reactivates anything here; verify in Stripe/accounting first, then
          record what you found.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">
          Needs review ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] p-5 text-sm text-slate-600">
            Nothing needs review right now.
          </div>
        ) : (
          <div className="space-y-4">
            {pending.map((row) => {
              const payment = firstJoin(row.payments);
              const pkg = firstJoin(row.client_packages);
              const clientName = payment?.client_id ? clientNameById.get(payment.client_id) : null;

              return (
                <div
                  key={row.id}
                  className="rounded-2xl border border-amber-200 bg-amber-50 p-4 md:p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">
                        {clientName || "Unknown client"}
                        {pkg?.name_snapshot ? ` — ${pkg.name_snapshot}` : ""}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {payment ? formatMoney(payment.amount) : ""}
                        {payment?.payment_channel ? ` · ${payment.payment_channel}` : ""}
                        {" · "}
                        {row.stripe_event_type} at {formatDate(row.created_at)}
                      </p>
                      {row.stripe_session_id ? (
                        <p className="mt-1 text-xs text-slate-500">
                          Stripe session: {row.stripe_session_id}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {row.note ? (
                    <p className="mt-3 whitespace-pre-line rounded-xl bg-white/70 p-3 text-sm text-slate-700">
                      {row.note}
                    </p>
                  ) : null}

                  <ConflictRowActions conflictId={row.id} />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {resolved.length > 0 ? (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Resolved</h2>
          <div className="space-y-3">
            {resolved.map((row) => {
              const payment = firstJoin(row.payments);
              const pkg = firstJoin(row.client_packages);
              const clientName = payment?.client_id ? clientNameById.get(payment.client_id) : null;
              return (
                <div key={row.id} className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
                  <p className="font-medium text-slate-900">
                    {clientName || "Unknown client"}
                    {pkg?.name_snapshot ? ` — ${pkg.name_snapshot}` : ""}
                  </p>
                  <p className="mt-1 text-slate-600">
                    Resolved {row.resolved_at ? formatDate(row.resolved_at) : ""}
                  </p>
                  {row.resolution_note ? (
                    <p className="mt-1 whitespace-pre-line text-slate-700">{row.resolution_note}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
