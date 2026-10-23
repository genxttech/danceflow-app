import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); } }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../actions", () => ({ saveSmsSetupAction: vi.fn(), submitSmsSetupAction: vi.fn(), cancelSmsSetupAction: vi.fn() }));
vi.mock("../numberActions", () => ({ approveNumberAction: vi.fn(), withdrawNumberAction: vi.fn() }));

let context: { studioId: string; userId: string; studioRole: string | null };
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => context }));

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let role = "studio_owner";
let offers: { data: unknown; error: { code: string } | null };
const OFFER = "0f0f0000-0000-4000-8000-000000000001";
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "get_studio_sms_status") return { data: { available: true, paused: false, texting_on: false, role, can_edit: false, can_cancel: false, state: "campaign_pending", needs_info_fields: [], submitted_at: "2026-10-15T00:00:00Z", submission_seq: 1 }, error: null };
      if (fn === "get_studio_sms_provisioning") return { data: { available: true, messaging_service: { status: "ready" }, campaign: { status: "approved", rejection_summary: null, checked_at: "2026-10-21T00:00:00Z" } }, error: null };
      if (fn === "get_studio_sms_texting_status") return { data: { available: true, version: 1, number: { status: "options_available", display: null, selection: "none" }, sender: { status: "not_ready" }, compliance: { status: "pending" }, activation: null, fees: { texting_paused: false, cancellation_in_progress: false, items: [] }, unexpected_resource_review: false }, error: null };
      if (fn === "get_studio_sms_number_offers") return offers;
      if (fn === "get_sms_onboarding_draft") return { data: { state: "campaign_pending", legal_name: "Harbor Dance Studio LLC", ein_last4: "4242", ein_on_file: true, missing: [], updated_at: "2026-10-15T00:00:00Z" }, error: null };
      return { data: null, error: { code: "42883" } };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Harbor Dance", public_name: "Harbor Dance", slug: "harbor-dance" } }) }) }) }),
  }),
}));

import SmsSettingsPage from "../page";

const STUDIO = "a5700000-0000-4000-8000-00000000000c";
const read = (over: Record<string, unknown> = {}) => ({
  data: { available: true, version: 1, step_open: true, price: { published: true, monthly_cents: 115 }, funding_mode: "credit_recurring", pilot_ceiling_reached: false,
    offer: { offer_id: OFFER, expires_at: "2026-10-23T12:00:00Z", numbers: [{ e164: "+15035550101", locality: null, region: null }] }, approval: null, blocker: "none", ...over },
  error: null,
});
const render = async () => renderToStaticMarkup(await SmsSettingsPage({}));

beforeEach(() => {
  rpcCalls.length = 0;
  context = { studioId: STUDIO, userId: "u1", studioRole: "studio_owner" };
  role = "studio_owner";
  offers = read();
});

describe("Settings -> Texting page: owner number choice (J3)", () => {
  it("reads the offers with only the studio id, shows the choice and links the journey's next step to it", async () => {
    const html = await render();
    expect(rpcCalls.filter((c) => c.fn === "get_studio_sms_number_offers")).toEqual([{ fn: "get_studio_sms_number_offers", args: { p_studio_id: STUDIO } }]);
    expect(html).toContain('data-testid="sms-number-selection"');
    // the number stage is the owner's turn (the call to action itself is covered in ownerRead.j3 where the earlier stages are complete)
    expect(html).toMatch(/data-stage="number" data-status="current"/);
  });
  it("no choice and no link when the read is refused, missing or the step is not open", async () => {
    for (const o of [{ data: null, error: { code: "42501" } }, { data: null, error: { code: "42883" } }, read({ step_open: false, blocker: "not_open", offer: null })]) {
      offers = o;
      const html = await render();
      expect(html).not.toContain('data-testid="sms-number-selection"');
      expect(html).not.toContain('href="#sms-number"');
    }
  });
  it("an open approval stays withdrawable after the step closed", async () => {
    offers = read({ step_open: false, blocker: "not_open", offer: null, approval: { selection_id: "0f0f0000-0000-4000-8000-000000000002", e164: "+15035550101", status: "open", expires_at: "2026-10-24T00:00:00Z", statement: "x" } });
    expect(await render()).toContain('data-testid="sms-number-withdraw"');
  });
  it("is not requested for a non-owner manager", async () => {
    role = "studio_admin";
    context.studioRole = "studio_admin";
    const html = await render();
    expect(rpcCalls.filter((c) => c.fn === "get_studio_sms_number_offers")).toHaveLength(0);
    expect(html).not.toContain('data-testid="sms-number-selection"');
  });
});
