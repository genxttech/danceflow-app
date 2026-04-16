import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { archiveLeadAction, convertLeadToActiveAction } from "./actions";

type SearchParamValue = string | string[] | undefined;

type SearchParams = Promise<{
  q?: SearchParamValue;
  tab?: SearchParamValue;
  source?: SearchParamValue;
  success?: SearchParamValue;
  error?: SearchParamValue;
}>;

type LeadRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  dance_interests: string | null;
  referral_source: string | null;
  created_at: string;
};

type FollowUpClient =
  | {
      first_name: string;
      last_name: string;
      referral_source?: string | null;
    }
  | {
      first_name: string;
      last_name: string;
      referral_source?: string | null;
    }[]
  | null;

type FollowUpRow = {
  id: string;
  client_id: string;
  activity_type: string;
  note: string;
  follow_up_due_at: string | null;
  completed_at: string | null;
  clients: FollowUpClient;
};

function readSearchParam(value: SearchParamValue, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return typeof value === "string" ? value : fallback;
}

function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function endOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

function formatDateTime(value: string | null) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatShortDate(value: string | null) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function getClientRecord(value: FollowUpClient) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function getClientName(value: FollowUpClient) {
  const client = getClientRecord(value);
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getClientSource(value: FollowUpClient) {
  const client = getClientRecord(value);
  return client?.referral_source ?? null;
}

function prettifySource(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function sourceLabel(source: string | null) {
  switch (source) {
    case "public_intro_booking":
      return "Public Intro";
    case "event_registration":
      return "Event Registration";
    case "public_directory_inquiry":
      return "Public Directory";
    case "public_directory":
      return "Public Directory";
    case "website_form":
      return "Website";
    case "manual":
      return "Manual";
    case "import":
      return "Import";
    case "referral":
      return "Referral";
    case null:
      return "Manual";
    default:
      return prettifySource(source);
  }
}

function sourceBadgeClass(source: string | null) {
  switch (source) {
    case "public_intro_booking":
      return "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200";
    case "event_registration":
      return "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200";
    case "public_directory_inquiry":
    case "public_directory":
      return "bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200";
    case "website_form":
      return "bg-cyan-50 text-cyan-700 ring-1 ring-inset ring-cyan-200";
    case "manual":
    case null:
      return "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200";
    default:
      return "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200";
  }
}

function statusBadgeClass(status: string) {
  switch (status) {
    case "lead":
      return "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200";
    case "active":
      return "bg-green-50 text-green-700 ring-1 ring-inset ring-green-200";
    case "archived":
      return "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200";
    default:
      return "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200";
  }
}

function activityLabel(value: string) {
  switch (value) {
    case "follow_up":
      return "Follow Up";
    case "call":
      return "Call";
    case "text":
      return "Text";
    case "email":
      return "Email";
    case "consultation":
      return "Consultation";
    default:
      return "Note";
  }
}

function sourceFilterMatches(sourceFilter: string, referralSource: string | null) {
  if (sourceFilter === "all") return true;
  if (sourceFilter === "public_intro") return referralSource === "public_intro_booking";
  if (sourceFilter === "event_registration") return referralSource === "event_registration";
  if (sourceFilter === "public_directory") {
    return referralSource === "public_directory" || referralSource === "public_directory_inquiry";
  }
  if (sourceFilter === "manual") {
    return !referralSource || referralSource === "manual";
  }
  if (sourceFilter === "other") {
    return ![
      null,
      "manual",
      "public_intro_booking",
      "event_registration",
      "public_directory",
      "public_directory_inquiry",
    ].includes(referralSource);
  }

  return true;
}

function leadSearchMatches(lead: LeadRow, q: string) {
  if (!q) return true;

  const haystack = [
    lead.first_name,
    lead.last_name,
    lead.email ?? "",
    lead.phone ?? "",
    lead.dance_interests ?? "",
    lead.referral_source ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(q);
}

function followUpSearchMatches(item: FollowUpRow, q: string) {
  if (!q) return true;

  const source = getClientSource(item.clients) ?? "";
  const haystack = `${getClientName(item.clients)} ${item.note} ${item.activity_type} ${source}`.toLowerCase();

  return haystack.includes(q);
}

function buildReturnTo(q: string, tab: string, source: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tab && tab !== "priority") params.set("tab", tab);
  if (source && source !== "all") params.set("source", source);
  const query = params.toString();
  return query ? `/app/leads?${query}` : "/app/leads";
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "lead_converted") {
    return {
      kind: "success" as const,
      message: "Lead converted to active client.",
    };
  }

  if (search.success === "lead_archived") {
    return {
      kind: "success" as const,
      message: "Lead archived.",
    };
  }

  if (search.success === "lead_activity_created") {
    return {
      kind: "success" as const,
      message: "Lead activity created.",
    };
  }

  if (search.success === "followup_completed") {
    return {
      kind: "success" as const,
      message: "Follow-up marked complete.",
    };
  }

  if (search.error === "lead_update_failed") {
    return {
      kind: "error" as const,
      message: "Could not update lead.",
    };
  }

  if (search.error === "followup_complete_failed") {
    return {
      kind: "error" as const,
      message: "Could not complete follow-up.",
    };
  }

  return null;
}

function getLeadPriority(lead: LeadRow) {
  if (lead.referral_source === "public_intro_booking") return 1;
  if (lead.referral_source === "event_registration") return 2;
  if (
    lead.referral_source === "public_directory" ||
    lead.referral_source === "public_directory_inquiry"
  ) {
    return 3;
  }
  if (!lead.referral_source || lead.referral_source === "manual") return 4;
  return 5;
}

function getRecommendedActionLabel(lead: LeadRow) {
  if (lead.referral_source === "public_intro_booking") return "Book intro";
  if (lead.referral_source === "event_registration") return "Convert after attendance";
  if (
    lead.referral_source === "public_directory" ||
    lead.referral_source === "public_directory_inquiry"
  ) {
    return "Call or text back";
  }
  return "Open lead";
}

function getRecommendedActionHref(lead: LeadRow) {
  if (lead.referral_source === "public_intro_booking") {
    return `/app/schedule/new?clientId=${lead.id}`;
  }

  return `/app/clients/${lead.id}`;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;

  const rawQ = readSearchParam(params.q, "");
  const rawSource = readSearchParam(params.source, "all");
  const rawTab = readSearchParam(params.tab, "priority");
  const rawSuccess = readSearchParam(params.success, "");
  const rawError = readSearchParam(params.error, "");

  const q = rawQ.trim().toLowerCase();
  const source = rawSource || "all";
  const tab = rawTab || "priority";
  const banner = getBanner({ success: rawSuccess, error: rawError });
  const returnTo = buildReturnTo(rawQ, tab, source);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const todayStart = startOfTodayLocal().toISOString();
  const todayEnd = endOfTodayLocal().toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: leads, error: leadsError },
    { data: overdueFollowUps, error: overdueError },
    { data: dueTodayFollowUps, error: dueTodayError },
    { data: completedFollowUps, error: completedError },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select(
        `
          id,
          first_name,
          last_name,
          email,
          phone,
          status,
          dance_interests,
          referral_source,
          created_at
        `
      )
      .eq("studio_id", studioId)
      .eq("status", "lead")
      .order("created_at", { ascending: false }),

    supabase
      .from("lead_activities")
      .select(
        `
          id,
          client_id,
          activity_type,
          note,
          follow_up_due_at,
          completed_at,
          clients (
            first_name,
            last_name,
            referral_source
          )
        `
      )
      .eq("studio_id", studioId)
      .not("follow_up_due_at", "is", null)
      .is("completed_at", null)
      .lt("follow_up_due_at", todayStart)
      .order("follow_up_due_at", { ascending: true })
      .limit(50),

    supabase
      .from("lead_activities")
      .select(
        `
          id,
          client_id,
          activity_type,
          note,
          follow_up_due_at,
          completed_at,
          clients (
            first_name,
            last_name,
            referral_source
          )
        `
      )
      .eq("studio_id", studioId)
      .not("follow_up_due_at", "is", null)
      .is("completed_at", null)
      .gte("follow_up_due_at", todayStart)
      .lt("follow_up_due_at", todayEnd)
      .order("follow_up_due_at", { ascending: true })
      .limit(50),

    supabase
      .from("lead_activities")
      .select(
        `
          id,
          client_id,
          activity_type,
          note,
          follow_up_due_at,
          completed_at,
          clients (
            first_name,
            last_name,
            referral_source
          )
        `
      )
      .eq("studio_id", studioId)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(50),
  ]);

  if (leadsError) {
    throw new Error(`Failed to load leads: ${leadsError.message}`);
  }

  if (overdueError) {
    throw new Error(`Failed to load overdue follow-ups: ${overdueError.message}`);
  }

  if (dueTodayError) {
    throw new Error(`Failed to load today follow-ups: ${dueTodayError.message}`);
  }

  if (completedError) {
    throw new Error(`Failed to load completed follow-ups: ${completedError.message}`);
  }

  const allLeads = ((leads ?? []) as LeadRow[]).filter(
    (lead) => sourceFilterMatches(source, lead.referral_source) && leadSearchMatches(lead, q)
  );

  const filteredOverdue = ((overdueFollowUps ?? []) as FollowUpRow[]).filter((item) => {
    return (
      sourceFilterMatches(source, getClientSource(item.clients)) && followUpSearchMatches(item, q)
    );
  });

  const filteredDueToday = ((dueTodayFollowUps ?? []) as FollowUpRow[]).filter((item) => {
    return (
      sourceFilterMatches(source, getClientSource(item.clients)) && followUpSearchMatches(item, q)
    );
  });

  const filteredCompleted = ((completedFollowUps ?? []) as FollowUpRow[]).filter((item) => {
    return (
      sourceFilterMatches(source, getClientSource(item.clients)) && followUpSearchMatches(item, q)
    );
  });

  const publicIntroLeads = allLeads.filter(
    (lead) => lead.referral_source === "public_intro_booking"
  );
  const eventRegistrationLeads = allLeads.filter(
    (lead) => lead.referral_source === "event_registration"
  );
  const publicDirectoryLeads = allLeads.filter(
    (lead) =>
      lead.referral_source === "public_directory" ||
      lead.referral_source === "public_directory_inquiry"
  );
  const manualLeads = allLeads.filter(
    (lead) => !lead.referral_source || lead.referral_source === "manual"
  );
  const newLast7DaysCount = allLeads.filter((lead) => lead.created_at >= sevenDaysAgo).length;

  const sortedLeadQueue = [...allLeads].sort((a, b) => {
    const priorityDiff = getLeadPriority(a) - getLeadPriority(b);
    if (priorityDiff !== 0) return priorityDiff;

    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const priorityLeads = sortedLeadQueue.slice(0, 8);

  const activeFollowUpList =
    tab === "overdue"
      ? filteredOverdue
      : tab === "today"
        ? filteredDueToday
        : tab === "completed"
          ? filteredCompleted
          : [...filteredOverdue, ...filteredDueToday];

  const baseFilterHref = (nextTab: string) => {
    const search = new URLSearchParams();
    if (nextTab !== "priority") search.set("tab", nextTab);
    if (source !== "all") search.set("source", source);
    if (rawQ.trim()) search.set("q", rawQ.trim());
    const query = search.toString();
    return query ? `/app/leads?${query}` : "/app/leads";
  };

  const sourceHref = (nextSource: string) => {
    const search = new URLSearchParams();
    if (tab !== "priority") search.set("tab", tab);
    if (nextSource !== "all") search.set("source", nextSource);
    if (rawQ.trim()) search.set("q", rawQ.trim());
    const query = search.toString();
    return query ? `/app/leads?${query}` : "/app/leads";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Leads</h1>
          <p className="mt-1 text-sm text-slate-600">
            Front-desk lead queue prioritized by source, follow-up urgency, and fastest next step.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            href="/app/clients/new"
            className="inline-flex items-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Add lead
          </Link>
          <Link
            href="/app/activity/new"
            className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Add follow-up
          </Link>
        </div>
      </div>

      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-2xl border bg-white p-4">
          <p className="text-sm text-slate-500">Overdue follow-ups</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{filteredOverdue.length}</p>
          <p className="mt-2 text-xs text-slate-500">Top front-desk priority</p>
        </div>

        <div className="rounded-2xl border bg-white p-4">
          <p className="text-sm text-slate-500">Due today</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{filteredDueToday.length}</p>
          <p className="mt-2 text-xs text-slate-500">Same-day callbacks and touchpoints</p>
        </div>

        <div className="rounded-2xl border bg-white p-4">
          <p className="text-sm text-slate-500">Public intro leads</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{publicIntroLeads.length}</p>
          <p className="mt-2 text-xs text-slate-500">Highest conversion intent</p>
        </div>

        <div className="rounded-2xl border bg-white p-4">
          <p className="text-sm text-slate-500">Event registration leads</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">
            {eventRegistrationLeads.length}
          </p>
          <p className="mt-2 text-xs text-slate-500">Nurture after attendance</p>
        </div>

        <div className="rounded-2xl border bg-white p-4">
          <p className="text-sm text-slate-500">New in last 7 days</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{newLast7DaysCount}</p>
          <p className="mt-2 text-xs text-slate-500">Recent inbound volume</p>
        </div>
      </div>

      <form className="rounded-2xl border bg-white p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-1 flex-col gap-3 lg:flex-row lg:items-center">
            <input
              type="text"
              name="q"
              defaultValue={rawQ}
              placeholder="Search name, contact, note, interests, or source"
              className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none ring-0 placeholder:text-slate-400 focus:border-slate-400 lg:max-w-md"
            />

            <input type="hidden" name="tab" value={tab} />

            <select
              name="source"
              defaultValue={source}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-slate-400"
            >
              <option value="all">All sources</option>
              <option value="public_intro">Public Intro</option>
              <option value="event_registration">Event Registration</option>
              <option value="public_directory">Public Directory</option>
              <option value="manual">Manual</option>
              <option value="other">Other</option>
            </select>

            <button
              type="submit"
              className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              Apply
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              { value: "all", label: "All", count: allLeads.length },
              { value: "public_intro", label: "Public Intro", count: publicIntroLeads.length },
              {
                value: "event_registration",
                label: "Event Registration",
                count: eventRegistrationLeads.length,
              },
              {
                value: "public_directory",
                label: "Public Directory",
                count: publicDirectoryLeads.length,
              },
              { value: "manual", label: "Manual", count: manualLeads.length },
            ].map((item) => {
              const isActive = source === item.value;

              return (
                <Link
                  key={item.value}
                  href={sourceHref(item.value)}
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-medium ${
                    isActive
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <span>{item.label}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 ${
                      isActive ? "bg-white/15 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {item.count}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </form>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Front-desk priority queue</h2>
              <p className="mt-1 text-sm text-slate-500">
                Public intro leads first, then event and directory leads, with newest items on top.
              </p>
            </div>
            <p className="text-sm text-slate-500">{priorityLeads.length} shown</p>
          </div>

          <div className="mt-5 space-y-3">
            {priorityLeads.length === 0 ? (
              <div className="rounded-2xl border border-dashed p-6 text-sm text-slate-500">
                No leads match the current filters.
              </div>
            ) : (
              priorityLeads.map((lead) => (
                <div
                  key={lead.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-slate-300 hover:bg-slate-100"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/app/clients/${lead.id}`}
                          className="text-base font-semibold text-slate-900 hover:underline"
                        >
                          {lead.first_name} {lead.last_name}
                        </Link>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sourceBadgeClass(
                            lead.referral_source
                          )}`}
                        >
                          {sourceLabel(lead.referral_source)}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            lead.status
                          )}`}
                        >
                          {lead.status}
                        </span>
                      </div>

                      <div className="mt-2 grid gap-1 text-sm text-slate-600">
                        <p>{lead.email ?? "No email"}</p>
                        <p>{lead.phone ?? "No phone"}</p>
                        <p>Created {formatDateTime(lead.created_at)}</p>
                        <p>Interest: {lead.dance_interests ?? "—"}</p>
                      </div>

                      <div className="mt-3">
                        <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
                          Recommended: {getRecommendedActionLabel(lead)}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 lg:justify-end">
                      <Link
                        href={getRecommendedActionHref(lead)}
                        className="inline-flex items-center rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                      >
                        {getRecommendedActionLabel(lead)}
                      </Link>

                      <Link
                        href={`/app/clients/${lead.id}`}
                        className="inline-flex items-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        View lead
                      </Link>

                      <form action={convertLeadToActiveAction}>
                        <input type="hidden" name="clientId" value={lead.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <button
                          type="submit"
                          className="inline-flex items-center rounded-xl border border-green-300 bg-white px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-50"
                        >
                          Convert active
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Follow-up queue</h2>
              <p className="mt-1 text-sm text-slate-500">
                Keep overdue and due-today actions visible for the front desk.
              </p>
            </div>
            <p className="text-sm text-slate-500">{activeFollowUpList.length} items</p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {[
              { value: "priority", label: "Priority" },
              { value: "overdue", label: "Overdue" },
              { value: "today", label: "Today" },
              { value: "completed", label: "Completed" },
            ].map((item) => {
              const isActive = tab === item.value;

              return (
                <Link
                  key={item.value}
                  href={baseFilterHref(item.value)}
                  className={`rounded-full px-3 py-2 text-sm font-medium ${
                    isActive
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>

          <div className="mt-5 space-y-3">
            {activeFollowUpList.length === 0 ? (
              <div className="rounded-2xl border border-dashed p-6 text-sm text-slate-500">
                No follow-ups in this view.
              </div>
            ) : (
              activeFollowUpList.map((item) => {
                const clientSource = getClientSource(item.clients);

                return (
                  <Link
                    key={item.id}
                    href={`/app/clients/${item.client_id}`}
                    className="block rounded-2xl border border-slate-200 bg-slate-50 p-4 hover:border-slate-300 hover:bg-slate-100"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-slate-900">{getClientName(item.clients)}</p>

                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sourceBadgeClass(
                              clientSource
                            )}`}
                          >
                            {sourceLabel(clientSource)}
                          </span>
                        </div>

                        <p className="mt-1 text-sm text-slate-600">
                          {activityLabel(item.activity_type)}
                        </p>

                        <p className="mt-1 text-sm text-slate-600">{item.note || "No note"}</p>

                        <p className="mt-2 text-sm text-slate-500">
                          {tab === "completed"
                            ? `Completed ${formatDateTime(item.completed_at)}`
                            : `Due ${formatDateTime(item.follow_up_due_at)}`}
                        </p>
                      </div>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                          tab === "completed"
                            ? "bg-green-50 text-green-700 ring-1 ring-inset ring-green-200"
                            : tab === "today"
                              ? "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200"
                              : "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200"
                        }`}
                      >
                        {tab === "completed" ? "Completed" : tab === "today" ? "Today" : "Overdue"}
                      </span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Open leads queue</h2>
            <p className="mt-1 text-sm text-slate-500">
              Same source labeling throughout the queue, with clear next actions for conversion.
            </p>
          </div>
          <p className="text-sm text-slate-500">{sortedLeadQueue.length} leads</p>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Lead</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Contact</th>
                  <th className="px-4 py-3 font-medium">Interest</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Next action</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white">
                {sortedLeadQueue.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      No leads match your filters.
                    </td>
                  </tr>
                ) : (
                  sortedLeadQueue.map((lead) => (
                    <tr key={lead.id} className="border-t border-slate-200 align-top">
                      <td className="px-4 py-4">
                        <div className="flex flex-col gap-1">
                          <Link
                            href={`/app/clients/${lead.id}`}
                            className="font-medium text-slate-900 hover:underline"
                          >
                            {lead.first_name} {lead.last_name}
                          </Link>

                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                                lead.status
                              )}`}
                            >
                              {lead.status}
                            </span>
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-4">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sourceBadgeClass(
                            lead.referral_source
                          )}`}
                        >
                          {sourceLabel(lead.referral_source)}
                        </span>
                      </td>

                      <td className="px-4 py-4 text-slate-600">
                        <div className="space-y-1">
                          <div>{lead.email ?? "—"}</div>
                          <div>{lead.phone ?? "—"}</div>
                        </div>
                      </td>

                      <td className="px-4 py-4 text-slate-600">
                        {lead.dance_interests ?? "—"}
                      </td>

                      <td className="px-4 py-4 text-slate-600">
                        <div>{formatShortDate(lead.created_at)}</div>
                        <div className="text-xs text-slate-400">{formatDateTime(lead.created_at)}</div>
                      </td>

                      <td className="px-4 py-4">
                        <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                          {getRecommendedActionLabel(lead)}
                        </span>
                      </td>

                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-3">
                          <Link
                            href={getRecommendedActionHref(lead)}
                            className="font-medium text-slate-900 underline"
                          >
                            {getRecommendedActionLabel(lead)}
                          </Link>

                          <Link
                            href={`/app/clients/${lead.id}/edit`}
                            className="text-slate-700 underline"
                          >
                            Edit
                          </Link>

                          <form action={convertLeadToActiveAction}>
                            <input type="hidden" name="clientId" value={lead.id} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <button type="submit" className="text-green-700 underline">
                              Convert active
                            </button>
                          </form>

                          <form action={archiveLeadAction}>
                            <input type="hidden" name="clientId" value={lead.id} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <button type="submit" className="text-red-600 underline">
                              Archive
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Public Intro</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{publicIntroLeads.length}</p>
          </div>

          <div className="rounded-2xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Event Registration</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {eventRegistrationLeads.length}
            </p>
          </div>

          <div className="rounded-2xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Public Directory</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {publicDirectoryLeads.length}
            </p>
          </div>

          <div className="rounded-2xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Manual / Other</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {manualLeads.length}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}