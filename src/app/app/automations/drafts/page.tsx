import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Inbox,
  Mail,
  Send,
  Sparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  completeAutomationAction,
  queueAutomationEmailDraftAction,
  saveAutomationEmailDraftAction,
} from "../actions";

type SearchParams = Promise<{
  status?: string;
  success?: string;
  error?: string;
}>;

type AutomationDraftDeliveryRow = {
  id: string;
  template_key: string | null;
  recipient_email: string | null;
  subject: string | null;
  body_text: string | null;
  status: string;
  related_id: string | null;
  created_at: string;
  updated_at: string | null;
  sent_at: string | null;
  error_message: string | null;
};

type AutomationActionRow = {
  id: string;
  rule_key: string;
  title: string;
  body: string | null;
  status: string;
  priority: string | null;
  client_id: string | null;
  created_at: string;
  completed_at: string | null;
  dismissed_at: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

const DELIVERY_STATUSES = ["draft", "queued", "sent", "failed", "skipped"];

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not available";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function ruleLabel(ruleKey: string | null | undefined) {
  if (ruleKey === "low_package_balance") return "Low package balance";
  if (ruleKey === "no_upcoming_lesson") return "No upcoming lesson";
  if (ruleKey === "unsigned_document") return "Unsigned document";
  if (ruleKey === "pending_booking_request") return "Pending booking request";
  if (ruleKey === "first_lesson_follow_up") return "First lesson follow-up";
  return "Automation";
}

function clientName(client: ClientRow | null | undefined) {
  const name = [client?.first_name, client?.last_name].filter(Boolean).join(" ").trim();
  return name || client?.email || "Client";
}

function statusLabel(status: string) {
  if (status === "draft") return "Draft";
  if (status === "queued") return "Queued";
  if (status === "sent") return "Sent";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return status;
}

function statusClasses(status: string) {
  if (status === "sent") return "bg-emerald-50 text-emerald-700";
  if (status === "queued") return "bg-blue-50 text-blue-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "skipped") return "bg-slate-100 text-slate-600";
  return "bg-pink-50 text-[#BE185D]";
}

function statusIcon(status: string) {
  if (status === "sent") return CheckCircle2;
  if (status === "queued") return Clock3;
  if (status === "failed") return AlertCircle;
  return Mail;
}

