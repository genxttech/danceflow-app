/*
  At system font scale 2.0 the sign-in content is taller than the window. The screen used to be a
  fixed, non-scrolling view, so the lower half (email field, Send secure link, legal links) was
  clipped and unreachable. It must scroll, and its content must be able to grow past the window.
*/
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ continueWithEmail: jest.fn() }) }));
jest.mock("@/components/LegalLinks", () => ({ LegalLinks: () => null }));
jest.mock("expo-linear-gradient", () => ({
  LinearGradient: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import { readFileSync } from "fs";
import { join } from "path";
import { render, screen } from "@testing-library/react-native";
import { ScrollView } from "react-native";
import SignInScreen from "../../../app/(auth)/sign-in";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

describe("sign-in at large text", () => {
  it("renders inside a ScrollView so every control can be reached", () => {
    const { UNSAFE_getByType } = render(<SignInScreen />);
    expect(UNSAFE_getByType(ScrollView)).toBeTruthy();
    expect(screen.getByText("Send secure link")).toBeTruthy();
  });

  it.each(["app/(auth)/sign-in.tsx", "app/(auth)/reset-password.tsx", "app/auth/secure-account.tsx"])(
    "%s lets its content grow instead of pinning it to the window",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "..", "..", file), "utf8");
      expect(source).not.toContain("scroll={false}");
      expect(source).not.toMatch(/wrap: \{\s*flex: 1/);
    },
  );
});
