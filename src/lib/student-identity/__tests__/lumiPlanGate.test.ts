import { describe, expect, it, vi } from "vitest";

const plans = vi.hoisted(() => ({
  "studio-growth": { planCode: "growth", status: "active" },
  "studio-trial": { planCode: "pro", status: "trialing" },
  "studio-starter": { planCode: "starter", status: "active" },
  "studio-lapsed": { planCode: "pro", status: "canceled" },
  "studio-off": { planCode: "pro", status: "active" },
}) as Record<string, { planCode: string; status: string }>);

vi.mock("@/lib/billing/access", () => ({ resolveStudioBillingPlan: async (_client: unknown, id: string) => plans[id] }));
const ids = Object.keys(plans);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const data =
        table === "client_account_links"
          ? ids.map((id) => ({ id: `link-${id}`, studio_id: id, client_id: `client-${id}`, status: "linked", relationship_type: "self" }))
          : table === "clients"
            ? ids.map((id) => ({ id: `client-${id}`, studios: { id, slug: id, name: id, public_name: null } }))
            : ids.map((id) => ({ studio_id: id, lumi_enabled: id !== "studio-off" }));
      const api: Record<string, unknown> = {};
      for (const name of ["select", "eq", "in", "order"]) api[name] = () => api;
      api.then = (resolve: (value: unknown) => void) => resolve({ data, error: null });
      return api;
    },
  }),
}));

import { isLumiPlanAllowed } from "@/lib/lumi/plan";
import { getStudentStudioLinks } from "../links";

describe("mobile LUMI availability follows the plan, like the web portal", () => {
  it("is on only for a flagged studio on an active or trialing Growth or Pro plan", async () => {
    const links = await getStudentStudioLinks({ id: "user-1" } as never);
    const enabled = Object.fromEntries(links.map((link) => [link.studioId, link.lumiEnabled]));
    expect(enabled).toEqual({
      "studio-growth": true,
      "studio-trial": true,
      "studio-starter": false,
      "studio-lapsed": false,
      "studio-off": false,
    });
  });

  it("the shared rule rejects organizer and missing plans", () => {
    expect(isLumiPlanAllowed({ planCode: "organizer", status: "active" })).toBe(false);
    expect(isLumiPlanAllowed({ planCode: null, status: "active" })).toBe(false);
  });
});
