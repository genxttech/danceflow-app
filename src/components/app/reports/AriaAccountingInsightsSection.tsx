import Link from "next/link";

type AriaAccountingInsight = {
  title: string;
  metric: string;
  detail: string;
  tone?: string | null;
};

type AriaAccountingInsightsSectionProps = {
  insights: AriaAccountingInsight[];
  exportHref: string;
};

export default function AriaAccountingInsightsSection({
  insights,
  exportHref,
}: AriaAccountingInsightsSectionProps) {
  return (
    <section className="rounded-3xl border border-[#7C2D92]/20 bg-gradient-to-br from-white via-[#fff7fd] to-[#fff4e8] p-6 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
            ARIA Accounting Insights
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Finance signals to review before closing this period
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
            Deterministic insights from the reporting data below. ARIA is not
            changing records or making accounting decisions here — it is
            highlighting items worth reviewing.
          </p>
        </div>
        <Link
          href={exportHref}
          className="inline-flex w-fit rounded-xl border border-[#7C2D92]/20 bg-white px-4 py-2 text-sm font-semibold text-[#7C2D92] hover:bg-[#FDF2F8]"
        >
          Export accounting map
        </Link>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {insights.map((insight) => (
          <div
            key={insight.title}
            className={`rounded-2xl border p-4 ${
              insight.tone === "warning"
                ? "border-amber-200 bg-amber-50"
                : insight.tone === "good"
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-white/80 bg-white/80"
            }`}
          >
            <p
              className={`text-xs font-semibold uppercase tracking-[0.16em] ${
                insight.tone === "warning"
                  ? "text-amber-700"
                  : insight.tone === "good"
                    ? "text-emerald-700"
                    : "text-slate-500"
              }`}
            >
              {insight.title}
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              {insight.metric}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {insight.detail}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
