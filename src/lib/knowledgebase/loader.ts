import fs from "node:fs";
import path from "node:path";
import { FrontmatterError, parseFrontmatter } from "./frontmatter";
import { validateFrontmatter, type KnowledgebaseArticle } from "./schema";

export type KnowledgebaseLoadResult = {
  /** Valid articles, sorted by `order`. */
  articles: KnowledgebaseArticle[];
  /** Every problem found, so a test can report them all at once. */
  errors: string[];
};

/**
 * Reads every `<slug>.md` in `dir`. Nothing here throws for content problems: they come back in `errors`
 * (see `loadKnowledgebaseArticlesOrThrow` for the runtime wrapper).
 */
export function loadKnowledgebaseArticlesFrom(dir: string): KnowledgebaseLoadResult {
  const errors: string[] = [];
  const articles: KnowledgebaseArticle[] = [];

  const files = fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort();

  for (const file of files) {
    if (!file.endsWith(".md")) {
      errors.push(`${file}: only .md article files are allowed in the articles folder`);
      continue;
    }
    const where = file;
    let parsed;
    try {
      parsed = parseFrontmatter(fs.readFileSync(path.join(dir, file), "utf8"), where);
    } catch (error) {
      if (error instanceof FrontmatterError) {
        errors.push(error.message);
        continue;
      }
      throw error;
    }

    const checked = validateFrontmatter(parsed.data, where);
    if (!checked.ok) {
      errors.push(...checked.errors);
      continue;
    }

    const content = parsed.body.trim();
    if (content === "") errors.push(`${where}: article body is empty`);
    if (file !== `${checked.value.slug}.md`) {
      errors.push(`${where}: file name must be "${checked.value.slug}.md" to match its slug`);
    }
    articles.push({ ...checked.value, content });
  }

  const bySlug = new Map<string, KnowledgebaseArticle>();
  const byOrder = new Map<number, string>();
  for (const article of articles) {
    if (bySlug.has(article.slug)) errors.push(`duplicate slug "${article.slug}"`);
    bySlug.set(article.slug, article);
    const clash = byOrder.get(article.order);
    if (clash) errors.push(`"${article.slug}" and "${clash}" share order ${article.order}`);
    byOrder.set(article.order, article.slug);
  }

  for (const article of articles) {
    for (const ref of article.related) {
      const target = bySlug.get(ref);
      if (!target) errors.push(`"${article.slug}": related slug "${ref}" does not exist`);
      else if (target.status !== "published") errors.push(`"${article.slug}": related slug "${ref}" is not published`);
      else if (article.visibility === "public" && target.visibility !== "public") {
        errors.push(`"${article.slug}": a public article must not relate to the signed-in article "${ref}"`);
      }
    }
  }

  articles.sort((a, b) => a.order - b.order);
  return { articles, errors };
}

export function loadKnowledgebaseArticlesOrThrow(dir: string): KnowledgebaseArticle[] {
  const { articles, errors } = loadKnowledgebaseArticlesFrom(dir);
  if (errors.length > 0) {
    throw new Error(`Knowledgebase content is invalid:\n- ${errors.join("\n- ")}`);
  }
  return articles;
}
