import type { KnowledgebaseRedirects } from "@/lib/knowledgebase/redirects";

/**
 * Retired article slugs, mapped to the live slug that replaces them: `"old-slug": "surviving-slug"`.
 * No slug has been retired yet. Retiring or renaming an article must add an entry here in the same change
 * (slugs are linked from the welcome email, search engines and the mobile apps); the content tests enforce it.
 */
export const knowledgebaseRedirects: KnowledgebaseRedirects = {};
