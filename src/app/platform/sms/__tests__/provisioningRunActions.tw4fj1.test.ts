import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/platform-assurance", async () => (await import("@/lib/auth/__tests__/stepUpDouble")).stepUpDouble());

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieSets: { name: string; value: string; options: Record<string, unknown> }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string, options: Record<string, unknown>) => cookieSets.push({ name, value, options }), get: () => undefined }) }));
let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: "padmin-1" };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: { code: "XX000" } }) }) }));
let built = 0;
vi.mock("@/lib/sms/twilioIsv/factory", () => ({
  buildProvisioningRuntime: () => { built += 1; return { ok: false, reason: "Twilio provisioning calls are switched off." }; },
  buildNumberRuntime: () => { built += 1; return { ok: false, reason: "Twilio number purchase calls are switched off." }; },
}));

import { runNumberStepAction, runProvisioningStepAction } from "../provisioningRunActions";
import ProvisioningSummary from "../ProvisioningSummary";
import { PROV_FLASH_COOKIE } from "@/lib/sms/provisioning/provisionFlash";
import { readPanelFlash } from "@/lib/sms/twilioIsv/panelFlash";
import { runControls, buildAdminProvisioningView, describeNumberOutcome, describeProvisioningOutcome, type AdminProvisioningInput } from "@/lib/sms/provisioning/adminView";

const STUDIO = "a5700000-0000-4000-8000-00000000000a";
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const go = async (action: (f: FormData) => Promise<void>, values: Record<string, string>) => {
  try {
    await action(form(values));
  } catch (error) {
    if ((error as Error).message !== "NEXT_REDIRECT") throw error;
  }
};

beforeEach(() => {
  redirects.length = 0;
  cookieSets.length = 0;
  platformAdmin = true;
  built = 0;
});

