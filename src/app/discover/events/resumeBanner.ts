/**
 * Public Event Registration E2E Harness -- Slice 3 bugfix.
 *
 * `/api/events/cart/resume-after-signing` (src/app/api/events/cart/resume-after-signing/route.ts)
 * has no event slug in scope when it needs to report a failure -- it only
 * knows a checkpoint/order id -- so its error/success redirects target the
 * slug-less `/events?...` path, which now forwards its query parameters on
 * to `/discover/events` (see ../../events/page.tsx) instead of silently
 * dropping them. This is the other half of that fix: without this,
 * `/discover/events` would still ignore the forwarded parameters and the
 * user would still see no visible context.
 *
 * Deliberately a narrow, separate function from `src/app/events/[slug]/banner.ts`'s
 * `getBanner` rather than a shared one -- that function's codes
 * (`checkout_cancelled`, `cart_checkout_failed`, etc.) are emitted by the
 * event-specific checkout route, which always redirects to `/events/[slug]`
 * directly (it always has a slug in scope) and never through this path.
 * Only resume-after-signing's five codes ever reach `/discover/events`.
 */
export function getResumeBanner(search: { success?: string; error?: string }) {
  if (search.success === "registration_complete") {
    return {
      kind: "success" as const,
      message: "Registration completed successfully.",
    };
  }

  if (search.error === "invalid_signing_resume") {
    return {
      kind: "error" as const,
      message: "This registration link is no longer valid. Please start your registration again.",
    };
  }

  if (search.error === "signing_incomplete") {
    return {
      kind: "error" as const,
      message: "Please complete all required waivers before continuing to payment.",
    };
  }

  if (search.error === "checkout_expired") {
    return {
      kind: "error" as const,
      message: "This registration session has expired. Please start your registration again.",
    };
  }

  if (search.error === "checkout_resume_failed") {
    return {
      kind: "error" as const,
      message: "We weren't able to resume your registration after signing. Please try again.",
    };
  }

  return null;
}
