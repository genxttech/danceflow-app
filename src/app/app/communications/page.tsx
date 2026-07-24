import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Mail,
  MessageSquareText,
  Radio,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canViewCommunications } from "@/lib/auth/permissions";
import CompactSummaryStrip from "@/components/app/workspace/CompactSummaryStrip";
import WorkspaceHeader from "@/components/app/workspace/WorkspaceHeader";

type SearchParams = Promise<{ view?: string }>;

type CommunicationsView =
  | "conversations"
  | "follow-ups"
  | "broadcasts"
  | "delivery";

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
};

type LeadActivityRow = {
  id: string;
  client_id: string;
  activity_type: string;
  note: string;
  created_at: string;
  follow_up_due_at: string | null;
  completed_at: string | null;
};

type SmsMessageRow = {
  id: string;
  client_id: string | null;
  direction: string;
  body: string | null;
  status: string;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
};

type SmsPermissionRow = {
  client_id: string | null;
  consent_status: string;
  updated_at: string;
};

type CampaignRow = {
  id: string;
  name: string;
  subject: string;
  status: string;
  created_at: string;
  sent_at: string | null;
};

type DeliveryRow = {
  id: string;
  recipient_email: string | null;
  subject: string | null;
  status: string;
  error_message: string | null;
  template_key: string | null;
  created_at: string;
  sent_at: string | null;
};

const views: Array<{
  id: CommunicationsView;
  label: string;
  description: string;
}> = [
  {
    id: "conversations",
    label: "Conversations",
    description: "Recent relationship communication by client",
  },
  {
    id: "follow-ups",
    label: "Follow-ups",
    description: "Overdue, due today, and upcoming outreach",
  },
  {
    id: "broadcasts",
    label: "Broadcasts",
    description: "Campaign drafts, schedules, and delivery",
  },
  {
    id: "delivery",
    label: "Delivery",
    description: "Failed and recent outbound messages",
  },
];

function resolveView(value: string | undefined): CommunicationsView {
  return views.some((item) => item.id === value)
    ? (value as CommunicationsView)
    : "conversations";
}

