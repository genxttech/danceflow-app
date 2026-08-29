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
 * Slice 2, Case B: 1 required waiver.
 *
 * public event page -> submit registration -> redirect to the real
 * DanceFlow Sign signing page -> complete the one required waiver through
 * the real UI -> resume -> the app attempts Stripe Checkout initiation.
 *
 * Previously blocked by a real, pre-existing, now-fixed defect: `redirect()`
 * throws Next.js's own internal NEXT_REDIRECT control-flow signal on
 * success, and `completeSigningAction`'s catch block around
 * `advanceEventSigningCheckpoint()` was catching that signal unconditionally
 * and converting every successful continuation into
 * `?error=event_checkout_continuation_failed`. Fixed in
 * src/app/sign/[token]/actions.ts via `unstable_rethrow(error)` as the
 * first line of that catch (see
 * src/app/sign/[token]/__tests__/completeSigningActionContinuation.test.ts
 * for the focused regression coverage). This test now genuinely reaches
 * the resume step.
 *
 * See registration-0-waivers.spec.ts's doc comment for why the final step
 * is a real (fixture-expected) Stripe rejection, not a fabricated success --
 * same reasoning applies here, after the resume-after-signing route (not
 * the checkout route) makes the real Stripe attempt.
 */
test.describe("Public event registration -- 1 required waiver", () => {
  test("submits registration, completes the required waiver, and reaches a real Stripe-initiation attempt on resume", async ({
    page,
    context,
  }) => {
    const config = loadE2EConfig();
    const { oneWaiver } = await establishE2EWaiverEventFixtures(config);
    await resetE2ERegistrationData(config, oneWaiver.eventId);
    await useUniqueE2ESourceIp(page);

    const guard = installE2ENavigationGuard(page, context, config);
    try {
      await gotoPublicEvent(page, oneWaiver.eventSlug);
      assertCurrentUrlAllowed(page, config, "after opening the event page");

      await openRegistrationForm(page);
      await selectTicketQuantity(page, oneWaiver.ticketTypeId, 1);
      await fillAttendeeDetails(page, E2E_ATTENDEE);
      await expect(checkoutSubmitButton(page)).toBeEnabled();

      await submitRegistration(page);
      assertCurrentUrlAllowed(page, config, "after submitting the 1-waiver registration");
      expect(page.url()).toContain("/sign/");

      // Proves the real, live signing checkpoint/envelope chain was
      // created for this exact registration -- the document title comes
      // from the real document_templates row the fixture upserted, not a
      // hardcoded string in this test.
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "E2E Liability Waiver",
      );

      await completeCurrentSigningPage(page);
      assertCurrentUrlAllowed(page, config, "after completing the one required waiver");
      expect(page.url()).toContain("/api/events/cart/resume-after-signing");

      await waitForResumeAfterSigningToSettle(page);
      assertCurrentUrlAllowed(page, config, "after the resume-after-signing route settles");
      guard.assertNoViolations("after the resume-after-signing route settles");

      // The core proof this case exists for: the real, live resume-after-
      // signing route was reached (asserted above) and genuinely attempted
      // the real Stripe call with the fixture's placeholder Connect account,
      // which fails and lands here -- proving the redirect-continuation fix
      // actually works end to end, not just that the app didn't crash.
      //
      // The exact final landing page is a *separate*, pre-existing,
      // unrelated quirk this test does not fix: resume-after-signing's own
      // error redirect targets `/events?error=checkout_resume_failed`, but
      // `src/app/events/page.tsx` unconditionally redirects `/events` to
      // `/discover/events`, silently dropping the query string (and thus
      // the error banner) along the way. Asserting the real, current,
      // observed destination rather than the query param that never
      // survives it.
      expect(page.url()).toBe(`${config.baseUrl}/discover/events`);
    } finally {
      guard.dispose();
    }
  });
});
