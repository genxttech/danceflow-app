import { describe, expect, it, vi } from "vitest";
import { buildPreviewView, loadPreviewView } from "@/lib/intake/previewView";
import type { PreviewRow, ReconcilePreviewRpc, StudioGateStatus } from "@/lib/intake/reconcilePreview";

const A = "studio-a";
const B = "studio-b";
const ON: StudioGateStatus = { enabled: true, enabledAt: "2026-10-01T00:00:00Z", gateAOpen: false, newObligationAllowed: true, defaultTemplateConfigured: true, assignmentCount: 0 };
const OFF: StudioGateStatus = { ...ON, enabled: false, enabledAt: null };
const row = (id: string, client: string, outcome: PreviewRow["outcome"]): PreviewRow => ({
  appointmentId: id,
  clientId: client,
  apptCreatedAt: "2026-10-02T00:00:00Z",
  outcome,
  templateId: null,
  versionNumber: outcome === "would_create" ? 2 : null,
});

describe("buildPreviewView", () => {
  it("uses only details of the caller's studio and falls back to a neutral name", () => {
    const view = buildPreviewView({
      studioId: A,
      status: ON,
      rows: [row("a1", "c1", "would_create"), row("a2", "c2", "existing_student")],
      appointments: [
        { id: "a1", studio_id: A, starts_at: "2026-10-20T15:00:00Z", appointment_type: "private_lesson", client_id: "c1" },
        { id: "a2", studio_id: B, starts_at: "2026-10-21T15:00:00Z", appointment_type: "private_lesson", client_id: "c2" },
      ],
      clients: [
        { id: "c1", studio_id: A, first_name: "Ada", last_name: "Lovelace" },
        { id: "c2", studio_id: B, first_name: "Other", last_name: "Studio" },
      ],
    });
    expect(view.rows.find((r) => r.appointmentId === "a1")?.clientName).toBe("Ada Lovelace");
    const foreign = view.rows.find((r) => r.appointmentId === "a2");
    expect(foreign?.clientName).toBe("Student");
    expect(foreign?.startsAt).toBeNull();
    expect(JSON.stringify(view)).not.toContain("Other Studio");
    expect(view.readOnly).toBe(true);
    expect(view.counts).toEqual({ would_create: 1, not_applicable: 1 });
  });
  it("flags a full page as possibly truncated", () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(`a${i}`, "c", "would_create"));
    expect(buildPreviewView({ studioId: A, status: ON, rows, appointments: [], clients: [], pageSize: 3 }).truncated).toBe(true);
    expect(buildPreviewView({ studioId: A, status: ON, rows, appointments: [], clients: [], pageSize: 4 }).truncated).toBe(false);
  });
});

describe("loadPreviewView is read-only", () => {
  function makeClient() {
    const calls: string[] = [];
    const client = {
      from(table: string) {
        calls.push(`from:${table}`);
        return {
          select() {
            return {
              eq(_c: string, studio: string) {
                calls.push(`eq:studio=${studio}`);
                return { in: async () => ({ data: [], error: null }) };
              },
            };
          },
        };
      },
    };
    return { client, calls };
  }

  it("does not call the preview RPC when the studio has intake off", async () => {
    const rpc: ReconcilePreviewRpc = { status: vi.fn(async () => OFF), preview: vi.fn(async () => []) };
    const { client, calls } = makeClient();
    const view = await loadPreviewView({ studioId: A, rpc, userClient: client });
    expect(view.rows).toEqual([]);
    expect(rpc.preview).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it("reads only (status, preview, appointment and client lookups) scoped to the caller's studio", async () => {
    const rpc: ReconcilePreviewRpc = { status: vi.fn(async () => ON), preview: vi.fn(async () => [row("a1", "c1", "would_create")]) };
    const { client, calls } = makeClient();
    await loadPreviewView({ studioId: A, rpc, userClient: client });
    expect(rpc.preview).toHaveBeenCalledWith(A, 50, null);
    expect(calls).toEqual(["from:appointments", `eq:studio=${A}`, "from:clients", `eq:studio=${A}`]);
    expect(Object.keys(rpc).sort()).toEqual(["preview", "status"]);
  });
  it("surfaces lookup failures instead of showing a partial or mis-attributed list", async () => {
    const rpc: ReconcilePreviewRpc = { status: async () => ON, preview: async () => [row("a1", "c1", "would_create")] };
    const failing = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: "x" } }) }) }) }) };
    await expect(loadPreviewView({ studioId: A, rpc, userClient: failing })).rejects.toThrow();
  });
});
