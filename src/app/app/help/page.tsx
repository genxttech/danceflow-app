import Link from "next/link";
import {
  BookOpen,
  Building2,
  CalendarDays,
  CreditCard,
  LifeBuoy,
  MessageSquareWarning,
  Search,
  ShieldAlert,
  Users,
  Wrench,
} from "lucide-react";

const knowledgebaseSections = [
  {
    title: "Getting Started",
    description: "Simple first-step guides for signing in, finding the right workspace, and learning where things live.",
    icon: BookOpen,
  },
  {
    title: "Studios",
    description: "Guides for schedule work, clients, packages, memberships, front desk tasks, and daily studio flow.",
    icon: Building2,
  },
  {
    title: "Organizers",
    description: "Guides for event setup, registrations, public event pages, and organizer billing.",
    icon: CalendarDays,
  },
  {
    title: "Staff Roles",
    description: "Help for studio owners, studio managers, front desk, instructors, and independent instructors.",
    icon: Users,
  },
  {
    title: "Billing & Payments",
    description: "Answers for subscriptions, payouts, sales, payment history, and billing questions.",
    icon: CreditCard,
  },
  {
    title: "Troubleshooting",
    description: "Step-by-step help for login problems, access issues, common errors, and support requests.",
    icon: Wrench,
  },
];

const supportTypes = [
  {
    title: "Technical issue",
    description: "Report broken pages, errors, missing buttons, or anything that is not working as expected.",
    icon: Wrench,
  },
  {
    title: "Billing issue",
    description: "Use this for subscription questions, payout concerns, or billing confusion.",
    icon: CreditCard,
  },
  {
    title: "Account access",
    description: "Tell us if you cannot sign in, cannot reach the right workspace, or think your access is wrong.",
    icon: ShieldAlert,
  },
  {
    title: "General help",
    description: "Ask a question when you are unsure how to complete a task or where to find something.",
    icon: MessageSquareWarning,
  },
];

export default function HelpCenterPage() {
  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Help Center
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Help, guides, and support in one place
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Use the Help Center to find simple how-to guides, browse future knowledgebase topics,
                or contact support when something is not working the way it should.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/knowledgebase"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Open Knowledgebase
              </Link>
              <Link
                href="/app/support"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Contact Support
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">Start with guides</h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                When you just need to learn how something works, the knowledgebase is the best place to start.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">Use support for problems</h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                If something is broken, confusing, or blocking your work, use the support form so the issue can be reviewed.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">Keep help easy to use</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                This area is meant to be simple, practical, and written in user language instead of technical language.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Search className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Knowledgebase preview</h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                These are the help areas planned for the full knowledgebase so users know what kind of guidance is coming.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {knowledgebaseSections.map(({ title, description, icon: Icon }) => (
              <div key={title} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl bg-white p-3 text-[var(--brand-primary)] shadow-sm">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
                    <p className="mt-2 text-sm leading-7 text-slate-600">{description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6">
            <Link
              href="/app/knowledgebase"
              className="inline-flex rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Go to Knowledgebase
            </Link>
          </div>
        </section>

        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <LifeBuoy className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Support options</h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Use support when you need direct help, need to report a problem, or are blocked from finishing a task.
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            {supportTypes.map(({ title, description, icon: Icon }) => (
              <div key={title} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl bg-white p-3 text-[var(--brand-primary)] shadow-sm">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
                    <p className="mt-2 text-sm leading-7 text-slate-600">{description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/app/support"
              className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
            >
              Open Support Form
            </Link>
            <Link
              href="/app"
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Back to Dashboard
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
