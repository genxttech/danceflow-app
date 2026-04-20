import Link from "next/link";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { signupAction } from "../actions";

export default function SignupPage() {
  async function submitSignup(formData: FormData) {
    "use server";
    await signupAction(formData);
  }

  return (
    <>
      <PublicSiteHeader isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="mx-auto max-w-6xl px-6 py-14 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
            <div className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Create Free Account
              </p>

              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                Start with a magic link
              </h1>

              <p className="mt-4 text-base leading-7 text-slate-600">
                For public discovery users, your free account should be fast and easy.
                Enter your info and we’ll email you a secure magic link. No password needed.
              </p>

              <form action={submitSignup} className="mt-8 space-y-5">
                <input type="hidden" name="signupMode" value="magic_link_public" />
                <input type="hidden" name="signupIntent" value="public" />

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
                  Email Me a Magic Link
                </button>
              </form>

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

              <p className="mt-6 text-sm text-slate-600">
                Already have an account?{" "}
                <Link href="/login" className="font-medium text-slate-900 underline">
                  Log in
                </Link>
              </p>
            </div>

            <div className="space-y-6">
              <section className="rounded-[32px] border border-violet-200 bg-violet-50 p-7 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                  Studio and Organizer Users
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
                  Business paths continue after account creation
                </h2>
                <p className="mt-3 text-sm leading-7 text-slate-600">
                  Studios and organizers can still start with a free account, then
                  continue into the pricing and trial path built for their business.
                </p>

                <div className="mt-5 rounded-2xl border border-violet-200 bg-white p-4">
                  <p className="text-sm font-medium text-slate-900">Recommended flow</p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-600">
                    <li>• Public users: magic link into free discovery account</li>
                    <li>• Studio users: continue into studio pricing after login</li>
                    <li>• Organizer users: continue into organizer pricing after login</li>
                  </ul>
                </div>
              </section>

              <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Why this is better
                </p>
                <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
                  <li>• Less friction for dancers and public users</li>
                  <li>• No password to remember</li>
                  <li>• Faster path into favorites, discovery, and registration</li>
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
