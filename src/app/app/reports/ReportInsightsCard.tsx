"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  generateReportInsights,
  type ReportInsightsMetrics,
} from "./actions";

type InsightResult = {
  ok: boolean;
  insights?: string;
  error?: string;
};

export default function ReportInsightsCard({
  canUseAi,
  metrics,
}: {
  canUseAi: boolean;
  metrics: ReportInsightsMetrics;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<InsightResult | null>(null);

  function handleGenerate() {
    setResult(null);

    startTransition(async () => {
      const response = await generateReportInsights(metrics);
      setResult(response);
    });
  }

  if (!canUseAi) {
    return (
      <section className="rounded-3xl border border-dashed border-[#E9D5FF] bg-[#FAF5FF] p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
          AI Insights
        </p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
          Unlock AI report insights
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Get a quick summary of report trends and practical next steps for your
          studio or event business.
        </p>
        <Link
          href="/app/settings/billing?reason=ai_report_insights&requiredPlan=growth"
          className="mt-5 inline-flex rounded-xl bg-[#7C2D92] px-4 py-2 text-sm font-semibold text-white hover:bg-[#5B197A]"
        >
          View Plans
        </Link>
      </section>
    );
  }

  return (
    <section className="rounded-3xl border border-[#E9D5FF] bg-[linear-gradient(135deg,#ffffff_0%,#faf5ff_55%,#fff7ed_100%)] p-6 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
            AI Insights
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Generate report insights
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Create a quick summary of what changed in this report range and what
            to focus on next.
          </p>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-500">
            AI-generated insights can help you spot trends, but review the
            numbers before making business decisions.
          </p>
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isPending}
          className="inline-flex w-full justify-center rounded-xl bg-[#7C2D92] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#5B197A] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {isPending ? "Generating..." : "Generate Insights"}
        </button>
      </div>

      {result?.error ? (
        <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700">
          {result.error}
        </div>
      ) : null}

      {result?.ok && result.insights ? (
        <div className="mt-5 whitespace-pre-line rounded-2xl border border-white/70 bg-white/90 p-5 text-sm leading-7 text-slate-700 shadow-sm">
          {result.insights}
        </div>
      ) : null}
    </section>
  );
}
