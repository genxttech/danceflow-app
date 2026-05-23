import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  token: string;
}>;

type SearchParams = Promise<{
  unsubscribed?: string;
  error?: string;
}>;

async function unsubscribeMarketingAction(formData: FormData) {
  "use server";

  const tokenValue = formData.get("token");
  const token = typeof tokenValue === "string" ? tokenValue.trim() : "";

  if (!token) {
    redirect("/unsubscribe/marketing/invalid?error=missing_token");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("unsubscribe_marketing_recipient", {
    p_token: token,
  });

  if (error) {
    console.error("unsubscribe marketing recipient failed", error);
    redirect(`/unsubscribe/marketing/${token}?error=unsubscribe_failed`);
  }

  const result = Array.isArray(data) ? data[0] : data;

  if (!result?.success) {
    redirect(`/unsubscribe/marketing/${token}?error=not_found`);
  }

  redirect(`/unsubscribe/marketing/${token}?unsubscribed=1`);
}

function errorMessage(code?: string) {
  switch (code) {
    case "missing_token":
      return "The unsubscribe link is missing a token.";
    case "not_found":
      return "This unsubscribe link could not be found or may already be expired.";
    case "unsubscribe_failed":
      return "We could not complete the unsubscribe request. Please try again.";
    default:
      return null;
  }
}

export default async function MarketingUnsubscribePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;
  const error = errorMessage(resolvedSearchParams.error);

  return (
    <main className="min-h-screen bg-[var(--brand-page-bg)] px-4 py-10 text-[var(--brand-text)] sm:px-6">
      <div className="mx-auto max-w-xl">
        <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-gradient-to-r from-[#241432] via-[#4D1F47] to-[#E85D2A] px-6 py-7 text-white">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/75">
              DanceFlow Marketing
            </p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight">
              Email Preferences
            </h1>
            <p className="mt-2 text-sm leading-6 text-white/85">
              You can unsubscribe from studio marketing emails sent through DanceFlow.
            </p>
          </div>

          <div className="p-6">
            {resolvedSearchParams.unsubscribed ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-800">
                <h2 className="text-lg font-bold">You are unsubscribed.</h2>
                <p className="mt-2 text-sm leading-6">
                  This email address has been removed from future marketing emails for this studio.
                </p>
              </div>
            ) : (
              <>
                {error ? (
                  <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">
                    {error}
                  </div>
                ) : null}

                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-5">
                  <h2 className="text-lg font-bold">Unsubscribe from marketing emails?</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
                    This only stops marketing campaigns from this studio. You may still receive transactional messages such as receipts, account notices, schedule updates, or event registration details.
                  </p>

                  <form action={unsubscribeMarketingAction} className="mt-5">
                    <input type="hidden" name="token" value={resolvedParams.token} />
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
              <Link
                href="/"
                className="text-sm font-semibold text-[#4D1F47] underline-offset-4 hover:underline"
              >
                Return to DanceFlow
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
