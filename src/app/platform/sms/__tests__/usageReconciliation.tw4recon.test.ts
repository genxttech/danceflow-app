import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/platform", () => ({ requirePlatformAdmin: async () => ({ id: "a" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/security/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), rateLimitKey: (...p: string[]) => p.join(":") }));

import { parseReconcileOverview } from "@/lib/sms/usageReconcileView";
import UsageReconciliation from "../UsageReconciliation";

const NO_MSG = "b1000000-0000-4000-8000-000000000001";
const WITH_MSG = "b2000000-0000-4000-8000-000000000002";

const render = (data: unknown, props: { notice?: boolean; error?: string | null } = {}) =>
  renderToStaticMarkup(createElement(UsageReconciliation, { overview: parseReconcileOverview(data), ...props }));

const base = { switch_on: true, last_completed_at: "2026-10-20T10:00:00Z", stale: false };

describe("UsageReconciliation", () => {
  it("renders nothing without an overview", () => {
    expect(renderToStaticMarkup(createElement(UsageReconciliation, { overview: null }))).toBe("");
  });

  it("shows the stale alert only when stale", () => {
    expect(render({ ...base, stale: true })).toContain("Reconciliation is not running");
    expect(render(base)).not.toContain("Reconciliation is not running");
  });

  it("shows the gap alert when either ledger does not reconcile", () => {
    expect(render({ ...base, usage_gaps: 1 })).toContain("ledger does not reconcile");
    expect(render({ ...base, inbound_gaps: 2 })).toContain("ledger does not reconcile");
    expect(render(base)).not.toContain("ledger does not reconcile");
  });

  it("offers release only without a provider message, and charge / close with one", () => {
    const html = render({
      ...base,
      exceptions: [
        { attempt_id: NO_MSG, state: "unknown", has_provider_message: false, reserved_cents: 8, estimated_segments: 1 },
        { attempt_id: WITH_MSG, state: "submitted", has_provider_message: true, reserved_cents: 16, estimated_segments: 2 },
      ],
    });
    const [first, second] = html.split("<li").filter((p) => p.includes("<form"));
    expect(first).toContain(NO_MSG);
    expect(first).toContain('value="released"');
    expect(first).not.toContain('value="charged"');
    expect(first).not.toContain('name="segments"');
    expect(second).toContain(WITH_MSG);
    expect(second).toContain('value="charged"');
    expect(second).toContain('value="not_charged"');
    expect(second).not.toContain('value="released"');
    expect(second).toContain('name="segments"');
    expect(second).toContain('value="2"');
    expect(html).toContain('minLength="10"');
    expect(html).toContain('maxLength="300"');
    expect(html).toContain("moves money and is final");
  });

  it("explains unseen keywords and shows the error / notice", () => {
    const html = render(
      { ...base, inbound: { keywords_unseen: [{ provider_sid: "SM123", recovered_at: "2026-10-20T08:00:00Z" }] } },
      { error: "not_resolvable", notice: true },
    );
    expect(html).toContain("Opt-outs are applied automatically");
    expect(html).toContain("A recovered START is never applied");
    expect(html).toContain("SM123");
    expect(html).toContain("cannot be resolved now");
    expect(html).toContain("The attempt was resolved.");
  });

  it("does not echo an unknown error code", () => {
    const html = render(base, { error: "<script>x</script>" });
    expect(html).not.toContain("<script>");
  });
});
