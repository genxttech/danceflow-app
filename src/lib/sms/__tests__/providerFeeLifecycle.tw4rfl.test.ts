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
  const a = (n: number): ProviderFeeAlert => ({ id: `a${n}`, claimToken: `t${n}`, legalEntityId: "e1", studioId: null, kind: "exposure_open", audience: "both", severity: "critical", summary: "summary" });

  it("one business failing does not stop the others; counts are summed; without a sink nothing is claimed", async () => {
    const { store, raw } = makeStore();
    const out = await runProviderFeeLifecycleScan(store, null);
    expect(out).toEqual({ entities: 2, opened: 2, closed: 4, alertsCreated: 6, inventoryGaps: 4, delivered: 0, failed: 0, errors: 1, deliveryEnabled: false, truncated: 0 });
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
    const out = await runProviderFeeLifecycleScan(store, sink);
    expect(out).toMatchObject({ delivered: 1, failed: 1, deliveryEnabled: true, errors: 1 });
    expect(finished).toEqual([{ id: "a1", delivered: true, error: null }, { id: "a2", delivered: false, error: "TypeError" }, { id: "a3", delivered: true, error: null }]);
    expect(raw.claimAlerts).toHaveBeenCalledTimes(1); // fewer than a full batch: stop
  });

  it("a scan that cannot list businesses still checks inventory gaps and reports the error", async () => {
    const { store } = makeStore({ scanEntities: vi.fn(async () => { throw new Error("db down"); }) });
    const out = await runProviderFeeLifecycleScan(store, null);
    expect(out).toMatchObject({ entities: 0, inventoryGaps: 4, errors: 1 });
  });

  it("a scan that cannot cover every business reports it (truncated, and an error) instead of staying silent", async () => {
    const many = Array.from({ length: 503 }, (_, i) => `e${i}`);
    const { store } = makeStore({ scanEntities: vi.fn(async () => many), scanEntity: vi.fn(async () => ({ opened: 0, closed: 0, alerts: 0 })) });
    const out = await runProviderFeeLifecycleScan(store, null);
    expect(out).toMatchObject({ entities: 500, truncated: 3, errors: 1 });
  });

  it("alert delivery is bounded: at most 8 batches per run", async () => {
    const claim = vi.fn(async () => Array.from({ length: 25 }, (_, i) => a(i)));
    const { store } = makeStore({ claimAlerts: claim });
    await runProviderFeeLifecycleScan(store, { deliver: async () => {} });
    expect(claim).toHaveBeenCalledTimes(8);
  });
});
