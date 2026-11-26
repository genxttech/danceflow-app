/* eslint-disable @typescript-eslint/no-explicit-any -- loose insert fake */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const inserted: any[] = [];
let failWith: { message: string } | "throw" | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (row: any) => {
        if (failWith === "throw") throw new Error("network down");
        if (failWith) return { error: failWith };
        inserted.push({ table, row });
        return { error: null };
      },
    }),
  }),
}));

import { recordIntegrationEvent, sanitizeAuditDetails } from "../audit";

beforeEach(() => { inserted.length = 0; failWith = null; vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("S0-g2 integration audit helper", () => {
  it("writes provider-neutral rows with defaults", async () => {
    await recordIntegrationEvent({ studioId: "s1", provider: "wave", eventType: "connected", actorUserId: "u1", connectionId: "c1", details: { scopes: ["a", "b"], business_selected: true } });
    expect(inserted[0]).toEqual({ table: "integration_audit_events", row: { studio_id: "s1", provider: "wave", event_type: "connected", outcome: "succeeded", connection_id: "c1", actor_user_id: "u1", details: { scopes: ["a", "b"], business_selected: true } } });
  });

  it("drops secret-like and personal keys and non-primitive values, and bounds sizes", () => {
    const clean = sanitizeAuditDetails({
      access_token: "x", refresh_token: "y", client_secret: "z", code: "oauth-code", google_account_email: "a@b.test", calendar_name: "Mine", phone: "1", notes: "n", Authorization: "Bearer x",
      revoke: "revoked", cleanup_skipped: true, count: 3, nested: { a: 1 }, mixed: [1, "a"], long: "x".repeat(500), many: Array.from({ length: 50 }, (_, i) => `s${i}`),
    });
    expect(Object.keys(clean).sort()).toEqual(["cleanup_skipped", "count", "long", "many", "revoke"]);
    expect((clean.long as string).length).toBe(200);
    expect((clean.many as string[]).length).toBe(20);
    expect(sanitizeAuditDetails(undefined)).toEqual({});
  });

  it("never throws: database errors and thrown errors are swallowed and logged without the payload", async () => {
    failWith = { message: "rls says no" };
    await expect(recordIntegrationEvent({ studioId: "s1", provider: "wave", eventType: "x", details: { revoke: "ok" } })).resolves.toBeUndefined();
    failWith = "throw";
    await expect(recordIntegrationEvent({ studioId: "s1", provider: "wave", eventType: "x" })).resolves.toBeUndefined();
    const logged = (console.error as any).mock.calls.flat().join(" ");
    expect(logged).toContain("rls says no");
    expect(logged).not.toContain("revoke");
  });
});
