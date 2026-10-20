import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  INBOUND_GRACE_MS,
  classifyEvidenceFailure,
  classifyRecoveredBody,
  reconcileSmsUsage,
  recoverInboundUsage,
  runScheduledUsageReconciliation,
} from "../usageReconciler";
import { FakeBilledSmsProvider, RealBilledSmsProvider, twilioDateToIso, type InboundMessageEvidence } from "../usageProvider";

/**
 * TW-4F scheduled reconciliation, application side (the database decides money; these check what is sent to it and when). The real-schema behaviour is
 * covered by localStack.tw4recon.test.ts.
 */

const ACCOUNT = `AC${"a".repeat(32)}`;
const OTHER = `AC${"b".repeat(32)}`;
const sidOf = (n: number) => `SM${n.toString(16).padStart(32, "0")}`;
const row = (n: number) => ({ attempt_id: `attempt-${n}`, account_sid: ACCOUNT, provider_sid: sidOf(n) });
const RUN = "11111111-1111-4111-8111-111111111111";

type Reply = { data?: unknown; error?: { code?: string } | null };
function fakeRpc(handlers: Record<string, (args: Record<string, unknown> | undefined) => Reply | Promise<Reply>>) {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const admin = {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args });
      const handler = handlers[fn];
      if (!handler) throw new Error(`unexpected rpc ${fn}`);
      const reply = await handler(args);
      return { data: reply.data ?? null, error: reply.error ?? null };
    },
  };
  return { admin: admin as unknown as Parameters<typeof reconcileSmsUsage>[0], calls };
}

const inbound = (n: number, over: Partial<InboundMessageEvidence> = {}): InboundMessageEvidence => ({
  sid: sidOf(n), account_sid: ACCOUNT, direction: "inbound", to: "+15125550100", from: "+15125550142", messaging_service_sid: null, num_segments: "1", num_media: "0",
  date_created: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), date_sent: null, body: "Running ten minutes late, sorry", ...over,
});

describe("evidence failures are classified, never released", () => {
  it("404, mismatch and invalid input are definite; everything else transient; unknown text gets a fixed code", () => {
    expect(classifyEvidenceFailure(new Error("usage_evidence_http_404"))).toEqual({ code: "usage_evidence_http_404", definite: true });
    expect(classifyEvidenceFailure(new Error("usage_evidence_mismatch"))).toEqual({ code: "usage_evidence_mismatch", definite: true });
    expect(classifyEvidenceFailure(new Error("usage_evidence_timeout"))).toEqual({ code: "usage_evidence_timeout", definite: false });
    expect(classifyEvidenceFailure(new Error("usage_evidence_credentials_unavailable")).definite).toBe(false);
    expect(classifyEvidenceFailure(new Error("usage_evidence_http_503")).definite).toBe(false);
    expect(classifyEvidenceFailure(new Error("Auth token abc123 rejected for +15125550100"))).toEqual({ code: "usage_evidence_unknown", definite: false });
    expect(classifyEvidenceFailure("x")).toEqual({ code: "usage_evidence_unknown", definite: false });
  });

  it("a failed read and a refused settle are recorded with backoff (refused = definite); transient settle errors are not definite", async () => {
    const provider = new FakeBilledSmsProvider().failFetch(sidOf(1));
    const { admin, calls } = fakeRpc({
      tw4_usage_release_stale: () => ({ data: { released: 0 } }),
      tw4_usage_due: () => ({ data: [row(1), row(2), row(3)] }),
      tw4_usage_settle: (args) => (args?.p_attempt_id === "attempt-2" ? { error: { code: "42501" } } : { error: { code: "55P03" } }),
      tw4_usage_evidence_failed: (args) => ({ data: { outcome: args?.p_definite ? "review" : "retry" } }),
    });
    const summary = await reconcileSmsUsage(admin, provider, { runId: RUN });
    expect(calls[0]).toEqual({ fn: "tw4_usage_release_stale", args: { p_run_id: RUN, p_limit: 200 } });
    expect(calls.filter((c) => c.fn === "tw4_usage_evidence_failed").map((c) => c.args)).toEqual([
      { p_attempt_id: "attempt-1", p_code: "usage_evidence_unreadable", p_definite: false },
      { p_attempt_id: "attempt-2", p_code: "usage_settle_refused", p_definite: true },
      { p_attempt_id: "attempt-3", p_code: "usage_settle_failed", p_definite: false },
    ]);
    expect(summary).toMatchObject({ errors: 3, review: 1, retrying: 2, settled: 0 });
    expect(calls.some((c) => c.fn === "tw4_usage_touch")).toBe(false);
  });

  it("without an evidence provider nothing is read and nothing is counted as a failure (the stale release still runs)", async () => {
    const { admin, calls } = fakeRpc({ tw4_usage_release_stale: () => ({ data: { released: 2 } }) });
    const summary = await reconcileSmsUsage(admin, null, { runId: RUN });
    expect(calls.map((c) => c.fn)).toEqual(["tw4_usage_release_stale"]);
    expect(summary).toMatchObject({ releasedUnsent: 2, due: 0, errors: 0, evidenceRead: false });
  });

  it("stops at the time budget and reports truncation (the rest waits for the next run)", async () => {
    const { admin, calls } = fakeRpc({
      tw4_usage_release_stale: () => ({ data: { released: 0 } }),
      tw4_usage_due: () => ({ data: [row(1), row(2)] }),
      tw4_usage_settle: () => ({ data: { outcome: "pending" } }),
    });
    const summary = await reconcileSmsUsage(admin, new FakeBilledSmsProvider(), { runId: RUN, deadline: Date.now() - 1 });
    expect(summary.truncated).toBe(true);
    expect(calls.some((c) => c.fn === "tw4_usage_settle")).toBe(false);
  });

  it("a lost lease stops the pass", async () => {
    const { admin } = fakeRpc({ tw4_usage_release_stale: () => ({ error: { code: "TW023" } }) });
    await expect(reconcileSmsUsage(admin, null, { runId: RUN })).rejects.toThrow("usage reconcile: the run lost its lease");
  });
});

