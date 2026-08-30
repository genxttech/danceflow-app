import { test, expect } from "@playwright/test";
import { loadE2EConfig } from "@/lib/e2e/config";
import {
  E2E_ATTENDEE,
  adminClient,
  establishE2EDocumentSetupFailureFixture,
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
 * Slice 3, Case A: document/signing setup failure.
 *
 * The fixture's one required document template has a deliberately
 * oversized body (see establishE2EDocumentSetupFailureFixture's own doc
 * comment for why this, specifically, is the only deterministic,
 * production-code-unweakened, parallel-safe trigger available) -- large
 * enough that the real, unmodified renderTemplateVersionPdf produces a PDF
 * exceeding the real, unmodified document-files bucket's 15MB
 * file_size_limit. The real, unmodified createEnvelopeForPosition's
 * `if (uploadError) throw ...` then fires for real, which the real,
 * unmodified checkout route's own catch block turns into: cancel the
 * held slot/registration/order, and redirect to the event page with
 * `?error=cart_checkout_failed` -- the same banner every other checkout
 * failure uses (see getBanner.test.ts's cart_checkout_failed case).
 *
 * This is genuinely slow (a ~20MB+ PDF has to render and upload inside the
 * real request) -- both this test and submitRegistration's own wait use a
 * generously raised timeout for exactly that reason, not because anything
 * is flaky.
 */
test.describe("Public event registration -- document/signing setup failure", () => {
  test.setTimeout(180_000);

  test("registration attempt fails visibly (not a blank form) and leaves consistent cancelled state; retry creates an independent, equally-honest failure", async ({
    page,
    context,
  }) => {
    const config = loadE2EConfig();
    const fixture = await establishE2EDocumentSetupFailureFixture(config);
    await resetE2ERegistrationData(config, fixture.eventId);
    await useUniqueE2ESourceIp(page);
    const admin = adminClient(config);

    const guard = installE2ENavigationGuard(page, context, config);
    try {
      await gotoPublicEvent(page, fixture.eventSlug);
      assertCurrentUrlAllowed(page, config, "after opening the event page");

      await openRegistrationForm(page);
      await selectTicketQuantity(page, fixture.ticketTypeId, 1);
      await fillAttendeeDetails(page, E2E_ATTENDEE);
      await expect(checkoutSubmitButton(page)).toBeEnabled();

      await submitRegistration(page, 120_000);
      assertCurrentUrlAllowed(page, config, "after the document-setup failure redirect");
      guard.assertNoViolations("after the document-setup failure redirect");

      // Not a blank form, not a generic app crash page: the real event page,
      // with the real, existing checkout-failure banner visibly shown.
      expect(page.url()).toContain(`/events/${fixture.eventSlug}`);
      expect(page.url()).toContain("error=cart_checkout_failed");
      await expect(page.getByText(/couldn't|weren't able|could not/i).first()).toBeVisible();

      // Order/registration/checkpoint state matches the app's own documented
      // failure handling exactly -- not merely "some error happened".
      const { data: orders } = await admin
        .from("event_orders")
        .select("id,status,payment_status,metadata")
        .eq("event_id", fixture.eventId)
        .order("created_at", { ascending: false })
        .limit(1);
      const order = orders?.[0];
      expect(order?.status).toBe("cancelled");
      expect(order?.payment_status).toBe("failed");
      expect((order?.metadata as Record<string, unknown> | null)?.failure_reason).toBe(
        "document_setup_failed",
      );

      const { data: registrations } = await admin
        .from("event_registrations")
        .select("status")
        .eq("order_id", order?.id as string);
      for (const registration of registrations ?? []) {
        expect(registration.status).toBe("cancelled");
      }

      const { data: checkpoints } = await admin
        .from("event_signing_checkpoints")
        .select("status")
        .eq("order_id", order?.id as string);
      for (const checkpoint of checkpoints ?? []) {
        expect(checkpoint.status).toBe("cancelled");
      }

      // No envelope should have been left in a non-terminal state -- the
      // oversized upload failed before the envelope insert was ever reached.
      const { data: envelopes } = await admin
        .from("document_sign_envelopes")
        .select("id")
        .eq("event_order_id", order?.id as string);
      expect(envelopes ?? []).toHaveLength(0);

      // Retry (Case E): submitting again must not get stuck on the prior
      // failed attempt's leftovers -- it creates its own independent order
      // and fails the same honest way, not silently or by reusing stale state.
      await gotoPublicEvent(page, fixture.eventSlug);
      await openRegistrationForm(page);
      await selectTicketQuantity(page, fixture.ticketTypeId, 1);
      await fillAttendeeDetails(page, E2E_ATTENDEE);
      await submitRegistration(page, 120_000);
      assertCurrentUrlAllowed(page, config, "after the retried document-setup failure redirect");
      guard.assertNoViolations("after the retried document-setup failure redirect");

      expect(page.url()).toContain("error=cart_checkout_failed");

      const { data: ordersAfterRetry } = await admin
        .from("event_orders")
        .select("id,status")
        .eq("event_id", fixture.eventId)
        .order("created_at", { ascending: false })
        .limit(2);
      expect(ordersAfterRetry ?? []).toHaveLength(2);
      expect(ordersAfterRetry?.[0]?.id).not.toBe(order?.id);
      for (const retryOrder of ordersAfterRetry ?? []) {
        expect(retryOrder.status).toBe("cancelled");
      }
    } finally {
      guard.dispose();
    }
  });
});
