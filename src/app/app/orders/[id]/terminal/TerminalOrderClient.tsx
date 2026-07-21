"use client";

import { useEffect, useRef, useState } from "react";
import { CreditCard, Loader2, RefreshCcw, XCircle } from "lucide-react";

type Reader = {
  id: string;
  label: string | null;
  status: string | null;
};

type OrderData = {
  orderId: string;
  paymentId: string;
  amount: number;
  description: string;
};

async function postJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as any;

  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || "Request failed.");
  }

  return data;
}

export default function TerminalOrderClient({
  order,
  readers,
}: {
  order: OrderData;
  readers: Reader[];
}) {
  const onlineReader =
    readers.find((reader) => reader.status === "online") ?? readers[0] ?? null;
  const [readerId, setReaderId] = useState(onlineReader?.id ?? "");
  const [sessionId, setSessionId] = useState("");
  const [status, setStatus] = useState("ready");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollCount = useRef(0);

  async function start() {
    setBusy(true);
    setError(null);

    try {
      const result = await postJson(
        "/api/stripe/terminal/quick-charge/start",
        {
          readerId,
          existingPaymentId: order.paymentId,
          commerceOrderId: order.orderId,
        },
      );

      setSessionId(result.sessionId);
      setStatus(result.status ?? "processing");
      pollCount.current = 0;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The order could not be sent to the card reader.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!sessionId) return;

    try {
      const result = await postJson(
        "/api/stripe/terminal/quick-charge/refresh",
        {
          paymentId: order.paymentId,
          sessionId,
        },
      );

      setStatus(result.status ?? status);

      if (result.paid) {
        window.location.href = `/app/orders/${order.orderId}?success=order_completed`;
        return;
      }

      if (result.done) {
        setError(
          result.errorMessage ||
            "Payment did not complete. Try again or cancel the order.",
        );
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The payment status could not be refreshed.",
      );
    }
  }

  async function cancel() {
    if (!sessionId) {
      window.location.href = `/app/orders/${order.orderId}`;
      return;
    }

    setBusy(true);
    try {
      await postJson("/api/stripe/terminal/quick-charge/cancel", {
        paymentId: order.paymentId,
        sessionId,
      });
      window.location.href = `/app/orders/${order.orderId}?error=payment_cancelled`;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The reader payment could not be cancelled.",
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!sessionId || status === "succeeded") return;

    const interval = window.setInterval(() => {
      pollCount.current += 1;
      refresh();

      if (pollCount.current >= 90) {
        window.clearInterval(interval);
        setError(
          "The reader is still waiting or processing. Refresh manually or cancel if the customer is no longer paying.",
        );
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, [sessionId, status]);

  return (
    <div className="space-y-5">
      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-900">
          <XCircle className="mt-0.5 h-5 w-5" />
          <p className="text-sm">{error}</p>
        </div>
      ) : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            {sessionId ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <CreditCard className="h-5 w-5" />
            )}
          </div>
          <div>
            <h2 className="text-xl font-semibold text-slate-950">
              Collect the card payment
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {order.description} · ${order.amount.toFixed(2)}
            </p>
          </div>
        </div>

        <label className="mt-5 block space-y-2 text-sm font-medium text-slate-700">
          Card reader
          <select
            value={readerId}
            onChange={(event) => setReaderId(event.target.value)}
            disabled={Boolean(sessionId)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
          >
            {readers.map((reader) => (
              <option key={reader.id} value={reader.id}>
                {reader.label || "Stripe reader"} · {reader.status || "unknown"}
              </option>
            ))}
          </select>
        </label>

        <p className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
          Inventory remains reserved but is not reduced until Stripe confirms
          the payment succeeded.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          {!sessionId ? (
            <button
              type="button"
              onClick={start}
              disabled={busy || !readerId}
              className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Send to reader
            </button>
          ) : (
            <button
              type="button"
              onClick={refresh}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700"
            >
              <RefreshCcw className="h-4 w-4" />
              Refresh now
            </button>
          )}

          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-700"
          >
            Cancel
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-500">Status: {status}</p>
      </section>
    </div>
  );
}
