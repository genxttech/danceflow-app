import { expect, type Page } from "@playwright/test";

/**
 * Public Event Registration E2E Harness -- Slice 1.
 *
 * Reusable browser helpers for the public event registration page
 * (src/app/events/[slug]/page.tsx) and its registration form
 * (src/app/events/[slug]/register/RegistrationForm.tsx). Selectors are
 * taken directly from that component's real field names/ids, not guessed:
 * #attendeeFirstName / #attendeeLastName / #attendeeEmail, and the
 * per-ticket quantity input name={`ticketQuantityDisplay-${ticket.id}`}.
 */

export async function gotoPublicEvent(page: Page, eventSlug: string) {
  await page.goto(`/events/${eventSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/**
 * Expands the registration <details> disclosure. Its <summary> text varies
 * by event type/state -- "Open Registration Form" is the default label for
 * a plain (non-group_class, not-sold-out) event, which is what the Slice 1
 * fixture always produces (event_type: "workshop").
 */
export async function openRegistrationForm(page: Page) {
  const summary = page.getByText("Open Registration Form", { exact: true });
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(page.locator("#attendeeFirstName")).toBeVisible();
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
  await page.locator("#attendeeFirstName").fill(attendee.firstName);
  await page.locator("#attendeeLastName").fill(attendee.lastName);
  await page.locator("#attendeeEmail").fill(attendee.email);
}

export function checkoutSubmitButton(page: Page) {
  return page.locator('#event-cart-checkout-form button[type="submit"]');
}
