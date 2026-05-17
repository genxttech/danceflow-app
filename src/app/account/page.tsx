import Link from "next/link";
import { redirect } from "next/navigation";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import { createClient } from "@/lib/supabase/server";

type FavoriteRow = {
  studio_id: string | null;
  event_id: string | null;
  created_at: string;
};

type RegistrationRow = {
  id: string;
  event_id: string | null;
  status: string | null;
  created_at: string;
};

type StudioRow = {
  id: string;
  slug: string | null;
  name: string;
  public_name: string | null;
  city: string | null;
  state: string | null;
};

type EventRow = {
  id: string;
  slug: string | null;
  name: string;
  start_date: string | null;
  city: string | null;
  state: string | null;
};

type PortalLinkRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  is_independent_instructor: boolean | null;
  studios:
    | {
        id: string;
        slug: string | null;
        name: string;
        public_name: string | null;
        city: string | null;
        state: string | null;
      }
    | {
        id: string;
        slug: string | null;
        name: string;
        public_name: string | null;
        city: string | null;
        state: string | null;
      }[]
    | null;
};

type FavoriteStudioItem = {
  studio: StudioRow;
  createdAt: string;
};

type FavoriteEventItem = {
  event: EventRow;
  createdAt: string;
};

type RegisteredEventItem = {
  registrationId: string;
  status: string;
  createdAt: string;
  event: EventRow;
};

type LinkedPortalItem = {
  clientId: string;
  studioId: string;
  studioSlug: string;
  studioName: string;
  location: string;
  isIndependentInstructor: boolean;
  clientName: string;
};

type ClientAccountLedgerRow = {
  id: string;
  studio_id: string;
  client_id: string;
  entry_date: string;
  entry_type: string;
  direction: "credit" | "debit";
  amount: number | string;
  description: string | null;
  created_at: string;
};

type AccountBalanceItem = {
  clientId: string;
  studioId: string;
  studioName: string;
  clientName: string;
  creditTotal: number;
  debitTotal: number;
  netBalance: number;
  recentEntries: ClientAccountLedgerRow[];
};

