import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/platform-assurance", async () => (await import("@/lib/auth/__tests__/stepUpDouble")).stepUpDouble());

/**
 * The pilot business's second campaign approval (the first month of the campaign's service fee): command rules, the server action's database reads
 * and the rendered panel. Synthetic names, ids and amounts only.
 */

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieJar = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => cookieJar.set(name, { value }), get: (name: string) => cookieJar.get(name) }) }));
vi.mock("@/lib/auth/platform", () => ({ requirePlatformAdmin: async () => ({ id: "a9000000-0000-4000-8000-000000000401" }) }));
const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let overviewData: unknown = null;
let overviewFails = false;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.push({ fn, args });
      if (fn === "tw4_panel_overview") return overviewFails ? { data: null, error: { code: "08006" } } : { data: overviewData, error: null };
      return { data: { spend_event_id: "x", replayed: false }, error: null };
    },
  }),
}));
vi.mock("@/lib/sms/twilioIsv/factory", () => ({ buildRunnerRuntime: () => ({ ok: false, reason: "off" }) }));

import * as actions from "../panelActions";
import SmsSubaccountPanel from "../SmsSubaccountPanel";
import { buildStudioPanels, parsePanelOverview, type PanelStore } from "@/lib/sms/twilioIsv/panel";
import * as commands from "@/lib/sms/twilioIsv/panelCommands";
import type { FeeContext } from "@/lib/sms/twilioIsv/panelCommands";

const ADMIN = "a9000000-0000-4000-8000-000000000401";
const STUDIO = "a9000000-0000-4000-8000-00000000000a";
const OTHER_STUDIO = "a9000000-0000-4000-8000-00000000000b";
const ENTITY = "e9000000-0000-4000-8000-0000000000e1";
const OTHER_ENTITY = "e9000000-0000-4000-8000-0000000000e2";
const PRICES = { brand: 111, campaign_vetting: 222, monthly: 333, monthly_low_volume: 444, number: 55 };

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const evidence = (over: Record<string, string> = {}) => ({
  authorizedOn: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10), authorizedByRole: "owner_written", scope: "pilot_campaign_fee",
  documentRef: "SYNTH-DOC-0001", documentSha256: "a".repeat(64), ...over,
});
const monthlyFields = (over: Record<string, string> = {}) => ({
  entityId: ENTITY, studioId: STUDIO, kind: "monthly", funding: "pilot", amountCents: "333", approvalRef: "Synthetic written approval, first month", ownerApproved: "on", ...evidence(), ...over,
});

type SpendRow = { kind: string; status?: string; reservation?: string | null; studio?: string | null };
const spendRow = (row: SpendRow, index: number) => ({
  id: `d9000000-0000-4000-8000-0000000000${String(index + 10)}`, kind: row.kind, amount_cents: 1, status: row.status ?? "authorized", funding: "pilot",
  studio_id: row.studio === undefined ? STUDIO : row.studio, approval_ref: `Synthetic approval ${index}`, authorized_at: "2026-10-20T01:00:00Z", reservation_status: row.reservation ?? null,
});
const raw = (options: { pilot?: boolean; tier?: string | null; state?: string; onboarding?: boolean; spend?: SpendRow[] } = {}) => ({
  entities: [{
    id: ENTITY, legal_name: "Synthetic Pilot Dance LLC", ein_last4: "0000", spend_cap_cents: 9999, committed_cents: 0, created_at: "2026-10-20T00:00:00Z",
    account: { status: "active", account_sid: `AC${"b".repeat(32)}` },
    pilot: options.pilot === false ? null : { ceiling_cents: 9999, used_cents: 0, authorized_cents: 0 },
    studios: [{ studio_id: STUDIO, name: "Synthetic Studio", link_kind: "founding", linked_at: "2026-10-20T00:00:00Z", verification_note: "synthetic check" }],
    spend: (options.spend ?? []).map(spendRow),
  }],
  onboardings: options.onboarding === false ? [] : [{
    studio_id: STUDIO, studio_name: "Synthetic Studio", onboarding_id: "b9000000-0000-4000-8000-0000000000b1", state: options.state ?? "service_setup",
    tier: options.tier ?? null, legal_entity_id: ENTITY, brand_status: "approved", b1_status: "succeeded",
  }],
  requests: [], audit: [], prices: PRICES,
});

