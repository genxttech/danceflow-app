import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { askKnowledgebaseAssistantAction } from "../ai-actions";

const QUESTION = "What is DanceFlow";
const fetchMock = vi.fn();

function ask() {
  const data = new FormData();
  data.set("question", QUESTION);
  return askKnowledgebaseAssistantAction({ ok: false }, data);
}

describe("public knowledgebase assistant: the model answer is opt-in", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ output_text: "Model answer." }), { status: 200 }));
    // Everything else needed for a provider call is present, so only the opt-in decides.
    vi.stubEnv("AI_FEATURES_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", "false", "TRUE", "1", " true "])(
    "makes no provider call when KB_PUBLIC_ASSISTANT_MODEL_ENABLED is %j, and still returns article links",
    async (value) => {
      vi.stubEnv("KB_PUBLIC_ASSISTANT_MODEL_ENABLED", value);
      const result = await ask();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(result.relatedArticles?.length).toBeGreaterThan(0);
      expect(result.relatedArticles?.[0].href).toMatch(/^\/knowledgebase\//);
    },
  );

  it("when it is exactly \"true\", calls the provider once and returns the model answer as before", async () => {
    vi.stubEnv("KB_PUBLIC_ASSISTANT_MODEL_ENABLED", "true");
    const result = await ask();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(result).toMatchObject({ ok: true, answer: "Model answer." });
    expect(result.relatedArticles?.length).toBeGreaterThan(0);
  });

  it("opting in does not override the global AI switch or a missing key", async () => {
    vi.stubEnv("KB_PUBLIC_ASSISTANT_MODEL_ENABLED", "true");
    vi.stubEnv("AI_FEATURES_ENABLED", "false");
    await ask();
    vi.stubEnv("AI_FEATURES_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", undefined);
    await ask();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
