import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadSenderHealth, parseSenderHealth, senderGuidance, type SenderHealthRow, type SenderHealthState } from "../senderVerification";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const rawRow = (over: Record<string, unknown> = {}) => ({
  studio_id: STUDIO, legal_entity_id: "e", sender_id: "s", status: "approved", state: "ready", blocked: false, last_success_at: "2026-10-20T01:00:00Z",
  expires_at: "2026-10-21T01:00:00Z", next_check_at: "2026-10-20T21:00:00Z", decisive_outcome: "verified", decisive_code: null, decisive_source: "provider_read",
  decisive_at: "2026-10-20T01:00:00Z", last_attempt_outcome: null, last_attempt_code: null, last_attempt_at: null, retries_since_success: 0, ...over,
});
const row = (over: Partial<SenderHealthRow>): SenderHealthRow => ({ ...parseSenderHealth({ senders: [rawRow()] }).senders[0], ...over });

describe("parseSenderHealth", () => {
  it("maps a good answer to camelCase", () => {
    const h = parseSenderHealth({
      senders: [rawRow({ retries_since_success: 3 })],
      scheduler: { last_completed_at: "2026-10-20T02:00:00Z", stale: false, running: null, runs: [{ run_id: "r", status: "completed", started_at: "a", finished_at: "b", summary: {}, error: null }], expiring: 1, expired: 0, failed: 2 },
    });
    expect(h.senders[0]).toMatchObject({ studioId: STUDIO, state: "ready", blocked: false, expiresAt: "2026-10-21T01:00:00Z", retriesSinceSuccess: 3 });
    expect(h.scheduler).toMatchObject({ lastCompletedAt: "2026-10-20T02:00:00Z", stale: false, running: false, expiring: 1, expired: 0, failed: 2 });
    expect(h.scheduler.runs[0]).toMatchObject({ runId: "r", status: "completed" });
  });

  it("never reads junk or a missing block as healthy", () => {
    for (const junk of [null, undefined, 5, "x", [], {}]) {
      const h = parseSenderHealth(junk);
      expect(h.senders).toEqual([]);
      expect(h.scheduler.stale).toBe(true);
    }
    const h = parseSenderHealth({ senders: [rawRow({ state: "great", blocked: false }), { state: "ready" }, null], scheduler: "nope" });
    expect(h.senders).toHaveLength(1);
    expect(h.senders[0].state).toBe("blocked");
    expect(h.senders[0].blocked).toBe(true);
    expect(h.scheduler.stale).toBe(true);
  });

  it("blocked is derived from the state, whatever the payload claims", () => {
    expect(parseSenderHealth({ senders: [rawRow({ state: "expired", blocked: false })] }).senders[0].blocked).toBe(true);
    expect(parseSenderHealth({ senders: [rawRow({ state: "expiring", blocked: true })] }).senders[0].blocked).toBe(false);
  });
});

describe("loadSenderHealth", () => {
  it("returns parsed data, and null on any error (including the function missing)", async () => {
    const ok = { rpc: vi.fn(async () => ({ data: { senders: [rawRow()], scheduler: { stale: false } }, error: null })) };
    expect((await loadSenderHealth(ok as never, "a"))?.senders).toHaveLength(1);
    expect(ok.rpc).toHaveBeenCalledWith("tw4_sender_health", { p_actor: "a" });
    for (const code of ["PGRST202", "42883", "XX000"]) {
      expect(await loadSenderHealth({ rpc: async () => ({ data: null, error: { code } }) } as never, "a")).toBeNull();
    }
    expect(await loadSenderHealth({ rpc: async () => { throw new Error("boom"); } } as never, "a")).toBeNull();
    expect(await loadSenderHealth({ rpc: async () => ({ data: null, error: null }) } as never, "a")).toBeNull();
  });
});

