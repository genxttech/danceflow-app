/*
  The open Android keyboard covered the email field and "Send secure link" on the sign-in screen:
  the window draws edge to edge, so it does not resize by itself. The screen opts into keeping its
  end above the keyboard, and the keyboard's send key sends the request.
*/
const mockContinueWithEmail = jest.fn();

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("@/lib/auth", () => ({
  useAuth: () => ({ continueWithEmail: mockContinueWithEmail }),
}));
jest.mock("@/components/LegalLinks", () => ({ LegalLinks: () => null }));
jest.mock("expo-linear-gradient", () => ({
  LinearGradient: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, Text } from "react-native";
import SignInScreen from "../../../app/(auth)/sign-in";
import { Screen } from "@/components/Screen";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

afterEach(() => jest.restoreAllMocks());

/** The KeyboardAvoidingView that wraps the ScrollView, if there is one. */
function keyboardAreas(view: ReturnType<typeof render>) {
  return view
    .UNSAFE_queryAllByType(KeyboardAvoidingView)
    .filter((area) => area.findAllByType(ScrollView).length > 0);
}

describe("sign-in above the Android keyboard", () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, "OS", "android");
  });

  it("shrinks the scroll area by the keyboard", () => {
    const view = render(<SignInScreen />);
    const areas = keyboardAreas(view);
    expect(areas).toHaveLength(1);
    expect(areas[0].props.behavior).toBe("padding");
  });

  it("scrolls to the button when the area is resized with the keyboard open", () => {
    const visible = jest.spyOn(Keyboard, "isVisible").mockReturnValue(false);
    const view = render(<SignInScreen />);
    const scrollView = view.UNSAFE_getByType(ScrollView);
    const scrollToEnd = jest.spyOn(scrollView.instance as ScrollView, "scrollToEnd");

    act(() => scrollView.props.onLayout());
    expect(scrollToEnd).not.toHaveBeenCalled();

    visible.mockReturnValue(true);
    act(() => scrollView.props.onLayout());
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("leaves screens that did not ask for it unchanged", () => {
    const view = render(
      <Screen>
        <Text>Other screen</Text>
      </Screen>,
    );
    expect(keyboardAreas(view)).toHaveLength(0);
    expect(view.UNSAFE_getByType(ScrollView).props.onLayout).toBeUndefined();
  });
});

describe("sign-in above the iOS keyboard", () => {
  it("keeps relying on the ScrollView's own keyboard insets", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const view = render(<SignInScreen />);
    expect(keyboardAreas(view)).toHaveLength(0);
    const scrollView = view.UNSAFE_getByType(ScrollView);
    expect(scrollView.props.onLayout).toBeUndefined();
    expect(scrollView.props.automaticallyAdjustKeyboardInsets).toBe(true);
  });
});

describe("the keyboard's send key", () => {
  const field = () => screen.getByPlaceholderText("Email");

  it("is labelled send", () => {
    render(<SignInScreen />);
    expect(field().props.returnKeyType).toBe("send");
  });

  it("sends the request for a typed address", async () => {
    mockContinueWithEmail.mockResolvedValue(undefined);
    render(<SignInScreen />);
    fireEvent.changeText(field(), "dana.dancer@example.test");
    await act(async () => {
      fireEvent(field(), "submitEditing");
    });
    expect(mockContinueWithEmail).toHaveBeenCalledTimes(1);
    expect(mockContinueWithEmail).toHaveBeenCalledWith("dana.dancer@example.test");
    expect(screen.getByText(/Check your email/)).toBeTruthy();
  });

  it.each(["", "   "])("does nothing while the field is %j", async (value) => {
    render(<SignInScreen />);
    fireEvent.changeText(field(), value);
    await act(async () => {
      fireEvent(field(), "submitEditing");
    });
    expect(mockContinueWithEmail).not.toHaveBeenCalled();
  });

  it("does not send a second request while one is in flight", async () => {
    let finish: () => void = () => {};
    mockContinueWithEmail.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(<SignInScreen />);
    fireEvent.changeText(field(), "dana.dancer@example.test");
    fireEvent(field(), "submitEditing");
    fireEvent(field(), "submitEditing");
    expect(mockContinueWithEmail).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});
