import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/platform-assurance", async () => (await import("@/lib/auth/__tests__/stepUpDouble")).stepUpDouble());

/** TW-4F platform-admin panel: server actions (authorization, wiring, the tier read for fee approvals) and the rendered panel. */

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieJar = new Map<string, { value: string; options: Record<string, unknown> }>();
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string, options: Record<string, unknown>) => cookieJar.set(name, { value, options }), get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)!.value } : undefined) }) }));
let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: "a6000000-0000-4000-8000-000000000401" };
  },
}));
const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let overviewData: unknown = { entities: [], requests: [], onboardings: [], audit: [], prices: {} };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.push({ fn, args });
      if (fn === "tw4_panel_overview") return { data: overviewData, error: null };
      return { data: { spend_event_id: "x", replayed: false, changed: true, legal_entity_id: "e" }, error: null };
    },
  }),
}));
let runtimeOk = false;
vi.mock("@/lib/sms/twilioIsv/factory", () => ({
  buildRunnerRuntime: () => (runtimeOk ? { ok: true, entities: {}, parent: {}, config: { envName: "test" } } : { ok: false, reason: "Twilio registration calls are disabled outside production." }),
}));

import * as actions from "../panelActions";
import SmsSubaccountPanel from "../SmsSubaccountPanel";
import { buildStudioPanels, parsePanelOverview } from "@/lib/sms/twilioIsv/panel";

const STUDIO = "a6000000-0000-4000-8000-00000000000a";
const ENTITY = "e6000000-0000-4000-8000-0000000000e1";
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const go = async (action: (f: FormData) => Promise<unknown>, values: Record<string, string>) => {
  try {
    await action(form(values));
  } catch (error) {
    if ((error as Error).message !== "NEXT_REDIRECT") throw error;
  }
  const flash = cookieJar.get("tw4_panel_flash");
  return `${decodeURIComponent(redirects.at(-1) ?? "")} ${flash ? JSON.parse(flash.value).message : ""}`;
};

beforeEach(() => {
  platformAdmin = true;
  runtimeOk = false;
  rpc.length = 0;
  redirects.length = 0;
  cookieJar.clear();
  overviewData = { entities: [], requests: [], onboardings: [], audit: [], prices: {} };
});

