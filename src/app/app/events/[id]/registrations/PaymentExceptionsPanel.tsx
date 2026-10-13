import { createClient } from "@/lib/supabase/server";
import { paymentExceptionLabel } from "@/lib/notifications/templates";
import { acknowledgePaymentExceptionAction, resolvePaymentExceptionAction } from "./paymentExceptionActions";

/**
 * PAY-WH-1A -- payment exceptions for one event (captured money without fulfilment, reversed payments, failing
 * follow-ups, delayed payments that need attention). Rows are visible only to event managers and platform admins (RLS);
 * acknowledging/resolving never moves money, issues tickets or reopens an order.
 */

type ExceptionRow = {
  id: string;
  kind: string;
  money_state: string;
  status: string;
  amount_cents: number | null;
  currency: string | null;
  stripe_payment_intent_id: string | null;
  order_id: string | null;
  registration_id: string | null;
  occurrences: number;
  created_at: string;
  acknowledged_at: string | null;
  acknowledgement_note: string | null;
  alert_status: string;
};

const MONEY_STATE_LABEL: Record<string, { label: string; className: string }> = {
  captured: { label: "Buyer was charged", className: "border-rose-200 bg-rose-50 text-rose-700" },
  reversed: { label: "Payment reversed", className: "border-rose-200 bg-rose-50 text-rose-700" },
  in_flight: { label: "Payment still processing (not charged yet)", className: "border-amber-200 bg-amber-50 text-amber-700" },
  operational: { label: "Paid order needs follow-up", className: "border-amber-200 bg-amber-50 text-amber-700" },
  informational: { label: "For your information", className: "border-slate-200 bg-slate-50 text-slate-700" },
};

function formatMoney(cents: number | null, currency: string | null) {
  if (typeof cents !== "number") return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${(currency || "usd").toUpperCase()}`;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export default async function PaymentExceptionsPanel({ eventId }: { eventId: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("event_order_settlement_exceptions")
    .select(
      "id, kind, money_state, status, amount_cents, currency, stripe_payment_intent_id, order_id, registration_id, occurrences, created_at, acknowledged_at, acknowledgement_note, alert_status",
    )
    .eq("event_id", eventId)
    .in("status", ["open", "acknowledged"])
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return (
      <section id="payment-exceptions" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        Payment exceptions could not be loaded. Refresh the page; if this continues, contact support.
      </section>
    );
  }
  const rows = (data ?? []) as ExceptionRow[];
  if (!rows.length) return null;

  return (
    <section id="payment-exceptions" aria-labelledby="payment-exceptions-heading" className="rounded-[28px] border border-rose-200 bg-white p-6 shadow-sm">
      <h2 id="payment-exceptions-heading" className="text-lg font-semibold text-rose-900">
        Payments needing review ({rows.length})
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-700">
        DanceFlow never refunds, issues tickets or reopens an order automatically for these. Decide in Stripe or here what
        should happen, then resolve the item with a note.
      </p>
      <ul className="mt-4 space-y-4">
        {rows.map((row) => {
          const state = MONEY_STATE_LABEL[row.money_state] ?? MONEY_STATE_LABEL.informational;
          const amount = formatMoney(row.amount_cents, row.currency);
          return (
            <li key={row.id} className="rounded-2xl border border-slate-200 p-4" data-testid="payment-exception">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${state.className}`}>{state.label}</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs text-slate-700">
                  {row.status === "acknowledged" ? "Acknowledged" : "Open"}
                </span>
                <span className="text-xs text-slate-500">{formatDate(row.created_at)}</span>
              </div>
              <p className="mt-2 font-medium text-slate-900">{paymentExceptionLabel(row.kind)}</p>
              <dl className="mt-1 grid gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-2">
                {amount ? (<div><dt className="inline text-slate-500">Amount: </dt><dd className="inline">{amount}</dd></div>) : null}
                {row.stripe_payment_intent_id ? (
                  <div className="break-all"><dt className="inline text-slate-500">Stripe payment: </dt><dd className="inline">{row.stripe_payment_intent_id}</dd></div>
                ) : null}
                {row.order_id ? (<div className="break-all"><dt className="inline text-slate-500">Order: </dt><dd className="inline">{row.order_id}</dd></div>) : null}
                {row.occurrences > 1 ? (<div><dt className="inline text-slate-500">Seen: </dt><dd className="inline">{row.occurrences} times</dd></div>) : null}
                {row.acknowledgement_note ? (<div className="sm:col-span-2"><dt className="inline text-slate-500">Note: </dt><dd className="inline">{row.acknowledgement_note}</dd></div>) : null}
              </dl>
              <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-end">
                {row.status === "open" ? (
                  <form action={acknowledgePaymentExceptionAction} className="flex flex-col gap-2 md:flex-row md:items-end">
                    <input type="hidden" name="eventId" value={eventId} />
                    <input type="hidden" name="exceptionId" value={row.id} />
                    <label className="text-sm text-slate-700">
                      <span className="mb-1 block">Acknowledge (optional note)</span>
                      <input name="note" maxLength={2000} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm md:w-64" />
                    </label>
                    <button type="submit" className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
                      Acknowledge
                    </button>
                  </form>
                ) : null}
                <form action={resolvePaymentExceptionAction} className="flex flex-col gap-2 md:flex-row md:items-end">
                  <input type="hidden" name="eventId" value={eventId} />
                  <input type="hidden" name="exceptionId" value={row.id} />
                  <label className="text-sm text-slate-700">
                    <span className="mb-1 block">Resolution note (required)</span>
                    <input name="note" required maxLength={2000} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm md:w-72" />
                  </label>
                  <button type="submit" className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90">
                    Mark resolved
                  </button>
                </form>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
