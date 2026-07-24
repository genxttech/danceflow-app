import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Plus,
  Ban,
  CheckCircle2,
  Pause,
  Play,
  Repeat2,
  SkipForward,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import SellWorkspaceHeader from "@/components/app/sell/SellWorkspaceHeader";
import SellWorkspaceEmptyState from "@/components/app/sell/SellWorkspaceEmptyState";
import CompactSummaryStrip from "@/components/app/workspace/CompactSummaryStrip";
import {
  canManageOrganizerExpenses,
  isOrganizerWorkspaceRole,
} from "@/lib/auth/permissions";
import {
  createExpenseAction,
  recordRecurringExpenseAction,
  setRecurringExpenseStatusAction,
  skipRecurringExpenseAction,
  voidExpenseAction,
} from "./actions";

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

type RecurringExpenseRow = {
  id: string;
  vendor_name: string;
  category: string;
  amount: number;
  currency: string;
  payment_method: string;
  related_event_id: string | null;
  notes: string | null;
  frequency: "weekly" | "monthly" | "quarterly" | "annually";
  next_due_date: string;
  end_date: string | null;
  status: "active" | "paused" | "completed";
};

type EventOptionRow = {
  id: string;
  name: string | null;
  start_date: string | null;
};

const studioExpenseCategories = [
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

const organizerExpenseCategories = [
  { value: "venue", label: "Venue" },
  { value: "judges", label: "Judges" },
  { value: "event_staff", label: "Event Staff" },
  { value: "contractors", label: "Contractors" },
  { value: "travel", label: "Travel" },
  { value: "lodging", label: "Lodging" },
  { value: "awards_prizes", label: "Awards and Prizes" },
  { value: "security", label: "Security" },
  { value: "insurance", label: "Insurance" },
  { value: "marketing", label: "Marketing" },
  { value: "equipment", label: "Equipment" },
  { value: "catering", label: "Catering" },
  { value: "vendor_services", label: "Vendor Services" },
  { value: "technology", label: "Technology" },
  { value: "event_expense", label: "Other Event Expense" },
  { value: "other", label: "Other" },
];

const allExpenseCategories = Array.from(
  new Map(
    [...organizerExpenseCategories, ...studioExpenseCategories].map(
      (category) => [category.value, category],
    ),
  ).values(),
);

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
  return allExpenseCategories.find((category) => category.value === value)?.label ?? "Other";
}

function paymentMethodLabel(value: string) {
  return paymentMethods.find((method) => method.value === value)?.label ?? "Other";
}

