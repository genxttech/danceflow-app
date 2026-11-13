import { render } from "@testing-library/react-native";
import { initialsFor } from "@/lib/initials";

const mockScreens: Array<{ name: string; options: Record<string, unknown> }> = [];
let mockSession: { user: { id: string } } | null = { user: { id: "u1" } };
let mockSegments: string[] = [];
const mockRedirects: string[] = [];

jest.mock("expo-router", () => {
  const React = jest.requireActual("react");
  function Tabs({ children }: { children: React.ReactNode }) {
    return React.createElement(React.Fragment, null, children);
  }
  function TabsScreen(props: { name: string; options: Record<string, unknown> }) {
    mockScreens.push(props);
    return null;
  }
  Tabs.Screen = TabsScreen;
  return {
    Tabs,
    Redirect: ({ href }: { href: string }) => {
      mockRedirects.push(href);
      return null;
    },
    useSegments: () => mockSegments,
  };
});
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ loading: false, session: mockSession }) }));
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

// eslint-disable-next-line import/first
import TabsLayout from "../../../app/(tabs)/_layout";

import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

// One-off renderer load, outside the tests' own timeouts (see warmUpRenderer).
beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

describe("tab bar", () => {
  beforeAll(() => {
    render(<TabsLayout />);
  });

  it("shows Today, Discover, Learn and Wallet, in that order", () => {
    const visible = mockScreens.filter((screen) => screen.options.href !== null);
    expect(visible.map((screen) => [screen.name, screen.options.title])).toEqual([
      ["home", "Today"],
      ["discover", "Discover"],
      ["learn", "Learn"],
      ["wallet", "Wallet"]
    ]);
    for (const screen of visible) expect(screen.options.tabBarAccessibilityLabel).toBe(screen.options.title);
  });

  it("keeps Schedule and More as routes outside the tab bar", () => {
    const hidden = mockScreens.filter((screen) => screen.options.href === null).map((screen) => screen.name);
    expect(hidden.sort()).toEqual(["more", "schedule"]);
  });
});

describe("guest tab layout", () => {
  beforeEach(() => {
    mockScreens.length = 0;
    mockRedirects.length = 0;
    mockSession = null;
  });
  afterAll(() => {
    mockSession = { user: { id: "u1" } };
    mockSegments = [];
  });

  it("opens only Discover to a signed-out visitor", () => {
    mockSegments = ["(tabs)", "discover"];
    render(<TabsLayout />);
    expect(mockRedirects).toEqual([]);
    const visible = mockScreens.filter((screen) => screen.options.href !== null).map((screen) => screen.name);
    expect(visible).toEqual(["discover"]);
  });

  it.each(["home", "learn", "wallet", "schedule", "more"])("sends a guest on the %s tab to sign-in", (tab) => {
    mockSegments = ["(tabs)", tab];
    render(<TabsLayout />);
    expect(mockRedirects).toEqual(["/(auth)/sign-in"]);
  });

  it("does not redirect a signed-in dancer", () => {
    mockSession = { user: { id: "u1" } };
    mockSegments = ["(tabs)", "wallet"];
    render(<TabsLayout />);
    expect(mockRedirects).toEqual([]);
  });
});

describe("profile button initials", () => {
  it.each([
    ["Riley Moss", null, "RM"],
    ["Jordan Avery Parker", null, "JA"],
    ["mara", null, "M"],
    ["", "dev@example.test", "D"],
    ["dev@example.test", "dev@example.test", "D"],
    ["", null, "D"]
  ])("%p -> %s", (name, email, initials) => {
    expect(initialsFor(name, email)).toBe(initials);
  });
});
