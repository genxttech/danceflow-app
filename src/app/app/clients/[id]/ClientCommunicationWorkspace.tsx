"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  Mail,
  MessageSquareText,
  NotebookPen,
  Phone,
  Send,
  Sparkles,
} from "lucide-react";
import type {
  SmsMessageLogRow,
  SmsPermissionRow,
} from "@/lib/sms/compliance";
import ResponsiveDetailPanel from "@/components/app/workspace/ResponsiveDetailPanel";
import LeadActivityForm from "@/app/app/leads/LeadActivityForm";
import { completeLeadFollowUpAction } from "@/app/app/leads/activity-actions";
import { ClientSmsConsentCard } from "./ClientSmsConsentCard";
import { ClientSendSmsCard } from "./ClientSendSmsCard";

type LeadActivityRow = {
  id: string;
  activity_type: string;
  note: string;
  created_at: string;
  follow_up_due_at: string | null;
  completed_at: string | null;
  profiles:
    | { full_name: string | null; email: string | null }
    | { full_name: string | null; email: string | null }[]
    | null;
};

type ClientActivityNoteRow = {
  id: string;
  note_type: string;
  body: string;
  occurred_at: string;
  created_at: string;
  profiles:
    | { full_name: string | null; email: string | null }
    | { full_name: string | null; email: string | null }[]
    | null;
};

type AutomationActionRow = {
  id: string;
  rule_key: string;
  title: string;
  body: string | null;
  status: string;
  priority: string | null;
  due_at: string | null;
  completed_at: string | null;
  dismissed_at: string | null;
  created_at: string;
};

type AutomationDeliveryRow = {
  id: string;
  template_key: string | null;
  recipient_email: string | null;
  subject: string | null;
  status: string;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  related_id: string | null;
};

type TimelineItem = {
  id: string;
  kind: "sms" | "lead_activity" | "note" | "automation";
  title: string;
  body: string;
  occurredAt: string;
  status?: string;
  detail?: string;
  source: SmsMessageLogRow | LeadActivityRow | ClientActivityNoteRow | AutomationActionRow;
};

