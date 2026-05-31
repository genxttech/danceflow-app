import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarDays,
  DollarSign,
  Mail,
  Phone,
  Search,
  Ticket,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type SearchParams = Promise<{
  organizer?: string;
  q?: string;
}>;

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
};

type OrganizerContactRow = {
  id: string;
  organizer_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  source: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_event_id: string | null;
  last_registration_id: string | null;
  total_registrations: number | null;
  total_paid_registrations: number | null;
  total_spend: number | null;
  currency: string | null;
  created_at: string;
};

type EventRow = {
  id: string;
  name: string;
  slug: string | null;
};

type RegistrationHistoryRow = {
  organizer_contact_id: string;
  registration_id: string;
  event_id: string;
  payment_status: string | null;
  status: string | null;
  total_amount: number | null;
  currency: string | null;
  registered_at: string | null;
  checked_in_at: string | null;
};

function canViewOrganizerContacts(
  role: string | null | undefined,
  isPlatformAdminRole: boolean,
) {
  if (isPlatformAdminRole) return true;

  return [
    "studio_owner",
    "studio_admin",
    "front_desk",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(role ?? "");
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Never";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Never";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatCurrency(value: number | null | undefined, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function contactName(contact: OrganizerContactRow) {
  const name = [contact.first_name, contact.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return name || contact.email;
}

function sourceLabel(source: string | null) {
  if (!source) return "Captured contact";
  return source.replaceAll("_", " ");
}

function StatCard({
  label,
  value,
  helper,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  helper?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
          {helper ? <p className="mt-2 text-sm text-slate-500">{helper}</p> : null}
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export default async function OrganizerContactsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const resolvedSearchParams = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!canViewOrganizerContacts(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app");
  }

  const selectedOrganizerId = resolvedSearchParams.organizer ?? "";
  const queryText = (resolvedSearchParams.q ?? "").trim().toLowerCase();

  const { data: organizers, error: organizersError } = await supabase
    .from("organizers")
    .select("id, name, slug, active")
    .eq("studio_id", context.studioId)
    .order("name", { ascending: true });

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const allowedOrganizerIds = typedOrganizers.map((organizer) => organizer.id);
  const organizerFilter =
    selectedOrganizerId && allowedOrganizerIds.includes(selectedOrganizerId)
      ? selectedOrganizerId
      : "";

  let contactsQuery = supabase
    .from("organizer_contacts")
    .select(
      `
        id,
        organizer_id,
        email,
        first_name,
        last_name,
        phone,
        source,
        first_seen_at,
        last_seen_at,
        last_event_id,
        last_registration_id,
        total_registrations,
        total_paid_registrations,
        total_spend,
        currency,
        created_at
      `,
    )
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (organizerFilter) {
    contactsQuery = contactsQuery.eq("organizer_id", organizerFilter);
  } else if (allowedOrganizerIds.length > 0) {
    contactsQuery = contactsQuery.in("organizer_id", allowedOrganizerIds);
  } else {
    contactsQuery = contactsQuery.eq("organizer_id", "00000000-0000-0000-0000-000000000000");
  }

  const { data: contacts, error: contactsError } = await contactsQuery;

  if (contactsError) {
    throw new Error(`Failed to load organizer contacts: ${contactsError.message}`);
  }

  const allContacts = (contacts ?? []) as OrganizerContactRow[];
  const filteredContacts = allContacts.filter((contact) => {
    if (!queryText) return true;

    const organizerName =
      typedOrganizers.find((organizer) => organizer.id === contact.organizer_id)
        ?.name ?? "";

    const haystack = [
      contact.first_name ?? "",
      contact.last_name ?? "",
      `${contact.first_name ?? ""} ${contact.last_name ?? ""}`,
      contact.email,
      contact.phone ?? "",
      organizerName,
      sourceLabel(contact.source),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(queryText);
  });

  const eventIds = Array.from(
    new Set(filteredContacts.map((contact) => contact.last_event_id).filter(Boolean)),
  ) as string[];

  const contactIds = filteredContacts.map((contact) => contact.id);

  const [eventsResult, registrationHistoryResult] = await Promise.all([
    eventIds.length > 0
      ? supabase
          .from("events")
          .select("id, name, slug")
          .in("id", eventIds)
      : Promise.resolve({ data: [], error: null }),
    contactIds.length > 0
      ? supabase
          .from("organizer_contact_registrations")
          .select(
            "organizer_contact_id, registration_id, event_id, payment_status, status, total_amount, currency, registered_at, checked_in_at",
          )
          .in("organizer_contact_id", contactIds)
          .order("registered_at", { ascending: false })
          .limit(75)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (eventsResult.error) {
    throw new Error(`Failed to load last events: ${eventsResult.error.message}`);
  }

  if (registrationHistoryResult.error) {
    throw new Error(
      `Failed to load organizer contact registration history: ${registrationHistoryResult.error.message}`,
    );
  }

  const eventMap = new Map(
    ((eventsResult.data ?? []) as EventRow[]).map((event) => [event.id, event]),
  );

  const recentRegistrationByContact = new Map<string, RegistrationHistoryRow>();
  for (const row of (registrationHistoryResult.data ?? []) as RegistrationHistoryRow[]) {
    if (!recentRegistrationByContact.has(row.organizer_contact_id)) {
      recentRegistrationByContact.set(row.organizer_contact_id, row);
    }
  }

  const organizerMap = new Map(
    typedOrganizers.map((organizer) => [organizer.id, organizer]),
  );

  const totalContacts = filteredContacts.length;
  const totalRegistrations = filteredContacts.reduce(
    (sum, contact) => sum + Number(contact.total_registrations ?? 0),
    0,
  );
  const totalPaidRegistrations = filteredContacts.reduce(
    (sum, contact) => sum + Number(contact.total_paid_registrations ?? 0),
    0,
  );
  const totalRevenue = filteredContacts.reduce(
    (sum, contact) => sum + Number(contact.total_spend ?? 0),
    0,
  );

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Organizer Contacts
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Organizer Contact List
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Review the people captured from organizer-owned event registrations so you can follow event interest, repeat buyers, and future marketing audiences without mixing them into studio CRM.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/organizers"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Organizer Summary
              </Link>
              <Link
                href="/app/events"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Event Operations
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">Organizer-scoped contacts</h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Contacts here come from organizer-owned event registrations and stay separate from studio CRM unless a sharing workflow is intentionally added later.
              </p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">Event audience foundation</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Use this list to understand repeat attendees, recent registrants, and future organizer marketing audiences.
              </p>
            </div>
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">Registration history</h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Each contact stores registration totals, paid registration counts, and the most recent event connection.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Contacts" value={totalContacts} icon={Users} />
        <StatCard label="Registrations" value={totalRegistrations} icon={Ticket} />
        <StatCard label="Paid registrations" value={totalPaidRegistrations} icon={CalendarDays} />
        <StatCard
          label="Contact revenue"
          value={formatCurrency(totalRevenue, filteredContacts[0]?.currency ?? "USD")}
          helper="Attributed to captured organizer contacts"
          icon={DollarSign}
        />
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <form className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px_auto]" action="/app/organizer-contacts">
          <label className="relative block">
            <span className="sr-only">Search contacts</span>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              name="q"
              defaultValue={resolvedSearchParams.q ?? ""}
              placeholder="Search by name, email, phone, or organizer..."
              className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-11 pr-4 text-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-4 focus:ring-[var(--brand-primary-soft)]"
            />
          </label>

          <label className="block">
            <span className="sr-only">Filter by organizer</span>
            <select
              name="organizer"
              defaultValue={organizerFilter}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-4 focus:ring-[var(--brand-primary-soft)]"
            >
              <option value="">All organizers</option>
              {typedOrganizers.map((organizer) => (
                <option key={organizer.id} value={organizer.id}>
                  {organizer.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className="rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[var(--brand-primary)]/90"
          >
            Filter
          </button>
        </form>
      </section>

      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Captured Contacts</h2>
            <p className="mt-1 text-sm text-slate-500">
              Showing {filteredContacts.length} contact{filteredContacts.length === 1 ? "" : "s"} from organizer-owned event registrations.
            </p>
          </div>
          <Link
            href="/app/organizers"
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Manage organizers
          </Link>
        </div>

        {filteredContacts.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]">
              <Users className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-slate-950">No organizer contacts yet</h3>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-7 text-slate-600">
              Contacts are created automatically when someone registers for an organizer-owned event. Once ticket buyers or registrants come in, they will appear here.
            </p>
            <div className="mt-6 flex justify-center">
              <Link
                href="/app/events"
                className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-primary)]/90"
              >
                Open Events
              </Link>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredContacts.map((contact) => {
              const organizer = organizerMap.get(contact.organizer_id);
              const lastEvent = contact.last_event_id
                ? eventMap.get(contact.last_event_id)
                : null;
              const recentRegistration = recentRegistrationByContact.get(contact.id);
              const currency = contact.currency || recentRegistration?.currency || "USD";

              return (
                <article key={contact.id} className="p-5 transition hover:bg-slate-50/70 md:p-6">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-semibold text-slate-950">
                          {contactName(contact)}
                        </h3>
                        <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold capitalize text-violet-700 ring-1 ring-violet-100">
                          {sourceLabel(contact.source)}
                        </span>
                        {organizer ? (
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                            {organizer.name}
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-600">
                        <span className="inline-flex items-center gap-2">
                          <Mail className="h-4 w-4 text-slate-400" />
                          {contact.email}
                        </span>
                        {contact.phone ? (
                          <span className="inline-flex items-center gap-2">
                            <Phone className="h-4 w-4 text-slate-400" />
                            {contact.phone}
                          </span>
                        ) : null}
                        <span className="inline-flex items-center gap-2">
                          <CalendarDays className="h-4 w-4 text-slate-400" />
                          Last seen {formatDate(contact.last_seen_at)}
                        </span>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-2xl border border-slate-200 bg-white p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                            Registrations
                          </p>
                          <p className="mt-2 text-2xl font-semibold text-slate-950">
                            {contact.total_registrations ?? 0}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
                            Paid
                          </p>
                          <p className="mt-2 text-2xl font-semibold text-emerald-950">
                            {contact.total_paid_registrations ?? 0}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-amber-600">
                            Total spend
                          </p>
                          <p className="mt-2 text-2xl font-semibold text-amber-950">
                            {formatCurrency(contact.total_spend, currency)}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-sky-600">
                            First seen
                          </p>
                          <p className="mt-2 text-sm font-semibold text-sky-950">
                            {formatDate(contact.first_seen_at ?? contact.created_at)}
                          </p>
                        </div>
                      </div>

                      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                        <p className="font-semibold text-slate-900">Latest activity</p>
                        <p className="mt-1">
                          {lastEvent ? lastEvent.name : "No linked event found"}
                          {recentRegistration?.payment_status ? (
                            <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs font-semibold capitalize text-slate-600 ring-1 ring-slate-200">
                              {recentRegistration.payment_status}
                            </span>
                          ) : null}
                          {recentRegistration?.checked_in_at ? (
                            <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                              Checked in
                            </span>
                          ) : null}
                        </p>
                        {recentRegistration?.registered_at ? (
                          <p className="mt-1 text-xs text-slate-500">
                            Registered {formatDateTime(recentRegistration.registered_at)}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 xl:w-44 xl:flex-col">
                      {organizer ? (
                        <Link
                          href={`/app/organizers`}
                          className="rounded-xl border border-slate-200 px-4 py-2 text-center text-sm font-semibold text-slate-700 hover:bg-white"
                        >
                          Organizer
                        </Link>
                      ) : null}
                      {lastEvent ? (
                        <Link
                          href={`/app/events/${lastEvent.id}/registrations`}
                          className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-center text-sm font-semibold text-white hover:bg-[var(--brand-primary)]/90"
                        >
                          Registrations
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
