import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Banknote,
  CircleDollarSign,
  FileDown,
  ReceiptText,
  Users,
} from "lucide-react";

type Metric = {
  label: string;
  value: string;
  helper: string;
  tone?: "positive" | "warning" | "neutral";
};

type ReadinessItem = {
  label: string;
  detail: string;
  ready: boolean;
  href: string;
  action: string;
};

export default function AccountingPeriodCloseOverview({
  rangeLabel,
  netResult,
  metrics,
  readiness,
}: {
  rangeLabel: string;
  netResult: number;
  metrics: Metric[];
  readiness: ReadinessItem[];
}) {
  const readyCount = readiness.filter((item) => item.ready).length;
  const issueCount = readiness.length - readyCount;

  return (
    <section
      id="overview"
      className="scroll-mt-44 overflow-hidden rounded-[32px] border border-violet-200 bg-white shadow-sm"
    >
      <div className="grid gap-0 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="p-5 sm:p-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-700">
                Period close overview
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                Financial command center
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Review the management result, confirm the supporting records,
                and resolve anything that could make {rangeLabel.toLowerCase()} incomplete.
              </p>
            </div>

            <div
              className={`min-w-[210px] rounded-3xl border p-5 ${
                netResult >= 0
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-rose-200 bg-rose-50"
              }`}
            >
              <p
                className={`text-xs font-semibold uppercase tracking-[0.14em] ${
                  netResult >= 0 ? "text-emerald-700" : "text-rose-700"
                }`}
              >
                Net after instructor pay
              </p>
              <p
                className={`mt-2 text-3xl font-semibold ${
                  netResult >= 0 ? "text-emerald-950" : "text-rose-950"
                }`}
              >
                {metrics[0]?.value}
              </p>
              <p
                className={`mt-1 text-xs ${
                  netResult >= 0 ? "text-emerald-800" : "text-rose-800"
                }`}
              >
                Management preview for {rangeLabel.toLowerCase()}.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {metrics.slice(1).map((metric) => (
              <div
                key={metric.label}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                  {metric.label}
                </p>
                <p className="mt-2 text-xl font-semibold text-slate-950">
                  {metric.value}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {metric.helper}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            <Link
              href="/app/expenses"
              className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              <ReceiptText className="h-4 w-4" />
              Manage expenses
            </Link>
            <Link
              href="/app/instructor-pay"
              className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-100"
            >
              <Users className="h-4 w-4" />
              Review instructor pay
            </Link>
            <Link
              href="#payouts"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Banknote className="h-4 w-4" />
              Check payouts
            </Link>
            <Link
              href="#exports"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <FileDown className="h-4 w-4" />
              Export period
            </Link>
          </div>
        </div>

        <aside className="border-t border-violet-100 bg-[linear-gradient(145deg,#faf5ff_0%,#fff7ed_100%)] p-5 sm:p-7 xl:border-l xl:border-t-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
                Close readiness
              </p>
              <h3 className="mt-2 text-xl font-semibold text-slate-950">
                {issueCount === 0 ? "Ready for review" : `${issueCount} item${issueCount === 1 ? "" : "s"} need attention`}
              </h3>
            </div>
            <span
              className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl ${
                issueCount === 0
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              {issueCount === 0 ? (
                <BadgeCheck className="h-5 w-5" />
              ) : (
                <AlertTriangle className="h-5 w-5" />
              )}
            </span>
          </div>

          <div className="mt-5 space-y-3">
            {readiness.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="group block rounded-2xl border border-white bg-white/90 p-4 shadow-sm transition hover:border-violet-200"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                      item.ready
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {item.ready ? (
                      <BadgeCheck className="h-4 w-4" />
                    ) : (
                      <CircleDollarSign className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-950">
                      {item.label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">
                      {item.detail}
                    </span>
                    <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-violet-700">
                      {item.action}
                      <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                    </span>
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
