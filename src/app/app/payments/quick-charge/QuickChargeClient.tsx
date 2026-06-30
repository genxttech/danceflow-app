"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, Receipt, XCircle } from "lucide-react";

type ReaderOption = {
  id: string;
  label: string | null;
  status: string | null;
  device_type: string | null;
};

type Preset = {
  category: string;
  label: string;
  amount: number;
  helper: string;
};

type ActiveSession = {
  paymentId: string;
  sessionId: string;
  status: string;
  amount: number;
  categoryLabel: string;
  readerLabel: string;
};

const PRESETS: Preset[] = [
  { category: "group_class", label: "Group Class", amount: 20, helper: "Drop-in class entrance" },
  { category: "social_party", label: "Social Party", amount: 15, helper: "Party or dance entry" },
  { category: "practice_party", label: "Practice Party", amount: 10, helper: "Practice/social floor entry" },
  { category: "floor_fee", label: "Floor Fee", amount: 15, helper: "Ad hoc floor use" },
];

const CATEGORY_OPTIONS = [
  { value: "group_class", label: "Group Class" },
  { value: "social_party", label: "Social Party" },
  { value: "practice_party", label: "Practice Party" },
  { value: "floor_fee", label: "Floor Fee" },
  { value: "private_lesson_ad_hoc", label: "Private Lesson" },
  { value: "merchandise", label: "Merchandise" },
  { value: "other", label: "Other" },
];

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function readerLabel(reader: ReaderOption) {
  const status = reader.status ? ` · ${reader.status}` : "";
  return `${reader.label || "Stripe reader"}${status}`;
}

function isReaderOnline(reader: ReaderOption | null | undefined) {
  return (reader?.status ?? "").toLowerCase() === "online";
}

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

