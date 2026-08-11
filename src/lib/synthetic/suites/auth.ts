import { assertSyntheticStudio } from "@/lib/synthetic/guards";
import type { CreatedRecordRefs } from "@/lib/synthetic/types";
import {
  assertTestCondition,
  requireSession,
  type SuiteCleanupResult,
  type SuiteContext,
} from "@/lib/synthetic/suites/contract";

/**
 * SYN-AUTH-001 -- Authentication
 *
 * Catalog assertion (FlowOps quality/SYNTHETIC-TEST-CATALOG.md):
 * "Restricted user can authenticate and only reach intended tenant."
 *
 * Steps (quality/PRODUCTION-SYNTHETIC-TESTING.md "Initial suites" list):
 * login as approved synthetic role; load protected resource; verify
 * expected tenant; logout/session termination.
 *
 * Protected resource: `clients`, not `studios`. `studios` was tried first
 * but is not actually tenant-restricted for this purpose -- Maya's
 * pre-activation review found `studios` carries an "authenticated users
 * can select studios during onboarding" policy (`FOR SELECT TO
 * authenticated USING (true)`), which grants blanket SELECT to any
 * logged-in user regardless of studio membership. `user_studio_roles` has
 * the identical "authenticated users can select user studio roles" `USING
 * (true)` policy, so it doesn't work either. `clients` has no such
 * blanket policy -- every SELECT policy on it is genuinely scoped
 * (`user_has_studio_access(studio_id)`, the "studio staff manage clients"
 * role check, or `portal_user_id = auth.uid()`), so reading it actually
 * exercises RLS-enforced tenant isolation rather than just an app-level
 * query filter that RLS would have honored regardless of tenant.
 *
 * Mutation: session only. No business records are created, so there is
 * nothing for cleanup to reverse.
 */
export async function runAuthSuite(ctx: SuiteContext): Promise<CreatedRecordRefs> {
  const session = requireSession(ctx, "owner");

  // Sign-in and the initial tenant check already happened in
  // signInSyntheticRole() before this suite ran. Re-assert here so this
  // suite doesn't silently rely on that having happened upstream --
  // SYN-AUTH-001 is specifically the test that is supposed to prove this
  // property, so it should check it directly rather than trust the caller.
  assertSyntheticStudio(ctx.config, session.studioId, "SYN-AUTH-001 tenant verification");

  // Load a protected resource: clients, scoped to the caller's studio
  // membership under RLS. There's no reliable "known other studio's
  // client id" to probe against directly, so this asserts the always-true
  // invariant instead (the same pattern already used by SYN-CLIENT-001's
  // own tenant-scoping check and SYN-PAY-READ-001's read-leak probe):
  // zero cross-tenant leakage across whatever this query returns.
  const { data: visibleClients, error: clientsError } = await session.client
    .from("clients")
    .select("studio_id")
    .limit(50);

  assertTestCondition(!clientsError, `Could not load protected clients resource: ${clientsError?.message}`);
  assertTestCondition(
    (visibleClients ?? []).every((row) => row.studio_id === session.studioId),
    "Synthetic session could see a clients row outside the synthetic tenant.",
  );

  // Logout / session termination: sign out, then verify the same
  // previously-authenticated client can no longer read the protected
  // resource. Under RLS this should come back as either an error or an
  // empty result -- either is an acceptable "terminated" signal; getting
  // any row back is not.
  await session.client.auth.signOut();

  const { data: postLogout, error: postLogoutError } = await session.client
    .from("clients")
    .select("studio_id")
    .limit(1);

  assertTestCondition(
    Boolean(postLogoutError) || (postLogout ?? []).length === 0,
    "Protected resource was still readable after synthetic sign-out -- session did not terminate.",
  );

  return {};
}

export async function cleanupAuthSuite(): Promise<SuiteCleanupResult> {
  return { status: "not_required", error: null };
}
