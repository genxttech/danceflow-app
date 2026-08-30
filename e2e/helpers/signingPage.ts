import { expect, type Page } from "@playwright/test";

/**
 * Public Event Registration E2E Harness -- Slice 2.
 *
 * Reusable browser helpers for the real DanceFlow Sign public signing page
 * (src/app/sign/[token]/page.tsx, src/app/sign/[token]/SigningCanvas.tsx).
 * Drives the real signing UI -- no internal function is called directly to
 * "fake" a signature.
 *
 * Every document created by src/lib/documents/event-signing.ts's
 * createEnvelopeForPosition has exactly three fields, always in this order:
 * printed_name, date, signature (see that module's field-insert call). The
 * printed_name/date text inputs are uncontrolled with a real `defaultValue`
 * (today's date / the signer's name) already filled in by the app itself --
 * they satisfy `required` without the test typing anything. Only the
 * signature field needs interaction: it renders as a plain `<button>`
 * (Playwright-clickable regardless of the PDF preview underneath, since
 * it's a normal same-document DOM element, not something inside the
 * sandboxed iframe) that opens a modal; the modal defaults to "typed" mode
 * with the signer's name already filled in, so clicking "Apply signature"
 * is sufficient.
 */

/** Completes the one signature field on the current /sign/[token] page and
 * submits, without asserting anything about what happens next -- callers
 * check the resulting URL themselves via the navigation guard. */
export async function completeCurrentSigningPage(page: Page) {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const signatureButton = page.getByRole("button", { name: /click to sign/i });
  await expect(signatureButton).toBeVisible();
  await signatureButton.click();

  const applyButton = page.getByRole("button", { name: /apply signature/i });
  await expect(applyButton).toBeVisible();
  await applyButton.click();
  await expect(applyButton).toBeHidden();

  const consentCheckbox = page.getByRole("checkbox", { name: /electronic records and signature/i });
  await expect(consentCheckbox).toBeVisible();
  await consentCheckbox.check();

  const submitButton = page.getByRole("button", { name: "Finish and sign" });
  await expect(submitButton).toBeEnabled();

  // This form's action is a Next.js Server Action, not a plain HTML POST --
  // the redirect() it triggers is applied through Next's own client-side
  // router (an RSC fetch + history update), not necessarily a browser-level
  // navigation `waitForLoadState` would reliably observe. `waitForURL`
  // waiting for the URL to actually change is the robust way to wait for
  // this kind of client-router-driven transition; a bare click() (or a
  // `waitForLoadState` race) can return before the URL update lands,
  // which is exactly what made this look like a race condition earlier.
  const urlBeforeSubmit = page.url();
  await submitButton.click();
  await page.waitForURL((url) => url.href !== urlBeforeSubmit, { timeout: 15_000 });
}

/**
 * After the *final* required waiver, `completeCurrentSigningPage` correctly
 * lands on the real `/api/events/cart/resume-after-signing?...` URL -- that
 * really is the Server Action's own intended redirect destination, not an
 * intermediate hop to filter out (unlike `/api/events/cart/checkout` in
 * registrationPage.ts's `submitRegistration`, which is only ever a
 * transient stop). But `resume-after-signing` is itself a Route Handler
 * that does real async work (a real, if fixture-doomed-to-fail, Stripe API
 * call) before issuing its *own* separate redirect -- a second navigation
 * this helper waits for explicitly, so callers don't have to know that
 * resuming after signing is actually two hops, not one.
 */
export async function waitForResumeAfterSigningToSettle(page: Page) {
  await page.waitForURL((url) => !url.pathname.startsWith("/api/events/cart/resume-after-signing"), {
    timeout: 20_000,
  });
}
