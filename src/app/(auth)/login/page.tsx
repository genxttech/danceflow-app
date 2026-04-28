import Link from "next/link";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import { loginAction, requestPasswordResetAction } from "../actions";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type LoginIntent = "studio" | "organizer" | "public";

function getSingleSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeIntent(value: string | undefined): LoginIntent {
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

function buildLoginHref(params: {
  intent: LoginIntent;
  nextPath: string;
  selectedPlan: string;
  emailHint: string;
}) {
  const { intent, nextPath, selectedPlan, emailHint } = params;
  const search = new URLSearchParams({ intent });

  if (nextPath) search.set("next", nextPath);
  if (selectedPlan) search.set("plan", selectedPlan);
  if (emailHint) search.set("email", emailHint);

  return `/login?${search.toString()}`;
}

function LoginChoiceCard({
  href,
  selected,
  eyebrow,
  title,
  description,
  cta,
}: {
  href: string;
  selected: boolean;
  eyebrow: string;
  title: string;
  description: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      aria-current={selected ? "page" : undefined}
      className={[
        "group relative flex min-h-[168px] flex-col justify-between rounded-2xl border p-5 text-left shadow-sm transition",
        "focus:outline-none focus:ring-4 focus:ring-violet-100",
        selected
          ? "border-violet-400 bg-violet-50 shadow-md"
          : "border-slate-200 bg-white hover:-translate-y-0.5 hover:border-violet-300 hover:bg-violet-50/50 hover:shadow-md",
      ].join(" ")}
    >
      <span className="flex items-start justify-between gap-3">
        <span>
          <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
            {eyebrow}
          </span>
          <span className="mt-2 block text-base font-semibold text-slate-950">
            {title}
          </span>
        </span>

        {selected ? (
          <span className="rounded-full bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white">
            Selected
          </span>
        ) : (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600 transition group-hover:border-violet-200 group-hover:bg-white group-hover:text-violet-700">
            Choose
          </span>
        )}
      </span>

      <span className="mt-3 block text-sm leading-6 text-slate-600">
        {description}
      </span>

      <span
        className={[
          "mt-4 inline-flex items-center text-sm font-semibold",
          selected ? "text-violet-700" : "text-slate-900 group-hover:text-violet-700",
        ].join(" ")}
      >
        {cta}
        <span className="ml-1 transition group-hover:translate-x-0.5">→</span>
      </span>
    </Link>
  );
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
      ? "Sign in to your studio workspace"
      : "Sign in to your organizer workspace"
    : "Log in to DanceFlow";

  const description = isBusiness
    ? loginIntent === "studio"
      ? "Use your studio email and password to access your DanceFlow workspace."
      : "Use your organizer email and password to access your DanceFlow workspace."
    : "Use your email to receive a secure sign-in link for your public account or client portal.";

  const selectedLabel =
    loginIntent === "studio"
      ? "Studio Workspace"
      : loginIntent === "organizer"
        ? "Organizer Workspace"
        : "Public Account / Client Portal";

  return (
    <>
      <PublicSiteHeader isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="mx-auto max-w-5xl px-6 py-14 lg:px-8">
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

            <div className="mt-8 rounded-3xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Step 1
                  </p>
                  <h2 className="mt-1 text-xl font-semibold text-slate-950">
                    Choose how you want to sign in
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    Select one option below to open the correct login form.
                  </p>
                </div>

                <div className="rounded-full border border-violet-200 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700">
                  Selected: {selectedLabel}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <LoginChoiceCard
                  href={buildLoginHref({
                    intent: "studio",
                    nextPath,
                    selectedPlan,
                    emailHint,
                  })}
                  selected={loginIntent === "studio"}
                  eyebrow="Workspace"
                  title="Studio Workspace"
                  description="Owners, studio admins, front desk, and instructors."
                  cta="Use Studio Login"
                />

                <LoginChoiceCard
                  href={buildLoginHref({
                    intent: "organizer",
                    nextPath,
                    selectedPlan,
                    emailHint,
                  })}
                  selected={loginIntent === "organizer"}
                  eyebrow="Events"
                  title="Organizer Workspace"
                  description="Organizers and event admin staff managing registrations."
                  cta="Use Organizer Login"
                />

                <LoginChoiceCard
                  href={buildLoginHref({
                    intent: "public",
                    nextPath,
                    selectedPlan,
                    emailHint,
                  })}
                  selected={loginIntent === "public"}
                  eyebrow="Public"
                  title="Public Account / Client Portal"
                  description="Dancers, students, clients, favorites, events, and portal access."
                  cta="Use Public Login"
                />
              </div>
            </div>

            {mode === "check-email" ? (
              <div className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Check your email
                </p>
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
                  Sign in with the email and password you already created to
                  continue.
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
                Step 2 · Magic Link Login
              </p>

              <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                Email me a sign-in link
              </h2>

              <p className="mt-4 text-base leading-7 text-slate-600">
                Enter the email connected to your public account or client
                portal. The email link should take you directly to the right
                account area.
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
                  Public account and client portal access
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• Favorites and saved discovery</li>
                  <li>• Event registrations and client portal access</li>
                  <li>• No password required</li>
                </ul>
              </div>
            </section>
          ) : (
            <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
              <section className="rounded-[32px] border border-violet-200 bg-white p-8 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
                  Step 2 · Password Login
                </p>

                <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                  {loginIntent === "studio"
                    ? "Studio workspace login"
                    : "Organizer workspace login"}
                </h2>

                <p className="mt-4 text-base leading-7 text-slate-600">
                  Business accounts use password login so account ownership,
                  billing, and workspace access stay clear and consistent.
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
                  Enter your business account email and we’ll send you a password
                  reset email.
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
                        selectedPlan
                          ? `&plan=${encodeURIComponent(selectedPlan)}`
                          : ""
                      }${
                        nextPath ? `&next=${encodeURIComponent(nextPath)}` : ""
                      }`
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
