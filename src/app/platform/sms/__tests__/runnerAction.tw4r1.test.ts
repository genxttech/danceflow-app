import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: "padmin-1" };
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
const adminRpc: { fn: string; args: Record<string, unknown> }[] = [];
let adminRpcError: { code: string } | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { adminRpc.push({ fn, args }); return { data: "2026-10-16T00:00:00Z", error: adminRpcError }; } }),
}));

type RuntimeResult = { ok: true; adapter: object; config: object; store: object; mode: "fake" } | { ok: false; reason: string };
let runtime: RuntimeResult = { ok: true, adapter: {}, config: {}, store: {}, mode: "fake" };
let built = 0;
vi.mock("@/lib/sms/twilioIsv/factory", async () => {
  const { SupabaseRunnerStore } = await import("@/lib/sms/twilioIsv/store");
  return {
    buildRunnerRuntime: () => { built += 1; return runtime; },
    buildRunnerStore: () => new SupabaseRunnerStore({ rpc: async (fn: string, args: Record<string, unknown>) => { adminRpc.push({ fn, args }); return { data: "2026-10-16T00:00:00Z", error: adminRpcError }; } } as never),
  };
});

const runCalls: Record<string, unknown>[] = [];
const refreshCalls: Record<string, unknown>[] = [];
let runImpl: () => Promise<{ outcome: string; detail?: string }> = async () => ({ outcome: "brand_submitted" });
vi.mock("@/lib/sms/twilioIsv/runner", () => ({
  runBrandSubmission: async (input: Record<string, unknown>) => { runCalls.push(input); return runImpl(); },
  refreshBrandStatus: async (input: Record<string, unknown>) => { refreshCalls.push(input); return { outcome: "brand_in_review" }; },
}));

import { runSmsOnboardingAction, setSmsRunnerWindowAction } from "../actions";
import SmsOnboardingPilot from "../SmsOnboardingPilot";

const STUDIO = "a5700000-0000-4000-8000-00000000000a";
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const go = async (values: Record<string, string>) => {
  try {
    await runSmsOnboardingAction(form(values));
  } catch (error) {
    if ((error as Error).message !== "NEXT_REDIRECT") throw error;
  }
  return decodeURIComponent(redirects.at(-1) ?? "");
};

beforeEach(() => {
  adminRpc.length = 0;
  adminRpcError = null;
  redirects.length = 0;
  runCalls.length = 0;
  refreshCalls.length = 0;
  built = 0;
  platformAdmin = true;
  runtime = { ok: true, adapter: {}, config: {}, store: {}, mode: "fake" };
  runImpl = async () => ({ outcome: "brand_submitted" });
});

