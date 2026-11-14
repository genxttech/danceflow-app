jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { isAllowedPostSignInRoute, rememberPostSignInRoute, takePostSignInRoute } from "@/lib/postSignInRoute";

beforeEach(() => AsyncStorage.clear());

describe("post sign-in route", () => {
  it.each(["/(tabs)/discover", "/partners", "/jobs", "/discover/marketplace", "/events/e1/register", "/events/orders/o1"])("returns a guest to %s after sign-in", async (path) => {
    await rememberPostSignInRoute(path, 1_000);
    await expect(takePostSignInRoute(2_000)).resolves.toBe(path);
  });

  it("returns a remembered event page once", async () => {
    await rememberPostSignInRoute("/events/e1", 1_000);
    await expect(takePostSignInRoute(2_000)).resolves.toBe("/events/e1");
    await expect(takePostSignInRoute(3_000)).resolves.toBeNull();
  });

  it("expires after an hour", async () => {
    await rememberPostSignInRoute("/events/e1", 0);
    await expect(takePostSignInRoute(60 * 60 * 1000 + 1)).resolves.toBeNull();
  });

  it.each(["/settings", "/wallet", "/(tabs)/wallet", "/partners/abc", "/discover/marketplace/x", "https://example.test/events/e1", "/events/e1/../../settings", "/events/", "//evil.test", "/events/e1?next=x", "/events/e1/register/x", "/events/orders/o1/x", "/events/e1/register?x=1"])(
    "refuses %p",
    async (path) => {
      expect(isAllowedPostSignInRoute(path)).toBe(false);
      await rememberPostSignInRoute(path, 0);
      await expect(takePostSignInRoute(1)).resolves.toBeNull();
    }
  );

  it("ignores a stored value that was tampered with", async () => {
    await AsyncStorage.setItem("danceflow.postSignInRoute", JSON.stringify({ path: "/settings", at: 0 }));
    await expect(takePostSignInRoute(1)).resolves.toBeNull();
    await AsyncStorage.setItem("danceflow.postSignInRoute", "not json");
    await expect(takePostSignInRoute(1)).resolves.toBeNull();
  });
});
