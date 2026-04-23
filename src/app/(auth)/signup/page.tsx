import Link from "next/link";
import { redirect } from "next/navigation";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import { signupAction } from "../actions";

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

function normalizeNextPath(value: string | undefined) {
  if (!value) return "";
  if (!value.startsWith("/")) return "";
  if (value.startsWith("//")) return "";
  return value;
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};

  const signupIntent = normalizeIntent(
    getSingleSearchParam(resolvedSearchParams.intent)
  );
  const selectedPlan = getSingleSearchParam(resolvedSearchParams.plan) ?? "";
  const nextPath = normalizeNextPath(
    getSingleSearchParam(resolvedSearchParams.next)
  );
  const emailHint = getSingleSearchParam(resolvedSearchParams.email) ?? "";

  if (signupIntent === "public") {
    redirect("/login");
  }

  const isStudio = signupIntent === "studio";
  const eyebrow = isStudio ? "Studio Signup" : "Organizer Signup";
  const title = isStudio
    ? "Create your studio account"
    : "Create your organizer account";
  const description = isStudio
    ? "Set up your password-based studio account so you can continue into billing and launch your studio workspace."
    : "Set up your password-based organizer account so you can continue into billing and launch your organizer workspace.";

  const planLabel = selectedPlan || (isStudio ? "studio trial" : "organizer trial");
  const effectiveNext =
    nextPath ||
    `/get-started/complete?intent=${encodeURIComponent(signupIntent)}${
      selectedPlan ? `&plan=${encodeURIComponent(selectedPlan)}` : ""
    }`;

  async function submitSignup(formData: FormData) {
    "use server";
    await signupAction(formData);
  }

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

            <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <p className="text-sm font-medium text-slate-900">You are starting</p>
              <ul className="mt-2 space-y-1 text-sm text-slate-600">
                <li>• Account type: {isStudio ? "Studio" : "Organizer"}</li>
                <li>• Plan: {planLabel}</li>
                <li>• Next step: billing and trial activation</li>
              </ul>
            </div>
          </div>

          <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
            <section className="rounded-[32px] border border-violet-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
                Account Setup
              </p>

              <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                Create your password login
              </h2>

              <p className="mt-4 text-base leading-7 text-slate-600">
                Business accounts use email and password so billing ownership,
                workspace access, and account recovery stay clear and consistent.
              </p>

              <form action={submitSignup} className="mt-8 space-y-5">
                <input type="hidden" name="signupIntent" value={signupIntent} />
                <input type="hidden" name="selectedPlan" value={selectedPlan} />
                <input type="hidden" name="nextPath" value={effectiveNext} />

                <div>
                  <label
                    htmlFor="fullName"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    {isStudio ? "Studio owner name" : "Organizer name"}
                  </label>
                  <input
                    id="fullName"
                    name="fullName"
                    type="text"
                    required
                    autoComplete="name"
                    placeholder={isStudio ? "Jane Smith" : "John Miller"}
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
                    placeholder={
                      isStudio ? "studio@example.com" : "organizer@example.com"
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
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-slate-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                >
                  {isStudio
                    ? "Continue to Studio Billing"
                    : "Continue to Organizer Billing"}
                </button>
              </form>

              <p className="mt-4 text-xs leading-6 text-slate-500">
                If this email already has an account, you will be sent to the correct
                login flow so you can continue setup instead of creating a duplicate.
              </p>
            </section>

            <section className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                Returning user?
              </p>

              <h2 className="mt-3 text-2xl font-semibold text-slate-950">
                Sign in instead
              </h2>

              <p className="mt-4 text-base leading-7 text-slate-600">
                Already started setup before? Use the business login that matches
                this account type.
              </p>

              <div className="mt-6 space-y-3">
                <Link
                  href={`/login?intent=${encodeURIComponent(signupIntent)}${
                    selectedPlan ? `&plan=${encodeURIComponent(selectedPlan)}` : ""
                  }${effectiveNext ? `&next=${encodeURIComponent(effectiveNext)}` : ""}${
                    emailHint ? `&email=${encodeURIComponent(emailHint)}` : ""
                  }`}
                  className="inline-flex w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  {isStudio ? "Studio Log In" : "Organizer Log In"}
                </Link>

                <Link
                  href={isStudio ? "/get-started/studio" : "/get-started/organizer"}
                  className="inline-flex w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Back to Pricing
                </Link>
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  Business account setup
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  <li>• Password-based login only</li>
                  <li>• Cleaner billing ownership</li>
                  <li>• Better workspace recovery and account control</li>
                </ul>
              </div>
            </section>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