describe("TW-4F J1 provisioning run actions", () => {
  it("a non-admin cannot invoke any action: nothing is built, no cookie is set, no redirect is issued", async () => {
    platformAdmin = false;
    const cases: [typeof runProvisioningStepAction, Record<string, string>][] = [
      [runProvisioningStepAction, { studioId: STUDIO, intent: "service" }],
      [runProvisioningStepAction, { studioId: STUDIO, intent: "campaign", confirmFee: "on", confirmPhrase: "SUBMIT" }],
      [runProvisioningStepAction, { studioId: STUDIO, intent: "refresh" }],
      [runNumberStepAction, { studioId: STUDIO, intent: "offer" }],
      [runNumberStepAction, { studioId: STUDIO, intent: "acquire", confirmFee: "on", approvedE164: "+12025550140" }],
      [runNumberStepAction, { studioId: STUDIO, intent: "refresh" }],
    ];
    for (const [action, values] of cases) await expect(action(form(values))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(built).toBe(0);
    expect(cookieSets).toHaveLength(0);
    expect(redirects).toHaveLength(0);
  });

  it("with the switches off the admin gets the gate's reason in the httpOnly flash cookie (never the URL) and lands on the studio's controls", async () => {
    await go(runProvisioningStepAction, { studioId: STUDIO, intent: "service" });
    expect(built).toBe(1);
    expect(redirects.at(-1)).toBe(`/platform/sms?prov_error=1#prov-run-${STUDIO}`);
    expect(redirects.at(-1)).not.toMatch(/switched/);
    const cookie = cookieSets.at(-1)!;
    expect(cookie.name).toBe(PROV_FLASH_COOKIE);
    expect(cookie.options).toMatchObject({ httpOnly: true, path: "/platform/sms" });
    expect(readPanelFlash(cookie.value, { panel: null, panelError: "1" }).error).toMatch(/provisioning calls are switched off\. Nothing was run\./);

    await go(runNumberStepAction, { studioId: STUDIO, intent: "offer" });
    expect(readPanelFlash(cookieSets.at(-1)!.value, { panel: null, panelError: "1" }).error).toMatch(/number purchase calls are switched off/);
  });

  it("a forged studio id is refused without building anything and without an anchor", async () => {
    await go(runNumberStepAction, { studioId: "x' or 1=1", intent: "offer" });
    expect(built).toBe(0);
    expect(redirects.at(-1)).toBe("/platform/sms?prov_error=1");
  });

  it("an unconfirmed fee-bearing request is refused before any runtime is built", async () => {
    await go(runProvisioningStepAction, { studioId: STUDIO, intent: "campaign", confirmFee: "on" });
    await go(runNumberStepAction, { studioId: STUDIO, intent: "acquire", approvedE164: "+12025550140" });
    expect(built).toBe(0);
  });
});

const base: AdminProvisioningInput = { studioId: STUDIO, state: "service_setup", accessEnabled: true, evidence: undefined, sender: null, operations: [] };
const render = (over: Partial<AdminProvisioningInput>) => renderToStaticMarkup(createElement(ProvisioningSummary, { ...base, ...over }));

describe("TW-4F J1 provisioning summary controls", () => {
  it("service setup: Messaging Service, the confirmed campaign form and a status check; the next action links to them", () => {
    const html = render({});
    for (const id of ["prov-run-controls", "prov-run-service", "prov-run-campaign-form", "prov-run-campaign-confirm", "prov-run-campaign-phrase", "prov-run-campaign", "prov-run-refresh"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain(`id="prov-run-${STUDIO}"`);
    expect(html).not.toContain("num-run-");
    expect(html).not.toContain("Check status"); // the R1 row's own button text stays unique to the R1 row
    expect(buildAdminProvisioningView(base).next).toMatchObject({ kind: "act", href: `#prov-run-${STUDIO}` });
    expect(html).not.toMatch(/checked/); // no confirmation is pre-ticked
  });

  it("campaign pending: only status checks while under review; once verified, number offers and the confirmed purchase form, as the next action", () => {
    const pending = render({ state: "campaign_pending" });
    expect(pending).toContain('data-testid="prov-run-refresh"');
    expect(pending).toContain('data-testid="num-run-refresh"');
    expect(pending).not.toContain('data-testid="num-run-offer"');
    expect(pending).not.toContain('data-testid="num-run-acquire"');
    const verifiedOps = [{ id: "o1", kind: "campaign", status: "succeeded", feeBearing: true, attemptedAt: null, errorCode: null, resource: { status: "verified", mismatchCode: null, providerStatus: "VERIFIED", failureReasons: null, observedAt: null, source: "fake" } }];
    const html = render({ state: "campaign_pending", operations: verifiedOps });
    for (const id of ["num-run-offer", "num-run-area-code", "num-run-acquire-form", "num-run-acquire-confirm", "num-run-acquire-e164", "num-run-acquire", "num-run-refresh", "prov-run-refresh"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).not.toContain('data-testid="prov-run-campaign"');
    expect(buildAdminProvisioningView({ ...base, state: "campaign_pending", operations: verifiedOps }).next.title).toMatch(/Offer numbers/);
  });

  it("an unknown outcome, an unreadable ledger or an unrecognized status hides every control that could start a provider operation", () => {
    const unknown = [{ id: "o1", kind: "campaign", status: "unknown_outcome", feeBearing: true, attemptedAt: null, errorCode: null }];
    expect(runControls({ ...base, operations: unknown })).toEqual({ provisioning: ["refresh"], numbers: [] });
    expect(runControls({ ...base, ledgerUnreadable: true, operations: null })).toEqual({ provisioning: ["refresh"], numbers: [] });
    expect(runControls({ ...base, state: "campaign_pending", operations: [{ ...unknown[0], status: "weird" }] })).toEqual({ provisioning: ["refresh"], numbers: ["refresh"] });
    const html = render({ operations: unknown });
    expect(html).not.toContain("prov-run-campaign");
    expect(html).not.toContain("prov-run-service");
  });

  it("no controls with pilot access off or outside the provisioning states", () => {
    expect(render({ accessEnabled: false })).not.toContain("prov-run-controls");
    for (const state of ["draft", "submitted_for_checks", "brand_pending", "exception", "blocked", "cancelled"]) expect(render({ state })).not.toContain("prov-run-controls");
    expect(runControls({ ...base, state: "ready_for_activation" })).toEqual({ provisioning: ["refresh"], numbers: ["refresh"] });
  });

  it("outcome texts: only real progress reads as success, and unknown outcomes never do", () => {
    expect(describeProvisioningOutcome("campaign_submitted").ok).toBe(true);
    for (const o of ["unknown_outcome", "exception", "record_failed", "waiting_fee_confirmation", "insufficient_credit", "made_up"]) expect(describeProvisioningOutcome(o).ok).toBe(false);
    expect(describeNumberOutcome("number_ready").ok).toBe(true);
    for (const o of ["unknown_outcome", "no_selection", "selection_mismatch", "exception", "made_up"]) expect(describeNumberOutcome(o).ok).toBe(false);
    expect(describeNumberOutcome("exception", "<script>x</script>").message).not.toContain("<");
  });
});
