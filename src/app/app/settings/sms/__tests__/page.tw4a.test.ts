import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../actions", () => ({ saveSmsSetupAction: vi.fn(), submitSmsSetupAction: vi.fn(), cancelSmsSetupAction: vi.fn() }));

let context: { studioId: string; userId: string; studioRole: string | null };
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => context }));

const rpcCalls: string[] = [];
let statusResult: { data: unknown; error: { code: string } | null };
let draftResult: { data: unknown; error: { code: string } | null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      return fn === "get_studio_sms_status" ? statusResult : draftResult;
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { name: "Harbor Dance", public_name: "Harbor Dance", slug: "harbor-dance", city: "Portland", state: "OR", postal_code: "97201", address_line_1: "12 Harbor Way" },
          }),
        }),
      }),
    }),
  }),
}));

import SmsSettingsPage from "../page";

const STUDIO = "a5700000-0000-4000-8000-00000000000a";
const status = (over: Record<string, unknown> = {}) => ({
  data: { available: true, paused: false, texting_on: false, role: "studio_owner", can_edit: true, can_cancel: true, state: "draft", needs_info_fields: [], submitted_at: null, submission_seq: 0, ...over },
  error: null,
});
const draft = (over: Record<string, unknown> = {}) => ({
  data: { state: "draft", legal_name: "Harbor Dance Studio LLC", ein_last4: "4242", ein_on_file: true, missing: [], updated_at: "2026-10-15T00:00:00Z", ...over },
  error: null,
});
async function render() {
  return renderToStaticMarkup(await SmsSettingsPage());
}

beforeEach(() => {
  redirects.length = 0;
  rpcCalls.length = 0;
  context = { studioId: STUDIO, userId: "u1", studioRole: "studio_owner" };
  statusResult = status();
  draftResult = draft();
});

describe("Settings -> Texting page", () => {
  it("is not available to people who cannot manage settings, and sends them away before any database call", async () => {
    for (const role of ["front_desk", "instructor", "client", null]) {
      context.studioRole = role;
      await expect(render()).rejects.toThrow("NEXT_REDIRECT:/app");
    }
    expect(rpcCalls).toEqual([]);
  });
  it("does not exist while the pilot switch is off and nothing was started, and a database error behaves the same", async () => {
    statusResult = { data: { available: false, texting_on: false }, error: null };
    await expect(render()).rejects.toThrow("NEXT_REDIRECT:/app/settings");
    statusResult = { data: null, error: { code: "42501" } };
    await expect(render()).rejects.toThrow("NEXT_REDIRECT:/app/settings");
    expect(rpcCalls).not.toContain("get_sms_onboarding_draft");
  });
  it("owner with a draft: tracker, editable form with the saved values, and a cancel control; the EIN is only its last four", async () => {
    const html = await render();
    expect(html).toContain("Setup in progress");
    expect(html).toContain("Business identity");
    expect(html).toContain("Save draft");
    expect(html).toContain("Cancel setup");
    expect(html).toContain("On file, ending 4242");
    expect(html).not.toMatch(/\d{2}-\d{7}|ciphertext/i);
    expect(html).not.toContain("paused");
  });
  it("owner who has not started: prefilled form, nothing to cancel", async () => {
    statusResult = status({ state: "not_started", can_cancel: false });
    draftResult = { data: null, error: null };
    const html = await render();
    expect(html).toContain("Business identity");
    expect(html).not.toContain("Cancel setup");
    expect(html).toContain("Harbor Way");
  });
  it("owner after submission: status and the (read-only) summary, can no longer submit or save, but CAN cancel", async () => {
    statusResult = status({ state: "submitted_for_checks", can_edit: false, can_cancel: true, submission_seq: 1 });
    draftResult = draft({ state: "submitted_for_checks" });
    const html = await render();
    expect(html).toContain("Submitted");
    expect(html).not.toContain("Submit for review");
    expect(html).not.toContain("Save draft");
    expect(html).toContain("Cancel setup");
    expect(html).toContain("View the information on file"); // collapsed summary instead of a full read-only form
  });
  it("an editable setup shows the form directly, not behind a disclosure", async () => {
    expect(await render()).not.toContain("View the information on file");
  });
  it("owner once the brand step has started: status only, no cancel (DanceFlow handles it)", async () => {
    statusResult = status({ state: "brand_pending", can_edit: false, can_cancel: false });
    draftResult = draft({ state: "brand_pending" });
    const html = await render();
    expect(html).toContain("Brand review");
    expect(html).not.toContain("Cancel setup");
    expect(html).not.toContain("Save draft");
  });
  it("PAUSED (switch turned off after submission): banner, tracker and cancel remain; the form and the switch-gated draft call are not used", async () => {
    statusResult = status({ paused: true, state: "submitted_for_checks", can_edit: false, can_cancel: true });
    const html = await render();
    expect(html).toContain("Texting setup is paused for your studio");
    expect(html).toContain("You can cancel the setup below");
    expect(html).toContain("Submitted");
    expect(html).toContain("Cancel setup");
    expect(html).not.toContain("Business identity");
    expect(html).not.toContain("Save draft");
    expect(rpcCalls).toEqual(["get_studio_sms_status"]);
  });
  it("paused and past the cancellation window: banner only, no cancel", async () => {
    statusResult = status({ paused: true, state: "campaign_pending", can_edit: false, can_cancel: false });
    const html = await render();
    expect(html).toContain("Texting setup is paused for your studio");
    expect(html).not.toContain("You can cancel the setup below");
    expect(html).not.toContain("Cancel setup");
  });
  it("a studio admin sees the progress read-only, never a form or a cancel control, paused or not", async () => {
    context.studioRole = "studio_admin";
    for (const paused of [false, true]) {
      statusResult = status({ role: "studio_admin", paused, can_edit: false, can_cancel: false, state: "submitted_for_checks" });
      draftResult = draft({ state: "submitted_for_checks" });
      const html = await render();
      expect(html).toContain("Only the studio owner can change this setup");
      expect(html).not.toContain("Cancel setup");
      expect(html).not.toContain("Submit for review");
      expect(html).not.toContain("Save draft");
    }
  });
  it("information needed: the form is editable again so the owner can fix it and resubmit", async () => {
    statusResult = status({ state: "needs_info", needs_info_fields: ["rep_email"], can_edit: true, can_cancel: true });
    draftResult = draft({ state: "needs_info" });
    const html = await render();
    expect(html).toContain("Information needed");
    expect(html).toContain("Save draft");
    expect(html).toContain("Submit for review");
    expect(html).toContain('aria-invalid="true"');
  });
  it("shows texting as on only when the registration is approved", async () => {
    statusResult = status({ texting_on: true, state: "active", can_edit: false, can_cancel: false });
    draftResult = draft({ state: "active" });
    expect(await render()).toContain("Texting is on");
  });
  it("never renders provider vocabulary or identifiers", async () => {
    for (const state of ["draft", "submitted_for_checks", "brand_pending", "exception", "blocked"]) {
      statusResult = status({ state, can_edit: state === "draft" });
      draftResult = draft({ state });
      expect(await render()).not.toMatch(/twilio|trust ?hub|\bTCR\b|10DLC|\bSID\b|BU[0-9a-f]{32}/i);
    }
  });
});