export default function QuickChargeClient({ readers }: { readers: ReaderOption[] }) {
  const defaultReader = useMemo(
    () => readers.find((reader) => reader.status === "online") ?? readers[0] ?? null,
    [readers]
  );

  const [readerId, setReaderId] = useState(defaultReader?.id ?? "");
  const [customCategory, setCustomCategory] = useState("other");
  const [customAmount, setCustomAmount] = useState("");
  const [guestName, setGuestName] = useState("");
  const [notes, setNotes] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [lastSuccess, setLastSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollCount = useRef(0);
  const selectedReader = useMemo(
    () => readers.find((reader) => reader.id === readerId) ?? null,
    [readers, readerId]
  );
  const selectedReaderOnline = isReaderOnline(selectedReader);

  useEffect(() => {
    if (!defaultReader?.id) return;
    setReaderId((current) => current || defaultReader.id);
  }, [defaultReader?.id]);

  async function startCharge(params: { category: string; label: string; amount: number }) {
    if (!readerId) {
      setError("Select or register a Stripe reader before collecting a payment.");
      return;
    }

    if (!selectedReaderOnline) {
      setError("The selected reader is not online. Wake the reader, confirm it is connected to Wi-Fi, then refresh reader status in Billing & Payouts.");
      return;
    }

    setError(null);
    setLastSuccess(null);
    setBusy(true);
    pollCount.current = 0;

    try {
      const result = await postJson("/api/stripe/terminal/quick-charge/start", {
        category: params.category,
        amount: params.amount,
        guestName,
        notes,
        readerId,
      });

      setActiveSession({
        paymentId: result.paymentId,
        sessionId: result.sessionId,
        status: result.status ?? "processing",
        amount: result.amount,
        categoryLabel: result.categoryLabel ?? params.label,
        readerLabel: result.readerLabel ?? "Stripe reader",
      });
      setPolling(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start quick charge.");
    } finally {
      setBusy(false);
    }
  }

  async function recordExternalCharge(params: { category: string; label: string; amount: number }) {
    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      setError("Enter a valid payment amount before recording the external card payment.");
      return;
    }

    setError(null);
    setLastSuccess(null);
    setBusy(true);

    try {
      const result = await postJson("/api/stripe/terminal/quick-charge/record-external", {
        category: params.category,
        amount: params.amount,
        guestName,
        notes,
        externalReference,
      });

      setLastSuccess(`${result.categoryLabel ?? params.label} recorded: ${formatCurrency(result.amount ?? params.amount)}`);
      setGuestName("");
      setNotes("");
      setExternalReference("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the external card payment.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus(session = activeSession) {
    if (!session) return;

    try {
      const result = await postJson("/api/stripe/terminal/quick-charge/refresh", {
        paymentId: session.paymentId,
        sessionId: session.sessionId,
      });

      setActiveSession((current) =>
        current
          ? {
              ...current,
              status: result.status ?? current.status,
            }
          : current
      );

      if (result.paid) {
        setLastSuccess(`${session.categoryLabel} paid: ${formatCurrency(session.amount)}`);
        setActiveSession(null);
        setGuestName("");
        setNotes("");
        setExternalReference("");
        setPolling(false);
        return;
      }

      if (result.done) {
        setError(result.errorMessage || "Payment did not complete. Try again or use another payment method.");
        setPolling(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh quick charge status.");
      setPolling(false);
    }
  }

  async function cancelCharge() {
    if (!activeSession) return;
    setBusy(true);
    setError(null);

    try {
      const result = await postJson("/api/stripe/terminal/quick-charge/cancel", {
        paymentId: activeSession.paymentId,
        sessionId: activeSession.sessionId,
      });

      if (result.paid || result.status === "succeeded") {
        setLastSuccess(`${activeSession.categoryLabel} paid: ${formatCurrency(activeSession.amount)}`);
        setGuestName("");
        setNotes("");
        setExternalReference("");
      }

      setActiveSession(null);
      setPolling(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel quick charge.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!polling || !activeSession) return;

    const interval = window.setInterval(() => {
      pollCount.current += 1;
      refreshStatus(activeSession);

      if (pollCount.current >= 90) {
        setPolling(false);
        setError("The reader is still waiting or processing. Refresh now to check the latest status, or cancel if the customer is no longer paying.");
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, [polling, activeSession?.paymentId, activeSession?.sessionId]);

  const customAmountNumber = Number(customAmount);
  const customCategoryLabel = CATEGORY_OPTIONS.find((option) => option.value === customCategory)?.label ?? "Other";

  return (
    <div className="space-y-6">
      {lastSuccess ? (
        <div className="flex items-start gap-3 rounded-2xl border border-green-200 bg-green-50 p-4 text-green-900">
          <CheckCircle2 className="mt-0.5 h-5 w-5" />
          <div>
            <p className="font-semibold">Payment complete</p>
            <p className="text-sm">{lastSuccess}. Ready for the next quick charge.</p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-900">
          <XCircle className="mt-0.5 h-5 w-5" />
          <div>
            <p className="font-semibold">Quick charge needs attention</p>
            <p className="text-sm">{error}</p>
          </div>
        </div>
      ) : null}

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              Quick Charge starts the sale in DanceFlow and sends it to a registered physical Stripe Terminal reader.
              The Stripe Dashboard mobile app Tap to Pay workflow is separate and will not automatically record this sale.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Reader</h2>
            <p className="mt-1 text-sm text-slate-500">
              Pick the front desk reader once. Preset buttons will send the charge directly to that reader.
            </p>
            {!selectedReaderOnline ? (
              <p className="mt-2 text-sm font-medium text-amber-700">
                Selected reader is not online. Wake the reader and refresh status before taking a card payment.
              </p>
            ) : null}
          </div>

          <select
            value={readerId}
            onChange={(event) => setReaderId(event.target.value)}
            className="min-w-[260px] rounded-xl border border-slate-300 px-3 py-2 text-sm"
            disabled={busy || Boolean(activeSession)}
          >
            {readers.length === 0 ? (
              <option value="">No readers registered</option>
            ) : null}
            {readers.map((reader) => (
              <option key={reader.id} value={reader.id}>
                {readerLabel(reader)}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="rounded-[28px] border border-sky-200 bg-sky-50 p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-white p-3 text-sky-700">
            <CreditCard className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-sky-950">Tap to Pay / external card fallback</h2>
            <p className="mt-1 text-sm leading-6 text-sky-900">
              If staff collect the card payment outside DanceFlow, such as in the Stripe Dashboard mobile app, use
              <span className="font-semibold"> Record external card</span>. This marks the payment paid immediately without sending anything to a reader.
            </p>
          </div>
        </div>
      </section>

      {activeSession ? (
        <section className="rounded-[28px] border border-indigo-200 bg-indigo-50 p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-white p-3 text-indigo-700">
                {polling ? <Loader2 className="h-5 w-5 animate-spin" /> : <Receipt className="h-5 w-5" />}
              </div>
              <div>
                <p className="font-semibold text-indigo-950">
                  Collecting {formatCurrency(activeSession.amount)} for {activeSession.categoryLabel}
                </p>
                <p className="mt-1 text-sm text-indigo-900">
                  Sent to {activeSession.readerLabel}. Ask the customer to tap, insert, or swipe their card.
                </p>
                <p className="mt-1 text-xs text-indigo-700">Status: {activeSession.status}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => refreshStatus()}
                className="rounded-xl border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-900 hover:bg-indigo-100"
                disabled={busy}
              >
                Refresh now
              </button>
              <button
                type="button"
                onClick={cancelCharge}
                className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-950">Fast door charges</h2>
          <p className="mt-1 text-sm text-slate-500">
            One click sends the preset amount to the selected Stripe reader and records the payment when it succeeds.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {PRESETS.map((preset) => (
            <div
              key={preset.category}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-5 transition hover:border-[var(--brand-primary)] hover:bg-white"
            >
              <p className="text-sm font-medium text-slate-500">{preset.helper}</p>
              <p className="mt-2 text-xl font-semibold text-slate-950">{preset.label}</p>
              <p className="mt-3 text-2xl font-bold text-[var(--brand-primary)]">{formatCurrency(preset.amount)}</p>

              <div className="mt-4 grid gap-2">
                <button
                  type="button"
                  onClick={() => startCharge(preset)}
                  disabled={busy || Boolean(activeSession) || !readerId || !selectedReaderOnline}
                  className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Send to reader
                </button>
                <button
                  type="button"
                  onClick={() => recordExternalCharge(preset)}
                  disabled={busy || Boolean(activeSession)}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Record external card
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-950">Custom quick charge</h2>
          <p className="mt-1 text-sm text-slate-500">
            Use this when the amount, category, guest name, or note needs to be specific.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-6">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="quickCategory">
              Category
            </label>
            <select
              id="quickCategory"
              value={customCategory}
              onChange={(event) => setCustomCategory(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              disabled={busy || Boolean(activeSession)}
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="quickAmount">
              Amount
            </label>
            <input
              id="quickAmount"
              type="number"
              min="0.01"
              step="0.01"
              value={customAmount}
              onChange={(event) => setCustomAmount(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="25.00"
              disabled={busy || Boolean(activeSession)}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="guestName">
              Guest name optional
            </label>
            <input
              id="guestName"
              value={guestName}
              onChange={(event) => setGuestName(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Walk-in name"
              disabled={busy || Boolean(activeSession)}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="quickNotes">
              Note optional
            </label>
            <input
              id="quickNotes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Example: Saturday social"
              disabled={busy || Boolean(activeSession)}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="externalReference">
              External ref optional
            </label>
            <input
              id="externalReference"
              value={externalReference}
              onChange={(event) => setExternalReference(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Stripe receipt/ref"
              disabled={busy || Boolean(activeSession)}
            />
          </div>

          <div className="grid content-end gap-2">
            <button
              type="button"
              onClick={() =>
                startCharge({
                  category: customCategory,
                  label: customCategoryLabel,
                  amount: customAmountNumber,
                })
              }
              disabled={
                busy ||
                Boolean(activeSession) ||
                !readerId ||
                !selectedReaderOnline ||
                !Number.isFinite(customAmountNumber) ||
                customAmountNumber <= 0
              }
              className="w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Sending..." : "Send to reader"}
            </button>
            <button
              type="button"
              onClick={() =>
                recordExternalCharge({
                  category: customCategory,
                  label: customCategoryLabel,
                  amount: customAmountNumber,
                })
              }
              disabled={
                busy ||
                Boolean(activeSession) ||
                !Number.isFinite(customAmountNumber) ||
                customAmountNumber <= 0
              }
              className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Record external card
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
