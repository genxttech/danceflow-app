import { test, expect } from "@playwright/test";
import { loadE2EConfig } from "@/lib/e2e/config";
import { E2E_ATTENDEE, establishE2EPublicEventFixture } from "@/lib/e2e/fixture";
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
 */
test.describe("Public event registration -- harness foundation", () => {
  test("opens a controlled public event and reaches an interactable registration form", async ({
    page,
  }) => {
    const config = loadE2EConfig();
    const fixture = await establishE2EPublicEventFixture(config);

    await gotoPublicEvent(page, fixture.eventSlug);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(fixture.eventName);

    await openRegistrationForm(page);
    await selectTicketQuantity(page, fixture.ticketTypeId, 1);
    await fillAttendeeDetails(page, E2E_ATTENDEE);

    await expect(checkoutSubmitButton(page)).toBeEnabled();
    await expect(checkoutSubmitButton(page)).toHaveText("Continue to Secure Checkout");
  });
});
