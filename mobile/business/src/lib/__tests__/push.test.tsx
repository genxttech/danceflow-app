import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import type React from "react";
import { NotificationsCard } from "@/components/NotificationsCard";
import { PushProvider, usePushTaps, type TapSource } from "@/lib/push";
import type { PushAdapter } from "@/lib/pushSetup";

const A = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";

function fakeAdapter(over: Partial<PushAdapter> = {}): PushAdapter {
  return {
    getPermission: jest.fn(async () => "undetermined" as const),
    requestPermission: jest.fn(async () => "granted" as const),
    getDeviceToken: jest.fn(async () => "tok"),
    ...over,
  };
}

const wrap = (value: React.ComponentProps<typeof PushProvider>["value"]) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <PushProvider value={value}>{children}</PushProvider>;
  };

describe("NotificationsCard", () => {
  it("renders nothing without an adapter (a build with no push)", () => {
    render(<NotificationsCard />, { wrapper: wrap(null) });
    expect(screen.queryByTestId("notifications")).toBeNull();
  });

  it("asks only when the user taps, then shows on", async () => {
    const adapter = fakeAdapter();
    render(<NotificationsCard />, { wrapper: wrap({ adapter, register: jest.fn(async () => {}) }) });
    await screen.findByText("Turn on notifications");
    expect(adapter.requestPermission).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText("Turn on notifications"));
    expect(await screen.findByText("Notifications are on.")).toBeTruthy();
    expect(adapter.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("explains a denied permission and offers no prompt", async () => {
    render(<NotificationsCard />, { wrapper: wrap({ adapter: fakeAdapter({ getPermission: async () => "denied" }) }) });
    expect(await screen.findByTestId("notifications-denied")).toBeTruthy();
    expect(screen.queryByText("Turn on notifications")).toBeNull();
  });

  it("says unavailable without credentials and does not crash", async () => {
    const adapter = fakeAdapter({ getPermission: async () => "granted", getDeviceToken: async () => Promise.reject(new Error("no firebase")) });
    render(<NotificationsCard />, { wrapper: wrap({ adapter }) });
    expect(await screen.findByTestId("notifications-unavailable")).toBeTruthy();
  });
});

describe("usePushTaps", () => {
  function source(initial: unknown = null) {
    let handler: (data: unknown) => void = () => {};
    const off = jest.fn();
    const taps: TapSource = {
      subscribe: (h) => {
        handler = h;
        return off;
      },
      getInitial: async () => initial,
    };
    return { taps, emit: (d: unknown) => handler(d), off };
  }

  it("routes a live tap and a launch notification, and unsubscribes", async () => {
    const { taps, emit, off } = source({ type: "appointment", id: A, studioId: S });
    const navigate = jest.fn();
    const { unmount } = renderHook(() => usePushTaps(navigate), { wrapper: wrap({ adapter: fakeAdapter(), taps }) });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ pathname: "/appointments/[id]", params: { id: A, studioId: S } }));
    act(() => emit({ type: "client", id: A, studioId: S }));
    expect(navigate).toHaveBeenLastCalledWith({ pathname: "/clients/[id]", params: { id: A, studioId: S } });
    act(() => emit({ type: "evil", id: "../x" }));
    expect(navigate).toHaveBeenLastCalledWith({ pathname: "/today" });
    unmount();
    expect(off).toHaveBeenCalled();
  });

  it("does nothing without a tap source", () => {
    const navigate = jest.fn();
    renderHook(() => usePushTaps(navigate), { wrapper: wrap({ adapter: fakeAdapter() }) });
    expect(navigate).not.toHaveBeenCalled();
  });
});
