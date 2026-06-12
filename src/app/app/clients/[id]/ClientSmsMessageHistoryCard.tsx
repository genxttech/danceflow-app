import {
  type SmsMessageLogRow,
  smsSendStatusLabel,
} from "@/lib/sms/compliance";

type ClientSmsMessageHistoryCardProps = {
  messages?: SmsMessageLogRow[];
};

function formatSmsDate(value: string | null | undefined) {
  if (!value) return "—";

  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function smsStatusClasses(status: string | null | undefined) {
  const normalized = String(status ?? "").toLowerCase();

  if (normalized === "delivered") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (normalized === "sent") return "border-sky-200 bg-sky-50 text-sky-800";
  if (normalized === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  if (normalized === "suppressed") return "border-amber-200 bg-amber-50 text-amber-800";
  if (normalized === "received") return "border-violet-200 bg-violet-50 text-violet-800";

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function directionLabel(direction: string | null | undefined) {
  if (direction === "inbound") return "Incoming";
  return "Outgoing";
}

function messageTimestamp(message: SmsMessageLogRow) {
  if (message.delivered_at) return message.delivered_at;
  if (message.failed_at) return message.failed_at;
  if (message.sent_at) return message.sent_at;
  return message.created_at;
}

export function ClientSmsMessageHistoryCard({
  messages = [],
}: ClientSmsMessageHistoryCardProps) {
  const recentMessages = messages.slice(0, 8);

  return (
    <section className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            SMS History
          </p>
          <h3 className="mt-2 text-lg font-semibold text-[var(--brand-text)]">
            Recent text messages
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Review recent texts and delivery status for this client.
          </p>
        </div>

        <span className="inline-flex w-fit rounded-full bg-[var(--brand-primary-soft)] px-3 py-1 text-xs font-semibold text-[var(--brand-primary)]">
          {messages.length} logged
        </span>
      </div>

      <div className="mt-5 space-y-3">
        {recentMessages.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] p-5 text-sm leading-6 text-slate-600">
            No text messages have been logged for this client yet. Sent messages will appear here after staff send an individual SMS.
          </div>
        ) : (
          recentMessages.map((message) => (
            <div
              key={message.id}
              className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${smsStatusClasses(message.status)}`}>
                      {smsSendStatusLabel(message.status)}
                    </span>
                    <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
                      {directionLabel(message.direction)}
                    </span>
                    <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
                      {message.segment_count || 1} segment{message.segment_count === 1 ? "" : "s"}
                    </span>
                  </div>

                  <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--brand-text)]">
                    {message.body || "No message body saved."}
                  </p>

                  {message.provider_error_message ? (
                    <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-800">
                      <span className="font-semibold">Delivery issue:</span>{" "}
                      This text could not be completed. Check the student's phone number or try again later.
                    </div>
                  ) : null}
                </div>

                <div className="shrink-0 text-left text-xs leading-5 text-slate-500 sm:text-right">
                  <p>{formatSmsDate(messageTimestamp(message))}</p>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {messages.length > recentMessages.length ? (
        <p className="mt-3 text-xs text-slate-500">
          Showing the latest {recentMessages.length} messages. Full SMS reporting will use the same message log.
        </p>
      ) : null}

      <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
        Tip: Text messaging may be unavailable while carrier approval is pending. Once texting is active, this history will update with sent, delivered, or failed statuses.
      </div>
    </section>
  );
}
