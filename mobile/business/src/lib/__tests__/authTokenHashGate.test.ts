/*
  A sign-in link that carries a token hash is not bound to this device (a code link is, by the PKCE verifier), so it is honoured only while this device has a
  pending sign-in request. Otherwise a page or app could open the callback with someone else's link and swap this person into another account.
*/
const mockVerifyOtp = jest.fn(async () => ({ error: null }));
const mockExchange = jest.fn(async () => ({ error: null }));
const mockPending = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }), verifyOtp: (...a: unknown[]) => (mockVerifyOtp as (...x: unknown[]) => unknown)(...a), exchangeCodeForSession: (...a: unknown[]) => (mockExchange as (...x: unknown[]) => unknown)(...a) } },
  clearPersistedSupabaseSessions: jest.fn(),
  hasPendingSignInRequest: () => mockPending(),
}));

import { act, renderHook } from "@testing-library/react-native";
import { createElement, type ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";

jest.mock("expo-linking", () => ({ addEventListener: () => ({ remove: jest.fn() }), getInitialURL: async () => null }));

async function handle(url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(AuthProvider, null, children);
  const { result } = renderHook(() => useAuth(), { wrapper });
  await act(async () => undefined);
  return result.current.handleAuthUrl(url);
}

beforeEach(() => {
  mockVerifyOtp.mockClear();
  mockExchange.mockClear();
  mockPending.mockReset();
});

describe("token-hash links", () => {
  it("are refused when this device did not ask for a sign-in link", async () => {
    mockPending.mockResolvedValue(false);
    await expect(handle("danceflow-business://auth/callback?token_hash=h1&type=magiclink")).rejects.toThrow(/not requested from this device/);
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("are honoured while a request from this device is pending", async () => {
    mockPending.mockResolvedValue(true);
    await expect(handle("danceflow-business://auth/callback?token_hash=h1&type=magiclink")).resolves.toBe(true);
    expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: "h1", type: "magiclink" });
  });

  it("do not affect a code link, which the PKCE verifier already binds to this device", async () => {
    mockPending.mockResolvedValue(false);
    await expect(handle("danceflow-business://auth/callback?code=abc")).resolves.toBe(true);
    expect(mockExchange).toHaveBeenCalledWith("abc");
  });
});
