import Link from "next/link";
import {
  BookOpen,
  Building2,
  CalendarDays,
  CreditCard,
  LifeBuoy,
  Map,
  Users,
  Wrench,
} from "lucide-react";

export default function KnowledgebasePage() {
  const sections = [
    {
      title: "Getting Started",
      description: "Learn the basic flow for getting into the right workspace and finding the tools you need.",
      icon: BookOpen,
    },
    {
      title: "Studios",
      description: "Future guides for daily studio work like scheduling, clients, packages, memberships, and front desk tasks.",
      icon: Building2,
    },
    {
      title: "Organizers",
      description: "Future guides for event setup, registrations, public event pages, and organizer billing.",
      icon: CalendarDays,
    },
    {
      title: "Staff Roles",
      description: "Future help for studio owners, studio managers, front desk, instructors, and independent instructors.",
      icon: Users,
    },
    {
      title: "Billing & Payments",
      description: "Future help for subscriptions, payouts, payment history, and sales-related questions.",
      icon: CreditCard,
    },
    {
      title: "Troubleshooting",
      description: "Future step-by-step help for login issues, access problems, common errors, and support requests.",
      icon: Wrench,
    },
  ];

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Knowledgebase
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Help articles are coming soon
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                This knowledgebase will become the main place for step-by-step help, quick answers,
                and simple guides for studios, organizers, staff, and dancers using DanceFlow.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Dashboard
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
              <h2 className="text-lg font-semibold text-sky-950">Simple help, written clearly</h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Articles here will be written in plain language so staff can finish tasks without digging through technical instructions.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">Built around real tasks</h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                The goal is to help users do things like sell a package, fix access, update billing, or manage the schedule faster.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">More help is on the way</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Until the full knowledgebase is ready, use the Support page if you need help with a problem or question.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Map className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">Planned help sections</h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              This placeholder gives users a clear idea of the help areas that are planned for the full knowledgebase.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sections.map(({ title, description, icon: Icon }) => (
            <div
              key={title}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
            >
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
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <LifeBuoy className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">Need help right now?</h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              The full knowledgebase is still being built. If you need help now, use the Support page to send in your question or report an issue.
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/app/support"
            className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
          >
            Open Support
          </Link>
          <Link
            href="/app"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Return to Dashboard
          </Link>
        </div>
      </section>
    </div>
  );
}
