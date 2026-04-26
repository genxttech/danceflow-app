import Link from "next/link";
import {
  BookOpen,
  Building2,
  CreditCard,
  LifeBuoy,
  Search,
  Users,
} from "lucide-react";
import {
  getKnowledgebaseCategories,
  getPublicKnowledgebaseArticles,
} from "@/content/knowledgebase/articles";

const categoryIcons = {
  "Getting Started": BookOpen,
  "Sales & Revenue": CreditCard,
  "Independent Instructors": Users,
  "Billing & Payments": CreditCard,
};

export default function KnowledgebasePage() {
  const articles = getPublicKnowledgebaseArticles();
  const categories = getKnowledgebaseCategories();

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
                Help for studios, organizers, and dancers
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Learn how DanceFlow helps studios manage clients, scheduling,
                packages, memberships, payments, independent instructor rentals,
                and public discovery.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/get-started"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Start Free Trial
              </Link>
              <Link
                href="/app"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Sign In
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                Start with the basics
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Learn what DanceFlow does and how studios can get set up for
                daily use.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">
                Built around real workflows
              </h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Articles focus on practical studio tasks like packages,
                memberships, rentals, billing, and scheduling.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">
                More guides coming soon
              </h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                This public knowledgebase will grow as the platform moves closer
                to launch.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Search className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">
              Browse articles
            </h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              Choose a guide below to learn how DanceFlow supports studio
              operations, public discovery, and client management.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {articles.map((article) => (
            <Link
              key={article.slug}
              href={`/knowledgebase/${article.slug}`}
              className="group rounded-2xl border border-slate-200 bg-slate-50 p-5 transition hover:-translate-y-0.5 hover:border-[var(--brand-primary)] hover:bg-white hover:shadow-sm"
            >
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-primary)]">
                {article.category}
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-950 group-hover:text-[var(--brand-primary)]">
                {article.title}
              </h3>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                {article.description}
              </p>
              <p className="mt-4 text-sm font-semibold text-[var(--brand-primary)]">
                Read article →
              </p>
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">
              Article categories
            </h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              These sections will expand as more help content is added.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {categories.map((category) => {
            const Icon =
              categoryIcons[category as keyof typeof categoryIcons] ?? BookOpen;

            return (
              <div
                key={category}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
              >
                <div className="rounded-2xl bg-white p-3 text-[var(--brand-primary)] shadow-sm w-fit">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">
                  {category}
                </h3>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  {articles.filter((article) => article.category === category).length}{" "}
                  article
                  {articles.filter((article) => article.category === category)
                    .length === 1
                    ? ""
                    : "s"}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <LifeBuoy className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">
              Need more help?
            </h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              The knowledgebase is still growing. Signed-in users can return to
              the app dashboard for account-specific tools and support options.
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/app"
            className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
          >
            Go to App
          </Link>
          <Link
            href="/get-started"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Start Free Trial
          </Link>
        </div>
      </section>
    </div>
  );
}
