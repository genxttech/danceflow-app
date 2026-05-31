"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  BookOpen,
  Building2,
  CalendarDays,
  CreditCard,
  Megaphone,
  Search,
  ShieldCheck,
  Ticket,
  Users,
  X,
} from "lucide-react";
import type { KnowledgebaseArticle } from "@/content/knowledgebase/articles";

type KnowledgebaseSearchProps = {
  articles: KnowledgebaseArticle[];
  categories: string[];
  assistantSlot?: ReactNode;
};

const categoryIcons = {
  "Getting Started": BookOpen,
  "Sales & Revenue": CreditCard,
  "Independent Instructors": Users,
  "Billing & Payments": CreditCard,
  "Clients & Portals": Users,
  "Client Portal": Users,
  "Public Discovery & Leads": Megaphone,
  "Public Discovery": Megaphone,
  Scheduling: CalendarDays,
  Events: Ticket,
  "Platform Updates": Building2,
  "Clients & Billing": Users,
  "Reports & Expenses": CreditCard,
  "Security & Privacy": ShieldCheck,
  Marketing: Megaphone,
};

function normalize(value: string) {
  return value.toLowerCase().trim();
}

function getSearchText(article: KnowledgebaseArticle) {
  return normalize(
    [
      article.title,
      article.category,
      article.description,
      article.audience,
      article.content,
    ].join(" "),
  );
}

export default function KnowledgebaseSearch({
  articles,
  categories,
  assistantSlot,
}: KnowledgebaseSearchProps) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  const normalizedQuery = normalize(query);

  const filteredArticles = articles.filter((article) => {
    const matchesCategory =
      activeCategory === "All" || article.category === activeCategory;

    const matchesSearch =
      !normalizedQuery || getSearchText(article).includes(normalizedQuery);

    return matchesCategory && matchesSearch;
  });

  return (
    <>
      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Search className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">
                Search articles
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">
                Search by topic, workflow, category, or keyword. Use the category
                filters to narrow the list to the area you are working on.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-950">
            {filteredArticles.length} of {articles.length} articles shown
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center gap-3 rounded-xl bg-white px-3 py-2 shadow-sm">
            <Search className="h-5 w-5 shrink-0 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search events, QR check-in, early bird pricing, campaigns..."
              className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {["All", ...categories].map((category) => {
              const active = activeCategory === category;

              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setActiveCategory(category)}
                  className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition ${
                    active
                      ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white shadow-sm"
                      : "border-slate-200 bg-white text-slate-700 hover:border-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
                  }`}
                >
                  {category}
                </button>
              );
            })}
          </div>
        </div>

        {assistantSlot ? <div className="mt-6">{assistantSlot}</div> : null}

        {filteredArticles.length ? (
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {filteredArticles.map((article) => (
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
        ) : (
          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-7 text-amber-950">
            No articles matched your search. Try a broader term like
            <span className="font-semibold"> events</span>,
            <span className="font-semibold"> scheduling</span>,
            <span className="font-semibold"> tickets</span>, or
            <span className="font-semibold"> clients</span>.
          </div>
        )}
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
              Browse the knowledgebase by the area of DanceFlow you are setting
              up or using.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {categories.map((category) => {
            const Icon =
              categoryIcons[category as keyof typeof categoryIcons] ?? BookOpen;
            const count = articles.filter(
              (article) => article.category === category,
            ).length;

            return (
              <button
                key={category}
                type="button"
                onClick={() => setActiveCategory(category)}
                className={`rounded-2xl border p-5 text-left transition hover:-translate-y-0.5 hover:shadow-sm ${
                  activeCategory === category
                    ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]"
                    : "border-slate-200 bg-slate-50 hover:border-[var(--brand-primary)] hover:bg-white"
                }`}
              >
                <div className="w-fit rounded-2xl bg-white p-3 text-[var(--brand-primary)] shadow-sm">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">
                  {category}
                </h3>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  {count} article{count === 1 ? "" : "s"}
                </p>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}