function frequencyLabel(value: RecurringExpenseRow["frequency"]) {
  return {
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    annually: "Annually",
  }[value];
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

  const isOrganizerWorkspace = isOrganizerWorkspaceRole(context.studioRole);
  const expenseCategories = isOrganizerWorkspace
    ? organizerExpenseCategories
    : studioExpenseCategories;

  const allowManage = Boolean(context.isPlatformAdmin) ||
    canManageOrganizerExpenses(context.studioRole) ||
    ["studio_owner", "studio_admin", "independent_instructor"].includes(
      context.studioRole ?? "",
    );

  const [
    { data: expenses, error: expensesError },
    { data: eventOptions, error: eventOptionsError },
    { data: recurringExpenses, error: recurringExpensesError },
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

    supabase
      .from("recurring_expense_schedules")
      .select(`
        id,
        vendor_name,
        category,
        amount,
        currency,
        payment_method,
        related_event_id,
        notes,
        frequency,
        next_due_date,
        end_date,
        status
      `)
      .eq("studio_id", context.studioId)
      .neq("status", "completed")
      .order("next_due_date", { ascending: true })
      .limit(100),
  ]);

  if (expensesError) {
    throw new Error(`Could not load expenses: ${expensesError.message}`);
  }

  if (eventOptionsError) {
    throw new Error(`Could not load events for expenses: ${eventOptionsError.message}`);
  }

  if (recurringExpensesError) {
    throw new Error(`Could not load recurring expenses: ${recurringExpensesError.message}`);
  }

  const typedExpenses = (expenses ?? []) as ExpenseRow[];
  const typedRecurringExpenses = (recurringExpenses ?? []) as RecurringExpenseRow[];
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
  const thirtyDaysFromToday = new Date();
  thirtyDaysFromToday.setDate(thirtyDaysFromToday.getDate() + 30);
  const thirtyDayKey = thirtyDaysFromToday.toISOString().slice(0, 10);
  const expectedNextThirtyDays = typedRecurringExpenses
    .filter(
      (expense) =>
        expense.status === "active" &&
        expense.next_due_date >= today &&
        expense.next_due_date <= thirtyDayKey
    )
    .reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <SellWorkspaceHeader
        role={context.studioRole}
        isPlatformAdmin={context.isPlatformAdmin}
        eyebrow={isOrganizerWorkspace ? "Organizer accounting" : "Financial administration"}
        title={isOrganizerWorkspace ? "Event Expenses" : "Expenses"}
        description="Record business expenses and predictable costs so reports and profitability views reflect the studio's real financial picture."
      />

      {!isOrganizerWorkspace ? (
        <section className="rounded-2xl border border-orange-200 bg-orange-50 p-5">
          <h2 className="font-semibold text-orange-950">Floor fees paid to outside studios belong here</h2>
          <p className="mt-1 text-sm leading-6 text-orange-900">
            Record outside-studio floor rental as a Floor Rental / Floor Fee expense. Host-studio floor-rental collections belong in revenue, not expenses.
          </p>
        </section>
      ) : null}

      <CompactSummaryStrip
        className="rounded-2xl border border-[var(--brand-border)] bg-white"
        items={[
          { key: "total", label: isOrganizerWorkspace ? "Event expenses" : "Total expenses", value: formatCurrency(totalExpenses), detail: "Most recent 100 records" },
          { key: "floor-fees", label: "Floor fees", value: formatCurrency(floorFeeTotal), detail: "Rental and floor costs" },
          { key: "records", label: "Expense records", value: activeExpenses.length, detail: "Active recent records" },
          { key: "expected", label: "Next 30 days", value: formatCurrency(expectedNextThirtyDays), detail: "Expected recurring costs", tone: expectedNextThirtyDays > 0 ? "info" as const : "default" as const },
        ]}
      />

      {allowManage ? (
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Plus className="h-5 w-5" />
            </div>

            <div>
              <h2 className="text-xl font-semibold text-slate-950">
                Add expense
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
                {isOrganizerWorkspace ? "Vendor / Payee Name *" : "Vendor / Studio Name *"}
              </label>
              <input
                type="text"
                name="vendor_name"
                maxLength={160}
                placeholder={
                  isOrganizerWorkspace
                    ? "Example: Downtown Convention Center"
                    : "Example: Confidance Studio"
                }
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

            <details className="lg:col-span-2 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/25 p-4">
              <summary className="cursor-pointer list-none">
                <span className="block text-sm font-semibold text-slate-900">
                  Repeat this expense
                </span>
                <span className="mt-1 block text-xs leading-5 text-slate-500">
                  Open to schedule predictable costs like rent, insurance, and software.
                </span>
              </summary>

              <label className="mt-4 flex items-center gap-2 text-sm font-semibold text-slate-800">
                <input
                  type="checkbox"
                  name="repeat_expense"
                  className="h-4 w-4 rounded border-slate-300"
                />
                Create a recurring schedule
              </label>

              <div className="mt-4 grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 lg:grid-cols-3">
                <label className="text-sm font-medium text-slate-700">
                  Frequency
                  <select
                    name="recurring_frequency"
                    defaultValue="monthly"
                    className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="annually">Annually</option>
                  </select>
                </label>

                <label className="text-sm font-medium text-slate-700">
                  Next expected date
                  <input
                    type="date"
                    name="recurring_next_date"
                    className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                  <span className="mt-1 block text-xs font-normal text-slate-500">
                    Leave blank to use the next interval automatically.
                  </span>
                </label>

                <label className="text-sm font-medium text-slate-700">
                  Optional end date
                  <input
                    type="date"
                    name="recurring_end_date"
                    className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                </label>
              </div>
            </details>

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
                Add expense
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Repeat2 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Expected Expenses
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Predictable expenses stay here until they are recorded as paid.
              </p>
            </div>
          </div>
        </div>

        {typedRecurringExpenses.length === 0 ? (
          <div className="p-4 sm:p-6">
            <SellWorkspaceEmptyState
              title="No expected expenses scheduled"
              description="Use Repeat this expense when adding rent, insurance, software, or another predictable cost."
              compact
            />
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {typedRecurringExpenses.map((expense) => (
              <div
                key={expense.id}
                className="flex flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-950">
                      {expense.vendor_name}
                    </p>
                    <span className="rounded-full bg-[var(--brand-primary-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--brand-primary)]">
                      {frequencyLabel(expense.frequency)}
                    </span>
                    {expense.status === "paused" ? (
                      <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                        Paused
                      </span>
                    ) : (
                      <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-800">
                        Expected
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-slate-600">
                    {categoryLabel(expense.category)} · Next {formatDate(expense.next_due_date)}
                    {expense.end_date ? ` · Ends ${formatDate(expense.end_date)}` : ""}
                  </p>
                  {expense.notes ? (
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {expense.notes}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <p className="text-lg font-semibold text-slate-950">
                    {formatCurrency(expense.amount, expense.currency)}
                  </p>

                  {allowManage ? (
                    <div className="flex flex-wrap gap-2">
                      {expense.status === "active" ? (
                        <>
                          <form action={recordRecurringExpenseAction}>
                            <input type="hidden" name="schedule_id" value={expense.id} />
                            <button className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--brand-primary)] px-3 py-2 text-xs font-semibold text-white">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Record as paid
                            </button>
                          </form>

                          <form action={skipRecurringExpenseAction}>
                            <input type="hidden" name="schedule_id" value={expense.id} />
                            <button className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                              <SkipForward className="h-3.5 w-3.5" />
                              Skip next
                            </button>
                          </form>

                          <form action={setRecurringExpenseStatusAction}>
                            <input type="hidden" name="schedule_id" value={expense.id} />
                            <input type="hidden" name="status" value="paused" />
                            <button className="inline-flex items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                              <Pause className="h-3.5 w-3.5" />
                              Pause
                            </button>
                          </form>
                        </>
                      ) : (
                        <form action={setRecurringExpenseStatusAction}>
                          <input type="hidden" name="schedule_id" value={expense.id} />
                          <input type="hidden" name="status" value="active" />
                          <button className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white">
                            <Play className="h-3.5 w-3.5" />
                            Resume
                          </button>
                        </form>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">
            {isOrganizerWorkspace ? "Recent Event Expenses" : "Recent Expenses"}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Review the most recent expense records for this workspace.
          </p>
        </div>

        {typedExpenses.length === 0 ? (
          <div className="p-4 sm:p-6">
            <SellWorkspaceEmptyState
              title="No expenses recorded yet"
              description="Add an expense to begin tracking business costs and improve financial reporting."
            />
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