class Store {
  calls: Record<string, unknown>[] = [];
  async authorizeSpend(input: Record<string, unknown>) {
    this.calls.push(input);
    return { spendEventId: "s1", replayed: false };
  }
}
const run = async (fields: Record<string, string>, context: FeeContext) => {
  const store = new Store();
  const result = await commands.authorizeFee(store as unknown as PanelStore, ADMIN, form(fields), context);
  return { store, result };
};
const standard: FeeContext = { studioTier: null, onboardingFound: true, pilotBusiness: true };
const lowVolume: FeeContext = { studioTier: "low_volume_standard", onboardingFound: true, pilotBusiness: true };

describe("authorizeFee: the monthly campaign fee approval of a pilot business", () => {
  it("records the path's monthly kind, pilot-funded, for one location, with the written-authorization evidence", async () => {
    for (const [context, kind, amountCents] of [[standard, "monthly", "333"], [{ ...standard, studioTier: "standard" }, "monthly", "333"], [lowVolume, "monthly_low_volume", "444"]] as const) {
      const { store, result } = await run(monthlyFields({ kind, amountCents }), context);
      expect(result.ok, result.message).toBe(true);
      expect(result.message).toMatch(/first month of the campaign's service fee.*campaign vetting/);
      expect(store.calls).toHaveLength(1);
      expect(store.calls[0]).toMatchObject({
        entityId: ENTITY, studioId: STUDIO, kind, cents: Number(amountCents), funding: "pilot", actorId: ADMIN,
        evidence: { scope: "pilot_campaign_fee", amountCents: Number(amountCents), periodKey: null },
      });
    }
  });

  const refusals: [string, Record<string, string>, FeeContext, RegExp][] = [
    ["a Low-Volume kind on the Standard path", { kind: "monthly_low_volume" }, standard, /Standard path.*does not apply/],
    ["a Standard kind on the Low-Volume path", { kind: "monthly" }, lowVolume, /Standard-price monthly approval would be wrong/],
    ["an onboarding that was not found", {}, { ...standard, onboardingFound: false }, /path could not be read/],
    ["an onboarding that was never reported", {}, { studioTier: null, pilotBusiness: true }, /path could not be read/],
    ["an unrecognized tier", {}, { ...standard, studioTier: "other" }, /path could not be read/],
    ["a business without a pilot exception", {}, { ...standard, pilotBusiness: false }, /pilot exception.*recurring monthly authorization/],
    ["a context that does not say the business is a pilot", {}, { studioTier: null, onboardingFound: true }, /pilot exception/],
    ["a business without a pilot exception paying from credit", { funding: "credit" }, { ...standard, pilotBusiness: false }, /pilot exception/],
    ["prepaid credit for the pilot business", { funding: "credit" }, standard, /pilot ceiling only/],
    ["missing evidence", { authorizedOn: "", documentRef: "", documentSha256: "" }, standard, /authorization/],
    ["the onboarding-fee evidence scope", { scope: "pilot_onboarding_fee" }, standard, /covers/],
    ["the period-cover evidence scope", { scope: "pilot_period_cover" }, standard, /covers/],
    ["an unconfirmed owner approval", { ownerApproved: "" }, standard, /Confirm the owner approved/],
    ["a short approval reference", { approvalRef: "short" }, standard, /written approval/],
    ["no published price", { amountCents: "" }, standard, /published price/],
  ];
  for (const [name, over, context, text] of refusals) {
    it(`refuses ${name} before any store call`, async () => {
      const { store, result } = await run(monthlyFields(over), context);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(text);
      expect(store.calls).toHaveLength(0);
    });
  }

  it("leaves the other fee kinds as they were: campaign vetting needs no pilot context and may be paid from credit", async () => {
    const { store, result } = await run(monthlyFields({ kind: "campaign_vetting", amountCents: "222", funding: "credit" }), { studioTier: null });
    expect(result.ok, result.message).toBe(true);
    expect(store.calls[0]).toMatchObject({ kind: "campaign_vetting", funding: "credit", evidence: null });
  });
});

describe("panelAuthorizeFeeAction reads the path and the pilot exception from the database", () => {
  beforeEach(() => {
    rpc.length = 0;
    redirects.length = 0;
    cookieJar.clear();
    overviewFails = false;
    overviewData = raw();
  });
  const submit = async (fields: Record<string, string>) => {
    try {
      await actions.panelAuthorizeFeeAction(form(fields));
    } catch (error) {
      if ((error as Error).message !== "NEXT_REDIRECT") throw error;
    }
    return JSON.parse(cookieJar.get("tw4_panel_flash")!.value).message as string;
  };

  it("a pilot location's path-correct monthly approval reaches the definer function", async () => {
    expect(await submit(monthlyFields())).toMatch(/first month of the campaign's service fee/);
    expect(rpc.map((r) => r.fn)).toEqual(["tw4_panel_overview", "tw4_spend_authorize"]);
    expect(rpc[1].args).toMatchObject({ p_kind: "monthly", p_funding: "pilot", p_entity_id: ENTITY, p_studio_id: STUDIO, p_amount_cents: 333, p_evidence_scope: "pilot_campaign_fee" });
  });

  const refused = async (fields: Record<string, string>, text: RegExp) => {
    expect(await submit(fields)).toMatch(text);
    expect(rpc.map((r) => r.fn)).toEqual(["tw4_panel_overview"]);
  };

  it("refuses a business without a pilot exception, whatever the form claims", async () => {
    overviewData = raw({ pilot: false });
    await refused(monthlyFields({ pilot: "on", pilotBusiness: "true" }), /pilot exception/);
  });

  it("refuses a pilot business that the location is not linked to, and an unknown business", async () => {
    await refused(monthlyFields({ studioId: OTHER_STUDIO }), /could not be read/);
    rpc.length = 0;
    await refused(monthlyFields({ entityId: OTHER_ENTITY }), /pilot exception/);
    rpc.length = 0;
    // a second location that has an onboarding but belongs to no business: the pilot exception of another business does not carry over
    const data = raw();
    data.onboardings.push({ ...data.onboardings[0], studio_id: OTHER_STUDIO, onboarding_id: "b9000000-0000-4000-8000-0000000000b2" });
    overviewData = data;
    await refused(monthlyFields({ studioId: OTHER_STUDIO }), /pilot exception/);
  });

  it("refuses the other path's kind from the database tier, not the form's", async () => {
    overviewData = raw({ tier: "low_volume_standard" });
    await refused(monthlyFields({ tier: "standard" }), /Low-Volume Standard/);
  });

  it("refuses when there is no onboarding, or the read fails", async () => {
    overviewData = raw({ onboarding: false });
    await refused(monthlyFields(), /could not be read/);
    rpc.length = 0;
    overviewFails = true;
    await refused(monthlyFields(), /could not be read/);
  });
});

const render = (data: ReturnType<typeof raw>) => {
  const overview = parsePanelOverview(data);
  return renderToStaticMarkup(createElement(SmsSubaccountPanel, { overview, panels: buildStudioPanels(overview), unavailable: false, notice: null, error: null, now: Date.now(), requestKeys: {} }));
};
const feeForm = (html: string, kind: string) => html.split("<form").find((part) => part.includes(`name="kind" value="${kind}"`))?.split("</form>")[0] ?? null;

describe("rendered panel: the monthly approval row", () => {
  it("is offered to a pilot business for its path's kind only, pilot-funded, with the evidence shown and required", () => {
    const html = render(raw());
    const row = feeForm(html, "monthly")!;
    expect(row).toContain("First month of campaign service");
    expect(row).toContain("$3.33");
    expect(row).toContain("Needed in addition to campaign vetting: both approvals must be recorded before the campaign can be submitted.");
    expect(row).toContain("its own retained document");
    expect(row).toContain('value="pilot"');
    expect(row).not.toContain('value="credit"');
    expect(row).not.toContain("<details");
    expect(row).toMatch(/<input[^>]*name="documentSha256"[^>]*required|<input[^>]*required[^>]*name="documentSha256"/);
    expect(row).toContain('value="pilot_campaign_fee"');
    expect(feeForm(html, "monthly_low_volume")).toBeNull();
    // the vetting row keeps both funding choices
    expect(feeForm(html, "campaign_vetting")).toContain('value="credit"');
  });

  it("follows the Low-Volume Standard path", () => {
    const html = render(raw({ tier: "low_volume_standard" }));
    const row = feeForm(html, "monthly_low_volume")!;
    expect(row).toContain("First month of campaign service (Low-Volume Standard)");
    expect(row).toContain("$4.44");
    expect(feeForm(html, "monthly")).toBeNull();
  });

  it("is not offered to a business without a pilot exception, or when the location's path cannot be read", () => {
    for (const data of [raw({ pilot: false }), raw({ onboarding: false })]) {
      const html = render(data);
      expect(feeForm(html, "campaign_vetting")).not.toBeNull();
      expect(feeForm(html, "monthly")).toBeNull();
      expect(feeForm(html, "monthly_low_volume")).toBeNull();
    }
  });

  it("names a recorded monthly approval in plain words", () => {
    expect(render(raw({ spend: [{ kind: "monthly" }] }))).toContain("First month of campaign service $0.01 (pilot ceiling)");
  });
});

describe("next action: the pilot campaign's two approvals", () => {
  const panel = (options: Parameters<typeof raw>[0]) => buildStudioPanels(parsePanelOverview(raw(options)))[0];
  const both = /record the owner's fee approval for campaign vetting and the first month of the campaign's service fee/;

  it("says which approval is missing while the campaign is not yet submitted", () => {
    expect(panel({}).nextAction).toMatch(both);
    const vettingOnly = panel({ spend: [{ kind: "campaign_vetting" }] }).nextAction;
    expect(vettingOnly).toMatch(/approval for the first month of the campaign's service fee \(the campaign needs both approvals\)/);
    expect(vettingOnly).not.toMatch(/campaign vetting/);
    expect(panel({ spend: [{ kind: "monthly" }] }).nextAction).toMatch(/approval for campaign vetting \(/);
  });

  it("is quiet once both are open (or reserved and still held)", () => {
    expect(panel({ spend: [{ kind: "campaign_vetting" }, { kind: "monthly" }] }).blockers).toEqual([]);
    expect(panel({ spend: [{ kind: "campaign_vetting", status: "reserved", reservation: "reserved" }, { kind: "monthly", studio: null }] }).blockers).toEqual([]);
    expect(panel({ tier: "low_volume_standard", spend: [{ kind: "campaign_vetting" }, { kind: "monthly_low_volume" }] }).blockers.join(" ")).not.toMatch(/fee approval for/);
  });

  it("does not count a withdrawn or spent approval, the other path's kind, or another location's approval", () => {
    expect(panel({ spend: [{ kind: "campaign_vetting", status: "void" }, { kind: "monthly", status: "void" }] }).nextAction).toMatch(both);
    expect(panel({ spend: [{ kind: "campaign_vetting", status: "reserved", reservation: "captured" }, { kind: "monthly" }] }).nextAction).toMatch(/approval for campaign vetting \(/);
    expect(panel({ spend: [{ kind: "campaign_vetting" }, { kind: "monthly_low_volume" }] }).nextAction).toMatch(/first month/);
    expect(panel({ spend: [{ kind: "campaign_vetting" }, { kind: "monthly", studio: OTHER_STUDIO }] }).nextAction).toMatch(/first month/);
  });

  it("is not added for a business without a pilot exception or outside the campaign step", () => {
    for (const options of [{ pilot: false }, { state: "brand_pending" }, { state: "campaign_pending" }]) {
      expect(panel(options).blockers.join(" ")).not.toMatch(/fee approval for/);
    }
  });
});
