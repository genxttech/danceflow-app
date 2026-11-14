import { act, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { AuthProvider, useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { unbindPushTokenForSignOut } from "@/lib/pushNotifications";
import { recordMobileEmailProof } from "@/lib/emailVerification";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("expo-linking", () => ({
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  getInitialURL: jest.fn(async () => null),
}));
jest.mock("@/lib/accountControls", () => ({ reactivateDanceFlowAccount: jest.fn(async () => undefined) }));
jest.mock("@/lib/emailVerification", () => ({ recordMobileEmailProof: jest.fn(async () => "bound") }));
jest.mock("@/lib/pushNotifications", () => ({ unbindPushTokenForSignOut: jest.fn(async () => undefined) }));
jest.mock("@/lib/supabase", () => ({
  clearPersistedSupabaseSessions: jest.fn(async () => undefined),
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: null } })),
      getUser: jest.fn(),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
      signInWithOtp: jest.fn(async () => ({ error: null })),
      verifyOtp: jest.fn(async () => ({ error: null })),
      exchangeCodeForSession: jest.fn(async () => ({ error: null })),
      setSession: jest.fn(async () => ({ error: null })),
      signOut: jest.fn(async () => ({ error: null })),
    },
  },
}));

const auth = supabase.auth as jest.Mocked<typeof supabase.auth>;

// One-off renderer load, outside the tests' own timeouts (see warmUpRenderer).
beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

async function renderAuth() {
  let value: ReturnType<typeof useAuth> | undefined;
  function Capture({ onValue }: { onValue: (next: ReturnType<typeof useAuth>) => void }) {
    onValue(useAuth());
    return <Text>ready</Text>;
  }

  render(
    <AuthProvider>
      <Capture
        onValue={(next) => {
          value = next;
        }}
      />
    </AuthProvider>,
  );
  await waitFor(() => expect(value?.loading).toBe(false));

  return value as ReturnType<typeof useAuth>;
}

describe("sign-up and sign-in", () => {
  it("creates an account for a new address, as the sign-in copy promises", async () => {
    const { continueWithEmail } = await renderAuth();

    await continueWithEmail("  New.Dancer@Example.com ");

    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: "new.dancer@example.com",
      options: {
        emailRedirectTo: "danceflow://auth/callback",
        shouldCreateUser: true,
        data: { signup_intent: "public" },
      },
    });
  });

  it("verifies a new address's token as signup and records the mailbox proof", async () => {
    const { handleAuthUrl } = await renderAuth();

    await act(async () => {
      await expect(
        handleAuthUrl("danceflow://auth/callback?token_hash=hash&type=signup"),
      ).resolves.toBe(true);
    });

    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "hash", type: "signup" });
    expect(recordMobileEmailProof).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown link type without verifying or recording anything", async () => {
    const { handleAuthUrl } = await renderAuth();

    await expect(
      handleAuthUrl("danceflow://auth/callback?token_hash=hash&type=invite"),
    ).rejects.toThrow("not supported");

    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(recordMobileEmailProof).not.toHaveBeenCalled();
  });

  it("keeps the PKCE path out of email proof", async () => {
    const { handleAuthUrl } = await renderAuth();

    await expect(handleAuthUrl("danceflow://auth/callback?code=abc")).resolves.toBe(true);

    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(recordMobileEmailProof).not.toHaveBeenCalled();
  });
});

describe("raw token deep links", () => {
  it.each([
    "danceflow://auth/callback#access_token=attacker&refresh_token=attacker",
    "danceflow://auth/callback?access_token=attacker&refresh_token=attacker",
  ])("ignores %s", async (url) => {
    const { handleAuthUrl } = await renderAuth();

    await expect(handleAuthUrl(url)).resolves.toBe(false);

    expect(auth.setSession).not.toHaveBeenCalled();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});

describe("sign-out", () => {
  it("unbinds the push token while the session is still valid", async () => {
    const order: string[] = [];
    (unbindPushTokenForSignOut as jest.Mock).mockImplementation(async () => void order.push("unbind"));
    auth.signOut.mockImplementation(async () => {
      order.push("signOut");
      return { error: null };
    });
    const { signOut } = await renderAuth();

    await act(async () => {
      await signOut();
    });

    expect(order).toEqual(["unbind", "signOut"]);
  });
});

describe("emailed link failures", () => {
  it("verifies a link once when it reaches the app twice (cold start)", async () => {
    const { handleAuthUrl } = await renderAuth();
    auth.verifyOtp.mockClear();

    await act(async () => {
      await Promise.all([
        handleAuthUrl("danceflow://auth/callback?token_hash=once&type=magiclink"),
        handleAuthUrl("danceflow://auth/callback?token_hash=once&type=magiclink"),
      ]);
    });

    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
  });

  it("explains an expired link instead of leaving the dancer waiting", async () => {
    const Linking = jest.requireMock("expo-linking") as { getInitialURL: jest.Mock };
    Linking.getInitialURL.mockResolvedValueOnce("danceflow://auth/callback?token_hash=old&type=magiclink");
    auth.verifyOtp.mockResolvedValueOnce({
      error: Object.assign(new Error("Email link is invalid or has expired"), { code: "otp_expired" }),
    } as never);

    let latest: ReturnType<typeof useAuth> | undefined;
    function Capture() {
      latest = useAuth();
      return <Text>ready</Text>;
    }
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>,
    );

    await waitFor(() => expect(latest?.authLinkError).toMatch(/expired or was already used/));
  });

  it("reads an error the auth server redirected back with", async () => {
    const Linking = jest.requireMock("expo-linking") as { getInitialURL: jest.Mock };
    Linking.getInitialURL.mockResolvedValueOnce(
      "danceflow://auth/callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    let latest: ReturnType<typeof useAuth> | undefined;
    function Capture() {
      latest = useAuth();
      return <Text>ready</Text>;
    }
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>,
    );

    await waitFor(() => expect(latest?.authLinkError).toMatch(/expired or was already used/));
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
});
