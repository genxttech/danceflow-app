import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BookOpen } from "lucide-react";
import {
  getKnowledgebaseArticleBySlug,
  getPublicKnowledgebaseArticles,
} from "@/content/knowledgebase/articles";

type PageProps = {
  params: Promise<{
    slug: string;
  }>;
};

function renderArticleContent(content: string) {
  const lines = content.trim().split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];

  function flushList() {
    if (listItems.length === 0) return;

    elements.push(
      <ul key={`list-${elements.length}`} className="my-5 list-disc space-y-2 pl-6 text-slate-700">
        {listItems.map((item) => (
          <li key={item}>{formatInlineText(item)}</li>
        ))}
      </ul>
    );

    listItems = [];
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      return;
    }

    if (trimmed.startsWith("- ")) {
      listItems.push(trimmed.slice(2));
      return;
    }

    flushList();

    if (trimmed.startsWith("## ")) {
      elements.push(
        <h2
          key={`h2-${index}`}
          className="mt-9 text-2xl font-semibold tracking-tight text-slate-950"
        >
          {trimmed.replace("## ", "")}
        </h2>
      );
      return;
    }

    if (trimmed.startsWith("# ")) {
      elements.push(
        <h1
          key={`h1-${index}`}
          className="mt-9 text-3xl font-semibold tracking-tight text-slate-950"
        >
          {trimmed.replace("# ", "")}
        </h1>
      );
      return;
    }

    elements.push(
      <p key={`p-${index}`} className="my-4 text-base leading-8 text-slate-700">
        {formatInlineText(trimmed)}
      </p>
    );
  });

  flushList();

  return elements;
}

function formatInlineText(text: string) {
  const parts = text.split(/(\*\*.*?\*\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={`${part}-${index}`} className="font-semibold text-slate-950">
          {part.slice(2, -2)}
        </strong>
      );
    }

    return part;
  });
}

export function generateStaticParams() {
  return getPublicKnowledgebaseArticles().map((article) => ({
    slug: article.slug,
  }));
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const article = getKnowledgebaseArticleBySlug(slug);

  if (!article) {
    return {
      title: "Knowledgebase Article | DanceFlow",
    };
  }

  return {
    title: `${article.title} | DanceFlow Knowledgebase`,
    description: article.description,
  };
}

export default async function KnowledgebaseArticlePage({ params }: PageProps) {
  const { slug } = await params;
  const article = getKnowledgebaseArticleBySlug(slug);

  if (!article || article.audience === "app") {
    notFound();
  }

  const relatedArticles = getPublicKnowledgebaseArticles()
    .filter((item) => item.slug !== article.slug)
    .slice(0, 3);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <Link
            href="/knowledgebase"
            className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/15"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Knowledgebase
          </Link>

          <div className="mt-7 max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              {article.category}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              {article.title}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
              {article.description}
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-8 xl:grid-cols-[1fr_320px]">
        <article className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
          <div className="prose prose-slate max-w-none">
            {renderArticleContent(article.content)}
          </div>
        </article>

        <aside className="space-y-4">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  More articles
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Continue learning how DanceFlow supports studio operations.
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {relatedArticles.map((relatedArticle) => (
                <Link
                  key={relatedArticle.slug}
                  href={`/knowledgebase/${relatedArticle.slug}`}
                  className="block rounded-2xl border border-slate-200 bg-slate-50 p-4 hover:border-[var(--brand-primary)] hover:bg-white"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--brand-primary)]">
                    {relatedArticle.category}
                  </p>
                  <h3 className="mt-1 text-sm font-semibold text-slate-950">
                    {relatedArticle.title}
                  </h3>
                </Link>
              ))}
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">
              Ready to try DanceFlow?
            </h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              Start with a studio or organizer workspace and explore the tools
              built for dance businesses.
            </p>
            <Link
              href="/get-started"
              className="mt-4 inline-flex rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
            >
              Start Free Trial
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}