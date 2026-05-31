import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import {
  getKnowledgebaseCategories,
  getPublicKnowledgebaseArticles,
} from "@/content/knowledgebase/articles";
import KnowledgebaseAIAssistant from "./KnowledgebaseAIAssistant";
import KnowledgebaseSearch from "./KnowledgebaseSearch";

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
                Search practical guides for CRM, scheduling, events, ticketing,
                marketing, public discovery, payments, and studio operations.
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
                Find setup guides for studio workspaces, public profiles,
                client data, billing, and daily operations.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">
                Follow real workflows
              </h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Learn practical tasks like creating events, using QR check-in,
                setting early bird pricing, and managing guest coach lessons.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">
                Search as you work
              </h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Use search and category filters to quickly find the article that
                matches the task you are trying to complete.
              </p>
            </div>
          </div>
        </div>
      </section>

      <KnowledgebaseSearch
        articles={articles}
        categories={categories}
        assistantSlot={<KnowledgebaseAIAssistant />}
      />

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
              The knowledgebase will continue growing as more workflows are
              released. Signed-in users can return to the app dashboard for
              account-specific tools and support options.
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

