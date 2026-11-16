jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("@/lib/supabase", () => ({ supabase: {} }));

import { assertSafeEventCheckoutUrl } from "@/lib/eventCheckout";

// The server hands the app a URL to open (checkout, signing). Only https may be followed: a hostile or
// corrupted response must never make the app open javascript:, data:, intent: or plain-http links.
describe("assertSafeEventCheckoutUrl", () => {
  it("accepts https and returns a normalized URL, ignoring surrounding whitespace", () => {
    expect(assertSafeEventCheckoutUrl("  https://checkout.stripe.com/c/pay/cs_test_1  ")).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
  });

  it.each([
    "http://checkout.example.test/pay",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "intent://scan/#Intent;scheme=zxing;end",
    "file:///etc/passwd",
    "ftp://example.test/x",
    "danceflow://wallet",
  ])("blocks %s", (url) => {
    expect(() => assertSafeEventCheckoutUrl(url)).toThrow("The secure checkout link was blocked.");
  });

  it("rejects text that is not a URL", () => {
    expect(() => assertSafeEventCheckoutUrl("not a url")).toThrow("The secure checkout link was invalid.");
    expect(() => assertSafeEventCheckoutUrl("")).toThrow("The secure checkout link was invalid.");
  });

  it("allows the app's own scheme only when the caller opts in", () => {
    expect(assertSafeEventCheckoutUrl(" danceflow://wallet?checkout=event ", { allowDanceFlowScheme: true })).toBe("danceflow://wallet?checkout=event");
    expect(assertSafeEventCheckoutUrl("DANCEFLOW://wallet", { allowDanceFlowScheme: true })).toBe("DANCEFLOW://wallet");
    expect(() => assertSafeEventCheckoutUrl("danceflow://wallet")).toThrow();
  });

  it("does not let the opt-in widen anything else", () => {
    expect(() => assertSafeEventCheckoutUrl("javascript:alert(1)", { allowDanceFlowScheme: true })).toThrow();
    expect(() => assertSafeEventCheckoutUrl("http://x.test", { allowDanceFlowScheme: true })).toThrow();
  });
});
