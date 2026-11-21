import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));
vi.mock("next/server", () => ({ NextResponse: { json: vi.fn(), redirect: vi.fn() } }));

const studioHasFeature = vi.fn();
const getUsageAllowance = vi.fn();
const recordUsageEvent = vi.fn();

vi.mock("@/lib/billing/access", () => ({ studioHasFeature: (...a: unknown[]) => studioHasFeature(...a) }));
vi.mock("@/lib/usage/addons", () => ({
  getUsageAllowance: (...a: unknown[]) => getUsageAllowance(...a),
  getUsageLimitMessage: () => "limit reached",
  recordUsageEvent: (...a: unknown[]) => recordUsageEvent(...a),
}));

import { generateEventDescriptionAssistantAction } from "../events/ai-actions";
import { generateReportInsights } from "../reports/actions";

const fetchMock = vi.fn();
const metrics = { range: "30d", plan: "growth" } as never;

function eventForm() {
  const data = new FormData();
  data.set("eventName", "Spring Social");
  return data;
}

describe("event-description and report-insights actions: authentication, plan, allowance, metering", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output_text: JSON.stringify({ shortDescription: "s", description: "d", titleIdeas: [] }) }), { status: 200 }),
    );
    vi.spyOn(console, "info").mockImplementation(() => {});
    studioHasFeature.mockReset().mockResolvedValue(true);
    getUsageAllowance.mockReset().mockResolvedValue({ allowed: true });
    recordUsageEvent.mockReset().mockResolvedValue({ ok: true });
    process.env.AI_FEATURES_ENABLED = "true";
    process.env.OPENAI_API_KEY = "sk-test-not-real";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.AI_FEATURES_ENABLED;
    delete process.env.OPENAI_API_KEY;
  });

  it("an unauthenticated or non-entitled caller (studioHasFeature false) reaches no provider call", async () => {
    studioHasFeature.mockResolvedValue(false);
    expect(await generateEventDescriptionAssistantAction({ ok: false }, eventForm())).toMatchObject({ ok: false });
    expect(await generateReportInsights(metrics)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordUsageEvent).not.toHaveBeenCalled();
  });

  it("an exhausted allowance reaches no provider call", async () => {
    getUsageAllowance.mockResolvedValue({ allowed: false });
    expect(await generateEventDescriptionAssistantAction({ ok: false }, eventForm())).toMatchObject({ ok: false });
    expect(await generateReportInsights(metrics)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an oversize metrics payload is refused before the provider", async () => {
    const huge = { range: "30d", plan: "growth", blob: "x".repeat(20_000) } as never;
    expect(await generateReportInsights(huge)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a successful call is metered against the studio ai_action allowance with its own source", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ output_text: "Summary\nOK" }), { status: 200 }));
    expect(await generateReportInsights(metrics)).toMatchObject({ ok: true });
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ featureKey: "ai_action", source: "report_ai_insights" }));
  });

  it("a provider failure is not metered and never leaks raw provider text", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "org-SECRET over quota" } }), { status: 500 }));
    const result = await generateReportInsights(metrics);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(recordUsageEvent).not.toHaveBeenCalled();
  });
});
