/**
 * KB-2B: redirects for retired article slugs.
 *
 * Slugs are a public contract (search engines, the welcome email, the mobile apps' Help links).
 * When an article is merged or renamed, its old slug is mapped here to the surviving slug and the
 * route answers with a permanent redirect. The map itself lives next to the content
 * (`src/content/knowledgebase/redirects.ts`); this file holds the pure logic so it can be tested.
 */

export type KnowledgebaseRedirects = Readonly<Record<string, string>>;

export type SlugResolution =
  | { kind: "article"; slug: string }
  | { kind: "redirect"; slug: string }
  | { kind: "missing" };

export function resolveKnowledgebaseSlug(
  slug: string,
  liveSlugs: ReadonlySet<string>,
  redirects: KnowledgebaseRedirects,
): SlugResolution {
  if (liveSlugs.has(slug)) return { kind: "article", slug };
  const target = Object.prototype.hasOwnProperty.call(redirects, slug) ? redirects[slug] : undefined;
  if (target && liveSlugs.has(target)) return { kind: "redirect", slug: target };
  return { kind: "missing" };
}

/** Returns every problem with a redirect map: a retired slug that is still live, a dangling target, a chain, or a self redirect. */
export function validateKnowledgebaseRedirects(
  redirects: KnowledgebaseRedirects,
  liveSlugs: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  for (const [from, to] of Object.entries(redirects)) {
    if (from === to) errors.push(`redirect "${from}" points at itself`);
    if (liveSlugs.has(from)) errors.push(`redirect source "${from}" is still a live article; remove the redirect or the article`);
    if (!liveSlugs.has(to)) {
      errors.push(
        Object.prototype.hasOwnProperty.call(redirects, to)
          ? `redirect "${from}" -> "${to}" is a chain; point it at the final live slug`
          : `redirect "${from}" -> "${to}": target is not a live article`,
      );
    }
  }
  return errors;
}
