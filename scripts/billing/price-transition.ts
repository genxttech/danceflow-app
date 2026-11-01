/**
 * D7 WP-3: owner-only July 2027 protected-price transition. DRY-RUN BY DEFAULT.
 *
 *   npx tsx scripts/billing/price-transition.ts \
 *     --protected-subscription <registry uuid> --notice <notice uuid> --subscription sub_... \
 *     --expected-current-price price_... --target-price price_... --boundary 2027-07-09T04:00:00Z
 *
 * Add `--execute --approved-by <owner uuid> --approved-plan-hash <hash printed by the dry run>` to schedule the change.
 * A live Stripe key additionally needs `--allow-live --live-authorization-ref <written authorization reference>`.
 *
 * Environment: STRIPE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and D7_TRANSITION_OWNER_IDS
 * (comma-separated owner uuids allowed to approve). Never run against a hosted project or Stripe account without the
 * separate written authorization this script records. Reads Stripe (retrieve) even in dry run. The report names the
 * Supabase host and the Stripe key mode so a mismatched pairing is visible before anything is approved.
 */
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { runPriceTransition, type RunnerDeps } from "@/lib/billing/priceTransitionRunner";
import { resolvePlanCodeFromEnvPriceId } from "@/lib/billing/subscriptionPlanResolution";

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
const has = (name: string) => process.argv.includes(`--${name}`);
function need(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`missing --${name}`);
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
  const stripe = new Stripe(secret);
  const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const db = createClient(supabaseUrl, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const owners = new Set((process.env.D7_TRANSITION_OWNER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const unix = (n: number) => new Date(n * 1000);

  const deps: RunnerDeps = {
    now: () => new Date(),
    keyMode,
    stripe: stripe as unknown as RunnerDeps["stripe"],
    isAuthorizedApprover: (id) => owners.has(id),
    resolvePlanForPrice: (priceId) => resolvePlanCodeFromEnvPriceId(priceId, process.env),
    async loadRegistry(id) {
      const { data, error } = await db.from("protected_subscriptions").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`registry read failed: ${error.message}`);
      return data
        ? { id: data.id, studioId: data.studio_id, stripeSubscriptionId: data.stripe_subscription_id, stripeCustomerId: data.stripe_customer_id, stripePriceId: data.stripe_price_id, releasedAt: data.released_at, protectionKind: data.protection_kind }
        : null;
    },
    async loadNotice(id) {
      const { data, error } = await db.from("price_transition_notices").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`notice read failed: ${error.message}`);
      return data
        ? {
            id: data.id,
            protectedSubscriptionId: data.protected_subscription_id,
            studioId: data.studio_id,
            effectiveAt: new Date(data.effective_at),
            newPriceId: data.new_stripe_price_id,
            newUnitAmountCents: data.new_unit_amount_cents,
            currency: data.currency,
            billingInterval: data.billing_interval,
            approved: Boolean(data.approved_at),
            deliveryStatus: data.delivery_status,
            sentAt: data.sent_at ? new Date(data.sent_at) : null,
          }
        : null;
    },
    async hasOpenTransition(id) {
      const { count, error } = await db.from("price_transitions").select("id", { count: "exact", head: true }).eq("protected_subscription_id", id).in("status", ["approved", "scheduled"]);
      if (error || count === null) throw new Error(`open-transition read failed: ${error?.message ?? "no count"}`);
      return count > 0;
    },
    async readSubscription(id) {
      const sub = (await stripe.subscriptions.retrieve(id)) as Stripe.Subscription;
      const item = sub.items.data[0];
      const periodStart = (sub as unknown as { current_period_start?: number }).current_period_start ?? (item as unknown as { current_period_start: number }).current_period_start;
      const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end ?? (item as unknown as { current_period_end: number }).current_period_end;
      const loose = sub as unknown as Record<string, unknown>;
      const unsupportedSettings: string[] = [];
      if (sub.trial_end) unsupportedSettings.push("trial");
      if (sub.pause_collection) unsupportedSettings.push("pause_collection");
      if (sub.pending_update) unsupportedSettings.push("pending_update");
      if (sub.cancel_at) unsupportedSettings.push("cancel_at");
      if (sub.collection_method !== "charge_automatically") unsupportedSettings.push("collection_method");
      if (Array.isArray(loose.discounts) && loose.discounts.length > 0) unsupportedSettings.push("discounts");
      if (loose.discount) unsupportedSettings.push("discount");
      return {
        id: sub.id,
        customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        status: sub.status,
        currentPeriodStart: unix(periodStart),
        currentPeriodEnd: unix(periodEnd),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        scheduleId: typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null,
        items: sub.items.data.map((i) => ({ priceId: i.price.id, quantity: i.quantity ?? 1, metadata: { ...(i.metadata ?? {}) } })),
        metadata: { ...(sub.metadata ?? {}) },
        unsupportedSettings,
      };
    },
    async readPrice(id) {
      const price = await stripe.prices.retrieve(id);
      return {
        id: price.id,
        active: price.active,
        unitAmountCents: price.unit_amount,
        currency: price.currency,
        interval: price.recurring?.interval ?? null,
        intervalCount: price.recurring?.interval_count ?? null,
        type: price.type,
        billingScheme: price.billing_scheme,
        usageType: price.recurring?.usage_type ?? null,
        hasTransformQuantity: price.transform_quantity != null,
      };
    },
    async insertAudit(row) {
      const { data, error } = await db
        .from("price_transitions")
        .insert({
          protected_subscription_id: row.protectedSubscriptionId,
          notice_id: row.noticeId,
          stripe_subscription_id: row.stripeSubscriptionId,
          target_stripe_price_id: row.targetStripePriceId,
          boundary_at: row.boundaryAt,
          approved_by: row.approvedBy,
          dry_run: row.dryRun,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(error?.message ?? "audit insert failed");
      return { id: data.id };
    },
    async recordSchedule(auditId, scheduleId) {
      const { error } = await db.from("price_transitions").update({ stripe_schedule_id: scheduleId }).eq("id", auditId);
      if (error) throw new Error(error.message);
    },
    async finalizeAudit(id, patch) {
      const { error } = await db.from("price_transitions").update({ status: patch.status, stripe_schedule_id: patch.scheduleId, result: patch.result }).eq("id", id);
      if (error) throw new Error(error.message);
    },
  };

  const report = await runPriceTransition(
    {
      protectedSubscriptionId: need("protected-subscription"),
      noticeId: need("notice"),
      stripeSubscriptionId: need("subscription"),
      expectedCurrentPriceId: need("expected-current-price"),
      targetPriceId: need("target-price"),
      boundaryAt: new Date(need("boundary")),
      execute: has("execute"),
      approvedBy: flag("approved-by"),
      approvedPlanHash: flag("approved-plan-hash"),
      allowLive: has("allow-live"),
      liveAuthorizationRef: flag("live-authorization-ref"),
    },
    deps,
  );
  console.log(JSON.stringify({ environment: { supabaseHost: new URL(supabaseUrl).host, stripeKeyMode: keyMode, stripeApiVersion: Stripe.API_VERSION }, ...report }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
