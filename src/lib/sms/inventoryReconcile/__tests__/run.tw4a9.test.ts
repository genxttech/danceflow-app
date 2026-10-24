import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { FakeNumberAdapter } from "@/lib/sms/twilioIsv/fakeNumbers";
import { runScheduledInventoryReconcile, type NumberReadRuntime } from "../run";
import type { NumberStore } from "@/lib/sms/twilioIsv/numberStore";
import { RunnerStoreError } from "@/lib/sms/twilioIsv/store";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));

/**
 * TW-4F A9: the scheduled inventory-reconciliation pass. Run lease, budget, lease loss and fail-closed recording, against a scripted store and run-lease RPCs with
 * the FAKE number adapter (no provider, no database). The SQL lease itself is pinned in localStack.tw4a9.test.ts.
 */

const ACC1 = `AC${"1".repeat(32)}`;
const ACC2 = `AC${"2".repeat(32)}`;
const target = (n: number, account: string) => ({ studio_id: `studio-${n}`, legal_entity_id: `le-${n}`, twilio_account_sid: account, last_checked_at: null, reason: "due" });

/** Only what one reconciliation pass touches; anything else would throw. */
function store(targets = [target(1, ACC1), target(2, ACC2)]) {
  const log: string[] = [];
  const s = {
    log,
    targets,
    known: [] as string[],
    async reconTargets() { log.push("targets"); return s.targets; },
    async claimRecon(studioId: string) { log.push(`claim:${studioId}`); return { onboarding_id: `ob-${studioId}`, studio_id: studioId, state: "active", submission_seq: 1 }; },
    async claim(studioId: string) { return s.claimRecon(studioId); },
    async getAccount(onboardingId: string) { return { legalEntityId: "le", accountSid: onboardingId.endsWith("2") ? ACC2 : ACC1, status: "active" }; },
    async inventoryObserve(_o: string, _l: string, numbers: { sid: string }[]) {
      log.push(`inventory:${numbers.length}`);
      return { listed: numbers.length, unknown: numbers.filter((n) => !s.known.includes(n.sid)).length, missing: 0, mismatch: 0, duplicate: 0 };
    },
    async release(onboardingId: string) { log.push(`release:${onboardingId}`); },
    async reconMark(entity: string) { log.push(`mark:${entity}`); },
    async escalateOrphans() { log.push("escalate"); return { outbox: true, raised: 0, considered: 0, failed: 0 }; },
  };
  return s;
}

type Rpc = { fn: string; args: Record<string, unknown> };
function admin(opts: { begin?: unknown; beginError?: boolean; alive?: (n: number) => boolean } = {}) {
  const calls: Rpc[] = [];
  let aliveChecks = 0;
  const client = {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "tw4_reconcile_run_begin") return opts.beginError ? { data: null, error: { code: "PGRST000" } } : { data: opts.begin ?? { acquired: true, run_id: "run-1" }, error: null };
      if (fn === "tw4_reconcile_run_alive") return { data: (opts.alive ?? (() => true))(++aliveChecks), error: null };
      if (fn === "tw4_reconcile_run_finish") return { data: { status: args.p_status }, error: null };
      return { data: null, error: { code: "42883" } };
    },
  };
  return client as unknown as Pick<SupabaseClient, "rpc"> & { calls: Rpc[] };
}
const finish = (a: ReturnType<typeof admin>) => a.calls.find((c) => c.fn === "tw4_reconcile_run_finish")?.args as { p_status: string; p_summary: Record<string, unknown>; p_error: string | null } | undefined;
const fakeRuntime = (s: ReturnType<typeof store>, adapters: Record<string, FakeNumberAdapter>): NumberReadRuntime => ({
  ok: true, store: s as unknown as NumberStore, adapterFor: async (account) => {
    const a = adapters[account];
    if (!a) throw new Error("no credentials");
    return a;
  },
});

