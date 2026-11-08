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
import { loadReconcilerReadiness, parseReconcilerReadiness, type ReconcilerReadiness } from "@/lib/sms/usageReconcilerReadiness";
import UsageReconciliation from "../UsageReconciliation";

const render = (switchOn: boolean, readiness: ReconcilerReadiness | null) =>
  renderToStaticMarkup(createElement(UsageReconciliation, { overview: parseReconcileOverview({ switch_on: switchOn, last_completed_at: null, stale: false }), readiness }));

describe("TW-4F F3 reconciler readiness: parsing", () => {
  it("reads the database contract", () => {
    expect(parseReconcilerReadiness({ ok: true, detail: "ready", last_success_at: "2026-10-22T10:00:00+00:00" })).toEqual({ ok: true, detail: "ready", lastSuccessAt: "2026-10-22T10:00:00+00:00" });
    expect(parseReconcilerReadiness({ ok: false, detail: "stale", last_success_at: "2026-10-22T09:00:00+00:00" })).toEqual({ ok: false, detail: "stale", lastSuccessAt: "2026-10-22T09:00:00+00:00" });
    expect(parseReconcilerReadiness({ ok: false, detail: "no_completed_run", last_success_at: null })).toEqual({ ok: false, detail: "no_completed_run", lastSuccessAt: null });
    expect(parseReconcilerReadiness({ ok: false, detail: "evidence_failing", last_success_at: null })).toEqual({ ok: false, detail: "evidence_failing", lastSuccessAt: null });
  });

  it("fails closed on anything unexpected", () => {
    expect(parseReconcilerReadiness({ ok: true, detail: "something_new", last_success_at: null })).toEqual({ ok: false, detail: "unknown", lastSuccessAt: null });
    expect(parseReconcilerReadiness({ ok: "true", detail: "ready" })).toBeNull();
    expect(parseReconcilerReadiness(null)).toBeNull();
    expect(parseReconcilerReadiness([])).toBeNull();
  });

  it("a missing function or an error reads as not available", async () => {
    expect(await loadReconcilerReadiness({ rpc: async () => ({ data: null, error: { code: "PGRST202" } }) } as never)).toBeNull();
    expect(await loadReconcilerReadiness({ rpc: async () => { throw new Error("down"); } } as never)).toBeNull();
    expect(await loadReconcilerReadiness({ rpc: async () => ({ data: { ok: true, detail: "ready", last_success_at: "2026-10-22T10:00:00Z" }, error: null }) } as never)).toMatchObject({ ok: true });
  });
});

describe("TW-4F F3 reconciler readiness: panel", () => {
  it("not ready while billed texting is on: an alert saying new texts are refused", () => {
    const html = render(true, { ok: false, detail: "stale", lastSuccessAt: "2026-10-22T09:00:00Z" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("more than 30 minutes old");
    expect(html).toContain("New billed texts are refused");
    expect(html).toContain("2026-10-22 09:00Z");
  });

  it("not ready while off: a status saying the switch cannot be turned on", () => {
    const html = render(false, { ok: false, detail: "no_completed_run", lastSuccessAt: null });
    expect(html).toContain('role="status"');
    expect(html).toContain("no reconciliation run has completed yet");
    expect(html).toContain("cannot be switched on");
    expect(render(false, { ok: false, detail: "stuck_lease", lastSuccessAt: null })).toContain("schedule has stopped");
    expect(render(false, { ok: false, detail: "no_evidence_reads", lastSuccessAt: null })).toContain("evidence reads are off");
    expect(render(false, { ok: false, detail: "evidence_failing", lastSuccessAt: null })).toContain("settled nothing that was due");
  });

  it("ready: a plain line; no readiness (older database): nothing", () => {
    expect(render(true, { ok: true, detail: "ready", lastSuccessAt: "2026-10-22T10:00:00Z" })).toContain("The reconciler is ready for billed texting");
    const none = render(true, null);
    expect(none).not.toContain("reconciler is ready");
    expect(none).not.toContain("not ready");
  });
});
