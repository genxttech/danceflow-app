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

function normalizeMode(value: string | undefined) {
  if (
    value === "resume-signup" ||
    value === "check-email" ||
    value === "existing-account" ||
    value === "verify-email"
  ) {
    return value;
  }

  return "default";
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
  const emailHint = getSingleSearchParam(resolvedSearchParams.email) ?? "";
  const mode = normalizeMode(getSingleSearchParam(resolvedSearchParams.mode));
  const legacyCheckEmail = getSingleSearchParam(resolvedSearchParams["check-email"]);
  const legacySignupState = getSingleSearchParam(resolvedSearchParams.signup);

  async function submitLogin(formData: FormData) {
    "use server";
    await loginAction(formData);
  }

  const isPaidPath = loginIntent === "studio" || loginIntent === "organizer";
  const effectiveMode =
    mode !== "default"
      ? mode
      : legacyCheckEmail === "1" || legacySignupState === "check-email"
        ? "check-email"
        : "default";

  const pageEyebrow =
    loginIntent === "studio"
      ? "Studio Login"
      : loginIntent === "organizer"
        ? "Organizer Login"
        : "Log In";

  const pageTitle =
    effectiveMode === "resume-signup"
      ? loginIntent === "studio"
        ? "Your studio account already exists"
        : loginIntent === "organizer"
          ? "Your organizer account already exists"
          : "Your account already exists"
      : effectiveMode === "verify-email"
        ? "Verify your email to continue"
        : loginIntent === "studio"
          ? "Continue your studio trial setup"
          : loginIntent === "organizer"
            ? "Continue your organizer trial setup"
            : "Log in to DanceFlow";

  const pageDescription =
    effectiveMode === "resume-signup"
      ? loginIntent === "studio"
        ? "That email already has a studio account. Sign in below to continue your studio setup instead of creating a second account."
        : loginIntent === "organizer"
          ? "That email already has an organizer account. Sign in below to continue your organizer setup instead of creating a second account."
          : "That email already has an account. Sign in below to continue."
      : effectiveMode === "verify-email"
        ? "Your account was created, but email verification still needs to be completed before password login can continue."
        : loginIntent === "studio"
          ? "Use your password or a magic link to continue studio onboarding and billing."
          : loginIntent === "organizer"
            ? "Use your password or a magic link to continue organizer onboarding and billing."
            : "Sign in to your free account, studio portal, or organizer workspace.";

  const magicLinkTitle =
    loginIntent === "studio"
      ? "Email me my studio sign-in link"
      : loginIntent === "organizer"
        ? "Email me my organizer sign-in link"
        : "Email me a sign-in link";

  const magicLinkDescription =
    effectiveMode === "resume-signup"
      ? "Best if you started account creation already and just need a fast, reliable way back into setup."
      : loginIntent === "studio"
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
    effectiveMode === "resume-signup"
      ? "Use the password you created earlier. If you do not want to use a password, the magic link option on the left is a reliable recovery path."
      : effectiveMode === "verify-email"
        ? "If password login does not work yet, verify your email first or use a magic link after confirmation."
        : loginIntent === "studio"
          ? "Best for studio users who already use a password-based login flow."
          : loginIntent === "organizer"
            ? "Best for organizer users who already use a password-based login flow."
            : "Use your email and password if you already have a password-based account.";

  const defaultPaidNext = nextPath || "/get-started/complete";
  const magicLinkDefaultNext = nextPath || (isPaidPath ? defaultPaidNext : "/account");
  const passwordDefaultNext = nextPath || (isPaidPath ? defaultPaidNext : "/account");

  const resumeBox =
    effectiveMode === "resume-signup" ? (
      <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4">
        <p className="text-sm font-medium text-slate-900">Account already created</p>
        <p className="mt-2 text-sm leading-7 text-slate-600">
          We found an existing account for{" "}
          <span className="font-medium text-slate-900">
            {emailHint || "this email address"}
          </span>
          . Sign in below to continue setup instead of trying to register again.
        </p>
      </div>
    ) : null;

  const verifyEmailBox =
    effectiveMode === "verify-email" ? (
      <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-medium text-slate-900">
          Check your inbox before password login
        </p>
        <p className="mt-2 text-sm leading-7 text-slate-600">
          Your account was created for{" "}
          <span className="font-medium text-slate-900">
            {emailHint || "your email address"}
          </span>
          . Open the verification email first. After that, return here and sign in to continue setup.
        </p>
      </div>
    ) : null;

  const checkEmailBox =
    effectiveMode === "check-email" ? (
      <div className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 p-4">
        <p className="text-sm font-medium text-slate-900">Check your email</p>
        <p className="mt-2 text-sm leading-7 text-slate-600">
          We sent a sign-in link to{" "}
          <span className="font-medium text-slate-900">
            {emailHint || "your email address"}
          </span>
          . Open it on this device to continue.
        </p>
      </div>
    ) : null;

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

            {resumeBox}
            {verifyEmailBox}
            {checkEmailBox}

            {isPaidPath ? (
              <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Setup continuation is preserved
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• Intent: {loginIntent}</li>
                  <li>• Plan: {selectedPlan || "not specified"}</li>
                  <li>• Return path: {defaultPaidNext}</li>
                </ul>
              </div>
            ) : null}
          </div>

          <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
            <section className="rounded-[32px] border border-orange-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Email Link Login
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
                  Best recovery path if setup was interrupted
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• No password reset friction</li>
                  <li>• Works well for trial continuation</li>
                  <li>• Returns you to the right next step</li>
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
                        : "business@example.com"
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
                  Best for returning business users
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• Works for established studio and organizer accounts</li>
                  <li>• Preserves the selected next step</li>
                  <li>• Gives a stable return path into setup</li>
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
