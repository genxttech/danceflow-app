import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ NextResponse: { json: vi.fn(), redirect: vi.fn() } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getServerActionRateLimitKey: async () => "k",
  rateLimitErrorMessage: () => "slow down",
}));

const usage = vi.hoisted(() => ({
  getLumiUsageSnapshot: vi.fn(),
  lumiRefusalMessage: vi.fn(() => "refused"),
  releaseLumiUsage: vi.fn(),
  reserveLumiUsage: vi.fn(),
  settleLumiUsage: vi.fn(),
}));
vi.mock("@/lib/lumi/usage", () => usage);

const state = vi.hoisted(() => ({ queryThrows: false }));
function chain(): unknown {
  const api: Record<string, unknown> = {};
  for (const name of ["select", "eq", "in", "is", "order", "limit"]) api[name] = () => api;
  api.then = (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
    (state.queryThrows ? Promise.reject(new Error("db down")) : Promise.resolve({ data: [] })).then(resolve, reject);
  return api;
}
vi.mock("@/lib/lumi/portal", () => ({
  resolveLumiPortalAccess: async () => ({
    allowed: true,
    admin: { from: () => chain() },
    studio: { id: "studio-1", slug: "s", name: "S" },
    client: { id: "client-1", first_name: "Zelda", last_name: "Quimby" },
  }),
}));

import { generateLumiPlanAction } from "../actions";

const fetchMock = vi.fn();
const run = () => {
  const data = new FormData();
  data.set("studioSlug", "s");
  data.set("task", "weekly_plan");
  return generateLumiPlanAction({ ok: false }, data);
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("LUMI plan action: which outcomes stay counted", () => {
  beforeEach(() => {
    state.queryThrows = false;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    usage.getLumiUsageSnapshot.mockReset().mockResolvedValue({ allowed: true });
    usage.reserveLumiUsage.mockReset().mockResolvedValue({ ok: true, id: "r1" });
    usage.releaseLumiUsage.mockReset();
    usage.settleLumiUsage.mockReset();
    process.env.AI_FEATURES_ENABLED = "true";
    process.env.OPENAI_API_KEY = "sk-test-not-real";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.AI_FEATURES_ENABLED;
    delete process.env.OPENAI_API_KEY;
  });

  const expectSettled = () => {
    expect(usage.settleLumiUsage).toHaveBeenCalledTimes(1);
    expect(usage.releaseLumiUsage).not.toHaveBeenCalled();
  };
  const expectReleased = () => {
    expect(usage.releaseLumiUsage).toHaveBeenCalledTimes(1);
    expect(usage.settleLumiUsage).not.toHaveBeenCalled();
  };

  it("settles a successful call", async () => {
    fetchMock.mockResolvedValueOnce(reply({ output_text: JSON.stringify({ headline: "h" }) }));
    expect(await run()).toMatchObject({ ok: true });
    expectSettled();
    expect(String(fetchMock.mock.calls[0][1].body)).not.toMatch(/Zelda|Quimby/);
  });

  it("settles an answer that cannot be parsed", async () => {
    fetchMock.mockResolvedValueOnce(reply({ output_text: "not json" }));
    expect(await run()).toMatchObject({ ok: false });
    expectSettled();
  });

  it("settles a timeout and an empty answer (possibly billed)", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(await run()).toMatchObject({ ok: false });
    expectSettled();
    usage.settleLumiUsage.mockReset();
    fetchMock.mockResolvedValueOnce(reply({ output: [] }));
    expect(await run()).toMatchObject({ ok: false });
    expectSettled();
  });

  it("never releases a billable call when recording the settlement itself fails", async () => {
    usage.settleLumiUsage.mockRejectedValue(new Error("db down"));
    fetchMock.mockResolvedValueOnce(reply({ output_text: JSON.stringify({ headline: "h" }) }));
    expect(await run()).toMatchObject({ ok: false });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(await run()).toMatchObject({ ok: false });
    expect(usage.releaseLumiUsage).not.toHaveBeenCalled();
  });

  it("releases a call the provider rejected", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: { message: "x" } }, 429));
    expect(await run()).toMatchObject({ ok: false });
    expectReleased();
  });

  it("releases when a context query throws before the provider call", async () => {
    state.queryThrows = true;
    expect(await run()).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expectReleased();
  });

  it("makes no provider call when the reservation is refused", async () => {
    usage.reserveLumiUsage.mockResolvedValue({ ok: false, reason: "dancer_daily" });
    expect(await run()).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
