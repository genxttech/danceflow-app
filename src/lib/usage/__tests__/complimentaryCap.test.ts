import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ studio: {} as Record<string, unknown>, packs: [] as Array<{ quantity_included: number }> }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => ({ studioId: "studio-1" }) }));
vi.mock("@/lib/billing/access", () => ({ getCurrentStudioPlanForUser: async () => ({ studioId: "studio-1", planCode: "pro", status: "active" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => {
      const data = table === "studios" ? db.studio : table === "usage_addon_entitlements" ? db.packs : null;
      const api: Record<string, unknown> = {};
      for (const name of ["select", "eq", "limit"]) api[name] = () => api;
      api.maybeSingle = async () => ({ data, error: null });
      api.then = (resolve: (value: unknown) => void) => resolve({ data, error: null });
      return api;
    },
  }),
}));

import { getUsageAllowance } from "../addons";

describe("complimentary studio allowance", () => {
  beforeEach(() => {
    db.studio = { billing_override_enabled: false, billing_override_expires_at: null };
    db.packs = [];
    delete process.env.AI_COMPLIMENTARY_STUDIO_MONTHLY_CAP;
  });

  it("leaves a paying studio unchanged", async () => {
    expect((await getUsageAllowance({ featureKey: "ai_action" })).totalAllowance).toBe(500);
  });

  it("caps the included AI of a complimentary studio and keeps purchased credits on top", async () => {
    db.studio = { billing_override_enabled: true, billing_override_expires_at: null };
    expect((await getUsageAllowance({ featureKey: "ai_action" })).totalAllowance).toBe(50);
    db.packs = [{ quantity_included: 200 }];
    expect((await getUsageAllowance({ featureKey: "ai_action" })).totalAllowance).toBe(250);
  });

  it("does not touch non-AI allowances", async () => {
    db.studio = { billing_override_enabled: true, billing_override_expires_at: null };
    expect((await getUsageAllowance({ featureKey: "email_campaign_recipient" })).totalAllowance).toBe(5000);
  });
});
