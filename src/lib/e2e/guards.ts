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

/**
 * Slice 3 (independent pre-commit review, Blocker B2): the Supabase-target
 * counterpart to `assertE2EBaseUrlIsSafe` above -- same philosophy, same
 * positive-allowlist/hard-block shape, deliberately a SEPARATE function and
 * a SEPARATE allowlist env var (E2E_SUPABASE_ALLOW_HOSTS, not
 * E2E_ALLOW_HOSTS) rather than reusing the base-URL one: the app origin and
 * the Supabase project are different resources with different blast radii
 * if misdirected (a wrong app origin misdirects a browser; a wrong Supabase
 * target lets this harness's real seed/mutate/delete fixture operations
 * run against a real project's real data), so conflating their allowlists
 * would let a host meant to be safe for one silently become allowed for
 * the other.
 *
 * The known production Supabase host below was read directly from this
 * machine's own `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`) -- the same file
 * this codebase's own E2E harness docs already describe as pointing at
 * "the hosted project" by default -- not queried, not guessed, and never
 * itself read by this function or any E2E code path (see loadE2EConfig:
 * this harness only ever reads E2E_SUPABASE_URL, never
 * NEXT_PUBLIC_SUPABASE_URL).
 */
const KNOWN_PRODUCTION_SUPABASE_HOSTS = new Set(["epdrtzcydvnoidwrepqz.supabase.co"]);

/**
 * Throws E2ESafetyError unless `rawUrl` is a well-formed absolute URL whose
 * host is safe for the E2E harness to seed/mutate/delete real rows in.
 * Never receives or logs the service-role key -- callers pass only the URL.
 */
export function assertE2ESupabaseUrlIsSafe(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new E2ESafetyError(`E2E_SUPABASE_URL is not a valid absolute URL: "${rawUrl}".`);
  }

  const host = url.hostname.toLowerCase();

  // Checked first and unconditionally -- this must win even if
  // E2E_SUPABASE_ALLOW_HOSTS is ever misconfigured to include it.
  if (KNOWN_PRODUCTION_SUPABASE_HOSTS.has(host)) {
    throw new E2ESafetyError(
      `E2E_SUPABASE_URL ("${rawUrl}") resolves to a known DanceFlow production Supabase project ("${host}"). Refusing to run the E2E harness against production.`,
    );
  }

  const extraAllowedHosts = (process.env.E2E_SUPABASE_ALLOW_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const isSafe =
    SAFE_HOST_PATTERNS.some((pattern) => pattern.test(host)) || extraAllowedHosts.includes(host);

  if (!isSafe) {
    throw new E2ESafetyError(
      `E2E_SUPABASE_URL ("${rawUrl}") does not match any built-in safe host (localhost, 127.0.0.1, [::1]) and is not listed in E2E_SUPABASE_ALLOW_HOSTS. Failing closed: an unrecognized Supabase host is refused, not assumed safe. Add its exact hostname to E2E_SUPABASE_ALLOW_HOSTS if it's a genuine, dedicated, non-production Supabase project.`,
    );
  }

  return url;
}