function formatDate(value: string | null) {
  if (!value) return "Date coming soon";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatLedgerEntryType(value: string) {
  return value
    .replaceAll("_", " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parseLedgerAmount(value: number | string) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getEventLocation(event: EventRow) {
  return (
    [event.city, event.state].filter(Boolean).join(", ") ||
    "Location coming soon"
  );
}

function getStudioLocation(studio: StudioRow) {
  return (
    [studio.city, studio.state].filter(Boolean).join(", ") ||
    "Location coming soon"
  );
}

function getPortalStudio(value: PortalLinkRow["studios"]): {
  id: string;
  slug: string | null;
  name: string;
  public_name: string | null;
  city: string | null;
  state: string | null;
} | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function formatStatus(value: string) {
  return value
    .replaceAll("_", " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function AccountStatCard({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: number;
  detail: string;
  className: string;
}) {
  return (
    <div className={`rounded-3xl border p-5 shadow-sm ${className}`}>
      <p className="text-sm font-medium text-slate-600">{label}</p>
      <p className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
        {value}
      </p>
      <p className="mt-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
        {detail}
      </p>
    </div>
  );
}

function QuickActionCard({
  eyebrow,
  title,
  description,
  href,
  className,
}: {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  className: string;
}) {
  return (
    <Link
      href={href}
      className={`block rounded-3xl border p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${className}`}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {eyebrow}
      </p>
      <p className="mt-3 text-lg font-semibold text-slate-950">{title}</p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
      <p className="mt-4 text-sm font-semibold text-slate-900">Open →</p>
    </Link>
  );
}

function EmptyState({
  title,
  description,
  href,
  actionLabel,
}: {
  title: string;
  description: string;
  href?: string;
  actionLabel?: string;
}) {
  return (
    <div className="mt-6 rounded-[28px] border border-dashed border-slate-300 bg-slate-50/80 p-8 text-center sm:p-10">
      <p className="text-lg font-semibold text-slate-950">{title}</p>
      <p className="mx-auto mt-2 max-w-2xl text-sm leading-7 text-slate-600">
        {description}
      </p>
      {href && actionLabel ? (
        <Link
          href={href}
          className="mt-5 inline-flex rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  actionHref,
  actionLabel,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-600">
          {eyebrow}
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
          {title}
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
          {description}
        </p>
      </div>

      {actionHref && actionLabel ? (
        <Link
          href={actionHref}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50"
        >
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

function AccountBalanceCards({ balances }: { balances: AccountBalanceItem[] }) {
  if (balances.length === 0) {
    return null;
  }

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      {balances.map((balance) => {
        const isCredit = balance.netBalance > 0;
        const isOwed = balance.netBalance < 0;
        const recentEntries = balance.recentEntries.slice(0, 5);

        return (
          <div
            key={`${balance.studioId}-${balance.clientId}`}
            className="rounded-[28px] border border-amber-100 bg-gradient-to-br from-amber-50 via-white to-white p-6 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold text-slate-950">
                  {balance.studioName}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {balance.clientName}
                </p>
              </div>

              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${
                  isCredit
                    ? "bg-emerald-50 text-emerald-800 ring-emerald-100"
                    : isOwed
                      ? "bg-rose-50 text-rose-800 ring-rose-100"
                      : "bg-slate-50 text-slate-700 ring-slate-200"
                }`}
              >
                {isCredit
                  ? "Credit available"
                  : isOwed
                    ? "Balance owed"
                    : "Settled"}
              </span>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-white p-4 ring-1 ring-amber-100">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Credit
                </p>
                <p className="mt-2 text-lg font-semibold text-emerald-700">
                  {formatCurrency(balance.creditTotal)}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-4 ring-1 ring-amber-100">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Owed / Used
                </p>
                <p className="mt-2 text-lg font-semibold text-rose-700">
                  {formatCurrency(balance.debitTotal)}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-4 ring-1 ring-amber-100">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Net
                </p>
                <p className="mt-2 text-lg font-semibold text-slate-950">
                  {formatCurrency(Math.abs(balance.netBalance))}
                </p>
              </div>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-600">
              {isCredit
                ? `You have ${formatCurrency(balance.netBalance)} available credit with this studio.`
                : isOwed
                  ? `You have ${formatCurrency(Math.abs(balance.netBalance))} owed with this studio.`
                  : "Your account balance is currently settled with this studio."}
            </p>

            <details className="mt-5 rounded-2xl border border-amber-100 bg-white p-4">
              <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                Recent account activity
              </summary>

              {recentEntries.length > 0 ? (
                <div className="mt-4 divide-y divide-slate-100">
                  {recentEntries.map((entry) => {
                    const amount = parseLedgerAmount(entry.amount);
                    const isEntryCredit = entry.direction === "credit";

                    return (
                      <div key={entry.id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {formatLedgerEntryType(entry.entry_type)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {formatDate(entry.entry_date)}
                            </p>
                          </div>

                          <p
                            className={`text-sm font-semibold ${
                              isEntryCredit
                                ? "text-emerald-700"
                                : "text-rose-700"
                            }`}
                          >
                            {isEntryCredit ? "+" : "-"}
                            {formatCurrency(amount)}
                          </p>
                        </div>

                        {entry.description ? (
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            {entry.description}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-600">
                  No recent account activity is available yet.
                </p>
              )}
            </details>
          </div>
        );
      })}
    </div>
  );
}

function PortalCards({ linkedPortals }: { linkedPortals: LinkedPortalItem[] }) {
  if (linkedPortals.length === 0) {
    return (
      <EmptyState
        title="No linked studio portals yet"
        description="When a studio links your account or sends you a client portal invite, your studio portals will appear here."
      />
    );
  }

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      {linkedPortals.map((portal) => (
        <Link
          key={`${portal.studioId}-${portal.clientId}`}
          href={`/portal/${portal.studioSlug}`}
          className="group rounded-[28px] border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xl font-semibold text-slate-950">
                {portal.studioName}
              </p>
              <p className="mt-1 text-sm text-slate-600">{portal.location}</p>
            </div>

            <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
              {portal.isIndependentInstructor
                ? "Instructor Portal"
                : "Client Portal"}
            </span>
          </div>

          <p className="mt-5 text-sm text-slate-700">
            Signed in as {portal.clientName}
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Open this studio’s private portal for studio-specific lessons,
            memberships, rentals, and account access.
          </p>
          <p className="mt-5 text-sm font-semibold text-emerald-800 group-hover:text-emerald-900">
            Open portal →
          </p>
        </Link>
      ))}
    </div>
  );
}

function FavoriteStudioCards({ studios }: { studios: FavoriteStudioItem[] }) {
  if (studios.length === 0) {
    return (
      <EmptyState
        title="No favorite studios yet"
        description="Save studios from discovery so you can find them quickly the next time you log in."
        href="/discover/studios"
        actionLabel="Find Studios"
      />
    );
  }

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      {studios.map(({ studio }) => (
        <Link
          key={studio.id}
          href={studio.slug ? `/studios/${studio.slug}` : "/discover/studios"}
          className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <p className="text-lg font-semibold text-slate-950">
            {studio.public_name?.trim() || studio.name}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {getStudioLocation(studio)}
          </p>
          <p className="mt-4 text-sm font-semibold text-slate-800">
            View studio →
          </p>
        </Link>
      ))}
    </div>
  );
}

function FavoriteEventCards({ events }: { events: FavoriteEventItem[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No favorite events yet"
        description="Save public events from discovery and they will appear here for quick access."
        href="/discover/events"
        actionLabel="Find Events"
      />
    );
  }

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      {events.map(({ event }) => (
        <Link
          key={event.id}
          href={event.slug ? `/events/${event.slug}` : "/discover/events"}
          className="rounded-[28px] border border-violet-100 bg-gradient-to-br from-violet-50 via-white to-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <p className="text-lg font-semibold text-slate-950">{event.name}</p>
          <p className="mt-1 text-sm text-slate-600">
            {formatDate(event.start_date)} • {getEventLocation(event)}
          </p>
          <p className="mt-4 text-sm font-semibold text-violet-800">
            View event →
          </p>
        </Link>
      ))}
    </div>
  );
}

function RegisteredEventCards({ events }: { events: RegisteredEventItem[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No event registrations yet"
        description="When you register for public events through DanceFlow, those registrations will appear here."
        href="/discover/events"
        actionLabel="Browse Events"
      />
    );
  }

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      {events.map(({ registrationId, status, event }) => (
        <Link
          key={registrationId}
          href={event.slug ? `/events/${event.slug}` : "/discover/events"}
          className="rounded-[28px] border border-sky-100 bg-gradient-to-br from-sky-50 via-white to-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-lg font-semibold text-slate-950">
                {event.name}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                {formatDate(event.start_date)} • {getEventLocation(event)}
              </p>
            </div>

            <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-sky-700 ring-1 ring-sky-100">
              {formatStatus(status)}
            </span>
          </div>

          <p className="mt-4 text-sm font-semibold text-sky-800">
            View registration →
          </p>
        </Link>
      ))}
    </div>
  );
}

export default async function AccountPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [
    { data: favorites, error: favoritesError },
    { data: registrations, error: registrationsError },
    { data: portalLinks, error: portalLinksError },
  ] = await Promise.all([
    supabase
      .from("user_favorites")
      .select("studio_id, event_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),

    supabase
      .from("event_registrations")
      .select("id, event_id, status, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),

    supabase
      .from("clients")
      .select(
        `
        id,
        first_name,
        last_name,
        is_independent_instructor,
        studios (
          id,
          slug,
          name,
          public_name,
          city,
          state
        )
      `,
      )
      .eq("portal_user_id", user.id)
      .order("created_at", { ascending: false }),
  ]);

  if (favoritesError) {
    throw new Error(`Failed to load favorites: ${favoritesError.message}`);
  }

  if (registrationsError) {
    throw new Error(
      `Failed to load registrations: ${registrationsError.message}`,
    );
  }

  if (portalLinksError) {
    throw new Error(
      `Failed to load studio portals: ${portalLinksError.message}`,
    );
  }

  const typedFavorites = (favorites ?? []) as FavoriteRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const typedPortalLinks = (portalLinks ?? []) as PortalLinkRow[];

  const favoriteStudioIds = Array.from(
    new Set(typedFavorites.map((row) => row.studio_id).filter(Boolean)),
  ) as string[];

  const favoriteEventIds = Array.from(
    new Set(typedFavorites.map((row) => row.event_id).filter(Boolean)),
  ) as string[];

  const registrationEventIds = Array.from(
    new Set(typedRegistrations.map((row) => row.event_id).filter(Boolean)),
  ) as string[];

  const allEventIds = Array.from(
    new Set([...favoriteEventIds, ...registrationEventIds]),
  );

  const [
    { data: favoriteStudios, error: favoriteStudiosError },
    { data: relatedEvents, error: relatedEventsError },
  ] = await Promise.all([
    favoriteStudioIds.length
      ? supabase
          .from("studios")
          .select("id, slug, name, public_name, city, state")
          .in("id", favoriteStudioIds)
      : Promise.resolve({ data: [], error: null }),

    allEventIds.length
      ? supabase
          .from("events")
          .select("id, slug, name, start_date, city, state")
          .in("id", allEventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (favoriteStudiosError) {
    throw new Error(
      `Failed to load favorite studios: ${favoriteStudiosError.message}`,
    );
  }

  if (relatedEventsError) {
    throw new Error(`Failed to load events: ${relatedEventsError.message}`);
  }

  const typedFavoriteStudios = (favoriteStudios ?? []) as StudioRow[];
  const typedRelatedEvents = (relatedEvents ?? []) as EventRow[];

  const studiosById = new Map(
    typedFavoriteStudios.map((studio) => [studio.id, studio]),
  );
  const eventsById = new Map(
    typedRelatedEvents.map((event) => [event.id, event]),
  );

  const favoriteStudiosList = typedFavorites
    .filter((row) => row.studio_id)
    .map((row) => {
      const studio = studiosById.get(row.studio_id!);
      if (!studio) return null;

      return {
        studio,
        createdAt: row.created_at,
      };
    })
    .filter((value): value is FavoriteStudioItem => Boolean(value));

  const favoriteEventsList = typedFavorites
    .filter((row) => row.event_id)
    .map((row) => {
      const event = eventsById.get(row.event_id!);
      if (!event) return null;

      return {
        event,
        createdAt: row.created_at,
      };
    })
    .filter((value): value is FavoriteEventItem => Boolean(value));

  const registeredEventsList = typedRegistrations
    .map((row) => {
      const event = row.event_id ? eventsById.get(row.event_id) : null;
      if (!event) return null;

      return {
        registrationId: row.id,
        status: row.status ?? "registered",
        createdAt: row.created_at,
        event,
      };
    })
    .filter((value): value is RegisteredEventItem => Boolean(value));

  const linkedPortals = typedPortalLinks
    .map((row) => {
      const studio = getPortalStudio(row.studios);
      if (!studio?.slug) return null;

      return {
        clientId: row.id,
        studioId: studio.id,
        studioSlug: studio.slug,
        studioName: studio.public_name?.trim() || studio.name,
        location:
          [studio.city, studio.state].filter(Boolean).join(", ") ||
          "Location coming soon",
        isIndependentInstructor: Boolean(row.is_independent_instructor),
        clientName:
          `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() ||
          "Portal Member",
      };
    })
    .filter((value): value is LinkedPortalItem => Boolean(value));

  const portalClientIds = Array.from(
    new Set(linkedPortals.map((row) => row.clientId)),
  );

  const { data: accountLedgerRows, error: accountLedgerError } =
    portalClientIds.length
      ? await supabase
          .from("client_account_ledger")
          .select(
            "id, studio_id, client_id, entry_date, entry_type, direction, amount, description, created_at",
          )
          .in("client_id", portalClientIds)
          .order("entry_date", { ascending: false })
          .order("created_at", { ascending: false })
      : { data: [], error: null };

  if (accountLedgerError) {
    throw new Error(
      `Failed to load account balances: ${accountLedgerError.message}`,
    );
  }

  const typedAccountLedgerRows = (accountLedgerRows ??
    []) as ClientAccountLedgerRow[];
  const ledgerRowsByClientId = new Map<string, ClientAccountLedgerRow[]>();

  for (const row of typedAccountLedgerRows) {
    const existingRows = ledgerRowsByClientId.get(row.client_id) ?? [];
    existingRows.push(row);
    ledgerRowsByClientId.set(row.client_id, existingRows);
  }

  const accountBalances = linkedPortals
    .map((portal) => {
      const rows = ledgerRowsByClientId.get(portal.clientId) ?? [];

      if (rows.length === 0) {
        return null;
      }

      const creditTotal = rows
        .filter((row) => row.direction === "credit")
        .reduce((total, row) => total + parseLedgerAmount(row.amount), 0);
      const debitTotal = rows
        .filter((row) => row.direction === "debit")
        .reduce((total, row) => total + parseLedgerAmount(row.amount), 0);

      return {
        clientId: portal.clientId,
        studioId: portal.studioId,
        studioName: portal.studioName,
        clientName: portal.clientName,
        creditTotal,
        debitTotal,
        netBalance: creditTotal - debitTotal,
        recentEntries: rows,
      };
    })
    .filter((value): value is AccountBalanceItem => Boolean(value));

  const firstPortalName =
    linkedPortals.map((row) => row.clientName).find(Boolean) || null;

  const displayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.first_name ||
    firstPortalName ||
    user.email?.split("@")[0] ||
    "there";

  const firstPortalHref = linkedPortals[0]?.studioSlug
    ? `/portal/${linkedPortals[0].studioSlug}`
    : null;

  return (
    <div className="min-h-screen bg-[#fff8f1]">
      <PublicSiteHeader currentPath="account" isAuthenticated />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <section className="overflow-hidden rounded-[36px] border border-orange-100 bg-white shadow-sm">
          <div className="relative isolate bg-gradient-to-br from-purple-900 via-fuchsia-800 to-orange-500 p-6 text-white sm:p-8 lg:p-10">
            <div className="absolute inset-0 -z-10 opacity-25 [background-image:radial-gradient(circle_at_top_left,#ffffff_0,transparent_28%),radial-gradient(circle_at_bottom_right,#ffffff_0,transparent_24%)]" />

            <div className="grid gap-8 xl:grid-cols-[1.15fr_0.85fr] xl:items-end">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-orange-100">
                  DanceFlow Account
                </p>
                <h1 className="mt-4 max-w-4xl text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
                  Welcome back, {displayName}
                </h1>
                <p className="mt-5 max-w-3xl text-base leading-8 text-orange-50">
                  Your DanceFlow home keeps your favorite studios, saved events,
                  registrations, and linked studio portals in one place.
                </p>

                <div className="mt-7 flex flex-wrap gap-3">
                  <Link
                    href="/discover/studios"
                    className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-purple-900 shadow-sm transition hover:bg-orange-50"
                  >
                    Find Studios
                  </Link>
                  <Link
                    href="/discover/events"
                    className="rounded-2xl bg-white/15 px-5 py-3 text-sm font-semibold text-white ring-1 ring-white/25 transition hover:bg-white/20"
                  >
                    Find Events
                  </Link>
                  {firstPortalHref ? (
                    <Link
                      href={firstPortalHref}
                      className="rounded-2xl bg-white/15 px-5 py-3 text-sm font-semibold text-white ring-1 ring-white/25 transition hover:bg-white/20"
                    >
                      Open My Portal
                    </Link>
                  ) : null}
                </div>
              </div>

              <div className="rounded-[28px] bg-white/12 p-5 ring-1 ring-white/20 backdrop-blur">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-100">
                  Quick Start
                </p>
                <div className="mt-4 space-y-3 text-sm leading-6 text-white/90">
                  <p>1. Explore studios and events in public discovery.</p>
                  <p>2. Save favorites so they are easy to find later.</p>
                  <p>
                    3. Open any linked studio portal when a studio connects your
                    account.
                  </p>
                </div>
                <div className="mt-5 rounded-2xl bg-white/15 p-4 text-sm text-white/90 ring-1 ring-white/15">
                  Signed in as{" "}
                  <span className="font-semibold text-white">{user.email}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4 lg:p-6">
            <AccountStatCard
              label="Favorite Studios"
              value={favoriteStudiosList.length}
              detail="Saved places"
              className="border-orange-100 bg-orange-50/70"
            />
            <AccountStatCard
              label="Favorite Events"
              value={favoriteEventsList.length}
              detail="Saved events"
              className="border-violet-100 bg-violet-50/70"
            />
            <AccountStatCard
              label="Registered Events"
              value={registeredEventsList.length}
              detail="Event activity"
              className="border-sky-100 bg-sky-50/70"
            />
            <AccountStatCard
              label="Studio Portals"
              value={linkedPortals.length}
              detail="Linked access"
              className="border-emerald-100 bg-emerald-50/70"
            />
          </div>
        </section>

        <section className="mt-8 grid gap-4 lg:grid-cols-4">
          <QuickActionCard
            eyebrow="Discover"
            title="Find studios"
            description="Browse public studio profiles and save the ones you want to revisit."
            href="/discover/studios"
            className="border-orange-100 bg-white"
          />
          <QuickActionCard
            eyebrow="Events"
            title="Find events"
            description="Search upcoming events and keep your registrations organized."
            href="/discover/events"
            className="border-violet-100 bg-white"
          />
          <QuickActionCard
            eyebrow="Favorites"
            title="View saved items"
            description="Open your favorite studios and events without searching again."
            href="/favorites"
            className="border-sky-100 bg-white"
          />
          <QuickActionCard
            eyebrow="Help"
            title="Learn DanceFlow"
            description="Use the knowledgebase for guides on accounts, portals, and discovery."
            href="/knowledgebase"
            className="border-emerald-100 bg-white"
          />
        </section>

        <div className="mt-8 space-y-8">
          <section className="rounded-[32px] border border-emerald-100 bg-white p-6 shadow-sm sm:p-7">
            <SectionHeader
              eyebrow="My Studio Portals"
              title="Private access from studios you are linked to"
              description="Your public DanceFlow account stays separate from studio portals. When a studio links your account, that studio’s portal appears here."
            />
            <PortalCards linkedPortals={linkedPortals} />
          </section>

          {accountBalances.length > 0 ? (
            <section className="rounded-[32px] border border-amber-100 bg-white p-6 shadow-sm sm:p-7">
              <SectionHeader
                eyebrow="Account Balance"
                title="Credits and balances from your linked studios"
                description="Studios can apply account credits, charges, and adjustments. This read-only summary helps you see your current balance without contacting the front desk."
              />
              <AccountBalanceCards balances={accountBalances} />
            </section>
          ) : null}

          <section className="rounded-[32px] border border-orange-100 bg-white p-6 shadow-sm sm:p-7">
            <SectionHeader
              eyebrow="Favorite Studios"
              title="Studios you want to keep nearby"
              description="Favorite studios from discovery so you can come back to them quickly."
              actionHref="/discover/studios"
              actionLabel="Find More Studios"
            />
            <FavoriteStudioCards studios={favoriteStudiosList} />
          </section>

          <section className="rounded-[32px] border border-violet-100 bg-white p-6 shadow-sm sm:p-7">
            <SectionHeader
              eyebrow="Favorite Events"
              title="Events you are tracking"
              description="Saved public events stay tied to your account so you do not have to search for them again."
              actionHref="/discover/events"
              actionLabel="Find More Events"
            />
            <FavoriteEventCards events={favoriteEventsList} />
          </section>

          <section className="rounded-[32px] border border-sky-100 bg-white p-6 shadow-sm sm:p-7">
            <SectionHeader
              eyebrow="Registered Events"
              title="Events you have registered for"
              description="Your public event registrations stay with this account, even if you also have studio portal access."
              actionHref="/discover/events"
              actionLabel="Browse Events"
            />
            <RegisteredEventCards events={registeredEventsList} />
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-7">
            <div className="grid gap-6 lg:grid-cols-[1fr_0.8fr] lg:items-center">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Account Help
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Need help with your account?
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Visit the knowledgebase or contact support if you need help
                  with public accounts, favorites, event registrations, or
                  studio portal access.
                </p>
              </div>

              <div className="flex flex-wrap gap-3 lg:justify-end">
                <Link
                  href="/knowledgebase"
                  className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50"
                >
                  Knowledgebase
                </Link>
                <Link
                  href="/support"
                  className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
                >
                  Contact Support
                </Link>
                <form action="/auth/logout" method="post">
                  <button
                    type="submit"
                    className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50"
                  >
                    Log Out
                  </button>
                </form>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

