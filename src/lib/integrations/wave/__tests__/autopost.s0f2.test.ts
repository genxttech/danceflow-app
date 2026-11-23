/* eslint-disable @typescript-eslint/no-explicit-any -- loose in-memory PostgREST fake */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, any>;
let db: Record<string, Row[]> = {};
let failures: Record<string, string> = {}; // "<table>:<insert|update>" -> error message
let rpcResult: { data: string | null; error: { message: string } | null } = { data: null, error: null };
const rpcCalls: Array<{ name: string; args: any }> = [];

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" | "insert" = "select";
  let patch: Row = {};
  let headCount = false;
  let limitN = Infinity;
  const rows = () => (db[name] ??= []);
  const run = () => {
    const hit = rows().filter((r) => filters.every((f) => f(r)));
    if (mode === "update" && !failures[`${name}:update`]) hit.forEach((r) => Object.assign(r, patch));
    return hit.slice(0, limitN);
  };
  const settle = () => {
    if (mode === "insert") {
      const msg = failures[`${name}:insert`];
      if (msg) return { error: { message: msg }, data: null };
      rows().push({ ...patch });
      return { error: null, data: null };
    }
    if (mode === "update" && failures[`${name}:update`]) return { error: { message: failures[`${name}:update`] }, data: null };
    const data = run();
    return headCount ? { error: null, data: null, count: data.length } : { error: null, data };
  };
  const builder: any = {
    select: (_c?: string, o?: { head?: boolean }) => { headCount = Boolean(o?.head); return builder; },
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return builder; },
    neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return builder; },
    in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return builder; },
    order: () => builder,
    limit: (n: number) => { limitN = n; return builder; },
    update: (p: Row) => { mode = "update"; patch = p; return builder; },
    insert: (p: Row) => { mode = "insert"; patch = p; return builder; },
    single: async () => { const d = run(); return d.length ? { data: d[0], error: null } : { data: null, error: { message: "not found" } }; },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: any) => resolve(settle()),
  };
  return builder;
}
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (n: string) => table(n),
    rpc: async (name: string, args: any) => { rpcCalls.push({ name, args }); return rpcResult; },
  }),
}));

const createTx = vi.fn();
const tokenFn = vi.fn();
vi.mock("@/lib/integrations/wave/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/wave/client")>()),
  createWaveMoneyTransaction: (...a: unknown[]) => createTx(...a),
}));
vi.mock("@/lib/integrations/wave/token", () => ({ getValidWaveAccessToken: (...a: unknown[]) => tokenFn(...a) }));

import { runWaveAutoPost } from "../autopost";
import { WavePostingUncertainError } from "../client";

const CONN = { id: "c1", studio_id: "s1", wave_business_id: "biz1", is_classic_accounting: false, scopes: ["transaction:write"], posting_enabled: true, posting_mode: "auto_post_safe", status: "connected" };
const RUN = { id: "r1", studio_id: "s1", connection_id: "c1", status: "approved", configuration_snapshot: { waveBusinessId: "biz1" } };
const LINE = { id: "l1", run_id: "r1", entry_date: "2026-11-01", category: "tuition", direction: "credit", amount: "12.5", currency: "USD", wave_category_account_id: "a1", wave_anchor_account_id: "a2", wave_external_id: "ext1", anchor_normal_balance_type: "DEBIT", source_count: 2, posting_status: "posting" };

function seed(over: { conn?: Row; run?: Row; entitlement?: Row | null; extraLines?: Row[] } = {}) {
  db = {
    studio_wave_connections: [{ ...CONN, ...over.conn }],
    studio_wave_posting_entitlements: over.entitlement === null ? [] : [{ studio_id: "s1", status: "active", ...over.entitlement }],
    studio_wave_sync_runs: [{ ...RUN, ...over.run }],
    studio_wave_sync_lines: [{ ...LINE }, ...(over.extraLines ?? [])],
    studio_wave_audit_events: [],
  };
  rpcResult = { data: "l1", error: null };
}
const audits = () => db.studio_wave_audit_events.map((e) => e.outcome);

beforeEach(() => {
  process.env.WAVE_POSTING_ENABLED = "true";
  failures = {}; rpcCalls.length = 0; createTx.mockReset(); tokenFn.mockReset();
  tokenFn.mockResolvedValue("tok"); createTx.mockResolvedValue("tx-1");
  seed();
});
afterEach(() => { delete process.env.WAVE_POSTING_ENABLED; });

