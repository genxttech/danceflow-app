/**
 * Public Event Registration E2E Harness -- Slice 1.
 *
 * Explicit, non-inherited configuration for the Playwright E2E harness --
 * every value is its own E2E_*-prefixed env var with no default and no
 * fallback to the app's own runtime vars (NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_APP_URL, etc.), matching the same idiom already established
 * by src/lib/payment-harness/config.ts and src/lib/synthetic/config.ts:
 * a harness that seeds/mutates data must never silently inherit whatever
 * the app happens to be configured for at the moment.
 */

import { assertE2EBaseUrlIsSafe, E2ESafetyError } from "@/lib/e2e/guards";

export type E2EConfig = {
  /** Origin the Playwright browser navigates against, e.g. http://localhost:3000 */
  baseUrl: string;
  /** Supabase API URL the fixture helpers seed data into directly (service-role). */
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new E2ESafetyError(
      `${name} is required and has no default -- see .env.e2e.example. Refusing to guess.`,
    );
  }
  return value;
}

export function loadE2EConfig(): E2EConfig {
  const baseUrlRaw = requireEnv("E2E_BASE_URL");
  const baseUrl = assertE2EBaseUrlIsSafe(baseUrlRaw);

  const supabaseUrl = requireEnv("E2E_SUPABASE_URL");
  const supabaseServiceRoleKey = requireEnv("E2E_SUPABASE_SERVICE_ROLE_KEY");

  return Object.freeze({
    baseUrl: baseUrl.origin,
    supabaseUrl,
    supabaseServiceRoleKey,
  });
}