function formatDateTime(value: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function clientName(client: ClientRow | undefined) {
  if (!client) return "Unknown client";
  return `${client.first_name} ${client.last_name}`.trim() || "Unnamed client";
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (["delivered", "sent", "completed"].includes(normalized)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (["failed", "error"].includes(normalized)) {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  if (["queued", "scheduled", "open"].includes(normalized)) {
    return "border-sky-200 bg-sky-50 text-sky-800";
  }
  return "border-violet-200 bg-violet-50 text-violet-800";
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[28px] border border-dashed border-violet-200 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-8 text-center">
      <p className="text-base font-semibold text-slate-950">{title}</p>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const activeView = resolveView(params.view);
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const role = context.studioRole ?? "";

  if (!canViewCommunications(role)) {
    redirect("/app");
  }

  const studioId = context.studioId;
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const [
    clientsResult,
    activitiesResult,
    smsResult,
    consentResult,
    campaignsResult,
    deliveriesResult,
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone, status")
      .eq("studio_id", studioId)
      .in("status", ["lead", "active", "inactive"])
      .limit(1000),
    supabase
      .from("lead_activities")
      .select(
        "id, client_id, activity_type, note, created_at, follow_up_due_at, completed_at",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("sms_message_logs")
      .select(
        "id, client_id, direction, body, status, created_at, sent_at, delivered_at, failed_at",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(250),
    supabase
      .from("sms_contact_permissions")
      .select("client_id, consent_status, updated_at")
      .eq("studio_id", studioId)
      .order("updated_at", { ascending: false })
      .limit(1000),
    supabase
      .from("marketing_campaigns")
      .select("id, name, subject, status, created_at, sent_at")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("outbound_deliveries")
      .select(
        "id, recipient_email, subject, status, error_message, template_key, created_at, sent_at",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(150),
  ]);

  if (clientsResult.error) {
    throw new Error(`Failed to load communication clients: ${clientsResult.error.message}`);
  }
  if (activitiesResult.error) {
    throw new Error(`Failed to load follow-ups: ${activitiesResult.error.message}`);
  }
  if (smsResult.error) {
    throw new Error(`Failed to load SMS activity: ${smsResult.error.message}`);
  }
  if (consentResult.error) {
    throw new Error(`Failed to load SMS consent: ${consentResult.error.message}`);
  }
  if (campaignsResult.error) {
    throw new Error(`Failed to load broadcasts: ${campaignsResult.error.message}`);
  }
  if (deliveriesResult.error) {
    throw new Error(`Failed to load outbound delivery: ${deliveriesResult.error.message}`);
  }

  const clients = (clientsResult.data ?? []) as ClientRow[];
  const activities = (activitiesResult.data ?? []) as LeadActivityRow[];
  const smsMessages = (smsResult.data ?? []) as SmsMessageRow[];
  const consents = (consentResult.data ?? []) as SmsPermissionRow[];
  const campaigns = (campaignsResult.data ?? []) as CampaignRow[];
  const deliveries = (deliveriesResult.data ?? []) as DeliveryRow[];

  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const latestConsentByClientId = new Map<string, SmsPermissionRow>();
  for (const consent of consents) {
    if (consent.client_id && !latestConsentByClientId.has(consent.client_id)) {
      latestConsentByClientId.set(consent.client_id, consent);
    }
  }

  const openFollowUps = activities.filter(
    (activity) => activity.follow_up_due_at && !activity.completed_at,
  );
  const overdueFollowUps = openFollowUps.filter(
    (activity) => new Date(activity.follow_up_due_at as string) < startOfToday,
  );
  const dueTodayFollowUps = openFollowUps.filter((activity) => {
    const dueAt = new Date(activity.follow_up_due_at as string);
    return dueAt >= startOfToday && dueAt < endOfToday;
  });
  const failedSms = smsMessages.filter((message) => message.status === "failed");
  const failedDeliveries = deliveries.filter(
    (delivery) => delivery.status === "failed",
  );
  const failedDeliveryCount = failedSms.length + failedDeliveries.length;
  const activeCampaigns = campaigns.filter((campaign) =>
    ["draft", "scheduled", "queued"].includes(campaign.status.toLowerCase()),
  ).length;

  const latestActivityByClientId = new Map<
    string,
    { type: "sms" | "activity"; at: string; title: string; body: string; status: string }
  >();

  for (const message of smsMessages) {
    if (!message.client_id || latestActivityByClientId.has(message.client_id)) continue;
    latestActivityByClientId.set(message.client_id, {
      type: "sms",
      at: message.delivered_at || message.failed_at || message.sent_at || message.created_at,
      title: message.direction === "inbound" ? "Incoming text" : "Outgoing text",
      body: message.body || "No message body saved.",
      status: message.status,
    });
  }

  for (const activity of activities) {
    const existing = latestActivityByClientId.get(activity.client_id);
    if (!existing || new Date(activity.created_at) > new Date(existing.at)) {
      latestActivityByClientId.set(activity.client_id, {
        type: "activity",
        at: activity.created_at,
        title: activity.activity_type.replaceAll("_", " "),
        body: activity.note,
        status: activity.completed_at ? "completed" : activity.follow_up_due_at ? "open" : "logged",
      });
    }
  }

  const conversationRows = Array.from(latestActivityByClientId.entries())
    .map(([clientId, latest]) => ({
      clientId,
      client: clientsById.get(clientId),
      latest,
      openFollowUp: openFollowUps.find((item) => item.client_id === clientId) ?? null,
      consent: latestConsentByClientId.get(clientId) ?? null,
    }))
    .sort((a, b) => new Date(b.latest.at).getTime() - new Date(a.latest.at).getTime())
    .slice(0, 50);

  const sortedFollowUps = [...openFollowUps].sort(
    (a, b) =>
      new Date(a.follow_up_due_at as string).getTime() -
      new Date(b.follow_up_due_at as string).getTime(),
  );

  return (
    <main className="space-y-6 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.07),transparent_28%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.08),transparent_26%)]">
      <section className="overflow-hidden rounded-[28px] border border-violet-200/80 bg-white shadow-[0_18px_45px_rgba(76,29,149,0.09)]">
        <WorkspaceHeader
          eyebrow="Relationship operations"
          title="Communications"
          description="Manage client conversations, follow-ups, broadcasts, and delivery health without moving between disconnected tools."
          actions={
            <>
              <Link
                href="/app/marketing/campaigns"
                className="rounded-xl border border-violet-200 bg-white px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50"
              >
                Create broadcast
              </Link>
              <Link
                href="/app/clients"
                className="rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-110"
              >
                Open clients
              </Link>
            </>
          }
        />

        <CompactSummaryStrip
          items={[
            {
              key: "follow-ups",
              label: "Needs follow-up",
              value: openFollowUps.length,
              detail: `${overdueFollowUps.length} overdue`,
              tone: overdueFollowUps.length > 0 ? "danger" : "default",
            },
            {
              key: "today",
              label: "Due today",
              value: dueTodayFollowUps.length,
              detail: "Outreach tasks",
              tone: dueTodayFollowUps.length > 0 ? "warning" : "default",
            },
            {
              key: "failed",
              label: "Failed delivery",
              value: failedDeliveryCount,
              detail: "SMS and email",
              tone: failedDeliveryCount > 0 ? "danger" : "success",
            },
            {
              key: "campaigns",
              label: "Active campaigns",
              value: activeCampaigns,
              detail: "Draft or scheduled",
              tone: activeCampaigns > 0 ? "info" : "default",
            },
            {
              key: "contacts",
              label: "Recent contacts",
              value: conversationRows.length,
              detail: "Loaded relationships",
            },
          ]}
        />
      </section>

      <nav className="flex gap-2 overflow-x-auto rounded-2xl border border-violet-100 bg-white p-2 shadow-sm">
        {views.map((view) => (
          <Link
            key={view.id}
            href={`/app/communications?view=${view.id}`}
            className={`min-w-[150px] shrink-0 rounded-xl px-4 py-3 transition ${
              activeView === view.id
                ? "bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] text-white shadow-sm"
                : "text-slate-700 hover:bg-violet-50"
            }`}
          >
            <span className="block text-sm font-semibold">{view.label}</span>
            <span
              className={`mt-1 block text-xs leading-5 ${
                activeView === view.id ? "text-white/75" : "text-slate-500"
              }`}
            >
              {view.description}
            </span>
          </Link>
        ))}
      </nav>

      {activeView === "conversations" ? (
        <section className="rounded-[28px] border border-violet-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                Relationship queue
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">Recent conversations</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Open the client communication tab to review the complete timeline, consent, and next action.
              </p>
            </div>
            <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-800">
              {conversationRows.length} relationships
            </span>
          </div>

          <div className="mt-5 space-y-3">
            {conversationRows.length === 0 ? (
              <EmptyState
                title="No communication activity yet"
                description="Calls, texts, emails, follow-ups, and ARIA outreach will appear here once they are logged against a client."
                action={
                  <Link href="/app/clients" className="text-sm font-semibold text-violet-800 underline">
                    Open clients
                  </Link>
                }
              />
            ) : (
              conversationRows.map((row) => (
                <Link
                  key={row.clientId}
                  href={`/app/clients/${row.clientId}?tab=marketing`}
                  className="block rounded-2xl border border-violet-100 bg-[linear-gradient(135deg,#ffffff_0%,#faf5ff_60%,#fff7ed_100%)] p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-slate-950">{clientName(row.client)}</p>
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(row.latest.status)}`}>
                          {row.latest.status.replaceAll("_", " ")}
                        </span>
                        <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
                          {row.consent?.consent_status === "opted_in"
                            ? "SMS allowed"
                            : row.consent?.consent_status === "opted_out"
                              ? "SMS opted out"
                              : "SMS consent needed"}
                        </span>
                      </div>
                      <p className="mt-2 text-sm font-medium capitalize text-slate-800">{row.latest.title}</p>
                      <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-600">{row.latest.body}</p>
                      <p className="mt-2 text-xs text-slate-500">{formatDateTime(row.latest.at)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {row.openFollowUp ? (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
                          Follow-up {formatDateTime(row.openFollowUp.follow_up_due_at)}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-2 text-sm font-semibold text-violet-800">
                        Open timeline <ArrowRight className="h-4 w-4" />
                      </span>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </section>
      ) : null}

      {activeView === "follow-ups" ? (
        <section className="rounded-[28px] border border-violet-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex items-start gap-3">
            <span className="rounded-xl bg-orange-50 p-2 text-orange-700 ring-1 ring-orange-200">
              <CalendarClock className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-xl font-semibold text-slate-950">Follow-up queue</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Work overdue tasks first, then today’s commitments and upcoming outreach.
              </p>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            {sortedFollowUps.length === 0 ? (
              <EmptyState title="No open follow-ups" description="All currently scheduled communication follow-ups are complete." />
            ) : (
              sortedFollowUps.map((followUp) => {
                const client = clientsById.get(followUp.client_id);
                const dueAt = new Date(followUp.follow_up_due_at as string);
                const isOverdue = dueAt < startOfToday;
                const isToday = dueAt >= startOfToday && dueAt < endOfToday;
                return (
                  <Link
                    key={followUp.id}
                    href={`/app/clients/${followUp.client_id}?tab=marketing`}
                    className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-violet-200 hover:shadow-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-slate-950">{clientName(client)}</p>
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                          isOverdue
                            ? "border-rose-200 bg-rose-50 text-rose-800"
                            : isToday
                              ? "border-amber-200 bg-amber-50 text-amber-800"
                              : "border-sky-200 bg-sky-50 text-sky-800"
                        }`}>
                          {isOverdue ? "Overdue" : isToday ? "Due today" : "Upcoming"}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-700">{followUp.note}</p>
                      <p className="mt-2 text-xs text-slate-500">Due {formatDateTime(followUp.follow_up_due_at)}</p>
                    </div>
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-violet-800">
                      Review client <ArrowRight className="h-4 w-4" />
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </section>
      ) : null}

      {activeView === "broadcasts" ? (
        <section className="rounded-[28px] border border-violet-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-violet-50 p-2 text-violet-700 ring-1 ring-violet-200">
                <Radio className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-xl font-semibold text-slate-950">Broadcast campaigns</h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Review recent email campaigns here, then open the full workspace to edit, test, schedule, or send.
                </p>
              </div>
            </div>
            <Link href="/app/marketing/campaigns" className="rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-800">
              Open campaign workspace
            </Link>
          </div>
          <div className="mt-5 space-y-3">
            {campaigns.length === 0 ? (
              <EmptyState
                title="No broadcast campaigns yet"
                description="Create a branded studio email for leads, active clients, package renewals, or event audiences."
                action={<Link href="/app/marketing/campaigns" className="text-sm font-semibold text-violet-800 underline">Create the first campaign</Link>}
              />
            ) : (
              campaigns.map((campaign) => (
                <Link
                  key={campaign.id}
                  href={`/app/marketing/campaigns/${campaign.id}`}
                  className="flex flex-col gap-4 rounded-2xl border border-violet-100 bg-white p-4 transition hover:border-violet-200 hover:shadow-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-950">{campaign.name}</p>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(campaign.status)}`}>
                        {campaign.status.replaceAll("_", " ")}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-slate-700">{campaign.subject}</p>
                    <p className="mt-2 text-xs text-slate-500">
                      {campaign.sent_at ? `Sent ${formatDateTime(campaign.sent_at)}` : `Created ${formatDateTime(campaign.created_at)}`}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-violet-800">
                    Review campaign <ArrowRight className="h-4 w-4" />
                  </span>
                </Link>
              ))
            )}
          </div>
        </section>
      ) : null}

      {activeView === "delivery" ? (
        <section className="rounded-[28px] border border-violet-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex items-start gap-3">
            <span className="rounded-xl bg-rose-50 p-2 text-rose-700 ring-1 ring-rose-200">
              <Mail className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-xl font-semibold text-slate-950">Delivery health</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Failed deliveries appear first, followed by the latest email and SMS activity.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">Email delivery</h3>
              {deliveries.length === 0 ? (
                <EmptyState title="No email delivery records" description="Outbound email activity will appear here after messages are queued or sent." />
              ) : (
                [...deliveries]
                  .sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"))
                  .slice(0, 40)
                  .map((delivery) => (
                    <div key={delivery.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(delivery.status)}`}>
                          {delivery.status.replaceAll("_", " ")}
                        </span>
                        <span className="text-xs text-slate-500">{delivery.template_key?.replaceAll("_", " ") || "Email"}</span>
                      </div>
                      <p className="mt-3 font-medium text-slate-950">{delivery.subject || "No subject recorded"}</p>
                      <p className="mt-1 text-sm text-slate-600">{delivery.recipient_email || "No recipient recorded"}</p>
                      {delivery.error_message ? (
                        <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm leading-6 text-rose-800">{delivery.error_message}</p>
                      ) : null}
                      <p className="mt-3 text-xs text-slate-500">{formatDateTime(delivery.sent_at || delivery.created_at)}</p>
                    </div>
                  ))
              )}
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">SMS delivery</h3>
              {smsMessages.length === 0 ? (
                <EmptyState title="No SMS delivery records" description="Individual text activity will appear here after messages are logged." />
              ) : (
                [...smsMessages]
                  .sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"))
                  .slice(0, 40)
                  .map((message) => (
                    <Link
                      key={message.id}
                      href={message.client_id ? `/app/clients/${message.client_id}?tab=marketing` : "/app/clients"}
                      className="block rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-violet-200 hover:shadow-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(message.status)}`}>
                          {message.status.replaceAll("_", " ")}
                        </span>
                        <span className="text-xs capitalize text-slate-500">{message.direction}</span>
                      </div>
                      <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-700">{message.body || "No message body saved."}</p>
                      <p className="mt-3 text-xs text-slate-500">{formatDateTime(message.delivered_at || message.failed_at || message.sent_at || message.created_at)}</p>
                    </Link>
                  ))
              )}
            </div>
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-violet-100 bg-violet-50/70 p-4">
          <Users className="h-5 w-5 text-violet-700" />
          <p className="mt-3 text-sm font-semibold text-slate-950">Client-owned history</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">Full communication remains attached to the relationship record.</p>
        </div>
        <div className="rounded-2xl border border-orange-100 bg-orange-50/70 p-4">
          <MessageSquareText className="h-5 w-5 text-orange-700" />
          <p className="mt-3 text-sm font-semibold text-slate-950">Consent-aware outreach</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">SMS consent remains visible before staff open a conversation.</p>
        </div>
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
          {failedDeliveryCount > 0 ? <AlertTriangle className="h-5 w-5 text-rose-700" /> : <CheckCircle2 className="h-5 w-5 text-emerald-700" />}
          <p className="mt-3 text-sm font-semibold text-slate-950">Delivery visibility</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">Failures are surfaced without mixing them into internal notifications.</p>
        </div>
      </section>
    </main>
  );
}
