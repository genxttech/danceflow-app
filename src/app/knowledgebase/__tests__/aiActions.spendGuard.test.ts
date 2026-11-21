import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let ip = "203.0.113.1";
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": ip }) }));
vi.mock("next/server", () => ({ NextResponse: { json: vi.fn(), redirect: vi.fn() } }));

import { askKnowledgebaseAssistantAction } from "../ai-actions";

const fetchMock = vi.fn();
const QUESTION = "What is DanceFlow";

function form(question: string) {
  const data = new FormData();
  data.set("question", question);
  return data;
}

const initial = { ok: false } as never;

describe("public knowledgebase assistant spend guard", () => {
  beforeEach(() => {
    ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ output_text: "Model answer." }), { status: 200 }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.AI_FEATURES_ENABLED = "true";
    process.env.OPENAI_API_KEY = "sk-test-not-real";
    delete process.env.AI_DISABLED_FEATURES;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.AI_FEATURES_ENABLED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_DISABLED_FEATURES;
  });

  it("answers with the model today (behaviour preserved) with a timeout and store:false", async () => {
    const result = await askKnowledgebaseAssistantAction(initial, form(QUESTION));
    expect(result).toMatchObject({ ok: true, answer: "Model answer." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body).store).toBe(false);
  });

  it("rejects an over-length question before any scoring or provider call", async () => {
    const result = await askKnowledgebaseAssistantAction(initial, form("a".repeat(301)));
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a very large question cannot reach the provider", async () => {
    const result = await askKnowledgebaseAssistantAction(initial, form("dance ".repeat(100_000)));
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes no provider call when AI is off, and still returns article links", async () => {
    process.env.AI_FEATURES_ENABLED = "false";
    const result = await askKnowledgebaseAssistantAction(initial, form(QUESTION));
    expect(result).toMatchObject({ ok: true });
    expect((result as { relatedArticles?: unknown[] }).relatedArticles?.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the per-feature kill switch (AI_DISABLED_FEATURES=kb_public) falls back to links with no provider call", async () => {
    process.env.AI_DISABLED_FEATURES = "kb_public";
    const result = await askKnowledgebaseAssistantAction(initial, form(QUESTION));
    expect(result).toMatchObject({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("per-IP rate limit: after 5 model calls in a minute the next one gets links only and no provider call", async () => {
    for (let i = 0; i < 5; i += 1) await askKnowledgebaseAssistantAction(initial, form(QUESTION));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const sixth = await askKnowledgebaseAssistantAction(initial, form(QUESTION));
    expect(sixth).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("a provider error or timeout degrades to links, never an exception and never raw provider text", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "org-SECRET quota" } }), { status: 429 }));
    const error = await askKnowledgebaseAssistantAction(initial, form(QUESTION));
    expect(error).toMatchObject({ ok: true });
    expect(JSON.stringify(error)).not.toContain("SECRET");

    const timeout = new Error("timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    await expect(askKnowledgebaseAssistantAction(initial, form(QUESTION))).resolves.toMatchObject({ ok: true });
  });
});
