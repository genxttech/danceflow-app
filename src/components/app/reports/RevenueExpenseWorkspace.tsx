import Link from "next/link";
import { ArrowRight, BadgeDollarSign, ReceiptText, Scale } from "lucide-react";

type SummaryItem = {
  key: string;
  label: string;
  count: number;
  total: number;
};

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export default function RevenueExpenseWorkspace({
  rangeLabel,
  grossRevenue,
  refunds,
  fees,
  expenses,
  instructorPay,
  netResult,
  revenueCategories,
  expenseCategories,
}: {
  rangeLabel: string;
  grossRevenue: number;
  refunds: number;
  fees: number;
  expenses: number;
  instructorPay: number;
  netResult: number;
  revenueCategories: SummaryItem[];
  expenseCategories: SummaryItem[];
}) {
  const deductions = refunds + fees + expenses + instructorPay;
  const margin = grossRevenue > 0 ? Math.round((netResult / grossRevenue) * 100) : 0;

  return (
    <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
      <article id="revenue-workspace" className="scroll-mt-44 rounded-[30px] border border-violet-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
              Revenue workspace
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              Where money came from
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Review collected revenue and the largest revenue categories for {rangeLabel.toLowerCase()}.
            </p>
          </div>
          <Link
            href="#revenue"
            className="inline-flex items-center gap-2 text-sm font-semibold text-violet-800 hover:underline"
          >
            Open revenue detail
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-emerald-50 p-4">
            <BadgeDollarSign className="h-5 w-5 text-emerald-700" />
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-emerald-800/70">Gross revenue</p>
            <p className="mt-1 text-2xl font-semibold text-emerald-950">{money(grossRevenue)}</p>
          </div>
          <div className="rounded-2xl bg-amber-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800/70">Refunds and fees</p>
            <p className="mt-1 text-2xl font-semibold text-amber-950">-{money(refunds + fees)}</p>
            <p className="mt-1 text-xs text-amber-900/70">{money(refunds)} refunds · {money(fees)} fees</p>
          </div>
          <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">After deductions</p>
            <p className="mt-1 text-2xl font-semibold text-violet-950">{money(grossRevenue - deductions)}</p>
            <p className="mt-1 text-xs text-violet-800/70">Before any unrecorded obligations</p>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {revenueCategories.length ? revenueCategories.slice(0, 5).map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-slate-950">{item.label}</p>
                <p className="mt-0.5 text-xs text-slate-500">{item.count} entries</p>
              </div>
              <p className="text-sm font-semibold text-slate-950">{money(item.total)}</p>
            </div>
          )) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
              Revenue categories will appear after accounting entries are recorded.
            </div>
          )}
        </div>
      </article>

      <article id="expense-workspace" className="scroll-mt-44 rounded-[30px] border border-orange-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">
              Expenses & profitability
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              What reduced profit
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              See operating expenses, instructor compensation, and the current management profit preview.
            </p>
          </div>
          <Link
            href="#expenses"
            className="inline-flex items-center gap-2 text-sm font-semibold text-orange-800 hover:underline"
          >
            Open expense detail
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-rose-50 p-4">
            <ReceiptText className="h-5 w-5 text-rose-700" />
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-rose-800/70">Recorded expenses</p>
            <p className="mt-1 text-2xl font-semibold text-rose-950">-{money(expenses)}</p>
          </div>
          <div className="rounded-2xl bg-purple-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-purple-800/70">Instructor pay</p>
            <p className="mt-1 text-2xl font-semibold text-purple-950">-{money(instructorPay)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Scale className="h-5 w-5 text-slate-700" />
                <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Net result</p>
                <p className={`mt-1 text-3xl font-semibold ${netResult >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                  {money(netResult)}
                </p>
              </div>
              <div className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
                {margin}% margin
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {expenseCategories.length ? expenseCategories.slice(0, 4).map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-slate-950">{item.label}</p>
                <p className="mt-0.5 text-xs text-slate-500">{item.count} entries</p>
              </div>
              <p className="text-sm font-semibold text-slate-950">-{money(item.total)}</p>
            </div>
          )) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
              Add expenses to see category pressure and improve the profit preview.
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/app/expenses" className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            Manage expenses
          </Link>
          <Link href="#profitability" className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Review P&amp;L detail
          </Link>
        </div>
      </article>
    </section>
  );
}