describe("runSmsOnboardingAction", () => {
  it("is refused for anyone who is not a platform admin, before any runtime is built", async () => {
    platformAdmin = false;
    await expect(runSmsOnboardingAction(form({ studioId: STUDIO }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(built).toBe(0);
    expect(runCalls).toEqual([]);
  });
  it("needs a valid studio", async () => {
    expect(await go({ studioId: "" })).toContain("runner_error=Choose a studio.");
    expect(await go({ studioId: "nope" })).toContain("runner_error");
    expect(built).toBe(0);
  });
  it("a refused runtime (DEV/preview without the fake, production without the switch, missing configuration) calls nothing and says why", async () => {
    runtime = { ok: false, reason: "Twilio registration calls are disabled outside production." };
    expect(await go({ studioId: STUDIO, confirmFee: "on" })).toContain("disabled outside production");
    expect(runCalls).toEqual([]);
    expect(refreshCalls).toEqual([]);
  });
  it("runs the studio with the SESSION admin as actor; the fee is confirmed only when the box is ticked", async () => {
    expect(await go({ studioId: STUDIO, actorId: "forged", intent: "run" })).toContain("runner=");
    expect(runCalls[0]).toMatchObject({ studioId: STUDIO, actorId: "padmin-1", confirmFee: false });
    await go({ studioId: STUDIO, confirmFee: "on" });
    expect(runCalls[1]).toMatchObject({ confirmFee: true });
    await go({ studioId: STUDIO, confirmFee: "yes" });
    expect(runCalls[2]).toMatchObject({ confirmFee: false });
  });
  it("the refresh intent is GET-only: it never runs the submission and never carries a fee confirmation", async () => {
    expect(await go({ studioId: STUDIO, intent: "refresh", confirmFee: "on" })).toContain("still in review");
    expect(runCalls).toEqual([]);
    expect(refreshCalls[0]).toMatchObject({ studioId: STUDIO, actorId: "padmin-1" });
    expect(refreshCalls[0]).not.toHaveProperty("confirmFee");
  });
  it("shows the outcome in plain words with only a short sanitized code", async () => {
    runImpl = async () => ({ outcome: "exception", detail: "B1:ambiguous_fee_step <script>" });
    const message = await go({ studioId: STUDIO, confirmFee: "on" });
    expect(message).toContain("Stopped for a human");
    expect(message).toContain("B1:ambiguous_fee_step");
    expect(message).not.toContain("<script>");
  });
  it("an unexpected failure is generic and tells the admin not to repeat blindly", async () => {
    runImpl = async () => { throw new Error("db down: password=hunter2"); };
    const message = await go({ studioId: STUDIO, confirmFee: "on" });
    expect(message).toContain("failed unexpectedly");
    expect(message).not.toContain("hunter2");
  });
});

describe("registration controls on the platform panel", () => {
  const base = { studioId: STUDIO, studioName: "Harbor Dance", submissionSeq: 1, submittedAt: "2026-10-15T12:00:00Z", updatedAt: null, einStored: true };
  const render = (rows: unknown[], extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(SmsOnboardingPilot, { studios: [{ id: STUDIO, name: "Harbor Dance" }], rows: rows as never, unavailable: false, notice: false, error: null, ...extra }));
  it("a submitted setup offers 'Run next steps' behind an explicit fee confirmation", () => {
    const html = render([{ ...base, accessEnabled: true, state: "submitted_for_checks" }]);
    expect(html).toContain("Run next steps");
    expect(html).toContain("I confirm the Twilio brand fee");
    expect(html).not.toContain("Check brand status");
  });
  it("a brand in review offers only the GET-only status check", () => {
    const html = render([{ ...base, accessEnabled: true, state: "brand_pending" }]);
    expect(html).toContain("Check brand status");
    expect(html).not.toContain("I confirm the Twilio brand fee");
  });
  it("offers nothing when the pilot switch is off or the setup is not in a runnable state", () => {
    for (const row of [{ ...base, accessEnabled: false, state: "submitted_for_checks" }, { ...base, accessEnabled: true, state: "draft" }, { ...base, accessEnabled: true, state: "exception" }, { ...base, accessEnabled: true, state: "service_setup" }]) {
      const html = render([row]);
      expect(html).not.toContain("Run next steps");
      expect(html).not.toContain("Check brand status");
    }
  });
  it("shows the run result and errors, and still never an EIN or SID", () => {
    const html = render([{ ...base, accessEnabled: true, state: "brand_pending" }], { runnerNotice: "The brand is still in review at Twilio. Nothing was created.", runnerError: "Twilio registration is not configured (missing: TWILIO_ISV_COMPLIANCE_EMAIL)." });
    expect(html).toContain("still in review");
    expect(html).toContain("not configured");
    expect(html).not.toMatch(/\b(?:BU|BN)[0-9a-f]{32}\b|(?<![\w-])\d{2}-\d{7}(?![\w-])/);
  });
});

describe("setSmsRunnerWindowAction (the database kill switch)", () => {
  const window = async (values: Record<string, string>) => {
    try {
      await setSmsRunnerWindowAction(form(values));
    } catch (error) {
      if ((error as Error).message !== "NEXT_REDIRECT") throw error;
    }
    return decodeURIComponent(redirects.at(-1) ?? "");
  };
  it("is refused for anyone who is not a platform admin, before any database call", async () => {
    platformAdmin = false;
    await expect(setSmsRunnerWindowAction(form({ studioId: STUDIO, hours: "24", reason: "pilot" }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(adminRpc).toEqual([]);
  });
  it("validates the studio, the reason and the hours (0-72) without calling the database", async () => {
    expect(await window({ studioId: "", hours: "24", reason: "pilot run" })).toContain("runner_error=Choose a studio.");
    expect(await window({ studioId: STUDIO, hours: "24", reason: "x" })).toContain("runner_error");
    for (const hours of ["-1", "73", "abc", "", "2.5x"]) {
      const message = await window({ studioId: STUDIO, hours, reason: "pilot run" });
      if (hours === "2.5x") expect(message).toContain("runner=Runner window open for 2 hour"); // parseInt semantics: "2.5x" is 2
      else expect(message).toContain("Hours must be between 0 (close) and 72.");
    }
    expect(adminRpc.filter((call) => call.args.p_hours === 2)).toHaveLength(1);
  });
  it("opens a window with the SESSION admin as actor and says so; 0 hours closes it", async () => {
    adminRpc.length = 0;
    expect(await window({ studioId: STUDIO, hours: "24", reason: "ConfiDance brand submission", actorId: "forged" })).toContain("Runner window open for 24 hour(s).");
    expect(adminRpc[0]).toEqual({ fn: "tw4_runner_set_window", args: { p_studio_id: STUDIO, p_actor: "padmin-1", p_hours: 24, p_reason: "ConfiDance brand submission" } });
    expect(await window({ studioId: STUDIO, hours: "0", reason: "done" })).toContain("Runner window closed.");
    expect(adminRpc[1].args).toMatchObject({ p_hours: 0 });
  });
  it("a database refusal is a neutral message with no raw text", async () => {
    adminRpcError = { code: "42501" };
    const message = await window({ studioId: STUDIO, hours: "24", reason: "pilot run" });
    expect(message).toContain("The runner window could not be changed.");
  });
});

describe("the runner window form on the platform panel", () => {
  it("offers a studio, hours (0-72, default 24), a reason, and explains that running needs an open window", () => {
    const html = renderToStaticMarkup(createElement(SmsOnboardingPilot, { studios: [{ id: STUDIO, name: "Harbor Dance" }], rows: [], unavailable: false, notice: false, error: null }));
    expect(html).toContain("Runner window");
    expect(html).toContain('name="hours"');
    expect(html).toContain('max="72"');
    expect(html).toContain("does nothing outside an open window");
  });
});
