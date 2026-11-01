/**
 * D7 WP-3: post-boundary reconciliation of protected-price transitions. DRY-RUN BY DEFAULT; it only READS Stripe.
 *
 *   npx tsx scripts/billing/price-transition-reconcile.ts --transition <price_transitions uuid>
 *   npx tsx scripts/billing/price-transition-reconcile.ts --all-due            # sweep for missed or delayed webhook events
 *
 * Add `--apply` to record milestones, flag needs_review, or atomically record the reconciled transition and release the
 * protected-price registry row. Safe to re-run at any time. Environment: STRIPE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY. Never run against a hosted project or Stripe account without separate written authorization.
 */
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { reconcilePriceTransition } from "@/lib/billing/priceTransitionReconcile";
import { createReconcileDeps, listDueTransitionIds } from "@/lib/billing/priceTransitionReconcileDeps";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return value;
}
function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const secret = env("STRIPE_SECRET_KEY");
  const keyMode = secret.startsWith("sk_live_") || secret.startsWith("rk_live_") ? "live" : "test";
  const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const db = createClient(supabaseUrl, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const deps = createReconcileDeps(db, new Stripe(secret));
  const apply = process.argv.includes("--apply");

  const ids = process.argv.includes("--all-due") ? await listDueTransitionIds(db, new Date()) : [flag("transition") ?? ""].filter(Boolean);
  if (ids.length === 0) {
    console.error("nothing to reconcile: pass --transition <id> or --all-due (no due transitions found)");
    process.exit(process.argv.includes("--all-due") ? 0 : 2);
  }

  let failed = false;
  const reports = [];
  for (const id of ids) {
    try {
      const report = await reconcilePriceTransition(id, deps, { apply });
      reports.push(report);
      if (report.state === "needs_review") failed = true;
    } catch (error) {
      failed = true;
      reports.push({ transitionId: id, state: "error", error: error instanceof Error ? error.message : "unknown" });
    }
  }
  console.log(JSON.stringify({ environment: { supabaseHost: new URL(supabaseUrl).host, stripeKeyMode: keyMode, stripeApiVersion: Stripe.API_VERSION }, apply, reports }, null, 2));
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
