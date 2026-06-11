import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canViewReports } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { toCsv } from "@/lib/utils/csv";

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
};

type BirthdayClient = ClientBirthdayRow & {
  fullName: string;
  formattedBirthday: string;
  nextBirthday: Date | null;
  daysUntilBirthday: number | null;
  mailingAddress: string;
  hasMailingAddress: boolean;
};

const validRanges = new Set([
  "next7",
  "next30",
  "this_month",
  "next_month",
  "missing_birthdays",
  "missing_addresses",
  "missing_profile_info",
  "all",
]);

function normalizeRange(range: string | null) {
  return range && validRanges.has(range) ? range : "next30";
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
  if (!parts) return "";

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(2000, parts.month - 1, parts.day)));
}

function formatNextBirthday(date: Date | null) {
  if (!date) return "";

  return date.toISOString().slice(0, 10);
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

  return [street, cityStatePostal, client.country].filter(Boolean).join(" | ");
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const range = normalizeRange(url.searchParams.get("range"));
  const query = url.searchParams.get("q") ?? "";
  const format = url.searchParams.get("format") ?? "standard";

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const context = await getCurrentStudioContext();

  if (!context.studioId || !canViewReports(context.studioRole ?? "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      country
    `,
    )
    .eq("studio_id", context.studioId)
    .order("last_name", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const clients = filterClients(((data ?? []) as ClientBirthdayRow[]).map(enhanceClient), range, query);
  const isLabelExport = format === "labels";
  const exportClients = isLabelExport
    ? clients.filter((client) => client.hasMailingAddress)
    : clients;

  const csv = isLabelExport
    ? toCsv(
        [
          "Client Name",
          "Address Line 1",
          "Address Line 2",
          "City",
          "State",
          "Postal Code",
          "Country",
          "Birthday",
          "Next Birthday",
          "Days Until Birthday",
        ],
        exportClients.map((client) => [
          client.fullName,
          client.address_line1 ?? "",
          client.address_line2 ?? "",
          client.city ?? "",
          client.state ?? "",
          client.postal_code ?? "",
          client.country ?? "",
          client.formattedBirthday,
          formatNextBirthday(client.nextBirthday),
          client.daysUntilBirthday ?? "",
        ]),
      )
    : toCsv(
        [
          "Client Name",
          "Birthday",
          "Next Birthday",
          "Days Until Birthday",
          "Email",
          "Phone",
          "Status",
          "Address Line 1",
          "Address Line 2",
          "City",
          "State",
          "Postal Code",
          "Country",
          "Mailing Address",
          "Client ID",
        ],
        exportClients.map((client) => [
          client.fullName,
          client.formattedBirthday,
          formatNextBirthday(client.nextBirthday),
          client.daysUntilBirthday ?? "",
          client.email ?? "",
          client.phone ?? "",
          client.status ?? "",
          client.address_line1 ?? "",
          client.address_line2 ?? "",
          client.city ?? "",
          client.state ?? "",
          client.postal_code ?? "",
          client.country ?? "",
          client.mailingAddress,
          client.id,
        ]),
      );

  const filename = isLabelExport
    ? `danceflow-client-mailing-labels-${range}.csv`
    : `danceflow-client-birthdays-${range}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