function formatDateTime(value: string | null, timeZone: string) {
  if (!value) return "Not recorded";

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function getAuthorName(
  value:
    | { full_name: string | null; email: string | null }
    | { full_name: string | null; email: string | null }[]
    | null,
) {
  const author = Array.isArray(value) ? value[0] : value;
  return author?.full_name || author?.email || "Studio team";
}

function activityLabel(value: string) {
  if (value === "follow_up") return "Follow-up";
  if (value === "call") return "Call";
  if (value === "text") return "Text";
  if (value === "email") return "Email";
  if (value === "consultation") return "Consultation";
  return "Note";
}

function noteTypeLabel(value: string) {
  if (value === "follow_up") return "Follow-up note";
  if (value === "sales") return "Sales note";
  if (value === "lesson") return "Lesson note";
  if (value === "billing") return "Billing note";
  if (value === "concern") return "Concern";
  return "Internal note";
}

function automationRuleLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function timelineIcon(kind: TimelineItem["kind"]) {
  if (kind === "sms") return Send;
  if (kind === "lead_activity") return Phone;
  if (kind === "automation") return Bot;
  return NotebookPen;
}

function timelineTone(kind: TimelineItem["kind"]) {
  if (kind === "sms") return "border-sky-200 bg-sky-50 text-sky-800";
  if (kind === "lead_activity") return "border-orange-200 bg-orange-50 text-orange-800";
  if (kind === "automation") return "border-violet-200 bg-violet-50 text-violet-800";
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
}

export default function ClientCommunicationWorkspace({
  clientId,
  clientName,
  phone,
  smsPermission,
  smsMessages,
  leadActivities,
  clientNotes,
  automationActions,
  automationDeliveries,
  canManage,
  returnTo,
  smsConsentMessage,
  smsConsentError,
  studioTimeZone,
}: {
  clientId: string;
  clientName: string;
  phone: string | null;
  smsPermission: SmsPermissionRow | null;
  smsMessages: SmsMessageLogRow[];
  leadActivities: LeadActivityRow[];
  clientNotes: ClientActivityNoteRow[];
  automationActions: AutomationActionRow[];
  automationDeliveries: AutomationDeliveryRow[];
  canManage: boolean;
  returnTo: string;
  smsConsentMessage: string | null;
  smsConsentError: string | null;
  studioTimeZone: string;
}) {
  const [selectedItem, setSelectedItem] = useState<TimelineItem | null>(null);
  const [filter, setFilter] = useState<"all" | TimelineItem["kind"]>("all");

  const deliveryByActionId = useMemo(
    () =>
      new Map(
        automationDeliveries.map((delivery) => [
          delivery.related_id,
          delivery,
        ]),
      ),
    [automationDeliveries],
  );

  const timeline = useMemo<TimelineItem[]>(() => {
    const smsItems: TimelineItem[] = smsMessages.map((message) => ({
      id: `sms-${message.id}`,
      kind: "sms",
      title: message.direction === "inbound" ? "Incoming text" : "Outgoing text",
      body: message.body || "No message body saved.",
      occurredAt:
        message.delivered_at ||
        message.failed_at ||
        message.sent_at ||
        message.created_at,
      status: message.status || "logged",
      detail:
        message.direction === "inbound"
          ? "Received from client"
          : "Sent by studio",
      source: message,
    }));

    const leadItems: TimelineItem[] = leadActivities.map((activity) => ({
      id: `activity-${activity.id}`,
      kind: "lead_activity",
      title: activityLabel(activity.activity_type),
      body: activity.note,
      occurredAt: activity.created_at,
      status: activity.completed_at
        ? "completed"
        : activity.follow_up_due_at
          ? "open"
          : "logged",
      detail: `By ${getAuthorName(activity.profiles)}`,
      source: activity,
    }));

    const noteItems: TimelineItem[] = clientNotes.map((note) => ({
      id: `note-${note.id}`,
      kind: "note",
      title: noteTypeLabel(note.note_type),
      body: note.body,
      occurredAt: note.occurred_at,
      status: "internal",
      detail: `By ${getAuthorName(note.profiles)}`,
      source: note,
    }));

    const automationItems: TimelineItem[] = automationActions.map((action) => {
      const delivery = deliveryByActionId.get(action.id);

      return {
        id: `automation-${action.id}`,
        kind: "automation",
        title: action.title,
        body: action.body || automationRuleLabel(action.rule_key),
        occurredAt: action.created_at,
        status: delivery?.status || action.status,
        detail: delivery?.subject
          ? `Email: ${delivery.subject}`
          : automationRuleLabel(action.rule_key),
        source: action,
      };
    });

    return [...smsItems, ...leadItems, ...noteItems, ...automationItems].sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
  }, [
    smsMessages,
    leadActivities,
    clientNotes,
    automationActions,
    deliveryByActionId,
  ]);

  const visibleTimeline =
    filter === "all"
      ? timeline
      : timeline.filter((item) => item.kind === filter);

  const openFollowUps = leadActivities.filter(
    (activity) => activity.follow_up_due_at && !activity.completed_at,
  ).length;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-violet-200/80 bg-white shadow-[0_18px_45px_rgba(76,29,149,0.09)]">
        <div className="bg-[linear-gradient(135deg,#111827_0%,#4c1d95_58%,#f97316_150%)] px-6 py-6 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
            Relationship communication
          </p>
          <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-2xl font-semibold">
                Communication with {clientName}
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-white/80">
                Review outreach, internal context, follow-ups, texts, and ARIA
                activity without moving between separate pages.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs font-semibold">
              <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5">
                {timeline.length} timeline items
              </span>
              <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5">
                {openFollowUps} open follow-ups
              </span>
            </div>
          </div>
        </div>

        <div className="grid gap-3 bg-[linear-gradient(135deg,#fff7ed_0%,#faf5ff_60%,#ffffff_100%)] p-5 sm:grid-cols-4">
          {[
            { label: "Texts", value: smsMessages.length },
            { label: "Outreach", value: leadActivities.length },
            { label: "Internal notes", value: clientNotes.length },
            { label: "ARIA actions", value: automationActions.length },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm"
            >
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                {item.label}
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {item.value}
              </p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-6">
          <LeadActivityForm clientId={clientId} returnTo={returnTo} />

          <ClientSmsConsentCard
            clientId={clientId}
            phone={phone}
            permission={smsPermission}
            canManage={canManage}
            message={smsConsentMessage}
            error={smsConsentError}
          />
        </div>

        <div className="space-y-6">
          <ClientSendSmsCard
            clientId={clientId}
            phone={phone}
            permission={smsPermission}
            canManage={canManage}
          />

          <section className="rounded-[28px] border border-violet-200/80 bg-white p-5 shadow-[0_18px_45px_rgba(76,29,149,0.08)]">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
                  Unified timeline
                </p>
                <h3 className="mt-2 text-xl font-semibold text-slate-950">
                  Communication and relationship history
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Select an item to review details without leaving the client
                  workspace.
                </p>
              </div>
              <Link
                href={`/app/clients/${clientId}?tab=notes`}
                className="rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50"
              >
                Internal notes
              </Link>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {[
                { id: "all", label: "All" },
                { id: "sms", label: "Texts" },
                { id: "lead_activity", label: "Outreach" },
                { id: "note", label: "Notes" },
                { id: "automation", label: "ARIA" },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    setFilter(item.id as "all" | TimelineItem["kind"])
                  }
                  className={`rounded-full px-3 py-2 text-xs font-semibold ${
                    filter === item.id
                      ? "bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] text-white shadow-sm"
                      : "border border-violet-100 bg-white text-slate-700 hover:bg-violet-50"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="mt-5 space-y-3">
              {visibleTimeline.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-violet-200 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-6 text-sm text-slate-600">
                  No communication items match this view yet.
                </div>
              ) : (
                visibleTimeline.map((item) => {
                  const Icon = timelineIcon(item.kind);

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedItem(item)}
                      className="block w-full rounded-2xl border border-violet-100 bg-[linear-gradient(135deg,#ffffff_0%,#faf5ff_55%,#fff7ed_100%)] p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md"
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={`rounded-xl border p-2 ${timelineTone(
                            item.kind,
                          )}`}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="font-semibold text-slate-950">
                                {item.title}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {formatDateTime(item.occurredAt, studioTimeZone)}
                              </p>
                            </div>
                            {item.status ? (
                              <span className="rounded-full border border-violet-100 bg-white px-2.5 py-1 text-xs font-semibold text-violet-800">
                                {item.status.replaceAll("_", " ")}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-700">
                            {item.body}
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>

      <ResponsiveDetailPanel
        open={Boolean(selectedItem)}
        title={selectedItem?.title ?? "Communication details"}
        description={
          selectedItem
            ? formatDateTime(selectedItem.occurredAt, studioTimeZone)
            : undefined
        }
        onClose={() => setSelectedItem(null)}
        footer={
          selectedItem ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                className="rounded-xl border border-violet-200 bg-white px-4 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-50"
              >
                Keep reviewing
              </button>
              <Link
                href={`/app/clients/${clientId}?tab=notes`}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
              >
                Open notes
                <NotebookPen className="h-4 w-4" />
              </Link>
            </div>
          ) : null
        }
      >
        {selectedItem ? (
          <div className="space-y-4 p-5">
            <section className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <span
                  className={`rounded-xl border p-2 ${timelineTone(
                    selectedItem.kind,
                  )}`}
                >
                  {(() => {
                    const Icon = timelineIcon(selectedItem.kind);
                    return <Icon className="h-4 w-4" />;
                  })()}
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    {selectedItem.kind.replaceAll("_", " ")}
                  </p>
                  <p className="mt-2 text-sm font-medium text-slate-900">
                    {selectedItem.detail}
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#faf5ff_100%)] p-4">
              <p className="whitespace-pre-wrap text-sm leading-7 text-slate-800">
                {selectedItem.body}
              </p>
            </section>

            {selectedItem.kind === "lead_activity" ? (
              <LeadActivityDetail
                item={selectedItem.source as LeadActivityRow}
                clientId={clientId}
                returnTo={returnTo}
                studioTimeZone={studioTimeZone}
              />
            ) : null}

            {selectedItem.kind === "automation" ? (
              <AutomationDetail
                action={selectedItem.source as AutomationActionRow}
                delivery={deliveryByActionId.get(
                  (selectedItem.source as AutomationActionRow).id,
                )}
                studioTimeZone={studioTimeZone}
              />
            ) : null}

            <section className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4">
              <div className="flex items-start gap-3">
                <Sparkles className="mt-0.5 h-4 w-4 text-sky-700" />
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
                    ARIA context
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-700">
                    Review this item alongside the full relationship timeline
                    before choosing the next contact or follow-up action.
                  </p>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </ResponsiveDetailPanel>
    </div>
  );
}

function LeadActivityDetail({
  item,
  clientId,
  returnTo,
  studioTimeZone,
}: {
  item: LeadActivityRow;
  clientId: string;
  returnTo: string;
  studioTimeZone: string;
}) {
  return (
    <section className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
      <div className="flex items-start gap-3">
        {item.completed_at ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />
        ) : (
          <CalendarClock className="mt-0.5 h-4 w-4 text-emerald-700" />
        )}
        <div className="flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
            Follow-up status
          </p>
          <p className="mt-2 text-sm text-slate-800">
            {item.follow_up_due_at
              ? `Due ${formatDateTime(item.follow_up_due_at, studioTimeZone)}`
              : "No follow-up date was set."}
          </p>
          {item.completed_at ? (
            <p className="mt-1 text-sm text-slate-700">
              Completed {formatDateTime(item.completed_at, studioTimeZone)}
            </p>
          ) : item.follow_up_due_at ? (
            <form action={completeLeadFollowUpAction} className="mt-3">
              <input type="hidden" name="activityId" value={item.id} />
              <input type="hidden" name="clientId" value={clientId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <button
                type="submit"
                className="rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
              >
                Mark follow-up complete
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AutomationDetail({
  action,
  delivery,
  studioTimeZone,
}: {
  action: AutomationActionRow;
  delivery?: AutomationDeliveryRow;
  studioTimeZone: string;
}) {
  return (
    <section className="rounded-2xl border border-violet-100 bg-violet-50/70 p-4">
      <div className="flex items-start gap-3">
        <Mail className="mt-0.5 h-4 w-4 text-violet-700" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
            Automation and delivery
          </p>
          <p className="mt-2 text-sm text-slate-800">
            Action status: {action.status.replaceAll("_", " ")}
          </p>
          {delivery ? (
            <>
              <p className="mt-1 text-sm text-slate-700">
                Delivery status: {delivery.status.replaceAll("_", " ")}
              </p>
              {delivery.subject ? (
                <p className="mt-1 text-sm text-slate-700">
                  Subject: {delivery.subject}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-slate-500">
                {formatDateTime(
                  delivery.sent_at || delivery.created_at,
                  studioTimeZone,
                )}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-slate-700">
              No outbound delivery is attached to this action.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
