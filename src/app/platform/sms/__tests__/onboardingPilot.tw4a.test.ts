import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/platform-assurance", async () => (await import("@/lib/auth/__tests__/stepUpDouble")).stepUpDouble());

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: "padmin" };
  },
}));
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcError: { code: string; message: string } | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { rpcCalls.push({ fn, args }); return { data: null, error: rpcError }; } }),
}));

import { setSmsOnboardingAccessAction } from "../actions";
import SmsOnboardingPilot from "../SmsOnboardingPilot";

const STUDIO = "a5700000-0000-4000-8000-00000000000a";
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const run = async (values: Record<string, string>) => {
  try {
    await setSmsOnboardingAccessAction(form(values));
  } catch (error) {
    if ((error as Error).message !== "NEXT_REDIRECT") throw error;
  }
  return redirects.at(-1) ?? "";
};

beforeEach(() => {
  redirects.length = 0;
  rpcCalls.length = 0;
  rpcError = null;
  platformAdmin = true;
});

describe("pilot access action", () => {
  it("is refused for anyone who is not a platform admin, before any database call", async () => {
    platformAdmin = false;
    await expect(setSmsOnboardingAccessAction(form({ studioId: STUDIO, reason: "pilot", enabled: "on" }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(rpcCalls).toEqual([]);
  });
  it("validates the studio and the reason without calling the database", async () => {
    expect(await run({ studioId: "", reason: "pilot reason", enabled: "on" })).toContain("pilot_error");
    expect(await run({ studioId: "not-a-uuid", reason: "pilot reason", enabled: "on" })).toContain("pilot_error");
    expect(await run({ studioId: STUDIO, reason: "x", enabled: "on" })).toContain("pilot_error");
    expect(rpcCalls).toEqual([]);
  });
  it("switches access on and off through the RPC with the reason, and reports success", async () => {
    expect(await run({ studioId: STUDIO, reason: "ConfiDance pilot", enabled: "on" })).toContain("pilot=saved");
    expect(await run({ studioId: STUDIO, reason: "paused for review" })).toContain("pilot=saved");
    expect(rpcCalls).toEqual([
      { fn: "set_sms_onboarding_access", args: { p_studio_id: STUDIO, p_enabled: true, p_reason: "ConfiDance pilot" } },
      { fn: "set_sms_onboarding_access", args: { p_studio_id: STUDIO, p_enabled: false, p_reason: "paused for review" } },
    ]);
  });
  it("a database refusal comes back as a neutral message, never raw text", async () => {
    rpcError = { code: "42501", message: "raw: not authorized for relation studio_sms_onboarding_access" };
    const url = await run({ studioId: STUDIO, reason: "ConfiDance pilot", enabled: "on" });
    expect(url).toContain("pilot_error");
    expect(decodeURIComponent(url)).not.toMatch(/relation|studio_sms_onboarding_access/);
  });
});

describe("pilot panel", () => {
  const studios = [{ id: STUDIO, name: "Harbor Dance" }];
  it("lists studios with pilot access and setup state, never an EIN or any personal field", () => {
    const html = renderToStaticMarkup(
      createElement(SmsOnboardingPilot, {
        studios,
        rows: [{ studioId: STUDIO, studioName: "Harbor Dance", accessEnabled: true, state: "submitted_for_checks", submissionSeq: 1, submittedAt: "2026-10-15T12:00:00Z", updatedAt: null, einStored: true }],
        unavailable: false,
        notice: false,
        error: null,
      }),
    );
    expect(html).toContain("Harbor Dance");
    expect(html).toContain("Submitted");
    expect(html).toContain("Pilot access");
    expect(html).toContain("Nothing here contacts Twilio");
    expect(html).not.toMatch(/(?<![\w-])\d{2}-\d{7}(?![\w-])/);
    expect(html).not.toContain("@");
  });
  it("explains itself when the tables are not available in this environment yet and offers no form", () => {
    const html = renderToStaticMarkup(createElement(SmsOnboardingPilot, { studios, rows: [], unavailable: true, notice: false, error: null }));
    expect(html).toContain("not available in this environment yet");
    expect(html).not.toContain("<form");
  });
  it("shows success and error banners", () => {
    const html = renderToStaticMarkup(createElement(SmsOnboardingPilot, { studios, rows: [], unavailable: false, notice: true, error: "The pilot switch could not be changed." }));
    expect(html).toContain("Saved.");
    expect(html).toContain("The pilot switch could not be changed.");
  });
});
