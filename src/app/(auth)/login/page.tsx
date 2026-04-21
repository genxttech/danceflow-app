import Link from "next/link";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { loginAction } from "../actions";

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

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};

  const nextPath = getSingleSearchParam(resolvedSearchParams.next) ?? "";
  const loginIntent = normalizeIntent(
    getSingleSearchParam(resolvedSearchParams.intent)
  );
  const selectedPlan = getSingleSearchParam(resolvedSearchParams.plan) ?? "";
  const checkEmail = getSingleSearchParam(resolvedSearchParams["check-email"]);
  const signupState = getSingleSearchParam(resolvedSearchParams.signup);
  const emailHint = getSingleSearchParam(resolvedSearchParams.email) ?? "";

  async function submitLogin(formData: FormData) {
    "use server";
    await loginAction(formData);
  }

  const isPaidPath = loginIntent === "studio" || loginIntent === "organizer";

  const pageEyebrow =
    loginIntent === "studio"
      ? "Studio Login"
      : loginIntent === "organizer"
        ? "Organizer Login"
        : "Log In";

  const pageTitle =
    loginIntent === "studio"
      ? "Continue your studio trial setup"
      : loginIntent === "organizer"
        ? "Continue your organizer trial setup"
        : "Log in to DanceFlow";

  const pageDescription =
    loginIntent === "studio"
      ? "Use your magic link or password to continue studio onboarding and billing."
      : loginIntent === "organizer"
        ? "Use your magic link or password to continue organizer onboarding and billing."
        : "Sign in to your free account, studio portal, or organizer workspace.";

  const magicLinkTitle =
    loginIntent === "studio"
      ? "Email me my studio magic link"
      : loginIntent === "organizer"
        ? "Email me my organizer magic link"
        : "Email me a magic link";

  const magicLinkDescription =
    loginIntent === "studio"
      ? "Best if you started studio onboarding already and want to return to trial setup quickly."
      : loginIntent === "organizer"
        ? "Best if you started organizer onboarding already and want to return to trial setup quickly."
        : "Best for dancers and free discovery accounts. Enter your email and we’ll send you a secure sign-in link.";

  const passwordTitle =
    loginIntent === "studio"
      ? "Sign in to your studio account"
      : loginIntent === "organizer"
        ? "Sign in to your organizer account"
        : "Sign in with password";

  const passwordDescription =
    loginIntent === "studio"
      ? "Best for studio users who already use a password-based login flow."
      : loginIntent === "organizer"
        ? "Best for organizer users who already use a password-based login flow."
        : "Use your email and password if you already have a password-based account.";

  const magicLinkDefaultNext = nextPath || (isPaidPath ? "/get-started/complete" : "/account");
  const passwordDefaultNext = nextPath || (isPaidPath ? "/app" : "/account");

  return (
    <>
      <PublicSiteHeader isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="mx-auto max-w-6xl px-6 py-14 lg:px-8">
          <div className="mb-8 rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              {pageEyebrow}
            </p>

            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
              {pageTitle}
            </h1>

            <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
              {pageDescription}
            </p>

            {(checkEmail === "1" || signupState === "check-email") && (
              <div className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Check your email
                </p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  We sent a magic link to{" "}
                  <span className="font-medium text-slate-900">
                    {emailHint || "your email address"}
                  </span>
                  . Open it on this device to continue.
                </p>
              </div>
            )}

            {isPaidPath && (
              <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Trial handoff is preserved
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• Intent: {loginIntent}</li>
                  <li>• Plan: {selectedPlan || "not specified"}</li>
                  <li>• Return path: {nextPath || "/get-started/complete"}</li>
                </ul>
              </div>
            )}
          </div>

          <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
            <section className="rounded-[32px] border border-orange-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Magic Link Login
              </p>

              <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                {magicLinkTitle}
              </h2>

              <p className="mt-4 text-base leading-7 text-slate-600">
                {magicLinkDescription}
              </p>

              <form action={submitLogin} className="mt-8 space-y-5">
                <input type="hidden" name="loginMode" value="magic_link" />
                <input type="hidden" name="next" value={magicLinkDefaultNext} />

                <div>
                  <label
                    htmlFor="magic-email"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Email
                  </label>
                  <input
                    id="magic-email"
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    defaultValue={emailHint}
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-slate-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  {magicLinkTitle}
                </button>
              </form>

              <div className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Good for quick continuation
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• No password to remember</li>
                  <li>• Works well for pricing and trial continuation</li>
                  <li>• Keeps the handoff into the right next step</li>
                </ul>
              </div>
            </section>

            <section className="rounded-[32px] border border-violet-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
                Password Login
              </p>

              <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                {passwordTitle}
              </h2>

              <p className="mt-4 text-base leading-7 text-slate-600">
                {passwordDescription}
              </p>

              <form action={submitLogin} className="mt-8 space-y-5">
                <input type="hidden" name="loginMode" value="password" />
                <input type="hidden" name="next" value={passwordDefaultNext} />

                <div>
                  <label
                    htmlFor="password-email"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Email
                  </label>
                  <input
                    id="password-email"
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    defaultValue={emailHint}
                    placeholder={
                      loginIntent === "public"
                        ? "you@example.com"
                        : "studio@example.com"
                    }
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-slate-500"
                  />
                </div>

                <div>
                  <label
                    htmlFor="password"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-slate-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                >
                  {passwordTitle}
                </button>
              </form>

              <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Good for returning business users
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• Works for established studio or organizer accounts</li>
                  <li>• Preserves the selected next step when provided</li>
                  <li>• Falls back to the correct default destination</li>
                </ul>
              </div>
            </section>
          </div>

          <div className="mt-8 rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              Need an account first?
            </p>

            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                href={
                  loginIntent === "studio" || loginIntent === "organizer"
                    ? `/signup?intent=${encodeURIComponent(loginIntent)}${
                        selectedPlan ? `&plan=${encodeURIComponent(selectedPlan)}` : ""
                      }${nextPath ? `&next=${encodeURIComponent(nextPath)}` : ""}`
                    : "/signup"
                }
                className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
              >
                Create Account
              </Link>

              <Link
                href="/get-started"
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Back to Get Started
              </Link>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
