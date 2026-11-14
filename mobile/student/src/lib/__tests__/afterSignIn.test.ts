jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { continueAfterSignIn } from "@/lib/afterSignIn";
import { rememberPostSignInRoute } from "@/lib/postSignInRoute";

const makeRouter = () => ({ replace: jest.fn(), push: jest.fn() });

beforeEach(() => AsyncStorage.clear());

describe("continueAfterSignIn", () => {
  it("lands on Today when nothing was remembered", async () => {
    const router = makeRouter();
    await continueAfterSignIn(router);
    expect(router.replace).toHaveBeenCalledWith("/(tabs)/home");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("puts the event on top of Today so Back is Today, not sign-in", async () => {
    await rememberPostSignInRoute("/events/e1");
    const router = makeRouter();
    await continueAfterSignIn(router);
    expect(router.replace).toHaveBeenCalledWith("/(tabs)/home");
    expect(router.push).toHaveBeenCalledWith("/events/e1");
  });

  it("returns to a registration the dancer was heading for", async () => {
    await rememberPostSignInRoute("/events/e1/register");
    const router = makeRouter();
    await continueAfterSignIn(router);
    expect(router.push).toHaveBeenCalledWith("/events/e1/register");
  });

  it("replaces for a tab destination instead of stacking a second tab bar", async () => {
    await rememberPostSignInRoute("/(tabs)/discover");
    const router = makeRouter();
    await continueAfterSignIn(router);
    expect(router.replace).toHaveBeenCalledWith("/(tabs)/discover");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("only returns once", async () => {
    await rememberPostSignInRoute("/events/e1");
    await continueAfterSignIn(makeRouter());
    const second = makeRouter();
    await continueAfterSignIn(second);
    expect(second.push).not.toHaveBeenCalled();
  });
});
