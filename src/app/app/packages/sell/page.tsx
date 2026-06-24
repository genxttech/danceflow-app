import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManagePackages } from "@/lib/auth/permissions";
import { Filter, Package2, Search, ShoppingBag, Users } from "lucide-react";
import { sellSelectedPackageFromSellPageAction } from "./actions";

type SearchParams = Promise<{
  q?: string;
  template?: string;
  client?: string;
  error?: string;
}>;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  status: string | null;
};

type PackageTemplateRow = {
  id: string;
  name: string;
  price: number;
  active: boolean;
  expiration_days: number | null;
  package_template_items:
    | {
        usage_type: string;
        quantity: number | null;
        is_unlimited: boolean;
      }[]
    | null;
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function formatPackageItems(items: PackageTemplateRow["package_template_items"]) {
  if (!items || items.length === 0) return "No included items listed";

  return items
    .map((item) => {
      const label =
        item.usage_type === "private_lesson"
          ? "Private lessons"
          : item.usage_type === "group_class"
            ? "Group classes"
            : "Practice sessions";

      return item.is_unlimited ? `${label}: Unlimited` : `${label}: ${item.quantity ?? 0}`;
    })
    .join(" • ");
}

function matchesSearch(client: ClientRow, q: string) {
  if (!q) return true;
  const haystack = `${client.first_name} ${client.last_name} ${client.email ?? ""}`.toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function getDateInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";

  return `${year}-${month}-${day}`;
}

export default async function SellPackagesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const query = (params.q ?? "").trim();
  const templateFilter = params.template ?? "all";
  const selectedClientId = params.client ?? null;
  const actionError = (params.error ?? "").trim();
  const todayForStudio = getDateInTimeZone(new Date(), "America/New_York");

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const role = context.studioRole ?? "";

  if (!canManagePackages(role) && !context.isPlatformAdmin) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [{ data: templates, error: templatesError }, { data: clients, error: clientsError }] =
    await Promise.all([
      supabase
        .from("package_templates")
        .select(`
          id,
          name,
          price,
          active,
          expiration_days,
          package_template_items (
            usage_type,
            quantity,
            is_unlimited
          )
        `)
        .eq("studio_id", studioId)
        .eq("active", true)
        .order("name", { ascending: true }),
      supabase
        .from("clients")
        .select("id, first_name, last_name, email, status")
        .eq("studio_id", studioId)
        .in("status", ["active", "lead", "inactive"])
        .order("first_name", { ascending: true })
        .limit(200),
    ]);

  if (templatesError) {
    throw new Error(`Failed to load package templates: ${templatesError.message}`);
  }

  if (clientsError) {
    throw new Error(`Failed to load clients: ${clientsError.message}`);
  }

  const typedTemplates = ((templates ?? []) as PackageTemplateRow[]).filter((t) =>
    templateFilter === "all" ? true : t.id === templateFilter
  );
  const selectedTemplate =
    ((templates ?? []) as PackageTemplateRow[]).find((t) => t.id === templateFilter) ?? null;
  const typedClients = ((clients ?? []) as ClientRow[]).filter((client) =>
    matchesSearch(client, query)
  );
  const selectedClient =
    ((clients ?? []) as ClientRow[]).find((client) => client.id === selectedClientId) ?? null;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Package Sales
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Sell a package
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Pick a package, choose the client, then confirm the payment method and amount before creating the sale.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/packages"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Package Templates
              </Link>
              <Link
                href="/app/clients"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Client List
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">Start with the package</h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Choose the package you want to sell first. That makes it easier to move quickly when the client is ready to buy.
              </p>
            </div>
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">Find the right client fast</h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Search by name or email to narrow the list, then select the client to open the sale form.
              </p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">Keep the task simple</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                This page does not assume cash. Staff must confirm payment details before the package and payment record are created.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Active Packages</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {(templates ?? []).length}
              </p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Package2 className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Visible Clients</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{typedClients.length}</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Users className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Selected Package</p>
              <p className="mt-2 text-xl font-semibold text-slate-950">
                {selectedTemplate ? selectedTemplate.name : "Choose any package"}
              </p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <ShoppingBag className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      {actionError ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
          {actionError}
        </div>
      ) : null}

      <form className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Filter className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Choose a package and search for a client</h2>
            <p className="mt-1 text-sm text-slate-500">
              Filter the package sale list before starting the sale workflow.
            </p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_320px_auto]">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Search client</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                name="q"
                defaultValue={query}
                placeholder="Name or email"
                className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 outline-none ring-0 transition focus:border-[var(--brand-primary)]"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Package</span>
            <select
              name="template"
              defaultValue={templateFilter}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
            >
              <option value="all">All active packages</option>
              {((templates ?? []) as PackageTemplateRow[]).map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
            >
              Update List
            </button>
          </div>
        </div>
      </form>

      {params.error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {params.error}
        </div>
      ) : null}

      {selectedTemplate && selectedClient ? (
        <section className="rounded-[28px] border border-[var(--brand-border)] bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
                Confirm package sale
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                {selectedTemplate.name} for {selectedClient.first_name} {selectedClient.last_name}
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                Confirm the sale date, payment method, amount collected, and any account credit before creating the package. This keeps package balances and accounting aligned.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <p className="font-medium text-slate-950">Package price</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                {formatCurrency(selectedTemplate.price)}
              </p>
            </div>
          </div>

          <form action={sellSelectedPackageFromSellPageAction} className="mt-6 grid gap-4 lg:grid-cols-2">
            <input type="hidden" name="clientId" value={selectedClient.id} />
            <input type="hidden" name="packageTemplateId" value={selectedTemplate.id} />
            <input type="hidden" name="q" value={query} />

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Sale date</span>
              <input
                type="date"
                name="purchaseDate"
                defaultValue={todayForStudio}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
                required
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Payment method</span>
              <select
                name="paymentMethod"
                defaultValue="cash"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
                required
              >
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="check">Check</option>
                <option value="venmo">Venmo</option>
                <option value="zelle">Zelle</option>
                <option value="other">Other</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Amount collected</span>
              <input
                type="text"
                name="paymentAmount"
                defaultValue={String(selectedTemplate.price ?? 0)}
                placeholder="0.00"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
                required
              />
              <p className="mt-1 text-xs text-slate-500">
                Enter the actual amount collected now. Do not leave the default price if this was not paid in full.
              </p>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Account credit to apply</span>
              <input
                type="text"
                name="accountCreditToApply"
                defaultValue="0"
                placeholder="0.00"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
              />
            </label>

            <label className="block lg:col-span-2">
              <span className="mb-2 block text-sm font-medium text-slate-700">Sale notes</span>
              <textarea
                name="notes"
                rows={3}
                placeholder="Optional internal note about this package sale"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
              />
            </label>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900 lg:col-span-2">
              Complete manual sale records money already collected. Send to card reader keeps the package inactive until Stripe confirms the in-person payment. Account credit cannot be combined with the card reader yet.
            </div>

            <div className="flex flex-wrap gap-3 lg:col-span-2">
              <button
                type="submit"
                name="paymentAction"
                value="manual"
                className="rounded-xl bg-[var(--brand-primary)] px-5 py-2.5 text-sm font-medium text-white hover:opacity-95"
              >
                Complete manual sale
              </button>
              <button
                type="submit"
                name="paymentAction"
                value="terminal"
                className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Send to card reader
              </button>
              <Link
                href={`/app/packages/sell${selectedTemplate ? `?template=${selectedTemplate.id}` : ""}`}
                className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </Link>
            </div>
          </form>
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-950">Available package templates</h2>
          <p className="mt-1 text-sm text-slate-500">
            Review package details before choosing a client.
          </p>

          <div className="mt-5 space-y-3">
            {typedTemplates.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                No package templates match this filter.
              </div>
            ) : (
              typedTemplates.map((template) => {
                const isSelected = selectedTemplate?.id === template.id;

                return (
                  <div
                    key={template.id}
                    className={`rounded-2xl border p-4 transition ${
                      isSelected
                        ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 shadow-sm ring-2 ring-[var(--brand-primary)]/20"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-slate-900">{template.name}</p>
                          {isSelected ? (
                            <span className="rounded-full bg-[var(--brand-primary)] px-2.5 py-1 text-xs font-semibold text-white">
                              Selected
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatCurrency(template.price)}
                          {template.expiration_days
                            ? ` • Expires in ${template.expiration_days} days`
                            : " • No set expiration"}
                        </p>
                        <p className="mt-2 text-sm text-slate-500">
                          {formatPackageItems(template.package_template_items)}
                        </p>
                      </div>

                      <Link
                        href={`/app/packages/sell?template=${template.id}`}
                        className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${
                          isSelected
                            ? "border-[var(--brand-primary)] bg-white text-[var(--brand-primary)]"
                            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                        }`}
                        aria-current={isSelected ? "true" : undefined}
                      >
                        {isSelected ? "Selected" : "Choose"}
                      </Link>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-950">Clients ready for package sale</h2>
          <p className="mt-1 text-sm text-slate-500">
            Choose a client to open the sale form with payment details.
          </p>

          <div className="mt-5 space-y-3">
            {typedClients.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                No clients match your search.
              </div>
            ) : (
              typedClients.map((client) => (
                <div key={client.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-medium text-slate-900">
                        {client.first_name} {client.last_name}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">{client.email || "No email on file"}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        Status: {client.status ? client.status.replaceAll("_", " ") : "—"}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <Link
                        href={`/app/clients/${client.id}`}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                      >
                        Open Client
                      </Link>
                      {selectedTemplate ? (
                        <Link
                          href={`/app/packages/sell?template=${selectedTemplate.id}&client=${client.id}${query ? `&q=${encodeURIComponent(query)}` : ""}`}
                          className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-95"
                        >
                          Start Sale
                        </Link>
                      ) : (
                        <Link
                          href={`/app/clients/${client.id}`}
                          className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-95"
                        >
                          Open to Sell Package
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