describe("scheduled inventory reconciliation (A9)", () => {
  it("takes the 'inventory_reconcile' run lease; busy and an unavailable database run nothing", async () => {
    const s = store();
    const busy = admin({ begin: { acquired: false, reason: "busy" } });
    expect(await runScheduledInventoryReconcile(busy, fakeRuntime(s, {}), { runner: "cron:test" })).toEqual({ ran: false, reason: "busy" });
    expect(busy.calls[0]).toEqual({ fn: "tw4_reconcile_run_begin", args: { p_job: "inventory_reconcile", p_runner: "cron:test", p_lease_seconds: 120 } });
    const down = admin({ beginError: true });
    expect(await runScheduledInventoryReconcile(down, fakeRuntime(s, {}), { runner: "cron:test" })).toEqual({ ran: false, reason: "unavailable" });
    expect(s.log).toEqual([]);
    expect([...busy.calls, ...down.calls].some((c) => c.fn === "tw4_reconcile_run_finish")).toBe(false);
  });

  it("gates off: nothing is read or called and the run is recorded FAILED (health stays visibly stale)", async () => {
    const a = admin();
    const out = await runScheduledInventoryReconcile(a, { ok: false, reason: "Twilio provisioning calls are switched off." }, { runner: "cron:test" });
    expect(out).toMatchObject({ ran: true, failed: true });
    expect(finish(a)).toMatchObject({ p_status: "failed", p_error: "inventory reconcile: number reads unavailable" });
    expect(finish(a)?.p_summary).toMatchObject({ reads_available: false, checked: 0, clean: 0 });
    expect(a.calls.map((c) => c.fn)).toEqual(["tw4_reconcile_run_begin", "tw4_reconcile_run_finish"]);
  });

  it("with the fake adapter: lists each due subaccount with its own adapter, counts clean and findings, and completes", async () => {
    const s = store();
    const one = new FakeNumberAdapter(ACC1);
    const two = new FakeNumberAdapter(ACC2);
    two.seedOwned("+12025550199");   // a number the ledger does not know: a finding, never clean
    const a = admin();
    const out = await runScheduledInventoryReconcile(a, fakeRuntime(s, { [ACC1]: one, [ACC2]: two }), { runner: "cron:test" });
    expect(out).toMatchObject({ ran: true, failed: false });
    expect(s.log.filter((e) => e.startsWith("inventory:"))).toEqual(["inventory:0", "inventory:1"]);
    expect(finish(a)).toMatchObject({ p_status: "completed", p_error: null });
    expect(finish(a)?.p_summary).toMatchObject({ checked: 2, clean: 1, findings: 1, skipped: 0, stopped: 0, errors: 0, reads_available: true, out_of_time: false });
    // counts only: no studio, account or number in the recorded summary
    expect(JSON.stringify(finish(a)?.p_summary)).not.toMatch(/studio-|AC[0-9]|PN[0-9]|\+1/);
  });

  it("a subaccount whose adapter cannot be built is skipped and counted as an error, never as clean", async () => {
    const s = store();
    const a = admin();
    const out = await runScheduledInventoryReconcile(a, fakeRuntime(s, { [ACC1]: new FakeNumberAdapter(ACC1) }), { runner: "cron:test" });
    expect(out).toMatchObject({ ran: true, failed: false });
    expect(finish(a)?.p_summary).toMatchObject({ checked: 1, clean: 1, skipped: 1, errors: 1 });
    expect(s.log).toContain("mark:le-2");
  });

  it("a lost lease stops the pass before the next subaccount and records the run FAILED", async () => {
    const s = store();
    const a = admin({ alive: (n) => n === 1 });
    const out = await runScheduledInventoryReconcile(a, fakeRuntime(s, { [ACC1]: new FakeNumberAdapter(ACC1), [ACC2]: new FakeNumberAdapter(ACC2) }), { runner: "cron:test" });
    expect(out).toMatchObject({ ran: true, failed: true });
    expect(s.log.filter((e) => e.startsWith("claim:"))).toEqual(["claim:studio-1"]);
    expect(finish(a)).toMatchObject({ p_status: "failed", p_error: "inventory reconcile: run lease lost" });
    expect(finish(a)?.p_summary).toMatchObject({ checked: 1, stopped: 1 });
    expect(s.log).not.toContain("escalate");   // a run that lost its lease does not escalate
  });

  it("the time budget stops the pass: the rest stay due (stopped, never clean), escalation waits for the next pass, and the backlog counts as an error", async () => {
    const s = store();
    let t = 0;
    const a = admin();
    const out = await runScheduledInventoryReconcile(a, fakeRuntime(s, { [ACC1]: new FakeNumberAdapter(ACC1), [ACC2]: new FakeNumberAdapter(ACC2) }), {
      runner: "cron:test", budgetMs: 10, now: () => (t += 6),
    });
    expect(out).toMatchObject({ ran: true, failed: false });
    expect(finish(a)?.p_summary).toMatchObject({ checked: 1, stopped: 1, out_of_time: true, errors: 1, escalation_raised: 0 });
    expect(s.log).not.toContain("escalate");
  });

  it("the budget leaves room for one more subaccount inside maxDuration 60", async () => {
    const { INVENTORY_RECONCILE_BUDGET_MS, INVENTORY_RECONCILE_LEASE_SECONDS } = await import("../run");
    expect(INVENTORY_RECONCILE_BUDGET_MS).toBeLessThanOrEqual(60_000 - 25_000);   // a listing has a 20-second provider timeout, plus credentials and writes
    expect(INVENTORY_RECONCILE_LEASE_SECONDS).toBeGreaterThan(60);                // a live run cannot outlive its lease
  });

  it("a failing work list records the run FAILED", async () => {
    const s = store();
    s.reconTargets = async () => {
      throw new RunnerStoreError("XX000");
    };
    const a = admin();
    expect(await runScheduledInventoryReconcile(a, fakeRuntime(s, {}), { runner: "cron:test" })).toMatchObject({ ran: true, failed: true });
    expect(finish(a)).toMatchObject({ p_status: "failed", p_error: "inventory reconcile: work list unavailable" });
  });

  it("the production runtime with the real-call gates off is not ok, so the route can never reach a provider", async () => {
    const { buildNumberReadRuntime: buildNumberRuntime } = await import("../numberReadRuntime");
    expect(buildNumberRuntime({ NODE_ENV: "production", VERCEL_ENV: "production" }).ok).toBe(false);
    expect(buildNumberRuntime({}).ok).toBe(false);
  });
});
