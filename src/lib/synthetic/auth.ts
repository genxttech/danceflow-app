import { createClient as createSupabaseJsClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadSyntheticConfig } from "@/lib/synthetic/config";
import { assertSyntheticStudio } from "@/lib/synthetic/guards";
import { SyntheticSafetyError } from "@/lib/synthetic/types";
import type { SyntheticConfig, SyntheticRole } from "@/lib/synthetic/types";

/**
 * Authenticated synthetic-user helpers.
 *
 * These sign in as a real, restricted synthetic identity through ordinary
 * Supabase Auth (the same mechanism the app's own login uses --
 * `signInWithPassword`), producing a real session subject to the
 * database's real Row Level Security policies. This is deliberately NOT
 * the service-role admin client: per FlowOps
 * quality/PRODUCTION-SYNTHETIC-TESTING.md safety requirement #4, "No
 * production service_role use for browser/business-flow tests unless a
 * specific server-side operation requires it and Maya approves the
 * boundary." The only service-role use anywhere in this harness is the
 * audit table itself (src/lib/synthetic/audit.ts), which is observability
 * infrastructure, not a business flow.
 */

export interface SyntheticSession {
  role: SyntheticRole;
  client: SupabaseClient;
  userId: string;
  studioId: string;
  /** Only set for the student role: the clients.id this portal user is
   * linked to. */
  clientId?: string;
}

async function resolveStudioId(
  client: SupabaseClient,
  role: SyntheticRole,
  userId: string,
  configuredStudioId: string,
): Promise<string | null> {
  if (role === "student") {
    const { data, error } = await client
      .from("client_account_links")
      .select("studio_id, client_id, status")
      .eq("user_id", userId)
      .eq("studio_id", configuredStudioId)
      .eq("status", "linked")
      .maybeSingle();
    if (error || !data) return null;
    return data.studio_id as string;
  }

  // owner / organizer: only ever resolve against the pre-configured
  // synthetic studio -- never "whichever studio comes back first," even
  // though that is how the real app's multi-workspace picker behaves for
  // ordinary staff users. A synthetic identity is provisioned for exactly
  // one tenant and must never be allowed to resolve to any other.
  const { data, error } = await client
    .from("user_studio_roles")
    .select("studio_id, active")
    .eq("user_id", userId)
    .eq("studio_id", configuredStudioId)
    .eq("active", true)
    .maybeSingle();
  if (error || !data) return null;
  return data.studio_id as string;
}

export async function signInSyntheticRole(
  role: SyntheticRole,
  config: SyntheticConfig = loadSyntheticConfig(),
): Promise<SyntheticSession> {
  const identity = config.identities[role];
  if (!identity) {
    throw new SyntheticSafetyError(
      `No synthetic identity configured for role "${role}".`,
      "CONFIG_MISSING",
    );
  }

  const client = createSupabaseJsClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await client.auth.signInWithPassword({
    email: identity.email,
    password: identity.password,
  });

  if (error || !data.session || !data.user) {
    throw new SyntheticSafetyError(
      `Synthetic sign-in failed for role "${role}": ${error?.message ?? "no session returned"}`,
      "AUTH_FAILED",
    );
  }

  const studioId = await resolveStudioId(client, role, data.user.id, config.studioId);

  // The core fail-closed check: a synthetic session that doesn't resolve
  // to the configured synthetic tenant is refused outright, before any
  // suite gets a chance to run anything against it.
  assertSyntheticStudio(config, studioId, `sign-in as synthetic ${role}`);

  return {
    role,
    client,
    userId: data.user.id,
    studioId: studioId as string,
    clientId: identity.clientId,
  };
}

export async function signOutSynthetic(session: SyntheticSession): Promise<void> {
  await session.client.auth.signOut();
}
