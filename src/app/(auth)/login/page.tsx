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

  return "studio";
}

function normalizeMode(value: string | undefined) {
  if (
    value === "resume-signup" ||
    value === "check-email" ||
    value === "verify-email" ||
    value === "reset-sent" ||
    value === "password-updated"
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

function intentLabel(intent: LoginIntent) {
  if (intent === "organizer") return "Organizer";
  if (intent === "public") return "Student / Dancer";
  return "Studio";
}

function intentDescription(intent: LoginIntent) {
  if (intent === "organizer") {
    return "For event organizers managing event pages, tickets, registrations, private lesson slots, and check-in.";
  }

  if (intent === "public") {
    return "For dancers, students, and clients using public discovery, favorites, event registrations, or studio portal access.";
  }

  return "For studio owners, admins, front desk staff, and instructors managing the studio workspace.";
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

  const isPublic = loginIntent === "public";
  const effectiveNext = nextPath || (isPublic ? "/account" : "/app");
  const selectedLabel = intentLabel(loginIntent);

  return (
    <>
      <PublicSiteHeader isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="mx-auto max-w-6xl px-6 py-12 lg:px-8 lg:py-16">
          <div className="grid gap-8 lg:grid-cols-[0.92fr_1.08fr] lg:items-start">
            <div className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
              <div className="bg-[linear-gradient(135deg,#2e1065_0%,#6d28d9_48%,#f97316_100%)] p-8 text-white sm:p-10">
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-white/75">
                  DanceFlow Login
                </p>
                <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
                  One sign-in page. DanceFlow routes you where you belong.
                </h1>
                <p className="mt-5 text-base leading-7 text-white/85">
                  Studio teams, organizers, instructors, students, and dancers can
                  all start here. Choose the account type that best matches what
                  you are trying to access.
                </p>
              </div>

              <div className="grid gap-3 bg-slate-50 p-5 sm:grid-cols-3">
                <Link
                  href={buildLoginHref({
                    intent: "studio",
                    nextPath,
                    selectedPlan,
                    emailHint,
                  })}
                  className={`rounded-2xl border px-4 py-4 text-sm transition ${
                    loginIntent === "studio"
                      ? "border-purple-300 bg-purple-50 text-purple-900 shadow-sm"
                      : "border-slate-200 bg-white text-slate-700 hover:border-purple-200 hover:bg-purple-50"
                  }`}
                >
                  <span className="block font-semibold">Studio</span>
                  <span className="mt-1 block text-xs leading-5">
                    Owners, staff, front desk, instructors
                  </span>
                </Link>

                <Link
                  href={buildLoginHref({
                    intent: "organizer",
                    nextPath,
                    selectedPlan,
                    emailHint,
                  })}
                  className={`rounded-2xl border px-4 py-4 text-sm transition ${
                    loginIntent === "organizer"
                      ? "border-orange-300 bg-orange-50 text-orange-900 shadow-sm"
                      : "border-slate-200 bg-white text-slate-700 hover:border-orange-200 hover:bg-orange-50"
                  }`}
                >
                  <span className="block font-semibold">Organizer</span>
                  <span className="mt-1 block text-xs leading-5">
                    Event pages, ticketing, check-in
                  </span>
                </Link>

                <Link
                  href={buildLoginHref({
                    intent: "public",
                    nextPath,
                    selectedPlan,
                    emailHint,
                  })}
                  className={`rounded-2xl border px-4 py-4 text-sm transition ${
                    loginIntent === "public"
                      ? "border-pink-300 bg-pink-50 text-pink-900 shadow-sm"
                      : "border-slate-200 bg-white text-slate-700 hover:border-pink-200 hover:bg-pink-50"
                  }`}
                >
                  <span className="block font-semibold">Student / Dancer</span>
                  <span className="mt-1 block text-xs leading-5">
                    Portal, favorites, registrations
                  </span>
                </Link>
              </div>
            </div>

            <div className="space-y-5">
              {mode === "check-email" ? (
                <div className="rounded-[2rem] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
                    Check your email
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold text-slate-950">
                    We sent your sign-in link.
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-slate-700">
                    Open the email sent to {emailHint || "your email address"} to
                    continue. You can safely close this page after using that link.
                  </p>
                </div>
              ) : null}

              {mode === "reset-sent" ? (
                <div className="rounded-[2rem] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
                    Password reset sent
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold text-slate-950">
                    Check your inbox.
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-slate-700">
                    We sent reset instructions to {emailHint || "your email address"}.
                  </p>
                </div>
              ) : null}

              {mode === "password-updated" ? (
                <div className="rounded-[2rem] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
                    Password updated
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold text-slate-950">
                    You can sign in with your new password.
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-slate-700">
                    Use your email and new password to continue to DanceFlow.
                  </p>
                </div>
              ) : null}

              {mode === "resume-signup" ? (
                <div className="rounded-[2rem] border border-amber-200 bg-amber-50 p-6 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-700">
                    Account already exists
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold text-slate-950">
                    Sign in to continue setup.
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-slate-700">
                    Use the same email and password to continue your DanceFlow setup.
                  </p>
                </div>
              ) : null}

              <section className="rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                      {selectedLabel} Access
                    </p>
                    <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                      {isPublic ? "Email me a secure sign-in link" : "Sign in with email and password"}
                    </h2>
                    <p className="mt-3 text-sm leading-7 text-slate-600">
                      {intentDescription(loginIntent)}
                    </p>
                  </div>

                  <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">
                    Selected: {selectedLabel}
                  </span>
                </div>

                {isPublic ? (
                  <form action={submitLogin} className="mt-8 space-y-5">
                    <input type="hidden" name="loginMode" value="magic_link" />
                    <input type="hidden" name="loginIntent" value="public" />
                    <input type="hidden" name="next" value={effectiveNext} />

                    <div>
                      <label
                        htmlFor="public-email"
                        className="mb-1.5 block text-sm font-medium text-slate-800"
                      >
                        Email
                      </label>
                      <input
                        id="public-email"
                        name="email"
                        type="email"
                        required
                        autoComplete="email"
                        defaultValue={emailHint}
                        placeholder="you@example.com"
                        className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-orange-400"
                      />
                    </div>

                    <button
                      type="submit"
                      className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Email My Sign-In Link
                    </button>

                    <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm leading-6 text-slate-700">
                      Student/client portal access usually starts from a studio invite
                      or event confirmation email. Use the same email address your
                      studio has on file.
                    </div>
                  </form>
                ) : (
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
                        className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-purple-400"
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
                        className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-purple-400"
                      />
                    </div>

                    <button
                      type="submit"
                      className="w-full rounded-xl bg-purple-700 px-4 py-3 text-sm font-semibold text-white hover:bg-purple-800"
                    >
                      Sign In to {selectedLabel}
                    </button>
                  </form>
                )}
              </section>

              {!isPublic ? (
                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">
                        Forgot your password?
                      </p>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        Send a reset email for your studio or organizer account.
                      </p>
                    </div>

                    <form action={submitReset} className="flex w-full flex-col gap-3 sm:flex-row lg:w-auto">
                      <input type="hidden" name="loginIntent" value={loginIntent} />
                      <input type="hidden" name="next" value={effectiveNext} />
                      <input
                        name="email"
                        type="email"
                        required
                        defaultValue={emailHint}
                        placeholder="email@example.com"
                        className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-slate-500 lg:w-64"
                      />
                      <button
                        type="submit"
                        className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                      >
                        Send Reset
                      </button>
                    </form>
                  </div>
                </section>
              ) : null}

              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
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
                    View Plans
                  </Link>

                  <Link
                    href="/knowledgebase"
                    className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Help Center
                  </Link>
                </div>
              </section>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}

