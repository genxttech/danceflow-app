import { render, screen, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { makeLumiAssistantRoot } from "../LumiAssistantRoot";

let mockPath = "/home";
let mockSession: { user: { id: string } } | null = { user: { id: "u1" } };
const mockAccess = jest.fn();
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, usePathname: () => mockPath, useGlobalSearchParams: () => ({}) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@/lib/fontScale", () => ({ useFontScale: () => 1 }));
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ session: mockSession }) }));
jest.mock("@/lib/studentAccess", () => ({ getStudentAccess: (...a: unknown[]) => mockAccess(...a) }));

function mount(enabled: boolean) {
  const Root = makeLumiAssistantRoot(enabled);
  render(
    <Root>
      <Text>app</Text>
    </Root>,
  );
}

describe("LUMI mount", () => {
  beforeEach(() => {
    mockPath = "/home";
    mockSession = { user: { id: "u1" } };
    mockAccess.mockReset();
    mockAccess.mockResolvedValue({ lumiEnabled: true });
  });

  it("flag off: only the app renders and the access endpoint is never read", () => {
    mount(false);
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it("flag on + server lumiEnabled: the LUMI launcher appears", async () => {
    mount(true);
    expect(await screen.findByLabelText("Open LUMI assistant")).toBeTruthy();
    expect(screen.getByText("app")).toBeTruthy();
  });

  it("flag on but the studio has LUMI off: nothing renders", async () => {
    mockAccess.mockResolvedValue({ lumiEnabled: false });
    mount(true);
    await waitFor(() => expect(mockAccess).toHaveBeenCalled());
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
  });

  it("flag on but the access read fails: nothing renders", async () => {
    mockAccess.mockRejectedValue(new Error("offline"));
    mount(true);
    await waitFor(() => expect(mockAccess).toHaveBeenCalled());
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
  });

  it("flag on, signed out: no access read, nothing renders", () => {
    mockSession = null;
    mount(true);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
  });

  it.each(["/sign-in", "/lumi", "/events/abc/register"])("flag on: no launcher on %s", async (p) => {
    mockPath = p;
    mount(true);
    await waitFor(() => expect(mockAccess).toHaveBeenCalled());
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
  });
});
