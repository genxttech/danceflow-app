import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireEventWorkspaceFeature } from "@/lib/billing/access";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  resendEventTicketConfirmationAction,
  updateEventRegistrationAttendeeAction,
} from "../actions";

type Params = Promise<{
  id: string;
  registrationId: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type EventRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  visibility: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  client_id: string | null;
  ticket_type_id: string | null;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  quantity: number | null;
  order_id: string | null;
  status: string;
  payment_status: string | null;
  total_amount: number | null;
  total_price: number | null;
  currency: string | null;
  checked_in_at: string | null;
  notes: string | null;
  created_at: string;
  clients:
    | { id: string; first_name: string | null; last_name: string | null }
    | { id: string; first_name: string | null; last_name: string | null }[]
    | null;
  event_ticket_types:
    | { name: string; ticket_kind: string | null; attendees_per_ticket: number | null }
    | { name: string; ticket_kind: string | null; attendees_per_ticket: number | null }[]
    | null;
};

type AttendeeRow = {
  id: string;
  registration_id: string;
  event_id: string | null;
  ticket_type_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  attendee_role: string | null;
  sort_order: number | null;
  checked_in_at: string | null;
  checked_in_by: string | null;
  waiver_signed_at: string | null;
  ticket_code: string | null;
  ticket_token: string | null;
  ticket_issued_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type ItemRow = {
  id: string;
  registration_id: string;
  ticket_type_id: string | null;
  ticket_name_snapshot: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
  created_at: string;
};

type OrderSiblingRegistrationRow = {
  id: string;
  ticket_type_id: string | null;
  quantity: number | null;
  total_amount: number | null;
  total_price: number | null;
  currency: string | null;
  payment_status: string | null;
  status: string | null;
  event_ticket_types:
    | { name: string | null }
    | { name: string | null }[]
    | null;
};

type PaymentRow = {
  id: string;
  registration_id: string;
  amount: number;
  currency: string;
  payment_method: string;
  status: string;
  refund_amount: number | null;
  refunded_at: string | null;
  source: string | null;
  created_at: string;
};

type TicketEmailAuditRow = {
  id: string;
  related_id: string | null;
  template_key: string | null;
  recipient_email: string | null;
  status: string | null;
  sent_at: string | null;
  error_message: string | null;
  created_at: string;
};

type EventDocumentRequirementRow = {
  id: string;
  template_id: string;
  is_required: boolean;
  active: boolean;
  document_templates:
    | { title: string | null }
    | { title: string | null }[]
    | null;
};

type DocumentSignatureRow = {
  id: string;
  event_registration_id: string | null;
  template_id: string;
  template_version_id: string | null;
  signer_name: string;
  signer_email: string | null;
  signer_user_id: string | null;
  signature_method: string | null;
  signature_text: string | null;
  consent_text: string | null;
  ip_address: string | null;
  user_agent: string | null;
  device_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  signed_at: string;
  document_templates:
    | { title: string | null }
    | { title: string | null }[]
    | null;
  document_template_versions:
    | { version_number: number | null; title: string | null }
    | { version_number: number | null; title: string | null }[]
    | null;
};

type DocumentAuditEventRow = {
  id: string;
  signature_id: string | null;
  assignment_id: string | null;
  template_id: string | null;
  template_version_id: string | null;
  event_type: string;
  event_summary: string | null;
  actor_email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

function statusBadgeClass(status: string | null) {
  if (status === "registered" || status === "confirmed") {
    return "bg-green-50 text-green-700 ring-1 ring-green-200";
  }
  if (status === "pending") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "waitlisted") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  if (status === "checked_in" || status === "attended") {
    return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function paymentBadgeClass(status: string | null) {
  if (status === "paid") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "pending") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "partial") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (status === "refunded" || status === "failed") {
    return "bg-red-50 text-red-700 ring-1 ring-red-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function friendlyEventValue(value: string | null | undefined) {
  const normalized = (value ?? "").trim();
  if (!normalized) return "Not recorded";

  return normalized
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function paymentMethodLabel(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "Payment method not recorded";
  if (normalized === "card") return "Card";
  if (normalized === "stripe") return "Stripe";
  if (normalized === "external_card") return "External card";
  if (normalized === "cash") return "Cash";
  if (normalized === "check") return "Check";
  if (normalized === "venmo") return "Venmo";
  if (normalized === "zelle") return "Zelle";
  if (normalized === "comp" || normalized === "comped") return "Comp";

  return friendlyEventValue(value);
}

function paymentSourceLabel(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "No source recorded";
  if (normalized === "stripe_checkout" || normalized === "checkout") return "Stripe checkout";
  if (normalized === "manual" || normalized === "admin") return "Manual entry";
  if (normalized === "external") return "External payment";
  if (normalized === "event") return "Event payment";

  return friendlyEventValue(value);
}

function ticketEmailStatusText(email: TicketEmailAuditRow | null) {
  if (!email) return "Not sent from DanceFlow";
  if (email.error_message || email.status === "failed") return "Failed";
  if (email.status === "sent" && email.sent_at) {
    return `Sent ${formatDateTime(email.sent_at)}`;
  }

  return `${friendlyEventValue(email.status ?? "queued")} ${formatDateTime(email.created_at)}`;
}

function visibilityPanelClass(needsAttention: boolean) {
  return needsAttention
    ? "border-amber-200 bg-amber-50"
    : "border-emerald-200 bg-emerald-50";
}

function shouldBlockAttendanceForPayment(paymentStatus: string | null) {
  return ["pending", "unpaid", "failed", "refunded"].includes(paymentStatus ?? "");
}

function isRegistrationActiveForCheckIn(registration: Pick<RegistrationRow, "status" | "payment_status">) {
  return ["confirmed", "registered", "checked_in", "attended"].includes(registration.status ?? "") &&
    !shouldBlockAttendanceForPayment(registration.payment_status);
}

function ticketQrSrc(ticketCode: string) {
  return `/api/tickets/qr?code=${encodeURIComponent(ticketCode)}`;
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "resend_ticket_confirmation_queued") {
    return { kind: "success" as const, message: "Ticket confirmation email was queued." };
  }
  if (search.success === "attendee_updated") {
    return { kind: "success" as const, message: "Attendee details updated." };
  }
  if (search.error === "attendee_name_required") {
    return { kind: "error" as const, message: "Attendee first and last name are required." };
  }
  if (search.error === "attendee_update_failed") {
    return { kind: "error" as const, message: "Attendee details could not be updated." };
  }
  if (search.error === "resend_not_confirmed") {
    return { kind: "error" as const, message: "Only confirmed or active registrations can receive ticket confirmations." };
  }
  if (search.error === "resend_not_paid") {
    return { kind: "error" as const, message: "Ticket confirmations can only be sent for paid registrations." };
  }
  if (search.error === "resend_missing_email") {
    return { kind: "error" as const, message: "This registration does not have an email address." };
  }
  if (search.error === "resend_ticket_failed") {
    return { kind: "error" as const, message: "Ticket confirmation could not be queued." };
  }
  return null;
}

function requirementTitle(value: EventDocumentRequirementRow["document_templates"]) {
  return one(value)?.title ?? "Required document";
}

function compactJson(value: Record<string, unknown> | null) {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function signatureDocumentTitle(signature: DocumentSignatureRow) {
  return one(signature.document_template_versions)?.title ??
    one(signature.document_templates)?.title ??
    "Signed document";
}

function signatureVersionLabel(signature: DocumentSignatureRow) {
  const version = one(signature.document_template_versions);
  return typeof version?.version_number === "number"
    ? `Version ${version.version_number}`
    : "Version not recorded";
}

export default async function EventRegistrationDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id, registrationId } = await params;

  await requireEventWorkspaceFeature({
    eventId: id,
    feature: "organizer_tools",
    allowedOrganizerRoles: ["organizer_owner", "organizer_admin", "organizer_staff"],
  });

  const search = await searchParams;
  const banner = getBanner(search);
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [
    { data: event, error: eventError },
    { data: registration, error: registrationError },
    { data: attendees, error: attendeesError },
    { data: items, error: itemsError },
    { data: payments, error: paymentsError },
    { data: ticketEmails, error: ticketEmailsError },
    { data: documentRequirements, error: documentRequirementsError },
    { data: documentSignatures, error: documentSignaturesError },
    { data: documentAuditEvents, error: documentAuditEventsError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select("id, name, slug, status, visibility")
      .eq("id", id)
      .eq("studio_id", studioId)
      .single<EventRow>(),

    supabase
      .from("event_registrations")
      .select(
        `
        id,
        event_id,
        client_id,
        ticket_type_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        quantity,
        order_id,
        status,
        payment_status,
        total_amount,
        total_price,
        currency,
        checked_in_at,
        notes,
        created_at,
        clients ( id, first_name, last_name ),
        event_ticket_types ( name, ticket_kind, attendees_per_ticket )
      `,
      )
      .eq("id", registrationId)
      .eq("event_id", id)
      .maybeSingle<RegistrationRow>(),

    supabase
      .from("event_registration_attendees")
      .select(
        `
        id,
        registration_id,
        event_id,
        ticket_type_id,
        first_name,
        last_name,
        email,
        phone,
        attendee_role,
        sort_order,
        checked_in_at,
        checked_in_by,
        waiver_signed_at,
        ticket_code,
        ticket_token,
        ticket_issued_at,
        created_at,
        updated_at
      `,
      )
      .eq("registration_id", registrationId)
      .order("sort_order", { ascending: true }),

    supabase
      .from("event_registration_items")
      .select("id, registration_id, ticket_type_id, ticket_name_snapshot, quantity, unit_price, line_total, created_at")
      .eq("registration_id", registrationId)
      .order("created_at", { ascending: true }),

    supabase
      .from("event_payments")
      .select("id, registration_id, amount, currency, payment_method, status, refund_amount, refunded_at, source, created_at")
      .eq("registration_id", registrationId)
      .order("created_at", { ascending: false }),

    supabase
      .from("outbound_deliveries")
      .select("id, related_id, template_key, recipient_email, status, sent_at, error_message, created_at")
      .eq("related_table", "event_registrations")
      .eq("related_id", registrationId)
      .in("template_key", [
        "event_ticket_confirmation",
        "event_registration_ticket_confirmation",
        "event_registration_ticket_confirmation_resend",
      ])
      .order("created_at", { ascending: false }),

    supabase
      .from("event_document_requirements")
      .select("id, template_id, is_required, active, document_templates ( title )")
      .eq("event_id", id)
      .eq("active", true)
      .eq("is_required", true),

    supabase
      .from("document_signatures")
      .select(
        `
        id,
        event_registration_id,
        template_id,
        template_version_id,
        signer_name,
        signer_email,
        signer_user_id,
        signature_method,
        signature_text,
        consent_text,
        ip_address,
        user_agent,
        device_metadata,
        metadata,
        signed_at,
        document_templates ( title ),
        document_template_versions ( version_number, title )
      `,
      )
      .eq("event_registration_id", registrationId),

    supabase
      .from("document_signature_audit_events")
      .select(
        "id, signature_id, assignment_id, template_id, template_version_id, event_type, event_summary, actor_email, ip_address, user_agent, metadata, created_at",
      )
      .eq("event_registration_id", registrationId)
      .order("created_at", { ascending: false }),
  ]);

  if (eventError || !event) notFound();
  if (registrationError) throw new Error(`Failed to load registration: ${registrationError.message}`);
  if (!registration) notFound();
  if (attendeesError) throw new Error(`Failed to load attendees: ${attendeesError.message}`);
  if (itemsError) throw new Error(`Failed to load ticket items: ${itemsError.message}`);
  if (paymentsError) throw new Error(`Failed to load payments: ${paymentsError.message}`);
  if (ticketEmailsError) throw new Error(`Failed to load ticket email audit: ${ticketEmailsError.message}`);
  if (documentRequirementsError) throw new Error(`Failed to load document requirements: ${documentRequirementsError.message}`);
  if (documentSignaturesError) throw new Error(`Failed to load document signatures: ${documentSignaturesError.message}`);
  if (documentAuditEventsError) throw new Error(`Failed to load document signature audit events: ${documentAuditEventsError.message}`);

  const typedRegistration = registration as RegistrationRow;
  const ticket = one(typedRegistration.event_ticket_types);
  const client = one(typedRegistration.clients);
  const attendeeRows = ((attendees ?? []) as AttendeeRow[]).sort(
    (left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0),
  );
  const itemRows = (items ?? []) as ItemRow[];
  const orderSiblingRows = typedRegistration.order_id
    ? ((
        (await supabase
          .from("event_registrations")
          .select(`
            id,
            ticket_type_id,
            quantity,
            total_amount,
            total_price,
            currency,
            payment_status,
            status,
            event_ticket_types ( name )
          `)
          .eq("event_id", id)
          .eq("order_id", typedRegistration.order_id)
          .order("created_at", { ascending: true }))
          .data ?? []
      ) as OrderSiblingRegistrationRow[])
    : [];
  const paymentRows = (payments ?? []) as PaymentRow[];
  const emailRows = (ticketEmails ?? []) as TicketEmailAuditRow[];
  const requirementRows = (documentRequirements ?? []) as EventDocumentRequirementRow[];
  const signatureRows = (documentSignatures ?? []) as DocumentSignatureRow[];
  const auditRows = (documentAuditEvents ?? []) as DocumentAuditEventRow[];

  const fullName = `${typedRegistration.attendee_first_name} ${typedRegistration.attendee_last_name}`.trim();
  const amount = Number(typedRegistration.total_amount ?? typedRegistration.total_price ?? 0);
  const currency = typedRegistration.currency ?? "USD";
  const quantity = Math.max(1, Number(typedRegistration.quantity ?? 1));
  const admitsPerTicket = Math.max(1, Number(ticket?.attendees_per_ticket ?? 1));
  const expectedAttendees = Math.max(1, quantity * admitsPerTicket);
  const issuedTicketCount = attendeeRows.filter((attendee) => Boolean(attendee.ticket_code)).length;
  const latestEmail = emailRows[0] ?? null;
  const signedTemplateIds = new Set(signatureRows.map((signature) => signature.template_id));
  const missingRequirements = requirementRows.filter((requirement) => !signedTemplateIds.has(requirement.template_id));
  const documentsComplete = requirementRows.length === 0 || missingRequirements.length === 0;
  const canResend =
    isRegistrationActiveForCheckIn(typedRegistration) &&
    !shouldBlockAttendanceForPayment(typedRegistration.payment_status) &&
    Boolean(typedRegistration.attendee_email);
  const latestPayment = paymentRows[0] ?? null;
  const paymentNeedsAttention =
    typedRegistration.payment_status !== "paid" || (amount > 0 && paymentRows.length === 0);
  const ticketNeedsAttention =
    issuedTicketCount < expectedAttendees || !isRegistrationActiveForCheckIn(typedRegistration);
  const emailNeedsAttention =
    !latestEmail || latestEmail.status === "failed" || Boolean(latestEmail.error_message);
  const documentNeedsAttention = requirementRows.length > 0 && !documentsComplete;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col gap-4 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm lg:flex-row lg:items-start lg:justify-between">
          <div>
            <Link
              href={`/app/events/${id}/registrations`}
              className="text-sm font-semibold text-indigo-600 hover:text-indigo-700"
            >
              ← Back to registrations
            </Link>
            <p className="mt-4 text-sm font-semibold uppercase tracking-[0.25em] text-indigo-600">
              Ticket / Attendee Detail
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
              {fullName || typedRegistration.attendee_email}
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              {event.name} • Registered {formatDateTime(typedRegistration.created_at)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(typedRegistration.status)}`}>
              {typedRegistration.status}
            </span>
            <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${paymentBadgeClass(typedRegistration.payment_status)}`}>
              {typedRegistration.payment_status ?? "unknown"}
            </span>
            <span className="inline-flex rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700 ring-1 ring-violet-200">
              {issuedTicketCount}/{expectedAttendees} QR tickets issued
            </span>
          </div>
        </div>

        {banner ? (
          <div
            className={`rounded-2xl border px-4 py-3 text-sm font-medium ${
              banner.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {banner.message}
          </div>
        ) : null}

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Registration payment visibility</h2>
              <p className="mt-1 text-sm text-slate-500">
                Confirm payment source, ticket email delivery, QR ticket issuance, and required documents before check-in.
              </p>
            </div>
            <Link
              href={`/app/events/${id}/check-in`}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Open Check-In
            </Link>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className={`rounded-2xl border p-4 ${visibilityPanelClass(paymentNeedsAttention)}`}>
              <p className="text-sm font-semibold text-slate-900">Payment</p>
              <p className="mt-2 text-sm font-medium text-slate-950">
                {latestPayment
                  ? `${paymentMethodLabel(latestPayment.payment_method)} • ${paymentSourceLabel(latestPayment.source)}`
                  : typedRegistration.payment_status === "paid"
                    ? "Paid, no payment row"
                    : "No payment logged"}
              </p>
              <p className="mt-2 text-xs text-slate-600">
                Status: {typedRegistration.payment_status ?? "unknown"} • {paymentRows.length} row
                {paymentRows.length === 1 ? "" : "s"}
              </p>
            </div>

            <div className={`rounded-2xl border p-4 ${visibilityPanelClass(emailNeedsAttention)}`}>
              <p className="text-sm font-semibold text-slate-900">Ticket Email</p>
              <p className="mt-2 text-sm font-medium text-slate-950">
                {ticketEmailStatusText(latestEmail)}
              </p>
              <p className="mt-2 text-xs text-slate-600">
                {emailRows.length} attempt{emailRows.length === 1 ? "" : "s"} recorded
              </p>
            </div>

            <div className={`rounded-2xl border p-4 ${visibilityPanelClass(ticketNeedsAttention)}`}>
              <p className="text-sm font-semibold text-slate-900">QR Tickets</p>
              <p className="mt-2 text-sm font-medium text-slate-950">
                {issuedTicketCount}/{expectedAttendees} issued
              </p>
              <p className="mt-2 text-xs text-slate-600">
                {isRegistrationActiveForCheckIn(typedRegistration)
                  ? "Active for check-in"
                  : "Not active for check-in yet"}
              </p>
            </div>

            <div className={`rounded-2xl border p-4 ${visibilityPanelClass(documentNeedsAttention)}`}>
              <p className="text-sm font-semibold text-slate-900">Documents</p>
              <p className="mt-2 text-sm font-medium text-slate-950">
                {requirementRows.length === 0
                  ? "None required"
                  : documentsComplete
                    ? "Complete"
                    : "Missing waiver"}
              </p>
              <p className="mt-2 text-xs text-slate-600">
                {requirementRows.length === 0
                  ? "No required documents for this event"
                  : `${requirementRows.length - missingRequirements.length}/${requirementRows.length} required complete`}
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Amount</p>
            <p className="mt-2 text-2xl font-bold text-slate-950">{formatCurrency(amount, currency)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Ticket</p>
            <p className="mt-2 font-semibold text-slate-950">{ticket?.name ?? "No ticket type"}</p>
            <p className="mt-1 text-xs text-slate-500">
              {quantity} purchased × admits {admitsPerTicket}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Client Link</p>
            <p className="mt-2 font-semibold text-slate-950">
              {client ? `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || "Linked client" : "Not linked"}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Documents</p>
            <p className="mt-2 font-semibold text-slate-950">
              {requirementRows.length === 0
                ? "None required"
                : documentsComplete
                  ? "Complete"
                  : "Missing waiver"}
            </p>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-950">Attendees & QR Tickets</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Edit attendee names without changing QR codes, payment status, or check-in history.
                </p>
              </div>
              <form action={resendEventTicketConfirmationAction}>
                <input type="hidden" name="eventId" value={id} />
                <input type="hidden" name="registrationId" value={registrationId} />
                <button
                  type="submit"
                  disabled={!canResend}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {orderSiblingRows.length > 1 ? "Resend full checkout confirmation" : "Resend ticket confirmation"}
                </button>
              </form>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {attendeeRows.length === 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  No attendee QR rows have been issued yet. Use the resend confirmation action to repair missing rows, or review the registration and payment status first.
                </div>
              ) : (
                attendeeRows.map((attendee, index) => {
                  const attendeeName = `${attendee.first_name ?? ""} ${attendee.last_name ?? ""}`.trim() || `Attendee ${index + 1}`;

                  return (
                    <div key={attendee.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex gap-4">
                        <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white p-2">
                          {attendee.ticket_code ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={ticketQrSrc(attendee.ticket_code)} alt={`QR code for ${attendeeName}`} className="h-full w-full" />
                          ) : (
                            <span className="text-center text-xs text-slate-400">No QR</span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-950">{index + 1}. {attendeeName}</p>
                          <p className="mt-1 text-xs text-slate-500">{attendee.email || "No email"}{attendee.phone ? ` • ${attendee.phone}` : ""}</p>
                          <p className="mt-2 font-mono text-xs font-semibold text-slate-700">{attendee.ticket_code ?? "No ticket code"}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            {attendee.checked_in_at ? `Checked in ${formatDateTime(attendee.checked_in_at)}` : "Not checked in"}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {attendee.waiver_signed_at ? `Waiver signed ${formatDateTime(attendee.waiver_signed_at)}` : "Waiver not signed on attendee row"}
                          </p>
                        </div>
                      </div>

                      <details className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
                        <summary className="cursor-pointer text-sm font-semibold text-slate-700">Edit attendee details</summary>
                        <form action={updateEventRegistrationAttendeeAction} className="mt-3 grid gap-3 sm:grid-cols-2">
                          <input type="hidden" name="eventId" value={id} />
                          <input type="hidden" name="registrationId" value={registrationId} />
                          <input type="hidden" name="attendeeId" value={attendee.id} />
                          <label className="text-sm font-medium text-slate-700">
                            First name
                            <input name="firstName" defaultValue={attendee.first_name ?? ""} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" required />
                          </label>
                          <label className="text-sm font-medium text-slate-700">
                            Last name
                            <input name="lastName" defaultValue={attendee.last_name ?? ""} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" required />
                          </label>
                          <label className="text-sm font-medium text-slate-700">
                            Email
                            <input name="email" type="email" defaultValue={attendee.email ?? ""} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
                          </label>
                          <label className="text-sm font-medium text-slate-700">
                            Phone
                            <input name="phone" defaultValue={attendee.phone ?? ""} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
                          </label>
                          <div className="sm:col-span-2">
                            <button type="submit" className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                              Save attendee
                            </button>
                          </div>
                        </form>
                      </details>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-950">Ticket Email Audit</h2>
              <p className="mt-1 text-sm text-slate-500">Confirmation and resend attempts for this registration.</p>
              <div className="mt-4 space-y-3">
                {emailRows.length === 0 ? (
                  <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                    No ticket confirmation email has been recorded yet.
                  </p>
                ) : (
                  emailRows.map((email) => (
                    <div key={email.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold text-slate-900">{ticketEmailStatusText(email)}</span>
                        <span className="text-xs text-slate-500">{formatDateTime(email.sent_at ?? email.created_at)}</span>
                      </div>
                      <p className="mt-1 text-slate-600">To {email.recipient_email ?? "unknown recipient"}</p>
                      {email.error_message ? <p className="mt-2 text-red-600">{email.error_message}</p> : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-950">Payment Log</h2>
              <div className="mt-4 space-y-3">
                {paymentRows.length === 0 ? (
                  <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">No event payment row is linked to this registration.</p>
                ) : (
                  paymentRows.map((payment) => (
                    <div key={payment.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold text-slate-900">{formatCurrency(Number(payment.amount ?? 0), payment.currency ?? "USD")}</span>
                        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${paymentBadgeClass(payment.status)}`}>{payment.status}</span>
                      </div>
                      <p className="mt-1 text-slate-600">
                        {paymentMethodLabel(payment.payment_method)} • {paymentSourceLabel(payment.source)}
                      </p>
                      {Number(payment.refund_amount ?? 0) > 0 ? (
                        <p className="mt-2 text-red-600">Refunded {formatCurrency(Number(payment.refund_amount ?? 0), payment.currency ?? "USD")} {payment.refunded_at ? `on ${formatDateTime(payment.refunded_at)}` : ""}</p>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        {orderSiblingRows.length > 1 ? (
          <section className="rounded-[28px] border border-purple-100 bg-purple-50 p-5 shadow-sm">
            <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Same Checkout</h2>
                <p className="mt-1 text-sm text-purple-900">
                  This purchase included multiple ticket options. Each ticket option has its own registration record so check-in and attendee details stay clear.
                </p>
              </div>
              <Link href={`/app/events/${id}/registrations`} className="text-sm font-semibold text-purple-800 hover:text-purple-950">
                View all registrations
              </Link>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {orderSiblingRows.map((sibling) => {
                const siblingTicket = one(sibling.event_ticket_types);
                const siblingTotal = Number(sibling.total_amount ?? sibling.total_price ?? 0);
                const isCurrent = sibling.id === typedRegistration.id;

                return (
                  <Link
                    key={sibling.id}
                    href={`/app/events/${id}/registrations/${sibling.id}`}
                    className={`rounded-2xl border p-4 text-sm transition ${
                      isCurrent
                        ? "border-purple-300 bg-white shadow-sm"
                        : "border-purple-100 bg-white/80 hover:bg-white"
                    }`}
                  >
                    <p className="font-semibold text-slate-950">
                      {siblingTicket?.name ?? "Event ticket"}
                      {isCurrent ? " · Current" : ""}
                    </p>
                    <p className="mt-1 text-slate-600">Quantity {sibling.quantity ?? 1}</p>
                    <p className="mt-2 font-semibold text-slate-950">
                      {formatCurrency(siblingTotal, sibling.currency ?? currency)}
                    </p>
                    <p className="mt-2 text-xs text-slate-500">
                      {friendlyEventValue(sibling.status)} · {friendlyEventValue(sibling.payment_status)}
                    </p>
                  </Link>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="grid gap-6 xl:grid-cols-2">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">Purchased Ticket Option</h2>
            <div className="mt-4 space-y-3">
              {itemRows.length === 0 ? (
                <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">No purchased ticket item rows are linked to this registration.</p>
              ) : (
                itemRows.map((item) => (
                  <div key={item.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
                    <div>
                      <p className="font-semibold text-slate-900">{item.ticket_name_snapshot ?? ticket?.name ?? "Event ticket"}</p>
                      <p className="mt-1 text-slate-500">Quantity {item.quantity ?? 1} × {formatCurrency(Number(item.unit_price ?? 0), currency)}</p>
                    </div>
                    <p className="font-semibold text-slate-950">{formatCurrency(Number(item.line_total ?? 0), currency)}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">Waiver / Document Status</h2>
            <div className="mt-4 space-y-3">
              {requirementRows.length === 0 ? (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">No required documents for this event.</p>
              ) : documentsComplete ? (
                <p className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">All required documents are signed.</p>
              ) : (
                missingRequirements.map((requirement) => (
                  <p key={requirement.id} className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    Missing: {requirementTitle(requirement.document_templates)}
                  </p>
                ))
              )}
              {signatureRows.map((signature) => (
                <div key={signature.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-semibold text-slate-900">{signatureDocumentTitle(signature)}</p>
                      <p className="mt-1 text-slate-600">
                        Signed by {signature.signer_name} {signature.signer_email ? `• ${signature.signer_email}` : ""}
                      </p>
                    </div>
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                      Signed
                    </span>
                  </div>
                  <div className="mt-4">
                    <Link
                      href={`/app/events/${id}/registrations/${registrationId}/signed-documents/${signature.id}`}
                      className="inline-flex rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                    >
                      Open printable receipt
                    </Link>
                    <Link
                      href={`/app/events/${id}/registrations/${registrationId}/signed-documents/${signature.id}/pdf`}
                      className="ml-2 inline-flex rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
                    >
                      Download PDF
                    </Link>
                  </div>
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Signed at</dt>
                      <dd className="mt-1 text-slate-900">{formatDateTime(signature.signed_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Document version</dt>
                      <dd className="mt-1 text-slate-900">{signatureVersionLabel(signature)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Signature method</dt>
                      <dd className="mt-1 text-slate-900">{friendlyEventValue(signature.signature_method ?? "typed")}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">IP address</dt>
                      <dd className="mt-1 text-slate-900">{signature.ip_address ?? "Not recorded"}</dd>
                    </div>
                  </dl>
                  {signature.consent_text ? (
                    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Consent accepted</p>
                      <p className="mt-2 whitespace-pre-wrap text-slate-700">{signature.consent_text}</p>
                    </div>
                  ) : null}
                  {signature.user_agent ? (
                    <p className="mt-3 break-words text-xs text-slate-500">User agent: {signature.user_agent}</p>
                  ) : null}
                  {compactJson(signature.device_metadata) ? (
                    <p className="mt-2 break-words text-xs text-slate-500">Device: {compactJson(signature.device_metadata)}</p>
                  ) : null}
                </div>
              ))}
              {auditRows.length > 0 ? (
                <details className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
                  <summary className="cursor-pointer font-semibold text-slate-800">Signature audit trail</summary>
                  <div className="mt-4 space-y-3">
                    {auditRows.map((event) => (
                      <div key={event.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                          <p className="font-semibold text-slate-900">{friendlyEventValue(event.event_type)}</p>
                          <p className="text-xs text-slate-500">{formatDateTime(event.created_at)}</p>
                        </div>
                        {event.event_summary ? <p className="mt-1 text-slate-600">{event.event_summary}</p> : null}
                        <p className="mt-2 text-xs text-slate-500">
                          {event.actor_email ?? "No actor email"}{event.ip_address ? ` • ${event.ip_address}` : ""}
                        </p>
                        {event.user_agent ? (
                          <p className="mt-1 break-words text-xs text-slate-500">User agent: {event.user_agent}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          </div>
        </section>

        {typedRegistration.notes ? (
          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">Notes</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{typedRegistration.notes}</p>
          </section>
        ) : null}
      </div>
    </main>
  );
}
