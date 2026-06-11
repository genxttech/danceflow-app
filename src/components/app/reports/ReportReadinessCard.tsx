import Link from "next/link";

type ReportReadinessCardProps = {
  revenueDataMessage: string;
  expenseDataMessage: string;
  accountingDepthMessage: string;
  operationalCoverageMessage: string;
};

export default function ReportReadinessCard({
  revenueDataMessage,
  expenseDataMessage,
  accountingDepthMessage,
  operationalCoverageMessage,
}: ReportReadinessCardProps) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Report Readiness
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Data health for this reporting period
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
            These reports are management previews. They become more useful as
            payments, refunds, fees, expenses, memberships, packages, payouts,
            and client profile data are recorded consistently in DanceFlow.
          </p>
        </div>
        <Link
          href="/app/expenses"
          className="inline-flex w-fit rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
        >
          Review expenses
        </Link>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
          <p className="text-sm font-semibold text-emerald-950">Revenue data</p>
          <p className="mt-1 text-xs leading-5 text-emerald-900/75">
            {revenueDataMessage}
          </p>
        </div>
        <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-950">Expense data</p>
          <p className="mt-1 text-xs leading-5 text-amber-900/75">
            {expenseDataMessage}
          </p>
        </div>
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4">
          <p className="text-sm font-semibold text-indigo-950">Accounting depth</p>
          <p className="mt-1 text-xs leading-5 text-indigo-900/75">
            {accountingDepthMessage}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-950">Operational coverage</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            {operationalCoverageMessage}
          </p>
        </div>
      </div>
    </section>
  );
}
