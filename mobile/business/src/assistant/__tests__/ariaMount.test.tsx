import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { makeAriaAssistantRoot } from "../AriaAssistantRoot";

let mockPath = "/today";
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, usePathname: () => mockPath, useGlobalSearchParams: () => ({}) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@/lib/fontScale", () => ({ useFontScale: () => 1 }));

function mount(enabled: boolean) {
  const Root = makeAriaAssistantRoot(enabled);
  render(
    <Root>
      <Text>app</Text>
    </Root>,
  );
}

describe("ARIA mount", () => {
  beforeEach(() => {
    mockPath = "/today";
  });

  it("flag off: only the app renders, no launcher", () => {
    mount(false);
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
  });

  it("flag on: the launcher appears with ARIA's label", () => {
    mount(true);
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.getByLabelText("Open ARIA assistant")).toBeTruthy();
  });

  it.each(["/sign-in", "/auth/callback"])("flag on: no launcher on %s", (p) => {
    mockPath = p;
    mount(true);
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
  });
});
