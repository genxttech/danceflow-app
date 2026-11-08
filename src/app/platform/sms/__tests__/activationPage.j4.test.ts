import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * TW-4F J4 page-level wiring: the platform SMS page mounts the activation console once, after the recovery panel, with the session's administrator id
 * and its own result query values. Data sources are stubbed; the console's own rendering is covered by activation.j4.test.ts.
 */

vi.mock("server-only", () => ({}));
const ADMIN = "a6000000-0000-4000-8000-00000000a4a4";
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
vi.mock("@/lib/sms/usageReconcileView", () => ({ loadReconcileOverview: async () => null }));
vi.mock("@/lib/sms/onboarding/client", () => ({ listOnboardings: async () => [] }));
vi.mock("@/lib/sms/twilioIsv/factory", () => ({ buildRunnerStore: () => ({ status: async () => null }) }));
vi.mock("@/lib/sms/provisioning/provisionLedger", () => ({ loadLedgers: async () => ({}), ProvisioningLedgerStore: class {} }));
vi.mock("@/lib/sms/twilioIsv/panel", () => ({ SupabasePanelStore: class { async overview() { return { entities: [], onboardings: [] }; } }, buildStudioPanels: () => [] }));
vi.mock("@/lib/sms/senderVerification", async (orig) => ({ ...(await orig<typeof import("@/lib/sms/senderVerification")>()), loadSenderOverview: async () => [], loadSenderHealth: async () => null }));

vi.mock("../ActivationPanel", () => ({ default: function ActivationPanel() { return null; } }));
vi.mock("../RecoveryPanel", () => ({ default: function RecoveryPanel() { return null; } }));
vi.mock("../SmsSubaccountPanel", () => ({ default: function SmsSubaccountPanel() { return null; } }));
vi.mock("../RecurringFeesPanel", () => ({ default: function RecurringFeesPanel() { return null; } }));
vi.mock("../SmsOnboardingPilot", () => ({ default: function SmsOnboardingPilot() { return null; } }));
vi.mock("../SmsCreditAdmin", () => ({ default: function SmsCreditAdmin() { return null; } }));
vi.mock("../UsageReconciliation", () => ({ default: function UsageReconciliation() { return null; } }));
vi.mock("../StudioSmsRegistrations", () => ({ default: function StudioSmsRegistrations() { return null; } }));

import PlatformSmsPage from "../page";

/** Every function-component element, depth first, in document order. */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out));
  } else if (isValidElement(node)) {
    if (typeof node.type === "function") out.push(node);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}
const named = (els: ReactElement[], name: string) => els.filter((e) => (e.type as { name?: string }).name === name);

describe("platform SMS page wiring (J4 activation console)", () => {
  it("mounts the activation console once, right after the recovery panel, with the session administrator and its own result values", async () => {
    const tree = await PlatformSmsPage({ searchParams: Promise.resolve({ activation: undefined, activation_error: "1", actor: "forged" }) });
    const all = walk(tree);
    const activation = named(all, "ActivationPanel");
    expect(activation).toHaveLength(1);
    expect(activation[0].props).toEqual({ adminId: ADMIN, notice: null, error: "1" });
    expect(all.indexOf(activation[0])).toBe(all.indexOf(named(all, "RecoveryPanel")[0]) + 1);
  });
});
