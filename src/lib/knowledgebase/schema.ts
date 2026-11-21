/**
 * KB-2B: knowledgebase article schema.
 *
 * Pure types and validation, no filesystem access, so client components may import the types.
 * Each article is one Markdown file with a frontmatter block (see `frontmatter.ts` for the accepted syntax).
 */

export const KB_VISIBILITIES = ["public", "signed_in"] as const;
export type KnowledgebaseVisibility = (typeof KB_VISIBILITIES)[number];

export const KB_STATUSES = ["published", "draft"] as const;
export type KnowledgebaseStatus = (typeof KB_STATUSES)[number];

/** Who the article is written for. Empty means "not yet classified" (every migrated article starts that way). */
export const KB_ROLES = [
  "owner",
  "admin",
  "front_desk",
  "instructor",
  "independent_instructor",
  "organizer",
  "student",
  "prospect",
] as const;
export type KnowledgebaseRole = (typeof KB_ROLES)[number];

export type KnowledgebaseRequirements = {
  /** Plan or add-on the feature needs, free text for now (for example "growth", "organizer_suite"). */
  plan?: string;
  /** Environment or release flags that gate the feature. */
  flags?: string[];
};

export type KnowledgebaseFrontmatter = {
  title: string;
  slug: string;
  category: string;
  summary: string;
  /** Position in the index and in "first N" fallbacks. Unique across articles. */
  order: number;
  visibility: KnowledgebaseVisibility;
  status: KnowledgebaseStatus;
  roles: KnowledgebaseRole[];
  requires: KnowledgebaseRequirements;
  /** ISO date (YYYY-MM-DD) the article was last checked against the product. Absent means never verified. */
  lastVerified: string | null;
  /** Slugs of related articles, in display order. */
  related: string[];
  /** Placeholder for KB-4 page-context mapping (route keys). Must stay empty until KB-4. */
  contexts: string[];
};

export type KnowledgebaseArticle = KnowledgebaseFrontmatter & {
  /** Markdown body, without the frontmatter block. */
  content: string;
};

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FLAG_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const ALLOWED_KEYS = new Set([
  "title",
  "slug",
  "category",
  "summary",
  "order",
  "visibility",
  "status",
  "roles",
  "requires",
  "lastVerified",
  "related",
  "contexts",
]);

type Raw = Record<string, unknown>;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates parsed frontmatter and returns a normalized object, or the list of problems.
 * `where` names the file in error messages.
 */
export function validateFrontmatter(
  raw: Raw,
  where: string,
): { ok: true; value: KnowledgebaseFrontmatter } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`${where}: ${message}`);

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) fail(`unknown frontmatter key "${key}"`);
  }

  const text = (key: string) => {
    const value = raw[key];
    if (typeof value !== "string" || value.trim() === "") {
      fail(`"${key}" is required and must be a non-empty string`);
      return "";
    }
    if (value !== value.trim()) fail(`"${key}" must not have leading or trailing whitespace`);
    return value;
  };

  const title = text("title");
  const slug = text("slug");
  const category = text("category");
  const summary = text("summary");

  if (slug && !SLUG_PATTERN.test(slug)) fail(`"slug" must be lowercase letters, digits and single hyphens`);

  let order = 0;
  if (typeof raw.order !== "number" || !Number.isInteger(raw.order) || raw.order < 0) {
    fail(`"order" is required and must be a non-negative integer`);
  } else {
    order = raw.order;
  }

  let visibility: KnowledgebaseVisibility = "public";
  if (raw.visibility !== undefined) {
    if (!(KB_VISIBILITIES as readonly unknown[]).includes(raw.visibility)) {
      fail(`"visibility" must be one of ${KB_VISIBILITIES.join(", ")}`);
    } else {
      visibility = raw.visibility as KnowledgebaseVisibility;
    }
  }

  let status: KnowledgebaseStatus = "published";
  if (raw.status !== undefined) {
    if (!(KB_STATUSES as readonly unknown[]).includes(raw.status)) {
      fail(`"status" must be one of ${KB_STATUSES.join(", ")}`);
    } else {
      status = raw.status as KnowledgebaseStatus;
    }
  }

  let roles: KnowledgebaseRole[] = [];
  if (raw.roles !== undefined) {
    if (!isStringList(raw.roles)) {
      fail(`"roles" must be a list`);
    } else {
      for (const role of raw.roles) {
        if (!(KB_ROLES as readonly string[]).includes(role)) fail(`unknown role "${role}"`);
      }
      if (new Set(raw.roles).size !== raw.roles.length) fail(`"roles" has duplicates`);
      roles = raw.roles as KnowledgebaseRole[];
    }
  }

  const requires: KnowledgebaseRequirements = {};
  if (raw.requires !== undefined) {
    const value = raw.requires;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`"requires" must be a map with optional "plan" and "flags"`);
    } else {
      const map = value as Raw;
      for (const key of Object.keys(map)) {
        if (key !== "plan" && key !== "flags") fail(`unknown "requires" key "${key}"`);
      }
      if (map.plan !== undefined) {
        if (typeof map.plan !== "string" || map.plan.trim() === "") fail(`"requires.plan" must be a non-empty string`);
        else requires.plan = map.plan;
      }
      if (map.flags !== undefined) {
        if (!isStringList(map.flags)) {
          fail(`"requires.flags" must be a list`);
        } else {
          for (const flag of map.flags) {
            if (!FLAG_PATTERN.test(flag)) fail(`flag "${flag}" must look like AN_ENV_FLAG`);
          }
          requires.flags = map.flags;
        }
      }
    }
  }

  let lastVerified: string | null = null;
  if (raw.lastVerified !== undefined) {
    if (typeof raw.lastVerified !== "string" || !ISO_DATE.test(raw.lastVerified) || Number.isNaN(Date.parse(raw.lastVerified))) {
      fail(`"lastVerified" must be a YYYY-MM-DD date`);
    } else {
      lastVerified = raw.lastVerified;
    }
  }

  let related: string[] = [];
  if (raw.related !== undefined) {
    if (!isStringList(raw.related)) {
      fail(`"related" must be a list of slugs`);
    } else {
      for (const item of raw.related) {
        if (!SLUG_PATTERN.test(item)) fail(`related entry "${item}" is not a valid slug`);
      }
      if (new Set(raw.related).size !== raw.related.length) fail(`"related" has duplicates`);
      if (slug && raw.related.includes(slug)) fail(`"related" must not list the article itself`);
      related = raw.related;
    }
  }

  let contexts: string[] = [];
  if (raw.contexts !== undefined) {
    if (!isStringList(raw.contexts)) fail(`"contexts" must be a list`);
    else if (raw.contexts.length > 0) fail(`"contexts" is reserved for KB-4 and must stay empty until then`);
    else contexts = raw.contexts;
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { title, slug, category, summary, order, visibility, status, roles, requires, lastVerified, related, contexts },
  };
}
