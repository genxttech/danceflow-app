import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => vi.fn());
const rateKey = vi.hoisted(() => vi.fn(async (scope: string, parts: unknown[]) => `${scope}:${parts.join(",")}`));

vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: context }));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getServerActionRateLimitKey: rateKey,
  rateLimitErrorMessage: () => "limited",
}));

import { generateEventDescriptionAssistantAction } from "../events/ai-actions";
import { generateReportInsights, type ReportInsightsMetrics } from "../reports/actions";

const fetchMock = vi.fn();
const describeEvent = () => generateEventDescriptionAssistantAction({ ok: false }, new FormData());
const insights = () => generateReportInsights({ range: "30d", plan: "pro" } as unknown as ReportInsightsMetrics);

describe("studio AI actions require a signed-in studio member", () => {
  beforeEach(() => {
    context.mockReset();
    rateKey.mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ output_text: "{}" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("AI_FEATURES_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ["event description", describeEvent],
    ["report insights", insights],
  ])("%s: no provider call when the caller is not a studio member", async (_name, run) => {
    context.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(run()).rejects.toThrow("NEXT_REDIRECT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["event description", describeEvent, "ai:event-description"],
    ["report insights", insights, "ai:report-insights"],
  ])("%s: a studio member reaches the provider, limited per user", async (_name, run, scope) => {
    context.mockResolvedValue({ userId: "user-1" });
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rateKey).toHaveBeenCalledWith(scope, ["user-1"]);
  });
});
