import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  LifeBuoy,
  Mail,
  MessageSquareWarning,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { sendSupportRequestAction } from "./actions";

type SearchParams = Promise<{
  sent?: string;
  error?: string;
}>;

const issueTypes = [
  {
    value: "Technical issue",
    label: "Technical issue",
    description: "Broken page, error, missing button, or something not working.",
    icon: Wrench,
  },
  {
    value: "Billing issue",
    label: "Billing issue",
    description: "Subscription, payout, payment, or billing question.",
    icon: CreditCard,
  },
  {
    value: "Account access",
    label: "Account access",
    description: "Login, workspace access, invite, or role issue.",
    icon: ShieldAlert,
  },
  {
    value: "General help",
    label: "General help",
    description: "Question about how to complete a task.",
    icon: MessageSquareWarning,
  },
];

export default async function SupportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const sent = params.sent === "1";
  const error = params.error ?? "";

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Support
              </p>

              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Contact support
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Send a support request when something is broken, confusing, or
                blocking your work. Include as much detail as you can so the
                issue can be reviewed quickly.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/help"
                className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                <ArrowLeft className="h-4 w-4" />
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
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                Send one clear request
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Describe what you were trying to do, what happened, and which
                workspace or page was involved.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">
                Include your best contact email
              </h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Support replies will go to the email you enter on the form.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">
                Urgent access issue?
              </h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Choose Account access and include the email address you use to
                sign in.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <LifeBuoy className="h-5 w-5" />
            </div>

            <div>
              <h2 className="text-2xl font-semibold text-slate-950">
                What can support help with?
              </h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Use the form for problems that need direct review.
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            {issueTypes.map(({ label, description, icon: Icon }) => (
              <div
                key={label}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl bg-white p-3 text-[var(--brand-primary)] shadow-sm">
                    <Icon className="h-5 w-5" />
                  </div>

                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">
                      {label}
                    </h3>
                    <p className="mt-2 text-sm leading-7 text-slate-600">
                      {description}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Mail className="h-5 w-5" />
            </div>

            <div>
              <h2 className="text-2xl font-semibold text-slate-950">
                Support request form
              </h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                This message will be sent to DanceFlow support.
              </p>
            </div>
          </div>

          {sent ? (
            <div className="mt-6 rounded-2xl border border-green-200 bg-green-50 p-5 text-green-900">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5" />
                <div>
                  <h3 className="font-semibold">Support request sent</h3>
                  <p className="mt-1 text-sm leading-6">
                    Thanks — your message was sent. We’ll follow up as soon as
                    possible.
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-5 text-red-900">
              <h3 className="font-semibold">Support request was not sent</h3>
              <p className="mt-1 text-sm leading-6">
                {error === "missing-fields"
                  ? "Please fill out your name, email, issue type, and message."
                  : "Something went wrong while sending your request. Please try again."}
              </p>
            </div>
          ) : null}

          <form action={sendSupportRequestAction} className="mt-6 space-y-5">
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label
                  htmlFor="name"
                  className="mb-1 block text-sm font-medium text-slate-800"
                >
                  Your name *
                </label>
                <input
                  id="name"
                  name="name"
                  required
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                  placeholder="Jane Smith"
                />
              </div>

              <div>
                <label
                  htmlFor="email"
                  className="mb-1 block text-sm font-medium text-slate-800"
                >
                  Your email *
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="workspaceName"
                className="mb-1 block text-sm font-medium text-slate-800"
              >
                Studio, organizer, or workspace name
              </label>
              <input
                id="workspaceName"
                name="workspaceName"
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                placeholder="ConfiDance Studio"
              />
            </div>

            <div>
              <label
                htmlFor="issueType"
                className="mb-1 block text-sm font-medium text-slate-800"
              >
                Issue type *
              </label>
              <select
                id="issueType"
                name="issueType"
                required
                defaultValue=""
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
              >
                <option value="" disabled>
                  Select an issue type
                </option>
                {issueTypes.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="message"
                className="mb-1 block text-sm font-medium text-slate-800"
              >
                Message *
              </label>
              <textarea
                id="message"
                name="message"
                required
                rows={8}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                placeholder="Tell us what happened, what page you were on, and what you expected to happen."
              />
            </div>

            <button
              type="submit"
              className="inline-flex rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-medium text-white hover:opacity-95"
            >
              Send Support Request
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
