/**
 * Extracted from page.tsx (a Next.js page module) so it can be a plain,
 * directly-importable/testable function -- Next's generated page-module
 * type checker (.next/dev/types/**, also scanned by `next build`'s own
 * TypeScript pass) only permits a fixed set of named exports from a
 * page.tsx file, and rejects any other export like this one used to be.
 * Colocated next to the page it belongs to, matching this codebase's own
 * convention for page-adjacent non-page helpers (e.g. RegistrationForm.tsx,
 * EventPublicTabs.tsx in this same directory).
 */
export function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "registered") {
    return {
      kind: "success" as const,
      message: "Registration completed successfully.",
    };
  }

  if (search.success === "paid") {
    return {
      kind: "success" as const,
      message: "Payment received. Your registration is confirmed.",
    };
  }

  if (search.success === "waitlisted") {
    return {
      kind: "success" as const,
      message: "You were added to the waitlist. You have not been charged.",
    };
  }

  if (search.error === "checkout_cancelled") {
    return {
      kind: "error" as const,
      message: "Checkout was cancelled. You can retry payment below.",
    };
  }

  if (search.error === "checkout_session_failed") {
    return {
      kind: "error" as const,
      message: "Could not start Stripe Checkout. Please try again.",
    };
  }

  if (search.error === "cart_checkout_failed") {
    return {
      kind: "error" as const,
      message:
        "We weren't able to start your registration and no payment was made. Please try again below.",
    };
  }

  if (search.error === "registration_not_enabled") {
    return {
      kind: "error" as const,
      message: "DanceFlow ticket checkout is not enabled for this basic event listing. Please contact the host for registration details.",
    };
  }

  if (search.error === "organizer_suite_required") {
    return {
      kind: "error" as const,
      message: "DanceFlow ticket checkout is not currently available for this listing. Please contact the host for registration details.",
    };
  }

  return null;
}
