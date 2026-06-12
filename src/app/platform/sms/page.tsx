import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { getSmsPlatformReadiness } from "@/lib/sms/compliance";

type SmsMessageLogRow = {
  id: string;
  studio_id: string | null;
  organizer_id: string | null;
  client_id: string | null;
  organizer_contact_id: string | null;
  phone_e164: string | null;
  direction: string | null;
  message_type: string | null;
  body: string | null;
  segment_count: number | null;
  status: string | null;
  provider: string | null;
  provider_message_id: string | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  created_at: string;
  updated_at: string | null;
  studios?: { name: string | null } | { name: string | null }[] | null;
  organizers?: { name: string | null } | { name: string | null }[] | null;
};

type SmsConsentRow = {
  id: string;
  studio_id: string | null;
  organizer_id: string | null;
  client_id: string | null;
  organizer_contact_id: string | null;
  phone_e164: string | null;
  consent_status: string | null;
  updated_at: string | null;
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

function getStatusClass(value: string | null | undefined) {
  const status = String(value ?? "").toLowerCase();

  if (status === "delivered") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "sent") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "failed" || status === "undelivered") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "queued" || status === "accepted" || status === "sending") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "received") return "border-violet-200 bg-violet-50 text-violet-700";

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function getStatusLabel(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "Unknown";
}

function truncate(value: string | null | undefined, length = 96) {
  if (!value) return "—";
  if (value.length <= length) return value;
  return `${value.slice(0, length)}…`;
}

function asName(value: SmsMessageLogRow["studios"] | SmsMessageLogRow["organizers"]) {
  const item = Array.isArray(value) ? value[0] : value;
  return item?.name ?? null;
}

function countByStatus(rows: SmsMessageLogRow[], status: string) {
  return rows.filter((row) => String(row.status ?? "").toLowerCase() === status).length;
}

function countFailed(rows: SmsMessageLogRow[]) {
  return rows.filter((row) => {
    const status = String(row.status ?? "").toLowerCase();
    return status === "failed" || status === "undelivered";
  }).length;
}