export default async function AutomationDraftsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context.studioId) {
    redirect("/app");
  }

  const canManage = canManageSettings(context.studioRole ?? "");
  const selectedStatus = DELIVERY_STATUSES.includes(query.status ?? "")
    ? String(query.status)
    : "all";
  const statuses = selectedStatus === "all" ? DELIVERY_STATUSES : [selectedStatus];

  const { data: deliveries } = await supabase
    .from("outbound_deliveries")
    .select(
      "id, template_key, recipient_email, subject, body_text, status, related_id, created_at, updated_at, sent_at, error_message"
    )
    .eq("studio_id", context.studioId)
    .eq("related_table", "automation_actions")
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(50);

  const typedDeliveries = (deliveries ?? []) as AutomationDraftDeliveryRow[];
  const actionIds = Array.from(
    new Set(typedDeliveries.map((delivery) => delivery.related_id).filter(Boolean) as string[])
  );

  const { data: actions } =
    actionIds.length > 0
      ? await supabase
          .from("automation_actions")
          .select("id, rule_key, title, body, status, priority, client_id, created_at, completed_at, dismissed_at")
          .eq("studio_id", context.studioId)
          .in("id", actionIds)
      : { data: [] };

  const typedActions = (actions ?? []) as AutomationActionRow[];
  const actionById = new Map(typedActions.map((action) => [action.id, action]));
  const clientIds = Array.from(
    new Set(typedActions.map((action) => action.client_id).filter(Boolean) as string[])
  );

  const { data: clients } =
    clientIds.length > 0
      ? await supabase
          .from("clients")
          .select("id, first_name, last_name, email")
          .eq("studio_id", context.studioId)
          .in("id", clientIds)
      : { data: [] };

  const clientById = new Map(((clients ?? []) as ClientRow[]).map((client) => [client.id, client]));
  const counts = DELIVERY_STATUSES.reduce<Record<string, number>>((acc, status) => {
    acc[status] = typedDeliveries.filter((delivery) => delivery.status === status).length;
    return acc;
  }, {});

  return (
    <main className="min-h-screen bg-[#F8F5FF] px-4 py-8 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <section className="overflow-hidden rounded-[32px] border border-white/70 bg-gradient-to-br from-[#2D0A46] via-[#6B21A8] to-[#DB2777] p-6 text-white shadow-xl sm:p-8">
          <Link
            href="/app/automations"
            className="inline-flex items-center gap-2 text-sm font-semibold text-pink-100 underline decoration-white/30 underline-offset-4"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to automations
          </Link>
          <div className="mt-6 grid gap-8 lg:grid-cols-[1.3fr_0.7fr] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-pink-100">
                <Inbox className="h-3.5 w-3.5" />
                Draft review inbox
              </div>
              <h1 className="mt-4 max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">
                Review automation emails before they go out.
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-pink-50 sm:text-base">
                ARIA and Automations can prepare client follow-up drafts, but your team stays in control.
                Edit the message, queue it for send, and track delivery from one focused inbox.
              </p>
            </div>
            <div className="rounded-3xl border border-white/20 bg-white/10 p-5 backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-100">
                Waiting for review
              </p>
              <p className="mt-2 text-3xl font-semibold">{counts.draft ?? 0}</p>
              <p className="mt-1 text-sm text-pink-50">
                Draft email{(counts.draft ?? 0) === 1 ? "" : "s"} ready for review.
              </p>
            </div>
          </div>
        </section>

        {query.success ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            Draft workflow updated.
          </div>
        ) : null}
        {query.error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            Could not update draft: {query.error}
          </div>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-5">
          {[
            ["all", "All", typedDeliveries.length],
            ["draft", "Draft", counts.draft ?? 0],
            ["queued", "Queued", counts.queued ?? 0],
            ["sent", "Sent", counts.sent ?? 0],
            ["failed", "Failed", counts.failed ?? 0],
          ].map(([key, label, count]) => {
            const href = key === "all" ? "/app/automations/drafts" : `/app/automations/drafts?status=${key}`;
            const active = selectedStatus === key;

            return (
              <Link
                key={String(key)}
                href={href}
                className={`rounded-2xl border px-4 py-3 text-sm font-semibold shadow-sm transition ${
                  active
                    ? "border-[#DB2777] bg-white text-[#BE185D]"
                    : "border-slate-200 bg-white/70 text-slate-600 hover:bg-white"
                }`}
              >
                <span className="block text-xs uppercase tracking-[0.14em] text-slate-400">
                  {label}
                </span>
                <span className="mt-1 block text-2xl text-slate-950">{count}</span>
              </Link>
            );
          })}
        </section>

        <section className="space-y-4">
          {typedDeliveries.length > 0 ? (
            typedDeliveries.map((delivery) => {
              const action = delivery.related_id ? actionById.get(delivery.related_id) : null;
              const client = action?.client_id ? clientById.get(action.client_id) : null;
              const StatusIcon = statusIcon(delivery.status);

              return (
                <article key={delivery.id} className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${statusClasses(delivery.status)}`}>
                          <StatusIcon className="h-3.5 w-3.5" />
                          {statusLabel(delivery.status)}
                        </span>
                        <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
                          {ruleLabel(action?.rule_key)}
                        </span>
                        {action?.priority ? (
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                            {action.priority} priority
                          </span>
                        ) : null}
                      </div>

                      <h2 className="mt-3 text-xl font-semibold text-slate-950">
                        {action?.title ?? delivery.subject ?? "Automation email draft"}
                      </h2>
                      <p className="mt-1 text-sm text-slate-600">
                        {client ? clientName(client) : "Recipient"} · {delivery.recipient_email ?? "Missing recipient"}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Created {formatDateTime(delivery.created_at)} · Updated {formatDateTime(delivery.updated_at)}
                      </p>
                      {delivery.status === "sent" ? (
                        <p className="mt-2 text-sm font-medium text-emerald-700">
                          Sent {formatDateTime(delivery.sent_at ?? delivery.updated_at)}
                        </p>
                      ) : null}
                      {delivery.status === "failed" ? (
                        <p className="mt-2 rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
                          {delivery.error_message || "Delivery failed. Review the outbound sender logs for details."}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap gap-2 lg:justify-end">
                      {action?.client_id ? (
                        <Link
                          href={`/app/clients/${action.client_id}?tab=notes`}
                          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          Open client
                        </Link>
                      ) : null}
                      <Link
                        href="/app/automations"
                        className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                      >
                        Open action
                      </Link>
                    </div>
                  </div>

                  {delivery.status === "draft" ? (
                    <form action={saveAutomationEmailDraftAction} className="mt-5 space-y-3 rounded-2xl border border-pink-100 bg-pink-50/40 p-4">
                      <input type="hidden" name="actionId" value={delivery.related_id ?? ""} />
                      <input type="hidden" name="deliveryId" value={delivery.id} />
                      <input type="hidden" name="returnTo" value="/app/automations/drafts" />
                      <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                        Subject
                        <input
                          name="subject"
                          defaultValue={delivery.subject ?? ""}
                          disabled={!canManage}
                          className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal tracking-normal text-slate-900 outline-none focus:border-[#DB2777] focus:ring-2 focus:ring-pink-100 disabled:bg-slate-100"
                        />
                      </label>
                      <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                        Body
                        <textarea
                          name="bodyText"
                          defaultValue={delivery.body_text ?? ""}
                          rows={8}
                          disabled={!canManage}
                          className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal leading-6 tracking-normal text-slate-900 outline-none focus:border-[#DB2777] focus:ring-2 focus:ring-pink-100 disabled:bg-slate-100"
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="submit"
                          disabled={!canManage}
                          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                        >
                          Save draft
                        </button>
                        <button
                          type="submit"
                          formAction={queueAutomationEmailDraftAction}
                          disabled={!canManage}
                          className="inline-flex items-center gap-2 rounded-full bg-[#6B21A8] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#581C87] disabled:cursor-not-allowed disabled:bg-slate-300"
                        >
                          Queue for send
                          <Send className="h-4 w-4" />
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-semibold text-slate-900">
                        {delivery.subject ?? "No subject"}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                        {delivery.body_text ?? "No body text saved."}
                      </p>
                      {delivery.status === "queued" ? (
                        <p className="mt-3 rounded-2xl bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700">
                          This email is queued and waiting for the outbound sender.
                        </p>
                      ) : null}
                      {delivery.status === "sent" && action?.status !== "completed" ? (
                        <form action={completeAutomationAction} className="mt-3">
                          <input type="hidden" name="actionId" value={delivery.related_id ?? ""} />
                          <button
                            type="submit"
                            disabled={!canManage}
                            className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                          >
                            Mark action complete
                          </button>
                        </form>
                      ) : null}
                    </div>
                  )}
                </article>
              );
            })
          ) : (
            <div className="rounded-[28px] border border-dashed border-slate-300 bg-white px-4 py-12 text-center shadow-sm">
              <Sparkles className="mx-auto h-8 w-8 text-slate-400" />
              <h2 className="mt-3 text-lg font-semibold text-slate-950">No automation drafts found</h2>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
                Create a draft from an automation action, then come back here to review, edit,
                and queue it for send.
              </p>
              <Link
                href="/app/automations"
                className="mt-5 inline-flex items-center gap-2 rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
              >
                Open automations
                <ArrowLeft className="h-4 w-4 rotate-180" />
              </Link>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
