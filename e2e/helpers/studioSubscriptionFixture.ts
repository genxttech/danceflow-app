import { randomBytes, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { E2EConfig } from "@/lib/e2e/config";
import { CURRENT_BUSINESS_LEGAL_ACCEPTANCE_VERSION, CURRENT_LEGAL_AGREEMENTS } from "@/lib/legal/agreements";
import { e2eAdminClient, type CompetitionAccount } from "./competitionFixture";

/**
 * BILLING-QA-2 studio SUBSCRIPTION fixtures (isolated local QA Supabase only). Two run-scoped studios, each with its
 * own studio owner who has accepted the current business terms:
 *   - `fresh`: never subscribed (subscription_status inactive), used for new-subscriber checkout and plan changes;
 *   - `legacy`: given a grandfathered subscription directly in Stripe test mode by the spec.
 * Missing starter/growth/pro `subscription_plans` rows are created (with no Stripe Price IDs, so the webhook resolves
 * plans through the checkout Price env vars, as in production) and only those are removed again.
 *
 * Every id is generated before anything is written. Cleanup removes only this run's rows, checks every delete and
 * throws listing anything it could not remove. Stripe test objects are cleaned up by the spec before this runs.
 */

export type SubscriptionStudio = { id: string; name: string; owner: CompetitionAccount };

export type StudioSubscriptionFixture = {
  runId: string;
  fresh: SubscriptionStudio;
  legacy: SubscriptionStudio;
  planIds: Record<"starter" | "growth" | "pro", string>;
  createdPlanIds: string[];
};

const PLAN_CODES = ["starter", "growth", "pro"] as const;

async function must<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`Studio subscription fixture: ${what}: ${error.message}`);
  return data as T;
}

export async function createStudioSubscriptionFixture(config: E2EConfig): Promise<StudioSubscriptionFixture> {
  const admin = e2eAdminClient(config);
  const runId = randomBytes(4).toString("hex");
  const studio = (key: string): SubscriptionStudio => ({
    id: randomUUID(),
    name: `E2E Billing Studio ${key} ${runId}`,
    owner: { id: "", email: `e2e-billing-${runId}-${key}-owner@e2e.test`, password: randomBytes(18).toString("base64url") },
  });
  const fixture: StudioSubscriptionFixture = {
    runId,
    fresh: studio("fresh"),
    legacy: studio("legacy"),
    planIds: { starter: "", growth: "", pro: "" },
    createdPlanIds: [],
  };

  try {
    for (const code of PLAN_CODES) {
      const existing = await must<{ id: string } | null>(admin.from("subscription_plans").select("id").eq("code", code).maybeSingle(), `${code} plan lookup`);
      if (existing) {
        fixture.planIds[code] = existing.id;
      } else {
        const id = randomUUID();
        await must(admin.from("subscription_plans").insert({ id, code, name: `${code} (E2E)`, active: true }), `${code} plan`);
        fixture.planIds[code] = id;
        fixture.createdPlanIds.push(id);
      }
    }

    for (const [key, s] of [["fresh", fixture.fresh], ["legacy", fixture.legacy]] as const) {
      await must(admin.from("studios").insert({ id: s.id, name: s.name, slug: `e2e-billing-${runId}-${key}`, subscription_status: "inactive" }), `${key} studio`);
      const { data: created, error } = await admin.auth.admin.createUser({ email: s.owner.email, password: s.owner.password, email_confirm: true });
      if (error || !created.user) throw new Error(`Studio subscription fixture: ${key} owner: ${error?.message}`);
      s.owner.id = created.user.id;
      await must(admin.from("profiles").upsert({ id: s.owner.id, email: s.owner.email, full_name: `E2E Billing Owner ${key}` }), `${key} owner profile`);
      await must(admin.from("user_studio_roles").insert({ user_id: s.owner.id, studio_id: s.id, role: "studio_owner", active: true }), `${key} owner role`);
      await must(admin.from("legal_agreement_acceptances").insert({
        user_id: s.owner.id,
        acceptance_version: CURRENT_BUSINESS_LEGAL_ACCEPTANCE_VERSION,
        terms_version: CURRENT_LEGAL_AGREEMENTS.terms,
        privacy_version: CURRENT_LEGAL_AGREEMENTS.privacy,
        dpa_version: CURRENT_LEGAL_AGREEMENTS.dpa,
        electronic_signature_version: CURRENT_LEGAL_AGREEMENTS.electronicSignature,
        source: "business_signup",
        account_intent: "studio",
      }), `${key} legal acceptance`);
    }
    return fixture;
  } catch (error) {
    await cleanupStudioSubscriptionFixture(config, fixture).catch((cleanupError) => {
      console.error(`Studio subscription fixture: cleanup after failed creation was incomplete: ${(cleanupError as Error).message}`);
    });
    throw error;
  }
}