function countInboundKeywords(rows: SmsMessageLogRow[]) {
  return rows.filter((row) => {
    const direction = String(row.direction ?? "").toLowerCase();
    const body = String(row.body ?? "").trim().toUpperCase();

    return direction === "inbound" && ["STOP", "START", "HELP"].some((word) => body.startsWith(word));
  }).length;
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
  tone?: "slate" | "emerald" | "amber" | "rose" | "violet" | "sky";
}) {
  const toneClass = {
    slate: "from-slate-50 to-white text-slate-700",
    emerald: "from-emerald-50 to-white text-emerald-700",
    amber: "from-amber-50 to-white text-amber-700",
    rose: "from-rose-50 to-white text-rose-700",
    violet: "from-violet-50 to-white text-violet-700",
    sky: "from-sky-50 to-white text-sky-700",
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

function StatusPill({ status }: { status: string | null | undefined }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${getStatusClass(
        status,
      )}`}
    >
      {getStatusLabel(status)}
    </span>
  );
}

export default async function PlatformSmsPage() {
  await requirePlatformAdmin();

  const supabase = await createClient();

  const [logsResult, consentResult] = await Promise.all([
    supabase
      .from("sms_message_logs")
      .select(
        "id, studio_id, organizer_id, client_id, organizer_contact_id, phone_e164, direction, message_type, body, segment_count, status, provider, provider_message_id, provider_error_code, provider_error_message, sent_at, delivered_at, failed_at, created_at, updated_at, studios(name), organizers(name)",
      )
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("sms_contact_permissions")
      .select("id, studio_id, organizer_id, client_id, organizer_contact_id, phone_e164, consent_status, updated_at")
      .order("updated_at", { ascending: false })
      .limit(500),
  ]);

  const logs = (logsResult.data ?? []) as SmsMessageLogRow[];
  const consentRows = (consentResult.data ?? []) as SmsConsentRow[];

  const twilioConfigured = Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_MESSAGE_SERVICE_SID),
  );

  const callbackConfigured = Boolean(process.env.TWILIO_STATUS_CALLBACK_SECRET);
  const smsReadiness = getSmsPlatformReadiness();

  const deliveredCount = countByStatus(logs, "delivered");
  const sentCount = countByStatus(logs, "sent");
  const queuedCount = countByStatus(logs, "queued");
  const failedCount = countFailed(logs);
  const inboundKeywordCount = countInboundKeywords(logs);
  const optedInCount = consentRows.filter((row) => row.consent_status === "opted_in").length;
  const optedOutCount = consentRows.filter((row) => row.consent_status === "opted_out").length;
  const consentNeededCount = consentRows.filter((row) => row.consent_status === "unknown").length;

  const latestStatusUpdate = logs
    .filter((row) => row.delivered_at || row.failed_at || row.status === "sent")
    .sort((a, b) => {
      const aValue = new Date(a.delivered_at ?? a.failed_at ?? a.updated_at ?? a.created_at).getTime();
      const bValue = new Date(b.delivered_at ?? b.failed_at ?? b.updated_at ?? b.created_at).getTime();
      return bValue - aValue;
    })[0];

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-8">
      <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
        <div className="bg-gradient-to-br from-slate-950 via-violet-950 to-fuchsia-800 px-6 py-8 text-white sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-fuchsia-100">
            Platform SMS
          </p>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                SMS operations
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-fuchsia-50">
                Monitor platform texting health, message delivery, consent activity, and provider readiness from one internal view.
              </p>
            </div>

            <Link
              href="/platform/webhooks"
              className="inline-flex w-fit rounded-2xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-white/15"
            >
              Webhook health
            </Link>
          </div>
        </div>

        <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard
            label="Sending status"
            value={smsReadiness.label}
            helper={smsReadiness.platformMessage}
            tone={smsReadiness.canSend ? "emerald" : smsReadiness.status === "rejected" ? "rose" : "amber"}
          />
          <StatCard
            label="Recent messages"
            value={logs.length}
            helper="Latest outbound and inbound SMS records loaded for review."
            tone="violet"
          />
          <StatCard
            label="Queued"
            value={queuedCount}
            helper="Messages accepted by the app and waiting on provider/carrier status."
            tone="amber"
          />
          <StatCard
            label="Delivered"
            value={deliveredCount}
            helper={`Sent count: ${sentCount}. Delivery depends on provider callback updates.`}
            tone="emerald"
          />
          <StatCard
            label="Failed"
            value={failedCount}
            helper="Messages with failed or undelivered provider status."
            tone={failedCount > 0 ? "rose" : "slate"}
          />
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Provider setup
          </p>
          <h2 className="mt-2 text-lg font-semibold text-slate-950">Twilio connection</h2>
          <div className="mt-4 space-y-3 text-sm text-slate-700">
            <div className="flex items-center justify-between gap-3">
              <span>Credentials</span>
              <StatusPill status={twilioConfigured ? "delivered" : "failed"} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Status callback secret</span>
              <StatusPill status={callbackConfigured ? "sent" : "failed"} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Latest provider update</span>
              <span className="text-right text-xs font-medium text-slate-500">
                {formatDateTime(
                  latestStatusUpdate?.delivered_at ??
                    latestStatusUpdate?.failed_at ??
                    latestStatusUpdate?.updated_at ??
                    null,
                )}
              </span>
            </div>
          </div>
          <p className="mt-4 rounded-2xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">
            Keep carrier registration details in Twilio. This page verifies whether DanceFlow can send and track platform SMS activity.
          </p>
          <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
            <p className="font-semibold">Safe activation</p>
            <p className="mt-1">
              Production SMS sends are blocked unless <code>DANCEFLOW_SMS_STATUS=approved</code> or <code>SMS_PLATFORM_STATUS=approved</code>. Current status: <span className="font-semibold">{smsReadiness.label}</span>.
            </p>
          </div>
        </div>

        <div className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Consent
          </p>
          <h2 className="mt-2 text-lg font-semibold text-slate-950">Client readiness</h2>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-2xl bg-emerald-50 p-3 text-center">
              <p className="text-2xl font-semibold text-emerald-700">{optedInCount}</p>
              <p className="mt-1 text-xs text-emerald-700">Opted in</p>
            </div>
            <div className="rounded-2xl bg-rose-50 p-3 text-center">
              <p className="text-2xl font-semibold text-rose-700">{optedOutCount}</p>
              <p className="mt-1 text-xs text-rose-700">Opted out</p>
            </div>
            <div className="rounded-2xl bg-amber-50 p-3 text-center">
              <p className="text-2xl font-semibold text-amber-700">{consentNeededCount}</p>
              <p className="mt-1 text-xs text-amber-700">Needed</p>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            SMS sends remain blocked unless the platform is approved and the contact is opted in. Consent history is stored separately for audit review.
          </p>
        </div>

        <div className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Inbound
          </p>
          <h2 className="mt-2 text-lg font-semibold text-slate-950">STOP / START / HELP</h2>
          <p className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
            {inboundKeywordCount}
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Recent inbound keyword messages recorded by the SMS webhook. Use this to confirm opt-out and help flows after carrier approval.
          </p>
        </div>
      </section>

      {(logsResult.error || consentResult.error) ? (
        <section className="rounded-[1.5rem] border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
          <p className="font-semibold">Some SMS data could not be loaded.</p>
          <p className="mt-2 leading-6">
            {logsResult.error?.message ?? consentResult.error?.message}
          </p>
        </section>
      ) : null}

      <section className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Message log
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Recent SMS activity
            </h2>
          </div>
          <p className="text-sm text-slate-500">Showing latest 100 messages.</p>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {logs.length === 0 ? (
            <div className="bg-slate-50 px-4 py-8 text-sm text-slate-600">
              <p className="font-semibold text-slate-900">No SMS activity yet.</p>
              <p className="mt-1">Once studios send texts, message attempts and provider statuses will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {logs.map((row) => {
                const workspaceName = asName(row.studios) ?? asName(row.organizers) ?? "Workspace";
                const errorText = row.provider_error_message || row.provider_error_code;

                return (
                  <article
                    key={row.id}
                    className="grid gap-3 bg-white px-4 py-4 text-sm md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.7fr)_auto]"
                  >
                    <div>
                      <p className="font-semibold text-slate-950">{workspaceName}</p>
                      <p className="mt-1 text-xs text-slate-500">{row.phone_e164 ?? "No phone"}</p>
                      <p className="mt-1 text-xs capitalize text-slate-500">
                        {row.direction ?? "outbound"} · {row.message_type ?? "manual"} · {row.segment_count ?? 1} segment
                      </p>
                    </div>

                    <div>
                      <p className="leading-6 text-slate-700">{truncate(row.body)}</p>
                      {errorText ? (
                        <p className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
                          {errorText}
                        </p>
                      ) : null}
                      <p className="mt-2 text-xs text-slate-500">
                        Provider ID: {row.provider_message_id ?? "—"}
                      </p>
                    </div>

                    <div className="flex flex-col items-start gap-2 md:items-end">
                      <StatusPill status={row.status} />
                      <p className="text-xs text-slate-500">{formatDateTime(row.created_at)}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
