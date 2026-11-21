/**
 * Pays an open Stripe-hosted Checkout Session in TEST mode the way a customer does: in a browser, with Stripe's documented TEST card.
 * It replaces the undocumented /v1/payment_pages confirm call (run 44806898241: 400 checkout_confirm_error).
 *
 * Boundaries (all fail closed):
 *  - only https://checkout.stripe.com/c/pay/cs_test_... is ever opened (a live session id, another host or an http URL is refused);
 *  - the browser can only talk to Stripe's own hosts plus the loopback success page; everything else is aborted;
 *  - the browser never receives the Stripe key (see browserEnv);
 *  - a security challenge (captcha, 3-D Secure, "verify") is NEVER bypassed: it is reported as INCONCLUSIVE and fails the run;
 *  - this file decides nothing about success. Whether the session is paid is always re-read from the Stripe API by the caller.
 * The driver talks to a narrow HostedPage so the decision logic is unit-tested without a browser.
 */

export const TEST_CARD = { number: "4242424242424242", expiry: "12 / 34", cvc: "123", name: "CF1 Canary", postal: "12345" } as const;
export const CANARY_EMAIL = "cf1-canary@example.com";

/**
 * The one accepted layout: https://checkout.stripe.com/c/pay/cs_test_<id>[#fragment]. Evidence: Stripe's Checkout Sessions documentation (the session `url`),
 * this repo's payment harness (src/lib/payment-harness/browser.ts: host set {checkout.stripe.com}, session-id pattern cs_[a-zA-Z0-9_]+) and its unit tests.
 * Underscores are allowed in the id because that existing pattern allows them. The legacy /pay/ layout is NOT accepted: only a comment in the harness
 * mentions it, and no observed session has used it.
 */
const CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\/c\/pay\/(cs_test_[A-Za-z0-9_]+)(?:[?#].*)?$/;

/** Fixed vocabulary that may be printed verbatim. Everything else is reduced to a length or a category, so no URL value can reach a log. */
const SHOWN_HOST = new Set(["checkout.stripe.com"]);
const SHOWN_SEGMENT = new Set(["c", "pay"]);

/**
 * A structural description of a URL for failure messages. Printed verbatim: only the scheme (https/http), the host when it is exactly checkout.stripe.com,
 * and path segments that are exactly "c" or "pay". Every other host or path segment is reduced to a category and a length, whatever its content (short
 * lowercase words included), and a query, fragment, userinfo or port is reported only as present. No identifier or value is ever included.
 */
export function describeUrlShape(url: unknown): string {
  if (typeof url !== "string") return `not a string (${url === null ? "null" : typeof url})`;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const hostText = SHOWN_HOST.has(host) ? host : `<${isAllowedHost(host) ? "other Stripe-owned host" : "non-Stripe host"}, ${host.length} chars, ${host.split(".").length} labels>`;
    const parts = u.pathname.split("/").filter(Boolean);
    const shown = parts.slice(0, 6).map((seg) => {
      if (SHOWN_SEGMENT.has(seg)) return seg;
      const kind = seg.startsWith("cs_test_") ? "test session id" : seg.startsWith("cs_live_") ? "LIVE session id" : "other";
      return `<${kind}, ${seg.length} chars>`;
    });
    if (parts.length > shown.length) shown.push(`<${parts.length - shown.length} more>`);
    const scheme = u.protocol === "https:" ? "https" : u.protocol === "http:" ? "http" : "other";
    const extras = `userinfo=${u.username || u.password ? "yes" : "no"} port=${u.port ? "yes" : "no"} query=${u.search ? "yes" : "no"} fragment=${u.hash ? "yes" : "no"}`;
    return `scheme=${scheme} host=${hostText} path=/${shown.join("/")} ${extras}`;
  } catch {
    return `unparseable (${url.length} chars)`;
  }
}

/** Returns the session id; throws on anything that is not a TEST hosted Checkout URL. The error shows the URL's shape, never its values. */
export function assertHostedCheckoutUrl(url: unknown): string {
  if (typeof url !== "string") throw new Error("the Checkout Session has no hosted URL");
  const match = CHECKOUT_URL.exec(url);
  if (!match) throw new Error(`refusing: the Checkout URL is not https://checkout.stripe.com/c/pay/cs_test_... (seen: ${describeUrlShape(url)})`);
  return match[1];
}

/** True for hosts the hosted page legitimately needs. Anything else is aborted. */
export function isAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "stripe.com" || h.endsWith(".stripe.com") || h === "stripe.network" || h.endsWith(".stripe.network") || h === "stripecdn.com" || h.endsWith(".stripecdn.com");
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** A minimal environment for the browser process: it must not inherit the Stripe key or any other secret. */
export function browserEnv(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR", "XDG_RUNTIME_DIR", "PLAYWRIGHT_BROWSERS_PATH"]) {
    const value = source[name];
    if (value) out[name] = value;
  }
  return out;
}

