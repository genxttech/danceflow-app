import { describe, expect, it, vi } from "vitest";
import {
  RECONCILE_MODE,
  RECONCILE_OUTCOMES,
  ReconcileRpcError,
  classifyOutcome,
  createSupabaseReconcileRpc,
  previewStudio,
  runReconcilePreview,
  type PreviewRow,
  type ReconcileBudget,
  type ReconcileDeps,
  type ReconcileOutcome,
  type StudioGateStatus,
} from "@/lib/intake/reconcilePreview";

const OPEN_STATUS: StudioGateStatus = {
  enabled: true,
  enabledAt: "2026-10-01T00:00:00Z",
  gateAOpen: false,
  newObligationAllowed: true,
  defaultTemplateConfigured: true,
  assignmentCount: 0,
};

function row(n: number, outcome: ReconcileOutcome): PreviewRow {
  return {
    appointmentId: `a-${n}`,
    clientId: `c-${n}`,
    apptCreatedAt: `2026-10-02T00:00:${String(n % 60).padStart(2, "0")}Z`,
    outcome,
    templateId: null,
    versionNumber: null,
  };
}

function makeDeps(overrides: Partial<ReconcileDeps> & { rows?: PreviewRow[]; status?: StudioGateStatus } = {}) {
  const rows = overrides.rows ?? [];
  const status = overrides.status ?? OPEN_STATUS;
  const preview = vi.fn(async (_studio: string, limit: number, cursor: { createdAt: string; id: string } | null) => {
    const start = cursor ? rows.findIndex((r) => r.appointmentId === cursor.id) + 1 : 0;
    return rows.slice(start, start + limit);
  });
  const rpc = { status: vi.fn(async () => status), preview };
  const deps: ReconcileDeps = {
    rpc: overrides.rpc ?? rpc,
    hasEntitlement: overrides.hasEntitlement ?? (async () => true),
    nowMs: overrides.nowMs,
  };
  return { deps, rpc, preview };
}

const BUDGET: ReconcileBudget = { maxStudios: 3, pageSize: 2, maxPagesPerStudio: 2, studioTimeBudgetMs: 1000 };

describe("outcome classification", () => {
  it("classifies every outcome and only create-type outcomes can create work", () => {
    const creators = RECONCILE_OUTCOMES.filter((o) => classifyOutcome(o) === "would_create");
    expect(creators.sort()).toEqual(["would_create", "would_create_reintake"]);
    for (const o of RECONCILE_OUTCOMES) expect(classifyOutcome(o)).toBeTruthy();
  });
  it("never treats lead/inquiry-like or historical states as creatable", () => {
    for (const o of ["existing_student", "imported_source", "before_enablement", "appointment_started", "appointment_not_live", "type_not_qualifying", "erasure_barrier"] as const) {
      expect(classifyOutcome(o)).toBe("not_applicable");
    }
  });
});

describe("previewStudio", () => {
  it("is preview-only and counts outcomes", async () => {
    const { deps } = makeDeps({ rows: [row(1, "would_create"), row(2, "existing_student")] });
    const result = await previewStudio("s1", deps, BUDGET);
    expect(RECONCILE_MODE).toBe("preview_only");
    expect(result.state).toBe("previewed");
    expect(result.counts).toEqual({ would_create: 1, existing_student: 1 });
    expect(result.classes).toEqual({ would_create: 1, not_applicable: 1 });
    expect(result.persistenceBlockedBy).toEqual(["gate_a_closed"]);
    expect(result.truncated).toBe(false);
  });

  it("reports the persistence blockers separately", async () => {
    const { deps } = makeDeps({ status: { ...OPEN_STATUS, gateAOpen: false, newObligationAllowed: false } });
    const result = await previewStudio("s1", deps, BUDGET);
    expect(result.persistenceBlockedBy).toEqual(["gate_a_closed", "new_obligation_not_allowed"]);
  });

  it("pages with a keyset cursor and stops at the page cap, flagging truncation", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, "would_create"));
    const { deps, preview } = makeDeps({ rows });
    const result = await previewStudio("s1", deps, BUDGET);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(result.examined).toBe(4);
    expect(result.truncated).toBe(true);
    expect(preview.mock.calls[1][2]).toEqual({ createdAt: rows[1].apptCreatedAt, id: "a-1" });
  });

  it("is not truncated when the list ends inside the budget", async () => {
    const { deps } = makeDeps({ rows: [row(1, "would_create"), row(2, "would_create"), row(3, "would_attach")] });
    const result = await previewStudio("s1", deps, BUDGET);
    expect(result.examined).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("stops on the time budget", async () => {
    let t = 0;
    const rows = Array.from({ length: 20 }, (_, i) => row(i, "would_create"));
    const { deps, preview } = makeDeps({ rows, nowMs: () => (t += 600) });
    const result = await previewStudio("s1", deps, { ...BUDGET, maxPagesPerStudio: 10 });
    expect(result.truncated).toBe(true);
    expect(preview.mock.calls.length).toBeLessThan(10);
  });

  it("does not call the database preview when the studio is not entitled (default deny)", async () => {
    const { deps, rpc } = makeDeps({ hasEntitlement: async () => false });
    const result = await previewStudio("s1", deps, BUDGET);
    expect(result.state).toBe("skipped_not_entitled");
    expect(rpc.status).not.toHaveBeenCalled();
    expect(rpc.preview).not.toHaveBeenCalled();
  });

  it("fails closed when the entitlement lookup throws", async () => {
    const { deps, rpc } = makeDeps({
      hasEntitlement: async () => {
        throw new Error("billing down: secret-ish detail");
      },
    });
    const result = await previewStudio("s1", deps, BUDGET);
    expect(result.state).toBe("skipped_entitlement_unknown");
    expect(rpc.status).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-ish");
  });

  it("skips studios that are not enabled without scanning appointments", async () => {
    const { deps, preview } = makeDeps({ status: { ...OPEN_STATUS, enabled: false, enabledAt: null } });
    expect((await previewStudio("s1", deps, BUDGET)).state).toBe("skipped_not_enabled");
    expect(preview).not.toHaveBeenCalled();
  });

  it("reports failures by error class only", async () => {
    const { deps } = makeDeps({
      rpc: {
        status: async () => OPEN_STATUS,
        preview: async () => {
          throw new ReconcileRpcError("42501");
        },
      },
    });
    const result = await previewStudio("s1", deps, BUDGET);
    expect(result.state).toBe("failed");
    expect(result.errorClass).toBe("ReconcileRpcError");
    expect(JSON.stringify(result)).not.toContain("42501");
  });
});

