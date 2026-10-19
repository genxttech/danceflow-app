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

const SUB = `AC${"7".repeat(32)}`;
let entity: Record<string, unknown> = { legal_entity_id: "ent-1", account_status: "active", account_sid: SUB };
const adapterRequests: string[] = [];
const okRuntime = () => ({ ok: true as const, adapter: undefined, config: {}, store: {}, mode: "fake" as const, entities: { entityForStudio: async () => entity }, adapterFor: async (sid: string) => { adapterRequests.push(sid); return { accountSid: sid }; } });
type RuntimeResult = ReturnType<typeof okRuntime> | { ok: false; reason: string };
let runtime: RuntimeResult = okRuntime();
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
  checkRegistrationStatus: async (input: Record<string, unknown>) => { refreshCalls.push(input); return { outcome: "brand_in_review" }; },
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
  runtime = okRuntime();
  entity = { legal_entity_id: "ent-1", account_status: "active", account_sid: SUB };
  adapterRequests.length = 0;
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
    expect(html).toContain("Check status"); // the read-only status check sits beside it
  });
  it("a brand in review offers only the GET-only status check", () => {
    const html = render([{ ...base, accessEnabled: true, state: "brand_pending" }]);
    expect(html).toContain("Check status");
    expect(html).not.toContain("I confirm the Twilio brand fee");
  });
  it("offers nothing when the pilot switch is off or the setup is not in a runnable state", () => {
    for (const row of [{ ...base, accessEnabled: false, state: "submitted_for_checks" }, { ...base, accessEnabled: true, state: "draft" }, { ...base, accessEnabled: true, state: "exception" }, { ...base, accessEnabled: true, state: "service_setup" }]) {
      const html = render([row]);
      expect(html).not.toContain("Run next steps");
      expect(html).not.toContain("Check status");
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

describe("TW-4F-1: the run action passes explicit submission confirmations only", () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, "info").mockImplementation((line: unknown) => { logs.push(String(line)); });
  });
  const confirmations = () => (runCalls[0]?.confirmSubmit ?? null) as string[] | null;

  it("without any submission box nothing is confirmed", async () => {
    await go({ studioId: STUDIO, confirmFee: "on" });
    expect(runCalls).toHaveLength(1);
    expect(confirmations()).toEqual([]);
    expect(runCalls[0].confirmFee).toBe(true);
    expect(logs).toEqual([]);
  });
  it("the fee confirmation does not confirm any submission", async () => {
    await go({ studioId: STUDIO, confirmFee: "on", submitPhrase: "SUBMIT" });
    expect(confirmations()).toEqual([]);
  });
  it("each box confirms only its own submission, and the trail records who and which", async () => {
    await go({ studioId: STUDIO, confirmSubmitProfile: "on", submitPhrase: "SUBMIT" });
    expect(confirmations()).toEqual(["S11"]);
    expect(JSON.parse(logs[0])).toEqual({ event: "sms_runner_submission_requested", studioId: STUDIO, actorId: "padmin-1", steps: ["S11"] });
    expect(JSON.parse(logs[1])).toEqual({ event: "sms_runner_submission_result", studioId: STUDIO, actorId: "padmin-1", requested: ["S11"], submitted: [], outcome: "brand_submitted" });
    runCalls.length = 0;
    await go({ studioId: STUDIO, confirmSubmitTrustProduct: "on", submitPhrase: "SUBMIT" });
    expect(confirmations()).toEqual(["T6"]);
    runCalls.length = 0;
    await go({ studioId: STUDIO, confirmSubmitProfile: "on", confirmSubmitTrustProduct: "on", submitPhrase: "SUBMIT" });
    expect(confirmations()).toEqual(["S11", "T6"]);
  });
  it.each([[""], ["submit"], ["Submit"], ["SUBMIT NOW"], ["YES"]])("a ticked submission with the phrase %j runs nothing and builds no runtime", async (phrase) => {
    const message = await go({ studioId: STUDIO, confirmSubmitProfile: "on", submitPhrase: phrase });
    expect(message).toContain("type SUBMIT exactly");
    expect(runCalls).toHaveLength(0);
    expect(built).toBe(0);
    expect(logs).toEqual([]);
  });
  it("surrounding spaces around the phrase are tolerated, nothing else", async () => {
    await go({ studioId: STUDIO, confirmSubmitProfile: "on", submitPhrase: "  SUBMIT " });
    expect(confirmations()).toEqual(["S11"]);
  });
  it("the typed phrase alone confirms nothing", async () => {
    await go({ studioId: STUDIO, submitPhrase: "SUBMIT" });
    expect(confirmations()).toEqual([]);
  });
  it("a status check ignores submission boxes entirely", async () => {
    await go({ studioId: STUDIO, intent: "refresh", confirmSubmitProfile: "on", confirmSubmitTrustProduct: "on", submitPhrase: "SUBMIT" });
    expect(refreshCalls).toHaveLength(1);
    expect(runCalls).toHaveLength(0);
    expect(logs).toEqual([]);
  });
  it("a platform-admin refusal still happens first", async () => {
    platformAdmin = false;
    await expect(runSmsOnboardingAction(form({ studioId: STUDIO, confirmSubmitProfile: "on", submitPhrase: "SUBMIT" }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(runCalls).toHaveLength(0);
  });
  it("the result trail says what was actually submitted, not just what was requested", async () => {
    runImpl = async () => ({ outcome: "waiting_submission_confirmation", detail: "T6", stepsRun: ["S11", "T1"] } as never);
    await go({ studioId: STUDIO, confirmSubmitProfile: "on", confirmSubmitTrustProduct: "on", submitPhrase: "SUBMIT" });
    expect(JSON.parse(logs[1])).toMatchObject({ event: "sms_runner_submission_result", requested: ["S11", "T6"], submitted: ["S11"], outcome: "waiting_submission_confirmation" });
  });
  it("the waiting outcome is explained in plain words", async () => {
    runImpl = async () => ({ outcome: "waiting_submission_confirmation", detail: "S11" });
    const message = await go({ studioId: STUDIO });
    expect(message).toContain("irreversible submission");
    expect(message).toContain("type SUBMIT");
    expect(message).toContain("Nothing was submitted");
    expect(message).toContain("the evaluation passed");
  });
});

describe("TW-4F-1: the platform panel shows the irreversible-submission confirmations", () => {
  const html = renderToStaticMarkup(createElement(SmsOnboardingPilot, {
    studios: [{ id: STUDIO, name: "Harbor Dance" }],
    rows: [{ studioId: STUDIO, studioName: "Harbor Dance", submissionSeq: 1, submittedAt: "2026-10-15T12:00:00Z", updatedAt: null, einStored: true, accessEnabled: true, state: "submitted_for_checks" }] as never,
    unavailable: false, notice: false, error: null,
  }));
  it("offers a separate unticked box for each submission and a typed phrase", () => {
    expect(html).toContain('name="confirmSubmitProfile"');
    expect(html).toContain('name="confirmSubmitTrustProduct"');
    expect(html).toContain('name="submitPhrase"');
    expect(html).toContain("Irreversible submissions");
    expect(html).not.toMatch(/name="confirmSubmit(Profile|TrustProduct)"[^>]*checked/);
  });
  it("keeps the fee confirmation separate", () => {
    expect(html).toContain('name="confirmFee"');
  });
  it("a brand already in review offers none of the submission controls", () => {
    const review = renderToStaticMarkup(createElement(SmsOnboardingPilot, {
      studios: [{ id: STUDIO, name: "Harbor Dance" }],
      rows: [{ studioId: STUDIO, studioName: "Harbor Dance", submissionSeq: 1, submittedAt: null, updatedAt: null, einStored: false, accessEnabled: true, state: "brand_pending" }] as never,
      unavailable: false, notice: false, error: null,
    }));
    expect(review).not.toContain("confirmSubmitProfile");
  });
});

describe("TW-4F-3a (D2): the run action only ever uses the studio's own Twilio subaccount", () => {
  it("builds the adapter for the subaccount recorded for the studio's legal entity", async () => {
    await go({ studioId: STUDIO });
    expect(adapterRequests).toEqual([SUB]);
    expect(runCalls).toHaveLength(1);
    expect((runCalls[0].adapter as { accountSid: string }).accountSid).toBe(SUB);
  });
  it("without a legal entity or an active subaccount nothing is built or run, for both intents", async () => {
    for (const shape of [{ legal_entity_id: null }, { legal_entity_id: "ent-1", account_status: null, account_sid: null }, { legal_entity_id: "ent-1", account_status: "creating", account_sid: null }, { legal_entity_id: "ent-1", account_status: "unknown", account_sid: SUB }]) {
      entity = shape;
      for (const intent of ["run", "refresh"]) {
        runCalls.length = 0;
        refreshCalls.length = 0;
        const message = await go({ studioId: STUDIO, intent, confirmFee: "on" });
        expect(message).toMatch(/no Twilio subaccount yet/i);
        expect(adapterRequests).toEqual([]);
        expect(runCalls).toHaveLength(0);
        expect(refreshCalls).toHaveLength(0);
      }
    }
  });
  it("a failing account lookup runs nothing", async () => {
    runtime = { ...okRuntime(), entities: { entityForStudio: async () => { throw new Error("db down"); } } };
    const message = await go({ studioId: STUDIO });
    expect(message).toMatch(/could not be looked up/i);
    expect(runCalls).toHaveLength(0);
  });
});
