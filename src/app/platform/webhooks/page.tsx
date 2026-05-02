import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";

type WebhookEventRow = {
  id: string;
  provider: string | null;
  provider_event_id: string | null;
  event_type: string | null;
  status: string | null;
  processed_at: string | null;
  payload_hash: string | null;
  error_message: string | null;
  created_at: string;
};

type PlatformErrorLogRow = {
  id: string;
  severity: string | null;
  source: string | null;
  message: string | null;
  created_at: string;
  resolved_at: string | null;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function getStatusLabel(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "Unknown";
}

function getStatusClass(value: string | null | undefined) {
  const status = (value ?? "").toLowerCase();

  if (["processed", "succeeded", "success", "complete", "completed"].includes(status)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (["failed", "error", "errored"].includes(status)) {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (["received", "pending", "processing", "queued"].includes(status)) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function isProcessed(value: string | null | undefined) {
  const status = (value ?? "").toLowerCase();
  return ["processed", "succeeded", "success", "complete", "completed"].includes(status);
}

function isFailed(value: string | null | undefined) {
  const status = (value ?? "").toLowerCase();
  return ["failed", "error", "errored"].includes(status);
}

function isNeedsReview(value: string | null | undefined) {
  const status = (value ?? "").toLowerCase();
  return ["received", "pending", "processing", "queued"].includes(status);
}

function truncate(value: string | null | undefined, length = 72) {
  if (!value) return "—";
  if (value.length <= length) return value;
  return `${value.slice(0, length)}…`;
}

function StatCard({
  label,
  value,
  helper,
  tone = "slate",
}: {
  label: string;
  value: string | number;
  helper: string;
  tone?: "slate" | "emerald" | "amber" | "rose" | "violet";
}) {
  const toneClass = {
    slate: "from-slate-50 to-white text-slate-700",
    emerald: "from-emerald-50 to-white text-emerald-700",
    amber: "from-amber-50 to-white text-amber-700",
    rose: "from-rose-50 to-white text-rose-700",
    violet: "from-violet-50 to-white text-violet-700",
  }[tone];

  return (
    <div className={`rounded-[1.5rem] border border-slate-200 bg-gradient-to-br ${toneClass} p-5 shadow-sm`}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
        {value}
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{helper}</p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-600">
      <p className="font-semibold text-slate-900">{title}</p>
      <p className="mt-1 leading-6">{body}</p>
    </div>
  );
}

export default async function PlatformWebhooksPage() {
  await requirePlatformAdmin();

  const supabase = await createClient();

  const [eventsResult, unresolvedErrorResult] = await Promise.all([
    supabase
      .from("payment_provider_events")
      .select(
        "id, provider, provider_event_id, event_type, status, processed_at, payload_hash, error_message, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(250),
    supabase
      .from("platform_error_logs")
      .select("id, severity, source, message, created_at, resolved_at")
      .is("resolved_at", null)
      .or("source.ilike.%webhook%,source.ilike.%stripe%,message.ilike.%webhook%,message.ilike.%stripe%")
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const events = ((eventsResult.data ?? []) as WebhookEventRow[]).filter(Boolean);
  const unresolvedWebhookErrors = ((unresolvedErrorResult.data ?? []) as PlatformErrorLogRow[]).filter(Boolean);

  const processedEvents = events.filter((event) => isProcessed(event.status));
  const failedEvents = events.filter((event) => isFailed(event.status) || Boolean(event.error_message));
  const needsReviewEvents = events.filter((event) => isNeedsReview(event.status));

  const lastReceived = events[0] ?? null;
  const lastProcessed = processedEvents[0] ?? null;

  const now = Date.now();
  const last24hEvents = events.filter((event) => {
    const createdAt = new Date(event.created_at).getTime();
    return now - createdAt <= 24 * 60 * 60 * 1000;
  });
  const failedLast24h = last24hEvents.filter(
    (event) => isFailed(event.status) || Boolean(event.error_message)
  );

  const recentFailures = failedEvents.slice(0, 12);
  const recentEvents = events.slice(0, 40);

  const noRecentWebhook = !lastReceived
    ? true
    : now - new Date(lastReceived.created_at).getTime() > 48 * 60 * 60 * 1000;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
        <div className="bg-gradient-to-br from-slate-950 via-violet-950 to-slate-900 px-6 py-8 text-white sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-violet-200">
            Platform Operations
          </p>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">Webhook Health</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-violet-100">
                Monitor Stripe webhook activity, payment sync issues, and subscription update processing from one place.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/platform/alerts"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
              >
                View Alerts
              </Link>
              <Link
                href="/platform/billing"
                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 shadow-sm transition hover:bg-violet-50"
              >
                Billing Health
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Recent Events"
          value={events.length}
          helper="Most recent provider events loaded for review."
          tone="violet"
        />
        <StatCard
          label="Processed"
          value={processedEvents.length}
          helper="Events that completed local processing."
          tone="emerald"
        />
        <StatCard
          label="Failed"
          value={failedEvents.length}
          helper="Events with failed status or stored errors."
          tone={failedEvents.length > 0 ? "rose" : "slate"}
        />
        <StatCard
          label="Needs Review"
          value={needsReviewEvents.length}
          helper="Received or pending events not yet completed."
          tone={needsReviewEvents.length > 0 ? "amber" : "slate"}
        />
        <StatCard
          label="Last Received"
          value={lastReceived ? formatDateTime(lastReceived.created_at) : "—"}
          helper="Most recent webhook event stored by the platform."
          tone={noRecentWebhook ? "amber" : "slate"}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Health Signals
          </p>
          <h3 className="mt-2 text-xl font-semibold text-slate-950">Webhook processing status</h3>
          <div className="mt-4 space-y-3">
            {failedLast24h.length > 0 ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                <p className="text-sm font-semibold text-rose-800">
                  Failed webhook events in the last 24 hours
                </p>
                <p className="mt-1 text-sm leading-6 text-rose-700">
                  Review recent failures below and confirm related payments, registrations, subscriptions, and floor rental records synced correctly.
                </p>
              </div>
            ) : (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-semibold text-emerald-800">
                  No failed webhook events found in the last 24 hours
                </p>
                <p className="mt-1 text-sm leading-6 text-emerald-700">
                  Recent webhook processing does not show stored failure records.
                </p>
              </div>
            )}

            {needsReviewEvents.length > 0 ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-800">
                  Some provider events still need review
                </p>
                <p className="mt-1 text-sm leading-6 text-amber-700">
                  Pending or received events may need confirmation if they remain open after normal processing.
                </p>
              </div>
            ) : null}

            {noRecentWebhook ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-800">
                  No recent webhook activity detected
                </p>
                <p className="mt-1 text-sm leading-6 text-amber-700">
                  This may be normal during quiet periods, but confirm Stripe webhooks are configured if signups or payments recently occurred.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Latest Activity
          </p>
          <h3 className="mt-2 text-xl font-semibold text-slate-950">Last successful event</h3>
          <div className="mt-4 rounded-2xl bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">
              {lastProcessed?.event_type ?? "No processed events found"}
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Received: {formatDateTime(lastProcessed?.created_at)}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Processed: {formatDateTime(lastProcessed?.processed_at)}
            </p>
            <p className="mt-1 break-all text-xs text-slate-500">
              {lastProcessed?.provider_event_id ?? "—"}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Recent Failures
            </p>
            <h3 className="mt-2 text-xl font-semibold text-slate-950">Webhook events needing attention</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Failed provider events can affect billing, payment ledgers, event registrations, and floor rental payment status.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {recentFailures.length > 0 ? (
            recentFailures.map((event) => (
              <div key={event.id} className="rounded-2xl border border-rose-100 bg-rose-50/60 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-rose-200 bg-white px-3 py-1 text-xs font-semibold text-rose-700">
                        {getStatusLabel(event.status)}
                      </span>
                      <span className="text-sm font-semibold text-slate-950">
                        {event.event_type ?? "Unknown event"}
                      </span>
                    </div>
                    <p className="mt-2 break-all text-xs text-slate-500">
                      {event.provider_event_id ?? event.id}
                    </p>
                    <p className="mt-3 text-sm leading-6 text-rose-800">
                      {truncate(event.error_message, 180)}
                    </p>
                  </div>
                  <p className="text-sm text-slate-600 md:text-right">
                    {formatDateTime(event.created_at)}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <EmptyState
              title="No recent webhook failures"
              body="There are no failed provider events in the recent webhook log."
            />
          )}
        </div>
      </section>

      <section className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Event Log
            </p>
            <h3 className="mt-2 text-xl font-semibold text-slate-950">Recent provider events</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Review recent webhook activity and processing status.
            </p>
          </div>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {recentEvents.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-[0.16em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Event</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Received</th>
                    <th className="px-4 py-3 font-semibold">Processed</th>
                    <th className="px-4 py-3 font-semibold">Provider ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {recentEvents.map((event) => (
                    <tr key={event.id} className="align-top">
                      <td className="px-4 py-4">
                        <p className="font-semibold text-slate-950">
                          {event.event_type ?? "Unknown event"}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {event.provider ?? "provider"}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${getStatusClass(event.status)}`}>
                          {getStatusLabel(event.status)}
                        </span>
                        {event.error_message ? (
                          <p className="mt-2 max-w-xs text-xs leading-5 text-rose-700">
                            {truncate(event.error_message, 120)}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-slate-600">
                        {formatDateTime(event.created_at)}
                      </td>
                      <td className="px-4 py-4 text-slate-600">
                        {formatDateTime(event.processed_at)}
                      </td>
                      <td className="px-4 py-4">
                        <p className="max-w-xs break-all text-xs text-slate-500">
                          {event.provider_event_id ?? event.id}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-5">
              <EmptyState
                title="No webhook events found"
                body="Provider events will appear here after Stripe sends webhooks to the platform."
              />
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Related Platform Errors
        </p>
        <h3 className="mt-2 text-xl font-semibold text-slate-950">Open webhook or Stripe errors</h3>
        <div className="mt-5 space-y-3">
          {unresolvedWebhookErrors.length > 0 ? (
            unresolvedWebhookErrors.map((error) => (
              <div key={error.id} className="rounded-2xl border border-amber-100 bg-amber-50/70 p-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">
                      {error.source ?? "Platform error"}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-amber-800">
                      {error.message ?? "No message recorded."}
                    </p>
                  </div>
                  <p className="text-sm text-slate-600 md:text-right">
                    {formatDateTime(error.created_at)}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <EmptyState
              title="No open webhook-related platform errors"
              body="Unresolved Stripe or webhook-related platform errors will appear here."
            />
          )}
        </div>
      </section>
    </div>
  );
}