describe("runReconcilePreview", () => {
  it("isolates a failing studio, de-duplicates ids and enforces the studio cap", async () => {
    const preview = vi.fn(async (studio: string) => {
      if (studio === "bad") throw new ReconcileRpcError("boom");
      return [row(1, "would_create")];
    });
    const { deps } = makeDeps({ rpc: { status: async () => OPEN_STATUS, preview } });
    const report = await runReconcilePreview(["ok1", "bad", "ok1", "ok2", "ok3"], deps, BUDGET);
    expect(report.mode).toBe("preview_only");
    expect(report.studios.map((s) => [s.studioId, s.state])).toEqual([
      ["ok1", "previewed"],
      ["bad", "failed"],
      ["ok2", "previewed"],
    ]);
    expect(report.studiosNotExamined).toBe(1);
  });

  it("repeated passes produce identical reports (stateless)", async () => {
    const { deps } = makeDeps({ rows: [row(1, "would_create"), row(2, "would_attach")] });
    const a = await runReconcilePreview(["s1"], deps, BUDGET);
    const b = await runReconcilePreview(["s1"], deps, BUDGET);
    expect(a).toEqual(b);
  });
});

describe("createSupabaseReconcileRpc", () => {
  it("maps rows, passes the keyset cursor and calls only the two read-only functions", async () => {
    const rpc = vi.fn(async (fn: string) =>
      fn === "intake_reconcile_status"
        ? {
            data: [
              { enabled: true, enabled_at: "2026-10-01T00:00:00Z", gate_a_open: false, new_obligation_allowed: true, default_template_configured: true, assignment_count: 1 },
            ],
            error: null,
          }
        : {
            data: [{ appointment_id: "a1", client_id: "c1", appt_created_at: "2026-10-02T00:00:00Z", outcome: "would_create", template_id: "t1", version_number: 2 }],
            error: null,
          },
    );
    const adapter = createSupabaseReconcileRpc({ rpc });
    expect((await adapter.status("s1")).gateAOpen).toBe(false);
    const rows = await adapter.preview("s1", 50, { createdAt: "x", id: "y" });
    expect(rows[0]).toMatchObject({ appointmentId: "a1", outcome: "would_create", versionNumber: 2 });
    expect(rpc).toHaveBeenCalledWith("intake_reconcile_preview", { p_studio_id: "s1", p_limit: 50, p_after_created_at: "x", p_after_id: "y" });
    expect(rpc.mock.calls.map((c) => c[0]).sort()).toEqual(["intake_reconcile_preview", "intake_reconcile_status"]);
  });

  it("rejects an unknown outcome and surfaces rpc errors as coded errors", async () => {
    const bad = createSupabaseReconcileRpc({
      rpc: async () => ({ data: [{ appointment_id: "a", client_id: "c", appt_created_at: "t", outcome: "mystery" }], error: null }),
    });
    await expect(bad.preview("s1", 10, null)).rejects.toThrow(ReconcileRpcError);
    const denied = createSupabaseReconcileRpc({ rpc: async () => ({ data: null, error: { code: "42501" } }) });
    await expect(denied.status("s1")).rejects.toMatchObject({ code: "42501" });
  });
});
