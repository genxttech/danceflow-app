import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { MoreScreen } from "@/screens/MoreScreen";
import { fakeApi, StaffTestProviders, workspace } from "@/test-utils/staff";

jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const A = workspace({ studioId: "a", name: "Maple Street Dance", publicName: null, role: "instructor" });
const B = workspace({ studioId: "b", name: "Harbor Ballroom", publicName: null, role: "studio_owner" });
const PAUSED = workspace({ studioId: "p", name: "Old Studio", publicName: null, role: "instructor", accessAllowed: false });

function renderMore(extra: Partial<React.ComponentProps<typeof StaffTestProviders>> = {}) {
  const props = {
    signOut: jest.fn(async () => undefined),
    signOutEverywhere: jest.fn(async () => true),
    selectWorkspace: jest.fn(),
    ...extra,
  };
  render(
    <StaffTestProviders api={fakeApi()} ws={A} user={{ id: "u", email: "ida@example.test", fullName: "Ida Instructor" }} {...props}>
      <MoreScreen />
    </StaffTestProviders>,
  );
  return props;
}

describe("MoreScreen", () => {
  it("shows the profile: name, email and role at the current studio", () => {
    renderMore();
    expect(screen.getByText("Ida Instructor")).toBeTruthy();
    expect(screen.getByText("ida@example.test")).toBeTruthy();
    expect(screen.getByText("Instructor at Maple Street Dance")).toBeTruthy();
  });

  it("has no switcher with one studio", () => {
    renderMore();
    expect(screen.queryByTestId("studio-switcher")).toBeNull();
    expect(screen.getByTestId("single-studio")).toBeTruthy();
  });

  it("offers a radio switcher with several studios, marks the current one, and switches", () => {
    const { selectWorkspace } = renderMore({ workspaces: [A, B, PAUSED] });
    expect(screen.getByLabelText("Switch studio")).toBeTruthy();
    const current = screen.getByRole("radio", { name: "Maple Street Dance, Instructor" });
    expect(current.props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByRole("radio", { name: "Old Studio, Instructor · Paused" })).toBeTruthy();

    fireEvent.press(screen.getByRole("radio", { name: "Harbor Ballroom, Owner" }));
    expect(selectWorkspace).toHaveBeenCalledWith("b");
  });

  it("signs out on this device", () => {
    const { signOut, signOutEverywhere } = renderMore();
    fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOutEverywhere).not.toHaveBeenCalled();
  });

  it("asks before signing out of all devices, and can be cancelled", () => {
    const { signOutEverywhere } = renderMore();
    fireEvent.press(screen.getByRole("button", { name: "Sign out of all devices" }));
    expect(screen.getByText("Sign out of all devices?")).toBeTruthy();
    expect(signOutEverywhere).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Sign out of all devices?")).toBeNull();
  });

  it("signs out everywhere after confirming", async () => {
    const { signOutEverywhere } = renderMore();
    fireEvent.press(screen.getByRole("button", { name: "Sign out of all devices" }));
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Sign out everywhere" }));
    });
    expect(signOutEverywhere).toHaveBeenCalledTimes(1);
  });

  it("says so, and stays signed in, when signing out everywhere fails", async () => {
    renderMore({ signOutEverywhere: jest.fn(async () => false) });
    fireEvent.press(screen.getByRole("button", { name: "Sign out of all devices" }));
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Sign out everywhere" }));
    });
    expect(screen.getByTestId("sign-out-everywhere-failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeTruthy();
  });

  it("explains a paused studio", () => {
    render(
      <StaffTestProviders api={fakeApi()} ws={PAUSED}>
        <MoreScreen />
      </StaffTestProviders>,
    );
    expect(screen.getByTestId("workspace-paused")).toBeTruthy();
  });
});