describe("recovered inbound classification fails safe", () => {
  it("keywords in any spelling are compliance; short, keyword-bearing, empty or missing bodies and unknown senders are uncertain; only the rest is ordinary", () => {
    const kinds: Record<string, string> = {
      STOP: "stop", " help ": "help", unstop: "start", "Stop!!": "stop", "STOP 🛑": "stop", "Stop,": "stop", "stop all": "stop", "S.T.O.P": "stop", "cancel.": "stop",
      "START": "start", "yes": "start", "info": "help", "HELP STOP": "stop", // an opt-out wins: consent fails closed
    };
    for (const [body, keywordKind] of Object.entries(kinds)) {
      expect(classifyRecoveredBody(body), body).toEqual({ classification: "compliance", keyword: true, keywordKind });
    }
    for (const body of [null, "   ", "ARRET", "Parar!", "ok thanks", "Running late sorry", "help me find the schedule"]) {
      expect(classifyRecoveredBody(body), String(body)).toEqual({ classification: "uncertain", keyword: false });
    }
    // an opt-out word inside a longer text: never charged, not applied, listed for a person
    for (const body of ["stop please", "please stop texting", "can you STOP these messages please", "unsubscribe me from this"]) {
      expect(classifyRecoveredBody(body), body).toEqual({ classification: "uncertain", keyword: false, possibleOptOut: true });
    }
    expect(classifyRecoveredBody("See you at six tonight")).toEqual({ classification: "ordinary", keyword: false });
    expect(classifyRecoveredBody("Running ten minutes late, sorry")).toEqual({ classification: "ordinary", keyword: false });
    expect(classifyRecoveredBody("Running ten minutes late, sorry", false)).toEqual({ classification: "uncertain", keyword: false }); // the webhook would not record it
  });
});

