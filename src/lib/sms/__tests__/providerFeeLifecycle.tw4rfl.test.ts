import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ProviderFeeError, ProviderFeeLifecycleStore, runProviderFeeLifecycleScan, type ProviderFeeAlert } from "../providerFeeLifecycle";

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
const storeWith = (rpc: Rpc) => new ProviderFeeLifecycleStore({ rpc } as never);

const alertRow = (n: number): Record<string, unknown> => ({ alert_id: `a${n}`, claim_token: `t${n}`, legal_entity_id: "e1", studio_id: null, kind: "exposure_open", audience: "both", severity: "critical", summary: "x".repeat(10) });

describe("ProviderFeeLifecycleStore", () => {
  it("maps every call to its function and arguments, and returns typed results", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const store = storeWith(async (fn, args) => {
      calls.push({ fn, args });
      const data: Record<string, unknown> = {
        tw4_rfl_register: { resource_id: "r1", fee_kind: "number", replayed: false },
        tw4_rfl_cancel_begin: { action: "execute", provider_sid: "PNx", resource_kind: "number" },
        tw4_rfl_studio_ready: { ready: false, blockers: ["open_exposure", 7] },
        tw4_rfl_scan_entities: [{ legal_entity_id: "e1" }, { legal_entity_id: "e2" }],
        tw4_rfl_alerts_claim: [alertRow(1)],
      };
      return { data: data[fn] ?? { replayed: true, operation_id: "o1", status: "confirmed", cover_id: "c1", updated: true }, error: null };
    });
    expect(await store.register({ studioId: "s", actorId: "a", kind: "number", providerSid: "PNx", accountSid: "ACx", e164: "+1555", source: "r2b" })).toEqual({ resourceId: "r1", feeKind: "number", replayed: false });
    expect(calls[0]).toEqual({ fn: "tw4_rfl_register", args: { p_studio_id: "s", p_actor: "a", p_kind: "number", p_provider_sid: "PNx", p_account_sid: "ACx", p_e164: "+1555", p_source: "r2b", p_source_operation: null, p_initial_reservation: null } });
    expect(await store.beginCancel("o1", "a")).toEqual({ action: "execute", providerSid: "PNx", resourceKind: "number" });
    expect(await store.studioReady("s")).toEqual({ ready: false, blockers: ["open_exposure"] });
    expect(await store.scanEntities()).toEqual(["e1", "e2"]);
    expect((await store.claimAlerts(5))[0]).toMatchObject({ id: "a1", claimToken: "t1", audience: "both", severity: "critical" });
    expect((await store.finishCancel("o1", "confirmed", "d".repeat(64), null, "a2")).status).toBe("confirmed");
    expect(calls.find((c) => c.fn === "tw4_rfl_cancel_finish")?.args).toEqual({ p_operation_id: "o1", p_actor: "a2", p_outcome: "confirmed", p_evidence_digest: "d".repeat(64), p_error_code: null });
  });

  it("a begin that is not 'execute' never yields a provider step", async () => {
    for (const action of ["in_progress", "reconcile"]) {
      const store = storeWith(async () => ({ data: { action }, error: null }));
      expect(await store.beginCancel("o", "a")).toEqual({ action });
    }
    const skip = storeWith(async () => ({ data: { action: "skip", status: "withdrawn" }, error: null }));
    expect(await skip.beginCancel("o", "a")).toEqual({ action: "skip", status: "withdrawn" });
    // an 'execute' without the identity it needs is not an execute
    const broken = storeWith(async () => ({ data: { action: "execute" }, error: null }));
    expect(await broken.beginCancel("o", "a")).toEqual({ action: "skip", status: "unknown" });
  });

  it("errors carry the SQLSTATE and never the database message", async () => {
    const store = storeWith(async () => ({ data: null, error: { code: "TW042", message: "secret detail about a tenant" } }));
    const error = await store.authorizeCancel("r", "ref", "owner_written", "reason", true, "a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderFeeError);
    expect((error as ProviderFeeError).code).toBe("TW042");
    expect(String((error as Error).message)).not.toContain("secret");
  });
});

