import { expect, type Page } from "@playwright/test";

/**
 * Public Event Registration E2E Harness -- Slice 1/2.
 *
 * Reusable browser helpers for the public event registration page
 * (src/app/events/[slug]/page.tsx) and its registration form
 * (src/app/events/[slug]/register/RegistrationForm.tsx). Prefers
 * accessible role/label queries over raw CSS selectors where the
 * component's existing markup already supports it (every attendee field
 * has a real `<label htmlFor>`) -- only the ticket-quantity input, which
 * has no accessible label of its own beyond an internal `name` attribute,
 * falls back to a structural selector. No app code was changed to make
 * these more selectable.
 */

export async function gotoPublicEvent(page: Page, eventSlug: string) {
  await page.goto(`/events/${eventSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/**
 * Expands the registration <details> disclosure. Its <summary> text varies
 * by event type/state -- "Open Registration Form" is the default label for
 * a plain (non-group_class, not-sold-out) event, which is what every E2E
 * fixture event produces (event_type: "workshop").
 */
export async function openRegistrationForm(page: Page) {
  const summary = page.getByText("Open Registration Form", { exact: true });
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(page.getByLabel("First Name")).toBeVisible();
}

export async function selectTicketQuantity(page: Page, ticketTypeId: string, quantity: number) {
  const quantityInput = page.locator(`input[name="ticketQuantityDisplay-${ticketTypeId}"]`);
  await expect(quantityInput).toBeVisible();
  await quantityInput.fill(String(quantity));
}

export async function fillAttendeeDetails(
  page: Page,
  attendee: { firstName: string; lastName: string; email: string },
) {
  await page.getByLabel("First Name").fill(attendee.firstName);
  await page.getByLabel("Last Name").fill(attendee.lastName);
  await page.getByLabel("Email").fill(attendee.email);
}

export function checkoutSubmitButton(page: Page) {
  return page.locator('#event-cart-checkout-form button[type="submit"]');
}

/**
 * Clicks the checkout submit button and waits for the resulting navigation
 * to settle -- the destination varies (a required-document signing page, a
 * Stripe-attempt error redirect, or an app error page), so this doesn't
 * assert on where it lands; callers check the resulting URL themselves.
 * No arbitrary sleep: `waitForURL` waiting for the URL to actually change
 * is what genuinely waits for the real POST + redirect chain this form
 * causes -- a `waitForLoadState` call race-started alongside the click can
 * resolve against the page's *current* (pre-navigation) load state instead
 * of the new one, intermittently returning before the redirect lands.
 * Excludes the form's own `/api/...` action path from "arrived": Playwright
 * surfaces that in-flight POST target as a transient `page.url()` value
 * before the server's 303 response is followed, and a predicate that
 * accepts any change at all can catch that intermediate value instead of
 * the real destination.
 */
export async function submitRegistration(page: Page) {
  const submitButton = checkoutSubmitButton(page);
  await expect(submitButton).toBeEnabled();
  const urlBeforeSubmit = page.url();
  await submitButton.click();
  await page.waitForURL((url) => url.href !== urlBeforeSubmit && !url.pathname.startsWith("/api/"), {
    timeout: 15_000,
  });
}
