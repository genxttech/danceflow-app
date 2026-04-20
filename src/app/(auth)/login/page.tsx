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
          <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
            <section className="rounded-[32px] border border-orange-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Public Login
              </p>

              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                Continue with a magic link
              </h1>

              <p className="mt-4 text-base leading-7 text-slate-600">
                Best for dancers and free discovery accounts. Enter your email and
                we’ll send you a secure sign-in link.
              </p>

              <form action={submitLogin} className="mt-8 space-y-5">
                <input type="hidden" name="loginMode" value="magic_link" />
                <input type="hidden" name="next" value="/account" />

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
                  Best for public users
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• No password to remember</li>
                  <li>• Fast access to favorites and event registrations</li>
                  <li>• Automatically works for new free discovery users</li>
                </ul>
              </div>

              <p className="mt-6 text-sm text-slate-600">
                Need a free account?{" "}
                <Link href="/signup" className="font-medium text-slate-900 underline">
                  Create one
                </Link>
              </p>
            </section>

            <section className="rounded-[32px] border border-violet-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
                Studio / Organizer Login
              </p>

              <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                Sign in to manage your business
              </h2>

              <p className="mt-4 text-base leading-7 text-slate-600">
                Best for studios and organizers accessing CRM, scheduling, events,
                registrations, payments, and business tools.
              </p>

              <form action={submitLogin} className="mt-8 space-y-5">
                <input type="hidden" name="loginMode" value="password" />
                <input type="hidden" name="next" value="/app" />

                <div>
                  <label
                    htmlFor="business-email"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Email
                  </label>
                  <input
                    id="business-email"
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="studio@example.com"
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-slate-500"
                  />
                </div>

                <div>
                  <label
                    htmlFor="business-password"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Password
                  </label>
                  <input
                    id="business-password"
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
                  Sign In to Business Account
                </button>
              </form>

              <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Best for business users
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• Access studio CRM and scheduling</li>
                  <li>• Manage events, tickets, and registrations</li>
                  <li>• Continue into stronger business-side security later</li>
                </ul>
              </div>

              <p className="mt-6 text-sm text-slate-600">
                New studio or organizer?{" "}
                <Link href="/signup" className="font-medium text-slate-900 underline">
                  Start with a free account
                </Link>
              </p>
            </section>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
