/*
  Cold start with a stored session. The app asks the auth server whether the stored token is still good (getUser). Only the server REFUSING the
  session may sign the dancer out and wipe it; a request that merely failed (offline, flaky network right after start, a 5xx, a rate limit) must keep it.
  Before this, any getUser error signed the dancer out and deleted the stored session, so opening the app without a connection logged them out for good.
*/
import { render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { AuthProvider, serverRefusedSession, useAuth } from "@/lib/auth";
import { clearPersistedSupabaseSessions, supabase } from "@/lib/supabase";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("expo-linking", () => ({ addEventListener: jest.fn(() => ({ remove: jest.fn() })), getInitialURL: jest.fn(async () => null) }));
jest.mock("@/lib/accountControls", () => ({ reactivateDanceFlowAccount: jest.fn(async () => undefined) }));
jest.mock("@/lib/emailVerification", () => ({ recordMobileEmailProof: jest.fn(async () => "bound") }));
jest.mock("@/lib/pushNotifications", () => ({ unbindPushTokenForSignOut: jest.fn(async () => undefined) }));
jest.mock("@/lib/supabase", () => ({
  clearPersistedSupabaseSessions: jest.fn(async () => undefined),
  supabase: {
    auth: {
      getSession: jest.fn(),
      getUser: jest.fn(),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
      signOut: jest.fn(async () => ({ error: null })),
    },
  },
}));

const auth = supabase.auth as jest.Mocked<typeof supabase.auth>;
const clearPersisted = clearPersistedSupabaseSessions as jest.Mock;
const SESSION = { access_token: "tok", refresh_token: "r", user: { id: "u1", email: "d@example.test" } };

jest.setTimeout(30000);
beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  auth.getSession.mockReset().mockResolvedValue({ data: { session: SESSION } } as never);
  auth.getUser.mockReset();
  auth.signOut.mockClear();
  clearPersisted.mockClear();
});

async function startApp() {
  const seen: { latest?: ReturnType<typeof useAuth> } = {};
  function Capture({ onValue }: { onValue: (next: ReturnType<typeof useAuth>) => void }) {
    onValue(useAuth());
    return <Text>ready</Text>;
  }
  render(
    <AuthProvider>
      <Capture
        onValue={(next) => {
          seen.latest = next;
        }}
      />
    </AuthProvider>,
  );
  await waitFor(() => expect(seen.latest?.loading).toBe(false));
  return seen;
}

const authError = (name: string, status: number | undefined, message = "x") => Object.assign(new Error(message), { name, status });

describe("serverRefusedSession", () => {
  it.each([
    ["401 invalid JWT", authError("AuthApiError", 401), true],
    ["403 session not found", authError("AuthApiError", 403), true],
    ["404 user not found", authError("AuthApiError", 404), true],
    ["network failure (status 0)", authError("AuthRetryableFetchError", 0), false],
    ["a fetch TypeError", new TypeError("Network request failed"), false],
    ["a 5xx", authError("AuthRetryableFetchError", 503), false],
    ["a 429 rate limit", authError("AuthApiError", 429), false],
    ["a 408 timeout", authError("AuthApiError", 408), false],
    ["an error with no status", new Error("something"), false],
  ])("%s -> %s", (_name, error, refused) => {
    expect(serverRefusedSession(error)).toBe(refused);
  });
});

describe("cold start with a stored session", () => {
  it("offline (network failure on the check): the dancer stays signed in and the stored session is NOT wiped", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: authError("AuthRetryableFetchError", 0, "Network request failed") } as never);
    const seen = await startApp();
    expect(seen.latest?.session?.access_token).toBe("tok");
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(clearPersisted).not.toHaveBeenCalled();
  });

  it("a server 5xx on the check also keeps the session", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: authError("AuthRetryableFetchError", 502) } as never);
    const seen = await startApp();
    expect(seen.latest?.session).not.toBeNull();
    expect(clearPersisted).not.toHaveBeenCalled();
  });

  it("the server refusing the token (401) signs out and wipes the stored session, as before", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: authError("AuthApiError", 401, "invalid JWT") } as never);
    const seen = await startApp();
    expect(seen.latest?.session).toBeNull();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearPersisted).toHaveBeenCalled();
  });

  it("no user and no error (the server says there is no such user) signs out", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: null } as never);
    const seen = await startApp();
    expect(seen.latest?.session).toBeNull();
    expect(clearPersisted).toHaveBeenCalled();
  });

  it("a good session stays signed in", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null } as never);
    const seen = await startApp();
    expect(seen.latest?.session?.access_token).toBe("tok");
    expect(clearPersisted).not.toHaveBeenCalled();
  });
});
