import path from "node:path";
import { loadKnowledgebaseArticlesOrThrow } from "./loader";
import { resolveKnowledgebaseSlug, type SlugResolution } from "./redirects";
import type { KnowledgebaseArticle } from "./schema";
import { knowledgebaseRedirects } from "@/content/knowledgebase/redirects";

export type { KnowledgebaseArticle } from "./schema";

/** One Markdown file per article. Read once per server process (pages are statically generated at build). */
const ARTICLES_DIR = path.join(process.cwd(), "src", "content", "knowledgebase", "articles");

let cache: KnowledgebaseArticle[] | null = null;

/** Every article, sorted by `order`, including drafts and signed-in articles. */
export function getKnowledgebaseArticles(): KnowledgebaseArticle[] {
  if (!cache) cache = loadKnowledgebaseArticlesOrThrow(ARTICLES_DIR);
  return cache;
}

/** What the public site may show: published and visible to everyone. */
export function getPublicKnowledgebaseArticles(): KnowledgebaseArticle[] {
  return getKnowledgebaseArticles().filter(
    (article) => article.status === "published" && article.visibility === "public",
  );
}

export function getKnowledgebaseArticleBySlug(slug: string): KnowledgebaseArticle | null {
  return getKnowledgebaseArticles().find((article) => article.slug === slug) ?? null;
}

export function getKnowledgebaseCategories(): string[] {
  return Array.from(new Set(getPublicKnowledgebaseArticles().map((article) => article.category)));
}

/** Public-site resolution of a URL slug: serve it, redirect a retired slug, or 404. */
export function resolvePublicKnowledgebaseSlug(slug: string): SlugResolution {
  const live = new Set(getPublicKnowledgebaseArticles().map((article) => article.slug));
  return resolveKnowledgebaseSlug(slug, live, knowledgebaseRedirects);
}

/**
 * "More articles" for an article page. Uses the article's own `related` list when it has one;
 * until an article is given one, falls back to the first articles in index order (the behavior before KB-2B).
 */
export function getRelatedPublicKnowledgebaseArticles(article: KnowledgebaseArticle, limit = 3): KnowledgebaseArticle[] {
  const publicArticles = getPublicKnowledgebaseArticles();
  if (article.related.length > 0) {
    const bySlug = new Map(publicArticles.map((item) => [item.slug, item]));
    return article.related
      .map((slug) => bySlug.get(slug))
      .filter((item): item is KnowledgebaseArticle => Boolean(item))
      .slice(0, limit);
  }
  return publicArticles.filter((item) => item.slug !== article.slug).slice(0, limit);
}
