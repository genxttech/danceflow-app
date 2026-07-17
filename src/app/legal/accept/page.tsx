import Link from "next/link";
import { redirect } from "next/navigation";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import { createClient } from "@/lib/supabase/server";
import { acceptCurrentBusinessAgreementsAction } from "./actions";

type SearchParams = Promise<{
  intent?: string;
  plan?: string;
}>;

export default async function LegalAcceptancePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const intent = params.intent === "organizer" ? "organizer" : "studio";
  const plan = params.plan ?? "";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = `/legal/accept?intent=${encodeURIComponent(intent)}${
      plan ? `&plan=${encodeURIComponent(plan)}` : ""
    }`;

    redirect(
      `/login?intent=${encodeURIComponent(intent)}&next=${encodeURIComponent(next)}`,
    );
  }

  return (
    <>
      <PublicSiteHeader isAuthenticated />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_22%,#f8fafc_100%)]">
        <section className="mx-auto max-w-3xl px-6 py-14">
          <div className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Legal agreement update
            </p>

            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
              Review and accept DanceFlow&apos;s current agreements
            </h1>

            <p className="mt-4 text-base leading-7 text-slate-600">
              Business workspace access requires acceptance of the current SaaS
              Terms and acknowledgment of the Privacy Policy and Data Processing
              Addendum.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <Link
                href="/terms"
                target="_blank"
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-100"
              >
                Review SaaS Terms
              </Link>
              <Link
                href="/privacy"
                target="_blank"
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-100"
              >
                Review Privacy Policy
              </Link>
              <Link
                href="/dpa"
                target="_blank"
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-100"
              >
                Review DPA
              </Link>
            </div>

            <form
              action={acceptCurrentBusinessAgreementsAction}
              className="mt-8 space-y-5"
            >
              <input type="hidden" name="intent" value={intent} />
              <input type="hidden" name="planCode" value={plan} />

              <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
                <label className="flex items-start gap-3 text-sm leading-6 text-slate-700">
                  <input
                    type="checkbox"
                    name="legalAccepted"
                    required
                    className="mt-1 h-4 w-4 rounded border-slate-300"
                  />
                  <span>
                    I agree to the DanceFlow SaaS Terms, acknowledge the
                    Privacy Policy, and agree that the Data Processing Addendum
                    applies when DanceFlow processes customer data for my
                    business workspace.
                  </span>
                </label>
              </div>

              <button
                type="submit"
                className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white hover:bg-violet-700"
              >
                Accept and Continue
              </button>
            </form>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
