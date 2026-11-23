/* eslint-disable @typescript-eslint/no-explicit-any -- loose in-memory PostgREST fake */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    single: async () => ({ data: run()[0] ?? null, error: null }),
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return builder; },
    neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return builder; },
    update: (p: Row) => { mode = "update"; patch = p; return builder; },
    delete: () => { mode = "delete"; return builder; },
    upsert: (p: Row, o: { onConflict: string }) => {
      const e = rows().find((r) => r[o.onConflict] === p[o.onConflict]);
      if (e) Object.assign(e, p); else rows().push({ ...p });
      return Promise.resolve({ error: null });
    },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ error: null, data: run() }),
  };
  return builder;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (n: string) => table(n) }) }));

import { missingScopes } from "../scopes";
import { GoogleTokenError, getValidGoogleCalendarAccessToken, revokeGoogleCalendarGrant, revokeGoogleToken, GOOGLE_REQUIRED_SCOPES } from "../google-calendar/client";
import { WaveTokenError, revokeWaveToken, refreshWaveAccessToken, WAVE_READ_SCOPES } from "../wave/client";
import { getValidWaveAccessToken } from "../wave/token";
import { encryptIntegrationSecret } from "../wave/secrets";

const original = globalThis.fetch;
const expired = () => new Date(Date.now() - 1000).toISOString();
beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = "1".repeat(64);
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "gid"; process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "gsecret";
  process.env.WAVE_CLIENT_ID = "wid"; process.env.WAVE_CLIENT_SECRET = "wsecret"; process.env.WAVE_REDIRECT_URI = "https://x/cb";
});
afterEach(() => { globalThis.fetch = original; vi.restoreAllMocks(); });

describe("S0-e scope verification", () => {
  it("reports missing scopes, tolerates order and extras, and treats an absent scope field as unproven-missing", () => {
    expect(missingScopes("b a extra", ["a", "b"])).toEqual([]);
    expect(missingScopes("a", ["a", "b"])).toEqual(["b"]);
    expect(missingScopes("", ["a"])).toEqual(["a"]);
    expect(missingScopes(["a"], ["a", "b"])).toEqual(["b"]);
    expect(missingScopes(undefined, ["a"])).toEqual([]);
    expect(missingScopes("https://www.googleapis.com/auth/userinfo.email", GOOGLE_REQUIRED_SCOPES)).toHaveLength(2);
    expect(missingScopes("user:read business:read account:read", WAVE_READ_SCOPES)).toEqual([]);
    expect(missingScopes("user:read", WAVE_READ_SCOPES)).toEqual(["business:read", "account:read"]);
  });
});

describe("S0-e Google refresh error classes", () => {
  const seed = () => {
    db.studio_google_calendar_connections = [{ id: "c1", status: "connected" }];
    db.studio_google_calendar_credentials = [{ connection_id: "c1", encrypted_access_token: encryptIntegrationSecret("a"), encrypted_refresh_token: encryptIntegrationSecret("r"), token_expires_at: expired() }];
  };
  it("invalid_grant marks needs_reauth", async () => {
    seed();
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as any;
    await expect(getValidGoogleCalendarAccessToken("c1")).rejects.toThrow(/Reconnect/);
    expect(db.studio_google_calendar_connections[0].status).toBe("needs_reauth");
  });
  it("a 5xx or network failure keeps the connection connected", async () => {
    seed();
    globalThis.fetch = (async () => new Response("oops", { status: 503 })) as any;
    await expect(getValidGoogleCalendarAccessToken("c1")).rejects.toThrow(/temporarily/);
    expect(db.studio_google_calendar_connections[0].status).toBe("connected");
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as any;
    await expect(getValidGoogleCalendarAccessToken("c1")).rejects.toThrow(/temporarily/);
    expect(db.studio_google_calendar_connections[0].status).toBe("connected");
  });
  it("a non-grant 4xx (for example invalid_client) needs a human; 429 and 5xx stay transient", () => {
    expect(new GoogleTokenError("x", "invalid_client", 401).permanent).toBe(true);
    expect(new GoogleTokenError("x", "rate", 429).permanent).toBe(false);
    expect(new WaveTokenError("x", 403).permanent).toBe(true);
    expect(new WaveTokenError("x", 429).permanent).toBe(false);
    expect(new WaveTokenError("x", 500).permanent).toBe(false);
    expect(new WaveTokenError("x", null).permanent).toBe(false);
  });
  it("GoogleTokenError.permanent is only true for invalid_grant or a non-transient 4xx", () => {
    expect(new GoogleTokenError("x", "invalid_grant", 400).permanent).toBe(true);
    expect(new GoogleTokenError("x", "temporarily_unavailable", 503).permanent).toBe(false);
    expect(new GoogleTokenError("x", null, null).permanent).toBe(false);
  });
});

