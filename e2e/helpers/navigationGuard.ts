import type { BrowserContext, Page } from "@playwright/test";
import { assertAllowedE2ENavigationOrigin } from "@/lib/e2e/navigationGuard";
import { E2ESafetyError } from "@/lib/e2e/guards";
import type { E2EConfig } from "@/lib/e2e/config";

/**
 * Public Event Registration E2E Harness -- Slice 2.
 *
 * Two layers of protection, both required, matching
 * src/lib/payment-harness/browser.ts's proven pattern of explicit
 * post-action checks -- extended here with an always-on listener backstop,
 * since this harness's flow (registration -> signing -> resume -> Stripe)
 * has more intermediate redirect hops than the payment harness's simpler
 * flow, and a step this module's author forgets to explicitly check should
 * still be caught:
 *
 * 1. `installE2ENavigationGuard(page, context, config)` attaches listeners
 *    for every top-level navigation AND every new page/popup for the
 *    lifetime of the test. Violations are recorded, not thrown from inside
 *    the listener (throwing inside an async Playwright event handler is not
 *    reliably surfaced as a test failure) -- call `assertNoViolations()` at
 *    checkpoints (and always at the end of a test) to fail closed on
 *    anything recorded.
 * 2. `assertCurrentUrlAllowed(page, config, context)` is the same explicit,
 *    synchronous, post-action check style payment-harness uses -- call it
 *    right after any action that causes a same-tab navigation (form
 *    submit, link click) for a precise, immediately-actionable error
 *    message at the exact step that violated the guard.
 *
 * A production DanceFlow origin can never become "allowed" through either
 * path -- both ultimately call the same
 * src/lib/e2e/navigationGuard.ts:assertAllowedE2ENavigationOrigin, whose
 * allowed set is exactly {configured E2E app origin, checkout.stripe.com}
 * and nothing else, regardless of how the navigation happened.
 */

export type E2ENavigationGuard = {
  /** Throws E2ESafetyError if any navigation (main-frame or popup) recorded
   * since the guard was installed (or since the last call to this) left
   * the allowed origin set. Always call at least once before the test ends. */
  assertNoViolations: (context: string) => void;
  /** Stops listening. Call in a finally/afterEach so a failed test doesn't
   * leave listeners attached to a page Playwright is about to tear down. */
  dispose: () => void;
};

export function installE2ENavigationGuard(
  page: Page,
  context: BrowserContext,
  config: E2EConfig,
): E2ENavigationGuard {
  const violations: string[] = [];

  const onFrameNavigated = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame !== page.mainFrame()) return;
    try {
      assertAllowedE2ENavigationOrigin(frame.url(), config, "main-frame navigation");
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
    }
  };

  const onNewPage = async (popup: Page) => {
    try {
      await popup.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      assertAllowedE2ENavigationOrigin(popup.url(), config, "popup/new-page navigation");
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
      await popup.close().catch(() => {});
    }
  };

  page.on("framenavigated", onFrameNavigated);
  context.on("page", onNewPage);

  function assertNoViolations(assertContext: string) {
    if (violations.length === 0) return;
    const message = violations.splice(0, violations.length).join("\n");
    throw new E2ESafetyError(
      `Fail-closed (${assertContext}): navigation guard recorded ${message ? "violation(s)" : ""}:\n${message}`,
    );
  }

  function dispose() {
    page.off("framenavigated", onFrameNavigated);
    context.off("page", onNewPage);
  }

  return { assertNoViolations, dispose };
}

/**
 * Explicit, synchronous check of the page's current URL -- call right
 * after any action expected to cause a same-tab navigation, for a precise
 * error tied to that exact step.
 */
export function assertCurrentUrlAllowed(page: Page, config: E2EConfig, context: string) {
  assertAllowedE2ENavigationOrigin(page.url(), config, context);
}
