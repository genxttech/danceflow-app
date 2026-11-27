import { act, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { AuthProvider, useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { unbindPushTokenForSignOut } from "@/lib/pushNotifications";
import { recordMobileEmailProof } from "@/lib/emailVerification";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";
import { LINK_NOT_REQUESTED_MESSAGE } from "@/lib/authLink";
import { markPendingSignIn, PENDING_SIGN_IN_TTL_MS, readPendingSignIn } from "@/lib/pendingSignIn";

const mockStore = new Map<string, string>();
jest.mock("@/lib/secureSessionStorage", () => ({
  secureSessionStorage: {
    getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => void mockStore.set(key, value)),
    removeItem: jest.fn(async (key: string) => void mockStore.delete(key)),
  },
}));
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
  // The non-saving link check, recorded on the same jest function the expectations read.
  verifyEmailLink: (params: unknown) =>
    (jest.requireMock("@/lib/supabase") as { supabase: { auth: { verifyOtp: (p: unknown) => unknown } } }).supabase.auth.verifyOtp(params),
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: null } })),
      getUser: jest.fn(),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
      signInWithOtp: jest.fn(async () => ({ error: null })),
      verifyOtp: jest.fn(async () => ({
        data: { user: { email: "dancer@example.com" }, session: { access_token: "link-token", refresh_token: "r" } },
        error: null,
      })),
      exchangeCodeForSession: jest.fn(async () => ({ error: null })),
      setSession: jest.fn(async () => ({ error: null })),
      signOut: jest.fn(async () => ({ error: null })),
    },
  },
}));

const auth = supabase.auth as jest.Mocked<typeof supabase.auth>;

// One-off renderer load, outside the tests' own timeouts (see warmUpRenderer).
beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