describe("inbound recovery", () => {
  const NUM = "+15125550100";
  const target = (through: Date, account = ACCOUNT, numbers = [NUM]) => ({ account_sid: account, legal_entity_id: "e", scanned_through: through.toISOString(), numbers });
  const hoursAgo = (h: number, now: Date) => new Date(now.getTime() - h * 60 * 60 * 1000);
  const allUnrecorded = (args: Record<string, unknown> | undefined) => ({ data: args?.p_sids });

  it("lists per location number, skips what is already recorded in one call, recovers the rest oldest first (never the body), then advances to now - grace", async () => {
    const now = new Date();
    const lister = new FakeBilledSmsProvider().setInbound(ACCOUNT, [
      inbound(1, { date_created: hoursAgo(1, now).toISOString() }), inbound(2, { body: "STOP", date_created: hoursAgo(2, now).toISOString() }),
      inbound(3, { to: "+15125550199" }), inbound(4),
    ]);
    const spy = vi.spyOn(lister, "listInbound");
    const { admin, calls } = fakeRpc({
      tw4_inbound_scan_targets: () => ({ data: [target(hoursAgo(3, now))] }),
      tw4_inbound_unrecorded: (args) => ({ data: (args?.p_sids as string[]).filter((s) => s !== sidOf(4)) }),
      tw4_inbound_recover: (args) => {
        const ev = args?.p_evidence as Record<string, unknown>;
        if (ev.sid === sidOf(1)) return { data: { outcome: "recovered", classification: "ordinary", basis: "ordinary", webhook_seen: false } };
        return { data: { outcome: "recovered", classification: "compliance", basis: "keyword", webhook_seen: false } };
      },
      tw4_inbound_scan_advance: () => ({ data: {} }),
    });
    const summary = await recoverInboundUsage(admin, lister, { runId: RUN, now });
    expect(spy.mock.calls.map((c) => c[1].to)).toEqual([NUM]);   // the other number's text is never listed
    expect(summary).toMatchObject({ accounts: 1, scanned: 3, recovered: 2, recoveredOrdinary: 1, keywordsUnseen: 1, alreadyRecorded: 1, errors: 0 });
    const sent = calls.filter((c) => c.fn === "tw4_inbound_recover").map((c) => c.args?.p_evidence as Record<string, unknown>);
    expect(sent.map((e) => e.sid)).toEqual([sidOf(2), sidOf(1)]);   // oldest first
    for (const ev of sent) expect(ev).not.toHaveProperty("body");
    // the texter's number reaches the database only for an opt-out (where the canonical STOP is applied to it)
    expect(sent[0]).toMatchObject({ keyword: true, keyword_kind: "stop", from: "+15125550142" });
    expect(sent[1]).not.toHaveProperty("from");
    expect(sent[1]).not.toHaveProperty("keyword_kind");
    const advance = calls.find((c) => c.fn === "tw4_inbound_scan_advance");
    expect(advance?.args).toEqual({ p_run_id: RUN, p_account_sid: ACCOUNT, p_through: new Date(now.getTime() - INBOUND_GRACE_MS).toISOString() });
  });

  it("never recovers inside the grace window; a transient failure advances only up to just before the text that failed", async () => {
    const now = new Date();
    const first = inbound(1, { date_created: hoursAgo(2.5, now).toISOString() });
    const second = inbound(2, { date_created: hoursAgo(2, now).toISOString() });
    const fresh = inbound(3, { date_created: new Date(now.getTime() - 5 * 60 * 1000).toISOString() });
    const lister = new FakeBilledSmsProvider().setInbound(ACCOUNT, [fresh, second, first]);
    const { admin, calls } = fakeRpc({
      tw4_inbound_scan_targets: () => ({ data: [target(hoursAgo(3, now))] }),
      tw4_inbound_unrecorded: allUnrecorded,
      tw4_inbound_recover: (args) => ((args?.p_evidence as { sid: string }).sid === sidOf(2) ? { error: { code: "55P03" } } : { data: { outcome: "recovered", basis: "ordinary" } }),
      tw4_inbound_scan_advance: () => ({ data: {} }),
    });
    const summary = await recoverInboundUsage(admin, lister, { runId: RUN, now });
    expect(calls.filter((c) => c.fn === "tw4_inbound_recover").map((c) => (c.args?.p_evidence as { sid: string }).sid)).toEqual([sidOf(1), sidOf(2)]);
    expect(summary).toMatchObject({ recovered: 1, errors: 1 });
    expect(calls.find((c) => c.fn === "tw4_inbound_scan_advance")?.args?.p_through).toBe(new Date(Date.parse(String(second.date_created)) - 1000).toISOString());
  });

  it("a permanent refusal (22023 / 42501) is kept as unresolved evidence and never blocks the checkpoint", async () => {
    const now = new Date();
    const lister = new FakeBilledSmsProvider().setInbound(ACCOUNT, [inbound(1), inbound(2, { date_created: hoursAgo(1.5, now).toISOString() })]);
    const { admin, calls } = fakeRpc({
      tw4_inbound_scan_targets: () => ({ data: [target(hoursAgo(3, now))] }),
      tw4_inbound_unrecorded: allUnrecorded,
      tw4_inbound_recover: (args) => ((args?.p_evidence as { sid: string }).sid === sidOf(1) ? { error: { code: "42501" } } : { data: { outcome: "recovered", basis: "ordinary" } }),
      tw4_inbound_note_unresolved: () => ({ data: { noted: true } }),
      tw4_inbound_scan_advance: () => ({ data: {} }),
    });
    const summary = await recoverInboundUsage(admin, lister, { runId: RUN, now });
    expect(summary).toMatchObject({ refused: 1, recovered: 1, errors: 0 });
    expect(calls.find((c) => c.fn === "tw4_inbound_note_unresolved")?.args).toEqual({ p_run_id: RUN, p_account_sid: ACCOUNT, p_provider_sid: sidOf(1), p_code: "42501" });
    expect(calls.find((c) => c.fn === "tw4_inbound_scan_advance")?.args?.p_through).toBe(new Date(now.getTime() - INBOUND_GRACE_MS).toISOString());
  });

  it("a failed list leaves the checkpoint alone and goes on; a subaccount with no sender number just advances", async () => {
    const now = new Date();
    const lister = new FakeBilledSmsProvider().failList(ACCOUNT).setInbound(OTHER, []);
    const { admin, calls } = fakeRpc({
      tw4_inbound_scan_targets: () => ({ data: [target(hoursAgo(3, now)), target(hoursAgo(3, now), OTHER), target(hoursAgo(3, now), `AC${"c".repeat(32)}`, [])] }),
      tw4_inbound_unrecorded: allUnrecorded,
      tw4_inbound_scan_advance: () => ({ data: {} }),
    });
    const summary = await recoverInboundUsage(admin, lister, { runId: RUN, now });
    expect(summary).toMatchObject({ accounts: 3, errors: 1 });
    expect(calls.filter((c) => c.fn === "tw4_inbound_scan_advance").map((c) => c.args?.p_account_sid).sort()).toEqual([OTHER, `AC${"c".repeat(32)}`].sort());
  });

  it("a listing too long for 24 hours is retried for one hour (and advances that far); still too long = stalled; a checkpoint inside the grace window is skipped", async () => {
    const now = new Date();
    const narrowOk = { listInbound: vi.fn(async (_a: string, w: { since: Date; until: Date }) => ({ messages: [], complete: w.until.getTime() - w.since.getTime() <= 2 * 60 * 60 * 1000 })) };
    const one = fakeRpc({ tw4_inbound_scan_targets: () => ({ data: [target(hoursAgo(120, now))] }), tw4_inbound_unrecorded: allUnrecorded, tw4_inbound_scan_advance: () => ({ data: {} }) });
    await recoverInboundUsage(one.admin, narrowOk, { runId: RUN, now });
    const windows = narrowOk.listInbound.mock.calls.map((c) => c[1].until.getTime() - c[1].since.getTime());
    expect(windows).toEqual([25 * 60 * 60 * 1000, 2 * 60 * 60 * 1000]);   // 1 h overlap + 24 h, then 1 h overlap + 1 h
    expect(one.calls.find((c) => c.fn === "tw4_inbound_scan_advance")?.args?.p_through).toBe(new Date(hoursAgo(120, now).getTime() + 60 * 60 * 1000).toISOString());

    const never = { listInbound: vi.fn(async () => ({ messages: [], complete: false })) };
    const two = fakeRpc({ tw4_inbound_scan_targets: () => ({ data: [target(hoursAgo(120, now)), target(new Date(now.getTime() - 60 * 1000), OTHER)] }), tw4_inbound_scan_advance: () => ({ data: {} }) });
    const summary = await recoverInboundUsage(two.admin, never, { runId: RUN, now });
    expect(never.listInbound).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ stalled: 1, truncated: true });
    expect(two.calls.some((c) => c.fn === "tw4_inbound_scan_advance")).toBe(false);
  });

  it("a lost lease stops recovery at once", async () => {
    const now = new Date();
    const lister = new FakeBilledSmsProvider().setInbound(ACCOUNT, [inbound(1), inbound(2)]);
    const { admin, calls } = fakeRpc({
      tw4_inbound_scan_targets: () => ({ data: [target(hoursAgo(3, now))] }),
      tw4_inbound_unrecorded: allUnrecorded,
      tw4_inbound_recover: () => ({ error: { code: "TW023" } }),
    });
    await expect(recoverInboundUsage(admin, lister, { runId: RUN, now })).rejects.toThrow("lost its lease");
    expect(calls.filter((c) => c.fn === "tw4_inbound_recover")).toHaveLength(1);
  });
});

