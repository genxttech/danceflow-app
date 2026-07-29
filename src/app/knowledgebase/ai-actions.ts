"use server";

import {
  getPublicKnowledgebaseArticles,
  type KnowledgebaseArticle,
} from "@/content/knowledgebase/articles";

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

type OpenAiResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getOutputText(data: OpenAiResponse) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const text = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();

  return text || null;
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
  const description = normalize(article.description);
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
        `Description: ${article.description}`,
        `URL: /knowledgebase/${article.slug}`,
        `Content: ${content}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

export async function askKnowledgebaseAssistantAction(
  _previousState: KnowledgebaseAssistantState,
  formData: FormData,
): Promise<KnowledgebaseAssistantState> {
  const question = getString(formData, "question");

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

  if (process.env.AI_FEATURES_ENABLED !== "true" || !process.env.OPENAI_API_KEY) {
    const top = exactTitle ?? relevantArticles[0];
    return {
      ok: true,
      answer: exactTitle
        ? `I found the article “${top.title}”. Open it below for the full guide.`
        : `I found ${relevantArticles.length} relevant DanceFlow guide${relevantArticles.length === 1 ? "" : "s"}. Open the closest match below.`,
      relatedArticles: relevantArticles.slice(0, 6).map((article) => ({
        title: article.title,
        description: article.description,
        href: `/knowledgebase/${article.slug}`,
        category: article.category,
      })),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const articleContext = buildArticleContext(relevantArticles);
  const model =
    process.env.OPENAI_MODEL_KNOWLEDGEBASE_ASSISTANT ??
    process.env.OPENAI_MODEL_REPORT_INSIGHTS ??
    "gpt-4.1-mini";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_output_tokens: 850,
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
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAiResponse;

  if (!response.ok) {
    return {
      ok: true,
      answer: exactTitle
        ? `I found the article “${exactTitle.title}”. Open it below for the full guide.`
        : "I found relevant DanceFlow guides, but the help answer could not be generated right now. Open one of the matching articles below.",
      relatedArticles: relevantArticles.slice(0, 6).map((article) => ({
        title: article.title,
        description: article.description,
        href: `/knowledgebase/${article.slug}`,
        category: article.category,
      })),
    };
  }

  const answer = getOutputText(data);

  return {
    ok: true,
    answer:
      answer ??
      (exactTitle
        ? `I found the article “${exactTitle.title}”. Open it below for the full guide.`
        : "I found relevant DanceFlow guides. Open one of the matching articles below."),
    relatedArticles: relevantArticles.slice(0, 6).map((article) => ({
      title: article.title,
      description: article.description,
      href: `/knowledgebase/${article.slug}`,
      category: article.category,
    })),
  };
}