// Every test starts as a phone that asked for a link for the address the mocked server answers with.
beforeEach(async () => {
  mockStore.clear();
  await markPendingSignIn("dancer@example.com");
});

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

    await waitFor(() => expect(seen.latest?.authLinkError).toMatch(/expired or was already used/));
  });

  it("reads an error the auth server redirected back with", async () => {
    const Linking = jest.requireMock("expo-linking") as { getInitialURL: jest.Mock };
    Linking.getInitialURL.mockResolvedValueOnce(
      "danceflow://auth/callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
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

    await waitFor(() => expect(seen.latest?.authLinkError).toMatch(/expired or was already used/));
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
});

describe("pending sign-in marker (G6)", () => {
  const link = "danceflow://auth/callback?token_hash=t1&type=magiclink";

  beforeEach(() => {
    auth.verifyOtp.mockClear();
    auth.signOut.mockClear();
    jest.mocked(recordMobileEmailProof).mockClear();
  });

  it("refuses a link this phone never asked for, without using the token or creating a session", async () => {
    mockStore.clear();
    const { handleAuthUrl } = await renderAuth();

    await expect(handleAuthUrl(link)).rejects.toThrow("not requested on this device");

    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(recordMobileEmailProof).not.toHaveBeenCalled();
  });

  it("tells the dancer what to do when the app is opened by such a link", async () => {
    mockStore.clear();
    const Linking = jest.requireMock("expo-linking") as { getInitialURL: jest.Mock };
    Linking.getInitialURL.mockResolvedValueOnce(link);

    const seen: { latest?: ReturnType<typeof useAuth> } = {};
    function Capture({ onValue }: { onValue: (next: ReturnType<typeof useAuth>) => void }) {
      onValue(useAuth());
      return <Text>ready</Text>;
    }
    render(
      <AuthProvider>
        <Capture onValue={(value) => (seen.latest = value)} />
      </AuthProvider>,
    );

    await waitFor(() => expect(seen.latest?.authLinkError).toBe(LINK_NOT_REQUESTED_MESSAGE));
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("drops a link for a different address (the sender's own live link): nothing is saved and nobody is signed out", async () => {
    auth.verifyOtp.mockResolvedValueOnce({
      data: { user: { email: "someone.else@example.com" }, session: { access_token: "their-token", refresh_token: "their-r" } },
      error: null,
    } as never);
    const { handleAuthUrl } = await renderAuth();
    auth.setSession.mockClear();

    await act(async () => {
      await expect(handleAuthUrl(link)).rejects.toThrow("not requested on this device");
    });

    expect(auth.setSession).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(recordMobileEmailProof).not.toHaveBeenCalled();
    // the dancer's own pending request survives the attempt
    await expect(readPendingSignIn()).resolves.toMatchObject({ email: "dancer@example.com" });
  });

  it("lets one request accept only one link, even when two arrive together", async () => {
    const { handleAuthUrl } = await renderAuth();
    auth.setSession.mockClear();

    await act(async () => {
      const results = await Promise.allSettled([
        handleAuthUrl("danceflow://auth/callback?token_hash=a1&type=magiclink"),
        handleAuthUrl("danceflow://auth/callback?token_hash=a2&type=magiclink"),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    });

    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(auth.setSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the earlier request when the server refuses a new one", async () => {
    const { continueWithEmail } = await renderAuth();
    auth.signInWithOtp.mockResolvedValueOnce({
      error: Object.assign(new Error("rate limited"), { status: 429, code: "over_email_send_rate_limit" }),
    } as never);

    await expect(continueWithEmail("typo@example.com")).rejects.toThrow("rate limited");

    await expect(readPendingSignIn()).resolves.toMatchObject({ email: "dancer@example.com" });
  });

  it("accepts the requested address in any letter case and uses the request up", async () => {
    auth.verifyOtp.mockResolvedValueOnce({
      data: { user: { email: "Dancer@Example.com" }, session: { access_token: "ok", refresh_token: "r" } },
      error: null,
    } as never);
    const { handleAuthUrl } = await renderAuth();

    await act(async () => {
      await expect(handleAuthUrl(link)).resolves.toBe(true);
    });
    await expect(readPendingSignIn()).resolves.toBeNull();

    await expect(handleAuthUrl("danceflow://auth/callback?token_hash=t2&type=magiclink")).rejects.toThrow("not requested");
    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
  });

  it("keeps the request when verification fails, so the dancer can try the link again", async () => {
    auth.verifyOtp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new TypeError("Network request failed"),
    } as never);
    const { handleAuthUrl } = await renderAuth();

    await act(async () => {
      await expect(handleAuthUrl(link)).rejects.toThrow("Network request failed");
    });

    await expect(readPendingSignIn()).resolves.not.toBeNull();
  });

  it("ignores a request older than the link lifetime", async () => {
    await markPendingSignIn("dancer@example.com", Date.now() - PENDING_SIGN_IN_TTL_MS - 1000);
    const { handleAuthUrl } = await renderAuth();

    await expect(handleAuthUrl(link)).rejects.toThrow("not requested");
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("records the request for the sign-in link (even if the answer is lost) and for a password reset", async () => {
    mockStore.clear();
    const { continueWithEmail, sendPasswordReset } = await renderAuth();

    auth.signInWithOtp.mockResolvedValueOnce({ error: new TypeError("Network request failed: lost response") } as never);
    await expect(continueWithEmail(" A@Example.com ")).rejects.toThrow("lost response");
    await expect(readPendingSignIn()).resolves.toMatchObject({ email: "a@example.com" });

    (auth as unknown as { resetPasswordForEmail: jest.Mock }).resetPasswordForEmail = jest.fn(async () => ({ error: null }));
    await sendPasswordReset("b@example.com");
    await expect(readPendingSignIn()).resolves.toMatchObject({ email: "b@example.com" });
  });

  it("forgets the request at sign-out", async () => {
    const { signOut } = await renderAuth();
    await act(async () => {
      await signOut();
    });
    await expect(readPendingSignIn()).resolves.toBeNull();
  });

  it("leaves the PKCE code path unchanged", async () => {
    mockStore.clear();
    const { handleAuthUrl } = await renderAuth();
    await expect(handleAuthUrl("danceflow://auth/callback?code=abc")).resolves.toBe(true);
  });
});
