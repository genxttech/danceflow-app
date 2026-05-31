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
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getQuestionTerms(question: string) {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "can",
    "do",
    "for",
    "from",
    "how",
    "i",
    "in",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "the",
    "to",
    "use",
    "what",
    "when",
    "where",
    "with",
  ]);

  return normalize(question)
    .split(" ")
    .filter((term) => term.length > 2 && !stopWords.has(term));
}

function scoreArticle(article: KnowledgebaseArticle, terms: string[]) {
  const title = normalize(article.title);
  const category = normalize(article.category);
  const description = normalize(article.description);
  const content = normalize(article.content);

  return terms.reduce((score, term) => {
    let nextScore = score;

    if (title.includes(term)) nextScore += 8;
    if (category.includes(term)) nextScore += 5;
    if (description.includes(term)) nextScore += 4;
    if (content.includes(term)) nextScore += 1;

    return nextScore;
  }, 0);
}

function getRelevantArticles(question: string) {
  const articles = getPublicKnowledgebaseArticles();
  const terms = getQuestionTerms(question);

  if (terms.length === 0) {
    return articles.slice(0, 6);
  }

  const scoredArticles = articles
    .map((article) => ({ article, score: scoreArticle(article, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.article);

  if (scoredArticles.length > 0) {
    return scoredArticles.slice(0, 6);
  }

  return articles.slice(0, 6);
}

function buildArticleContext(articles: KnowledgebaseArticle[]) {
  return articles
    .map((article) => {
      const content = article.content.trim().replace(/\s+/g, " ").slice(0, 2600);

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
  if (process.env.AI_FEATURES_ENABLED !== "true") {
    return {
      ok: false,
      error: "AI help is not enabled yet.",
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      error: "AI help is not configured yet.",
    };
  }

  const question = getString(formData, "question");

  if (question.length < 6) {
    return {
      ok: false,
      error: "Ask a little more detail so DanceFlow can find the right guide.",
    };
  }

  const relevantArticles = getRelevantArticles(question);
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
            "You are a helpful DanceFlow support assistant. Answer only from the provided knowledgebase article excerpts. Use plain, practical language for studio owners, organizers, instructors, and dancers. If the articles do not answer the question, say you do not see a guide for that yet and suggest contacting support or reviewing related articles. Do not mention AI, prompts, internal implementation, model names, database details, roadmap phases, or unsupported product claims. Do not provide legal, tax, medical, or financial advice. Keep the answer concise and action-oriented.",
        },
        {
          role: "user",
          content: `Question:\n${question}\n\nRelevant DanceFlow knowledgebase articles:\n${articleContext}\n\nReturn a helpful answer with:\n- A short direct answer\n- Steps if the articles include steps\n- A brief note when support may be needed`,
        },
      ],
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAiResponse;

  if (!response.ok) {
    return {
      ok: false,
      error:
        data.error?.message ??
        "DanceFlow help could not answer that right now. Please try again.",
    };
  }

  const answer = getOutputText(data);

  if (!answer) {
    return {
      ok: false,
      error: "DanceFlow help did not return a readable response.",
    };
  }

  return {
    ok: true,
    answer,
    relatedArticles: relevantArticles.slice(0, 4).map((article) => ({
      title: article.title,
      description: article.description,
      href: `/knowledgebase/${article.slug}`,
      category: article.category,
    })),
  };
}
