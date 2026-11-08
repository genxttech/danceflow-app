import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * TW-4F F4 page-level wiring: the platform SMS page mounts the F4 recovery panel (with the session's administrator id and its own result query values)
 * AND keeps #251's sender-health data on the subaccount panel. Data sources are stubbed; each panel's own rendering is covered by its component tests.
 */

vi.mock("server-only", () => ({}));
const ADMIN = "a6000000-0000-4000-8000-0000000f4f41";
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
const OVERVIEW = { entities: [{ legalEntityId: "e1", studios: [{ studioId: "s1" }] }], onboardings: [] };
vi.mock("@/lib/sms/twilioIsv/panel", () => ({ SupabasePanelStore: class { async overview() { return OVERVIEW; } }, buildStudioPanels: () => [] }));
const HEALTH = { scheduler: { marker: "f4-page-check" } };
vi.mock("@/lib/sms/senderVerification", () => ({ loadSenderOverview: async () => [], loadSenderHealth: async () => HEALTH }));

// the page's children are stubbed to markers: this test checks the page's own wiring
vi.mock("../RecoveryPanel", () => ({ default: function RecoveryPanel() { return null; } }));
vi.mock("../SmsSubaccountPanel", () => ({ default: function SmsSubaccountPanel() { return null; } }));
vi.mock("../RecurringFeesPanel", () => ({ default: function RecurringFeesPanel() { return null; } }));
vi.mock("../SmsOnboardingPilot", () => ({ default: function SmsOnboardingPilot() { return null; } }));
vi.mock("../SmsCreditAdmin", () => ({ default: function SmsCreditAdmin() { return null; } }));
vi.mock("../UsageReconciliation", () => ({ default: function UsageReconciliation() { return null; } }));
vi.mock("../StudioSmsRegistrations", () => ({ default: function StudioSmsRegistrations() { return null; } }));

import PlatformSmsPage from "../page";

function find(node: ReactNode, name: string, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((n) => find(n, name, out));
  } else if (isValidElement(node)) {
    const type = node.type as { name?: string };
    if (typeof node.type === "function" && type.name === name) out.push(node);
    find((node.props as { children?: ReactNode }).children, name, out);
  }
  return out;
}

describe("platform SMS page wiring (F4 + #251)", () => {
  it("mounts the recovery panel once with the session administrator and its own result values, and keeps sender health on the subaccount panel", async () => {
    const tree = await PlatformSmsPage({ searchParams: Promise.resolve({ recovery: "1", recovery_error: undefined }) });
    const recovery = find(tree, "RecoveryPanel");
    expect(recovery).toHaveLength(1);
    expect(recovery[0].props).toEqual({ adminId: ADMIN, notice: "1", error: null });
    const subaccount = find(tree, "SmsSubaccountPanel");
    expect(subaccount).toHaveLength(1);
    expect((subaccount[0].props as { senderHealth: unknown }).senderHealth).toBe(HEALTH);
    // the recurring-fee panel is still mounted alongside (the recovery panel is an addition, not a replacement)
    expect(find(tree, "RecurringFeesPanel")).toHaveLength(1);
  });
});
