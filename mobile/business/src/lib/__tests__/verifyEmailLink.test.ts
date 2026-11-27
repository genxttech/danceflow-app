/* The client that checks an emailed link saves nothing and refreshes nothing, so an unaccepted session never reaches the app. */
const mockVerifyOtp = jest.fn(async () => ({ data: {}, error: null }));
const mockCreateClient = jest.fn((url: string, key: string, options: unknown) => ({ url, key, options, auth: { verifyOtp: mockVerifyOtp } }));
jest.mock("@supabase/supabase-js", () => ({ createClient: (url: string, key: string, options: unknown) => mockCreateClient(url, key, options) }));
jest.mock("react-native-url-polyfill/auto", () => ({}));
jest.mock("@/lib/secureSessionStorage", () => ({ secureSessionStorage: {}, clearPersistedSessions: jest.fn() }));

describe("verifyEmailLink", () => {
  it("uses a throwaway client: no persistence, no storage, no refresh, its own key", async () => {
    // loaded after the mocks are in place
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { verifyEmailLink } = require("@/lib/supabase") as typeof import("@/lib/supabase");
    mockCreateClient.mockClear();
    await verifyEmailLink({ token_hash: "h", type: "magiclink" });
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const auth = (mockCreateClient.mock.calls[0][2] as { auth: Record<string, unknown> }).auth;
    expect(auth).toMatchObject({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
    expect(auth.storage).toBeUndefined();
    expect(String(auth.storageKey)).toMatch(/-link-check$/);
    expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: "h", type: "magiclink" });
  });
});
