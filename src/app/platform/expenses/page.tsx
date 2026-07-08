import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";
import {
  createPlatformExpenseAction,
  updatePlatformExpenseStatusAction,
} from "./actions";

type SearchParams = Promise<{
  range?: string;
  category?: string;
  status?: string;
  recurring?: string;
  q?: string;
}>;

type PlatformExpenseRow = {
  id: string;
  expense_date: string;
  vendor_name: string;
  description: string | null;
  category: string;
  amount: number | null;
  currency: string | null;
  payment_method: string | null;
  status: string;
  tax_treatment: string | null;
  is_recurring: boolean | null;
  recurrence_frequency: string | null;
  receipt_url: string | null;
  notes: string | null;
  created_at: string;
};

const RANGE_OPTIONS = [
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "180", label: "Last 180 days", days: 180 },
  { value: "365", label: "Last 12 months", days: 365 },
];

const CATEGORY_OPTIONS = [
  { value: "software_tools", label: "Software Tools" },
  { value: "hosting_infrastructure", label: "Hosting / Infrastructure" },
  { value: "payment_processing", label: "Payment Processing" },
  { value: "contractor_payroll", label: "Contractor / Payroll" },
  { value: "marketing_ads", label: "Marketing / Ads" },
  { value: "professional_services", label: "Professional Services" },
  { value: "taxes_licenses", label: "Taxes / Licenses" },
  { value: "office_admin", label: "Office / Admin" },
  { value: "travel_meals", label: "Travel / Meals" },
  { value: "owner_draw", label: "Owner Draw" },
  { value: "other", label: "Other" },
];

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "reviewed", label: "Reviewed" },
  { value: "reconciled", label: "Reconciled" },
  { value: "excluded", label: "Excluded" },
];

const TAX_OPTIONS = [
  { value: "deductible", label: "Deductible" },
  { value: "capitalized", label: "Capitalized" },
  { value: "non_deductible", label: "Non-Deductible" },
  { value: "distribution", label: "Distribution" },
  { value: "unknown", label: "Unknown" },
];

function getRange(value: string | undefined) {
  return RANGE_OPTIONS.find((option) => option.value === value) ?? RANGE_OPTIONS[1];
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function formatLabel(value: string | null | undefined) {
  return normalize(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function categoryLabel(value: string | null | undefined) {
  return (
    CATEGORY_OPTIONS.find((option) => option.value === normalize(value))?.label ||
    formatLabel(value) ||
    "Other"
  );
}

function statusLabel(value: string | null | undefined) {
  return (
    STATUS_OPTIONS.find((option) => option.value === normalize(value))?.label ||
    formatLabel(value) ||
    "Draft"
  );
}

function formatMoney(value: number | null | undefined, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 2,
  }).format(Number(value ?? 0));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function buildHref(params: Record<string, string | undefined | null>) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }

  const query = search.toString();
  return query ? `/platform/expenses?${query}` : "/platform/expenses";
}

