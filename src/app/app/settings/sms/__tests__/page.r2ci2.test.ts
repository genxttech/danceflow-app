import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); } }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../actions", () => ({ saveSmsSetupAction: vi.fn(), submitSmsSetupAction: vi.fn(), cancelSmsSetupAction: vi.fn() }));

let context: { studioId: string; userId: string; studioRole: string | null };
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => context }));

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let state = "campaign_pending";
let role = "studio_owner";
let provisioning: { data: unknown; error: { code: string } | null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "get_studio_sms_status") return { data: { available: true, paused: false, texting_on: false, role, can_edit: false, can_cancel: false, state, needs_info_fields: [], submitted_at: "2026-10-15T00:00:00Z", submission_seq: 1 }, error: null };
      if (fn === "get_studio_sms_provisioning") return provisioning;
      if (fn === "get_sms_onboarding_draft") return { data: { state, legal_name: "Harbor Dance Studio LLC", ein_last4: "4242", ein_on_file: true, missing: [], updated_at: "2026-10-15T00:00:00Z" }, error: null };
      return { data: null, error: { code: "42883" } };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Harbor Dance", public_name: "Harbor Dance", slug: "harbor-dance" } }) }) }) }),
  }),
}));

import SmsSettingsPage from "../page";

const STUDIO = "a5700000-0000-4000-8000-00000000000a";
const read = (campaign: Record<string, unknown>, service = "ready") => ({ data: { available: true, messaging_service: { status: service }, campaign }, error: null });
const render = async () => renderToStaticMarkup(await SmsSettingsPage({}));
const provCalls = () => rpcCalls.filter((c) => c.fn === "get_studio_sms_provisioning");

beforeEach(() => {
  rpcCalls.length = 0;
  context = { studioId: STUDIO, userId: "u1", studioRole: "studio_owner" };
  state = "campaign_pending";
  role = "studio_owner";
  provisioning = read({ status: "pending", rejection_summary: null, checked_at: null });
});

describe("Settings -> Texting page: owner-safe provisioning read (R2c-I2)", () => {
  it("asks the database with only the studio id (the caller is derived from the session, no actor argument)", async () => {
    await render();
    expect(provCalls()).toHaveLength(1);
    expect(provCalls()[0].args).toEqual({ p_studio_id: STUDIO });
  });

  it("pending: shown as carrier review, never approved; number/sender/compliance stay unavailable", async () => {
    const html = await render();
    expect(html).toContain("under carrier review");
    expect(html).not.toContain("approved by the carriers");
    for (const key of ["number", "sender", "compliance"]) expect(html).toMatch(new RegExp(`data-stage="${key}" data-status="unavailable"`));
  });

  it("approved campaign does not complete the journey: number stays unavailable and activation is not done", async () => {
    provisioning = read({ status: "approved", rejection_summary: null, checked_at: "2026-10-21T00:00:00Z" });
    const html = await render();
    expect(html).toContain("approved by the carriers");
    expect(html).toMatch(/data-stage="number" data-status="unavailable"/);
    expect(html).not.toMatch(/data-stage="activation" data-status="done"/);
    expect(html).not.toContain("Texting is on");
  });

  it("rejected: shows the sanitized reason and no action", async () => {
    state = "exception";
    provisioning = read({ status: "rejected", rejection_summary: "Opt-in flow not described", checked_at: null });
    const html = await render();
    expect(html).toContain("did not approve your campaign");
    expect(html).toContain("Opt-in flow not described");
    expect(html).not.toContain("sms-next-cta");
  });

  it("an unsafe or unexpected answer is dropped (fail closed): identifiers in the summary are scrubbed, unknown statuses show nothing", async () => {
    state = "exception";
    provisioning = read({ status: "rejected", rejection_summary: `see QE${"a".repeat(32)} at https://x.test and a@b.co call 5035550123`, checked_at: null });
    const html = await render();
    expect(html).not.toMatch(/QE[0-9a-f]{32}|https:\/\/x\.test|a@b\.co|5035550123/);
    provisioning = read({ status: "totally_approved", rejection_summary: null });
    state = "campaign_pending";
    const unknown = await render();
    expect(unknown).not.toContain("approved by the carriers");
    expect(unknown).toMatch(/data-stage="number" data-status="unavailable"/);
  });

  it("a database refusal, a missing function or an unavailable answer behaves like no data, without breaking the page", async () => {
    for (const result of [{ data: null, error: { code: "42501" } }, { data: null, error: { code: "42883" } }, { data: { available: false }, error: null }]) {
      provisioning = result;
      const html = await render();
      expect(html).toContain("sms-journey");
      expect(html).not.toContain("approved by the carriers");
    }
  });

  it("is not requested for a non-owner manager (they only follow progress) or when the setup is paused", async () => {
    role = "studio_admin";
    context.studioRole = "studio_admin";
    await render();
    expect(provCalls()).toHaveLength(0);
  });

  it("never reaches the database for people who cannot manage settings", async () => {
    for (const r of ["front_desk", "instructor", "client", null]) {
      context.studioRole = r;
      await expect(render()).rejects.toThrow("NEXT_REDIRECT:/app");
    }
    expect(provCalls()).toHaveLength(0);
  });
});
