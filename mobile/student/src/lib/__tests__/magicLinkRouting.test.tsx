/*
  Routing table for emailed links, cold start (the link launches the app: Linking.getInitialURL)
  and warm start (the app is running: the url event). Same provider code, two delivery paths; each
  row says what must be verified, what must not, and what the dancer is told.
*/
import { act, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { AuthProvider, useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
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
const Linking = jest.requireMock("expo-linking") as {
  addEventListener: jest.Mock;
  getInitialURL: jest.Mock;
};

jest.setTimeout(30000);
beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  auth.verifyOtp.mockClear();
  auth.exchangeCodeForSession.mockClear();
  auth.setSession.mockClear();
  Linking.getInitialURL.mockReset().mockResolvedValue(null);
  Linking.addEventListener.mockClear();
});

type Delivery = "cold" | "warm";
type Seen = { latest?: ReturnType<typeof useAuth> };

async function openApp(delivery: Delivery, url: string) {
  const seen: Seen = {};
  if (delivery === "cold") Linking.getInitialURL.mockResolvedValue(url);

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

  if (delivery === "warm") {
    const listener = Linking.addEventListener.mock.calls.find(([event]) => event === "url")?.[1] as
      | ((event: { url: string }) => void)
      | undefined;
    expect(listener).toBeDefined();
    await act(async () => {
      listener?.({ url });
    });
  }
  return seen;
}

const base = "danceflow://auth/callback";

describe.each<Delivery>(["cold", "warm"])("%s start", (delivery) => {
  it.each([
    ["magic link", `${base}?token_hash=abc&type=magiclink`, "magiclink"],
    ["first-time signup link", `${base}?token_hash=abc&type=signup`, "signup"],
    ["link without a type", `${base}?token_hash=abc`, "magiclink"],
    ["token in the fragment", `${base}#token_hash=abc&type=magiclink`, "magiclink"],
  ])("verifies a %s once as %s", async (_label, url, expectedType) => {
    await openApp(delivery, url);
    await waitFor(() => expect(auth.verifyOtp).toHaveBeenCalledTimes(1));
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "abc", type: expectedType });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("exchanges a PKCE code", async () => {
    await openApp(delivery, `${base}?code=pkce-1`);
    await waitFor(() => expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("pkce-1"));
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it.each([
    ["raw access and refresh tokens", `${base}#access_token=a&refresh_token=r&type=magiclink`],
    ["no credential at all", base],
  ])("signs nobody in from %s", async (_label, url) => {
    const seen = await openApp(delivery, url);
    // Give any (wrong) async verification a chance to run before asserting none did.
    await act(async () => {
      await Promise.resolve();
    });
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(seen.latest?.authLinkError ?? null).toBeNull();
  });

  it("refuses an unknown link type, verifies nothing, and says so", async () => {
    const seen = await openApp(delivery, `${base}?token_hash=abc&type=impersonate`);
    await waitFor(() => expect(seen.latest?.authLinkError).toMatch(/could not finish signing you in/));
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  // Documented behaviour, not a requirement: the credential decides, not the path. The token is
  // single use and only signs into the account it was issued for.
  it("treats a token on any path as the same credential", async () => {
    await openApp(delivery, "danceflow://wallet?token_hash=abc&type=magiclink");
    await waitFor(() => expect(auth.verifyOtp).toHaveBeenCalledTimes(1));
  });

  it("tells the dancer when the link is expired or already used", async () => {
    auth.verifyOtp.mockResolvedValueOnce({
      error: Object.assign(new Error("Email link is invalid or has expired"), { code: "otp_expired" }),
    } as never);
    const seen = await openApp(delivery, `${base}?token_hash=old&type=magiclink`);
    await waitFor(() => expect(seen.latest?.authLinkError).toMatch(/expired or was already used/));
  });

  it("reports a server-side redirect error without verifying anything", async () => {
    const seen = await openApp(
      delivery,
      `${base}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid`,
    );
    await waitFor(() => expect(seen.latest?.authLinkError).toMatch(/expired or was already used/));
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
});
