/* eslint-disable @typescript-eslint/no-explicit-any -- loose route/PostgREST fakes */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const STUDIO = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
let nextId = 1;
function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" | "insert" | "delete" | "upsert" = "select";
  let patch: Row = {};
  let last: Row | null = null;
  const rows = () => (db[name] ??= []);
  const run = () => {
    const hit = rows().filter((r) => filters.every((f) => f(r)));
    if (mode === "update") hit.forEach((r) => Object.assign(r, patch));
    if (mode === "delete") db[name] = rows().filter((r) => !hit.includes(r));
    return mode === "insert" || mode === "upsert" ? (last ? [last] : []) : hit;
  };
  const b: any = {
    select: () => b,
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
    is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return b; },
    neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return b; },
    update: (p: Row) => { mode = "update"; patch = p; return b; },
    delete: () => { mode = "delete"; return b; },
    insert: (p: any) => { mode = "insert"; const arr = Array.isArray(p) ? p : [p]; arr.forEach((x) => { const row: Row = { id: `id${nextId++}`, ...x }; last = row; rows().push(row); }); return b; },
    upsert: (p: Row, o?: { onConflict: string }) => {
      mode = "upsert";
      const e = o ? rows().find((r) => r[o.onConflict] === p[o.onConflict]) : undefined;
      if (e) { Object.assign(e, p); last = e; } else { last = { id: `id${nextId++}`, ...p }; rows().push(last); }
      return b;
    },
    single: async () => ({ data: run()[0] ?? null, error: run()[0] ? null : { message: "no row" } }),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ error: null, data: run() }),
  };
  return b;
}
const admin = { from: (n: string) => table(n) };
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

// ---- Google callback fakes
const googleCalls: string[] = [];
let googleTokens: any;
vi.mock("@/lib/integrations/google-calendar/client", () => ({
  GOOGLE_REQUIRED_SCOPES: ["cal.events", "cal.list"],
  exchangeGoogleCalendarCode: async () => googleTokens,
  getGoogleAccountEmail: async () => "g@example.test",
  listGoogleCalendars: async () => [{ id: "cal1", summary: "Main", primary: true }],
  googleAccountHasOtherConnection: async () => false,
  revokeGoogleToken: async (t: string) => { googleCalls.push(`revoke:${t}`); return "revoked"; },
}));
vi.mock("@/lib/integrations/google-calendar/access", () => ({
  googleCalendarReturnPath: () => "/app/settings/integrations/google-calendar",
  getGoogleCalendarAccess: async () => ({ supabase: admin, context: { studioId: STUDIO, userId: USER }, instructorId: null }),
}));

// ---- Wave callback fakes
const waveCalls: string[] = [];
let waveTokens: any;
let mayManage = true;
let signedIn = true;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn ? { id: USER } : null } }) }, rpc: async () => ({ data: mayManage }) }),
}));
vi.mock("@/lib/integrations/wave/client", () => ({
  WAVE_READ_SCOPES: ["user:read", "business:read", "account:read"],
  exchangeWaveAuthorizationCode: async () => waveTokens,
  getWaveUserAndBusinesses: async () => ({ user: { id: "wu" }, businesses: { edges: [{ node: { id: "b1", name: "Biz", isPersonal: false, currency: { code: "USD" }, isClassicAccounting: false } }] } }),
  revokeWaveToken: async (t: string) => { waveCalls.push(`revoke:${t}`); return "revoked"; },
}));

import { createOAuthStateCookieValue } from "@/lib/security/oauth";
import { decryptIntegrationSecret } from "@/lib/integrations/wave/secrets";
import { GET as googleGet } from "../google-calendar/callback/route";
import { GET as waveGet } from "../wave/callback/route";

function request(path: string, cookieName: string, cookieValue?: string, extra = "") {
  const state = cookieValue ? JSON.parse(cookieValue).state : "x";
  const url = `https://app.example.test${path}?code=abc&state=${extra || state}`;
  return { url, nextUrl: new URL(url), cookies: { get: (n: string) => (n === cookieName && cookieValue ? { value: cookieValue } : undefined) } } as any;
}
const location = (r: Response) => r.headers.get("location") ?? "";

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  googleCalls.length = 0; waveCalls.length = 0; mayManage = true; signedIn = true;
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = "2".repeat(64);
  googleTokens = { access_token: "g-access", refresh_token: "g-refresh", expires_in: 3600, scope: "cal.events cal.list extra" };
  waveTokens = { access_token: "w-access", refresh_token: "w-refresh", expires_in: 3600, scope: "user:read business:read account:read transaction:write", token_type: "bearer" };
});

