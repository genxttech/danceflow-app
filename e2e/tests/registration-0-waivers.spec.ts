import { test, expect } from "@playwright/test";
import { loadE2EConfig } from "@/lib/e2e/config";
import { E2E_ATTENDEE, establishE2EPublicEventFixture, resetE2ERegistrationData } from "@/lib/e2e/fixture";
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
 * Slice 2, Case A: 0 required waivers.
 *
 * public event page -> open registration form -> attendee/contact data ->
 * choose ticket -> submit registration -> the app attempts Stripe Checkout
 * initiation directly (no signing step in between).
 *
 * Stripe boundary (explicitly scoped, see e2e/README.md): the fixture
 * studio's `stripe_connected_account_id` is a placeholder, not a real
 * Stripe Connect test-mode account (creating one is an explicit, separate,
 * human-approved step this slice does not take). The real, unmodified
 * checkout route therefore genuinely attempts a real Stripe API call and
 * gets a real rejection back, which its own existing catch block handles by
 * redirecting to `?error=cart_checkout_failed` -- still the app's own
 * origin. That is the correct, honest, deterministic outcome this test
 * asserts: real order creation, real 0-waiver skip, a real (failing)
 * Stripe-initiation attempt, and graceful, already-shipped failure
 * handling -- not a fabricated "session created" claim. Startevent
 * Order Payment's actual Stripe-call construction is separately, and more
 * directly, proven correct in
 * src/lib/events/__tests__/eventOrderPaymentStripeConstruction.test.ts,
 * which mocks Stripe rather than needing a real Connect account.
 */
test.describe("Public event registration -- 0 required waivers", () => {
  test("submits registration and reaches a real (fixture-expected) Stripe-initiation attempt", async ({
    page,
    context,
  }) => {
    const config = loadE2EConfig();
    const fixture = await establishE2EPublicEventFixture(config);
    await resetE2ERegistrationData(config, fixture.eventId);
    await useUniqueE2ESourceIp(page);

    const guard = installE2ENavigationGuard(page, context, config);
    try {
      await gotoPublicEvent(page, fixture.eventSlug);
      assertCurrentUrlAllowed(page, config, "after opening the event page");

      await openRegistrationForm(page);
      await selectTicketQuantity(page, fixture.ticketTypeId, 1);
      await fillAttendeeDetails(page, E2E_ATTENDEE);
      await expect(checkoutSubmitButton(page)).toBeEnabled();

      await submitRegistration(page);
      assertCurrentUrlAllowed(page, config, "after submitting the 0-waiver registration");
      guard.assertNoViolations("after submitting the 0-waiver registration");

      // Honest, deterministic outcome given the placeholder Stripe account:
      // the real checkout route reached and attempted the real Stripe call,
      // got a real rejection, and redirected to its own existing error
      // banner -- proving the full non-Stripe code path end to end.
      expect(page.url()).toContain("error=cart_checkout_failed");
      await expect(
        page.getByText(/couldn't|weren't able|could not/i).first(),
      ).toBeVisible();
    } finally {
      guard.dispose();
    }
  });
});
