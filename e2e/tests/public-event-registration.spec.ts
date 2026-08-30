import { test, expect } from "@playwright/test";
import { loadE2EConfig } from "@/lib/e2e/config";
import { E2E_ATTENDEE, establishE2EFoundationEventFixture } from "@/lib/e2e/fixture";
import {
  checkoutSubmitButton,
  fillAttendeeDetails,
  gotoPublicEvent,
  openRegistrationForm,
  selectTicketQuantity,
} from "../helpers/registrationPage";

/**
 * Slice 1: harness-foundation happy path.
 *
 * Proves the harness can seed a controlled, self-contained public event
 * (studio + event + one ticket type, zero required documents -- the
 * "0 required waivers" case) and reach an interactable registration form.
 * Deliberately stops short of submitting: a real submission either needs a
 * genuinely Stripe-Connect-onboarded test account (0-waiver case) or a real
 * DanceFlow Sign document template (1/2-waiver case), both explicitly
 * deferred to a later slice per this slice's acceptance criteria.
 *
 * Uses its own dedicated event fixture (Slice 3), not Case A's
 * (registration-0-waivers.spec.ts) -- this test never submits, so sharing
 * an event with Case A was safe in practice, but only as long as that stays
 * true. A dedicated event removes that fragile, easy-to-break-by-accident
 * invariant entirely (see the Slice 2 review's non-blocking recommendation).
 */
test.describe("Public event registration -- harness foundation", () => {
  test("opens a controlled public event and reaches an interactable registration form", async ({
    page,
  }) => {
    const config = loadE2EConfig();
    const fixture = await establishE2EFoundationEventFixture(config);

    await gotoPublicEvent(page, fixture.eventSlug);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(fixture.eventName);

    await openRegistrationForm(page);
    await selectTicketQuantity(page, fixture.ticketTypeId, 1);
    await fillAttendeeDetails(page, E2E_ATTENDEE);

    await expect(checkoutSubmitButton(page)).toBeEnabled();
    await expect(checkoutSubmitButton(page)).toHaveText("Continue to Secure Checkout");
  });
});
