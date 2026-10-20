import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** TW-4F UI follow-up: Texting settings links an unlinked location's OWNER to the location-attestation page; nobody else, never a linked location. */

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: unknown; className?: string }) => createElement("a", { href, className }, children as never) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../actions", () => ({ saveSmsSetupAction: vi.fn(), submitSmsSetupAction: vi.fn(), cancelSmsSetupAction: vi.fn() }));
vi.mock("../location/actions", () => ({ attestLocationAction: vi.fn() }));

let context: { studioId: string; userId: string; studioRole: string | null };
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => context }));

const STUDIO = "a5800000-0000-4000-8000-00000000000a";
const rpcCalls: { fn: string; args: unknown }[] = [];
let statusData: Record<string, unknown>;
/** sms_credit_overview: undefined = not installed (error), otherwise its data */
let creditOverview: Record<string, unknown> | undefined;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "get_studio_sms_status") return { data: statusData, error: null };
      if (fn === "sms_credit_overview") return creditOverview ? { data: creditOverview, error: null } : { data: null, error: { code: "42883" } };
      if (fn.startsWith("sms_credit") || fn === "sms_price_list" || fn.startsWith("sms_recurring") || fn === "sms_monthly_limit_overview") return { data: null, error: { code: "42883" } };
      return { data: { state: "submitted_for_checks", legal_name: "Harbor Dance Studio LLC", ein_last4: "4242", ein_on_file: true, missing: [] }, error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Harbor Dance", slug: "harbor-dance" } }) }) }) }),
  }),
}));

import SmsSettingsPage from "../page";
import SmsLocationAttestationPage from "../location/page";

const status = (over: Record<string, unknown> = {}) => ({
  available: true, paused: false, texting_on: false, role: "studio_owner", can_edit: true, can_cancel: true, state: "draft", needs_info_fields: [], submitted_at: null, submission_seq: 0, ...over,
});
const render = async () => renderToStaticMarkup(await SmsSettingsPage({}));
const LINK = 'href="/app/settings/sms/location"';

beforeEach(() => {
  redirects.length = 0;
  rpcCalls.length = 0;
  context = { studioId: STUDIO, userId: "u1", studioRole: "studio_owner" };
  statusData = status();
  creditOverview = undefined;
});

describe("Texting settings: link to the location attestation", () => {
  it("offers the owner of an unlinked location one click to the attestation page", async () => {
    creditOverview = { legal_business: false };
    const html = await render();
    expect(html).toContain('data-testid="sms-location-link"');
    expect(html).toContain(LINK);
    expect(html).toContain("Link this location");
    // the owner's own studio only: every read is for the signed-in studio
    for (const call of rpcCalls) if (call.args && typeof call.args === "object" && "p_studio_id" in call.args) expect((call.args as { p_studio_id: string }).p_studio_id).toBe(STUDIO);
  });

  it("still offers it when the credit read is not installed in this environment (the attestation page and database re-check)", async () => {
    creditOverview = undefined;
    expect(await render()).toContain(LINK);
  });

  it("hides it once the location belongs to a legal business", async () => {
    creditOverview = { legal_business: true, balance_cents: 0, reserved_cents: 0, available_cents: 0 };
    const html = await render();
    expect(html).not.toContain(LINK);
    expect(html).not.toContain('data-testid="sms-location-link"');
  });

  it("hides it from a studio administrator (only the owner can attest)", async () => {
    context = { studioId: STUDIO, userId: "u2", studioRole: "studio_admin" };
    statusData = status({ role: "studio_admin", can_edit: false, can_cancel: false });
    creditOverview = { legal_business: false };
    expect(await render()).not.toContain(LINK);
  });

  it("hides it while the texting setup is paused", async () => {
    statusData = status({ paused: true, state: "submitted_for_checks" });
    creditOverview = { legal_business: false };
    expect(await render()).not.toContain(LINK);
  });

  it("front desk never reaches the page (redirected before any link renders)", async () => {
    context = { studioId: STUDIO, userId: "u3", studioRole: "front_desk" };
    await expect(render()).rejects.toThrow("NEXT_REDIRECT:/app");
    expect(redirects).toEqual(["/app"]);
  });

  it("gives the read-only 'information on file' disclosure a chevron that turns when it opens", async () => {
    statusData = status({ state: "submitted_for_checks", can_edit: false });
    creditOverview = { legal_business: false };
    const html = await render();
    const onFile = html.slice(html.indexOf("group/onfile"), html.indexOf("View the information on file"));
    expect(onFile).toContain("<svg");
    expect(onFile).toContain("group-open/onfile:rotate-180");
  });
});

describe("location attestation page: the destination", () => {
  it("renders for the owner with a way back to Texting", async () => {
    const html = renderToStaticMarkup(await SmsLocationAttestationPage({}));
    expect(html).toContain('href="/app/settings/sms"');
    expect(html).toContain("Add this location to your existing business");
  });

  it("sends a non-owner back to Texting", async () => {
    statusData = status({ role: "studio_admin" });
    await expect(SmsLocationAttestationPage({})).rejects.toThrow("NEXT_REDIRECT:/app/settings/sms");
  });

  it("never shows URL text: an unknown result code renders no message", async () => {
    const html = renderToStaticMarkup(await SmsLocationAttestationPage({ searchParams: Promise.resolve({ result: "<script>x</script>" }) }));
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain('role="alert"');
  });
});