/** What the app recorded for a studio's DanceFlow subscription. */
export async function readStudioBilling(config: E2EConfig, studioId: string) {
  const admin = e2eAdminClient(config);
  const studio = await must<Record<string, unknown> | null>(
    admin.from("studios").select("billing_plan, subscription_status, stripe_customer_id, stripe_subscription_id").eq("id", studioId).maybeSingle(), "studio billing");
  const subscriptions = (await must<Record<string, unknown>[]>(
    admin.from("studio_subscriptions").select("id, subscription_plan_id, stripe_subscription_id, status, billing_interval").eq("studio_id", studioId), "studio subscriptions")) ?? [];
  const customers = (await must<Record<string, unknown>[]>(
    admin.from("studio_billing_customers").select("stripe_customer_id").eq("studio_id", studioId), "billing customers")) ?? [];
  return { studio, subscriptions, customers };
}

/** Links a Stripe test customer to a studio the way checkout does (webhooks find the studio through this row). */
export async function linkBillingCustomer(config: E2EConfig, studioId: string, stripeCustomerId: string) {
  const admin = e2eAdminClient(config);
  await must(admin.from("studio_billing_customers").insert({ studio_id: studioId, stripe_customer_id: stripeCustomerId }), "link billing customer");
  await must(admin.from("studios").update({ stripe_customer_id: stripeCustomerId }).eq("id", studioId), "studio customer id");
}

/** Webhook idempotency ledger rows for Stripe event ids. */
export async function readLedger(config: E2EConfig, eventIds: string[]) {
  return (await must<Record<string, unknown>[]>(
    e2eAdminClient(config).from("payment_provider_events").select("provider_event_id, event_type, status").eq("provider", "stripe").in("provider_event_id", eventIds), "provider events")) ?? [];
}

/** Rows any studio got for a Stripe subscription id (an unowned platform subscription must produce none). */
export async function readPlatformSubscriptionRows(config: E2EConfig, stripeSubscriptionId: string) {
  const admin = e2eAdminClient(config);
  const count = async (table: string) =>
    ((await must<Record<string, unknown>[]>(admin.from(table).select("id").eq("stripe_subscription_id", stripeSubscriptionId), table)) ?? []).length;
  return { stripeSubscriptions: await count("stripe_subscriptions"), studioSubscriptions: await count("studio_subscriptions") };
}

/** Every Stripe test customer recorded for the run's studios (created by the app's checkout or by the spec). */
export async function runStripeCustomerIds(config: E2EConfig, fixture: StudioSubscriptionFixture | undefined) {
  if (!fixture) return [];
  const ids = new Set<string>();
  for (const s of [fixture.fresh, fixture.legacy]) {
    for (const row of (await readStudioBilling(config, s.id)).customers) if (row.stripe_customer_id) ids.add(String(row.stripe_customer_id));
  }
  return [...ids];
}

/** Deletes the run's Stripe TEST customers (cancelling their subscriptions) and expires their open Checkout Sessions. */
export async function cleanupStripeTestObjects(stripe: Stripe, customerIds: string[]) {
  const failures: string[] = [];
  for (const customer of customerIds) {
    try {
      const sessions = await stripe.checkout.sessions.list({ customer, limit: 100 });
      for (const session of sessions.data) if (session.status === "open") await stripe.checkout.sessions.expire(session.id);
      await stripe.customers.del(customer);
    } catch (error) {
      failures.push(`${customer}: ${(error as Error).message}`);
    }
  }
  if (failures.length) throw new Error(`Studio subscription Stripe cleanup incomplete: ${failures.join("; ")}`);
}

export async function cleanupStudioSubscriptionFixture(config: E2EConfig, fixture: StudioSubscriptionFixture | undefined) {
  if (!fixture) return;
  const admin = e2eAdminClient(config);
  const failures: string[] = [];
  const step = async (what: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) failures.push(`${what}: ${error.message}`);
  };

  for (const s of [fixture.fresh, fixture.legacy]) {
    await step("studio subscriptions", () => admin.from("studio_subscriptions").delete().eq("studio_id", s.id));
    await step("billing customers", () => admin.from("studio_billing_customers").delete().eq("studio_id", s.id));
    if (s.owner.id) {
      await step("legal acceptances", () => admin.from("legal_agreement_acceptances").delete().eq("user_id", s.owner.id));
      await step("owner role", () => admin.from("user_studio_roles").delete().eq("user_id", s.owner.id));
    }
    await step("studio", () => admin.from("studios").delete().eq("id", s.id));
    if (s.owner.id) {
      await step("owner profile", () => admin.from("profiles").delete().eq("id", s.owner.id));
      const { error } = await admin.auth.admin.deleteUser(s.owner.id);
      if (error) failures.push(`owner auth user: ${error.message}`);
    }
    const { data: left } = await admin.from("studios").select("id").eq("id", s.id).maybeSingle();
    if (left) failures.push(`studio ${s.id} still present`);
  }
  for (const id of fixture.createdPlanIds) await step("plan", () => admin.from("subscription_plans").delete().eq("id", id));
  if (failures.length) throw new Error(`Studio subscription fixture cleanup incomplete: ${failures.join("; ")}`);
}
