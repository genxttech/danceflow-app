import { test, expect } from "@playwright/test";
import { loadE2EConfig } from "@/lib/e2e/config";
import {
  E2E_ATTENDEE,
  adminClient,
  establishE2ECancellationEventFixture,
  resetE2ERegistrationData,
} from "@/lib/e2e/fixture";
import {
  checkoutSubmitButton,
  fillAttendeeDetails,
  gotoPublicEvent,
  openRegistrationForm,
  selectTicketQuantity,
  submitRegistration,
} from "../helpers/registrationPage";
import { assertCurrentUrlAllowed, installE2ENavigationGuard } from "../helpers/navigationGuard";
import { useUniqueE2ESourceIp } from "../helpers/rateLimitBypass";

/**
 * Slice 3, Case D: genuine user cancellation, kept semantically distinct
 * from a technical failure.
 *
 * Real hosted Stripe Checkout is never reached in this harness (no
 * approved test-mode Connect account -- see e2e/README.md's "Stripe
 * boundary"), so a literal "user clicks Cancel on Stripe's own page" can't
 * be driven through the browser here, same as it can't for any other case
 * in this suite. What *is* real and directly testable is the destination
 * Stripe would have sent that cancellation to:
 * `/api/events/cart/release` (src/app/api/events/cart/release/route.ts),
 * with the exact orderId/eventSlug/holdToken query shape the real checkout
 * route already builds into `cancel_url` for every real Stripe session it
 * creates. This test captures that real holdToken from a real order this
 * fixture's own registration creates, then drives the browser to that same
 * URL directly -- proving the *route itself* redirects to a genuinely
 * different outcome (`checkout_cancelled`) than a technical failure
 * (`cart_checkout_failed`), not asserting both under one umbrella check.
 *
 * The order this test captures a holdToken from will already be
 * `cancelled`/`failed` by the time this runs (the fixture's fake Stripe
 * account makes checkout fail immediately, before any real cancel could
 * happen) -- release's own cancellation logic is idempotent on an
 * already-cancelled order (`.neq("payment_status", "paid")`), so this still
 * exercises its real code path and real redirect, just not literally
 * "before" the technical failure that necessarily preceded it here.
 */
test.describe("Public event registration -- genuine user cancellation", () => {
  test("the release route's own cancellation outcome is semantically distinct from a technical checkout failure", async ({
    page,
    context,
  }) => {
    const config = loadE2EConfig();
    const fixture = await establishE2ECancellationEventFixture(config);
    await resetE2ERegistrationData(config, fixture.eventId);
    await useUniqueE2ESourceIp(page);
    const admin = adminClient(config);

    const guard = installE2ENavigationGuard(page, context, config);
    try {
      await gotoPublicEvent(page, fixture.eventSlug);
      await openRegistrationForm(page);
      await selectTicketQuantity(page, fixture.ticketTypeId, 1);
      await fillAttendeeDetails(page, E2E_ATTENDEE);
      await expect(checkoutSubmitButton(page)).toBeEnabled();

      await submitRegistration(page);
      assertCurrentUrlAllowed(page, config, "after the initial (fixture-expected) checkout failure");
      expect(page.url()).toContain("error=cart_checkout_failed");

      const { data: orders } = await admin
        .from("event_orders")
        .select("id,metadata")
        .eq("event_id", fixture.eventId)
        .limit(1);
      const order = orders?.[0];
      const holdToken = (order?.metadata as Record<string, unknown> | null)?.holdToken as
        | string
        | undefined;
      expect(order?.id).toBeTruthy();
      expect(holdToken).toBeTruthy();

      const releaseUrl = new URL("/api/events/cart/release", config.baseUrl);
      releaseUrl.searchParams.set("orderId", order?.id as string);
      releaseUrl.searchParams.set("eventSlug", fixture.eventSlug);
      releaseUrl.searchParams.set("holdToken", holdToken as string);

      await page.goto(releaseUrl.toString());
      assertCurrentUrlAllowed(page, config, "after driving the browser to the release route directly");
      guard.assertNoViolations("after driving the browser to the release route directly");

      // The core proof this case exists for: a genuinely different error
      // code and a genuinely different banner message than the technical
      // failure this same test already saw above -- not the same assertion
      // reused for both outcomes.
      expect(page.url()).toContain("error=checkout_cancelled");
      expect(page.url()).not.toContain("error=cart_checkout_failed");
      await expect(page.getByText(/cancelled/i).first()).toBeVisible();
      await expect(page.getByText(/couldn't|weren't able|could not/i)).toHaveCount(0);
    } finally {
      guard.dispose();
    }
  });
});
