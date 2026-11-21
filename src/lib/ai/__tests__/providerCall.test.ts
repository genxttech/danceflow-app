import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ NextResponse: { json: vi.fn(), redirect: vi.fn() } }));

import {
  AI_SAFE_MESSAGES,
  HARD_MAX_INPUT_CHARS,
  HARD_MAX_OUTPUT_TOKENS,
  callOpenAiResponses,
  isAiFeatureEnabled,
  type AiCallOptions,
} from "../providerCall";

const base: AiCallOptions = {
  feature: "lumi_plan",
  model: "gpt-4.1-mini",
  temperature: 0.3,
  maxOutputTokens: 500,
  input: [
    { role: "system", content: "s" },
    { role: "user", content: "hello" },
  ],
};

function okResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("callOpenAiResponses (shared provider-call wrapper)", () => {
  const fetchMock = vi.fn();
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.AI_FEATURES_ENABLED = "true";
    process.env.OPENAI_API_KEY = "sk-test-not-real";
    delete process.env.AI_DISABLED_FEATURES;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    infoSpy.mockRestore();
    delete process.env.AI_FEATURES_ENABLED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_DISABLED_FEATURES;
  });

  function logged() {
    return infoSpy.mock.calls.map((call) => JSON.parse(String(call[0])));
  }

  it("fails closed without calling the provider when the master flag is not exactly true", async () => {
    for (const value of [undefined, "", "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.AI_FEATURES_ENABLED;
      else process.env.AI_FEATURES_ENABLED = value;
      const result = await callOpenAiResponses(base);
      expect(result).toEqual({ ok: false, reason: "disabled", message: AI_SAFE_MESSAGES.disabled });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed without calling the provider when the key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await callOpenAiResponses(base);
    expect(result).toMatchObject({ ok: false, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours the per-feature deny switch without affecting other features", async () => {
    process.env.AI_DISABLED_FEATURES = " kb_public , report_insights ";
    expect(isAiFeatureEnabled("kb_public")).toBe(false);
    expect(isAiFeatureEnabled("lumi_plan")).toBe(true);
    expect(await callOpenAiResponses({ ...base, feature: "kb_public" })).toMatchObject({ ok: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(okResponse({ output_text: "fine" }));
    expect(await callOpenAiResponses(base)).toMatchObject({ ok: true, text: "fine" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversize input before any provider call, and never exceeds the hard ceiling", async () => {
    const big = { role: "user" as const, content: "x".repeat(5001) };
    expect(await callOpenAiResponses({ ...base, input: [big], maxInputChars: 5000 })).toMatchObject({ ok: false, reason: "input_too_large" });
    const huge = { role: "user" as const, content: "x".repeat(HARD_MAX_INPUT_CHARS + 1) };
    expect(await callOpenAiResponses({ ...base, input: [huge], maxInputChars: 10_000_000 })).toMatchObject({ ok: false, reason: "input_too_large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clamps output tokens to the hard ceiling, sets store:false and a timeout signal", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ output_text: "ok" }));
    await callOpenAiResponses({ ...base, maxOutputTokens: 50_000 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body);
    expect(body.max_output_tokens).toBe(HARD_MAX_OUTPUT_TOKENS);
    expect(body.store).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("never returns raw provider error text to the caller", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ error: { message: "You exceeded your current quota for org-SECRET, model gpt-x" } }, 429),
    );
    const result = await callOpenAiResponses(base);
    expect(result).toEqual({ ok: false, reason: "provider_error", message: AI_SAFE_MESSAGES.provider_error });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(logged())).not.toContain("SECRET");
  });

  it("maps a hung provider (abort/timeout) to a timeout result", async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(error);
    expect(await callOpenAiResponses(base)).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("maps a network failure to provider_error and an empty body to empty_output", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await callOpenAiResponses(base)).toMatchObject({ ok: false, reason: "provider_error" });
    fetchMock.mockResolvedValueOnce(okResponse({ output: [] }));
    expect(await callOpenAiResponses(base)).toMatchObject({ ok: false, reason: "empty_output" });
  });

  it("reads output_text or nested output content and reports provider token usage", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ output: [{ content: [{ text: "a" }, { text: "b" }] }], usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 64 } } }),
    );
    const result = await callOpenAiResponses(base);
    expect(result).toMatchObject({ ok: true, text: "a\nb", usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 64 } });
  });

  it("writes one accounting line per attempt with no prompt text or identifiers", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ output_text: "RESPONSE-BODY", usage: { input_tokens: 10, output_tokens: 5 } }));
    await callOpenAiResponses({ ...base, input: [{ role: "user", content: "PROMPT-BODY" }] });
    await callOpenAiResponses({ ...base, input: [{ role: "user", content: "x".repeat(HARD_MAX_INPUT_CHARS + 5) }] });
    const lines = logged();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: "ai_provider_call", feature: "lumi_plan", outcome: "ok", inputTokens: 10, outputTokens: 5 });
    expect(lines[1]).toMatchObject({ outcome: "input_too_large" });
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("PROMPT-BODY");
    expect(raw).not.toContain("RESPONSE-BODY");
    expect(raw).not.toContain("sk-test");
  });

  it("applies a best-effort feature budget and refuses the over-budget call without calling the provider", async () => {
    fetchMock.mockImplementation(async () => okResponse({ output_text: "ok" }));
    const options = { ...base, feature: "event_description" as const, budget: { limit: 2, windowMs: 60_000 } };
    expect(await callOpenAiResponses(options)).toMatchObject({ ok: true });
    expect(await callOpenAiResponses(options)).toMatchObject({ ok: true });
    expect(await callOpenAiResponses(options)).toMatchObject({ ok: false, reason: "budget_exceeded" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry: one attempt produces exactly one provider request", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ error: { message: "x" } }, 500));
    await callOpenAiResponses(base);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hardens against non-string content and NaN output caps", async () => {
    const bad = { role: "user", content: 42 } as unknown as { role: "user"; content: string };
    expect(await callOpenAiResponses({ ...base, input: [bad] })).toMatchObject({ ok: false, reason: "input_too_large" });
    fetchMock.mockResolvedValueOnce(okResponse({ output_text: "ok" }));
    await callOpenAiResponses({ ...base, maxOutputTokens: Number.NaN });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_output_tokens).toBe(HARD_MAX_OUTPUT_TOKENS);
  });
});
