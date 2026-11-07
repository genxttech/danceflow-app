// Constants that define WHAT the proof is allowed to be. They are part of the manifest hash, so changing any of them changes the pin the owner approves.

/**
 * The Stripe API version sent as the Stripe-Version header on EVERY request, and required of every response. It is the default API version of the
 * `stripe` SDK this application ships (Stripe.API_VERSION of the installed package), so the proof exercises the response shapes the production client would see.
 * The allow-list refuses any request whose version is missing or different; the guard aborts if a response reports another version.
 */
export const STRIPE_API_VERSION = "2026-03-25.dahlia";

/** Absolute number of Stripe requests a run may send, retries included. Nothing may raise it. */
export const HARD_CALL_CAP = 40;
/** Calls held back so cleanup can always run. */
export const CLEANUP_RESERVE = 8;

/** Display name the owner must give the dedicated sandbox (informational: the name is NEVER trusted as identity; only the pinned ids are). */
export const SANDBOX_NAME = "DanceFlow D24-M3 TEST";