const CHALLENGE_FRAME = /hcaptcha|recaptcha|captcha|three-?d-?secure|3ds|authenticate|challenge|acs\./i;
const CHALLENGE_TEXT = /verify (that )?you('| a)re (a )?human|are you a robot|complete the security check|additional authentication|authenticate (this|your) payment|3d secure|captcha/i;

/** Returns why the page needs something a test must not bypass, or null. */
export function detectChallenge(frameUrls: string[], bodyText: string): string | null {
  const frame = frameUrls.find((u) => CHALLENGE_FRAME.test(u));
  if (frame) return "a security challenge frame is present";
  if (CHALLENGE_TEXT.test(bodyText)) return "the page asks for a security check or additional authentication";
  return null;
}

export interface HostedPage {
  open(url: string): Promise<void>;
  /** Fills the first candidate selector that exists; returns false when none exists. */
  fillFirst(candidates: string[], value: string): Promise<boolean>;
  /** Clicks the first candidate selector that exists; returns false when none exists. */
  clickFirst(candidates: string[]): Promise<boolean>;
  /** Unticks the first candidate checkbox if it exists and is ticked; returns whether anything was found. */
  uncheckFirst(candidates: string[]): Promise<boolean>;
  frameUrls(): string[];
  bodyText(): Promise<string>;
  currentUrl(): string;
  /** Resolves true once the page URL starts with the given prefix, false on timeout. */
  waitForUrlPrefix(prefix: string, timeoutMs: number): Promise<boolean>;
  wait(ms: number): Promise<void>;
}

const SELECTORS = {
  email: ["#email", "input[name='email']", "input[type='email']"],
  cardNumber: ["#cardNumber", "input[name='cardNumber']", "input[autocomplete='cc-number']"],
  cardExpiry: ["#cardExpiry", "input[name='cardExpiry']", "input[autocomplete='cc-exp']"],
  cardCvc: ["#cardCvc", "input[name='cardCvc']", "input[autocomplete='cc-csc']"],
  name: ["#billingName", "input[name='billingName']", "input[autocomplete='cc-name']"],
  postal: ["#billingPostalCode", "input[name='billingPostalCode']", "input[autocomplete='postal-code']"],
  save: ["[data-testid='hosted-payment-submit-button']", "button.SubmitButton", "button[type='submit']"],
  link: ["#enableStripePass", "input[name='enableStripePass']"],
} as const;

export type HostedPayOptions = { successPrefix: string; timeoutMs?: number };

/**
 * Drives the page. Returns normally only when the browser reached the success URL; the caller then confirms payment with documented API reads.
 * Every other outcome throws with a message that names the step and never contains page text beyond the fixed labels used here.
 */
export async function driveHostedCheckout(page: HostedPage, url: string, options: HostedPayOptions): Promise<void> {
  assertHostedCheckoutUrl(url);
  await page.open(url);

  const early = detectChallenge(page.frameUrls(), await page.bodyText());
  if (early) throw new Error(`INCONCLUSIVE: ${early} before payment details were entered; the test does not bypass it`);

  const required: Array<[string, string[], string]> = [
    ["card number", [...SELECTORS.cardNumber], TEST_CARD.number],
    ["card expiry", [...SELECTORS.cardExpiry], TEST_CARD.expiry],
    ["card CVC", [...SELECTORS.cardCvc], TEST_CARD.cvc],
  ];
  for (const [label, selectors, value] of required) {
    if (!(await page.fillFirst(selectors, value))) throw new Error(`hosted Checkout: the ${label} field was not found (the page layout changed or a different payment form is shown)`);
  }
  // Optional fields: present depending on the session and the account's country settings.
  await page.fillFirst([...SELECTORS.email], CANARY_EMAIL);
  await page.fillFirst([...SELECTORS.name], TEST_CARD.name);
  await page.fillFirst([...SELECTORS.postal], TEST_CARD.postal);
  await page.uncheckFirst([...SELECTORS.link]);

  if (!(await page.clickFirst([...SELECTORS.save]))) throw new Error("hosted Checkout: the pay button was not found");

  const timeoutMs = options.timeoutMs ?? 90_000;
  const step = 3_000;
  let waited = 0;
  while (waited < timeoutMs) {
    if (await page.waitForUrlPrefix(options.successPrefix, step)) return;
    waited += step;
    const challenge = detectChallenge(page.frameUrls(), await page.bodyText());
    if (challenge) throw new Error(`INCONCLUSIVE: ${challenge} after submitting payment; the test does not bypass it`);
  }
  throw new Error(`hosted Checkout: the success page was not reached within ${Math.round(timeoutMs / 1000)}s after submitting payment (the payment may have been declined or is still processing)`);
}