describe("the scheduled run", () => {
  const ok = (extra: Record<string, (args: Record<string, unknown> | undefined) => Reply> = {}) =>
    fakeRpc({
      tw4_reconcile_run_begin: () => ({ data: { acquired: true, run_id: RUN } }),
      tw4_usage_release_stale: () => ({ data: { released: 1 } }),
      tw4_usage_due: () => ({ data: [] }),
      tw4_usage_escalate: () => ({ data: { escalated: 2 } }),
      tw4_inbound_scan_targets: () => ({ data: [] }),
      tw4_reconcile_run_finish: () => ({ data: { status: "completed" } }),
      ...extra,
    });

  it("an overlapping invocation does nothing (busy)", async () => {
    const { admin, calls } = fakeRpc({ tw4_reconcile_run_begin: () => ({ data: { acquired: false, reason: "busy" } }) });
    expect(await runScheduledUsageReconciliation(admin, new FakeBilledSmsProvider(), { runner: "test:1" })).toEqual({ ran: false, reason: "busy" });
    expect(calls).toHaveLength(1);
  });

  it("runs every step under its lease and records a completed run with counts only", async () => {
    const { admin, calls } = ok();
    const outcome = await runScheduledUsageReconciliation(admin, new FakeBilledSmsProvider(), { runner: "test:1" });
    expect(outcome.ran && outcome.failed).toBe(false);
    expect(calls.map((c) => c.fn)).toEqual(["tw4_reconcile_run_begin", "tw4_usage_release_stale", "tw4_usage_due", "tw4_usage_escalate", "tw4_inbound_scan_targets", "tw4_reconcile_run_finish"]);
    expect(calls[0].args).toEqual({ p_job: "usage_reconcile", p_runner: "test:1", p_lease_seconds: 120 });
    const finish = calls[calls.length - 1].args as Record<string, unknown>;
    expect(finish).toMatchObject({ p_run_id: RUN, p_status: "completed", p_error: null });
    expect(finish.p_summary).toMatchObject({ released_unsent: 1, escalated: 2, errors: 0 });
    for (const v of Object.values(finish.p_summary as Record<string, unknown>)) expect(["number", "boolean"]).toContain(typeof v);
  });

  it("without a provider it releases and escalates but reads nothing (no inbound scan)", async () => {
    const { admin, calls } = ok();
    await runScheduledUsageReconciliation(admin, null, { runner: "test:1" });
    expect(calls.map((c) => c.fn)).toEqual(["tw4_reconcile_run_begin", "tw4_usage_release_stale", "tw4_usage_escalate", "tw4_reconcile_run_finish"]);
  });

  it("a failing step records the run as failed with a fixed message (never provider or database text)", async () => {
    const { admin, calls } = ok({ tw4_usage_due: () => ({ error: { code: "57014" } }) });
    const outcome = await runScheduledUsageReconciliation(admin, new FakeBilledSmsProvider(), { runner: "test:1" });
    expect(outcome.ran && outcome.failed).toBe(true);
    expect(calls[calls.length - 1].args).toMatchObject({ p_status: "failed", p_error: "usage reconcile: due failed (57014)" });
    const thrown = ok({ tw4_usage_escalate: () => { throw new Error("connect ECONNREFUSED secret-host:5432"); } });
    await runScheduledUsageReconciliation(thrown.admin, null, { runner: "test:1" });
    expect(thrown.calls[thrown.calls.length - 1].args).toMatchObject({ p_status: "failed", p_error: "usage reconcile: unexpected failure" });
  });

  it("a database that cannot start a run is 'unavailable'", async () => {
    const { admin } = fakeRpc({ tw4_reconcile_run_begin: () => ({ error: { code: "PGRST202" } }) });
    expect(await runScheduledUsageReconciliation(admin, null, { runner: "test:1" })).toEqual({ ran: false, reason: "unavailable" });
  });
});

