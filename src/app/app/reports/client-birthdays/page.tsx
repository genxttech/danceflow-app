import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  Cake,
  Download,
  Mail,
  MapPin,
  Search,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { canViewReports } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type SearchParams = Promise<{
  range?: string;
  q?: string;
}>;

type ClientBirthdayRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  birthday: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  created_at: string | null;
};

type BirthdayClient = ClientBirthdayRow & {
  fullName: string;
  formattedBirthday: string;
  nextBirthday: Date | null;
  daysUntilBirthday: number | null;
  mailingAddress: string;
  hasMailingAddress: boolean;
};

const rangeOptions = [
  { value: "next7", label: "Next 7 days" },
  { value: "next30", label: "Next 30 days" },
  { value: "this_month", label: "This month" },
  { value: "next_month", label: "Next month" },
  { value: "missing_birthdays", label: "Missing birthday" },
  { value: "missing_addresses", label: "Missing mailing address" },
  { value: "missing_profile_info", label: "Missing profile info" },
  { value: "all", label: "All clients" },
];

function normalizeRange(range: string | undefined) {
  return rangeOptions.some((option) => option.value === range) ? range ?? "next30" : "next30";
}

function todayUtcDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function parseBirthdayParts(value: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function getNextBirthday(value: string | null, today = todayUtcDateOnly()) {
  const parts = parseBirthdayParts(value);
  if (!parts) return null;

  const year = today.getUTCFullYear();
  let next = new Date(Date.UTC(year, parts.month - 1, parts.day));

  if (next < today) {
    next = new Date(Date.UTC(year + 1, parts.month - 1, parts.day));
  }

  return next;
}

function getDaysUntil(date: Date | null, today = todayUtcDateOnly()) {
  if (!date) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((date.getTime() - today.getTime()) / msPerDay);
}

function formatBirthday(value: string | null) {
  const parts = parseBirthdayParts(value);
  if (!parts) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(2000, parts.month - 1, parts.day)));
}