describe("runProviderFeeLifecycleScan", () => {
  const makeStore = (over: Partial<Record<string, unknown>> = {}) => {
    const finished: Array<{ id: string; delivered: boolean; error: string | null }> = [];
    const store = {
      scanEntities: vi.fn(async () => ["e1", "e2", "e3"]),
      scanEntity: vi.fn(async (id: string) => {
        if (id === "e2") throw new Error("boom");
        return { opened: 1, closed: 2, alerts: 3 };
      }),
      inventoryGaps: vi.fn(async () => 4),
      claimAlerts: vi.fn(async () => [] as ProviderFeeAlert[]),
      finishAlert: vi.fn(async (id: string, _t: string, delivered: boolean, error: string | null) => {
        finished.push({ id, delivered, error });
        return true;
      }),
      ...over,
    };
    return { store: store as unknown as ProviderFeeLifecycleStore, finished, raw: store };
  };
  const makeOps = (over: Partial<Record<string, unknown>> = {}) => {
    const order: string[] = [];
    const finishes: Array<{ runId: string; status: string; summary: Record<string, unknown>; error: string | null }> = [];
    const ops = {
      scanBegin: vi.fn(async () => { order.push("begin"); return { ran: true, reason: null, runId: "run1" }; }),
      escalateDelivery: vi.fn(async () => { order.push("escalate"); return 2; }),
      releaseAlert: vi.fn(async () => true),
      // exactly like tw4_rfl_scan_finish: the summary must be a flat object whose values are all finite numbers (SQLSTATE 22023 otherwise)
      scanFinish: vi.fn(async (runId: string, status: string, summary: Record<string, unknown>, error: string | null) => {
        order.push("finish");
        const flat = summary !== null && typeof summary === "object" && !Array.isArray(summary);
        if (!flat || !Object.values(summary).every((v) => typeof v === "number" && Number.isFinite(v))) throw new ProviderFeeError("22023");
        finishes.push({ runId, status, summary, error });
        return true;
      }),
      ...over,
    };
    return { ops: ops as never, raw: ops, order, finishes };
  };
  const a = (n: number): ProviderFeeAlert => ({ id: `a${n}`, claimToken: `t${n}`, legalEntityId: "e1", studioId: null, kind: "exposure_open", audience: "both", severity: "critical", summary: "summary" });

  it("one business failing does not stop the others; counts are summed; without a sink nothing is claimed", async () => {
    const { store, raw } = makeStore();
    const { ops } = makeOps();
    const out = await runProviderFeeLifecycleScan(store, null, ops);
    expect(out).toEqual({ ran: true, ranReason: null, entities: 2, opened: 2, closed: 4, alertsCreated: 6, inventoryGaps: 4, escalated: 2, delivered: 0, failed: 0, errors: 1, deliveryEnabled: false, truncated: 0, deferred: 0, deliverySkipped: 0 });
    expect(raw.claimAlerts).not.toHaveBeenCalled();
  });

  it("delivers claimed alerts through the sink, marks failures (with a name, not the message), and never reports a delivery the database did not accept", async () => {
    let calls = 0;
    const finished: Array<{ id: string; delivered: boolean; error: string | null }> = [];
    const { store, raw } = makeStore({
      claimAlerts: vi.fn(async () => (calls++ === 0 ? [a(1), a(2), a(3)] : [])),
      finishAlert: vi.fn(async (id: string, _t: string, delivered: boolean, error: string | null) => {
        finished.push({ id, delivered, error });
        return id !== "a3"; // a stale claim: the database refuses it
      }),
    });
    const sink = { deliver: vi.fn(async (al: ProviderFeeAlert) => { if (al.id === "a2") throw new TypeError("smtp password leaked here"); }) };
    const out = await runProviderFeeLifecycleScan(store, sink, makeOps().ops);
    expect(out).toMatchObject({ delivered: 1, failed: 1, deliveryEnabled: true, errors: 1 });
    expect(finished).toEqual([{ id: "a1", delivered: true, error: null }, { id: "a2", delivered: false, error: "TypeError" }, { id: "a3", delivered: true, error: null }]);
    expect(raw.claimAlerts).toHaveBeenCalledTimes(1); // fewer than a full batch: stop
  });

  it("a scan that cannot list businesses still checks inventory gaps and reports the error", async () => {
    const { store } = makeStore({ scanEntities: vi.fn(async () => { throw new Error("db down"); }) });
    const out = await runProviderFeeLifecycleScan(store, null, makeOps().ops);
    expect(out).toMatchObject({ entities: 0, inventoryGaps: 4, errors: 1 });
  });

  it("a scan that cannot cover every business reports it (truncated, and an error) instead of staying silent", async () => {
    const many = Array.from({ length: 503 }, (_, i) => `e${i}`);
    const { store } = makeStore({ scanEntities: vi.fn(async () => many), scanEntity: vi.fn(async () => ({ opened: 0, closed: 0, alerts: 0 })) });
    const out = await runProviderFeeLifecycleScan(store, null, makeOps().ops);
    expect(out).toMatchObject({ entities: 500, truncated: 3, errors: 1 });
  });


  it("runs in contract order and ALWAYS finishes the heartbeat with counts only (completed when clean)", async () => {
    const order: string[] = [];
    const { store } = makeStore({
      scanEntities: vi.fn(async () => { order.push("entities"); return ["e1"]; }),
      scanEntity: vi.fn(async () => { order.push("entity"); return { opened: 0, closed: 0, alerts: 1 }; }),
      inventoryGaps: vi.fn(async () => { order.push("gaps"); return 0; }),
      claimAlerts: vi.fn(async () => { order.push("claim"); return []; }),
    });
    const { ops, order: opsOrder, finishes } = makeOps();
    // share one timeline
    (ops as unknown as { scanBegin: () => Promise<unknown> }).scanBegin = async () => { order.push("begin"); return { ran: true, reason: null, runId: "run1" }; };
    (ops as unknown as { escalateDelivery: () => Promise<number> }).escalateDelivery = async () => { order.push("escalate"); return 0; };
    (ops as unknown as { scanFinish: (...a: unknown[]) => Promise<boolean> }).scanFinish = async (runId, status, summary, error) => { order.push("finish"); expect(Object.values(summary as object).every((v) => typeof v === "number")).toBe(true); finishes.push({ runId: runId as string, status: status as string, summary: summary as Record<string, unknown>, error: error as string | null }); return true; };
    await runProviderFeeLifecycleScan(store, { deliver: async () => {} }, ops);
    expect(order).toEqual(["begin", "entities", "entity", "gaps", "escalate", "claim", "finish"]);
    expect(opsOrder).toEqual([]);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ runId: "run1", status: "completed", error: null });
    expect(Object.values(finishes[0].summary).every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
    expect(finishes[0].summary).toMatchObject({ deliveryEnabled: 1, deferred: 0 });
    expect(finishes[0].summary).not.toHaveProperty("ranReason");
  });

  it("escalation runs on every pass, including without a sink; nothing is claimed without a sink", async () => {
    const { store, raw } = makeStore();
    const { ops, raw: o } = makeOps();
    const out = await runProviderFeeLifecycleScan(store, null, ops);
    expect(o.escalateDelivery).toHaveBeenCalledTimes(1);
    expect(out.escalated).toBe(2);
    expect(raw.claimAlerts).not.toHaveBeenCalled();
  });

  it("stops without scanning when the heartbeat refuses (switched_off / busy / unknown reason) and finishes nothing", async () => {
    for (const [reason, expected] of [["switched_off", "switched_off"], ["busy", "busy"], ["weird", "unknown"], [null, "unknown"]] as const) {
      const { store, raw } = makeStore();
      const { ops, raw: o } = makeOps({ scanBegin: vi.fn(async () => ({ ran: false, reason, runId: null })) });
      const out = await runProviderFeeLifecycleScan(store, { deliver: async () => {} }, ops);
      expect(out).toMatchObject({ ran: false, ranReason: expected, errors: 0, entities: 0, deliveryEnabled: false });
      expect(raw.scanEntities).not.toHaveBeenCalled();
      expect(raw.claimAlerts).not.toHaveBeenCalled();
      expect(o.escalateDelivery).not.toHaveBeenCalled();
      expect(o.scanFinish).not.toHaveBeenCalled();
    }
  });

  it("a heartbeat that cannot begin (error, or no run id) stops with begin_failed and an error", async () => {
    for (const begin of [async () => { throw new Error("db"); }, async () => ({ ran: true, reason: null, runId: null })]) {
      const { store, raw } = makeStore();
      const { ops } = makeOps({ scanBegin: vi.fn(begin) });
      const out = await runProviderFeeLifecycleScan(store, null, ops);
      expect(out).toMatchObject({ ran: false, ranReason: "begin_failed", errors: 1 });
      expect(raw.scanEntities).not.toHaveBeenCalled();
    }
  });

  it("any error (a failing business, a failing escalation) finishes the run as failed; a failing finish is an error too", async () => {
    const { store } = makeStore();
    const { ops, finishes } = makeOps();
    await runProviderFeeLifecycleScan(store, null, ops);
    expect(finishes[0]).toMatchObject({ status: "failed", error: "scan_errors" });

    const clean = makeStore({ scanEntity: vi.fn(async () => ({ opened: 0, closed: 0, alerts: 0 })) });
    const failingEscalation = makeOps({ escalateDelivery: vi.fn(async () => { throw new Error("db"); }) });
    const out = await runProviderFeeLifecycleScan(clean.store, null, failingEscalation.ops);
    expect(out.errors).toBe(1);
    expect(failingEscalation.finishes[0].status).toBe("failed");

    const badFinish = makeOps({ scanFinish: vi.fn(async () => { throw new Error("db"); }) });
    const out2 = await runProviderFeeLifecycleScan(makeStore({ scanEntity: vi.fn(async () => ({ opened: 0, closed: 0, alerts: 0 })) }).store, null, badFinish.ops);
    expect(out2.errors).toBe(1);
  });

  it("an unexpected exception inside the pass still finishes the heartbeat as failed", async () => {
    const { store } = makeStore({ claimAlerts: vi.fn(async () => { throw new Error("db"); }) });
    const { ops, finishes } = makeOps();
    const out = await runProviderFeeLifecycleScan(store, { deliver: async () => {} }, ops);
    expect(out.errors).toBeGreaterThan(0);
    expect(finishes).toHaveLength(1);
    expect(finishes[0].status).toBe("failed");
  });

  it("the heartbeat summary is accepted by a SQL-faithful validator on every pass (a boolean in it would leave the run 'running')", async () => {
    const { store } = makeStore();
    const { ops, finishes } = makeOps();
    const out = await runProviderFeeLifecycleScan(store, { deliver: async () => {} }, ops);
    expect(finishes).toHaveLength(1);   // the strict fake would have thrown (and added an error) otherwise
    expect(out.errors).toBe(1);   // only the failing business e2, not a rejected finish
  });

  it("alert delivery is bounded: ONE claim per pass, capped at 20 alerts", async () => {
    const claim = vi.fn(async () => Array.from({ length: 20 }, (_, i) => a(i)));
    const { store } = makeStore({ claimAlerts: claim });
    const out = await runProviderFeeLifecycleScan(store, { deliver: async () => {} }, makeOps().ops);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(20);
    expect(out.delivered).toBe(20);
  });

  it("time budget: alerts not started within the delivery budget are RELEASED (not finished as failed), counted in deferred, and the heartbeat still finishes", async () => {
    let t = 0;
    const { store, raw } = makeStore({ scanEntities: vi.fn(async () => []), claimAlerts: vi.fn(async () => [a(1), a(2), a(3), a(4), a(5)]) });
    const { ops, raw: o, finishes } = makeOps();
    const out = await runProviderFeeLifecycleScan(store, { deliver: async () => { t += 15_000; } }, ops, { now: () => t, budgetMs: 40_000 });
    expect(out).toMatchObject({ delivered: 3, failed: 0, deferred: 2, deliverySkipped: 0, errors: 0, ran: true });
    expect(o.releaseAlert.mock.calls).toEqual([["a4", "t4"], ["a5", "t5"]]);
    expect(raw.finishAlert).toHaveBeenCalledTimes(3);   // the released ones are never marked failed
    expect(finishes[0]).toMatchObject({ status: "completed" });
    expect(finishes[0].summary).toMatchObject({ deferred: 2, deliverySkipped: 0 });
  });

  it("a release that errors leaves the alert 'sending' (an error, never marked failed); a refused release is not counted as deferred", async () => {
    let t = 0;
    const { store, raw } = makeStore({ scanEntities: vi.fn(async () => []), claimAlerts: vi.fn(async () => [a(1), a(2)]) });
    const { ops, finishes } = makeOps({ releaseAlert: vi.fn(async () => { throw new Error("db"); }) });
    const out = await runProviderFeeLifecycleScan(store, { deliver: async () => { t += 60_000; } }, ops, { now: () => t });
    expect(out).toMatchObject({ delivered: 1, deferred: 0, errors: 1 });
    expect(raw.finishAlert).toHaveBeenCalledTimes(1);
    expect(finishes[0].status).toBe("failed");
    const refused = makeOps({ releaseAlert: vi.fn(async () => false) });
    t = 0;
    const out2 = await runProviderFeeLifecycleScan(makeStore({ scanEntities: vi.fn(async () => []), claimAlerts: vi.fn(async () => [a(1), a(2)]) }).store, { deliver: async () => { t += 60_000; } }, refused.ops, { now: () => t });
    expect(out2).toMatchObject({ deferred: 0, errors: 0 });
  });

  it("the delivery budget is measured from the START OF DELIVERY; with too little of the pass left the claim is skipped entirely (nothing claimed, nothing burned)", async () => {
    let t = 0;
    const { store, raw } = makeStore({ inventoryGaps: vi.fn(async () => { t += 45_000; return 0; }), scanEntities: vi.fn(async () => []) });
    const { ops, raw: o } = makeOps();
    const out = await runProviderFeeLifecycleScan(store, { deliver: async () => {} }, ops, { now: () => t });
    expect(out).toMatchObject({ deliverySkipped: 1, deferred: 0, delivered: 0, errors: 0 });
    expect(raw.claimAlerts).not.toHaveBeenCalled();
    expect(o.releaseAlert).not.toHaveBeenCalled();
    // a 30 s scan: delivery still starts, its deadline is bounded by the 50 s pass deadline (20 s left): starts at 30, 38, 46 s; the fourth (54 s) is released
    t = 0;
    const mid = makeStore({ inventoryGaps: vi.fn(async () => { t += 30_000; return 0; }), scanEntities: vi.fn(async () => []), claimAlerts: vi.fn(async () => [a(1), a(2), a(3), a(4)]) });
    const midOps = makeOps();
    const out2 = await runProviderFeeLifecycleScan(mid.store, { deliver: async () => { t += 8_000; } }, midOps.ops, { now: () => t });
    expect(out2).toMatchObject({ deliverySkipped: 0, delivered: 3, deferred: 1 });
    expect(midOps.raw.releaseAlert).toHaveBeenCalledWith("a4", "t4");
  });

  describe("each alert is attempted at most once per pass (claim burns an attempt and re-offers failed rows immediately)", () => {
    /** A database fake like tw4_rfl_alerts_claim: oldest first, claim increments attempts, failed rows are re-claimable at once, attempts < 5. */
    function db(count: number, onScan: () => void = () => {}) {
      const rows = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, attempts: 0, status: "pending", token: "" }));
      let n = 0;
      const store = {
        scanEntities: async () => { onScan(); return []; }, scanEntity: vi.fn(), inventoryGaps: async () => 0,
        claimAlerts: vi.fn(async (limit: number) => {
          const picked = rows.filter((r) => (r.status === "pending" || r.status === "failed") && r.attempts < 5).slice(0, limit);
          return picked.map((r) => { r.status = "sending"; r.attempts += 1; r.token = `t${n++}`; return { ...a(0), id: r.id, claimToken: r.token }; });
        }),
        release: (id: string, token: string) => {
          const r = rows.find((x) => x.id === id)!;
          if (r.status !== "sending" || r.token !== token) return false;
          r.status = "pending";
          r.attempts = Math.max(r.attempts - 1, 0);
          return true;
        },
        finishAlert: vi.fn(async (id: string, token: string, delivered: boolean) => {
          const r = rows.find((x) => x.id === id)!;
          if (r.token !== token) return false;
          r.status = delivered ? "delivered" : "failed";
          return true;
        }),
      };
      return { rows, store: store as unknown as ProviderFeeLifecycleStore, raw: store };
    }

    it("a slow scan + 10 passes never exhausts or escalates an untried alert (delivery skipped; claims are never burned)", async () => {
      let t = 0;
      const d = db(6, () => { t += 45_000; });
      const { ops, raw } = makeOps({ releaseAlert: vi.fn(async (id: string, token: string) => d.raw.release(id, token)) });
      for (let pass = 0; pass < 10; pass += 1) {
        t = 0;
        await runProviderFeeLifecycleScan(d.store, { deliver: async () => {} }, ops, { now: () => t });
      }
      expect(d.raw.claimAlerts).not.toHaveBeenCalled();
      expect(d.rows.every((r) => r.attempts === 0 && r.status === "pending")).toBe(true);
      expect(raw.releaseAlert).not.toHaveBeenCalled();
    });

    it("alerts claimed but not started are released with the attempt restored: untried alerts never lose an attempt, the tried one gains exactly one per pass", async () => {
      let t = 0;
      const d = db(6);
      const { ops } = makeOps({ releaseAlert: vi.fn(async (id: string, token: string) => d.raw.release(id, token)) });
      for (let pass = 1; pass <= 4; pass += 1) {
        t = 0;
        // the first alert takes the whole budget and fails; the other five are claimed but never started
        await runProviderFeeLifecycleScan(d.store, { deliver: async () => { t += 60_000; throw new Error("down"); } }, ops, { now: () => t });
        expect(d.rows[0].attempts).toBe(pass);
        expect(d.rows.slice(1).every((r) => r.attempts === 0 && r.status === "pending")).toBe(true);
      }
    });

    it("release errors do not mark anything failed and do not burn further attempts", async () => {
      let t = 0;
      const d = db(3);
      const { ops } = makeOps({ releaseAlert: vi.fn(async () => { throw new Error("db"); }) });
      await runProviderFeeLifecycleScan(d.store, { deliver: async () => { t += 60_000; } }, ops, { now: () => t });
      expect(d.rows.map((r) => [r.status, r.attempts])).toEqual([["delivered", 1], ["sending", 1], ["sending", 1]]);   // left 'sending' (re-claimable after 15 min in the database)
    });

    it("a failing sink adds exactly 1 attempt per alert per pass, however many alerts exist", async () => {
      const d = db(12);
      const failing = { deliver: async () => { throw new Error("down"); } };
      await runProviderFeeLifecycleScan(d.store, failing, makeOps().ops);
      expect(d.rows.map((r) => r.attempts)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
      await runProviderFeeLifecycleScan(d.store, failing, makeOps().ops);
      expect(d.rows.every((r) => r.attempts === 2)).toBe(true);
      expect(d.raw.claimAlerts).toHaveBeenCalledTimes(2);
    });

    it("newer alerts are not starved: with more failing old alerts than one pass covers, later passes still go on, and a recovered sink delivers everything", async () => {
      const d = db(25);
      let failing = true;
      const sink = { deliver: async () => { if (failing) throw new Error("down"); } };
      await runProviderFeeLifecycleScan(d.store, sink, makeOps().ops, { maxAlerts: 20 });
      expect(d.rows.slice(0, 20).every((r) => r.attempts === 1)).toBe(true);
      expect(d.rows.slice(20).every((r) => r.attempts === 0)).toBe(true);   // beyond this pass's cap: untouched
      failing = false;
      const out = await runProviderFeeLifecycleScan(d.store, sink, makeOps().ops, { maxAlerts: 20 });
      expect(out.delivered).toBe(20);
      await runProviderFeeLifecycleScan(d.store, sink, makeOps().ops, { maxAlerts: 20 });
      expect(d.rows.every((r) => r.status === "delivered")).toBe(true);
      expect(d.rows.every((r) => r.attempts <= 2)).toBe(true);
    });

    it("an id offered twice by a claim is attempted once", async () => {
      const deliver = vi.fn(async () => {});
      const { store } = makeStore({ claimAlerts: vi.fn(async () => [a(1), a(1), a(2)]) });
      const out = await runProviderFeeLifecycleScan(store, { deliver }, makeOps().ops);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(out.delivered).toBe(2);
    });
  });
});
