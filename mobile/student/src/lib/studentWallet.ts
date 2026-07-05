import { supabase } from "@/lib/supabase";
import { type LinkedStudioAccess } from "@/lib/studentAccess";

const DEFAULT_WEB_BASE_URL = "https://idanceflow.com";
const WALLET_CACHE_TTL_MS = 15000;

function webBaseUrl() {
  const value = process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL ?? DEFAULT_WEB_BASE_URL;
  return value.replace(/\/$/, "");
}

type Joined<T> = T | T[] | null | undefined;

function firstJoin<T>(value: Joined<T>) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function moneyFromCents(cents: number | null | undefined) {
  if (typeof cents !== "number" || Number.isNaN(cents)) return null;
  return cents / 100;
}

export type StudentPackageItem = {
  usageType: string;
  total: number | null;
  used: number | null;
  remaining: number | null;
  unlimited: boolean;
};

export type StudentPackage = {
  id: string;
  studioId: string;
  studioName: string;
  name: string;
  expiresOn: string | null;
  price: number | null;
  items: StudentPackageItem[];
};

export type StudentMembership = {
  id: string;
  studioId: string;
  studioName: string;
  name: string;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  price: number | null;
  billingInterval: string | null;
};

export type StudentTicket = {
  id: string;
  registrationId: string;
  eventId: string;
  studioId: string;
  studioName: string;
  eventName: string;
  eventSlug: string | null;
  ticketName: string;
  ticketCode: string | null;
  qrImageUrl: string | null;
  checkedInAt: string | null;
  waiverSignedAt: string | null;
  eventDate: string | null;
  eventTime: string | null;
  venue: string | null;
  city: string | null;
  state: string | null;
};

export type StudentEventRegistration = {
  id: string;
  eventId: string;
  studioId: string;
  studioName: string;
  eventName: string;
  eventSlug: string | null;
  status: string;
  paymentStatus: string | null;
  quantity: number | null;
  totalAmount: number | null;
  eventDate: string | null;
  eventTime: string | null;
  venue: string | null;
  city: string | null;
  state: string | null;
};

export type StudentPaymentRequest = {
  id: string;
  studioId: string;
  studioName: string;
  amount: number | null;
  currency: string | null;
  paymentType: string | null;
  notes: string | null;
  createdAt: string;
  checkoutUrl: string;
};

export type StudentWallet = {
  memberships: StudentMembership[];
  packages: StudentPackage[];
  paymentRequests: StudentPaymentRequest[];
  registrations: StudentEventRegistration[];
  tickets: StudentTicket[];
};

type LoadStudentWalletOptions = {
  force?: boolean;
};

type WalletCacheEntry = {
  expiresAt: number;
  wallet: StudentWallet;
};

type PackageRow = {
  id: string;
  studio_id: string;
  active: boolean | null;
  purchase_date: string | null;
  name_snapshot: string | null;
  expiration_date: string | null;
  sold_price: number | null;
  price_snapshot: number | null;
  client_package_items: Joined<{
    usage_type: string | null;
    quantity_total: number | null;
    quantity_used: number | null;
    quantity_remaining: number | null;
    is_unlimited: boolean | null;
  }>;
};

type MembershipRow = {
  id: string;
  studio_id: string;
  status: string | null;
  starts_on: string | null;
  ends_on: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  auto_renew: boolean | null;
  cancel_at_period_end: boolean | null;
  name_snapshot: string | null;
  price_snapshot: number | null;
  billing_interval_snapshot: string | null;
};

type EventRegistrationRow = {
  id: string;
  studio_id: string;
  event_id: string;
  status: string | null;
  payment_status: string | null;
  quantity: number | null;
  total_amount: number | null;
  total_price?: number | null;
  events: Joined<{
    id: string;
    name: string | null;
    slug: string | null;
    start_date: string | null;
    start_time: string | null;
    venue_name: string | null;
    city: string | null;
    state: string | null;
  }>;
};

type TicketRow = {
  id: string;
  registration_id: string;
  event_id: string;
  first_name: string | null;
  last_name: string | null;
  email?: string | null;
  sort_order: number | null;
  checked_in_at: string | null;
  waiver_signed_at: string | null;
  ticket_code: string | null;
  ticket_issued_at: string | null;
};

type PaymentRequestRow = {
  id: string;
  studio_id: string;
  amount: number | null;
  currency: string | null;
  payment_type: string | null;
  notes: string | null;
  created_at: string;
};

function studioNameFor(studioId: string, linkedStudios: LinkedStudioAccess[]) {
  const studio = linkedStudios.find((item) => item.studioId === studioId);
  return studio?.studioPublicName || studio?.studioName || "Studio";
}

function attendeeName(row: TicketRow) {
  const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return fullName || `Ticket ${row.sort_order ?? ""}`.trim();
}

