"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  CreditCard,
  FileSignature,
  Megaphone,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type { KnowledgebaseArticle } from "@/content/knowledgebase/articles";

type Props = {
  articles: KnowledgebaseArticle[];
  categories: string[];
  assistantSlot?: React.ReactNode;
};

const categoryIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  "Getting Started": BookOpen,
  "AI & Automations": Sparkles,
  Scheduling: CalendarDays,
  "Billing & Payments": CreditCard,
  "Clients & CRM": Users,
  "Clients & Portals": Users,
  "Client Portal": Users,
  Marketing: Megaphone,
  "Public Discovery & Leads": Megaphone,
  "Public Discovery": Megaphone,
  "Documents & E-Signatures": FileSignature,
  "Security & Privacy": ShieldCheck,
};

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function queryTerms(value: string) {
  return normalize(value)
    .split(" ")
    .filter((term) => term.length > 1);
}

function scoreArticle(article: KnowledgebaseArticle, rawQuery: string) {
  const query = normalize(rawQuery);
  if (!query) return 1;

  const title = normalize(article.title);
  const slug = normalize(article.slug);
  const category = normalize(article.category);
  const description = normalize(article.description);
  const content = normalize(article.content);
  const terms = queryTerms(rawQuery);

  let score = 0;

  if (title === query) score += 1000;
  if (slug === query) score += 900;
  if (title.startsWith(query)) score += 450;
  if (title.includes(query)) score += 350;
  if (description.includes(query)) score += 140;
  if (category.includes(query)) score += 100;
  if (content.includes(query)) score += 60;

  for (const term of terms) {
    if (title === term) score += 80;
    if (title.includes(term)) score += 40;
    if (slug.includes(term)) score += 30;
    if (category.includes(term)) score += 20;
    if (description.includes(term)) score += 15;
    if (content.includes(term)) score += 4;
  }

  const titleTermMatches = terms.filter((term) => title.includes(term)).length;
  if (terms.length > 0 && titleTermMatches === terms.length) score += 180;

  const allText = `${title} ${slug} ${category} ${description} ${content}`;
  const allTermsMatch = terms.length > 0 && terms.every((term) => allText.includes(term));
  if (allTermsMatch) score += 75;

  return score;
}

export default function KnowledgebaseSearch({
  articles,
  categories,
  assistantSlot,
}: Props) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  const filteredArticles = useMemo(() => {
    return articles
      .filter(
        (article) =>
          activeCategory === "All" || article.category === activeCategory,
      )
      .map((article) => ({
        article,
        score: scoreArticle(article, query),
      }))
      .filter(({ score }) => !query.trim() || score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.article.title.localeCompare(b.article.title);
      })
      .map(({ article }) => article);
  }, [activeCategory, articles, query]);

  return (
    <div className="space-y-6">
      <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
              Search the knowledgebase
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Find an article by name or topic
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">
              Search checks article titles, categories, descriptions, URLs, and article content.
            </p>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by exact article name or describe what you need..."
              className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-12 pr-12 text-sm text-slate-900 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-200"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {["All", ...categories].map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setActiveCategory(category)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  activeCategory === category
                    ? "bg-violet-700 text-white"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {category}
              </button>
            ))}
          </div>

          {query.trim() ? (
            <p className="text-xs text-slate-500">
              {filteredArticles.length} article{filteredArticles.length === 1 ? "" : "s"} found
              for “{query.trim()}”.
            </p>
          ) : null}
        </div>

        {filteredArticles.length > 0 ? (
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredArticles.map((article) => {
              const Icon =
                categoryIcons[article.category] ?? BookOpen;

              return (
                <Link
                  key={article.slug}
                  href={`/knowledgebase/${article.slug}`}
                  className="group rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md"
                >
                  <div className="flex items-start gap-3">
                    <div className="rounded-2xl bg-violet-50 p-2.5 text-violet-700">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-violet-700">
                        {article.category}
                      </p>
                      <h3 className="mt-2 text-base font-semibold leading-6 text-slate-950 group-hover:text-violet-800">
                        {article.title}
                      </h3>
                    </div>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    {article.description}
                  </p>
                  <p className="mt-4 text-xs font-semibold text-violet-700">
                    Read article →
                  </p>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-7 text-amber-950">
            No matching article was found. Clear the category filter or try the exact article title, a shorter phrase, or the help search below.
          </div>
        )}
      </section>

      {assistantSlot}
    </div>
  );
}
