import Link from "next/link";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { signupAction } from "../actions";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function getSingleSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeIntent(value: string | undefined) {
  if (value === "studio" || value === "organizer" || value === "public") {
    return value;
  }

  return "public";
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};

  const signupIntent = normalizeIntent(
    getSingleSearchParam(resolvedSearchParams.intent)
  );
  const selectedPlan = getSingleSearchParam(resolvedSearchParams.plan) ?? "";
  const nextPath = getSingleSearchParam(resolvedSearchParams.next) ?? "";

  async function submitSignup(formData: FormData) {
    "use server";
    await signupAction(formData);
  }

  const isPaidPath = signupIntent === "studio" || signupIntent === "organizer";
  const eyebrow =
    signupIntent === "studio"
      ? "Create Studio Account"
      : signupIntent === "organizer"
        ? "Create Organizer Account"
        : "Create Free Account";

  const title =
    signupIntent === "studio"
      ? "Start your studio account with a magic link"
      : signupIntent === "organizer"
        ? "Start your organizer account with a magic link"
        : "Start with a magic link";

  const description =
    signupIntent === "studio"
      ? "Create your account first, then continue into studio trial setup and billing."
      : signupIntent === "organizer"
        ? "Create your account first, then continue into organizer trial setup and billing."
        : "For public discovery users, your free account should be fast and easy. Enter your info and we’ll email you a secure magic link. No password needed.";

  const primaryButton =
    signupIntent === "studio"
      ? "Email Me My Studio Magic Link"
      : signupIntent === "organizer"
        ? "Email Me My Organizer Magic Link"
        : "Email Me a Magic Link";

  return (
    <>
      <PublicSiteHeader isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="mx-auto max-w-6xl px-6 py-14 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
            <div className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                {eyebrow}
              </p>

              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                {title}
              </h1>

              <p className="mt-4 text-base leading-7 text-slate-600">
                {description}
              </p>

              {isPaidPath ? (
                <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                  <p className="text-sm font-medium text-slate-900">
                    Trial setup will continue after signup
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-600">
                    <li>• We’ll send you a secure magic link</li>
                    <li>• After login, you’ll return to trial setup automatically</li>
                    <li>• Billing is completed before entering the dashboard</li>
                  </ul>
                </div>
              ) : null}

              <form action={submitSignup} className="mt-8 space-y-5">
                <input
                  type="hidden"
                  name="signupMode"
                  value={isPaidPath ? "magic_link_paid_path" : "magic_link_public"}
                />
                <input type="hidden" name="signupIntent" value={signupIntent} />
                <input type="hidden" name="selectedPlan" value={selectedPlan} />
                <input type="hidden" name="nextPath" value={nextPath} />

                <div>
                  <label
                    htmlFor="fullName"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Full Name
                  </label>
                  <input
                    id="fullName"
                    name="fullName"
                    type="text"
                    required
                    autoComplete="name"
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-slate-500"
                  />
                </div>

                <div>
                  <label
                    htmlFor="email"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Email
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-slate-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  {primaryButton}
                </button>
              </form>

              {!isPaidPath ? (
                <div className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 p-4">
                  <p className="text-sm font-medium text-slate-900">
                    What happens next
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-600">
                    <li>• Your free discovery account is created automatically.</li>
                    <li>• You can save favorite studios and events.</li>
                    <li>• You can track events you register for.</li>
                  </ul>
                </div>
              ) : (
                <div className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 p-4">
                  <p className="text-sm font-medium text-slate-900">
                    What happens next
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-600">
                    <li>• You sign in through the magic link</li>
                    <li>• DanceFlow returns you to your trial-complete step</li>
                    <li>• You start your free trial with billing</li>
                  </ul>
                </div>
              )}

              <p className="mt-6 text-sm text-slate-600">
                Already have an account?{" "}
                <Link href="/login" className="font-medium text-slate-900 underline">
                  Log in
                </Link>
              </p>
            </div>

            <div className="space-y-6">
              <section
                className={`rounded-[32px] p-7 shadow-sm ${
                  isPaidPath
                    ? "border border-violet-200 bg-violet-50"
                    : "border border-slate-200 bg-white"
                }`}
              >
                <p
                  className={`text-sm font-semibold uppercase tracking-[0.16em] ${
                    isPaidPath ? "text-violet-700" : "text-slate-500"
                  }`}
                >
                  {isPaidPath ? "Paid Path Onboarding" : "Free Discovery Path"}
                </p>

                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
                  {signupIntent === "studio"
                    ? "Studios continue into pricing-backed trial setup"
                    : signupIntent === "organizer"
                      ? "Organizers continue into pricing-backed trial setup"
                      : "Public users stay on the free discovery path"}
                </h2>

                <p className="mt-3 text-sm leading-7 text-slate-600">
                  {signupIntent === "studio"
                    ? "This signup keeps your studio onboarding flow intact so you return to trial setup instead of getting dumped into the wrong part of the app."
                    : signupIntent === "organizer"
                      ? "This signup keeps your organizer onboarding flow intact so you return to trial setup before entering the organizer side."
                      : "Public users can move quickly into discovery, favorites, and event tracking without needing a paid-path setup flow."}
                </p>

                <div className="mt-5 rounded-2xl border border-white/60 bg-white p-4">
                  <p className="text-sm font-medium text-slate-900">
                    Current path details
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-600">
                    <li>• Intent: {signupIntent}</li>
                    <li>• Plan: {selectedPlan || "none selected"}</li>
                    <li>
                      • Return step: {nextPath || "default account destination"}
                    </li>
                  </ul>
                </div>
              </section>

              <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Why this is better
                </p>
                <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
                  <li>• Keeps the studio and organizer onboarding flow intact</li>
                  <li>• Preserves the selected plan and return step</li>
                  <li>• Still gives public users a fast magic-link signup</li>
                </ul>
              </section>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
