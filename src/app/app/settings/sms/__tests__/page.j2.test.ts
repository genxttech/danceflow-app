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
let state = "ready_for_activation";
let role = "studio_owner";
let paused = false;
let texting: { data: unknown; error: { code: string } | null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "get_studio_sms_status") return { data: { available: true, paused, texting_on: false, role, can_edit: false, can_cancel: false, state, needs_info_fields: [], submitted_at: "2026-10-15T00:00:00Z", submission_seq: 1 }, error: null };
      if (fn === "get_studio_sms_provisioning") return { data: { available: true, messaging_service: { status: "ready" }, campaign: { status: "approved", rejection_summary: null, checked_at: "2026-10-21T00:00:00Z" } }, error: null };
      if (fn === "get_studio_sms_texting_status") return texting;
      if (fn === "get_sms_onboarding_draft") return { data: { state, legal_name: "Harbor Dance Studio LLC", ein_last4: "4242", ein_on_file: true, missing: [], updated_at: "2026-10-15T00:00:00Z" }, error: null };
      return { data: null, error: { code: "42883" } };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Harbor Dance", public_name: "Harbor Dance", slug: "harbor-dance" } }) }) }) }),
  }),
}));

import SmsSettingsPage from "../page";

const STUDIO = "a5700000-0000-4000-8000-00000000000b";
const status = (over: Record<string, unknown> = {}) => ({
  data: {
    available: true, version: 1,
    number: { status: "secured", display: "***-***-0123", selection: "used" },
    sender: { status: "ready" },
    compliance: { status: "pending" },
    activation: { ready: false, checklist: [{ area: "provider", ok: true }, { area: "compliance", ok: false }] },
    fees: { texting_paused: false, cancellation_in_progress: false, items: [{ kind: "texting_service", current_period: "covered", next_period: "covered", attention: "none" }, { kind: "phone_number", current_period: "not_covered", next_period: "not_covered", attention: "authorization_needed" }] },
    unexpected_resource_review: false,
    ...over,
  },
  error: null,
});
const render = async () => renderToStaticMarkup(await SmsSettingsPage({}));
const calls = () => rpcCalls.filter((c) => c.fn === "get_studio_sms_texting_status");

beforeEach(() => {
  rpcCalls.length = 0;
  context = { studioId: STUDIO, userId: "u1", studioRole: "studio_owner" };
  state = "ready_for_activation";
  role = "studio_owner";
  paused = false;
  texting = status();
});

describe("Settings -> Texting page: owner texting status (J2)", () => {
  it("asks the database with only the studio id", async () => {
    await render();
    expect(calls()).toEqual([{ fn: "get_studio_sms_texting_status", args: { p_studio_id: STUDIO } }]);
  });

  it("number, sender and compliance are driven by the read; the number shows only its last four digits", async () => {
    const html = await render();
    expect(html).toMatch(/data-stage="number" data-status="done"/);
    expect(html).toMatch(/data-stage="sender" data-status="done"/);
    expect(html).toMatch(/data-stage="compliance" data-status="waiting"/);
    expect(html).toContain("ending in 0123");
    expect(html).not.toMatch(/\+1\d{10}|503-?555/);
    expect(html).toContain("DanceFlow still has to confirm opt-out and help handling before texting turns on");
  });

  it("renders service coverage in plain words with no amounts and no buttons", async () => {
    const html = await render();
    const section = html.slice(html.indexOf('data-testid="sms-coverage"'));
    expect(section).toContain("Monthly texting service");
    expect(section).toContain("Texting phone number");
    expect(section).toContain("Not covered yet");
    expect(section).toContain("needs your authorization in Recurring service charges");
    const coverage = section.slice(0, section.indexOf("</section>"));
    expect(coverage).not.toMatch(/\$|cents|<button|<a |<form/);
  });

  it("an unexpected resource is a neutral notice only: no request to authorize, register, adopt or pay, and no coverage row for it", async () => {
    texting = status({ unexpected_resource_review: true, fees: { texting_paused: false, cancellation_in_progress: false, items: [] } });
    const html = await render();
    const coverage = html.slice(html.indexOf('data-testid="sms-coverage"'));
    const notice = coverage.slice(0, coverage.indexOf("</section>"));
    expect(notice).toContain("We are looking into an unexpected texting resource");
    expect(notice).toContain("no action is needed from you");
    expect(notice).not.toMatch(/authoriz|register|adopt|\bpay|add funds|\$|<button|<a /i);
    expect(notice).not.toContain("data-coverage=");
  });

  it("nothing to report: no coverage section", async () => {
    texting = status({ fees: { texting_paused: false, cancellation_in_progress: false, items: [] } });
    expect(await render()).not.toContain('data-testid="sms-coverage"');
  });

  it("a refusal, a missing function or an unexpected answer leaves number, sender and compliance 'not available yet' and shows no coverage", async () => {
    for (const result of [{ data: null, error: { code: "42501" } }, { data: null, error: { code: "42883" } }, { data: { available: false }, error: null }, status({ sender: { status: "sorta" } })]) {
      texting = result;
      const html = await render();
      for (const key of ["number", "sender", "compliance"]) expect(html).toMatch(new RegExp(`data-stage="${key}" data-status="unavailable"`));
      expect(html).not.toContain('data-testid="sms-coverage"');
    }
  });

  it("is not requested for a non-owner manager or when the setup is paused", async () => {
    role = "studio_admin";
    context.studioRole = "studio_admin";
    await render();
    expect(calls()).toHaveLength(0);
    role = "studio_owner";
    context.studioRole = "studio_owner";
    paused = true;
    await render();
    expect(calls()).toHaveLength(0);
  });
});