function formatNextBirthday(date: Date | null) {
  if (!date) return "Not scheduled";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatClientName(client: ClientBirthdayRow) {
  const name = [client.first_name, client.last_name].filter(Boolean).join(" ").trim();
  return name || "Unnamed client";
}

function formatMailingAddress(client: ClientBirthdayRow) {
  const street = [client.address_line1, client.address_line2].filter(Boolean).join(" ").trim();
  const cityStatePostal = [client.city, client.state, client.postal_code]
    .filter(Boolean)
    .join(", ")
    .replace(/, ([^,]*)$/, " $1")
    .trim();

  return [street, cityStatePostal, client.country].filter(Boolean).join(" • ");
}

function enhanceClient(client: ClientBirthdayRow): BirthdayClient {
  const nextBirthday = getNextBirthday(client.birthday);
  const mailingAddress = formatMailingAddress(client);

  return {
    ...client,
    fullName: formatClientName(client),
    formattedBirthday: formatBirthday(client.birthday),
    nextBirthday,
    daysUntilBirthday: getDaysUntil(nextBirthday),
    mailingAddress,
    hasMailingAddress: Boolean(mailingAddress),
  };
}

function getNextMonthNumber(today = todayUtcDateOnly()) {
  return today.getUTCMonth() === 11 ? 1 : today.getUTCMonth() + 2;
}

function filterClients(clients: BirthdayClient[], range: string, query: string) {
  const today = todayUtcDateOnly();
  const thisMonth = today.getUTCMonth() + 1;
  const nextMonth = getNextMonthNumber(today);
  const normalizedQuery = query.trim().toLowerCase();

  return clients
    .filter((client) => {
      if (range === "missing_birthdays") return !client.birthday;
      if (range === "missing_addresses") return !client.hasMailingAddress;
      if (range === "missing_profile_info") {
        return !client.birthday || !client.hasMailingAddress || !client.email || !client.phone;
      }
      if (range === "all") return true;

      if (!client.birthday || client.daysUntilBirthday === null) return false;

      const parts = parseBirthdayParts(client.birthday);
      if (!parts) return false;

      if (range === "next7") return client.daysUntilBirthday <= 7;
      if (range === "next30") return client.daysUntilBirthday <= 30;
      if (range === "this_month") return parts.month === thisMonth;
      if (range === "next_month") return parts.month === nextMonth;

      return client.daysUntilBirthday <= 30;
    })
    .filter((client) => {
      if (!normalizedQuery) return true;

      return [
        client.fullName,
        client.email ?? "",
        client.phone ?? "",
        client.mailingAddress,
        client.status ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((a, b) => {
      if (range === "missing_birthdays" || range === "missing_addresses" || range === "missing_profile_info") {
        return a.fullName.localeCompare(b.fullName);
      }

      return (a.daysUntilBirthday ?? 9999) - (b.daysUntilBirthday ?? 9999);
    });
}

function birthdayBadge(client: BirthdayClient) {
  if (client.daysUntilBirthday === null) return "Missing birthday";
  if (client.daysUntilBirthday === 0) return "Today";
  if (client.daysUntilBirthday === 1) return "Tomorrow";
  return `In ${client.daysUntilBirthday} days`;
}

export default async function ClientBirthdaysReportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const range = normalizeRange(params.range);
  const query = params.q ?? "";

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;

  if (!studioId) {
    redirect("/app");
  }

  const { data, error } = await supabase
    .from("clients")
    .select(
      `
      id,
      first_name,
      last_name,
      email,
      phone,
      status,
      birthday,
      address_line1,
      address_line2,
      city,
      state,
      postal_code,
      country,
      created_at
    `,
    )
    .eq("studio_id", studioId)
    .order("last_name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const clients = ((data ?? []) as ClientBirthdayRow[]).map(enhanceClient);
  const filteredClients = filterClients(clients, range, query);
  const upcoming30 = clients.filter(
    (client) => client.daysUntilBirthday !== null && client.daysUntilBirthday <= 30,
  ).length;
  const missingBirthdays = clients.filter((client) => !client.birthday).length;
  const missingAddresses = clients.filter((client) => !client.hasMailingAddress).length;
  const missingProfileInfo = clients.filter(
    (client) => !client.birthday || !client.hasMailingAddress || !client.email || !client.phone,
  ).length;
  const readyForCards = clients.filter(
    (client) =>
      client.daysUntilBirthday !== null &&
      client.daysUntilBirthday <= 30 &&
      client.hasMailingAddress,
  ).length;

  const exportHref = `/app/reports/client-birthdays/export?range=${encodeURIComponent(
    range,
  )}${query ? `&q=${encodeURIComponent(query)}` : ""}`;
  const labelExportHref = `${exportHref}&format=labels`;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-gradient-to-r from-[#2D0B45] via-[#5B197A] to-[#7C2D92] text-white shadow-sm">
        <div className="flex flex-col gap-6 px-6 py-6 md:flex-row md:items-start md:justify-between md:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#F3D7FF]">
              DanceFlow CRM Reports
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Client Birthdays & Mailing List
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/85 md:text-base">
              See upcoming birthdays, find missing contact details, and export a
              clean mailing list for birthday cards and client appreciation.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row md:flex-col lg:flex-row">
            <Link
              href="/app/reports"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/15"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Reports
            </Link>
            <Link
              href={exportHref}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#5B197A] transition hover:bg-[#F3E8FF]"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Link>
            <Link
              href={labelExportHref}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
            >
              <MapPin className="h-4 w-4" />
              Export mailing labels
            </Link>
          </div>
        </div>

        <div className="grid gap-3 border-t border-white/10 bg-black/10 px-6 py-4 md:grid-cols-5 md:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Upcoming
            </p>
            <p className="mt-1 text-2xl font-semibold">{upcoming30}</p>
            <p className="text-xs text-white/70">next 30 days</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Card-ready
            </p>
            <p className="mt-1 text-2xl font-semibold">{readyForCards}</p>
            <p className="text-xs text-white/70">birthday + address</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Missing birthday
            </p>
            <p className="mt-1 text-2xl font-semibold">{missingBirthdays}</p>
            <p className="text-xs text-white/70">needs profile update</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Missing address
            </p>
            <p className="mt-1 text-2xl font-semibold">{missingAddresses}</p>
            <p className="text-xs text-white/70">not card-ready</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Missing profile
            </p>
            <p className="mt-1 text-2xl font-semibold">{missingProfileInfo}</p>
            <p className="text-xs text-white/70">birthday, contact, or address</p>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <form className="grid gap-4 md:grid-cols-[220px_1fr_auto] md:items-end">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">View</span>
            <select
              name="range"
              defaultValue={range}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-[#7C2D92] focus:outline-none focus:ring-2 focus:ring-[#E9D5FF]"
            >
              {rangeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Search</span>
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                name="q"
                defaultValue={query}
                placeholder="Search by name, email, phone, status, or address"
                className="w-full rounded-xl border border-slate-300 py-2 pl-9 pr-3 text-sm text-slate-900 shadow-sm focus:border-[#7C2D92] focus:outline-none focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>
          </label>

          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-xl bg-[#7C2D92] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#5B197A]"
          >
            Apply Filters
          </button>
        </form>
      </section>

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-slate-200 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Birthday Outreach List
            </h2>
            <p className="text-sm text-slate-600">
              {filteredClients.length} client{filteredClients.length === 1 ? "" : "s"} in this view
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={exportHref}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              Export this view
            </Link>
            <Link
              href={labelExportHref}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#D8B4FE] px-3 py-2 text-sm font-semibold text-[#6B21A8] transition hover:bg-[#FCF8FF]"
            >
              <MapPin className="h-4 w-4" />
              Labels
            </Link>
          </div>
        </div>

        {filteredClients.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#F3E8FF] text-[#7C2D92]">
              <Cake className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-slate-950">
              No clients found
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
              Try a different range or update client profiles with birthdays and
              mailing addresses.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredClients.map((client) => (
              <div
                key={client.id}
                className="grid gap-4 px-5 py-4 md:grid-cols-[1.2fr_0.9fr_1.4fr_auto] md:items-center"
              >
                <div>
                  <Link
                    href={`/app/clients/${client.id}`}
                    className="font-semibold text-slate-950 transition hover:text-[#7C2D92]"
                  >
                    {client.fullName}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-600">
                    {client.email ? (
                      <span className="inline-flex items-center gap-1">
                        <Mail className="h-3.5 w-3.5" />
                        {client.email}
                      </span>
                    ) : null}
                    {client.phone ? <span>{client.phone}</span> : null}
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold text-slate-950">
                    {client.formattedBirthday}
                  </p>
                  <p className="text-sm text-slate-600">
                    {client.nextBirthday ? formatNextBirthday(client.nextBirthday) : "Add birthday"}
                  </p>
                </div>

                <div>
                  {client.hasMailingAddress ? (
                    <p className="inline-flex items-start gap-2 text-sm leading-6 text-slate-700">
                      <MapPin className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                      <span>{client.mailingAddress}</span>
                    </p>
                  ) : (
                    <p className="text-sm text-amber-700">Missing mailing address</p>
                  )}
                </div>

                <div className="md:text-right">
                  <span className="inline-flex rounded-full bg-[#F3E8FF] px-3 py-1 text-xs font-semibold text-[#6B21A8]">
                    {birthdayBadge(client)}
                  </span>
                  <div className="mt-2">
                    <Link
                      href={`/app/clients/${client.id}/edit`}
                      className="text-sm font-semibold text-[#7C2D92] hover:text-[#5B197A]"
                    >
                      Edit profile
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#F3E8FF] text-[#7C2D92]">
            <Cake className="h-5 w-5" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-slate-950">
            Birthday cards
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Use the next 30 days view to prepare handwritten cards before the
            month gets busy.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FEF3C7] text-[#92400E]">
            <MapPin className="h-5 w-5" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-slate-950">
            Address cleanup
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            The missing address view gives front desk staff a simple call list
            before sending cards.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#DBEAFE] text-[#1D4ED8]">
            <Users className="h-5 w-5" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-slate-950">
            Client retention
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Small personal touches help studios build stronger relationships and
            keep dancers engaged.
          </p>
        </div>
      </section>
    </div>
  );
}
