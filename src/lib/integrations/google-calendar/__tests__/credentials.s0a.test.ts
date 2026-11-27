/* eslint-disable @typescript-eslint/no-explicit-any -- loose in-memory PostgREST fake */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" | "delete" | "upsert" = "select";
  let patch: Row = {};
  const rows = () => (db[name] ??= []);
  const run = () => {
    const hit = rows().filter((r) => filters.every((f) => f(r)));
    if (mode === "update") hit.forEach((r) => Object.assign(r, patch));
    if (mode === "delete") db[name] = rows().filter((r) => !hit.includes(r));
    return hit;
  };
  const builder: any = {
    select: () => builder,
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return builder; },
    neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return builder; },
    update: (p: Row) => { mode = "update"; patch = p; return builder; },
    delete: () => { mode = "delete"; return builder; },
    upsert: (p: Row, opts: { onConflict: string }) => {
      const existing = rows().find((r) => r[opts.onConflict] === p[opts.onConflict]);
      if (existing) Object.assign(existing, p); else rows().push({ ...p });
      return Promise.resolve({ error: null });
    },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ error: null, data: run() }),
  };
  return builder;
}
const admin: any = { from: (n: string) => table(n) };
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

const refreshMock = vi.fn();
const originalFetch = globalThis.fetch;

import { deleteGoogleCredentials, loadGoogleCredentials, saveGoogleCredentials } from "../credentials";

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  refreshMock.mockReset();
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = "0".repeat(64);
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "id";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret";
  globalThis.fetch = originalFetch;
});

describe("S0-a google calendar credentials storage", () => {
  it("prefers the credentials table over legacy columns", async () => {
    db.studio_google_calendar_connections = [{ id: "c1", encrypted_access_token: "legacy", encrypted_refresh_token: null, token_expires_at: null }];
    db.studio_google_calendar_credentials = [{ connection_id: "c1", encrypted_access_token: "new", encrypted_refresh_token: "r", token_expires_at: null }];
    expect((await loadGoogleCredentials(admin, "c1"))?.encrypted_access_token).toBe("new");
  });

  it("falls back to legacy columns when no credentials row exists, and returns null when neither has a token", async () => {
    db.studio_google_calendar_connections = [{ id: "c1", encrypted_access_token: "legacy", encrypted_refresh_token: "lr", token_expires_at: null }, { id: "c2", encrypted_access_token: null }];
    expect((await loadGoogleCredentials(admin, "c1"))?.encrypted_refresh_token).toBe("lr");
    expect(await loadGoogleCredentials(admin, "c2")).toBeNull();
  });

  it("save keeps an existing refresh token when none is provided and replaces it when one is", async () => {
    await saveGoogleCredentials(admin, "c1", { encrypted_access_token: "a1", encrypted_refresh_token: "r1", token_expires_at: null });
    await saveGoogleCredentials(admin, "c1", { encrypted_access_token: "a2", token_expires_at: "t" });
    expect(db.studio_google_calendar_credentials[0]).toMatchObject({ encrypted_access_token: "a2", encrypted_refresh_token: "r1", token_expires_at: "t" });
    await saveGoogleCredentials(admin, "c1", { encrypted_access_token: "a3", encrypted_refresh_token: "r2", token_expires_at: null });
    expect(db.studio_google_calendar_credentials[0].encrypted_refresh_token).toBe("r2");
  });

  it("disconnect removes the credentials row and clears legacy columns", async () => {
    db.studio_google_calendar_connections = [{ id: "c1", encrypted_access_token: "legacy", encrypted_refresh_token: "lr", token_expires_at: "t" }];
    db.studio_google_calendar_credentials = [{ connection_id: "c1", encrypted_access_token: "new" }];
    await deleteGoogleCredentials(admin, "c1");
    expect(db.studio_google_calendar_credentials).toHaveLength(0);
    expect(db.studio_google_calendar_connections[0]).toMatchObject({ encrypted_access_token: null, encrypted_refresh_token: null, token_expires_at: null });
  });
});

