import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  Banknote,
  CalendarDays,
  DollarSign,
  Plus,
  ReceiptText,
  Ban,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createExpenseAction, voidExpenseAction } from "./actions";

type ExpenseRow = {
  id: string;
  expense_date: string;
  vendor_name: string;
  category: string;
  amount: number;
  currency: string;
  payment_method: string;
  related_event_id: string | null;
  notes: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
};

type EventOptionRow = {
  id: string;
  name: string | null;
  start_date: string | null;
};

const expenseCategories = [
  { value: "floor_fee", label: "Floor Rental / Floor Fee" },
  { value: "rent", label: "Rent" },
  { value: "instructor_pay", label: "Instructor Pay" },
  { value: "marketing", label: "Marketing" },
  { value: "software", label: "Software" },
  { value: "supplies", label: "Supplies" },
  { value: "costumes_retail_inventory", label: "Costumes / Retail Inventory" },
  { value: "event_expense", label: "Event Expense" },
  { value: "travel", label: "Travel" },
  { value: "meals", label: "Meals" },
  { value: "utilities", label: "Utilities" },
  { value: "insurance", label: "Insurance" },
  { value: "professional_services", label: "Professional Services" },
  { value: "other", label: "Other" },
];

const paymentMethods = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "card", label: "Card" },
  { value: "venmo", label: "Venmo" },
  { value: "zelle", label: "Zelle" },
  { value: "ach", label: "ACH" },
  { value: "stripe", label: "Stripe" },
  { value: "other", label: "Other" },
];

function categoryLabel(value: string) {
  return expenseCategories.find((category) => category.value === value)?.label ?? "Other";
}

function paymentMethodLabel(value: string) {
  return paymentMethods.find((method) => method.value === value)?.label ?? "Other";
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatEventOptionLabel(event: EventOptionRow) {
  const name = event.name?.trim() || "Untitled event";

  if (!event.start_date) return name;

  return `${name} · ${formatDate(event.start_date)}`;
}

function formatCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(Number(value ?? 0));
}

function canManageExpenses(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;

  return (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "organizer_owner" ||
    role === "organizer_admin" ||
    role === "independent_instructor"
  );
}

