import Link from "next/link";
import {
  ArrowRight,
  CircleDollarSign,
  CirclePlay,
  FileDown,
  PackageCheck,
  Users,
} from "lucide-react";
import type { CommerceIntelligence } from "@/lib/commerce/intelligence";

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export default function OperationsDeliveryWorkspace({
  range,
  instructorCount,
  teachingHours,
  instructorRevenue,
  instructorPayOutstanding,
  instructorPayRatio,
  commerce,
  canViewProReports,
}: {
  range: string;
  instructorCount: number;
  teachingHours: number;
  instructorRevenue: number;
  instructorPayOutstanding: number;
  instructorPayRatio: string;
  commerce: CommerceIntelligence;
  canViewProReports: boolean;
}) {
  const instructorNeedsAction = instructorPayOutstanding > 0;
  const commerceNeedsAction =
    commerce.unfulfilledOrderCount > 0 ||
    commerce.lowStockVariantCount > 0 ||
    commerce.digitalNeverStartedCount > 0 ||
    commerce.digitalLowCompletionCount > 0;

  return (
    <section className="grid gap-6 xl:grid-cols-3">
      <article id="instructor-pay" className="scroll-mt-44 rounded-[30px] border border-violet-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
              Instructor operations
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Activity and compensation
            </h2>
          </div>
          <span className="rounded-2xl bg-violet-50 p-3 text-violet-700">
            <Users className="h-5 w-5" />
          </span>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">Instructors</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{instructorCount}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">Teaching hours</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{teachingHours}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">Lesson revenue</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{money(instructorRevenue)}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">Pay / revenue</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{instructorPayRatio}</p>
          </div>
        </div>

        <div className={`mt-4 rounded-2xl border p-4 ${instructorNeedsAction ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
          <p className="text-sm font-semibold text-slate-950">
            {instructorNeedsAction ? `${money(instructorPayOutstanding)} awaiting payment` : "No instructor pay awaiting action"}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            {instructorNeedsAction
              ? "Review pending and approved earnings before closing the period."
              : "Instructor compensation is clear for the selected range."}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/app/instructor-pay" className="rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800">
            Open Instructor Pay
          </Link>
          <Link href={`/app/instructor-pay/export?range=${range}&status=all`} className="rounded-xl border border-violet-200 px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50">
            Export pay CSV
          </Link>
        </div>
      </article>

      <article id="commerce" className="scroll-mt-44 rounded-[30px] border border-orange-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">
              Commerce operations
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Retail and digital health
            </h2>
          </div>
          <span className="rounded-2xl bg-orange-50 p-3 text-orange-700">
            <PackageCheck className="h-5 w-5" />
          </span>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">Net revenue</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{money(commerce.netRevenue)}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">Completed orders</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{commerce.completedOrderCount}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">Needs fulfillment</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{commerce.unfulfilledOrderCount}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">Digital started</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{commerce.digitalStartedCount}</p>
          </div>
        </div>

        <div className={`mt-4 rounded-2xl border p-4 ${commerceNeedsAction ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
          <p className="text-sm font-semibold text-slate-950">
            {commerceNeedsAction ? "Commerce exceptions need review" : "Commerce operations are clear"}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            {commerceNeedsAction
              ? `${commerce.unfulfilledOrderCount} fulfillment, ${commerce.lowStockVariantCount} low-stock, and ${commerce.digitalNeverStartedCount + commerce.digitalLowCompletionCount} engagement exceptions are visible.`
              : "No urgent fulfillment, inventory, or engagement issue is standing out."}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/app/orders" className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700">
            Open Orders
          </Link>
          <Link href="/app/catalog" className="rounded-xl border border-orange-200 px-4 py-2 text-sm font-semibold text-orange-800 hover:bg-orange-50">
            Open Catalog
          </Link>
        </div>
      </article>

      <article id="exports" className="scroll-mt-44 rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Accountant delivery
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Export and handoff
            </h2>
          </div>
          <span className="rounded-2xl bg-slate-100 p-3 text-slate-700">
            <FileDown className="h-5 w-5" />
          </span>
        </div>

        <div className="mt-5 space-y-3">
          <a href={`/app/reports/export/accounting?range=${range}`} className="flex items-center justify-between rounded-2xl border border-slate-200 p-4 transition hover:border-violet-300 hover:bg-violet-50/50">
            <span>
              <span className="block text-sm font-semibold text-slate-950">Accounting CSV</span>
              <span className="mt-1 block text-xs text-slate-500">Normalized revenue, refunds, fees, and expenses</span>
            </span>
            <ArrowRight className="h-4 w-4 text-slate-400" />
          </a>
          <a href={`/app/reports/export/expenses?range=${range}`} className="flex items-center justify-between rounded-2xl border border-slate-200 p-4 transition hover:border-violet-300 hover:bg-violet-50/50">
            <span>
              <span className="block text-sm font-semibold text-slate-950">Expense CSV</span>
              <span className="mt-1 block text-xs text-slate-500">Detailed expense activity for the selected range</span>
            </span>
            <ArrowRight className="h-4 w-4 text-slate-400" />
          </a>
          <a href={`/app/reports/export/instructor-activity?range=${range}`} className="flex items-center justify-between rounded-2xl border border-slate-200 p-4 transition hover:border-violet-300 hover:bg-violet-50/50">
            <span>
              <span className="block text-sm font-semibold text-slate-950">Instructor activity CSV</span>
              <span className="mt-1 block text-xs text-slate-500">Lessons, attendance, and activity by instructor</span>
            </span>
            <ArrowRight className="h-4 w-4 text-slate-400" />
          </a>
        </div>

        <div className={`mt-4 rounded-2xl border p-4 ${canViewProReports ? "border-violet-200 bg-violet-50" : "border-slate-200 bg-slate-50"}`}>
          <div className="flex items-start gap-3">
            {canViewProReports ? <CircleDollarSign className="mt-0.5 h-5 w-5 text-violet-700" /> : <CirclePlay className="mt-0.5 h-5 w-5 text-slate-500" />}
            <div>
              <p className="text-sm font-semibold text-slate-950">
                {canViewProReports ? "Accountant-ready mapping available" : "Accountant-ready mapping requires Pro"}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                {canViewProReports
                  ? "Use the mapped export for bookkeeping review and accounting imports."
                  : "Upgrade to unlock mapped accounting categories and import preparation."}
              </p>
              <Link href={canViewProReports ? `#accounting-map` : "/app/settings/billing?reason=reports_upgrade&requiredPlan=pro"} className="mt-2 inline-flex text-xs font-semibold text-violet-800 hover:underline">
                {canViewProReports ? "Open mapped export" : "View plans"}
              </Link>
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}
