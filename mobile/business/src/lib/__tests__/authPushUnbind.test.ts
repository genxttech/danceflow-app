/*
  Signing out unbinds this device's push token while the session is still valid (the table's own-row delete policy needs it), and a failure or a hang never
  blocks the sign-out.
*/
const mockCalls: string[] = [];
const mockSignOut = jest.fn(async ({ scope }: { scope: string }) => {
  mockCalls.push(`signOut:${scope}`);
  return { error: null };
});

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      signOut: (args: { scope: string }) => mockSignOut(args),
    },
  },
  clearPersistedSupabaseSessions: async () => undefined,
  hasPendingSignInRequest: async () => false,
}));
jest.mock("expo-linking", () => ({ addEventListener: () => ({ remove: jest.fn() }), getInitialURL: async () => null }));

import { act, renderHook } from "@testing-library/react-native";
import { createElement, type ReactNode } from "react";
import { AuthProvider, BEFORE_SIGN_OUT_TIMEOUT_MS, useAuth } from "@/lib/auth";
import { createPushUnbind } from "@/lib/expoPush";
import type { PushAdapter } from "@/lib/pushSetup";

async function provider(beforeSignOut?: () => Promise<void>, onSignOutRefused?: () => Promise<void>) {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(AuthProvider, { beforeSignOut, onSignOutRefused, children });
  const { result } = renderHook(() => useAuth(), { wrapper });
  await act(async () => undefined);
  return result;
}

beforeEach(() => {
  mockCalls.length = 0;
  mockSignOut.mockClear();
});

describe("sign-out and the push token", () => {
  it.each([
    ["signOut", "local"],
    ["signOutEverywhere", "global"],
  ] as const)("%s unbinds before the session ends", async (method, scope) => {
    const auth = await provider(async () => {
      mockCalls.push("unbind");
    });
    await act(async () => {
      await auth.current[method]();
    });
    expect(mockCalls).toEqual(["unbind", `signOut:${scope}`]);
  });

  it("binds again when sign out of all devices is refused and this device stays signed in", async () => {
    mockSignOut.mockImplementationOnce(async () => ({ error: new Error("offline") as never }));
    const rebind = jest.fn(async () => undefined);
    const auth = await provider(async () => undefined, rebind);
    let done: boolean | undefined;
    await act(async () => {
      done = await auth.current.signOutEverywhere();
    });
    expect(done).toBe(false);
    expect(rebind).toHaveBeenCalledTimes(1);
  });

  it("still signs out when the unbind fails", async () => {
    const auth = await provider(async () => {
      throw new Error("offline");
    });
    await act(async () => {
      await auth.current.signOut();
    });
    expect(mockCalls).toEqual(["signOut:local"]);
  });

  it("still signs out when the unbind never answers", async () => {
    const auth = await provider(() => new Promise<void>(() => undefined));
    jest.useFakeTimers();
    try {
      await act(async () => {
        const done = auth.current.signOut();
        await jest.advanceTimersByTimeAsync(BEFORE_SIGN_OUT_TIMEOUT_MS + 1);
        await done;
      });
    } finally {
      jest.useRealTimers();
    }
    expect(mockCalls).toEqual(["signOut:local"]);
  });
});

describe("createPushUnbind", () => {
  const adapter = { getDeviceToken: async () => "ExponentPushToken[abc]" } as unknown as PushAdapter;
  const user = async () => "user-a";

  it("removes exactly this device's token, pinned to the person signing out", async () => {
    const remove = jest.fn(async () => ({ error: null }));
    await createPushUnbind(adapter, user, remove)();
    expect(remove).toHaveBeenCalledWith("ExponentPushToken[abc]", "user-a");
  });

  it("keeps the first person's id even if someone else signs in while the token is being read", async () => {
    let current = "user-a";
    const slow = { getDeviceToken: async () => ((current = "user-b"), "ExponentPushToken[abc]") } as unknown as PushAdapter;
    const remove = jest.fn(async () => ({ error: null }));
    await createPushUnbind(slow, async () => current, remove)();
    expect(remove).toHaveBeenCalledWith("ExponentPushToken[abc]", "user-a");
  });

  it("does nothing when nobody is signed in", async () => {
    const remove = jest.fn(async () => ({ error: null }));
    await createPushUnbind(adapter, async () => null, remove)();
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports a refused delete, without the token in the message", async () => {
    const unbind = createPushUnbind(adapter, user, async () => ({ error: { message: "denied ExponentPushToken[abc]" } }));
    await expect(unbind()).rejects.toThrow(/^push token removal failed$/);
  });

  it("deletes nothing when the device has no token (push not set up)", async () => {
    const remove = jest.fn(async () => ({ error: null }));
    const none = { getDeviceToken: async () => Promise.reject(new Error("no push token")) } as unknown as PushAdapter;
    await expect(createPushUnbind(none, user, remove)()).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
  });
});
