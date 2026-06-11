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
  signer_name: string;
  signer_email: string | null;
  signed_at: string;
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
      .select("id, event_registration_id, template_id, signer_name, signer_email, signed_at")
      .eq("event_registration_id", registrationId),
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

  const typedRegistration = registration as RegistrationRow;
  const ticket = one(typedRegistration.event_ticket_types);
  const client = one(typedRegistration.clients);
  const attendeeRows = ((attendees ?? []) as AttendeeRow[]).sort(
    (left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0),
  );
  const itemRows = (items ?? []) as ItemRow[];
  const paymentRows = (payments ?? []) as PaymentRow[];
  const emailRows = (ticketEmails ?? []) as TicketEmailAuditRow[];
  const requirementRows = (documentRequirements ?? []) as EventDocumentRequirementRow[];
  const signatureRows = (documentSignatures ?? []) as DocumentSignatureRow[];

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
                  Resend ticket confirmation
                </button>
              </form>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {attendeeRows.length === 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  No attendee QR rows have been issued yet. Use resend ticket confirmation to repair missing rows, or review the registration status/payment status first.
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
                        <span className="font-semibold text-slate-900">{email.status ?? "queued"}</span>
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
                      <p className="mt-1 text-slate-600">{payment.payment_method} • {payment.source ?? "event payment"}</p>
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

        <section className="grid gap-6 xl:grid-cols-2">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">Ticket Items</h2>
            <div className="mt-4 space-y-3">
              {itemRows.length === 0 ? (
                <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">No ticket item rows are linked to this registration.</p>
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
                  <p className="font-semibold text-slate-900">Signed by {signature.signer_name}</p>
                  <p className="mt-1 text-slate-500">{signature.signer_email ?? "No email"} • {formatDateTime(signature.signed_at)}</p>
                </div>
              ))}
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
