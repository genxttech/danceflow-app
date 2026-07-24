import Link from "next/link";
import { redirect } from "next/navigation";
import type { ComponentType } from "react";
import {
  BarChart3,
  Clock3,
  DollarSign,
  HeartHandshake,
  PieChart,
  Target,
  TrendingUp,
  UserCheck,
} from "lucide-react";
import { canViewReports } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import ReportingWorkspaceHeader from "@/components/app/reports/ReportingWorkspaceHeader";
import AnalyticsWorkspaceNav from "@/components/app/analytics/AnalyticsWorkspaceNav";
import {
  formatDanceGoalCurrency,
  formatDanceGoalDays,
  formatDanceGoalPercent,
  getDanceGoalIntelligence,
} from "@/lib/aria/danceGoalInsights";

type SearchParams = Promise<{
  range?: string;
}>;

function fmtNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function StatCard({
  label,
  value,
  helper,
  icon: Icon,
  accent = "primary",
}: {
  label: string;
  value: string;
  helper: string;
  icon: ComponentType<{ className?: string }>;
  accent?: "primary" | "emerald" | "amber" | "rose";
}) {
  const accentClass =
    accent === "emerald"
      ? "bg-emerald-50 text-emerald-700"
      : accent === "amber"
        ? "bg-amber-50 text-amber-700"
        : accent === "rose"
          ? "bg-rose-50 text-rose-700"
          : "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]";

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
          <p className="mt-2 text-sm leading-6 text-slate-500">{helper}</p>
        </div>
        <div className={`rounded-2xl p-3 ${accentClass}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function InsightCard({
  title,
  value,
  detail,
  tone = "slate",
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "slate" | "emerald" | "amber" | "rose";
}) {
  const toneClass =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : tone === "rose"
          ? "border-rose-200 bg-rose-50 text-rose-900"
          : "border-slate-200 bg-slate-50 text-slate-900";

  return (
    <div className={`rounded-3xl border p-4 ${toneClass}`}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-2 text-sm leading-6 opacity-80">{detail}</p>
    </div>
  );
}

export default async function DanceGoalsAnalyticsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;
  if (!studioId) {
    redirect("/app");
  }

  const intelligence = await getDanceGoalIntelligence({
    studioId,
    range: params.range,
  });
  const { range, goalStats, totals, leaders, recommendations } = intelligence;
  const {
    bestConversion,
    highestRevenue,
    retentionLeader,
    highInterestLowConversion,
  } = leaders;

  const rangeControls = [
    { value: "30", label: "30 days" },
    { value: "90", label: "90 days" },
    { value: "180", label: "180 days" },
    { value: "365", label: "12 months" },
    { value: "all", label: "All time" },
  ].map((option) => {
    const active = option.value === range.value;

    return (
      <Link
        key={option.value}
        href={`/app/analytics/dance-goals?range=${option.value}`}
        className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
          active
            ? "border-white bg-white text-slate-950"
            : "border-white/20 bg-white/10 text-white hover:bg-white/20"
        }`}
      >
        {option.label}
      </Link>
    );
  });

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <ReportingWorkspaceHeader
        activeWorkspace="analytics"
        eyebrow="DanceFlow Intelligence"
        title="Dance Goal Analytics"
        description={
          <>
            See which student goals create the strongest conversion, retention,
            lesson activity, and lifetime spend. ARIA reads these same metrics
            for studio recommendations.
          </>
        }
        controls={rangeControls}
      >
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/app/analytics?range=${range.value}`}
            className="rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
          >
            Analytics overview
          </Link>
          <span className="rounded-full border border-orange-200/40 bg-orange-300/15 px-4 py-2 text-sm font-semibold text-orange-100">
            Dance goals
          </span>
        </div>
      </ReportingWorkspaceHeader>

      <AnalyticsWorkspaceNav activeSection="dance_goals" range={range.value} />

      <section className="rounded-3xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
        <span className="font-semibold text-slate-900">How this works:</span>{" "}
        conversion means the client has at least one package or membership purchase.
        retention means a second package or membership purchase within 90 days of the
        first purchase. Lifetime spend is based on package sold price plus membership
        price and signup fee.
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Goal Selections"
          value={fmtNumber(totals.goalSelections)}
          helper={`${range.label} across clients with one or more selected goals`}
          icon={Target}
        />
        <StatCard
          label="Goal Conversion"
          value={formatDanceGoalPercent(
            totals.convertedSelections,
            totals.goalSelections,
          )}
          helper={`${totals.convertedSelections} converted goal selections`}
          icon={UserCheck}
          accent="emerald"
        />
        <StatCard
          label="Goal Retention"
          value={formatDanceGoalPercent(
            totals.retainedSelections,
            totals.convertedSelections,
          )}
          helper={`${totals.retainedSelections} retained selections after first purchase`}
          icon={TrendingUp}
          accent="amber"
        />
        <StatCard
          label="Lifetime Spend"
          value={formatDanceGoalCurrency(totals.totalSpend)}
          helper="Package and membership value tied to selected goals"
          icon={DollarSign}
          accent="rose"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-4">
        <InsightCard
          title="Best Converting Goal"
          value={bestConversion?.goal ?? "Not enough data"}
          detail={
            bestConversion
              ? `${formatDanceGoalPercent(bestConversion.converted, bestConversion.totalClients)} conversion from ${bestConversion.totalClients} clients.`
              : "At least two clients per goal are needed for this insight."
          }
          tone="emerald"
        />
        <InsightCard
          title="Highest Revenue Goal"
          value={highestRevenue?.goal ?? "No spend yet"}
          detail={
            highestRevenue
              ? `${formatDanceGoalCurrency(highestRevenue.totalSpend)} total lifetime spend.`
              : "Add purchases to see revenue by goal."
          }
        />
        <InsightCard
          title="Retention Leader"
          value={retentionLeader?.goal ?? "No retention yet"}
          detail={
            retentionLeader
              ? `${formatDanceGoalPercent(retentionLeader.retained, retentionLeader.converted)} retained after first purchase.`
              : "Retention appears after repeat package or membership purchases."
          }
          tone="amber"
        />
        <InsightCard
          title="Watchlist"
          value={highInterestLowConversion?.goal ?? "No gap yet"}
          detail={
            highInterestLowConversion
              ? `${highInterestLowConversion.totalClients} interested, ${formatDanceGoalPercent(highInterestLowConversion.converted, highInterestLowConversion.totalClients)} converted.`
              : "No high-interest, low-conversion goal is visible yet."
          }
          tone="rose"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {recommendations.map((recommendation) => (
          <AriaInsightCard
            key={recommendation.title}
            eyebrow="ARIA Dance Goal Insight"
            title={recommendation.title}
            insight={recommendation.insight}
            recommendation={recommendation.recommendation}
            metric={recommendation.metric}
            primaryAction={{
              href: "/app/aria",
              label: "Open ARIA",
            }}
            compact
          />
        ))}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-950">
                Goal Performance
              </h2>
              <p className="text-sm text-slate-500">
                Conversion, retention, lesson activity, and spend by dance goal.
              </p>
            </div>
          </div>
        </div>
        <div className="overflow-x-auto p-5">
          {goalStats.length ? (
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-3">Goal</th>
                  <th className="px-3 py-3 text-right">Clients</th>
                  <th className="px-3 py-3 text-right">Leads</th>
                  <th className="px-3 py-3 text-right">Active</th>
                  <th className="px-3 py-3 text-right">Conversion</th>
                  <th className="px-3 py-3 text-right">Retention</th>
                  <th className="px-3 py-3 text-right">Avg. LTV</th>
                  <th className="px-3 py-3 text-right">Lessons</th>
                  <th className="px-3 py-3 text-right">Avg. days to buy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {goalStats.map((stat) => (
                  <tr key={stat.goal} className="text-slate-700">
                    <td className="px-3 py-4 font-medium text-slate-950">
                      {stat.goal}
                    </td>
                    <td className="px-3 py-4 text-right">{stat.totalClients}</td>
                    <td className="px-3 py-4 text-right">{stat.leads}</td>
                    <td className="px-3 py-4 text-right">{stat.active}</td>
                    <td className="px-3 py-4 text-right">
                      {formatDanceGoalPercent(stat.converted, stat.totalClients)}
                    </td>
                    <td className="px-3 py-4 text-right">
                      {formatDanceGoalPercent(stat.retained, stat.converted)}
                    </td>
                    <td className="px-3 py-4 text-right">
                      {formatDanceGoalCurrency(
                        stat.totalSpend / Math.max(stat.totalClients, 1),
                      )}
                    </td>
                    <td className="px-3 py-4 text-right">{stat.completedLessons}</td>
                    <td className="px-3 py-4 text-right">
                      {formatDanceGoalDays(stat.avgDaysToFirstPurchase)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
              No dance goals are available for this range yet. Add Dance Goals on
              client intake to populate this dashboard.
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-3">
            <PieChart className="h-5 w-5 text-[var(--brand-primary)]" />
            <h2 className="text-lg font-semibold text-slate-950">
              Conversion Use
            </h2>
          </div>
          <p className="text-sm leading-6 text-slate-600">
            Use high-converting goals to shape consult scripts, intro offers, and
            landing-page copy. These goals tell the studio what language is already
            working.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-3">
            <HeartHandshake className="h-5 w-5 text-emerald-600" />
            <h2 className="text-lg font-semibold text-slate-950">
              Retention Use
            </h2>
          </div>
          <p className="text-sm leading-6 text-slate-600">
            Compare conversion with retention. A goal can convert well but still need
            a stronger follow-up path after the first purchase.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-3">
            <Clock3 className="h-5 w-5 text-amber-600" />
            <h2 className="text-lg font-semibold text-slate-950">
              Speed Use
            </h2>
          </div>
          <p className="text-sm leading-6 text-slate-600">
            Average days to first purchase helps identify goals that need faster
            close support, different package recommendations, or more nurture.
          </p>
        </div>
      </section>
    </div>
  );
}