describe("S0-f Google OAuth callback", () => {
  const good = () => createOAuthStateCookieValue({ studioId: STUDIO, userId: USER });
  it("stores connection and credentials separately on success", async () => {
    const { cookieValue } = good();
    const res = await googleGet(request("/api/integrations/google-calendar/callback", "google_calendar_oauth_state", cookieValue));
    expect(location(res)).toContain("connected=1");
    const conn = db.studio_google_calendar_connections[0];
    expect(conn).toMatchObject({ studio_id: STUDIO, status: "connected", google_account_email: "g@example.test" });
    expect(conn.encrypted_access_token).toBeUndefined();
    const cred = db.studio_google_calendar_credentials[0];
    expect(cred.connection_id).toBe(conn.id);
    expect(decryptIntegrationSecret(cred.encrypted_access_token)).toBe("g-access");
    expect(decryptIntegrationSecret(cred.encrypted_refresh_token)).toBe("g-refresh");
  });
  it("rejects a missing cookie and a mismatched state without touching the database", async () => {
    expect(location(await googleGet(request("/api/integrations/google-calendar/callback", "google_calendar_oauth_state")))).toContain("error=invalid_callback");
    const { cookieValue } = good();
    const res = await googleGet(request("/api/integrations/google-calendar/callback", "google_calendar_oauth_state", cookieValue, "A".repeat(43)));
    expect(location(res)).toContain("error=state_mismatch");
    expect(db.studio_google_calendar_connections ?? []).toHaveLength(0);
  });
  it("insufficient scope stores nothing and revokes the grant", async () => {
    googleTokens.scope = "cal.events";
    const { cookieValue } = good();
    const res = await googleGet(request("/api/integrations/google-calendar/callback", "google_calendar_oauth_state", cookieValue));
    expect(location(res)).toContain("error=insufficient_scope");
    expect(db.studio_google_calendar_connections ?? []).toHaveLength(0);
    expect(db.studio_google_calendar_credentials ?? []).toHaveLength(0);
    expect(googleCalls).toEqual(["revoke:g-refresh"]);
  });
  it("a provider error is sanitised into the redirect", async () => {
    const url = "https://app.example.test/cb?error=access_denied%3Cx%3E";
    const res = await googleGet({ url, nextUrl: new URL(url), cookies: { get: () => undefined } } as any);
    expect(location(res)).toContain("error=access_denied_x_");
  });
});

describe("S0-f Wave OAuth callback", () => {
  const good = () => createOAuthStateCookieValue({ studioId: STUDIO, userId: USER });
  it("connects, stores credentials in the credentials table and the single business", async () => {
    const { cookieValue } = good();
    const res = await waveGet(request("/api/integrations/wave/callback", "wave_oauth_state", cookieValue));
    expect(location(res)).toContain("status=connected");
    expect(db.studio_wave_connections[0]).toMatchObject({ studio_id: STUDIO, wave_business_id: "b1", scopes: ["user:read", "business:read", "account:read", "transaction:write"] });
    expect(decryptIntegrationSecret(db.studio_wave_credentials[0].encrypted_refresh_token)).toBe("w-refresh");
    expect(db.studio_wave_businesses).toHaveLength(1);
  });
  it("signed out, bad state and missing permission all stop before the code exchange stores anything", async () => {
    const { cookieValue } = good();
    signedIn = false;
    expect(location(await waveGet(request("/api/integrations/wave/callback", "wave_oauth_state", cookieValue)))).toContain("status=signed_out");
    signedIn = true;
    expect(location(await waveGet(request("/api/integrations/wave/callback", "wave_oauth_state", cookieValue, "B".repeat(43))))).toContain("status=invalid_state");
    mayManage = false;
    expect(location(await waveGet(request("/api/integrations/wave/callback", "wave_oauth_state", cookieValue)))).toContain("status=forbidden");
    expect(db.studio_wave_connections ?? []).toHaveLength(0);
    expect(db.studio_wave_credentials ?? []).toHaveLength(0);
  });
  it("missing read scopes store nothing and revoke; a missing transaction:write is allowed (posting stays gated)", async () => {
    waveTokens.scope = "user:read";
    const { cookieValue } = good();
    expect(location(await waveGet(request("/api/integrations/wave/callback", "wave_oauth_state", cookieValue)))).toContain("status=insufficient_scope");
    expect(db.studio_wave_connections ?? []).toHaveLength(0);
    expect(waveCalls).toEqual(["revoke:w-refresh"]);
    waveTokens.scope = "user:read business:read account:read";
    const second = good();
    expect(location(await waveGet(request("/api/integrations/wave/callback", "wave_oauth_state", second.cookieValue)))).toContain("status=connected");
  });
});