function paymentCheckoutUrl(paymentId: string) {
  return `${webBaseUrl()}/api/stripe/client-checkout?paymentId=${encodeURIComponent(paymentId)}`;
}

const walletCache = new Map<string, WalletCacheEntry>();

function walletCacheKey(linkedStudios: LinkedStudioAccess[], accountEmail?: string | null) {
  const accessKey = linkedStudios
    .map((item) => `${item.studioId}:${item.clientId}`)
    .sort()
    .join("|");
  return `${accountEmail?.trim().toLowerCase() ?? ""}|${accessKey}`;
}

export function clearStudentWalletCache() {
  walletCache.clear();
}

export function formatWalletDate(value: string | null | undefined) {
  if (!value) return "Not set";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

export function formatCurrency(value: number | null | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency"
  }).format(value);
}

export function packageItemLabel(item: StudentPackageItem) {
  const label = item.usageType.replace(/_/g, " ");
  if (item.unlimited) return `${label}: unlimited`;
  if (typeof item.remaining === "number") return `${label}: ${item.remaining} remaining`;
  return label;
}

function registrationSelect() {
  return `
    id,
    studio_id,
    event_id,
    status,
    payment_status,
    quantity,
    total_amount,
    total_price,
    events (
      id,
      name,
      slug,
      start_date,
      start_time,
      venue_name,
      city,
      state
    )
  `;
}

function registrationToWallet(row: EventRegistrationRow, linkedStudios: LinkedStudioAccess[]): StudentEventRegistration {
  const event = firstJoin(row.events);
  return {
    id: row.id,
    eventId: row.event_id,
    studioId: row.studio_id,
    studioName: studioNameFor(row.studio_id, linkedStudios),
    eventName: event?.name ?? "Event",
    eventSlug: event?.slug ?? null,
    status: row.status ?? "confirmed",
    paymentStatus: row.payment_status,
    quantity: row.quantity,
    totalAmount: moneyFromCents(row.total_amount ?? row.total_price ?? null),
    eventDate: event?.start_date ?? null,
    eventTime: event?.start_time ?? null,
    venue: event?.venue_name ?? null,
    city: event?.city ?? null,
    state: event?.state ?? null
  };
}

