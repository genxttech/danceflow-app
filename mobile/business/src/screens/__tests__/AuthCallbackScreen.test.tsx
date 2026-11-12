import type React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AuthCallbackScreen, CALLBACK_TIMEOUT_MS } from "@/screens/AuthCallbackScreen";
import { isAuthCallbackUrl } from "@/lib/auth";

jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});
// auth.tsx builds a Supabase client at import; the screen and the URL filter don't need a live one
jest.mock("@/lib/supabase", () => ({ supabase: { auth: {} }, clearPersistedSupabaseSessions: jest.fn() }));

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function renderCallback(props: Partial<React.ComponentProps<typeof AuthCallbackScreen>> = {}) {
  const onDone = jest.fn();
  const onBackToSignIn = jest.fn();
  const utils = render(<AuthCallbackScreen signedIn={false} linkStatus="processing" onDone={onDone} onBackToSignIn={onBackToSignIn} {...props} />);
  return { onDone, onBackToSignIn, ...utils };
}

describe("AuthCallbackScreen", () => {
  it("shows a labelled progress state while the link is exchanged", () => {
    renderCallback();
    expect(screen.getByLabelText("Signing you in")).toBeTruthy();
    expect(screen.getByText("Signing you in…")).toBeTruthy();
  });

  it("leaves for the app as soon as there is a session", () => {
    const { onDone, rerender, onBackToSignIn } = renderCallback();
    rerender(<AuthCallbackScreen signedIn linkStatus="idle" onDone={onDone} onBackToSignIn={onBackToSignIn} />);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("says the link didn't work, as an alert, and offers sign-in", () => {
    const { onBackToSignIn } = renderCallback({ linkStatus: "failed" });
    expect(screen.getByTestId("callback-failed").props.accessibilityRole).toBe("alert");
    expect(screen.getByText("This sign-in link didn't work")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Back to sign in" }));
    expect(onBackToSignIn).toHaveBeenCalledTimes(1);
  });

  it("gives up on a link that never resolves, but not while an exchange is still running", async () => {
    const { rerender, onDone, onBackToSignIn } = renderCallback({ linkStatus: "processing" });
    await act(async () => {
      jest.advanceTimersByTime(CALLBACK_TIMEOUT_MS + 1);
    });
    expect(screen.getByLabelText("Signing you in")).toBeTruthy();
    rerender(<AuthCallbackScreen signedIn={false} linkStatus="idle" onDone={onDone} onBackToSignIn={onBackToSignIn} />);
    expect(screen.getByTestId("callback-failed")).toBeTruthy();
  });
});

describe("isAuthCallbackUrl", () => {
  it("accepts the callback path and links that carry a code or token hash", () => {
    expect(isAuthCallbackUrl("danceflow-business://auth/callback")).toBe(true);
    expect(isAuthCallbackUrl("danceflow-business://auth/callback?code=abc")).toBe(true);
    expect(isAuthCallbackUrl("danceflow-business://auth/callback#token_hash=h&type=magiclink")).toBe(true);
    expect(isAuthCallbackUrl("http://localhost:8790/?code=abc")).toBe(true);
  });

  it("ignores the dev client's own URL and ordinary deep links", () => {
    expect(isAuthCallbackUrl("exp+danceflow-business://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081")).toBe(false);
    expect(isAuthCallbackUrl("danceflow-business://today")).toBe(false);
  });
});
