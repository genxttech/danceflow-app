/**
 * Public Event Registration E2E Harness -- Slice 2.
 *
 * Pure, framework-agnostic navigation-origin gate -- the browser-side
 * (Playwright) orchestration lives in e2e/helpers/navigationGuard.ts, which
 * wraps this. Directly modeled on
 * src/lib/payment-harness/browser.ts's `assertAllowedNavigationOrigin`
 * (same split of "pure origin check" vs. "Playwright orchestration", same
 * fail-closed philosophy): any URL that isn't either the configured E2E app
 * origin or the one intentionally-allowed external origin (Stripe Checkout)
 * is refused, not silently followed. A DanceFlow production origin never
 * becomes allowed just because the app happened to redirect there --
 * production is never in the allowed set at all, regardless of how the
 * navigation got there (app-generated absolute URL, redirect, signing
 * resume URL, payment URL, or a popup/new-page navigation -- see the
 * Playwright-side wrapper for the popup case).
 */

import { E2ESafetyError } from "@/lib/e2e/guards";
import type { E2EConfig } from "@/lib/e2e/config";

export type E2ENavigationOrigin = "app" | "stripe_checkout";

// The only hostname Stripe hosted Checkout Sessions are ever served from --
// exact copy of payment-harness's own STRIPE_CHECKOUT_HOSTNAMES.
const STRIPE_CHECKOUT_HOSTNAMES = new Set(["checkout.stripe.com"]);

/**
 * The single navigation-origin gate every E2E browser action goes through.
 * Fails closed on anything other than the configured E2E app origin or the
 * real Stripe Checkout hostname.
 */
export function assertAllowedE2ENavigationOrigin(
  url: string,
  config: E2EConfig,
  context: string,
): E2ENavigationOrigin {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new E2ESafetyError(
      `Fail-closed (${context}): navigated to an unparseable URL ("${url}"). Refusing to proceed.`,
    );
  }

  if (parsed.origin === config.baseUrl) return "app";
  if (STRIPE_CHECKOUT_HOSTNAMES.has(parsed.hostname)) return "stripe_checkout";

  throw new E2ESafetyError(
    `Fail-closed (${context}): navigation left the allowed origin set (the configured E2E ` +
      `base URL, or Stripe Checkout) -- landed on "${parsed.origin}". Refusing to proceed. ` +
      `A DanceFlow production origin is never allowed here, no matter how the navigation got ` +
      `there (redirect, app-generated absolute URL, signing/payment URL, or a popup).`,
  );
}