async function loadRegistrationsByClient(clientIds: string[], studioIds: string[]) {
  if (!clientIds.length || !studioIds.length) return [] as EventRegistrationRow[];

  const { data, error } = await supabase
    .from("event_registrations")
    .select(registrationSelect())
    .in("studio_id", studioIds)
    .in("client_id", clientIds)
    .in("status", ["confirmed", "checked_in", "pending", "waitlisted"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []) as unknown as EventRegistrationRow[];
}

async function loadRegistrationsByEmail(email: string | null | undefined) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return [] as EventRegistrationRow[];

  const { data, error } = await supabase
    .from("event_registrations")
    .select(registrationSelect())
    .eq("attendee_email", normalizedEmail)
    .in("status", ["confirmed", "checked_in", "pending", "waitlisted"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    // Some deployments may not expose email-based ticket lookup to mobile yet.
    // Keep Wallet usable and continue with studio-linked items.
    return [];
  }

  return (data ?? []) as unknown as EventRegistrationRow[];
}

function dedupeRegistrations(rows: EventRegistrationRow[]) {
  const byId = new Map<string, EventRegistrationRow>();
  rows.forEach((row) => byId.set(row.id, row));
  return Array.from(byId.values());
}

export async function loadStudentWallet(
  linkedStudios: LinkedStudioAccess[],
  accountEmail?: string | null,
  options?: LoadStudentWalletOptions
): Promise<StudentWallet> {
  const cacheKey = walletCacheKey(linkedStudios, accountEmail);
  const cached = walletCache.get(cacheKey);
  const now = Date.now();

  if (!options?.force && cached && cached.expiresAt > now) {
    return cached.wallet;
  }

  const clientIds = linkedStudios.map((item) => item.clientId).filter(Boolean);
  const studioIds = linkedStudios.map((item) => item.studioId).filter(Boolean);

  const [membershipsResult, packagesResult, paymentsResult, clientRegistrationRows, emailRegistrationRows] = await Promise.all([
    clientIds.length && studioIds.length
      ? supabase
          .from("client_memberships")
          .select(
            `
            id,
            studio_id,
            status,
            starts_on,
            ends_on,
            current_period_start,
            current_period_end,
            auto_renew,
            cancel_at_period_end,
            name_snapshot,
            price_snapshot,
            billing_interval_snapshot
          `
          )
          .in("studio_id", studioIds)
          .in("client_id", clientIds)
          .in("status", ["active", "trialing", "past_due"])
          .order("created_at", { ascending: false })
          .limit(12)
      : Promise.resolve({ data: [], error: null }),

    clientIds.length && studioIds.length
      ? supabase
          .from("client_packages")
          .select(
            `
            id,
            studio_id,
            active,
            purchase_date,
            name_snapshot,
            expiration_date,
            sold_price,
            price_snapshot,
            client_package_items (
              usage_type,
              quantity_total,
              quantity_used,
              quantity_remaining,
              is_unlimited
            )
          `
          )
          .in("studio_id", studioIds)
          .in("client_id", clientIds)
          .order("purchase_date", { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [], error: null }),

    clientIds.length && studioIds.length
      ? supabase
          .from("payments")
          .select("id, studio_id, amount, currency, payment_type, notes, created_at")
          .in("studio_id", studioIds)
          .in("client_id", clientIds)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [], error: null }),

    loadRegistrationsByClient(clientIds, studioIds),
    loadRegistrationsByEmail(accountEmail)
  ]);

  if (membershipsResult.error) throw membershipsResult.error;
  if (packagesResult.error) throw packagesResult.error;
  if (paymentsResult.error) throw paymentsResult.error;

  const memberships = ((membershipsResult.data ?? []) as MembershipRow[]).map((row) => ({
    id: row.id,
    studioId: row.studio_id,
    studioName: studioNameFor(row.studio_id, linkedStudios),
    name: row.name_snapshot ?? "Membership",
    status: row.status ?? "active",
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    autoRenew: row.auto_renew === true,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    price: moneyFromCents(row.price_snapshot),
    billingInterval: row.billing_interval_snapshot
  }));

  const packages = ((packagesResult.data ?? []) as PackageRow[])
    .filter((row) => row.active !== false)
    .map((row) => ({
      id: row.id,
      studioId: row.studio_id,
      studioName: studioNameFor(row.studio_id, linkedStudios),
      name: row.name_snapshot ?? "Lesson package",
      expiresOn: row.expiration_date,
      price: moneyFromCents(row.sold_price ?? row.price_snapshot),
      items: (Array.isArray(row.client_package_items)
        ? row.client_package_items
        : row.client_package_items
          ? [row.client_package_items]
          : []
      ).map((item) => ({
        usageType: item.usage_type ?? "lesson",
        total: item.quantity_total,
        used: item.quantity_used,
        remaining: item.quantity_remaining,
        unlimited: item.is_unlimited === true
      }))
    }));

  const registrationRows = dedupeRegistrations([...clientRegistrationRows, ...emailRegistrationRows]);
  const registrations = registrationRows.map((row) => registrationToWallet(row, linkedStudios));
  const paymentRequests = ((paymentsResult.data ?? []) as PaymentRequestRow[]).map((row) => ({
    id: row.id,
    studioId: row.studio_id,
    studioName: studioNameFor(row.studio_id, linkedStudios),
    amount: row.amount,
    currency: row.currency,
    paymentType: row.payment_type,
    notes: row.notes,
    createdAt: row.created_at,
    checkoutUrl: paymentCheckoutUrl(row.id)
  }));

  const registrationIds = registrationRows.map((item) => item.id);
  let tickets: StudentTicket[] = [];

  if (registrationIds.length) {
    const { data, error } = await supabase
      .from("event_registration_attendees")
      .select(
        "id, registration_id, event_id, first_name, last_name, email, sort_order, checked_in_at, waiver_signed_at, ticket_code, ticket_issued_at"
      )
      .in("registration_id", registrationIds)
      .order("sort_order", { ascending: true });

    if (error) throw error;

    const registrationById = new Map(registrations.map((item) => [item.id, item]));

    tickets = ((data ?? []) as TicketRow[]).map((row) => {
      const registration = registrationById.get(row.registration_id);
      const ticketCode = row.ticket_code;
      return {
        id: row.id,
        registrationId: row.registration_id,
        eventId: row.event_id,
        studioId: registration?.studioId ?? "",
        studioName: registration?.studioName ?? "Event",
        eventName: registration?.eventName ?? "Event",
        eventSlug: registration?.eventSlug ?? null,
        ticketName: attendeeName(row),
        ticketCode,
        qrImageUrl: ticketCode ? `${webBaseUrl()}/api/tickets/qr?code=${encodeURIComponent(ticketCode)}` : null,
        checkedInAt: row.checked_in_at,
        waiverSignedAt: row.waiver_signed_at,
        eventDate: registration?.eventDate ?? null,
        eventTime: registration?.eventTime ?? null,
        venue: registration?.venue ?? null,
        city: registration?.city ?? null,
        state: registration?.state ?? null
      };
    });
  }

  const wallet = { memberships, packages, paymentRequests, registrations, tickets };
  walletCache.set(cacheKey, { expiresAt: Date.now() + WALLET_CACHE_TTL_MS, wallet });

  return wallet;
}
