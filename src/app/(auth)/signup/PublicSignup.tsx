import Link from "next/link";

/**
 * W-2: dancer (public) account creation, rendered for `/signup?intent=public`.
 *
 * It posts to the existing `signupAction`, whose public branch already sends a passwordless
 * sign-in link (shouldCreateUser) with the validated attribution metadata and returns to
 * `/login?mode=check-email`. No new auth surface: this replaces the old bounce to `/login`.
 * Business trials stay a separate path (`/get-started/studio`).
 */
export default function PublicSignup({
  action,
  nextPath,
  emailHint,
}: {
  action: (formData: FormData) => Promise<void>;
  nextPath: string;
  emailHint: string;
}) {
  const loginSearch = new URLSearchParams({ intent: "public" });
  if (nextPath) loginSearch.set("next", nextPath);
  if (emailHint) loginSearch.set("email", emailHint);

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
      <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8 lg:py-14">
        <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Dancer Account
            </p>

            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Create your free DanceFlow account
            </h1>

            <p className="mt-4 text-base leading-7 text-slate-600">
              Save studios and events you like, keep your registrations in one place and get
              back to your student portal. We email you a secure sign-in link, so there is no
              password to set up.
            </p>

            <form action={action} className="mt-8 space-y-5">
              <input type="hidden" name="signupIntent" value="public" />
              <input type="hidden" name="nextPath" value={nextPath} />

              <div>
                <label
                  htmlFor="fullName"
                  className="mb-1.5 block text-sm font-medium text-slate-800"
                >
                  Your name
                </label>
                <input
                  id="fullName"
                  name="fullName"
                  type="text"
                  required
                  autoComplete="name"
                  placeholder="Alex Rivera"
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
                  defaultValue={emailHint}
                  placeholder="you@example.com"
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <button
                type="submit"
                className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white hover:bg-[var(--brand-primary-dark)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]"
              >
                Email me a secure link
              </button>
            </form>

            <p className="mt-4 text-xs leading-6 text-slate-500">
              If this email already has an account, the link signs you in instead of creating a
              duplicate. If your studio invited you to its portal, use the email it has on file.
            </p>
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="text-2xl font-semibold text-slate-950">Already have an account?</h2>
            <p className="mt-3 text-base leading-7 text-slate-600">
              Sign in with the same email and we will send you a link.
            </p>
            <Link
              href={`/login?${loginSearch.toString()}`}
              className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
            >
              Log In
            </Link>

            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-900">Running a studio or events?</p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Business accounts start with a free trial instead.
              </p>
              <Link
                href="/get-started/studio"
                className="mt-3 inline-flex w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Start free trial
              </Link>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
