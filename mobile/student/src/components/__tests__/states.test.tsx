import { fireEvent, render, renderHook, screen } from "@testing-library/react-native";
import { Platform } from "react-native";

let mockReducedMotion = false;
jest.mock("react-native-reanimated", () => {
  const Reanimated = jest.requireActual("react-native-reanimated/mock");
  // Tagged builders so a test can see which entrance preset was chosen.
  const tagged = (name: string) => {
    const builder: Record<string, unknown> = { preset: name };
    for (const method of ["duration", "delay", "easing", "withInitialValues"]) builder[method] = () => builder;
    return builder;
  };
  return { ...Reanimated, FadeIn: tagged("FadeIn"), FadeInDown: tagged("FadeInDown"), useReducedMotion: () => mockReducedMotion };
});
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import { ErrorState } from "@/components/ErrorState";
import { LoadingState } from "@/components/LoadingState";
import { enterUp, pressedTransform, useEnterUp } from "@/lib/motion";

import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

// One-off renderer load, outside the tests' own timeouts (see warmUpRenderer).
beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

describe("LoadingState", () => {
  it("is announced as a busy progress indicator with its label, not as placeholder text", () => {
    render(<LoadingState label="Loading tickets" rows={3} />);
    const state = screen.getByTestId("loading-state");
    expect(state.props.accessibilityRole).toBe("progressbar");
    expect(state.props.accessibilityLabel).toBe("Loading tickets");
    expect(state.props.accessibilityState).toEqual({ busy: true });
    expect(screen.queryByText(/Loading/)).toBeNull();
  });
});

describe("ErrorState", () => {
  it.each([
    ["Network request failed", "offline", "You're offline"],
    ["Authentication required.", "signedOut", "Sign in again"],
    ["Not authorized to view this.", "forbidden", "No access"],
    ["This recap could not be found.", "notFound", "Not available"]
  ])("shows a distinct state for %p", (error, kind, title) => {
    render(<ErrorState error={error} title="Recaps unavailable" />);
    expect(screen.getByTestId(`error-state-${kind}`).props.accessibilityRole).toBe("alert");
    expect(screen.getByText(title)).toBeTruthy();
  });

  it("keeps the screen's title and message for an unknown failure", () => {
    render(<ErrorState error="Stripe returned an unexpected response." title="Checkout needs attention" />);
    expect(screen.getByTestId("error-state-unknown")).toBeTruthy();
    expect(screen.getByText("Checkout needs attention")).toBeTruthy();
    expect(screen.getByText("Stripe returned an unexpected response.")).toBeTruthy();
  });

  it("uses the fallback when there is no message", () => {
    render(<ErrorState error={null} fallback="This event could not be loaded." title="Event unavailable" />);
    expect(screen.getByText("This event could not be loaded.")).toBeTruthy();
  });

  it("offers a retry for failures a retry can fix, and not for signed-out or no-access", () => {
    const onRetry = jest.fn();
    const { rerender } = render(<ErrorState error="Network request failed" onRetry={onRetry} title="Wallet unavailable" />);
    fireEvent.press(screen.getByText("Try again"));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<ErrorState error="Authentication required." onRetry={onRetry} title="Wallet unavailable" />);
    expect(screen.queryByText("Try again")).toBeNull();
    rerender(<ErrorState error="Not authorized." onRetry={onRetry} title="Wallet unavailable" />);
    expect(screen.queryByText("Try again")).toBeNull();
  });
});

describe("motion presets with Reduce Motion", () => {
  afterEach(() => {
    mockReducedMotion = false;
  });

  it("press feedback has no movement when Reduce Motion is on", () => {
    expect(pressedTransform(false)).toEqual([{ scale: 0.985 }]);
    expect(pressedTransform(true)).toEqual([]);
  });

  it("entering content fades without moving when Reduce Motion is on", () => {
    expect((enterUp(false) as unknown as { preset: string }).preset).toBe("FadeInDown");
    expect((enterUp(true) as unknown as { preset: string }).preset).toBe("FadeIn");
  });

  it("skips entering animations on web, where Reanimated's cleanup can throw", () => {
    expect((renderHook(() => useEnterUp()).result.current as unknown as { preset: string }).preset).toBe("FadeInDown");
    const restore = jest.replaceProperty(Platform, "OS", "web");
    try {
      expect(renderHook(() => useEnterUp()).result.current).toBeUndefined();
    } finally {
      restore.restore();
    }
  });
});
