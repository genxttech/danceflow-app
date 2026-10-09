import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { loadCompetitionRegistrationStatus, type CompetitionRegistrationDisplayState } from "@/lib/competition/registrationCheckout";
import { competitionRegistrationUrls } from "@/lib/competition/registrationUrls";

/*
  Phase 10C: the competition registration result page. Payment state comes ONLY from server-side
  order/payment state (and, while the order is pending, the bound Stripe session's status). A
  returning browser is never proof of payment: until the verified webhook finalizes, the buyer
  sees "processing", never "confirmed".
*/

export const dynamic = "force-dynamic";

const competitionRegistrationEnabled =
  process.env.NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED === "true";

const COPY: Record<CompetitionRegistrationDisplayState, { title: string; body: string; tone: string }> = {
  confirmed: { title: "Registration confirmed", body: "Your entries are confirmed. A confirmation will be sent to the registration contact.", tone: "border-emerald-200 bg-emerald-50 text-emerald-900" },
  processing: { title: "Payment processing", body: "Stripe has your payment and we are confirming it. This page updates when the payment is confirmed; refresh in a moment.", tone: "border-sky-200 bg-sky-50 text-sky-900" },
  awaiting_payment: { title: "Payment not completed", body: "Your entries are held while you finish payment. They are not confirmed until payment completes.", tone: "border-amber-200 bg-amber-50 text-amber-900" },
  awaiting_signature: { title: "Documents still need signing", body: "Sign the required event documents from the secure link to continue to payment.", tone: "border-amber-200 bg-amber-50 text-amber-900" },
  expired: { title: "Registration hold expired", body: "Payment was not completed in time, so these entries were released. Start a new registration to enter.", tone: "border-slate-200 bg-slate-50 text-slate-800" },
  cancelled: { title: "Registration cancelled", body: "Checkout was cancelled and these entries were released. You were not charged.", tone: "border-slate-200 bg-slate-50 text-slate-800" },
  payment_failed: { title: "Payment failed", body: "The payment did not go through and these entries were released. Start a new registration to try again.", tone: "border-rose-200 bg-rose-50 text-rose-900" },
  needs_review: { title: "We received your payment", body: "Your payment arrived but the registration needs review by the organizer. They will contact you.", tone: "border-amber-200 bg-amber-50 text-amber-900" },
};

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export default async function CompetitionRegistrationStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  if (!competitionRegistrationEnabled) notFound();
  const { slug } = await params;
  const { token } = await searchParams;
  let stripe = null;
  try {
    stripe = getStripe();
  } catch {
    stripe = null;
  }
  const status = await loadCompetitionRegistrationStatus({ admin: createAdminClient(), stripe, token: token ?? "", eventSlug: slug });
  if (!status) notFound();
  const copy = COPY[status.state];
  const resumeUrl = token ? competitionRegistrationUrls("", slug, token).resumeUrl : null;

  return <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
    <header className="border-b border-slate-200 pb-5">
      <Link href={`/events/${encodeURIComponent(slug)}`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to event</Link>
      <h1 className="mt-2 text-2xl font-semibold text-slate-950">Competition Registration</h1>
      <p className="mt-1 text-sm text-slate-600">{status.eventName}</p>
    </header>
    <section role="status" aria-live="polite" className={`my-6 border p-4 text-sm ${copy.tone}`}>
      <p className="font-semibold">{copy.title}</p>
      <p className="mt-1">{copy.body}</p>
    </section>
    <section className="border-y border-slate-200">
      <h2 className="sr-only">Entries</h2>
      <ul className="divide-y divide-slate-200">
        {status.entries.map((entry, index) => <li key={`${entry.label}-${index}`} className="flex items-start justify-between gap-4 py-3 text-sm">
          <span className="min-w-0 break-words text-slate-800">{entry.label}</span>
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">{entry.status}</span>
        </li>)}
      </ul>
      <div className="flex justify-between border-t border-slate-200 py-3 text-sm font-semibold text-slate-900">
        <span>Total</span><span>{money(status.totalCents, status.currency)}</span>
      </div>
    </section>
    {status.state === "awaiting_payment" && resumeUrl ? <a href={resumeUrl} className="mt-6 inline-flex h-10 items-center rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">Continue to payment</a> : null}
    {["expired", "cancelled", "payment_failed"].includes(status.state) ? <Link href={`/events/${encodeURIComponent(slug)}/competition/register`} className="mt-6 inline-flex h-10 items-center rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">Start a new registration</Link> : null}
  </main>;
}
