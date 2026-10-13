import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createAdminClient } from "@/lib/supabase/admin";
import { paymentExceptionLabel } from "@/lib/notifications/templates";

export const dynamic = "force-dynamic";

/**
 * PAY-WH-1A -- platform oversight of payment exceptions across all studios and organizers, plus settlement follow-ups
 * that stopped retrying. Read-only: studios handle (acknowledge/resolve) their own exceptions from Event registrations.
 */

type ExceptionRow = {
  id: string;
  kind: string;
  money_state: string;
  status: string;
  studio_id: string | null;
  event_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  stripe_payment_intent_id: string | null;
  alert_status: string;
  alert_last_error: string | null;
  occurrences: number;
  created_at: string;
};

function formatMoney(cents: number | null, currency: string | null) {
  if (typeof cents !== "number") return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${(currency || "usd").toUpperCase()}`;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export default async function PlatformPaymentExceptionsPage() {
  await requirePlatformAdmin();
  // Platform admins are verified above; the settlement tables are server-only, so they are read with the service role.
  const admin = createAdminClient();

  const [exceptionsResult, deadResult] = await Promise.all([
    admin
      .from("event_order_settlement_exceptions")
      .select("id, kind, money_state, status, studio_id, event_id, amount_cents, currency, stripe_payment_intent_id, alert_status, alert_last_error, occurrences, created_at")
      .in("status", ["open", "acknowledged"])
      .order("created_at", { ascending: false })
      .limit(200),
    admin.from("event_settlement_outbox").select("id", { count: "exact", head: true }).eq("status", "dead"),
  ]);

  const rows = (exceptionsResult.data ?? []) as ExceptionRow[];
  const studioIds = [...new Set(rows.map((row) => row.studio_id).filter((id): id is string => Boolean(id)))];
  const eventIds = [...new Set(rows.map((row) => row.event_id).filter((id): id is string => Boolean(id)))];
  const [{ data: studios }, { data: events }] = await Promise.all([
    studioIds.length ? admin.from("studios").select("id, name").in("id", studioIds) : Promise.resolve({ data: [] }),
    eventIds.length ? admin.from("events").select("id, name").in("id", eventIds) : Promise.resolve({ data: [] }),
  ]);
  const studioName = new Map((studios ?? []).map((studio: { id: string; name: string | null }) => [studio.id, studio.name]));
  const eventName = new Map((events ?? []).map((event: { id: string; name: string | null }) => [event.id, event.name]));

  const captured = rows.filter((row) => row.money_state === "captured" || row.money_state === "reversed");
  const alertFailures = rows.filter((row) => row.alert_status === "failed");

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-violet-700">Platform Operations</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Payment Exceptions</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Payments that were captured without a ticket, reversed after settlement, or whose follow-ups stopped retrying.
          Nothing here is refunded or fulfilled automatically; studios resolve their own items from Event registrations.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">Money captured / reversed</p>
            <p className="mt-2 text-3xl font-semibold text-rose-900">{captured.length}</p>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Alerts not delivered</p>
            <p className="mt-2 text-3xl font-semibold text-amber-900">{alertFailures.length}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Dead settlement follow-ups</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{deadResult.count ?? 0}</p>
          </div>
        </div>
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
        {exceptionsResult.error ? (
          <p className="text-sm text-rose-700">Payment exceptions could not be loaded.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-600">No open payment exceptions.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">What happened</th>
                  <th className="py-2 pr-4">Studio / event</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Alert</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} data-testid="platform-payment-exception">
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-600">{formatDate(row.created_at)}</td>
                    <td className="py-2 pr-4">
                      <p className="font-medium text-slate-900">{paymentExceptionLabel(row.kind)}</p>
                      {row.stripe_payment_intent_id ? <p className="break-all text-xs text-slate-500">{row.stripe_payment_intent_id}</p> : null}
                    </td>
                    <td className="py-2 pr-4 text-slate-700">
                      {row.studio_id ? studioName.get(row.studio_id) ?? row.studio_id : "Unattributed"}
                      {row.event_id ? (
                        <p className="text-xs text-slate-500">
                          <Link href={`/app/events/${row.event_id}/registrations#payment-exceptions`} className="underline">
                            {eventName.get(row.event_id) ?? row.event_id}
                          </Link>
                        </p>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatMoney(row.amount_cents, row.currency)}</td>
                    <td className="py-2 pr-4 capitalize">{row.status}{row.occurrences > 1 ? ` (×${row.occurrences})` : ""}</td>
                    <td className="py-2 pr-4">
                      {row.alert_status.replaceAll("_", " ")}
                      {row.alert_last_error ? <p className="text-xs text-rose-600">{row.alert_last_error}</p> : null}
                    </td>
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
