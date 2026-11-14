jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import { render, screen, waitFor } from "@testing-library/react-native";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

let mockParams: Record<string, string> = {};
let mockAuth: Record<string, unknown> = {};

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn(), setParams: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock("@/lib/auth", () => ({ useAuth: () => mockAuth }));
jest.mock("@/lib/afterSignIn", () => ({ continueAfterSignIn: jest.fn(async () => "/(tabs)/home") }));
jest.mock("@/components/Screen", () => ({ Screen: ({ children }: { children: React.ReactNode }) => children }));

import AuthCallbackScreen from "../../../app/auth/callback";
import { router as mockRouter } from "expo-router";
import { continueAfterSignIn } from "@/lib/afterSignIn";

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockAuth = {
    session: null,
    loading: false,
    identityCheckPending: false,
    emailBindingRequired: false,
    authLinkError: null,
  };
});

describe("auth callback screen", () => {
  it("shows the plain-language reason when the link was expired or used, with a way to request a new one", async () => {
    mockAuth.authLinkError = "That sign-in link has expired or was already used. Request a new link to continue.";
    render(<AuthCallbackScreen />);

    await waitFor(() => expect(screen.getByText("Sign in needs another try")).toBeTruthy());
    expect(screen.getByText(/expired or was already used/)).toBeTruthy();
    expect(screen.getByText("Request a new link")).toBeTruthy();
    expect(continueAfterSignIn).not.toHaveBeenCalled();
  });

  it("never shows a provider description from the route", async () => {
    mockParams = { error: "access_denied", error_description: "raw provider text" };
    render(<AuthCallbackScreen />);

    await waitFor(() => expect(screen.getByText(/could not be used/)).toBeTruthy());
    expect(screen.queryByText(/raw provider text/)).toBeNull();
  });

  it("removes the one-time token from the route params", async () => {
    mockParams = { token_hash: "secret-hash", type: "magiclink" };
    render(<AuthCallbackScreen />);

    await waitFor(() =>
      expect(mockRouter.setParams).toHaveBeenCalledWith({ token_hash: undefined, code: undefined, type: undefined }),
    );
  });

  it("continues to the remembered destination once the session exists, exactly once", async () => {
    mockAuth.session = { access_token: "t" };
    const view = render(<AuthCallbackScreen />);
    await waitFor(() => expect(continueAfterSignIn).toHaveBeenCalledTimes(1));
    view.rerender(<AuthCallbackScreen />);
    expect(continueAfterSignIn).toHaveBeenCalledTimes(1);
  });

  it("sends a first-time mailbox proof to account binding, not to the destination", async () => {
    mockAuth.session = { access_token: "t" };
    mockAuth.emailBindingRequired = true;
    render(<AuthCallbackScreen />);

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith("/auth/secure-account"));
    expect(continueAfterSignIn).not.toHaveBeenCalled();
  });
});
