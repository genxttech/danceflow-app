"use server";

import { callOpenAiResponses, isAiFeatureEnabled } from "@/lib/ai/providerCall";
import { checkRateLimit, getServerActionRateLimitKey } from "@/lib/security/rate-limit";

import { getPublicKnowledgebaseArticles } from "@/lib/knowledgebase/articles";
import type { KnowledgebaseArticle } from "@/lib/knowledgebase/schema";

export type KnowledgebaseAssistantState = {
  ok: boolean;
  error?: string;
  answer?: string;
  relatedArticles?: Array<{
    title: string;
    description: string;
    href: string;
    category: string;
  }>;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

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

function getQuestionTerms(question: string) {
  const stopWords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "can", "do", "for",
    "from", "how", "i", "in", "is", "it", "me", "my", "of", "on",
    "or", "the", "to", "use", "what", "when", "where", "with",
  ]);

  return normalize(question)
    .split(" ")
    .filter((term) => term.length > 1 && !stopWords.has(term));
}

function scoreArticle(
  article: KnowledgebaseArticle,
  normalizedQuestion: string,
  terms: string[],
) {
  const title = normalize(article.title);
  const slug = normalize(article.slug);
  const category = normalize(article.category);
  const description = normalize(article.summary);
  const content = normalize(article.content);

  let score = 0;

  if (title === normalizedQuestion) score += 2000;
  if (slug === normalizedQuestion) score += 1800;
  if (title.startsWith(normalizedQuestion)) score += 800;
  if (title.includes(normalizedQuestion)) score += 650;
  if (description.includes(normalizedQuestion)) score += 220;
  if (content.includes(normalizedQuestion)) score += 100;

  for (const term of terms) {
    if (title.includes(term)) score += 60;
    if (slug.includes(term)) score += 45;
    if (category.includes(term)) score += 25;
    if (description.includes(term)) score += 20;
    if (content.includes(term)) score += 5;
  }

  const titleMatches = terms.filter((term) => title.includes(term)).length;
  if (terms.length > 0 && titleMatches === terms.length) score += 350;

  const searchable = `${title} ${slug} ${category} ${description} ${content}`;
  if (terms.length > 0 && terms.every((term) => searchable.includes(term))) {
    score += 150;
  }

  return score;
}