describe("panel server actions", () => {
  const all = [
    actions.panelCreateEntityAction, actions.panelDecideLinkAction, actions.panelSetSpendCapAction, actions.panelAuthorizeFeeAction,
    actions.panelWithdrawFeeAction, actions.panelCreatePilotExceptionAction, actions.panelCreateSubaccountAction, actions.panelDecideTierAction,
  ];

  it("a non-admin is stopped before any database call by every action", async () => {
    platformAdmin = false;
    for (const action of all) await expect(action(form({ entityId: ENTITY, studioId: STUDIO }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(rpc).toHaveLength(0);
  });

  it("a valid budget change reaches the definer function with the server-side admin id (never one from the form)", async () => {
    const url = await go(actions.panelSetSpendCapAction, { entityId: ENTITY, capDollars: "150", confirmCap: "150", actor: "attacker" });
    expect(url).toMatch(/panel=1/);
    expect(url).toMatch(/Setup budget set to \$150\.00/);
    expect(rpc).toEqual([{ fn: "tw4_entity_set_spend_cap", args: { p_entity_id: ENTITY, p_cents: 15000, p_actor: "a6000000-0000-4000-8000-000000000401" } }]);
  });

  it("the fee approval reads the location's tier from the database: a forged form cannot get a Standard brand approval for a Low-Volume Standard location", async () => {
    overviewData = { entities: [], requests: [], onboardings: [{ studio_id: STUDIO, onboarding_id: "b6000000-0000-4000-8000-0000000000b1", state: "submitted_for_checks", tier: "low_volume_standard" }], audit: [], prices: {} };
    const url = await go(actions.panelAuthorizeFeeAction, { entityId: ENTITY, studioId: STUDIO, kind: "brand", funding: "credit", amountCents: "4600", approvalRef: "Owner email 2026-10-20 approving", ownerApproved: "on", tier: "standard" });
    expect(url).toMatch(/panel_error=1.*Low-Volume Standard/);
    expect(rpc.map((r) => r.fn)).toEqual(["tw4_panel_overview"]);
  });

  it("Create subaccount: refused when this deployment cannot create, BEFORE any confirmation is recorded", async () => {
    const url = await go(actions.panelCreateSubaccountAction, { studioId: STUDIO, requestKey: "c6000000-0000-4000-8000-0000000000c1", phrase: "CREATE SUBACCOUNT" });
    expect(url).toMatch(/panel_error=1.*disabled outside production\. Nothing was created/);
    expect(rpc).toHaveLength(0);
  });

  it("the result text travels only in a short-lived httpOnly same-site cookie, never in the URL; the acted-on studio reopens", async () => {
    await go(actions.panelSetSpendCapAction, { entityId: ENTITY, studioId: STUDIO, capDollars: "150", confirmCap: "150" });
    expect(redirects.at(-1)).toBe(`/platform/sms?panel=1&studio=${STUDIO}#subaccount-panel`);
    expect(cookieJar.get("tw4_panel_flash")!.options).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/platform/sms", maxAge: 60 });
    await go(actions.panelSetSpendCapAction, { entityId: ENTITY, studioId: "not-a-uuid", capDollars: "150", confirmCap: "150" });
    expect(redirects.at(-1)).toBe("/platform/sms?panel=1#subaccount-panel");
  });

  it("the result banner is bounded and lands on the panel", async () => {
    const url = await go(actions.panelDecideTierAction, { studioId: STUDIO, tier: "standard", reason: "Pilot default (D3) for this studio" });
    expect(redirects.at(-1)).toMatch(/#subaccount-panel$/);
    expect(url).toMatch(/Registration path set to Standard/);
  });
});

describe("rendered panel", () => {
  const overview = parsePanelOverview({
    entities: [{
      id: ENTITY, legal_name: "ConfiDance Unlimited, LLC", ein_last4: "1234", spend_cap_cents: 15000, committed_cents: 4600, created_at: "2026-10-20T00:00:00Z",
      account: { status: "active", account_sid: `AC${"a".repeat(32)}` }, pilot: { ceiling_cents: 15000, used_cents: 0, authorized_cents: 4600 },
      studios: [{ studio_id: STUDIO, name: "ConfiDance Studio", link_kind: "founding", linked_at: "2026-10-20T00:00:00Z", verification_note: "Oregon SOS checked" }],
      spend: [{ id: "d6000000-0000-4000-8000-0000000000d1", kind: "brand", amount_cents: 4600, status: "authorized", funding: "pilot", studio_id: STUDIO, approval_ref: "Owner email 2026-10-20", authorized_at: "2026-10-20T01:00:00Z" }],
    }],
    onboardings: [{ studio_id: STUDIO, studio_name: "ConfiDance Studio", onboarding_id: "b6000000-0000-4000-8000-0000000000b1", state: "submitted_for_checks", tier: null, legal_entity_id: ENTITY }],
    requests: [], audit: [{ studio_id: STUDIO, action: "spend_authorized", note: "entity=x;kind=brand", at: "2026-10-20T01:00:00Z", actor_type: "platform_admin" }],
    prices: { brand: 4600 },
  });
  const html = renderToStaticMarkup(createElement(SmsSubaccountPanel, { overview, panels: buildStudioPanels(overview), unavailable: false, notice: null, error: null, now: Date.now(), requestKeys: { [STUDIO]: "c6000000-0000-4000-8000-0000000000c1" } }));

  it("shows the pilot ceiling, the owner approval, the next action and the four state words; no full SID", () => {
    expect(html).toContain("ConfiDance pilot: $150 non-spendable ceiling");
    expect(html).toContain("$46.00 approved but not yet reserved");
    expect(html).toContain("Owner email 2026-10-20");
    expect(html).toContain('data-testid="next-action"');
    for (const word of ["Configured", "Approved", "Submitted", "Active"]) expect(html).toContain(word);
    expect(html).not.toContain("a".repeat(32));
    expect(html).toContain("Owner fee approval recorded");
  });

  it("offers no Create subaccount form for an active account, and a one-time key for one that is not", () => {
    expect(html).not.toContain("Create subaccount</button>");
    const fresh = parsePanelOverview({ ...overview, entities: [{ id: ENTITY, legal_name: "Synthetic LLC", ein_last4: "1234", spend_cap_cents: 15000, studios: [{ studio_id: STUDIO, name: "S" }] }], onboardings: [] });
    const freshHtml = renderToStaticMarkup(createElement(SmsSubaccountPanel, { overview: fresh, panels: buildStudioPanels(fresh), unavailable: false, notice: null, error: null, now: Date.now(), requestKeys: { [STUDIO]: "c6000000-0000-4000-8000-0000000000c1" } }));
    expect(freshHtml).toContain("Create subaccount</button>");
    expect(freshHtml).toMatch(/name="requestKey" value="[0-9a-f-]{36}"/);
  });

  it("renders a safe notice when the data is unavailable", () => {
    const out = renderToStaticMarkup(createElement(SmsSubaccountPanel, { overview: null, panels: [], unavailable: true, notice: null, error: "<script>x</script>", now: Date.now() }));
    expect(out).toContain("not available in this environment");
    expect(out).not.toContain("<script>x</script>");
  });
});
