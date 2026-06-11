import Link from "next/link";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import { createClient } from "@/lib/supabase/server";
import { updatePasswordAction } from "../(auth)/actions";

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

  return "studio";
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const loginIntent = normalizeIntent(
    getSingleSearchParam(resolvedSearchParams.intent)
  );
  const nextPath = getSingleSearchParam(resolvedSearchParams.next) ?? "";
  const errorMessage = getSingleSearchParam(resolvedSearchParams.error) ?? "";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const loginHref = `/login?intent=${encodeURIComponent(loginIntent)}${
    nextPath ? `&next=${encodeURIComponent(nextPath)}` : ""
  }`;

  return (
    <>
      <PublicSiteHeader isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="mx-auto flex min-h-[70vh] max-w-3xl items-center px-6 py-12 lg:px-8">
          <div className="w-full rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Password Reset
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Create a new DanceFlow password
            </h1>

            {user ? (
              <>
                <p className="mt-4 text-sm leading-7 text-slate-600">
                  Enter a new password for {user.email ?? "your account"}. Your
                  password must be at least 8 characters.
                </p>

                {errorMessage ? (
                  <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">
                    {errorMessage}
                  </div>
                ) : null}

                <form action={updatePasswordAction} className="mt-8 space-y-5">
                  <input type="hidden" name="loginIntent" value={loginIntent} />
                  <input type="hidden" name="next" value={nextPath} />

                  <div>
                    <label
                      htmlFor="password"
                      className="mb-1.5 block text-sm font-medium text-slate-800"
                    >
                      New password
                    </label>
                    <input
                      id="password"
                      name="password"
                      type="password"
                      required
                      minLength={8}
                      autoComplete="new-password"
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-purple-400"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="confirmPassword"
                      className="mb-1.5 block text-sm font-medium text-slate-800"
                    >
                      Confirm new password
                    </label>
                    <input
                      id="confirmPassword"
                      name="confirmPassword"
                      type="password"
                      required
                      minLength={8}
                      autoComplete="new-password"
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-purple-400"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full rounded-xl bg-purple-700 px-4 py-3 text-sm font-semibold text-white hover:bg-purple-800"
                  >
                    Update Password
                  </button>
                </form>
              </>
            ) : (
              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5">
                <h2 className="text-lg font-semibold text-slate-950">
                  This reset link is expired or missing.
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-700">
                  Request a new password reset email, then open the latest link in
                  your inbox. Password reset links can only be used once.
                </p>
                <Link
                  href={loginHref}
                  className="mt-5 inline-flex rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Request New Reset Email
                </Link>
              </div>
            )}
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
