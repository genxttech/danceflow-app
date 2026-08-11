import type {
  SyntheticConfig,
  SyntheticEventFixtureConfig,
  SyntheticIdentityConfig,
  SyntheticRole,
} from "@/lib/synthetic/types";
import { SyntheticSafetyError } from "@/lib/synthetic/types";

/**
 * Fail-closed environment configuration for the synthetic harness.
 *
 * Every value the runner needs to operate must be explicitly configured.
 * There is no default, no fallback, and no "run against whatever's
 * available" mode -- an unconfigured harness refuses to start at all,
 * rather than silently degrading into something unsafe. This is the
 * config-loading half of the fail-closed guard described in
 * FlowOps quality/PRODUCTION-SYNTHETIC-TESTING.md safety requirement #1:
 * "Runner must fail closed if the target tenant is not the configured
 * synthetic tenant" -- it has to be configured before it can be checked.
 *
 * No credentials are ever hardcoded or committed here. Values come from
 * server-side environment variables only (see .env.example), never from
 * repository markdown or prompts, per FlowOps
 * 00-governance/INFORMATION-CLASSIFICATION.md and
 * quality/PRODUCTION-SYNTHETIC-TESTING.md safety requirement #5.
 */

function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new SyntheticSafetyError(
      `Missing ${name}. The synthetic harness will not start without an explicit ${name}.`,
      "CONFIG_MISSING",
    );
  }
  return value;
}

function readOptional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readIdentity(role: SyntheticRole): SyntheticIdentityConfig | null {
  const prefix = `SYNTHETIC_${role.toUpperCase()}`;
  const email = readOptional(`${prefix}_EMAIL`);
  const password = readOptional(`${prefix}_PASSWORD`);

  if (!email && !password) return null;
  if (!email || !password) {
    throw new SyntheticSafetyError(
      `${prefix}_EMAIL and ${prefix}_PASSWORD must both be set or both be unset.`,
      "CONFIG_INCOMPLETE",
    );
  }

  if (role === "student") {
    const clientId = readOptional(`${prefix}_CLIENT_ID`);
    if (!clientId) {
      throw new SyntheticSafetyError(
        "SYNTHETIC_STUDENT_CLIENT_ID is required alongside SYNTHETIC_STUDENT_EMAIL/PASSWORD.",
        "CONFIG_INCOMPLETE",
      );
    }
    return { email, password, clientId };
  }

  return { email, password };
}

function readEventFixture(): SyntheticEventFixtureConfig | null {
  const eventId = readOptional("SYNTHETIC_EVENT_ID");
  const ticketTypeId = readOptional("SYNTHETIC_EVENT_TICKET_TYPE_ID");
  if (!eventId && !ticketTypeId) return null;
  if (!eventId || !ticketTypeId) {
    throw new SyntheticSafetyError(
      "SYNTHETIC_EVENT_ID and SYNTHETIC_EVENT_TICKET_TYPE_ID must both be set or both be unset.",
      "CONFIG_INCOMPLETE",
    );
  }
  return { eventId, ticketTypeId };
}

let cachedConfig: SyntheticConfig | null = null;

/**
 * Loads and validates synthetic-harness configuration. Throws
 * SyntheticSafetyError (never returns a partially-usable config) if
 * anything required is missing. Call this first, before any suite runs --
 * every suite entry point does this itself as well, so there is no code
 * path that can run without it.
 */
export function loadSyntheticConfig(): SyntheticConfig {
  if (cachedConfig) return cachedConfig;

  const studioId = readRequired("SYNTHETIC_STUDIO_ID");
  const supabaseUrl = readRequired("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = readRequired("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const identities: SyntheticConfig["identities"] = {};
  for (const role of ["owner", "organizer", "student"] as SyntheticRole[]) {
    const identity = readIdentity(role);
    if (identity) identities[role] = identity;
  }

  if (Object.keys(identities).length === 0) {
    throw new SyntheticSafetyError(
      "No synthetic identities configured. At least one of SYNTHETIC_OWNER_*, SYNTHETIC_ORGANIZER_*, or SYNTHETIC_STUDENT_* must be set.",
      "CONFIG_MISSING",
    );
  }

  const eventFixture = readEventFixture();

  cachedConfig = { studioId, supabaseUrl, supabaseAnonKey, identities, eventFixture };
  return cachedConfig;
}

/** Test-only: clears the cached config so tests can exercise different env states. */
export function __resetSyntheticConfigCacheForTests() {
  cachedConfig = null;
}
