import Link from "next/link";
import { isUnsubscribeToken } from "@/lib/marketing/compliance/unsubscribeLinks";

/**
 * Marketing M-0: the marketing unsubscribe confirmation page (studio, organizer and commercial message links).
 * Rendering it changes nothing (mail scanners and link prefetchers open links); the button posts to the unsubscribe
 * endpoint, which needs no login. Nothing about the recipient (email address, workspace) is looked up or shown.
 */

type Kind = "studio" | "organizer";

function errorMessage(code?: string) {
  switch (code) {
    case "rate_limited":
      return "Too many requests. Please wait a minute and try again.";
    case "unavailable":
      return "We could not complete the unsubscribe request. Please try again.";
    default:
      return null;
  }
}

export function UnsubscribeConfirmation(props: { token: string; kind: Kind; done?: string; error?: string }) {
  const tokenValid = isUnsubscribeToken(props.token);
  const sender = props.kind === "organizer" ? "this event organizer" : "this studio";
  const error = errorMessage(props.error);
  const action = `/api/email/unsubscribe/${encodeURIComponent(tokenValid ? props.token.trim().toLowerCase() : "invalid")}`;

  return (
    <main className="min-h-screen bg-[var(--brand-page-bg)] px-4 py-10 text-[var(--brand-text)] sm:px-6">
      <div className="mx-auto max-w-xl">
        <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-gradient-to-r from-[#241432] via-[#4D1F47] to-[#E85D2A] px-6 py-7 text-white">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/75">DanceFlow Marketing</p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight">Email Preferences</h1>
            <p className="mt-2 text-sm leading-6 text-white/85">
              You can unsubscribe from marketing emails from {sender} sent through DanceFlow.
            </p>
          </div>

          <div className="p-6">
            {props.done ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-800" role="status">
                <h2 className="text-lg font-bold">Your request has been received.</h2>
                <p className="mt-2 text-sm leading-6">
                  If this link belongs to a DanceFlow marketing email, that address will not receive further marketing
                  emails from {sender} through DanceFlow.
                </p>
              </div>
            ) : (
              <>
                {error ? (
                  <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700" role="alert">
                    {error}
                  </div>
                ) : null}

                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-5">
                  <h2 className="text-lg font-bold">Unsubscribe from marketing emails?</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
                    This only stops marketing emails from {sender}. You may still receive transactional messages such
                    as receipts, account notices, schedule updates, or registration details.
                  </p>

                  <form action={action} method="post" className="mt-5">
                    <input type="hidden" name="df_source" value="page" />
                    <input type="hidden" name="df_kind" value={props.kind} />
                    <button
                      type="submit"
                      className="inline-flex w-full items-center justify-center rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#3D1839]"
                    >
                      Unsubscribe
                    </button>
                  </form>
                </div>
              </>
            )}

            <div className="mt-5 text-center">
              <Link href="/" className="text-sm font-semibold text-[#4D1F47] underline-offset-4 hover:underline">
                Return to DanceFlow
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
