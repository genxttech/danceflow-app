import Link from "next/link";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { loginAction } from "../actions";

export default function LoginPage() {
  async function submitLogin(formData: FormData) {
    "use server";
    await loginAction(formData);
  }

  return (
    <>
      <PublicSiteHeader isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="mx-auto max-w-6xl px-6 py-14 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
            <div className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Log In
              </p>

              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                Continue with a magic link
              </h1>

              <p className="mt-4 text-base leading-7 text-slate-600">
                Public users can log in without a password. Enter your email and
                we’ll send you a secure sign-in link.
              </p>

              <form action={submitLogin} className="mt-8 space-y-5">
                <input type="hidden" name="loginMode" value="magic_link" />

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
                  Email Me a Magic Link
                </button>
              </form>

              <div className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Best for public and free accounts
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• No password to remember</li>
                  <li>• Faster login for dancers exploring the platform</li>
                  <li>• Easy access to favorites and event registrations</li>
                </ul>
              </div>

              <p className="mt-6 text-sm text-slate-600">
                Need an account?{" "}
                <Link href="/signup" className="font-medium text-slate-900 underline">
                  Create one
                </Link>
              </p>
            </div>

            <div className="space-y-6">
              <section className="rounded-[32px] border border-violet-200 bg-violet-50 p-7 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                  Studio and Organizer Users
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
                  Business login stays separate
                </h2>
                <p className="mt-3 text-sm leading-7 text-slate-600">
                  Studios and organizers may still use their existing business-side
                  authentication flow while the public side moves to magic links.
                </p>

                <div className="mt-5 rounded-2xl border border-violet-200 bg-white p-4">
                  <p className="text-sm font-medium text-slate-900">Recommended path</p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-600">
                    <li>• Public users: magic link</li>
                    <li>• Studio users: stronger business auth</li>
                    <li>• Organizer users: stronger business auth</li>
                  </ul>
                </div>
              </section>

              <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  What your free account can do
                </p>
                <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
                  <li>• Browse public studio profiles</li>
                  <li>• Search public events</li>
                  <li>• Save favorites for quick access</li>
                  <li>• Track events you registered for</li>
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
