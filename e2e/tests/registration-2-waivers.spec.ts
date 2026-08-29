import { test, expect } from "@playwright/test";
import { loadE2EConfig } from "@/lib/e2e/config";
import { E2E_ATTENDEE, establishE2EWaiverEventFixtures, resetE2ERegistrationData } from "@/lib/e2e/fixture";
import {
  checkoutSubmitButton,
  fillAttendeeDetails,
  gotoPublicEvent,
  openRegistrationForm,
  selectTicketQuantity,
  submitRegistration,
} from "../helpers/registrationPage";
import { completeCurrentSigningPage, waitForResumeAfterSigningToSettle } from "../helpers/signingPage";
import { assertCurrentUrlAllowed, installE2ENavigationGuard } from "../helpers/navigationGuard";
import { useUniqueE2ESourceIp } from "../helpers/rateLimitBypass";

/**
 * Slice 2, Case C: 2 required waivers.
 *
 * public event page -> submit registration -> waiver 1 -> waiver 2 ->
 * resume -> the app attempts Stripe Checkout initiation.
 *
 * Previously blocked by a real, pre-existing, now-fixed defect (see
 * registration-1-waiver.spec.ts's doc comment and
 * src/app/sign/[token]/__tests__/completeSigningActionContinuation.test.ts):
 * `completeSigningAction` was miscatching Next.js's own internal redirect()
 * signal on every successful continuation, so a two-waiver event used to
 * fail identically at the very first signature -- waiver 2 was never
 * reached. Fixed via `unstable_rethrow(error)`; this test now genuinely
 * proceeds through both waivers.
 *
 * `event_document_requirements` has no defined query ordering in the
 * checkout route (confirmed by reading it directly -- no `.order(...)`
 * clause), so this test does not assume which of the two fixture templates
 * ("E2E Liability Waiver" / "E2E Photo Release") is presented first --
 * only that the two signing steps are for two genuinely different
 * documents (different titles, different /sign/[token] URLs), matching
 * what a real two-waiver event actually requires.
 *
 * See registration-0-waivers.spec.ts's doc comment for why the final step
 * is a real (fixture-expected) Stripe rejection, not a fabricated success.
 */
test.describe("Public event registration -- 2 required waivers", () => {
  test("submits registration, completes both required waivers in sequence, and reaches a real Stripe-initiation attempt on resume", async ({
    page,
    context,
  }) => {
    const config = loadE2EConfig();
    const { twoWaiver } = await establishE2EWaiverEventFixtures(config);
    await resetE2ERegistrationData(config, twoWaiver.eventId);
    await useUniqueE2ESourceIp(page);

    const knownTitles = ["E2E Liability Waiver", "E2E Photo Release"];

    const guard = installE2ENavigationGuard(page, context, config);
    try {
      await gotoPublicEvent(page, twoWaiver.eventSlug);
      assertCurrentUrlAllowed(page, config, "after opening the event page");

      await openRegistrationForm(page);
      await selectTicketQuantity(page, twoWaiver.ticketTypeId, 1);
      await fillAttendeeDetails(page, E2E_ATTENDEE);
      await expect(checkoutSubmitButton(page)).toBeEnabled();

      await submitRegistration(page);
      assertCurrentUrlAllowed(page, config, "after submitting the 2-waiver registration");
      expect(page.url()).toContain("/sign/");

      const firstSigningUrl = page.url();
      const firstHeading = await page.getByRole("heading", { level: 1 }).textContent();
      const firstTitle = knownTitles.find((title) => firstHeading?.includes(title));
      expect(
        firstTitle,
        `first signing page heading ("${firstHeading}") should contain one of the two fixture document titles`,
      ).toBeTruthy();

      await completeCurrentSigningPage(page);
      assertCurrentUrlAllowed(page, config, "after completing the first of two required waivers");

      // Now genuinely on a *different* signing page for the second,
      // distinct required document -- not the swallowed-redirect error
      // bouncing back to the same page.
      expect(page.url()).toContain("/sign/");
      expect(page.url()).not.toBe(firstSigningUrl);
      expect(page.url()).not.toContain("error=");

      const secondHeading = await page.getByRole("heading", { level: 1 }).textContent();
      const secondTitle = knownTitles.find((title) => secondHeading?.includes(title));
      expect(
        secondTitle,
        `second signing page heading ("${secondHeading}") should contain the other fixture document title`,
      ).toBeTruthy();
      expect(secondTitle, "the second waiver must be a genuinely different document than the first").not.toBe(
        firstTitle,
      );

      await completeCurrentSigningPage(page);
      assertCurrentUrlAllowed(page, config, "after completing both required waivers");
      expect(page.url()).toContain("/api/events/cart/resume-after-signing");

      await waitForResumeAfterSigningToSettle(page);
      assertCurrentUrlAllowed(page, config, "after the resume-after-signing route settles");
      guard.assertNoViolations("after the resume-after-signing route settles");

      // The core proof this case exists for: the real, live resume-after-
      // signing route was reached (asserted above) and genuinely attempted
      // the real Stripe call -- proving both waivers were actually
      // completed in sequence, not just the first, and that the
      // redirect-continuation fix works across a full multi-waiver chain.
      //
      // See registration-1-waiver.spec.ts's doc comment for why the exact
      // final landing page is `/discover/events` with no query string --
      // a separate, pre-existing, unrelated redirect quirk in
      // src/app/events/page.tsx, not something this test fixes.
      expect(page.url()).toBe(`${config.baseUrl}/discover/events`);
    } finally {
      guard.dispose();
    }
  });
});