function statusBadgeClass(status: string | null | undefined) {
  const normalized = normalize(status);

  if (normalized === "reconciled") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }

  if (normalized === "reviewed") {
    return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
  }

  if (normalized === "excluded") {
    return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
  }

  return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
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
  tone?: "slate" | "emerald" | "sky" | "amber" | "rose";
}) {
  const tones = {
    slate: "border-slate-200 bg-white text-slate-950",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
    sky: "border-sky-200 bg-sky-50 text-sky-950",
    amber: "border-amber-200 bg-amber-50 text-amber-950",
    rose: "border-rose-200 bg-rose-50 text-rose-950",
  };

  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${tones[tone]}`}>
      <p className="text-sm font-medium opacity-75">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
      <p className="mt-2 text-xs leading-5 opacity-75">{helper}</p>
    </div>
  );
}

export default async function PlatformExpensesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();

  const params = await searchParams;
  const range = getRange(params.range);
  const selectedCategory = normalize(params.category);
  const selectedStatus = normalize(params.status);
  const recurringOnly = params.recurring === "1";
  const query = String(params.q ?? "").trim();

  const now = new Date();
  const rangeStart = new Date(now);
  rangeStart.setDate(rangeStart.getDate() - range.days);

  const rangeStartDate = dateOnly(rangeStart);
  const todayDate = dateOnly(now);

  const supabase = await createClient();

  let expenseQuery = supabase
    .from("platform_expenses")
    .select(
      `
      id,
      expense_date,
      vendor_name,
      description,
      category,
      amount,
      currency,
      payment_method,
      status,
      tax_treatment,
      is_recurring,
      recurrence_frequency,
      receipt_url,
      notes,
      created_at
    `
    )
    .gte("expense_date", rangeStartDate)
    .lte("expense_date", todayDate)
    .order("expense_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (selectedCategory) {
    expenseQuery = expenseQuery.eq("category", selectedCategory);
  }

  if (selectedStatus) {
    expenseQuery = expenseQuery.eq("status", selectedStatus);
  }

  if (recurringOnly) {
    expenseQuery = expenseQuery.eq("is_recurring", true);
  }

  if (query) {
    const escapedQuery = query.replace(/[%_]/g, "");
    expenseQuery = expenseQuery.or(
      `vendor_name.ilike.%${escapedQuery}%,description.ilike.%${escapedQuery}%,notes.ilike.%${escapedQuery}%`
    );
  }

  const { data: expenses, error } = await expenseQuery.limit(200);

  if (error) {
    throw new Error(`Failed to load platform expenses: ${error.message}`);
  }

  const rows = (expenses ?? []) as PlatformExpenseRow[];

  const activeRows = rows.filter((row) => normalize(row.status) !== "excluded");
  const operatingRows = activeRows.filter((row) => normalize(row.category) !== "owner_draw");
  const ownerDrawRows = activeRows.filter((row) => normalize(row.category) === "owner_draw");
  const recurringRows = activeRows.filter((row) => row.is_recurring);

  const totalExpenses = activeRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const operatingExpenses = operatingRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const ownerDraws = ownerDrawRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const recurringExpenses = recurringRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

    type CategorySummaryRow = {
    key: string;
    label: string;
    total: number;
    count: number;
  };

  const categorySummaryMap = operatingRows.reduce<Map<string, CategorySummaryRow>>(
    (map, row) => {
      const key = normalize(row.category) || "other";
      const existing =
        map.get(key) ??
        ({
          key,
          label: categoryLabel(key),
          total: 0,
          count: 0,
        } satisfies CategorySummaryRow);

      existing.total += Number(row.amount ?? 0);
      existing.count += 1;
      map.set(key, existing);

      return map;
    },
    new Map<string, CategorySummaryRow>()
  );

  const categoryRows = Array.from(categorySummaryMap.values()).sort(
    (a, b) => b.total - a.total
  );

  const returnTo = buildHref({
    range: range.value,
    category: selectedCategory,
    status: selectedStatus,
    recurring: recurringOnly ? "1" : null,
    q: query,
  });

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                Platform Expenses
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Expense Ledger
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Track DanceFlow operating expenses, owner draws, vendor costs, and recurring platform spend.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {RANGE_OPTIONS.map((option) => (
                <Link
                  key={option.value}
                  href={buildHref({
                    range: option.value,
                    category: selectedCategory,
                    status: selectedStatus,
                    recurring: recurringOnly ? "1" : null,
                    q: query,
                  })}
                  className={`rounded-xl border px-4 py-2 text-sm font-semibold ${
                    option.value === range.value
                      ? "border-white bg-white text-[var(--brand-primary)]"
                      : "border-white/20 bg-white/10 text-white hover:bg-white/15"
                  }`}
                >
                  {option.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total Expenses"
          value={formatMoney(totalExpenses)}
          helper={`${rows.length} ledger item${rows.length === 1 ? "" : "s"} in ${range.label.toLowerCase()}`}
          tone="slate"
        />
        <StatCard
          label="Operating Expenses"
          value={formatMoney(operatingExpenses)}
          helper="Excludes owner draws and excluded rows"
          tone="rose"
        />
        <StatCard
          label="Recurring Spend"
          value={formatMoney(recurringExpenses)}
          helper={`${recurringRows.length} recurring item${recurringRows.length === 1 ? "" : "s"} in this view`}
          tone="amber"
        />
        <StatCard
          label="Owner Draws"
          value={formatMoney(ownerDraws)}
          helper="Tracked separately from operating expenses"
          tone="sky"
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Add Expense
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              New Ledger Item
            </h2>
          </div>

          <form action={createPlatformExpenseAction} className="mt-5 grid gap-4">
            <input type="hidden" name="returnTo" value={returnTo} />

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Date
                <input
                  name="expenseDate"
                  type="date"
                  defaultValue={todayDate}
                  required
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Amount
                <input
                  name="amount"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  placeholder="0.00"
                />
              </label>
            </div>

            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Vendor
              <input
                name="vendorName"
                required
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                placeholder="Vendor or payee"
              />
            </label>

            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Description
              <input
                name="description"
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                placeholder="Short description"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Category
                <select
                  name="category"
                  defaultValue="software_tools"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                >
                  {CATEGORY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Tax Treatment
                <select
                  name="taxTreatment"
                  defaultValue="deductible"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                >
                  {TAX_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Payment Method
                <input
                  name="paymentMethod"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  placeholder="Card, ACH, cash..."
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Currency
                <input
                  name="currency"
                  defaultValue="USD"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm uppercase"
                />
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Receipt URL
                <input
                  name="receiptUrl"
                  type="url"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  placeholder="https://..."
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Recurrence
                <select
                  name="recurrenceFrequency"
                  defaultValue=""
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                >
                  <option value="">None</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annual">Annual</option>
                </select>
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                name="isRecurring"
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300"
              />
              Recurring expense
            </label>

            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Notes
              <textarea
                name="notes"
                rows={3}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                placeholder="Internal accounting notes"
              />
            </label>

            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Add Expense
            </button>
          </form>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Expense Mix
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Operating Expenses by Category
            </h2>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
            {categoryRows.length ? (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Items</th>
                    <th className="px-4 py-3">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {categoryRows.map((row) => (
                    <tr key={row.key}>
                      <td className="px-4 py-3 font-semibold text-slate-900">{row.label}</td>
                      <td className="px-4 py-3 text-slate-600">{row.count}</td>
                      <td className="px-4 py-3 font-semibold text-slate-950">
                        {formatMoney(row.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="bg-slate-50 p-5 text-sm text-slate-500">
                No operating expense categories are available for this view.
              </div>
            )}
          </div>

          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800">
            Owner draws are tracked separately because they are cash movement, not operating expense.
          </div>
        </section>
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Ledger
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Expense Entries
            </h2>
          </div>

          <form className="grid gap-3 md:grid-cols-5" action="/platform/expenses">
            <input type="hidden" name="range" value={range.value} />

            <select
              name="category"
              defaultValue={selectedCategory}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">All categories</option>
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              name="status"
              defaultValue={selectedStatus}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              name="recurring"
              defaultValue={recurringOnly ? "1" : ""}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">All expenses</option>
              <option value="1">Recurring only</option>
            </select>

            <input
              name="q"
              defaultValue={query}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              placeholder="Search"
            />

            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Filter
            </button>
          </form>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {rows.length ? (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Recurring</th>
                  <th className="px-4 py-3">Update</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {rows.map((expense) => (
                  <tr key={expense.id} className={normalize(expense.status) === "excluded" ? "bg-slate-50" : ""}>
                    <td className="px-4 py-3 text-slate-600">{formatDate(expense.expense_date)}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-950">{expense.vendor_name}</div>
                      <div className="mt-1 max-w-md text-xs leading-5 text-slate-500">
                        {expense.description || expense.notes || "No description"}
                      </div>
                      {expense.receipt_url ? (
                        <Link
                          href={expense.receipt_url}
                          className="mt-1 inline-flex text-xs font-semibold text-sky-700 hover:text-sky-900"
                          target="_blank"
                        >
                          Receipt
                        </Link>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{categoryLabel(expense.category)}</td>
                    <td className="px-4 py-3 font-semibold text-slate-950">
                      {formatMoney(expense.amount, expense.currency ?? "USD")}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(expense.status)}`}>
                        {statusLabel(expense.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {expense.is_recurring
                        ? formatLabel(expense.recurrence_frequency) || "Yes"
                        : "No"}
                    </td>
                    <td className="px-4 py-3">
                      <form action={updatePlatformExpenseStatusAction} className="flex gap-2">
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <input type="hidden" name="expenseId" value={expense.id} />
                        <select
                          name="status"
                          defaultValue={expense.status}
                          className="rounded-xl border border-slate-200 px-2 py-1 text-xs"
                        >
                          {STATUS_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="rounded-xl bg-slate-900 px-3 py-1 text-xs font-semibold text-white"
                        >
                          Save
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="bg-slate-50 p-5 text-sm text-slate-500">
              No platform expenses match this view.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}