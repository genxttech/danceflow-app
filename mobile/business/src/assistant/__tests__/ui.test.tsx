import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Keyboard, type EmitterSubscription } from "react-native";
import { auditA11y } from "@/test-utils/a11y";
import { AssistantHost, type AssistantTheme } from "../shared/ui";
import { AssistantProvider, useAssistant } from "../shared/provider";
import { createStubResponder } from "../shared/stubResponder";
import type { AssistantConfig } from "../shared/types";

jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

const theme: AssistantTheme = { background: "#fff", surface: "#f5f5f5", text: "#111", muted: "#555", border: "#ccc", primary: "#5b145e", onPrimary: "#fff", danger: "#a32a1e", scrim: "rgba(0,0,0,.4)" };

const config: AssistantConfig = {
  id: "aria",
  name: "TESTBOT",
  tone: "x",
  avatarInitials: "TB",
  introText: "Intro text",
  disclaimer: "Disclaimer text",
  capabilities: [],
  flagKey: "f",
  screens: [{ id: "today", label: "Today" }],
  deepLinks: [{ id: "today", template: "/today" }],
  promptsForScreen: () => [{ id: "s1", text: "Suggested question" }],
};

function Harness({ responder = createStubResponder({ fallback: "Stub answer", rules: [{ words: ["go"], reply: { text: "Sure", links: [{ target: "today", label: "Open Today" }] } }] }), onNavigate = jest.fn() }) {
  return (
    <AssistantProvider config={config} responder={responder}>
      <AssistantHost theme={theme} onNavigate={onNavigate} bottomOffset={72} />
    </AssistantProvider>
  );
}

let listeners: Record<string, (() => void)[]>;
beforeEach(() => {
  listeners = {};
  jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, cb: () => void) => {
    (listeners[event] ||= []).push(cb);
    return { remove: jest.fn() } as unknown as EmitterSubscription;
  }) as never);
});
afterEach(() => jest.restoreAllMocks());

describe("assistant UI", () => {
  it("renders nothing without a provider (flag off)", () => {
    render(<AssistantHost theme={theme} onNavigate={jest.fn()} />);
    expect(screen.toJSON()).toBeNull();
  });

  it("launcher has a role, label, hint and a 56dp target; passes the static a11y audit", () => {
    render(<Harness />);
    const launcher = screen.getByTestId("assistant-launcher");
    expect(launcher.props.accessibilityRole).toBe("button");
    expect(launcher.props.accessibilityLabel).toBe("Open TESTBOT assistant");
    expect(launcher.props.accessibilityHint).toBeTruthy();
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
  });

  it("opens the sheet with intro, disclaimer and suggestions; sheet passes the audit", () => {
    render(<Harness />);
    fireEvent.press(screen.getByTestId("assistant-launcher"));
    expect(screen.getByText("Intro text")).toBeTruthy();
    expect(screen.getByText("Disclaimer text")).toBeTruthy();
    expect(screen.getByLabelText("Suggested question")).toBeTruthy();
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
  });

  it("sends a message, shows the typing state then the answer, and keeps the thread after close and reopen", async () => {
    jest.useFakeTimers();
    render(<Harness responder={createStubResponder({ fallback: "Stub answer", delayMs: 100 })} />);
    fireEvent.press(screen.getByTestId("assistant-launcher"));
    fireEvent.changeText(screen.getByLabelText("Message TESTBOT"), "hello");
    fireEvent.press(screen.getByLabelText("Send message"));
    expect(screen.getByLabelText("TESTBOT is typing")).toBeTruthy();
    expect(screen.getByLabelText("Stop")).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.getByText("Stub answer")).toBeTruthy();
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
    fireEvent.press(screen.getByLabelText("Minimize assistant", { exact: true }) ?? screen.getAllByLabelText("Minimize assistant")[0]);
    fireEvent.press(screen.getByTestId("assistant-launcher"));
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("Stub answer")).toBeTruthy();
    jest.useRealTimers();
  });

  it("shows an error with Retry", async () => {
    const responder = createStubResponder({ fallback: "Recovered", failWith: "network", failOnCall: 1 });
    render(<Harness responder={responder} />);
    fireEvent.press(screen.getByTestId("assistant-launcher"));
    fireEvent.changeText(screen.getByLabelText("Message TESTBOT"), "hi");
    await act(async () => fireEvent.press(screen.getByLabelText("Send message")));
    await act(async () => undefined);
    expect(await screen.findByText(/Couldn.t reach the assistant/)).toBeTruthy();
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
    await act(async () => fireEvent.press(screen.getByLabelText("Retry")));
    await act(async () => undefined);
    expect(await screen.findByText("Recovered")).toBeTruthy();
  });

  it("a whitelisted link closes the sheet and navigates; the app gets only the resolved href", async () => {
    const onNavigate = jest.fn();
    render(<Harness onNavigate={onNavigate} />);
    fireEvent.press(screen.getByTestId("assistant-launcher"));
    fireEvent.changeText(screen.getByLabelText("Message TESTBOT"), "go");
    await act(async () => fireEvent.press(screen.getByLabelText("Send message")));
    await act(async () => undefined);
    fireEvent.press(await screen.findByLabelText("Open Today"));
    expect(onNavigate).toHaveBeenCalledWith("/today");
    expect(screen.getByTestId("assistant-launcher")).toBeTruthy();
  });

  it("hides the launcher while the keyboard is up", () => {
    render(<Harness />);
    expect(screen.queryByTestId("assistant-launcher")).toBeTruthy();
    act(() => (listeners.keyboardDidShow ?? listeners.keyboardWillShow ?? []).forEach((cb) => cb()));
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
    act(() => (listeners.keyboardDidHide ?? listeners.keyboardWillHide ?? []).forEach((cb) => cb()));
    expect(screen.queryByTestId("assistant-launcher")).toBeTruthy();
  });

  it("hides the launcher while another sheet asked it to step aside", () => {
    let release: (() => void) | undefined;
    function Probe() {
      const api = useAssistant();
      return <ProbeButton onPress={() => (release = api.suppress())} />;
    }
    function ProbeButton({ onPress }: { onPress: () => void }) {
      const { Pressable } = jest.requireActual("react-native");
      return <Pressable testID="probe" onPress={onPress} />;
    }
    render(
      <AssistantProvider config={config} responder={createStubResponder({ fallback: "x" })}>
        <Probe />
        <AssistantHost theme={theme} onNavigate={jest.fn()} />
      </AssistantProvider>,
    );
    fireEvent.press(screen.getByTestId("probe"));
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
    act(() => release?.());
    expect(screen.queryByTestId("assistant-launcher")).toBeTruthy();
  });

  it("full-screen mode toggles and a Clear empties the thread", async () => {
    render(<Harness />);
    fireEvent.press(screen.getByTestId("assistant-launcher"));
    fireEvent.press(screen.getByLabelText("Expand to full screen"));
    expect(screen.getByLabelText("Show as sheet")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Message TESTBOT"), "hello");
    await act(async () => fireEvent.press(screen.getByLabelText("Send message")));
    await act(async () => undefined);
    fireEvent.press(screen.getByLabelText("Clear conversation"));
    expect(screen.getByText("Intro text")).toBeTruthy();
  });
});