function StatCard({
  label,
  value,
  helper,
  icon: Icon,
}: {
  label: string;
  value: string;
  helper?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
          {helper ? <p className="mt-1 text-xs text-slate-500">{helper}</p> : null}
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export default async function ExpensesPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  const allowManage = canManageExpenses(
    context.studioRole,
    context.isPlatformAdmin
  );

  const [
    { data: expenses, error: expensesError },
    { data: eventOptions, error: eventOptionsError },
  ] = await Promise.all([
    supabase
      .from("expenses")
      .select(
        `
          id,
          expense_date,
          vendor_name,
          category,
          amount,
          currency,
          payment_method,
          related_event_id,
          notes,
          created_at,
          voided_at,
          void_reason
        `
      )
      .eq("studio_id", context.studioId)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100),

    supabase
      .from("events")
      .select("id, name, start_date")
      .eq("studio_id", context.studioId)
      .order("start_date", { ascending: false })
      .limit(300),
  ]);

  if (expensesError) {
    throw new Error(`Could not load expenses: ${expensesError.message}`);
  }

  if (eventOptionsError) {
    throw new Error(`Could not load events for expenses: ${eventOptionsError.message}`);
  }

  const typedExpenses = (expenses ?? []) as ExpenseRow[];
  const typedEventOptions = (eventOptions ?? []) as EventOptionRow[];
  const eventOptionById = new Map(
    typedEventOptions.map((event) => [event.id, formatEventOptionLabel(event)]),
  );

  const activeExpenses = typedExpenses.filter((expense) => !expense.voided_at);

  const totalExpenses = activeExpenses.reduce(
    (sum, expense) => sum + Number(expense.amount ?? 0),
    0
  );

  const floorFeeTotal = activeExpenses
    .filter((expense) => expense.category === "floor_fee")
    .reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Expenses
              </p>

              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Expenses
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Record business expenses like floor fees, rent, marketing,
                software, supplies, and event costs so future reports and P&L
                views can show a clearer financial picture.
              </p>
            </div>

            <Link
              href="/app"
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Dashboard
            </Link>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="rounded-2xl border border-orange-200 bg-orange-50 p-5">
            <h2 className="text-lg font-semibold text-orange-950">
              Floor fees paid to outside studios belong here
            </h2>
            <p className="mt-2 text-sm leading-7 text-orange-900">
              If you rent floor space from a studio that is not on DanceFlow,
              record it as a <strong>Floor Rental / Floor Fee</strong> expense.
              Host studios that collect floor rental fees should treat those
              collections as revenue, not expenses.
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Total Expenses"
          value={formatCurrency(totalExpenses)}
          helper="From the most recent 100 expenses"
          icon={DollarSign}
        />
        <StatCard
          label="Floor Fees"
          value={formatCurrency(floorFeeTotal)}
          helper="Floor rental / floor fee expenses"
          icon={Banknote}
        />
        <StatCard
          label="Expense Records"
          value={String(activeExpenses.length)}
          helper="Active recent expense records"
          icon={ReceiptText}
        />
      </div>

      {allowManage ? (
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Plus className="h-5 w-5" />
            </div>

            <div>
              <h2 className="text-xl font-semibold text-slate-950">
                Add Expense
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Use this for manual expenses, including floor fees paid to
                outside studios.
              </p>
            </div>
          </div>

          <form action={createExpenseAction} className="mt-6 grid gap-4 lg:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-slate-700">
                Expense Date *
              </label>
              <input
                type="date"
                name="expense_date"
                defaultValue={today}
                required
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">
                Vendor / Studio Name *
              </label>
              <input
                type="text"
                name="vendor_name"
                maxLength={160}
                placeholder="Example: Confidance Studio"
                required
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">
                Category *
              </label>
              <select
                name="category"
                defaultValue="floor_fee"
                required
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20"
              >
                {expenseCategories.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">
                Amount *
              </label>
              <input
                type="number"
                name="amount"
                min="0"
                step="0.01"
                placeholder="25.00"
                required
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">
                Payment Method *
              </label>
              <select
                name="payment_method"
                defaultValue="other"
                required
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20"
              >
                {paymentMethods.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-2">
              <label className="text-sm font-medium text-slate-700">
                Related Event
              </label>
              <select
                name="related_event_id"
                defaultValue=""
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20"
              >
                <option value="">Not tied to a specific event</option>
                {typedEventOptions.map((event) => (
                  <option key={event.id} value={event.id}>
                    {formatEventOptionLabel(event)}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Link event costs like guest instructors, venue rental, awards,
                printing, or event marketing so Event P&L can calculate true
                profitability.
              </p>
            </div>

            <div className="lg:col-span-2">
              <label className="text-sm font-medium text-slate-700">
                Notes
              </label>
              <textarea
                name="notes"
                rows={3}
                maxLength={2500}
                placeholder="Example: Floor rental for private lesson"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20"
              />
            </div>

            <div className="lg:col-span-2">
              <button
                type="submit"
                className="rounded-xl bg-[var(--brand-primary)] px-5 py-2.5 text-sm font-medium text-white hover:opacity-95"
              >
                Add Expense
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">
            Recent Expenses
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Review the most recent expense records for this workspace.
          </p>
        </div>

        {typedExpenses.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <CalendarDays className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-4 text-base font-medium text-slate-900">
              No expenses recorded yet
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Add your first expense to start tracking business costs.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left font-semibold text-slate-600">
                    Date
                  </th>
                  <th className="px-6 py-3 text-left font-semibold text-slate-600">
                    Vendor
                  </th>
                  <th className="px-6 py-3 text-left font-semibold text-slate-600">
                    Category
                  </th>
                  <th className="px-6 py-3 text-left font-semibold text-slate-600">
                    Event
                  </th>
                  <th className="px-6 py-3 text-left font-semibold text-slate-600">
                    Method
                  </th>
                  <th className="px-6 py-3 text-right font-semibold text-slate-600">
                    Amount
                  </th>
                  <th className="px-6 py-3 text-right font-semibold text-slate-600">
                    Action
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-200 bg-white">
                {typedExpenses.map((expense) => (
                  <tr
                    key={expense.id}
                    className={expense.voided_at ? "bg-slate-50 opacity-70" : ""}
                  >
                    <td className="whitespace-nowrap px-6 py-4 text-slate-700">
                      {formatDate(expense.expense_date)}
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-medium text-slate-950">
                        {expense.vendor_name}
                      </p>
                      {expense.notes ? (
                        <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">
                          {expense.notes}
                        </p>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-slate-700">
                      {categoryLabel(expense.category)}
                    </td>
                    <td className="max-w-xs px-6 py-4 text-slate-700">
                      {expense.related_event_id ? (
                        <span className="text-xs font-medium text-slate-700">
                          {eventOptionById.get(expense.related_event_id) ??
                            "Linked event"}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-slate-700">
                      {paymentMethodLabel(expense.payment_method)}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right font-semibold text-slate-950">
                      {formatCurrency(expense.amount, expense.currency)}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right">
                      {expense.voided_at ? (
                        <div className="text-right">
                          <span className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                            Voided
                          </span>
                          {expense.void_reason ? (
                            <p
                              className="mt-1 max-w-48 whitespace-normal text-xs text-slate-500"
                              title={expense.void_reason}
                            >
                              {expense.void_reason}
                            </p>
                          ) : null}
                        </div>
                      ) : allowManage ? (
                        <details className="inline-block text-left">
                          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100">
                            <Ban className="h-3.5 w-3.5" />
                            Void
                          </summary>
                          <form
                            action={voidExpenseAction}
                            className="mt-2 w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-lg"
                          >
                            <input
                              type="hidden"
                              name="expense_id"
                              value={expense.id}
                            />
                            <label className="block text-xs font-medium text-slate-700">
                              Reason for voiding
                              <textarea
                                name="void_reason"
                                required
                                maxLength={500}
                                rows={2}
                                placeholder="Duplicate, entered incorrectly, refunded..."
                                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                              />
                            </label>
                            <button
                              type="submit"
                              className="mt-2 w-full rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
                            >
                              Confirm void
                            </button>
                          </form>
                        </details>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}