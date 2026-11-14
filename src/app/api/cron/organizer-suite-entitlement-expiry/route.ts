import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import {
  countDueOrganizerSuiteGrants,
  isOrganizerSuiteExpiryDryRun,
  isOrganizerSuiteExpiryEnabled,
  runOrganizerSuiteExpiry,
  type OrganizerSuiteExpiryOutcome,
} from "@/lib/billing/organizerSuiteExpiryJob";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * D7 dated expiry of complimentary Organizer Suite grants (organizerSuiteExpiryJob.ts). DARK: answered 404 unless
 * ORGANIZER_SUITE_EXPIRY_ENABLED is exactly "true", and NOT registered in vercel.json (suggested hourly, "7 * * * *", added
 * deliberately by a release owner; see docs/billing/ORGANIZER-SUITE-EXPIRY-JOB.md). Then CRON_SECRET is required (Bearer or
 * x-cron-secret). One RPC call per invocation with as_of = server now (never caller-supplied); retry- and concurrency-safe
 * (a repeat call expires 0). ?dry_run=1 (or ORGANIZER_SUITE_EXPIRY_DRY_RUN=true) only SELECTs and reports how many would
 * expire. Counts only: no studio, organizer or entitlement id, no notes. Never purchases, charges, extends or deletes.
 */
async function run(request: Request) {
  if (!isOrganizerSuiteExpiryEnabled()) return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  const headers = { "Cache-Control": "no-store" };
  const dryRun = isOrganizerSuiteExpiryDryRun(request.url);
  const asOf = new Date();
  let outcome: OrganizerSuiteExpiryOutcome;
  try {
    const admin = createAdminClient();
    outcome = dryRun ? await countDueOrganizerSuiteGrants(admin, asOf) : await runOrganizerSuiteExpiry(admin, asOf);
  } catch {
    console.error("organizer_suite_expiry_failed");
    return Response.json({ ok: false, dry_run: dryRun, error: "expiry_failed" }, { status: 500, headers });
  }

  if (!outcome.ok) {
    console.error(`organizer_suite_expiry_${outcome.error}`);
    const status = outcome.error === "migration_not_applied" ? 503 : 500;
    return Response.json({ ok: false, dry_run: outcome.dryRun, as_of: outcome.asOf, error: outcome.error }, { status, headers });
  }
  if (outcome.dryRun) {
    return Response.json({ ok: true, dry_run: true, as_of: outcome.asOf, would_expire_count: outcome.wouldExpireCount }, { headers });
  }
  return Response.json({ ok: true, dry_run: false, as_of: outcome.asOf, expired_count: outcome.expiredCount }, { headers });
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
