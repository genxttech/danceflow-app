import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import LeadsWorkspacePanels from "./LeadsWorkspacePanels";

type SearchParamValue = string | string[] | undefined;

type SearchParams = Promise<{
  q?: SearchParamValue;
  tab?: SearchParamValue;
  source?: SearchParamValue;
  success?: SearchParamValue;
  error?: SearchParamValue;
}>;

export type LeadRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  dance_interests: string | null;
  referral_source: string | null;
  created_at: string;
  is_independent_instructor: boolean | null;
};

type BookingRequestRow = {
  id: string;
  client_id: string | null;
  source: string | null;
  status: string | null;
  requested_starts_at: string | null;
  updated_at: string | null;
  created_at: string | null;
};

export type BookingRequestState = {
  hasPending: boolean;
  hasApproved: boolean;
  pendingRequestId?: string;
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

export type FollowUpRow = {
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
    { data: bookingRequests, error: bookingRequestsError },
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
          created_at,
          is_independent_instructor
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

    supabase
      .from("booking_requests")
      .select("id, client_id, source, status, requested_starts_at, updated_at, created_at")
      .eq("studio_id", studioId)
      .in("status", ["pending", "approved"])
      .order("updated_at", { ascending: false })
      .limit(500),
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

  if (bookingRequestsError) {
    throw new Error(`Failed to load booking requests: ${bookingRequestsError.message}`);
  }

  const bookingRequestStateByClientId = new Map<string, BookingRequestState>();

  ((bookingRequests ?? []) as BookingRequestRow[]).forEach((request) => {
    if (!request.client_id) return;

    const state =
      bookingRequestStateByClientId.get(request.client_id) ?? {
        hasPending: false,
        hasApproved: false,
      };

    if (request.status === "pending") {
      state.hasPending = true;
      state.pendingRequestId = request.id;
    }

    if (request.status === "approved") {
      state.hasApproved = true;
    }

    bookingRequestStateByClientId.set(request.client_id, state);
  });

  const { data: linkedLeadAccounts } = await supabase
    .from("client_account_links")
    .select("client_id")
    .eq("studio_id", studioId)
    .eq("status", "linked");

  const linkedLeadClientIds = new Set(
    (linkedLeadAccounts ?? []).map((row) => String(row.client_id)),
  );

  const allLeads = ((leads ?? []) as LeadRow[]).filter((lead) => {
    const isActivatedIndependentInstructor =
      lead.is_independent_instructor === true && linkedLeadClientIds.has(lead.id);

    return (
      !isActivatedIndependentInstructor &&
      sourceFilterMatches(source, lead.referral_source) &&
      leadSearchMatches(lead, q)
    );
  });

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
    const getQueuePriority = (lead: LeadRow) => {
      const bookingState = bookingRequestStateByClientId.get(lead.id);

      if (bookingState?.hasPending) return 0;
      if (bookingState?.hasApproved && lead.referral_source === "public_intro_booking") return 4;

      return getLeadPriority(lead);
    };

    const priorityDiff = getQueuePriority(a) - getQueuePriority(b);
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
    <div className="min-h-[calc(100vh-4rem)] space-y-6 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.10),transparent_28%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.10),transparent_26%),linear-gradient(180deg,#fff7ed_0%,#ffffff_30%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,#111827_0%,#4c1d95_52%,#f97316_145%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow CRM
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Leads
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Track interested dancers, follow-up status, and next steps so prospects do not slip through the cracks.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/app/clients/new"
                className="inline-flex items-center rounded-xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-medium text-white backdrop-blur hover:bg-white/20"
              >
                Add Lead
              </Link>
              <Link
                href="/app/activity/new"
                className="inline-flex items-center rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Add Follow-Up
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#faf5ff_55%,#ffffff_100%)] px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">Follow-Up Pipeline</h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                See where every lead stands and what needs attention next.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">Turn Interest Into Clients</h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Keep contact details, source, notes, and follow-up timing in one place.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">Front Desk Friendly</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Give staff a clear way to update statuses without digging through spreadsheets.
              </p>
            </div>
          </div>
        </div>
      </section>

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
        <div className="rounded-2xl border border-violet-200/70 bg-white p-4 shadow-sm">
          <p className="text-sm text-slate-500">Overdue follow-ups</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{filteredOverdue.length}</p>
          <p className="mt-2 text-xs text-slate-500">Top front-desk priority</p>
        </div>

        <div className="rounded-2xl border border-violet-200/70 bg-white p-4 shadow-sm">
          <p className="text-sm text-slate-500">Due today</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{filteredDueToday.length}</p>
          <p className="mt-2 text-xs text-slate-500">Same-day callbacks and touchpoints</p>
        </div>

        <div className="rounded-2xl border border-violet-200/70 bg-white p-4 shadow-sm">
          <p className="text-sm text-slate-500">Public intro leads</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{publicIntroLeads.length}</p>
          <p className="mt-2 text-xs text-slate-500">Highest conversion intent</p>
        </div>

        <div className="rounded-2xl border border-violet-200/70 bg-white p-4 shadow-sm">
          <p className="text-sm text-slate-500">Event registration leads</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">
            {eventRegistrationLeads.length}
          </p>
          <p className="mt-2 text-xs text-slate-500">Nurture after attendance</p>
        </div>

        <div className="rounded-2xl border border-violet-200/70 bg-white p-4 shadow-sm">
          <p className="text-sm text-slate-500">New in last 7 days</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{newLast7DaysCount}</p>
          <p className="mt-2 text-xs text-slate-500">Recent inbound volume</p>
        </div>
      </div>

      <form className="rounded-[28px] border border-violet-200/80 bg-white/95 p-5 shadow-[0_18px_45px_rgba(76,29,149,0.09)]">
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
              className="inline-flex items-center rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
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
                      ? "bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] text-white shadow-sm"
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
        <div className="rounded-[28px] border border-violet-200/80 bg-white p-6 shadow-[0_18px_45px_rgba(76,29,149,0.08)]">
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
              <LeadsWorkspacePanels
                variant="priority"
                leads={priorityLeads}
                followUps={[]}
                bookingRequestStates={Object.fromEntries(bookingRequestStateByClientId)}
                returnTo={returnTo}
              />
            )}
          </div>
        </div>

        <div className="rounded-[28px] border border-violet-200/80 bg-white p-6 shadow-[0_18px_45px_rgba(76,29,149,0.08)]">
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
                      ? "bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] text-white shadow-sm"
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
              <LeadsWorkspacePanels
                variant="follow-up"
                leads={[]}
                followUps={activeFollowUpList}
                bookingRequestStates={{}}
                returnTo={returnTo}
                followUpView={tab}
              />
            )}
          </div>
        </div>
      </div>

      <div className="rounded-[28px] border border-violet-200/80 bg-white p-6 shadow-[0_18px_45px_rgba(76,29,149,0.08)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Open leads queue</h2>
            <p className="mt-1 text-sm text-slate-500">
              Same source labeling throughout the queue, with clear next actions for conversion.
            </p>
          </div>
          <p className="text-sm text-slate-500">{sortedLeadQueue.length} leads</p>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-violet-200/80 shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_70%,#ffffff_100%)] text-left text-slate-700">
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
                  <LeadsWorkspacePanels
                    variant="table"
                    leads={sortedLeadQueue}
                    followUps={[]}
                    bookingRequestStates={Object.fromEntries(bookingRequestStateByClientId)}
                    returnTo={returnTo}
                  />
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-4">
            <p className="text-sm text-slate-500">Public Intro</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{publicIntroLeads.length}</p>
          </div>

          <div className="rounded-2xl border border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-4">
            <p className="text-sm text-slate-500">Event Registration</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {eventRegistrationLeads.length}
            </p>
          </div>

          <div className="rounded-2xl border border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-4">
            <p className="text-sm text-slate-500">Public Directory</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {publicDirectoryLeads.length}
            </p>
          </div>

          <div className="rounded-2xl border border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-4">
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