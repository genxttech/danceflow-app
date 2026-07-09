import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import {
  createPlatformSalesOpportunityAction,
  updatePlatformSalesStageAction,
} from "./actions";

type SearchParams = Promise<{
  stage?: string;
}>;

type StudioOptionRow = {
  id: string;
  name: string;
};

type SalesOpportunityRow = {
  id: string;
  studio_id: string | null;
  company_name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string;
  stage: string;
  plan_interest: string | null;
  estimated_value: number | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  next_follow_up_at: string | null;
  lost_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  studios:
    | {
        id: string;
        name: string;
      }
    | {
        id: string;
        name: string;
      }[]
    | null;
};

const STAGES = [
  { key: "new_lead", label: "New Lead" },
  { key: "demo_scheduled", label: "Demo Scheduled" },
  { key: "trial_started", label: "Trial Started" },
  { key: "onboarding", label: "Onboarding" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
];

const SOURCES = [
  { key: "manual", label: "Manual" },
  { key: "referral", label: "Referral" },
  { key: "website", label: "Website" },
  { key: "founder_outreach", label: "Founder Outreach" },
  { key: "social_media", label: "Social Media" },
  { key: "event", label: "Event" },
  { key: "partner", label: "Partner" },
  { key: "other", label: "Other" },
];

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function formatMoney(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";

  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function daysUntil(value: string | null | undefined) {
  if (!value) return null;
  const target = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

function stageLabel(value: string) {
  return STAGES.find((stage) => stage.key === value)?.label ?? value;
}

function sourceLabel(value: string) {
  return SOURCES.find((source) => source.key === value)?.label ?? value;
}

function stageBadgeClass(stage: string) {
  if (stage === "won") return "bg-emerald-50 text-emerald-700";
  if (stage === "lost") return "bg-rose-50 text-rose-700";
  if (stage === "trial_started") return "bg-sky-50 text-sky-700";
  if (stage === "onboarding") return "bg-violet-50 text-violet-700";
  if (stage === "demo_scheduled") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function followUpTone(value: string | null | undefined) {
  const days = daysUntil(value);
  if (days === null) return "text-slate-500";
  if (days < 0) return "text-rose-700";
  if (days <= 3) return "text-amber-700";
  return "text-slate-600";
}

function StatCard({
  label,
  value,
  helper,
  tone = "slate",
}: {
  label: string;
  value: string;
  helper: string;
  tone?: "slate" | "emerald" | "amber" | "rose" | "sky" | "violet";
}) {
  const toneClass =
    tone === "emerald"
      ? "from-emerald-50 to-white text-emerald-700"
      : tone === "amber"
        ? "from-amber-50 to-white text-amber-700"
        : tone === "rose"
          ? "from-rose-50 to-white text-rose-700"
          : tone === "sky"
            ? "from-sky-50 to-white text-sky-700"
            : tone === "violet"
              ? "from-violet-50 to-white text-violet-700"
              : "from-slate-50 to-white text-slate-700";

  return (
    <div className={`rounded-[28px] border border-slate-200 bg-gradient-to-br ${toneClass} p-5 shadow-sm`}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{value}</p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{helper}</p>
    </div>
  );
}

function HiddenReturnTo({ stage }: { stage: string }) {
  return <input type="hidden" name="returnTo" value={`/platform/sales${stage === "all" ? "" : `?stage=${stage}`}`} />;
}

export default async function PlatformSalesPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePlatformAdmin();

  const params = await searchParams;
  const selectedStage = normalize(params.stage) || "all";

  const supabase = await createClient();

  const [
    { data: opportunities, error: opportunitiesError },
    { data: studios, error: studiosError },
  ] = await Promise.all([
    supabase
      .from("platform_sales_opportunities")
      .select(
        `
        id,
        studio_id,
        company_name,
        contact_name,
        contact_email,
        contact_phone,
        source,
        stage,
        plan_interest,
        estimated_value,
        trial_started_at,
        trial_ends_at,
        next_follow_up_at,
        lost_reason,
        notes,
        created_at,
        updated_at,
        studios ( id, name )
      `,
      )
      .order("next_follow_up_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase.from("studios").select("id, name").order("name", { ascending: true }),
  ]);

  if (opportunitiesError) {
    throw new Error(`Failed to load sales opportunities: ${opportunitiesError.message}`);
  }

  if (studiosError) {
    throw new Error(`Failed to load studios: ${studiosError.message}`);
  }

  const typedOpportunities = (opportunities ?? []) as SalesOpportunityRow[];
  const studioOptions = (studios ?? []) as StudioOptionRow[];

  const filteredOpportunities =
    selectedStage === "all"
      ? typedOpportunities
      : typedOpportunities.filter((opportunity) => opportunity.stage === selectedStage);

  const openOpportunities = typedOpportunities.filter(
    (opportunity) => !["won", "lost"].includes(opportunity.stage),
  );
  const wonOpportunities = typedOpportunities.filter((opportunity) => opportunity.stage === "won");
  const lostOpportunities = typedOpportunities.filter((opportunity) => opportunity.stage === "lost");
  const overdueFollowUps = openOpportunities.filter((opportunity) => {
    const days = daysUntil(opportunity.next_follow_up_at);
    return days !== null && days < 0;
  });
  const dueSoonFollowUps = openOpportunities.filter((opportunity) => {
    const days = daysUntil(opportunity.next_follow_up_at);
    return days !== null && days >= 0 && days <= 7;
  });
  const activePipelineValue = openOpportunities.reduce(
    (sum, opportunity) => sum + Number(opportunity.estimated_value ?? 0),
    0,
  );
  const wonValue = wonOpportunities.reduce(
    (sum, opportunity) => sum + Number(opportunity.estimated_value ?? 0),
    0,
  );

  const stageCounts = STAGES.map((stage) => ({
    ...stage,
    count: typedOpportunities.filter((opportunity) => opportunity.stage === stage.key).length,
    value: typedOpportunities
      .filter((opportunity) => opportunity.stage === stage.key)
      .reduce((sum, opportunity) => sum + Number(opportunity.estimated_value ?? 0), 0),
  }));

  const priorityQueue = [...overdueFollowUps, ...dueSoonFollowUps]
    .filter((opportunity, index, rows) => rows.findIndex((row) => row.id === opportunity.id) === index)
    .slice(0, 8);

  return (
    <main className="space-y-6">
      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-slate-950 shadow-sm">
        <div className="grid gap-6 p-6 text-white lg:grid-cols-[1.2fr_0.8fr] lg:p-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-pink-200">
              Platform Sales
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Trial CRM and founder pipeline
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
              Track DanceFlow prospects from first conversation through demo, trial, onboarding, conversion, or lost reason.
            </p>
          </div>
          <div className="rounded-[28px] border border-white/10 bg-white/10 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-100">
              ARIA Sales Signal
            </p>
            <p className="mt-3 text-2xl font-semibold">{overdueFollowUps.length || dueSoonFollowUps.length ? "Follow-up pressure" : "Pipeline clean"}</p>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              {overdueFollowUps.length
                ? `${overdueFollowUps.length} sales follow-up${overdueFollowUps.length === 1 ? "" : "s"} are overdue.`
                : dueSoonFollowUps.length
                  ? `${dueSoonFollowUps.length} follow-up${dueSoonFollowUps.length === 1 ? "" : "s"} are due in the next week.`
                  : "No overdue sales follow-ups are currently visible."}
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Open Pipeline" value={String(openOpportunities.length)} helper={formatMoney(activePipelineValue)} tone="sky" />
        <StatCard label="Won" value={String(wonOpportunities.length)} helper={formatMoney(wonValue)} tone="emerald" />
        <StatCard label="Lost" value={String(lostOpportunities.length)} helper="Captured with reason notes" tone="rose" />
        <StatCard label="Overdue" value={String(overdueFollowUps.length)} helper="Follow-ups past due" tone={overdueFollowUps.length ? "rose" : "slate"} />
        <StatCard label="Due Soon" value={String(dueSoonFollowUps.length)} helper="Follow-ups in 7 days" tone={dueSoonFollowUps.length ? "amber" : "slate"} />
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            New Opportunity
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Add a studio prospect
          </h2>

          <form action={createPlatformSalesOpportunityAction} className="mt-5 grid gap-4">
            <HiddenReturnTo stage={selectedStage} />

            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Company / Studio Name
              <input
                required
                name="companyName"
                className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100"
                placeholder="Studio name"
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Contact Name
                <input name="contactName" className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100" />
              </label>
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Contact Email
                <input type="email" name="contactEmail" className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100" />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Stage
                <select name="stage" defaultValue="new_lead" className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100">
                  {STAGES.map((stage) => (
                    <option key={stage.key} value={stage.key}>{stage.label}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Source
                <select name="source" defaultValue="manual" className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100">
                  {SOURCES.map((source) => (
                    <option key={source.key} value={source.key}>{source.label}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Value
                <input name="estimatedValue" inputMode="decimal" placeholder="0" className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100" />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Plan Interest
                <input name="planInterest" placeholder="Starter, Growth, Pro..." className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100" />
              </label>
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Next Follow-up
                <input type="date" name="nextFollowUpAt" className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100" />
              </label>
            </div>

            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Link Existing Studio
              <select name="studioId" defaultValue="" className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100">
                <option value="">Not linked yet</option>
                {studioOptions.map((studio) => (
                  <option key={studio.id} value={studio.id}>{studio.name}</option>
                ))}
              </select>
            </label>

            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Notes
              <textarea name="notes" rows={4} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-pink-300 focus:ring-4 focus:ring-pink-100" />
            </label>

            <button
              type="submit"
              className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Add Opportunity
            </button>
          </form>
        </div>

        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Pipeline Stages
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Founder pipeline board
          </h2>

          <div className="mt-5 grid gap-3">
            <Link
              href="/platform/sales"
              className={`rounded-2xl border px-4 py-3 text-sm font-semibold transition ${
                selectedStage === "all"
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
              }`}
            >
              All Opportunities · {typedOpportunities.length}
            </Link>

            {stageCounts.map((stage) => (
              <Link
                key={stage.key}
                href={`/platform/sales?stage=${stage.key}`}
                className={`rounded-2xl border px-4 py-3 transition ${
                  selectedStage === stage.key
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{stage.label}</p>
                    <p className={`mt-1 text-xs ${selectedStage === stage.key ? "text-slate-300" : "text-slate-500"}`}>
                      {stage.count} opportunity{stage.count === 1 ? "" : "ies"} · {formatMoney(stage.value)}
                    </p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${selectedStage === stage.key ? "bg-white/15 text-white" : stageBadgeClass(stage.key)}`}>
                    {stage.count}
                  </span>
                </div>
              </Link>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm leading-6 text-violet-800">
            Use this as the platform CRM for founder outreach, demos, trials, and lost reason tracking.
          </div>
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Follow-up Queue
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Priority sales actions
            </h2>
          </div>
          <Link href="/platform/ops-review" className="text-sm font-semibold text-[#BE185D]">
            Ops Review
          </Link>
        </div>

        <div className="mt-5 grid gap-3">
          {priorityQueue.length ? (
            priorityQueue.map((opportunity) => {
              const studio = one(opportunity.studios);
              const days = daysUntil(opportunity.next_follow_up_at);

              return (
                <div key={opportunity.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="font-semibold text-slate-950">{opportunity.company_name}</p>
                      <p className="mt-1 text-sm text-slate-600">
                        {opportunity.contact_name ?? "No contact"}{opportunity.contact_email ? ` · ${opportunity.contact_email}` : ""}
                      </p>
                      <p className={`mt-2 text-sm font-semibold ${followUpTone(opportunity.next_follow_up_at)}`}>
                        {days !== null && days < 0
                          ? `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`
                          : days === 0
                            ? "Due today"
                            : `Due ${formatDate(opportunity.next_follow_up_at)}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {studio ? (
                        <Link href={`/platform/studios/${studio.id}`} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
                          View Studio
                        </Link>
                      ) : null}
                      <Link href="/platform/success" className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white">
                        Success
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
              No overdue or due-soon sales follow-ups.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Opportunities
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              {selectedStage === "all" ? "All sales opportunities" : stageLabel(selectedStage)}
            </h2>
          </div>
          <p className="text-sm text-slate-500">
            {filteredOpportunities.length} visible
          </p>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {filteredOpportunities.length ? (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Opportunity</th>
                  <th className="px-4 py-3">Stage</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Follow-up</th>
                  <th className="px-4 py-3">Value</th>
                  <th className="px-4 py-3">Move</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {filteredOpportunities.map((opportunity) => {
                  const studio = one(opportunity.studios);

                  return (
                    <tr key={opportunity.id} className="align-top">
                      <td className="px-4 py-4">
                        <p className="font-semibold text-slate-950">{opportunity.company_name}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {opportunity.contact_name ?? "No contact"}{opportunity.contact_email ? ` · ${opportunity.contact_email}` : ""}
                        </p>
                        {studio ? (
                          <Link href={`/platform/studios/${studio.id}`} className="mt-2 inline-flex text-xs font-semibold text-[#BE185D]">
                            Linked: {studio.name}
                          </Link>
                        ) : null}
                        {opportunity.notes ? (
                          <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{opportunity.notes}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4">
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${stageBadgeClass(opportunity.stage)}`}>
                          {stageLabel(opportunity.stage)}
                        </span>
                        {opportunity.plan_interest ? (
                          <p className="mt-2 text-xs text-slate-500">{opportunity.plan_interest}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-slate-600">{sourceLabel(opportunity.source)}</td>
                      <td className={`px-4 py-4 font-semibold ${followUpTone(opportunity.next_follow_up_at)}`}>
                        {formatDate(opportunity.next_follow_up_at)}
                      </td>
                      <td className="px-4 py-4 font-semibold text-slate-950">
                        {formatMoney(opportunity.estimated_value)}
                      </td>
                      <td className="px-4 py-4">
                        <form action={updatePlatformSalesStageAction} className="flex min-w-[180px] flex-col gap-2">
                          <HiddenReturnTo stage={selectedStage} />
                          <input type="hidden" name="opportunityId" value={opportunity.id} />
                          <select
                            name="stage"
                            defaultValue={opportunity.stage}
                            className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-950"
                          >
                            {STAGES.map((stage) => (
                              <option key={stage.key} value={stage.key}>{stage.label}</option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white"
                          >
                            Update Stage
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="bg-slate-50 p-6 text-sm text-slate-500">
              No opportunities are in this stage yet.
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