function getRelevantArticles(question: string) {
  const articles = getPublicKnowledgebaseArticles();
  const normalizedQuestion = normalize(question);
  const terms = getQuestionTerms(question);

  if (!normalizedQuestion) return [];

  return articles
    .map((article) => ({
      article,
      score: scoreArticle(article, normalizedQuestion, terms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.article);
}

function buildArticleContext(articles: KnowledgebaseArticle[]) {
  return articles
    .map((article) => {
      const content = article.content.trim().replace(/\s+/g, " ").slice(0, 3200);

      return [
        `Title: ${article.title}`,
        `Category: ${article.category}`,
        `Description: ${article.summary}`,
        `URL: /knowledgebase/${article.slug}`,
        `Content: ${content}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

async function withinPublicRateLimit() {
  // Per-IP, per instance (see rate-limit.ts): a speed bump for casual abuse, not a hard budget.
  const perMinute = checkRateLimit(await getServerActionRateLimitKey("ai:kb-public:min"), { limit: 5, windowMs: 60 * 1000 });
  if (!perMinute.allowed) return false;
  const perHour = checkRateLimit(await getServerActionRateLimitKey("ai:kb-public:hour"), { limit: 30, windowMs: 60 * 60 * 1000 });
  return perHour.allowed;
}

// Public, unauthenticated surface: every model call is paid by DanceFlow, so it is bounded (see lib/ai/providerCall.ts).
const MAX_QUESTION_CHARS = 300;
const KB_MODEL_TIMEOUT_MS = 8000;

export async function askKnowledgebaseAssistantAction(
  _previousState: KnowledgebaseAssistantState,
  formData: FormData,
): Promise<KnowledgebaseAssistantState> {
  const question = getString(formData, "question").replace(/\s+/g, " ");

  if (question.length > MAX_QUESTION_CHARS) {
    return {
      ok: false,
      error: `Please keep your question under ${MAX_QUESTION_CHARS} characters.`,
    };
  }

  if (question.length < 3) {
    return {
      ok: false,
      error: "Enter an article name or a short question so DanceFlow can find the right guide.",
    };
  }

  const relevantArticles = getRelevantArticles(question);

  if (relevantArticles.length === 0) {
    return {
      ok: false,
      error:
        "I could not find a matching DanceFlow guide. Try the exact article title or a shorter phrase.",
    };
  }

  // Exact-title searches should still return the article even if AI help is disabled.
  const exactTitle = relevantArticles.find(
    (article) => normalize(article.title) === normalize(question),
  );

  // Link-only answer (no provider call) when AI is off, the public feature is switched off (AI_DISABLED_FEATURES=kb_public),
  // or this caller is over the per-IP limit.
  const modelAllowed =
    isAiFeatureEnabled("kb_public") &&
    (await withinPublicRateLimit());

  if (!modelAllowed) {
    const top = exactTitle ?? relevantArticles[0];
    return {
      ok: true,
      answer: exactTitle
        ? `I found the article “${top.title}”. Open it below for the full guide.`
        : `I found ${relevantArticles.length} relevant DanceFlow guide${relevantArticles.length === 1 ? "" : "s"}. Open the closest match below.`,
      relatedArticles: relevantArticles.slice(0, 6).map((article) => ({
        title: article.title,
        description: article.summary,
        href: `/knowledgebase/${article.slug}`,
        category: article.category,
      })),
    };
  }

  const articleContext = buildArticleContext(relevantArticles);
  const model =
    process.env.OPENAI_MODEL_KNOWLEDGEBASE_ASSISTANT ??
    process.env.OPENAI_MODEL_REPORT_INSIGHTS ??
    "gpt-4.1-mini";

  const result = await callOpenAiResponses({
    feature: "kb_public",
    model,
    temperature: 0.2,
    maxOutputTokens: 850,
    maxInputChars: 36000,
    timeoutMs: KB_MODEL_TIMEOUT_MS,
    // Best-effort global ceiling per server instance (in-memory); a durable budget needs storage and is a separate decision.
    budget: { limit: Number.parseInt(process.env.KB_ASSISTANT_INSTANCE_HOURLY_BUDGET ?? "", 10) || 300, windowMs: 60 * 60 * 1000 },
    input: [
      {
        role: "system",
        content:
          "You are a helpful DanceFlow support assistant. Answer only from the provided knowledgebase article excerpts. Use plain, practical language for studio owners, organizers, instructors, and dancers. When an exact matching article is provided, clearly name it and direct the user to the related article link. If the articles do not answer the question, say the available guides do not fully answer it. Do not mention prompts, internal implementation, model names, database details, roadmap phases, or unsupported product claims. Do not provide legal, tax, medical, or financial advice. Keep the answer concise and action-oriented.",
      },
      {
        role: "user",
        content: `Question or article search:\n${question}\n\nRelevant DanceFlow knowledgebase articles:\n${articleContext}\n\nReturn a helpful answer using only these articles.`,
      },
    ],
  });

  if (!result.ok) {
    return {
      ok: true,
      answer: exactTitle
        ? `I found the article “${exactTitle.title}”. Open it below for the full guide.`
        : "I found relevant DanceFlow guides, but the help answer could not be generated right now. Open one of the matching articles below.",
      relatedArticles: relevantArticles.slice(0, 6).map((article) => ({
        title: article.title,
        description: article.summary,
        href: `/knowledgebase/${article.slug}`,
        category: article.category,
      })),
    };
  }

  const answer = result.text;

  return {
    ok: true,
    answer:
      answer ??
      (exactTitle
        ? `I found the article “${exactTitle.title}”. Open it below for the full guide.`
        : "I found relevant DanceFlow guides. Open one of the matching articles below."),
    relatedArticles: relevantArticles.slice(0, 6).map((article) => ({
      title: article.title,
      description: article.summary,
      href: `/knowledgebase/${article.slug}`,
      category: article.category,
    })),
  };
}