describe("S0-a token refresh persists to the credentials table", () => {
  it("refreshes an expired token, stores the new ciphertext only in credentials, and marks connected", async () => {
    const { encryptIntegrationSecret, decryptIntegrationSecret } = await import("@/lib/integrations/wave/secrets");
    const { getValidGoogleCalendarAccessToken } = await import("../client");
    db.studio_google_calendar_connections = [{ id: "c1", status: "needs_reauth", encrypted_access_token: "legacy-old" }];
    db.studio_google_calendar_credentials = [{ connection_id: "c1", encrypted_access_token: encryptIntegrationSecret("old"), encrypted_refresh_token: encryptIntegrationSecret("refresh-1"), token_expires_at: new Date(Date.now() - 1000).toISOString() }];
    globalThis.fetch = (async (_url: string, init: any) => {
      refreshMock(String(init.body));
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
    }) as any;

    const token = await getValidGoogleCalendarAccessToken("c1");
    expect(token).toBe("fresh");
    expect(refreshMock.mock.calls[0][0]).toContain("refresh_token=refresh-1");
    expect(decryptIntegrationSecret(db.studio_google_calendar_credentials[0].encrypted_access_token)).toBe("fresh");
    expect(db.studio_google_calendar_connections[0].encrypted_access_token).toBe("legacy-old"); // expand phase: legacy untouched by refresh
    expect(db.studio_google_calendar_connections[0].status).toBe("connected");
  });

  it("a legacy-only connection keeps its refresh token after the first refresh", async () => {
    const { encryptIntegrationSecret } = await import("@/lib/integrations/wave/secrets");
    const { getValidGoogleCalendarAccessToken } = await import("../client");
    const legacyRefresh = encryptIntegrationSecret("refresh-L");
    db.studio_google_calendar_connections = [{ id: "c5", status: "connected", encrypted_access_token: encryptIntegrationSecret("old"), encrypted_refresh_token: legacyRefresh, token_expires_at: new Date(Date.now() - 1000).toISOString() }];
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 })) as any;
    await getValidGoogleCalendarAccessToken("c5");
    expect(db.studio_google_calendar_credentials[0].encrypted_refresh_token).toBe(legacyRefresh);
    refreshMock.mockClear();
    globalThis.fetch = (async (_u: string, init: any) => { refreshMock(String(init.body)); return new Response(JSON.stringify({ access_token: "again", expires_in: 3600 }), { status: 200 }); }) as any;
    db.studio_google_calendar_credentials[0].token_expires_at = new Date(Date.now() - 1000).toISOString();
    await getValidGoogleCalendarAccessToken("c5");
    expect(refreshMock.mock.calls[0][0]).toContain("refresh_token=refresh-L");
  });

  it("a disconnect during an in-flight refresh wins: no token row and no connected status", async () => {
    const { encryptIntegrationSecret } = await import("@/lib/integrations/wave/secrets");
    const { getValidGoogleCalendarAccessToken } = await import("../client");
    db.studio_google_calendar_connections = [{ id: "c6", status: "disconnected", encrypted_access_token: null }];
    db.studio_google_calendar_credentials = [{ connection_id: "c6", encrypted_access_token: encryptIntegrationSecret("o"), encrypted_refresh_token: encryptIntegrationSecret("r"), token_expires_at: new Date(Date.now() - 1000).toISOString() }];
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 })) as any;
    await expect(getValidGoogleCalendarAccessToken("c6")).rejects.toThrow();
    expect(db.studio_google_calendar_credentials).toHaveLength(0);
    expect(db.studio_google_calendar_connections[0].status).toBe("disconnected");
  });

  it("uses a still-valid stored token without calling Google", async () => {
    const { encryptIntegrationSecret } = await import("@/lib/integrations/wave/secrets");
    const { getValidGoogleCalendarAccessToken } = await import("../client");
    db.studio_google_calendar_credentials = [{ connection_id: "c9", encrypted_access_token: encryptIntegrationSecret("valid"), token_expires_at: new Date(Date.now() + 3_600_000).toISOString() }];
    globalThis.fetch = (async () => { throw new Error("no network expected"); }) as any;
    expect(await getValidGoogleCalendarAccessToken("c9")).toBe("valid");
  });
});
