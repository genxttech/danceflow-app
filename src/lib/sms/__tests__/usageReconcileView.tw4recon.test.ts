import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadReconcileOverview, parseReconcileOverview } from "../usageReconcileView";

const ATTEMPT = "b1000000-0000-4000-8000-000000000001";

describe("parseReconcileOverview", () => {
  it("parses a good overview", () => {
    const o = parseReconcileOverview({
      switch_on: true,
      last_completed_at: "2026-10-20T10:00:00Z",
      stale: false,
      running: { run_id: "r1", runner: "cron", started_at: "2026-10-20T10:05:00Z", lease_expires_at: "2026-10-20T10:10:00Z" },
      runs: [{ run_id: "r0", status: "completed", started_at: "2026-10-20T10:00:00Z", finished_at: "2026-10-20T10:00:05Z", summary: { settled: 3, charged_cents: "12", bogus: 9 }, error: null }],
      by_state: { reserved: 2, review: "1", weird: {} },
      stale_reserved: 1, evidence_retrying: 2, escalated_open: 3, reserved_open_cents: 450, usage_gaps: 0, inbound_gaps: 2,
      exceptions: [{ attempt_id: ATTEMPT, state: "unknown", has_provider_message: true, reserved_cents: 8, estimated_segments: 2, review_reason: "x" }],
      inbound: {
        cursors: [{ account_sid: "AC1", scanned_through: "2026-10-20T09:00:00Z", lag_minutes: 60 }],
        unscanned_accounts: 1,
        recovered_7d: { keyword: 2 },
        keywords_unseen: [{ provider_sid: "SM1", studio_id: null, recovered_at: "2026-10-20T08:00:00Z" }],
      },
    });
    expect(o.switchOn).toBe(true);
    expect(o.running?.runId).toBe("r1");
    expect(o.runs[0].summary).toEqual({ settled: 3, charged_cents: 12 });
    expect(o.byState).toEqual({ reserved: 2, review: 1 });
    expect(o.inboundGaps).toBe(2);
    expect(o.exceptions[0]).toMatchObject({ attemptId: ATTEMPT, hasProviderMessage: true, estimatedSegments: 2, reservedCents: 8 });
    expect(o.inbound.cursors[0].lagMinutes).toBe(60);
    expect(o.inbound.keywordsUnseen[0].providerSid).toBe("SM1");
  });

  it("survives junk and missing fields", () => {
    for (const junk of [null, undefined, 5, "x", [], { runs: "no", exceptions: [1, null, {}], inbound: 7 }]) {
      const o = parseReconcileOverview(junk);
      expect(o.switchOn).toBe(false);
      expect(o.stale).toBe(false);
      expect(o.running).toBeNull();
      expect(o.runs).toEqual([]);
      expect(o.exceptions).toEqual([]);
      expect(o.inbound).toEqual({ cursors: [], unscannedAccounts: 0, recovered7d: {}, keywordsUnseen: [], unresolved7d: {}, unresolved: [] });
      expect(o.usageGaps).toBe(0);
    }
  });

  it("clamps estimated segments to 1..10", () => {
    const seg = (n: unknown) => parseReconcileOverview({ exceptions: [{ attempt_id: ATTEMPT, estimated_segments: n }] }).exceptions[0].estimatedSegments;
    expect(seg(0)).toBe(1);
    expect(seg(99)).toBe(10);
    expect(seg("junk")).toBe(1);
  });
});

describe("loadReconcileOverview", () => {
  const client = (answer: { data: unknown; error: unknown } | "throw") =>
    ({ rpc: async () => { if (answer === "throw") throw new Error("boom"); return answer; } }) as never;

  it("is null when the function is missing, errors or throws", async () => {
    expect(await loadReconcileOverview(client({ data: null, error: { code: "PGRST202" } }), "a")).toBeNull();
    expect(await loadReconcileOverview(client({ data: null, error: { code: "42883" } }), "a")).toBeNull();
    expect(await loadReconcileOverview(client("throw"), "a")).toBeNull();
    expect(await loadReconcileOverview(client({ data: null, error: null }), "a")).toBeNull();
  });

  it("parses data and passes the actor", async () => {
    const calls: unknown[] = [];
    const c = { rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return { data: { switch_on: true }, error: null }; } } as never;
    expect((await loadReconcileOverview(c, "admin-1"))?.switchOn).toBe(true);
    expect(calls).toEqual([["tw4_usage_reconcile_overview", { p_actor: "admin-1", p_limit: 50 }]]);
  });
});

describe("parseReconcileOverview: inbound recovery evidence", () => {
  it("parses keyword recoveries with whether the webhook was seen, and the unresolved evidence; drops malformed rows", () => {
    const o = parseReconcileOverview({
      inbound: {
        keywords_unseen: [{ provider_sid: "SMa", studio_id: "s1", recovered_at: "2026-10-20T10:00:00Z", webhook_seen: true }, { studio_id: "x" }],
        unresolved_7d: { unrouted: 2, refused: "1" },
        unresolved: [{ provider_sid: "SMb", account_sid: "ACx", reason: "refused", code: "42501", noted_at: "2026-10-20T11:00:00Z" }, null, { reason: "unrouted" }],
      },
    });
    expect(o.inbound.keywordsUnseen).toEqual([{ providerSid: "SMa", studioId: "s1", recoveredAt: "2026-10-20T10:00:00Z", webhookSeen: true }]);
    expect(o.inbound.unresolved7d).toEqual({ unrouted: 2, refused: 1 });
    expect(o.inbound.unresolved).toEqual([{ providerSid: "SMb", accountSid: "ACx", reason: "refused", code: "42501", notedAt: "2026-10-20T11:00:00Z" }]);
  });
});
