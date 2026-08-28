/**
 * Public Event Registration E2E Harness -- Slice 1.
 *
 * Fail-closed guard preventing the E2E harness (which seeds/mutates data
 * and drives a real browser through checkout-adjacent flows) from ever
 * being pointed at the real DanceFlow production environment. Modeled on
 * the same "positive allowlist, not negative blocklist" idiom already
 * established in src/lib/payment-harness/guards.ts and
 * src/lib/synthetic/guards.ts (see PAYMENT_HARNESS_ALLOWED_ENVIRONMENTS /
 * SyntheticSafetyError) -- an unrecognized host is rejected, not assumed
 * safe. The exact known production hostnames are additionally hard-blocked
 * as defense in depth, so this still fails closed even if the allowlist
 * (or E2E_ALLOW_HOSTS) is ever loosened by mistake.
 *
 * The built-in safe list is limited to explicit loopback/local-development
 * hosts only -- it deliberately does NOT include a blanket "*.vercel.app"
 * entry. Vercel assigns a *.vercel.app address to every deployment,
 * production included (e.g. a real "Production - danceflow-app-qfem"
 * deployment's own address has looked exactly like
 * "danceflow-app-qfem-<hash>-dance-flow.vercel.app" in this project's own
 * deployment history), so there is no way to distinguish "preview" from
 * "production" by hostname shape alone. A remote preview host must be
 * added explicitly, per exact hostname, via E2E_ALLOW_HOSTS -- never
 * trusted as a class.
 */

export class E2ESafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2ESafetyError";
  }
}

const KNOWN_PRODUCTION_HOSTS = new Set(["idanceflow.com", "www.idanceflow.com"]);

const SAFE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\.0\.0\.1$/,
  /^\[::1\]$/,
];

/**
 * Throws E2ESafetyError unless `rawUrl` is a well-formed absolute URL whose
 * host is safe to run the E2E harness against. Returns the parsed URL on
 * success so callers don't have to re-parse it.
 */
export function assertE2EBaseUrlIsSafe(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new E2ESafetyError(`E2E_BASE_URL is not a valid absolute URL: "${rawUrl}".`);
  }

  const host = url.hostname.toLowerCase();

  // Checked first and unconditionally -- this must win even if
  // E2E_ALLOW_HOSTS is ever misconfigured to include a production host.
  if (KNOWN_PRODUCTION_HOSTS.has(host)) {
    throw new E2ESafetyError(
      `E2E_BASE_URL ("${rawUrl}") resolves to a known DanceFlow production domain ("${host}"). Refusing to run the E2E harness against production.`,
    );
  }

  const extraAllowedHosts = (process.env.E2E_ALLOW_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const isSafe =
    SAFE_HOST_PATTERNS.some((pattern) => pattern.test(host)) || extraAllowedHosts.includes(host);

  if (!isSafe) {
    throw new E2ESafetyError(
      `E2E_BASE_URL ("${rawUrl}") does not match any built-in safe host (localhost, 127.0.0.1, [::1]) and is not listed in E2E_ALLOW_HOSTS. Failing closed: an unrecognized host -- including any *.vercel.app deployment, which production also uses -- is refused, not assumed safe. Add its exact hostname to E2E_ALLOW_HOSTS if it's a genuine non-production target.`,
    );
  }

  return url;
}
