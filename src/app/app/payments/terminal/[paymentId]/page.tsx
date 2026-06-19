import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canViewPayments } from "@/lib/auth/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CreditCard, RefreshCcw, XCircle } from "lucide-react";

type PageProps = {
  params: Promise<{ paymentId: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
};

type PaymentRow = {
  id: string;
  amount: number;
  currency: string | null;
  status: string;
  payment_method: string;
  payment_type: string | null;
  payment_channel?: string | null;
  source: string | null;
  notes: string | null;
  stripe_payment_intent_id: string | null;
  terminal_payment_session_id?: string | null;
  client_id: string | null;
  client_package_id: string | null;
  clients:
    | { first_name: string; last_name: string; email: string | null }
    | { first_name: string; last_name: string; email: string | null }[]
    | null;
  client_packages:
    | { name_snapshot: string | null }
    | { name_snapshot: string | null }[]
    | null;
  client_memberships:
    | { name_snapshot: string | null }
    | { name_snapshot: string | null }[]
    | null;
};

type ReaderRow = {
  id: string;
  label: string | null;
  device_type: string | null;
  status: string | null;
  stripe_reader_id: string;
  stripe_location_id: string | null;
};

type SessionRow = {
  id: string;
  status: string;
  error_message: string | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  stripe_terminal_readers:
    | { label: string | null; stripe_reader_id: string | null }
    | { label: string | null; stripe_reader_id: string | null }[]
    | null;
};

function fmtCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(Number(value ?? 0));
}

function fmtDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusBadgeClass(status: string | null | undefined) {
  const value = (status ?? "").toLowerCase();
  if (value === "paid" || value === "succeeded") return "bg-green-50 text-green-700";
  if (["pending", "processing", "requires_confirmation", "requires_payment_method"].includes(value)) return "bg-amber-50 text-amber-700";
  if (["failed", "canceled", "cancelled"].includes(value)) return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function getClientName(value: PaymentRow["clients"]) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getPackageName(value: PaymentRow["client_packages"]) {
  const pkg = Array.isArray(value) ? value[0] : value;
  return pkg?.name_snapshot ?? null;
}

function getMembershipName(value: PaymentRow["client_memberships"]) {
  const membership = Array.isArray(value) ? value[0] : value;
  return membership?.name_snapshot ?? null;
}

function getReaderLabel(value: SessionRow["stripe_terminal_readers"]) {
  const reader = Array.isArray(value) ? value[0] : value;
  return reader?.label ?? reader?.stripe_reader_id ?? "Reader";
}

function messageForSuccess(value: string | undefined) {
  if (value === "terminal_payment_ready") return "Payment is ready for card reader collection.";
  if (value === "terminal_payment_sent") return "Payment was sent to the reader. Ask the client to present their card, then refresh status.";
  if (value === "terminal_payment_refreshed") return "Payment status refreshed.";
  if (value === "terminal_payment_succeeded") return "In-person card payment succeeded and was recorded.";
  if (value === "terminal_payment_canceled") return "Terminal payment attempt was canceled.";
  if (value === "terminal_session_already_open") return "An open card reader session already exists for this payment.";
  return null;
}

function messageForError(value: string | undefined) {
  if (value === "terminal_reader_required") return "Select a card reader before starting collection.";
  if (value === "terminal_reader_not_found") return "The selected reader could not be found.";
  if (value === "terminal_payment_not_found") return "Payment record could not be found.";
  if (value === "terminal_payment_not_pending") return "This payment is not pending and cannot be sent to a reader.";
  if (value === "terminal_invalid_amount") return "Payment amount must be greater than zero.";
  if (value === "terminal_payment_start_failed") return "Could not start the card reader payment.";
  if (value === "terminal_payment_refresh_failed") return "Could not refresh the card reader payment.";
  if (value === "terminal_payment_failed") return "The card reader payment did not complete.";
  if (value === "terminal_payment_cancel_failed") return "Could not cancel the card reader payment.";
  if (value === "terminal_location_required") return "Create a Terminal location and register a reader before collecting payment.";
  return value ? value.replaceAll("_", " ") : null;
}

export default async function TerminalPaymentPage({ params, searchParams }: PageProps) {
  const { paymentId } = await params;
  const search = await searchParams;
  const supabase = createAdminClient();
  const context = await getCurrentStudioContext();

  if (!canViewPayments(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [{ data: payment, error: paymentError }, { data: readers, error: readersError }, { data: sessions, error: sessionsError }] = await Promise.all([
    supabase
      .from("payments")
      .select(`
        id,
        amount,
        currency,
        status,
        payment_method,
        payment_type,
        payment_channel,
        source,
        notes,
        stripe_payment_intent_id,
        terminal_payment_session_id,
        client_id,
        client_package_id,
        clients (
          first_name,
          last_name,
          email
        ),
        client_packages (
          name_snapshot
        ),
        client_memberships (
          name_snapshot
        )
      `)
      .eq("id", paymentId)
      .eq("studio_id", studioId)
      .single(),
    supabase
      .from("stripe_terminal_readers")
      .select("id, label, device_type, status, stripe_reader_id, stripe_location_id")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("label", { ascending: true }),
    supabase
      .from("terminal_payment_sessions")
      .select(`
        id,
        status,
        error_message,
        stripe_payment_intent_id,
        created_at,
        updated_at,
        completed_at,
        stripe_terminal_readers (
          label,
          stripe_reader_id
        )
      `)
      .eq("payment_id", paymentId)
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  if (paymentError || !payment) {
    throw new Error(`Failed to load terminal payment: ${paymentError?.message ?? "not found"}`);
  }

  if (readersError) {
    throw new Error(`Failed to load card readers: ${readersError.message}`);
  }

  if (sessionsError) {
    throw new Error(`Failed to load terminal sessions: ${sessionsError.message}`);
  }

  const typedPayment = payment as PaymentRow;
  const typedReaders = (readers ?? []) as ReaderRow[];
  const typedSessions = (sessions ?? []) as SessionRow[];
  const latestSession = typedSessions[0] ?? null;
  const successMessage = messageForSuccess(search.success);
  const errorMessage = messageForError(search.error);
  const currency = (typedPayment.currency ?? "usd").toUpperCase();
  const isPaid = typedPayment.status === "paid";
  const canStart = !isPaid && ["pending", "failed"].includes((typedPayment.status ?? "").toLowerCase());
  const packageName = getPackageName(typedPayment.client_packages);
  const membershipName = getMembershipName(typedPayment.client_memberships);

  return (
    <div className="space-y-6 p-1">
      <section className="rounded-[32px] border border-[var(--brand-border)] bg-white p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--brand-primary)]">
              DanceFlow Terminal
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              Collect in-person card payment
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
              Send this pending payment to a registered front-desk reader, then refresh status after the client presents their card.
            </p>
          </div>
          <Link href="/app/payments" className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Back to Payments
          </Link>
        </div>

        {successMessage ? (
          <div className="mt-5 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            {successMessage}
          </div>
        ) : null}

        {errorMessage ? (
          <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {errorMessage}
          </div>
        ) : null}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Client</p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">{getClientName(typedPayment.clients)}</h2>
            </div>
            <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(typedPayment.status)}`}>
              {typedPayment.status}
            </span>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Amount</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">{fmtCurrency(Number(typedPayment.amount ?? 0), currency)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Payment type</p>
              <p className="mt-2 font-semibold text-slate-950">{(typedPayment.payment_type ?? "general").replaceAll("_", " ")}</p>
            </div>
            {packageName ? (
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Package</p>
                <p className="mt-2 font-semibold text-slate-950">{packageName}</p>
              </div>
            ) : null}
            {membershipName ? (
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Membership</p>
                <p className="mt-2 font-semibold text-slate-950">{membershipName}</p>
              </div>
            ) : null}
          </div>

          {typedPayment.notes ? (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-600">
              {typedPayment.notes}
            </div>
          ) : null}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Send to reader</h2>
              <p className="text-sm text-slate-500">Choose the active front-desk reader.</p>
            </div>
          </div>

          {isPaid ? (
            <div className="mt-5 rounded-2xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
              This payment is already marked paid.
            </div>
          ) : typedReaders.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              No active readers are registered yet. Go to Billing &amp; Payouts to register a card reader.
            </div>
          ) : (
            <form action="/api/stripe/terminal/payments/start" method="post" className="mt-5 space-y-4">
              <input type="hidden" name="paymentId" value={typedPayment.id} />
              <div>
                <label htmlFor="readerId" className="mb-1 block text-sm font-medium text-slate-700">
                  Card reader
                </label>
                <select id="readerId" name="readerId" className="w-full rounded-xl border border-slate-300 px-3 py-2" required disabled={!canStart}>
                  <option value="">Select reader</option>
                  {typedReaders.map((reader) => (
                    <option key={reader.id} value={reader.id}>
                      {reader.label ?? reader.stripe_reader_id} {reader.status ? `(${reader.status})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" disabled={!canStart} className="w-full rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60">
                Send payment to reader
              </button>
              {!canStart ? (
                <p className="text-xs leading-5 text-slate-500">Only pending or failed payments can be sent to a reader.</p>
              ) : null}
            </form>
          )}
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Reader payment status</h2>
            <p className="text-sm text-slate-500">Use Refresh after the client taps, inserts, or swipes their card.</p>
          </div>
          {latestSession ? (
            <div className="flex flex-wrap gap-2">
              <form action="/api/stripe/terminal/payments/refresh" method="post">
                <input type="hidden" name="paymentId" value={typedPayment.id} />
                <input type="hidden" name="sessionId" value={latestSession.id} />
                <button type="submit" className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                  <RefreshCcw className="h-4 w-4" />
                  Refresh status
                </button>
              </form>
              {!isPaid && !["canceled", "succeeded"].includes((latestSession.status ?? "").toLowerCase()) ? (
                <form action="/api/stripe/terminal/payments/cancel" method="post">
                  <input type="hidden" name="paymentId" value={typedPayment.id} />
                  <input type="hidden" name="sessionId" value={latestSession.id} />
                  <button type="submit" className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100">
                    <XCircle className="h-4 w-4" />
                    Cancel attempt
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="mt-5 space-y-3">
          {typedSessions.length === 0 ? (
            <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              No reader sessions have been started for this payment yet.
            </p>
          ) : (
            typedSessions.map((session) => (
              <div key={session.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-semibold text-slate-950">{getReaderLabel(session.stripe_terminal_readers)}</p>
                    <p className="mt-1 text-xs text-slate-500">Started {fmtDateTime(session.created_at)} · Updated {fmtDateTime(session.updated_at)}</p>
                  </div>
                  <span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(session.status)}`}>
                    {session.status.replaceAll("_", " ")}
                  </span>
                </div>
                {session.error_message ? <p className="mt-3 text-sm text-red-700">{session.error_message}</p> : null}
                {session.stripe_payment_intent_id ? <p className="mt-3 text-xs text-slate-500">Stripe PaymentIntent: {session.stripe_payment_intent_id}</p> : null}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
