import Link from "next/link";

const portalChecks = [
  "Confirm the client email on the studio client record matches the email the student is using to sign in.",
  "Check whether an auth.users row exists for that email and whether email_confirmed_at is populated.",
  "Check whether public.profiles has a row with the same id as auth.users.id.",
  "Check whether public.client_account_links has a linked row connecting the client to the matching auth user.",
  "Use the platform studio detail repair action when the auth user exists but the account-link row is missing.",
];

const portalSql = `select
  c.id as client_id,
  c.first_name,
  c.last_name,
  c.email as client_email,
  cal.id as account_link_id,
  cal.status as account_link_status,
  cal.relationship_type,
  cal.user_id,
  p.id as profile_id,
  p.email as profile_email,
  u.id as auth_user_id,
  u.email as auth_email,
  u.email_confirmed_at,
  u.last_sign_in_at
from public.clients c
left join public.client_account_links cal
  on cal.client_id = c.id
  and cal.studio_id = c.studio_id
left join public.profiles p
  on p.id = cal.user_id
left join auth.users u
  on u.id = cal.user_id
where lower(c.email) = lower('student@example.com');`;

const inviteSql = `select
  id,
  studio_id,
  template_key,
  recipient_email,
  related_table,
  related_id,
  status,
  provider_message_id,
  error_message,
  sent_at,
  created_at
from public.outbound_deliveries
where template_key = 'client_portal_invite'
  and lower(recipient_email) = lower('student@example.com')
order by created_at desc
limit 10;`;

const ticketEmailSql = `select
  id,
  template_key,
  recipient_email,
  related_table,
  related_id,
  status,
  provider_message_id,
  error_message,
  sent_at,
  created_at
from public.outbound_deliveries
where template_key = 'event_ticket_confirmation'
  and related_table = 'event_registrations'
  and related_id = 'registration-id-here'
order by created_at desc;`;

function SupportNoteCard({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">
          Internal note
        </p>
        <h2 className="mt-2 text-xl font-semibold text-slate-950">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">{summary}</p>
      </div>
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}

function SqlBlock({ value }: { value: string }) {
  return (
    <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-4 text-xs leading-6 text-slate-100">
      <code>{value}</code>
    </pre>
  );
}

export default function PlatformSupportNotesPage() {
  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-600">
              Platform only
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              Internal Support Notes
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              Use these notes for platform support and diagnostics only. Do not copy these details into public help articles, studio-facing pages, student portal pages, or customer support replies without translating them into plain operational language.
            </p>
          </div>

          <Link
            href="/platform/studios"
            className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            Open Studios
          </Link>
        </div>
      </section>

      <SupportNoteCard
        title="Portal access troubleshooting"
        summary="Use this when a student says they cannot access the portal after receiving an invite or magic link."
      >
        <div className="rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          Keep the studio-facing explanation simple: “The portal account was not connected yet. We reconnected it and they can try again.” Do not mention auth.users, profiles, client_account_links, or raw IDs to the studio.
        </div>

        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-700">
          {portalChecks.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>

        <SqlBlock value={portalSql} />
      </SupportNoteCard>

      <SupportNoteCard
        title="Portal invite delivery troubleshooting"
        summary="Use this when a studio says a student did not receive the portal invite email."
      >
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
          <li>Confirm the client email is correct and does not contain extra spaces or typos.</li>
          <li>Check outbound_deliveries for template_key = client_portal_invite.</li>
          <li>If status is failed, review error_message and resend after correcting the email if needed.</li>
          <li>If status is sent, have the student check spam/promotions and request a new portal sign-in link from the portal login screen.</li>
        </ul>

        <SqlBlock value={inviteSql} />
      </SupportNoteCard>

      <SupportNoteCard
        title="Password reset troubleshooting"
        summary="Use this when a user receives a reset email but does not reach the reset password form."
      >
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
          <li>Ask the user to use the newest reset email only. Recovery links are short-lived and single-use.</li>
          <li>The expected route after the callback is /reset-password.</li>
          <li>After updateUser succeeds, the app should redirect to /login?mode=password-updated.</li>
          <li>If the user returns to login without updating, generate a fresh reset email and retest the full flow.</li>
        </ul>
      </SupportNoteCard>

      <SupportNoteCard
        title="Event ticket email troubleshooting"
        summary="Use this when ticket confirmation resend says it succeeded or failed but the recipient reports no email."
      >
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
          <li>Confirm the event registration email is correct.</li>
          <li>Check outbound_deliveries for template_key = event_ticket_confirmation and related_table = event_registrations.</li>
          <li>Review status, sent_at, provider_message_id, and error_message.</li>
          <li>If QR rows are missing, verify event_registration_attendees exists for the registration before resending.</li>
        </ul>

        <SqlBlock value={ticketEmailSql} />
      </SupportNoteCard>

      <SupportNoteCard
        title="Event registration payment visibility troubleshooting"
        summary="Use this when the registration list or detail page shows an unexpected payment/source status."
      >
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
          <li>Compare event_registrations.status and event_registrations.payment_status first.</li>
          <li>Check event_payments for the matching registration/order when payment source is unclear.</li>
          <li>Manual sales should have an admin/manual source and a payment record where applicable.</li>
          <li>Stripe checkout payments should reconcile to Stripe payment intent or checkout session metadata.</li>
          <li>Do not expose raw payment identifiers to studio staff unless needed for a support escalation.</li>
        </ul>
      </SupportNoteCard>

      <SupportNoteCard
        title="Guest coach slot troubleshooting"
        summary="Use this when staff cannot find or manage coach lesson slots for an event."
      >
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
          <li>Open the event in the platform or studio app and use Manage Coach Slots.</li>
          <li>The event-specific route is /app/events/[id]/private-lessons.</li>
          <li>Confirm private lesson slots exist for the event and are not marked unavailable unless intentionally blocked.</li>
          <li>Blocked/offline slots should keep the reason readable for staff, such as break, group class, or manually blocked.</li>
        </ul>
      </SupportNoteCard>
    </div>
  );
}
