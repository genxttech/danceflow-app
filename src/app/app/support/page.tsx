import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle, CreditCard, HelpCircle, LifeBuoy, ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { submitSupportRequestAction } from "./actions";

type SupportPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function audienceLabel(role: string | null | undefined) {
  if (role === "organizer_owner" || role === "organizer_admin") {
    return "Organizer Support";
  }

  if (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "front_desk" ||
    role === "instructor" ||
    role === "independent_instructor"
  ) {
    return "Studio Support";
  }

  return "DanceFlow Support";
}

function InfoCard({
  icon: Icon,
  title,
  description,
  tone = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  tone?: "default" | "warning" | "billing";
}) {
  const toneClasses =
    tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-950"
      : tone === "billing"
        ? "border-sky-200 bg-sky-50 text-sky-950"
        : "border-slate-200 bg-white text-slate-950";

  const iconClasses =
    tone === "warning"
      ? "bg-amber-100 text-amber-700"
      : tone === "billing"
        ? "bg-sky-100 text-sky-700"
        : "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]";

  return (
    <div className={`rounded-3xl border p-5 shadow-sm ${toneClasses}`}>
      <div className="flex items-start gap-3">
        <div className={`rounded-2xl p-3 ${iconClasses}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-2 text-sm leading-7 text-slate-600">{description}</p>
        </div>
      </div>
    </div>
  );
}

export default async function SupportPage({ searchParams }: SupportPageProps) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  const resolvedSearchParams = (await searchParams) ?? {};
  const successMessage =
    typeof resolvedSearchParams.success === "string"
      ? resolvedSearchParams.success
      : null;
  const errorMessage =
    typeof resolvedSearchParams.error === "string"
      ? resolvedSearchParams.error
      : null;

  const audience = audienceLabel(context?.studioRole);
  const email = user.email ?? "";

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Help
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Support
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Use this page to report technical problems, billing questions, account access issues,
                or anything else you need help with.
              </p>
              <div className="mt-4 flex flex-wrap gap-3 text-sm text-white/80">
                <span>
                  Support area: <span className="font-medium text-white">{audience}</span>
                </span>
                {context?.studioId ? (
                  <span>
                    Workspace connected: <span className="font-medium text-white">Yes</span>
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/help"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Help
              </Link>
              <Link
                href="/knowledgebase"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Open Knowledgebase
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <InfoCard
              icon={LifeBuoy}
              title="Use simple details"
              description="Tell us what happened, what page you were on, and what you expected to happen. Short, clear details help us troubleshoot faster."
            />
            <InfoCard
              icon={CreditCard}
              title="Billing questions are welcome"
              description="Use this form for billing, payouts, subscriptions, and payment questions if something looks wrong or you are unsure what to do next."
              tone="billing"
            />
            <InfoCard
              icon={ShieldAlert}
              title="Account access issues"
              description="If you cannot reach a page or think access is wrong for your role, tell us what page you tried to open and what message or redirect you saw."
              tone="warning"
            />
          </div>
        </div>
      </section>

      {successMessage ? (
        <section className="rounded-[32px] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Support request sent
          </p>
          <p className="mt-2 text-sm leading-7 text-slate-700">{successMessage}</p>
        </section>
      ) : null}

      {errorMessage ? (
        <section className="rounded-[32px] border border-rose-200 bg-rose-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-rose-700">
            We could not send your request
          </p>
          <p className="mt-2 text-sm leading-7 text-slate-700">{errorMessage}</p>
        </section>
      ) : null}

      <section className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <HelpCircle className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Send a support request</h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Choose the type of help you need and tell us what is going on. We will use your
                message to review the issue and follow up.
              </p>
            </div>
          </div>

          <form action={submitSupportRequestAction} className="mt-6 space-y-6">
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label
                  htmlFor="issueType"
                  className="block text-sm font-medium text-slate-700"
                >
                  What do you need help with?
                </label>
                <select
                  id="issueType"
                  name="issueType"
                  defaultValue="technical"
                  className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-violet-500"
                >
                  <option value="technical">Technical issue</option>
                  <option value="billing">Billing issue</option>
                  <option value="account_access">Account access</option>
                  <option value="feature_question">Feature question</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="supportEmail"
                  className="block text-sm font-medium text-slate-700"
                >
                  Your email
                </label>
                <input
                  id="supportEmail"
                  type="email"
                  value={email}
                  readOnly
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600 outline-none"
                />
                <p className="mt-2 text-xs leading-6 text-slate-500">
                  We will use this email to follow up with you.
                </p>
              </div>
            </div>

            <div>
              <label htmlFor="subject" className="block text-sm font-medium text-slate-700">
                Short subject
              </label>
              <input
                id="subject"
                name="subject"
                type="text"
                placeholder="Example: Billing page access is blocked"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-violet-500"
              />
            </div>

            <div>
              <label htmlFor="description" className="block text-sm font-medium text-slate-700">
                Describe the issue
              </label>
              <textarea
                id="description"
                name="description"
                rows={8}
                placeholder="Tell us what happened, what page you were on, what you clicked, and what you expected to happen."
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-violet-500"
              />
              <p className="mt-2 text-xs leading-6 text-slate-500">
                Helpful details include the page name, role, and whether you saw an error message
                or were redirected somewhere unexpected.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                className="rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-medium text-white hover:opacity-95"
              >
                Send Support Request
              </button>

              <Link
                href="/knowledgebase"
                className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Check the Knowledgebase
              </Link>
            </div>
          </form>
        </section>

        <section className="space-y-6">
          <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-slate-950">Before you send a request</h2>
                <div className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
                  <p>• Double-check that you are in the correct workspace.</p>
                  <p>• Note the page name and what role you were signed in as.</p>
                  <p>• Include the exact steps that caused the issue.</p>
                  <p>• Mention whether this is blocking daily work or can wait.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-950">Other help options</h2>
            <div className="mt-4 space-y-4">
              <Link
                href="/app/help"
                className="block rounded-2xl border border-slate-200 bg-slate-50 p-4 hover:bg-slate-100"
              >
                <p className="text-sm font-semibold text-slate-950">Return to Help Center</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  See support and help resources in one place.
                </p>
              </Link>

              <Link
                href="/knowledgebase"
                className="block rounded-2xl border border-slate-200 bg-slate-50 p-4 hover:bg-slate-100"
              >
                <p className="text-sm font-semibold text-slate-950">Open Knowledgebase</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Browse setup help, step-by-step guides, and common answers.
                </p>
              </Link>
            </div>
          </div>
        </section>
      </section>
    </div>
  );
}
