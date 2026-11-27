/*
  An emailed sign-in link (token hash) is bound to the request made on this phone: the requested address, within 24 hours, used once. It is checked on a client
  that saves nothing, and the session is adopted only when the address matches. A code link is already bound to this device and is unchanged.
*/
const mockStore = new Map<string, string>();
let mockStoreBroken = false;
jest.mock("@/lib/secureSessionStorage", () => ({
  secureSessionStorage: {
    getItem: async (key: string) => {
      if (mockStoreBroken) throw new Error("keystore");
      return mockStore.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => void mockStore.set(key, value),
    removeItem: async (key: string) => void mockStore.delete(key),
  },
}));

const mockVerify = jest.fn();
const mockSetSession = jest.fn(async () => ({ error: null }));
const mockExchange = jest.fn(async () => ({ error: null }));
const mockOtp = jest.fn();
const mockSignOut = jest.fn(async () => ({ error: null }));
jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      setSession: (...args: unknown[]) => (mockSetSession as (...a: unknown[]) => unknown)(...args),
      exchangeCodeForSession: (...args: unknown[]) => (mockExchange as (...a: unknown[]) => unknown)(...args),
      signInWithOtp: (...args: unknown[]) => mockOtp(...args),
      signOut: () => mockSignOut(),
    },
  },
  clearPersistedSupabaseSessions: async () => undefined,
  verifyEmailLink: (...args: unknown[]) => mockVerify(...args),
}));
jest.mock("expo-linking", () => ({ addEventListener: () => ({ remove: jest.fn() }), getInitialURL: async () => null }));

import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LinkNotRequestedError } from "@/lib/authLink";
import { markPendingSignIn, PENDING_SIGN_IN_TTL_MS, readPendingSignIn } from "@/lib/pendingSignIn";

const link = (hash: string, type = "magiclink") => `danceflow-business://auth/callback?token_hash=${hash}&type=${type}`;
const sessionFor = (email: string) => ({ data: { user: { email }, session: { access_token: `at-${email}`, refresh_token: `rt-${email}` } }, error: null });

async function auth() {
  function Wrapper({ children }: { children: ReactNode }) {
    return <AuthProvider>{children}</AuthProvider>;
  }
  const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
  await act(async () => undefined);
  return result;
}

beforeEach(() => {
  mockStore.clear();
  mockStoreBroken = false;
  for (const mock of [mockVerify, mockSetSession, mockExchange, mockOtp, mockSignOut]) mock.mockClear();
  mockOtp.mockResolvedValue({ error: null });
  mockVerify.mockResolvedValue(sessionFor("owner@example.test"));
});

