import { describe, expect, it } from "vitest";
import { E2ESafetyError } from "@/lib/e2e/guards";
import { assertAllowedE2ENavigationOrigin } from "@/lib/e2e/navigationGuard";
import type { E2EConfig } from "@/lib/e2e/config";

const config: E2EConfig = Object.freeze({
  baseUrl: "http://localhost:3000",
  supabaseUrl: "http://127.0.0.1:54321",
  supabaseServiceRoleKey: "irrelevant-for-this-test",
});

describe("assertAllowedE2ENavigationOrigin", () => {
  it("allows the configured app origin", () => {
    expect(() =>
      assertAllowedE2ENavigationOrigin("http://localhost:3000/events/foo", config, "ctx"),
    ).not.toThrow();
    expect(assertAllowedE2ENavigationOrigin("http://localhost:3000/events/foo", config, "ctx")).toBe(
      "app",
    );
  });

  it("allows the real Stripe Checkout hostname", () => {
    expect(() =>
      assertAllowedE2ENavigationOrigin(
        "https://checkout.stripe.com/c/pay/cs_test_abc123",
        config,
        "ctx",
      ),
    ).not.toThrow();
    expect(
      assertAllowedE2ENavigationOrigin(
        "https://checkout.stripe.com/c/pay/cs_test_abc123",
        config,
        "ctx",
      ),
    ).toBe("stripe_checkout");
  });

  it("rejects the real DanceFlow production domain even though it's a real app-shaped URL", () => {
    expect(() =>
      assertAllowedE2ENavigationOrigin("https://idanceflow.com/events/foo", config, "ctx"),
    ).toThrow(E2ESafetyError);
  });

  it("rejects a production-shaped Vercel deployment host", () => {
    expect(() =>
      assertAllowedE2ENavigationOrigin(
        "https://danceflow-app-qfem-nmulhlxcm-dance-flow.vercel.app",
        config,
        "ctx",
      ),
    ).toThrow(E2ESafetyError);
  });

  it("rejects a lookalike Stripe hostname (not the real checkout.stripe.com)", () => {
    expect(() =>
      assertAllowedE2ENavigationOrigin("https://checkout.stripe.com.evil.example/", config, "ctx"),
    ).toThrow(E2ESafetyError);
  });

  it("rejects a different, unrelated external host", () => {
    expect(() =>
      assertAllowedE2ENavigationOrigin("https://example.com/", config, "ctx"),
    ).toThrow(E2ESafetyError);
  });

  it("rejects the app origin at a different port than configured", () => {
    expect(() =>
      assertAllowedE2ENavigationOrigin("http://localhost:4000/events/foo", config, "ctx"),
    ).toThrow(E2ESafetyError);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertAllowedE2ENavigationOrigin("not-a-url", config, "ctx")).toThrow(
      E2ESafetyError,
    );
  });

  it("error message includes the context label for debuggability", () => {
    expect(() =>
      assertAllowedE2ENavigationOrigin("https://idanceflow.com", config, "after-form-submit"),
    ).toThrow(/after-form-submit/);
  });
});