describe("senderGuidance", () => {
  it("ready and expiring are the only able-to-send states", () => {
    expect(senderGuidance(row({ state: "ready" }))).toMatchObject({ headline: "Ready", next: "none" });
    expect(senderGuidance(row({ state: "expiring" }))).toMatchObject({ headline: "Ready, re-check due", next: "wait" });
    const states: SenderHealthState[] = ["none", "released", "revoked", "pending", "failed", "expired", "blocked"];
    for (const state of states) expect(senderGuidance(row({ state })).headline).not.toMatch(/^Ready/);
  });

  it("expired: verify, unless the scheduler is retrying an unreachable Twilio", () => {
    expect(senderGuidance(row({ state: "expired", lastAttemptOutcome: null })).next).toBe("verify");
    expect(senderGuidance(row({ state: "expired", lastAttemptOutcome: "failed" })).next).toBe("verify");
    expect(senderGuidance(row({ state: "expired", lastAttemptOutcome: "inconclusive" })).next).toBe("wait");
  });

  it("failed: provider, mismatch and attestation code families", () => {
    const next = (code: string | null) => senderGuidance(row({ state: "failed", decisiveCode: code })).next;
    for (const c of ["campaign_not_verified", "service_not_a2p_registered", "number_not_ready", "number_not_in_service", "account_not_active", "inbound_not_routed_to_danceflow", "callback:30034"]) expect(next(c)).toBe("provider");
    for (const c of ["service_not_on_account", "campaign_not_on_service", "brand_not_the_business", "mock_registration", "use_case_mismatch", "subaccount_not_active", "read_not_found:account", "read_forbidden:number", "read_unreadable:brand"]) expect(next(c)).toBe("investigate");
    expect(next("advanced_opt_out_not_attested")).toBe("verify");
    expect(next("something_new")).toBe("investigate");
    expect(next(null)).toBe("investigate");
    expect(senderGuidance(row({ state: "failed", decisiveCode: "campaign_not_verified" })).detail).toMatch(/Fix it in Twilio, then Verify/);
    expect(senderGuidance(row({ state: "failed", decisiveCode: "service_not_on_account" })).detail).toMatch(/reassignment or wrong subaccount/);
  });

  it("pending verifies; blocked investigates; revoked/released/none record", () => {
    expect(senderGuidance(row({ state: "pending" })).next).toBe("verify");
    const blocked = senderGuidance(row({ state: "blocked" }));
    expect(blocked.next).toBe("investigate");
    expect(blocked.detail).toMatch(/subaccount is no longer active, the location's registration path changed/);
    for (const state of ["revoked", "released", "none"] as const) expect(senderGuidance(row({ state })).next).toBe("record");
  });
});

describe("senderGuidance: review follow-ups", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  it("a token that cannot be obtained is never 'just wait': it is investigated, before and after the deadline", () => {
    expect(senderGuidance(row({ state: "expired", lastAttemptOutcome: "inconclusive", lastAttemptCode: "read_credentials_unavailable:account", lastSuccessAt: hoursAgo(25) })).next).toBe("investigate");
    expect(senderGuidance(row({ state: "expiring", lastAttemptOutcome: "inconclusive", lastAttemptCode: "read_credentials_unavailable:campaign" })).next).toBe("investigate");
  });
  it("repeated failed re-checks while still trusted are surfaced in the headline", () => {
    const g = senderGuidance(row({ state: "expiring", lastAttemptOutcome: "inconclusive", lastAttemptCode: "read_timeout:number", retriesSinceSuccess: 3 }));
    expect(g).toMatchObject({ headline: "Ready, re-checks failing", next: "wait" });
    expect(g.detail).toContain("3 tries");
  });
  it("trust lapsed more than 48 hours ago needs a person's verification", () => {
    expect(senderGuidance(row({ state: "expired", lastAttemptOutcome: "inconclusive", lastAttemptCode: "read_timeout:account", lastSuccessAt: hoursAgo(80) }))).toMatchObject({ next: "verify", headline: "Blocked: verification lapsed days ago" });
  });
});