describe("a token-hash link", () => {
  it("is refused, without spending the token, when this phone asked for nothing", async () => {
    const result = await auth();
    await expect(result.current.handleAuthUrl(link("h1"))).rejects.toBeInstanceOf(LinkNotRequestedError);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("signs in for the requested address, once: the request is used up", async () => {
    const result = await auth();
    await act(async () => result.current.sendSignInLink("  Owner@Example.test "));
    await expect(result.current.handleAuthUrl(link("h1"))).resolves.toBe(true);
    expect(mockVerify).toHaveBeenCalledWith({ token_hash: "h1", type: "magiclink" });
    expect(mockSetSession).toHaveBeenCalledWith({ access_token: "at-owner@example.test", refresh_token: "rt-owner@example.test" });
    expect(await readPendingSignIn()).toBeNull();
    await expect(result.current.handleAuthUrl(link("h2"))).rejects.toBeInstanceOf(LinkNotRequestedError);
    expect(mockSetSession).toHaveBeenCalledTimes(1);
  });

  it("for another account is never adopted, and the request stays for the right link", async () => {
    const result = await auth();
    await markPendingSignIn("owner@example.test");
    mockVerify.mockResolvedValueOnce(sessionFor("attacker@example.test"));
    await expect(result.current.handleAuthUrl(link("evil"))).rejects.toBeInstanceOf(LinkNotRequestedError);
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    await expect(result.current.handleAuthUrl(link("good"))).resolves.toBe(true);
    expect(mockSetSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no address in the answer", { data: { user: {}, session: { access_token: "a", refresh_token: "r" } }, error: null }],
    ["no session in the answer", { data: { user: { email: "owner@example.test" }, session: null }, error: null }],
  ])("with %s is not adopted", async (_label, answer) => {
    const result = await auth();
    await markPendingSignIn("owner@example.test");
    mockVerify.mockResolvedValueOnce(answer);
    await expect(result.current.handleAuthUrl(link("h"))).rejects.toBeInstanceOf(LinkNotRequestedError);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("is refused after 24 hours, from the far future, and when the record cannot be read", async () => {
    const result = await auth();
    for (const requestedAt of [Date.now() - PENDING_SIGN_IN_TTL_MS - 1000, Date.now() + PENDING_SIGN_IN_TTL_MS + 1000]) {
      await markPendingSignIn("owner@example.test", requestedAt);
      await expect(result.current.handleAuthUrl(link(`t${requestedAt}`))).rejects.toBeInstanceOf(LinkNotRequestedError);
    }
    await markPendingSignIn("owner@example.test");
    mockStoreBroken = true;
    await expect(result.current.handleAuthUrl(link("broken"))).rejects.toBeInstanceOf(LinkNotRequestedError);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("just inside 24 hours is accepted", async () => {
    const result = await auth();
    await markPendingSignIn("owner@example.test", Date.now() - PENDING_SIGN_IN_TTL_MS + 60_000);
    await expect(result.current.handleAuthUrl(link("h"))).resolves.toBe(true);
  });

  it("that the server rejects keeps the request, and the same link may be tried again", async () => {
    const result = await auth();
    await markPendingSignIn("owner@example.test");
    mockVerify.mockResolvedValueOnce({ data: { user: null, session: null }, error: new Error("offline") });
    await expect(result.current.handleAuthUrl(link("h"))).rejects.toThrow("offline");
    await expect(result.current.handleAuthUrl(link("h"))).resolves.toBe(true);
  });

  it("delivered twice is checked once and both deliveries succeed", async () => {
    const result = await auth();
    await markPendingSignIn("owner@example.test");
    await expect(Promise.all([result.current.handleAuthUrl(link("h")), result.current.handleAuthUrl(link("h"))])).resolves.toEqual([true, true]);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it("two different links at once: only one can use the request", async () => {
    const result = await auth();
    await markPendingSignIn("owner@example.test");
    const outcomes = await Promise.allSettled([result.current.handleAuthUrl(link("a")), result.current.handleAuthUrl(link("b"))]);
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "rejected"]);
    expect(mockSetSession).toHaveBeenCalledTimes(1);
  });

  it("of an unsupported type is refused before anything is read", async () => {
    const result = await auth();
    await markPendingSignIn("owner@example.test");
    await expect(result.current.handleAuthUrl(link("h", "invite_other"))).rejects.toThrow(/not supported/);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe("the request record", () => {
  it("keeps the earlier request when the server refuses a new one, and none when there was none", async () => {
    const result = await auth();
    mockOtp.mockResolvedValue({ error: { name: "AuthApiError", status: 429 } });
    await expect(result.current.sendSignInLink("second@example.test")).rejects.toMatchObject({ status: 429 });
    expect(await readPendingSignIn()).toBeNull();
    await markPendingSignIn("owner@example.test");
    await expect(result.current.sendSignInLink("second@example.test")).rejects.toMatchObject({ status: 429 });
    expect((await readPendingSignIn())?.email).toBe("owner@example.test");
  });

  it("keeps the new request when the answer was lost on the way back", async () => {
    const result = await auth();
    mockOtp.mockResolvedValue({ error: { name: "AuthRetryableFetchError", status: 0 } });
    await expect(result.current.sendSignInLink("owner@example.test")).rejects.toBeTruthy();
    expect((await readPendingSignIn())?.email).toBe("owner@example.test");
  });

  it.each(["signOut", "signOutEverywhere"] as const)("is removed by %s", async (method) => {
    const result = await auth();
    await markPendingSignIn("owner@example.test");
    await act(async () => {
      await result.current[method]();
    });
    expect(await readPendingSignIn()).toBeNull();
  });

  it("is removed by a code link, which this device's verifier already binds", async () => {
    const result = await auth();
    await markPendingSignIn("owner@example.test");
    await expect(result.current.handleAuthUrl("danceflow-business://auth/callback?code=abc")).resolves.toBe(true);
    expect(mockExchange).toHaveBeenCalledWith("abc");
    expect(mockVerify).not.toHaveBeenCalled();
    expect(await readPendingSignIn()).toBeNull();
  });
});
