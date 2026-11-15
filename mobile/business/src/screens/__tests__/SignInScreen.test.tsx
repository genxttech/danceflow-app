import { act, fireEvent, render, screen } from "@testing-library/react-native";
import SignInScreen from "../../../app/sign-in";

/*
  Behaviour of the sign-in screen (its accessibility audit is in src/__tests__/a11y.test.tsx): when each button is enabled, what happens while a request is in
  flight, and that neither message tells a stranger whether an email belongs to studio staff.
*/

jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const mockAuth = { signInWithPassword: jest.fn(), sendSignInLink: jest.fn() };
jest.mock("@/lib/auth", () => ({ useAuth: () => mockAuth }));
jest.setTimeout(20_000);

const email = () => screen.getByLabelText("Email");
const password = () => screen.getByLabelText("Password");
const signIn = () => screen.getByRole("button", { name: "Sign in" });
const link = () => screen.getByRole("button", { name: "Email me a sign-in link" });
const disabled = (node: { props: { accessibilityState?: { disabled?: boolean } } }) => node.props.accessibilityState?.disabled === true;

function fill(e = "ida@example.test", p = "secret-pw") {
  if (e) fireEvent.changeText(email(), e);
  if (p) fireEvent.changeText(password(), p);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.signInWithPassword.mockResolvedValue(undefined);
  mockAuth.sendSignInLink.mockResolvedValue(undefined);
  render(<SignInScreen />);
});

describe("which buttons are enabled", () => {
  it("both are off until there is something to send", () => {
    expect(disabled(signIn())).toBe(true);
    expect(disabled(link())).toBe(true);
  });

  it("an email alone turns on the link button, and Sign in needs the password too", () => {
    fill("ida@example.test", "");
    expect(disabled(link())).toBe(false);
    expect(disabled(signIn())).toBe(true);
    fill("", "secret-pw");
    expect(disabled(signIn())).toBe(false);
  });

  it("an email of only spaces does not count", () => {
    fill("   ", "secret-pw");
    expect(disabled(signIn())).toBe(true);
    expect(disabled(link())).toBe(true);
  });

  it("the fields are set up for credentials: the password is hidden, the email is not auto-capitalised or corrected", () => {
    expect(password().props.secureTextEntry).toBe(true);
    expect(email().props.autoCapitalize).toBe("none");
    expect(email().props.autoCorrect).toBe(false);
  });
});

describe("signing in with a password", () => {
  it("sends what was typed, once", async () => {
    fill();
    await act(async () => fireEvent.press(signIn()));
    expect(mockAuth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(mockAuth.signInWithPassword).toHaveBeenCalledWith("ida@example.test", "secret-pw");
  });

  it("while the request is out both buttons are off and Sign in shows busy; afterwards they come back", async () => {
    let finish: () => void = () => undefined;
    mockAuth.signInWithPassword.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    fill();
    await act(async () => fireEvent.press(signIn()));
    expect(disabled(signIn())).toBe(true);
    expect(disabled(link())).toBe(true);
    expect(signIn().props.accessibilityState.busy).toBe(true);
    await act(async () => finish());
    expect(disabled(signIn())).toBe(false);
  });

  it("a refusal says the pair did not match without saying which half, as an alert, and offers the link instead", async () => {
    mockAuth.signInWithPassword.mockRejectedValue(new Error("Invalid login credentials"));
    fill();
    await act(async () => fireEvent.press(signIn()));
    const alert = screen.getByRole("alert");
    expect(alert.props.children).toBe("That email and password did not match. Try again, or email yourself a sign-in link.");
    expect(JSON.stringify(alert.props.children)).not.toMatch(/Invalid login|user not found|wrong password/i);
    expect(disabled(link())).toBe(false);
  });

  it("the error is cleared when the next attempt starts", async () => {
    mockAuth.signInWithPassword.mockRejectedValueOnce(new Error("no")).mockResolvedValueOnce(undefined);
    fill();
    await act(async () => fireEvent.press(signIn()));
    expect(screen.queryByRole("alert")).toBeTruthy();
    await act(async () => fireEvent.press(signIn()));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Done on the keyboard signs in only when both fields are filled", async () => {
    fill("ida@example.test", "");
    await act(async () => fireEvent(password(), "submitEditing"));
    expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();
    fill("", "secret-pw");
    await act(async () => fireEvent(password(), "submitEditing"));
    expect(mockAuth.signInWithPassword).toHaveBeenCalledTimes(1);
  });
});

describe("the emailed link", () => {
  it("sends the link for the typed email and confirms in words that do not reveal whether the account exists", async () => {
    fill("ida@example.test", "");
    await act(async () => fireEvent.press(link()));
    expect(mockAuth.sendSignInLink).toHaveBeenCalledWith("ida@example.test");
    const note = screen.getByText(/a sign-in link is on its way/);
    expect(note.props.children).toBe("If this email belongs to studio staff, a sign-in link is on its way. Open it on this device.");
    expect(note.props.accessibilityLiveRegion).toBe("polite");
  });

  it("a failure is an alert that asks for a retry, and a later success replaces it", async () => {
    mockAuth.sendSignInLink.mockRejectedValueOnce(new Error("rate limit")).mockResolvedValueOnce(undefined);
    fill("ida@example.test", "");
    await act(async () => fireEvent.press(link()));
    expect(screen.getByRole("alert").props.children).toBe("We could not send a link right now. Check the address and try again.");
    expect(JSON.stringify(screen.getByRole("alert").props.children)).not.toMatch(/rate limit/);
    await act(async () => fireEvent.press(link()));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/a sign-in link is on its way/)).toBeTruthy();
  });

  it("a password failure after a sent link replaces the success note", async () => {
    mockAuth.signInWithPassword.mockRejectedValue(new Error("no"));
    fill();
    await act(async () => fireEvent.press(link()));
    expect(screen.queryByText(/on its way/)).toBeTruthy();
    await act(async () => fireEvent.press(signIn()));
    expect(screen.queryByText(/on its way/)).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
