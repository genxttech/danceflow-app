import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/** Page wiring: the platform SMS page mounts the activation controls once, with the session's administrator, its own usage reads and its own result values. */

vi.mock("server-only", () => ({}));
const ADMIN = "a6000000-0000-4000-8000-00000000c0c0";
vi.mock("@/lib/auth/platform", () => ({ requirePlatformAdmin: async () => ({ id: ADMIN }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: vi.fn() }) }));
const chain = () => {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "order", "eq"]) q[m] = () => q;
  q.limit = async () => ({ data: [], error: null });
  return q;
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => chain(), rpc: async () => ({ data: [], error: null }) }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));
vi.mock("@/lib/billing/smsCreditView", () => ({ getAdminCreditOverview: async () => null }));
vi.mock("@/lib/billing/smsRecurring", () => ({ getRecurringAdminOverview: async () => null }));
vi.mock("@/lib/billing/smsPanelMonthlyLimits", () => ({ loadPanelMonthlyLimits: async () => null }));
const USAGE = { switchOn: false, usageGaps: 0, inboundGaps: 0, marker: "controls-usage" };
const READINESS = { ok: false, detail: "stale", lastSuccessAt: null };
vi.mock("@/lib/sms/usageReconcileView", () => ({ loadReconcileOverview: async () => USAGE }));
vi.mock("@/lib/sms/usageReconcilerReadiness", () => ({ loadReconcilerReadiness: async () => READINESS }));
const ROWS = [{ studioId: "f0000001-0000-4000-8000-00000000c0c0", studioName: "Synthetic Location", state: null, accessEnabled: false }];
vi.mock("@/lib/sms/onboarding/client", () => ({ listOnboardings: async () => ROWS }));
vi.mock("@/lib/sms/twilioIsv/factory", () => ({ buildRunnerStore: () => ({ status: async () => null }) }));
vi.mock("@/lib/sms/provisioning/provisionLedger", () => ({ loadLedgers: async () => ({}), ProvisioningLedgerStore: class {} }));
vi.mock("@/lib/sms/twilioIsv/panel", () => ({ SupabasePanelStore: class { async overview() { return { entities: [], onboardings: [] }; } }, buildStudioPanels: () => [] }));
vi.mock("@/lib/sms/senderVerification", async (orig) => ({ ...(await orig<typeof import("@/lib/sms/senderVerification")>()), loadSenderOverview: async () => [], loadSenderHealth: async () => null }));

vi.mock("../ActivationControlsPanel", () => ({ default: function ActivationControlsPanel() { return null; } }));
vi.mock("../ActivationPanel", () => ({ default: function ActivationPanel() { return null; } }));
vi.mock("../RecoveryPanel", () => ({ default: function RecoveryPanel() { return null; } }));
vi.mock("../SmsSubaccountPanel", () => ({ default: function SmsSubaccountPanel() { return null; } }));
vi.mock("../RecurringFeesPanel", () => ({ default: function RecurringFeesPanel() { return null; } }));
vi.mock("../SmsOnboardingPilot", () => ({ default: function SmsOnboardingPilot() { return null; } }));
vi.mock("../SmsCreditAdmin", () => ({ default: function SmsCreditAdmin() { return null; } }));
vi.mock("../UsageReconciliation", () => ({ default: function UsageReconciliation() { return null; } }));
vi.mock("../StudioSmsRegistrations", () => ({ default: function StudioSmsRegistrations() { return null; } }));

import PlatformSmsPage from "../page";

function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out));
  } else if (isValidElement(node)) {
    if (typeof node.type === "function") out.push(node);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

describe("platform SMS page wiring (activation controls)", () => {
  it("mounts the controls once with the session administrator, the page's reads and its own result values", async () => {
    const tree = await PlatformSmsPage({ searchParams: Promise.resolve({ controls: "1", controls_error: undefined, actor: "forged" }) });
    const controls = walk(tree).filter((e) => (e.type as { name?: string }).name === "ActivationControlsPanel");
    expect(controls).toHaveLength(1);
    expect(controls[0].props).toEqual({ adminId: ADMIN, locations: ROWS, usage: USAGE, readiness: READINESS, notice: "1", error: null });
  });
});
