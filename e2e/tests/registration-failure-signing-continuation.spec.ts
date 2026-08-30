import { test, expect } from "@playwright/test";
import { loadE2EConfig } from "@/lib/e2e/config";
import {
  E2E_ATTENDEE,
  adminClient,
  establishE2EContinuationFailureEventFixture,
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
import { completeCurrentSigningPage } from "../helpers/signingPage";
import { assertCurrentUrlAllowed, installE2ENavigationGuard } from "../helpers/navigationGuard";
import { useUniqueE2ESourceIp } from "../helpers/rateLimitBypass";

/**
 * Slice 3, Case B: signing continuation application failure.
 *
 * Reproduces the exact class of defect the Public Event Registration
 * signing-continuation hotfix (PR #24, unstable_rethrow) fixed -- but
 * proves the *other* side of it: a genuine (non-NEXT_REDIRECT) failure
 * from advanceEventSigningCheckpoint must still be caught and surfaced,
 * not swallowed. Triggered deterministically by advancing the real
 * checkpoint's own `expires_at` into the past, via the admin client,
 * between reaching the signing page and completing the signature --
 * exactly what a real 30-minute-old checkout looks like, just sped up.
 * No production code is touched or weakened; this only writes to
 * already-real, already-mutable row state the app itself owns and
 * updates via the identical mechanism (event_signing_checkpoints.expires_at)
 * once the real 30 minutes elapse.
 */
test.describe("Public event registration -- signing continuation application failure", () => {
  test("a genuine continuation failure is surfaced visibly, and the already-captured signature is not duplicated on retry", async ({
    page,
    context,
  }) => {
    const config = loadE2EConfig();
    const oneWaiver = await establishE2EContinuationFailureEventFixture(config);
    await resetE2ERegistrationData(config, oneWaiver.eventId);
    await useUniqueE2ESourceIp(page);
    const admin = adminClient(config);

    const guard = installE2ENavigationGuard(page, context, config);
    try {
      await gotoPublicEvent(page, oneWaiver.eventSlug);
      await openRegistrationForm(page);
      await selectTicketQuantity(page, oneWaiver.ticketTypeId, 1);
      await fillAttendeeDetails(page, E2E_ATTENDEE);
      await expect(checkoutSubmitButton(page)).toBeEnabled();

      await submitRegistration(page);
      assertCurrentUrlAllowed(page, config, "after submitting the registration");
      expect(page.url()).toContain("/sign/");

      // resetE2ERegistrationData guarantees exactly one checkpoint exists
      // for this event at this point.
      const { data: checkpoint } = await admin
        .from("event_signing_checkpoints")
        .select("id,status")
        .eq("event_id", oneWaiver.eventId)
        .single();
      expect(checkpoint?.status).toBe("signing");

      // Deterministically reproduce "checkout expired before signing was
      // completed" -- the real, unmodified advanceEventSigningCheckpoint's
      // own genuine failure path (a plain Error, not a NEXT_REDIRECT digest).
      await admin
        .from("event_signing_checkpoints")
        .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", checkpoint?.id as string);

      await completeCurrentSigningPage(page);
      assertCurrentUrlAllowed(page, config, "after the continuation failure redirect");
      guard.assertNoViolations("after the continuation failure redirect");

      // Genuinely surfaced, not a blank page and not silently swallowed.
      expect(page.url()).toContain("error=event_checkout_continuation_failed");
      await expect(
        page.getByText(/could not be completed|problem continues/i).first(),
      ).toBeVisible();

      // The signature itself genuinely completed (envelope completion runs
      // before the continuation call) -- it must not be lost just because
      // the *next* step failed.
      const { data: envelopes } = await admin
        .from("document_sign_envelopes")
        .select("id,status")
        .eq("event_signing_checkpoint_id", checkpoint?.id as string);
      expect(envelopes ?? []).toHaveLength(1);
      expect(envelopes?.[0]?.status).toBe("completed");
      const envelopeId = envelopes?.[0]?.id as string;

      const { data: completedEvents } = await admin
        .from("document_sign_events")
        .select("id")
        .eq("envelope_id", envelopeId)
        .eq("event_type", "completed");
      expect(completedEvents ?? []).toHaveLength(1);

      const { data: checkpointAfter } = await admin
        .from("event_signing_checkpoints")
        .select("status")
        .eq("id", checkpoint?.id as string)
        .single();
      expect(checkpointAfter?.status).toBe("expired");

      // Retry (Case E): revisiting the same signing link (bare, without the
      // error query string that's now part of the current URL -- reloading
      // *that* would just redisplay the same banner unconditionally, since
      // the page renders it directly off `query.error`) must not re-process
      // or duplicate the already-completed signature. The page's own
      // existing `completed = envelope.status === "completed" || ...`
      // check (src/app/sign/[token]/page.tsx) renders a "Document
      // completed" view instead of the signing form -- there is no
      // resubmittable form left to retry at all once this is true.
      const bareSigningUrl = new URL(page.url());
      bareSigningUrl.search = "";
      await page.goto(bareSigningUrl.toString());
      assertCurrentUrlAllowed(page, config, "after revisiting the bare signing link");
      await expect(page.getByText("Document completed")).toBeVisible();
      await expect(page.getByRole("button", { name: /click to sign/i })).toHaveCount(0);

      const { data: envelopesAfterRetry } = await admin
        .from("document_sign_envelopes")
        .select("id")
        .eq("event_signing_checkpoint_id", checkpoint?.id as string);
      expect(envelopesAfterRetry ?? []).toHaveLength(1);

      const { data: completedEventsAfterRetry } = await admin
        .from("document_sign_events")
        .select("id")
        .eq("envelope_id", envelopeId)
        .eq("event_type", "completed");
      expect(completedEventsAfterRetry ?? []).toHaveLength(1);
    } finally {
      guard.dispose();
    }
  });
});
