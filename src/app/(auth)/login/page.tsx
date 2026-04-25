import Link from "next/link";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import { loginAction, requestPasswordResetAction } from "../actions";

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
    value === "verify-email" ||
    value === "reset-sent"
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

  async function submitLogin(formData: FormData) {
    "use server";
    await loginAction(formData);
  }

  async function submitReset(formData: FormData) {
    "use server";
    await requestPasswordResetAction(formData);
  }

  const isBusiness = loginIntent === "studio" || loginIntent === "organizer";
  const effectiveNext = nextPath || (isBusiness ? "/app" : "/account");

  const eyebrow = isBusiness
    ? loginIntent === "studio"
      ? "Studio Login"
      : "Organizer Login"
    : "Public Login";

  const title = isBusiness
    ? loginIntent === "studio"
      ? "Sign in to your studio account"
      : "Sign in to your organizer account"
    : "Log in to DanceFlow";

  const description = isBusiness
    ? loginIntent === "studio"
      ? "Use your studio email and password to access your DanceFlow workspace."
      : "Use your organizer email and password to access your DanceFlow workspace."
    : "Use your email to receive a secure sign-in link for your free public account.";

  return (
    <>
      <PublicSiteHeader isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="mx-auto max-w-4xl px-6 py-14 lg:px-8">
          <div className="mb-8 rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              {eyebrow}
            </p>

            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
              {title}
            </h1>

                        <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
              {description}
            </p>

            <div className="mt-6 grid gap-3 md:grid-cols-3">
              <Link
                href="/login?intent=studio"
                className={[
                  "rounded-2xl border p-4 text-left transition",
                  loginIntent === "studio"
                    ? "border-violet-300 bg-violet-50"
                    : "border-slate-200 bg-slate-50 hover:bg-slate-100",
                ].join(" ")}
              >
                <p className="text-sm font-semibold text-slate-950">Studio Login</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Owners, studio admins, front desk, and instructors
                </p>
              </Link>

              <Link
                href="/login?intent=organizer"
                className={[
                  "rounded-2xl border p-4 text-left transition",
                  loginIntent === "organizer"
                    ? "border-violet-300 bg-violet-50"
                    : "border-slate-200 bg-slate-50 hover:bg-slate-100",
                ].join(" ")}
              >
                <p className="text-sm font-semibold text-slate-950">Organizer Login</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Organizers and event admin staff
                </p>
              </Link>

              <Link
                href="/login?intent=public"
                className={[
                  "rounded-2xl border p-4 text-left transition",
                  loginIntent === "public"
                    ? "border-violet-300 bg-violet-50"
                    : "border-slate-200 bg-slate-50 hover:bg-slate-100",
                ].join(" ")}
              >
                <p className="text-sm font-semibold text-slate-950">Public Login</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Dancers, clients, and general account access
                </p>
              </Link>
            </div>

            {mode === "check-email" ? (
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
            ) : null}

            {mode === "verify-email" ? (
              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Verify your email first
                </p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Your account was created for{" "}
                  <span className="font-medium text-slate-900">
                    {emailHint || "your email address"}
                  </span>
                  . Open the verification email first, then sign in here.
                </p>
              </div>
            ) : null}

            {mode === "resume-signup" ? (
              <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Account already exists
                </p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Sign in with the email and password you already created to continue.
                </p>
              </div>
            ) : null}

            {mode === "reset-sent" ? (
              <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Password reset email sent
                </p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Check your inbox for a password reset email for{" "}
                  <span className="font-medium text-slate-900">
                    {emailHint || "your email address"}
                  </span>
                  .
                </p>
              </div>
            ) : null}
          </div>

          {!isBusiness ? (
            <section className="rounded-[32px] border border-orange-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Magic Link Login
              </p>

              <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                Email me a sign-in link
              </h2>

              <p className="mt-4 text-base leading-7 text-slate-600">
                For free public accounts, we keep login simple. Enter your email and we’ll send you a secure sign-in link.
              </p>

              <form action={submitLogin} className="mt-8 space-y-5">
                <input type="hidden" name="loginMode" value="magic_link" />
                <input type="hidden" name="loginIntent" value="public" />
                <input type="hidden" name="next" value={effectiveNext} />

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
                  Email me a sign-in link
                </button>
              </form>

              <div className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Public account access
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• Favorites and saved discovery</li>
                  <li>• Event registrations and portal access</li>
                  <li>• No password required</li>
                </ul>
              </div>
            </section>
          ) : (
            <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
              <section className="rounded-[32px] border border-violet-200 bg-white p-8 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
                  Password Login
                </p>

                <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                  {loginIntent === "studio"
                    ? "Studio workspace login"
                    : "Organizer workspace login"}
                </h2>

                <p className="mt-4 text-base leading-7 text-slate-600">
                  Business accounts use password login so account ownership, billing, and workspace access stay clear and consistent.
                </p>

                <form action={submitLogin} className="mt-8 space-y-5">
                  <input type="hidden" name="loginMode" value="password" />
                  <input type="hidden" name="loginIntent" value={loginIntent} />
                  <input type="hidden" name="next" value={effectiveNext} />

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
                        loginIntent === "studio"
                          ? "studio@example.com"
                          : "organizer@example.com"
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
                    Sign in with password
                  </button>
                </form>
              </section>

              <section className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Need help?
                </p>

                <h2 className="mt-3 text-2xl font-semibold text-slate-950">
                  Forgot your password?
                </h2>

                <p className="mt-4 text-base leading-7 text-slate-600">
                  Enter your business account email and we’ll send you a password reset email.
                </p>

                <form action={submitReset} className="mt-8 space-y-5">
                  <input type="hidden" name="loginIntent" value={loginIntent} />
                  <input type="hidden" name="next" value={effectiveNext} />

                  <div>
                    <label
                      htmlFor="reset-email"
                      className="mb-1.5 block text-sm font-medium text-slate-800"
                    >
                      Email
                    </label>
                    <input
                      id="reset-email"
                      name="email"
                      type="email"
                      required
                      autoComplete="email"
                      defaultValue={emailHint}
                      placeholder={
                        loginIntent === "studio"
                          ? "studio@example.com"
                          : "organizer@example.com"
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-slate-500"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Send reset email
                  </button>
                </form>

                <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-900">
                    Business account access
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-600">
                    <li>• Password-based login only</li>
                    <li>• Cleaner owner and billing flow</li>
                    <li>• Better recovery than magic links for paid users</li>
                  </ul>
                </div>
              </section>
            </div>
          )}

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