describe("S0-e Wave refresh error classes", () => {
  const seed = () => {
    db.studio_wave_connections = [{ id: "w1", status: "connected", posting_enabled: true }];
    db.studio_wave_credentials = [{ connection_id: "w1", encrypted_access_token: encryptIntegrationSecret("a"), encrypted_refresh_token: encryptIntegrationSecret("r"), token_expires_at: expired() }];
  };
  it("400/401 marks needs_reauth and turns posting off", async () => {
    seed();
    globalThis.fetch = (async () => new Response("{}", { status: 400 })) as any;
    await expect(getValidWaveAccessToken("w1")).rejects.toThrow(/Reconnect/);
    expect(db.studio_wave_connections[0]).toMatchObject({ status: "needs_reauth", posting_enabled: false });
  });
  it("5xx and network errors leave the connection and posting untouched", async () => {
    seed();
    globalThis.fetch = (async () => new Response("{}", { status: 502 })) as any;
    await expect(getValidWaveAccessToken("w1")).rejects.toThrow(/temporarily/);
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as any;
    await expect(getValidWaveAccessToken("w1")).rejects.toThrow(/temporarily/);
    expect(db.studio_wave_connections[0]).toMatchObject({ status: "connected", posting_enabled: true });
  });
  it("token errors carry status; refresh success stores a rotated refresh token", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as any;
    await expect(refreshWaveAccessToken("r")).rejects.toBeInstanceOf(WaveTokenError);
    seed();
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "n", refresh_token: "r2", expires_in: 3600, token_type: "bearer" }), { status: 200 })) as any;
    expect(await getValidWaveAccessToken("w1")).toBe("n");
    expect(db.studio_wave_credentials[0].encrypted_refresh_token).not.toBe(encryptIntegrationSecret("r"));
  });
});

describe("S0-b provider revoke", () => {
  it("Google: posts the token form-encoded; 400 means already invalid; other failures never throw", async () => {
    const calls: Array<{ url: string; body: string; type: string }> = [];
    globalThis.fetch = (async (url: string, init: any) => { calls.push({ url, body: String(init.body), type: init.headers["Content-Type"] }); return new Response("", { status: 200 }); }) as any;
    expect(await revokeGoogleToken("tok-1")).toBe("revoked");
    expect(calls[0]).toEqual({ url: "https://oauth2.googleapis.com/revoke", body: "token=tok-1", type: "application/x-www-form-urlencoded" });
    globalThis.fetch = (async () => new Response("", { status: 400 })) as any;
    expect(await revokeGoogleToken("t")).toBe("already_invalid");
    globalThis.fetch = (async () => new Response("", { status: 500 })) as any;
    expect(await revokeGoogleToken("t")).toBe("failed");
    globalThis.fetch = (async () => { throw new Error("down"); }) as any;
    expect(await revokeGoogleToken("t")).toBe("failed");
  });
  it("Google grant revoke prefers the refresh token, handles no credentials, and survives undecryptable data", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_u: string, init: any) => { bodies.push(String(init.body)); return new Response("", { status: 200 }); }) as any;
    expect(await revokeGoogleCalendarGrant("none")).toBe("no_credentials");
    db.studio_google_calendar_credentials = [{ connection_id: "c1", encrypted_access_token: encryptIntegrationSecret("access-A"), encrypted_refresh_token: encryptIntegrationSecret("refresh-R") }];
    expect(await revokeGoogleCalendarGrant("c1")).toBe("revoked");
    expect(bodies).toEqual(["token=refresh-R"]);
    db.studio_google_calendar_credentials = [{ connection_id: "c2", encrypted_access_token: "garbage" }];
    expect(await revokeGoogleCalendarGrant("c2")).toBe("failed");
  });
  it("Google grant revoke is skipped while another connection uses the same Google account", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as any;
    db.studio_google_calendar_connections = [
      { id: "own", status: "connected", google_account_email: "a@x.test" },
      { id: "other", status: "connected", google_account_email: "a@x.test" },
      { id: "solo", status: "connected", google_account_email: "b@x.test" },
    ];
    db.studio_google_calendar_credentials = [
      { connection_id: "own", encrypted_access_token: encryptIntegrationSecret("a"), encrypted_refresh_token: encryptIntegrationSecret("r") },
      { connection_id: "solo", encrypted_access_token: encryptIntegrationSecret("a"), encrypted_refresh_token: encryptIntegrationSecret("r") },
    ];
    expect(await revokeGoogleCalendarGrant("own")).toBe("skipped_shared_account");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await revokeGoogleCalendarGrant("solo")).toBe("revoked");
  });
  it("Wave transient refresh failure leaves a visible note and a disconnect during refresh is not overwritten", async () => {
    db.studio_wave_connections = [{ id: "w9", status: "connected", posting_enabled: true }];
    db.studio_wave_credentials = [{ connection_id: "w9", encrypted_access_token: encryptIntegrationSecret("a"), encrypted_refresh_token: encryptIntegrationSecret("r"), token_expires_at: expired() }];
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as any;
    await expect(getValidWaveAccessToken("w9")).rejects.toThrow(/temporarily/);
    expect(db.studio_wave_connections[0].last_error).toMatch(/temporarily/);
    db.studio_wave_connections[0].status = "disconnected";
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "n", token_type: "bearer", expires_in: 60 }), { status: 200 })) as any;
    await getValidWaveAccessToken("w9").catch(() => null);
    expect(db.studio_wave_connections[0].status).toBe("disconnected");
  });
  it("Wave: posts client credentials and token to the documented revoke endpoint without throwing", async () => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    globalThis.fetch = (async (url: string, init: any) => { calls.push({ url, body: init.body }); return new Response("", { status: 200 }); }) as any;
    expect(await revokeWaveToken("wtok")).toBe("revoked");
    expect(calls[0].url).toBe("https://api.waveapps.com/oauth2/token-revoke/");
    expect(Object.fromEntries(calls[0].body)).toEqual({ client_id: "wid", client_secret: "wsecret", token: "wtok" });
    globalThis.fetch = (async () => new Response("", { status: 500 })) as any;
    expect(await revokeWaveToken("t")).toBe("failed");
    delete process.env.WAVE_CLIENT_ID;
    expect(await revokeWaveToken("t")).toBe("failed");
  });
});
