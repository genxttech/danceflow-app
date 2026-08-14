import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";
import { resolvePaymentHarnessEnvironment } from "@/lib/payment-harness/deployment";
import type { PaymentHarnessConfig } from "@/lib/payment-harness/types";

/**
 * Same UUID validation shape already used elsewhere in this codebase
 * (e.g. src/app/api/stripe/client-checkout/route.ts's UUID_PATTERN) --
 * reused here as a pattern, not imported, to keep this module's only
 * dependencies within src/lib/payment-harness/.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Same pragmatic shape check already used for other operator-typed inputs in
// this codebase (e.g. the login form's own HTML5 email input) -- this is
// not attempting full RFC 5322 validation, only "obviously not an email"
// rejection.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Fail-closed configuration loading for the Payment Harness.
 *
 * Reads only `PAYMENT_HARNESS_*` environment variables. Deliberately never
 * falls back to the application's own runtime configuration
 * (`STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, etc.) or to the
 * Production Synthetic Harness's `SYNTHETIC_*` variables -- even when one
 * of those happens to be set to a value that would otherwise look usable.
 * A harness that could silently inherit either would defeat the whole
 * point of keeping these two capabilities' configuration independent (see
 * types.ts's module doc comment). There is no default, no partial config,
 * and no "run against whatever's available" mode: missing or malformed
 * required values throw immediately.
 *
 * Does not cache -- this is a low-frequency, CLI-driven operation, not a
 * hot path, so recomputing on every call is simpler than a cache-plus-
 * test-reset mechanism and avoids any risk of a stale cached config
 * outliving a test's env var changes.
 */
export function loadPaymentHarnessConfig(): PaymentHarnessConfig {
  const rawStudioId = process.env.PAYMENT_HARNESS_STUDIO_ID?.trim();
  if (!rawStudioId) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: missing PAYMENT_HARNESS_STUDIO_ID. The Payment Harness will not start " +
        "without an explicit, configured studio id.",
      "CONFIG_MISSING",
    );
  }
  // Normalized to lowercase before validation/storage -- Postgres UUID
  // columns canonically render lowercase, and the tenant guards
  // (assertPaymentHarnessStudio/assertPaymentHarnessClient) use strict,
  // case-sensitive equality on purpose. Without this normalization, an
  // operator-typed uppercase/mixed-case id would pass validation here but
  // then fail every later guard check against real (lowercase) database
  // values, for a reason completely disconnected from where the mistake
  // was made.
  const studioId = rawStudioId.toLowerCase();
  if (!UUID_PATTERN.test(studioId)) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: PAYMENT_HARNESS_STUDIO_ID is not a valid UUID. Refusing to proceed with a " +
        "malformed studio identifier.",
      "CONFIG_MALFORMED",
    );
  }

  const rawClientId = process.env.PAYMENT_HARNESS_CLIENT_ID?.trim();
  if (!rawClientId) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: missing PAYMENT_HARNESS_CLIENT_ID. The Payment Harness will not start " +
        "without an explicit, configured client id.",
      "CONFIG_MISSING",
    );
  }
  const clientId = rawClientId.toLowerCase();
  if (!UUID_PATTERN.test(clientId)) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: PAYMENT_HARNESS_CLIENT_ID is not a valid UUID. Refusing to proceed with a " +
        "malformed client identifier.",
      "CONFIG_MALFORMED",
    );
  }

  const environment = resolvePaymentHarnessEnvironment();

  // Slice 4 additions: the base URL Playwright navigates to, and the email
  // address of the Supabase Auth user linked to the configured QA client.
  // Both are harness-only, `PAYMENT_HARNESS_*`-prefixed, and validated with
  // the same fail-closed, no-fallback discipline as studioId/clientId above
  // -- never `NEXT_PUBLIC_APP_URL`/`NEXT_PUBLIC_SITE_URL` (the app's own
  // runtime URL) and never a `clients`/`client_account_links` DB lookup,
  // so the harness's login target is exactly what the operator configured,
  // not something inferred.
  const rawBaseUrl = process.env.PAYMENT_HARNESS_BASE_URL?.trim();
  if (!rawBaseUrl) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: missing PAYMENT_HARNESS_BASE_URL. The Payment Harness will not start " +
        "without an explicit, configured application base URL for the browser to navigate to.",
      "CONFIG_MISSING",
    );
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: PAYMENT_HARNESS_BASE_URL is not a valid absolute URL. Refusing to proceed " +
        "with a malformed application base URL.",
      "CONFIG_MALFORMED",
    );
  }

  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: PAYMENT_HARNESS_BASE_URL must be an http(s) URL. Refusing to proceed with " +
        "an unrecognized URL scheme.",
      "CONFIG_MALFORMED",
    );
  }

  // Stored as the normalized origin (scheme + host, no trailing slash, no
  // path/query) -- every later origin comparison in browser.ts compares
  // against exactly this value, so storing anything else here (a path, a
  // trailing slash) would make those comparisons fragile for no benefit.
  const baseUrl = parsedBaseUrl.origin;

  const rawPortalLoginEmail = process.env.PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL?.trim().toLowerCase();
  if (!rawPortalLoginEmail) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: missing PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL. The Payment Harness will not " +
        "start without an explicit, configured portal login email.",
      "CONFIG_MISSING",
    );
  }

  if (!EMAIL_PATTERN.test(rawPortalLoginEmail)) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL is not a valid email address. Refusing " +
        "to proceed with a malformed portal login email.",
      "CONFIG_MALFORMED",
    );
  }

  const portalLoginEmail = rawPortalLoginEmail;

  // Frozen so a later slice's write path can't accidentally (or
  // maliciously) mutate a loaded config before passing it into a guard --
  // the guards' entire safety model depends on config being trustworthy,
  // immutable ground truth. Object.freeze is the runtime half of this
  // guarantee; the `readonly` fields on PaymentHarnessConfig (types.ts)
  // are the compile-time half.
  return Object.freeze({ studioId, clientId, environment, baseUrl, portalLoginEmail });
}