describe("provider: identity evidence and the inbound list", () => {
  const SUB_TOKEN = "t0ken".repeat(6) + "ab";
  const tokens = { tokenFor: async () => ({ reveal: () => SUB_TOKEN }), refresh: async () => ({ secret: { reveal: () => SUB_TOKEN }, changed: false }) };
  const make = (reply: (url: string) => { status: number; body: unknown }, allowRead = true) => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      const r = reply(url);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    return { provider: new RealBilledSmsProvider(tokens as never, { fetchImpl, allowRead }), seen };
  };

  it("converts Twilio dates to ISO and maps identity fields", async () => {
    expect(twilioDateToIso("Tue, 20 Oct 2026 12:00:00 +0000")).toBe("2026-10-20T12:00:00.000Z");
    expect(twilioDateToIso("")).toBeNull();
    expect(twilioDateToIso("not a date")).toBeNull();
    const { provider } = make(() => ({
      status: 200,
      body: { sid: sidOf(1), account_sid: ACCOUNT, status: "delivered", direction: "outbound-api", messaging_service_sid: `MG${"1".repeat(32)}`, from: "+15125550100", to: "+15125550142", date_created: "Tue, 20 Oct 2026 12:00:00 +0000", error_code: 30003 },
    }));
    expect(await provider.fetchMessage(ACCOUNT, sidOf(1))).toMatchObject({ direction: "outbound-api", from: "+15125550100", to: "+15125550142", date_created: "2026-10-20T12:00:00.000Z", error_code: "30003" });
  });

  it("lists only this subaccount's inbound messages, follows its own next pages, refuses a foreign page link or account", async () => {
    const since = new Date("2026-10-20T00:00:00Z");
    const until = new Date("2026-10-20T06:00:00Z");
    const page2 = `/2010-04-01/Accounts/${ACCOUNT}/Messages.json?PageSize=200&Page=1&PageToken=PAx`;
    const { provider, seen } = make((url) =>
      url.includes("PageToken")
        ? { status: 200, body: { messages: [{ sid: sidOf(3), account_sid: ACCOUNT, direction: "inbound", body: "hi there", date_sent: "Tue, 20 Oct 2026 01:00:00 +0000" }], next_page_uri: null } }
        : { status: 200, body: { messages: [{ sid: sidOf(1), account_sid: ACCOUNT, direction: "inbound", to: "+15125550100", num_segments: "1" }, { sid: sidOf(2), account_sid: ACCOUNT, direction: "outbound-api" }], next_page_uri: page2 } });
    const listed = await provider.listInbound(ACCOUNT, { since, until, maxPages: 5 });
    expect(listed.complete).toBe(true);
    expect(listed.messages.map((m) => m.sid)).toEqual([sidOf(1), sidOf(3)]);
    expect(listed.messages[1].date_sent).toBe("2026-10-20T01:00:00.000Z");
    expect(seen[0]).toContain(`/Accounts/${ACCOUNT}/Messages.json?`);
    // Twilio's inclusive date-time filters carry the operator in the parameter name ("DateSent>" = on or after), a second of margin each side
    expect(decodeURIComponent(seen[0])).toContain("DateSent>=2026-10-19T23:59:59Z");
    expect(decodeURIComponent(seen[0])).toContain("DateSent<=2026-10-20T06:00:01Z");
    expect(decodeURIComponent(seen[0])).not.toContain("To=");
    const byNumber = make(() => ({ status: 200, body: { messages: [] } }));
    await byNumber.provider.listInbound(ACCOUNT, { since, until, maxPages: 1, to: "+15125550100" });
    expect(decodeURIComponent(byNumber.seen[0])).toContain("To=+15125550100");
    await expect(byNumber.provider.listInbound(ACCOUNT, { since, until, maxPages: 1, to: "5125550100" })).rejects.toThrow("usage_evidence_invalid_input");
    // no further page after the deadline
    const late = make(() => ({ status: 200, body: { messages: [], next_page_uri: page2 } }));
    expect((await late.provider.listInbound(ACCOUNT, { since, until, maxPages: 5, deadline: Date.now() - 1 })).complete).toBe(false);
    expect(late.seen).toHaveLength(1);

    const foreign = make(() => ({ status: 200, body: { messages: [], next_page_uri: `/2010-04-01/Accounts/${OTHER}/Messages.json?Page=1` } })).provider;
    await expect(foreign.listInbound(ACCOUNT, { since, until, maxPages: 5 })).rejects.toThrow("usage_evidence_mismatch");
    const wrongAccount = make(() => ({ status: 200, body: { messages: [{ sid: sidOf(1), account_sid: OTHER, direction: "inbound" }] } })).provider;
    await expect(wrongAccount.listInbound(ACCOUNT, { since, until, maxPages: 5 })).rejects.toThrow("usage_evidence_mismatch");
    const capped = make(() => ({ status: 200, body: { messages: [], next_page_uri: page2 } })).provider;
    expect((await capped.listInbound(ACCOUNT, { since, until, maxPages: 1 })).complete).toBe(false);
    await expect(make(() => ({ status: 200, body: {} }), false).provider.listInbound(ACCOUNT, { since, until, maxPages: 1 })).rejects.toThrow("usage_evidence_reads_disabled");
    await expect(make(() => ({ status: 500, body: {} })).provider.listInbound(ACCOUNT, { since, until, maxPages: 1 })).rejects.toThrow("usage_evidence_http_500");
  });
});
