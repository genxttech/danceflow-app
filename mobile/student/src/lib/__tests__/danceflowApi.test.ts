process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL = "https://app.example.test";

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      refreshSession: jest.fn(),
      signOut: jest.fn(async () => ({ error: null })),
    },
  },
}));

import { danceflowApiFetch, SESSION_EXPIRED_MESSAGE } from "@/lib/danceflowApi";
import { supabase } from "@/lib/supabase";
import { classifyError } from "@/lib/errorKind";

const mockAuth = supabase.auth as unknown as Record<"getSession" | "refreshSession" | "signOut", jest.Mock>;
const fresh = (token: string) => ({ access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 });
const reply = (status: number, body: unknown = {}) =>
  ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) }) as Response;

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.getSession.mockResolvedValue({ data: { session: fresh("t1") }, error: null });
  global.fetch = jest.fn();
});

describe("session expiry", () => {
  it("sends the current token on a healthy session", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(reply(200, { ok: true }));
    await expect(danceflowApiFetch("/api/x")).resolves.toEqual({ ok: true });
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it("refreshes once and retries when the server answers 401", async () => {
    mockAuth.refreshSession.mockResolvedValue({ data: { session: fresh("t2") }, error: null });
    (global.fetch as jest.Mock).mockResolvedValueOnce(reply(401, { error: "no" })).mockResolvedValueOnce(reply(200, { ok: true }));

    await expect(danceflowApiFetch("/api/x")).resolves.toEqual({ ok: true });

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls[1][1].headers.get("Authorization")).toBe("Bearer t2");
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it("ends the session when the retry is refused too, so the app returns to sign-in", async () => {
    mockAuth.refreshSession.mockResolvedValue({ data: { session: fresh("t2") }, error: null });
    (global.fetch as jest.Mock).mockResolvedValue(reply(401, { error: "no" }));

    await expect(danceflowApi()).rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("ends the session when the refresh token is refused", async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: { access_token: "old", expires_at: 1 } }, error: null });
    mockAuth.refreshSession.mockResolvedValue({ data: { session: null }, error: Object.assign(new Error("Invalid Refresh Token"), { status: 400 }) });

    await expect(danceflowApi()).rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does NOT sign out on a network failure while refreshing", async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: { access_token: "old", expires_at: 1 } }, error: null });
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: Object.assign(new Error("Failed to fetch"), { name: "AuthRetryableFetchError", status: 0 }),
    });

    await expect(danceflowApi()).rejects.toThrow(/could not reach DanceFlow/);
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it("surfaces the expiry as the signed-out error kind", () => {
    expect(classifyError(new Error(SESSION_EXPIRED_MESSAGE))).toBe("signedOut");
  });
});

function danceflowApi() {
  return danceflowApiFetch("/api/x");
}