describe("runWaveAutoPost (S0-f2)", () => {
  it("does nothing when the environment switch is off", async () => {
    delete process.env.WAVE_POSTING_ENABLED;
    const r = await runWaveAutoPost();
    expect(r.messages[0]).toMatch(/disabled/);
    expect(rpcCalls).toHaveLength(0);
    expect(createTx).not.toHaveBeenCalled();
  });

  it("posts a claimed line, completes the run, and writes started+succeeded audit rows", async () => {
    const r = await runWaveAutoPost();
    expect(r).toMatchObject({ claimedLines: 1, postedLines: 1, completedRuns: 1, failedRuns: 0, uncertainRuns: 0 });
    expect(rpcCalls[0]).toEqual({ name: "claim_next_wave_sync_line_for_autopost", args: { target_run_id: "r1" } });
    expect(db.studio_wave_sync_lines[0]).toMatchObject({ posting_status: "posted", wave_transaction_id: "tx-1" });
    expect(db.studio_wave_sync_runs[0].status).toBe("posted");
    expect(audits()).toEqual(["started", "succeeded"]);
    // external id is the idempotency key; anchor normal-balance DEBIT + credit line => DEPOSIT
    const input = createTx.mock.calls[0][1];
    expect(input.externalId).toBe("ext1");
    expect(input.anchor).toEqual({ accountId: "a2", amount: "12.50", direction: "DEPOSIT" });
    expect(input.lineItems[0]).toMatchObject({ accountId: "a1", balance: "CREDIT" });
  });

  it("does not mark the run posted while other lines are still unposted", async () => {
    seed({ extraLines: [{ ...LINE, id: "l2", posting_status: "pending" }] });
    const r = await runWaveAutoPost();
    expect(r.postedLines).toBe(1);
    expect(r.completedRuns).toBe(0);
    expect(db.studio_wave_sync_runs[0].status).toBe("approved");
  });

  it.each([
    ["missing transaction:write scope", { scopes: ["user:read"] }],
    ["classic accounting business", { is_classic_accounting: true }],
    ["no business selected", { wave_business_id: null }],
  ])("skips a connection with %s", async (_n, conn) => {
    seed({ conn });
    const r = await runWaveAutoPost();
    expect(r.skippedRuns).toBe(1);
    expect(rpcCalls).toHaveLength(0);
    expect(createTx).not.toHaveBeenCalled();
  });

  it.each([["no entitlement row", null], ["suspended entitlement", { status: "suspended" }]])("skips a studio with %s", async (_n, ent) => {
    seed({ entitlement: ent as Row | null });
    const r = await runWaveAutoPost();
    expect(r.skippedRuns).toBe(1);
    expect(rpcCalls).toHaveLength(0);
  });

  it("parks a run whose Wave business changed after approval, without claiming", async () => {
    seed({ run: { configuration_snapshot: { waveBusinessId: "other" } } });
    const r = await runWaveAutoPost();
    expect(db.studio_wave_sync_runs[0].status).toBe("attention_required");
    expect(r.skippedRuns).toBe(1);
    expect(rpcCalls).toHaveLength(0);
    expect(createTx).not.toHaveBeenCalled();
  });

  it("skips when the claim returns no line (another worker holds it / nothing left)", async () => {
    rpcResult = { data: null, error: null };
    const r = await runWaveAutoPost();
    expect(r.claimedLines).toBe(0);
    expect(r.skippedRuns).toBe(1);
    expect(createTx).not.toHaveBeenCalled();
  });

  it("counts a claim RPC error as a failed run and posts nothing", async () => {
    rpcResult = { data: null, error: { message: "claim boom" } };
    const r = await runWaveAutoPost();
    expect(r.failedRuns).toBe(1);
    expect(r.messages[0]).toContain("claim boom");
    expect(createTx).not.toHaveBeenCalled();
  });

  it("an uncertain Wave outcome marks the line uncertain and the run attention_required (never retried blindly)", async () => {
    createTx.mockRejectedValue(new WavePostingUncertainError("Wave returned 503."));
    const r = await runWaveAutoPost();
    expect(r.uncertainRuns).toBe(1);
    expect(r.failedRuns).toBe(0);
    expect(db.studio_wave_sync_lines[0].posting_status).toBe("uncertain");
    expect(db.studio_wave_sync_runs[0].status).toBe("attention_required");
    expect(audits()).toEqual(["started", "uncertain"]);
  });

  it("a definite Wave rejection marks the line failed and the run failed", async () => {
    createTx.mockRejectedValue(new Error("amount: invalid"));
    const r = await runWaveAutoPost();
    expect(r.failedRuns).toBe(1);
    expect(db.studio_wave_sync_lines[0].posting_status).toBe("failed");
    expect(db.studio_wave_sync_runs[0].status).toBe("failed");
    expect(audits()).toEqual(["started", "failed"]);
  });

  it("if the start audit cannot be written, the line returns to pending and Wave is never called", async () => {
    failures["studio_wave_audit_events:insert"] = "audit down";
    const r = await runWaveAutoPost();
    expect(createTx).not.toHaveBeenCalled();
    expect(db.studio_wave_sync_lines[0].posting_status).toBe("pending");
    expect(r.failedRuns).toBe(1);
  });

  it("if Wave succeeded but the result cannot be saved, the outcome is uncertain, not failed", async () => {
    failures["studio_wave_sync_lines:update"] = "db down";
    const r = await runWaveAutoPost();
    expect(createTx).toHaveBeenCalledTimes(1);
    expect(r.uncertainRuns).toBe(1);
    expect(r.postedLines).toBe(0);
  });

  it("an anchor with no normal-balance type fails before any Wave call", async () => {
    db.studio_wave_sync_lines[0].anchor_normal_balance_type = null;
    const r = await runWaveAutoPost();
    expect(createTx).not.toHaveBeenCalled();
    expect(r.failedRuns).toBe(1);
    expect(db.studio_wave_sync_lines[0].posting_status).toBe("failed");
  });
});
