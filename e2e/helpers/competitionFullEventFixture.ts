import { randomBytes, randomUUID } from "node:crypto";
import type { E2EConfig } from "@/lib/e2e/config";
import { E2ESafetyError } from "@/lib/e2e/guards";
import { e2eAdminClient, type CompetitionAccount } from "./competitionFixture";

/**
 * Q1 full simulated competition: the base seed, and nothing else. A run-scoped studio (Pro plan with the Organizer
 * Suite add-on, so event commerce is available, and an existing Stripe TEST connected account so entries can be paid),
 * its owner, three judges and three dancers. Everything after this -- the event, the competition, registrations,
 * payments, check-in and the running order -- is created through the DanceFlow UI by the spec.
 *
 * Test credentials are generated here per run (random passwords) and live only in this fixture object; they are never
 * logged or written anywhere else. Every id is generated before anything is written, so cleanup removes exactly this
 * run's rows even when creation fails part-way. Cleanup checks every delete and throws listing anything left behind.
 */

export type CompetitionFullEventFixture = {
  runId: string;
  studioId: string;
  studioName: string;
  planId: string;
  createdPlan: boolean;
  owner: CompetitionAccount;
  judges: CompetitionAccount[];
  dancers: Array<CompetitionAccount & { firstName: string; lastName: string }>;
  /** The guest registers without an account; these are only the details typed into the public form. */
  guest: { email: string; firstName: string; lastName: string };
};

async function must<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`Competition full-event fixture: ${what}: ${error.message}`);
  return data as T;
}

const DANCER_NAMES: Array<[string, string]> = [["Avery", "Lead"], ["Blair", "Step"], ["Casey", "Turn"]];

export async function createCompetitionFullEventFixture(config: E2EConfig, options: { connectedAccountId: string }): Promise<CompetitionFullEventFixture> {
  if (!/^acct_[A-Za-z0-9]+$/.test(options.connectedAccountId)) throw new Error("Competition full-event fixture: invalid connected account id");
  const admin = e2eAdminClient(config);
  const runId = randomBytes(4).toString("hex");
  const password = () => randomBytes(18).toString("base64url");
  // Buyer-facing addresses use example.com (Stripe validates customer emails); staff use the reserved e2e.test domain.
  const fixture: CompetitionFullEventFixture = {
    runId,
    studioId: randomUUID(),
    studioName: `E2E Full Competition Studio ${runId}`,
    planId: randomUUID(),
    createdPlan: false,
    owner: { id: "", email: `e2e-compfull-${runId}-owner@e2e.test`, password: password() },
    judges: [1, 2, 3].map((n) => ({ id: "", email: `e2e-compfull-${runId}-judge${n}@e2e.test`, password: password() })),
    dancers: DANCER_NAMES.map(([firstName, lastName], index) => ({
      id: "", email: `e2e-compfull-${runId}-dancer${index + 1}@example.com`, password: password(), firstName, lastName,
    })),
    guest: { email: `e2e-compfull-${runId}-guest@example.com`, firstName: "Gale", lastName: "Guest" },
  };

  const profiles = await must(admin.from("competition_rules_profiles").select("version, status").eq("profile_key", "studio_simple"), "profiles");
  if (!profiles?.some((row) => row.version === 3 && row.status === "active")) {
    throw new E2ESafetyError("The E2E Supabase target has no active studio_simple@3 profile (20261114090000 is not applied).");
  }

  try {
    const existingPlan = await must<{ id: string } | null>(admin.from("subscription_plans").select("id").eq("code", "pro").maybeSingle(), "plan lookup");
    if (existingPlan) {
      fixture.planId = existingPlan.id;
    } else {
      fixture.createdPlan = true;
      await must(admin.from("subscription_plans").insert({ id: fixture.planId, code: "pro", name: "Pro (E2E)", active: true }), "plan");
    }
    await must(admin.from("studios").insert({
      id: fixture.studioId, name: fixture.studioName, slug: `e2e-compfull-${runId}`, subscription_status: "active", billing_plan: "pro",
      stripe_connected_account_id: options.connectedAccountId, stripe_connect_charges_enabled: true,
      stripe_connect_payouts_enabled: true, stripe_connect_onboarding_complete: true,
    }), "studio");
    await must(admin.from("studio_subscriptions").insert({ studio_id: fixture.studioId, subscription_plan_id: fixture.planId, status: "active" }), "subscription");
    await must(admin.from("usage_addon_entitlements").insert({
      studio_id: fixture.studioId, workspace_type: "studio", feature_key: "organizer_suite", quantity_included: 1, source: "manual_grant",
      status: "active", notes: "Q1 full simulated competition E2E fixture",
    }), "organizer suite entitlement");

    const create = async (account: CompetitionAccount, fullName: string) => {
      const { data, error } = await admin.auth.admin.createUser({ email: account.email, password: account.password, email_confirm: true });
      if (error || !data.user) throw new Error(`Competition full-event fixture: account ${account.email}: ${error?.message}`);
      account.id = data.user.id;
      await must(admin.from("profiles").upsert({ id: account.id, email: account.email, full_name: fullName }), `profile ${fullName}`);
    };
    await create(fixture.owner, "E2E Full Competition Owner");
    await must(admin.from("user_studio_roles").insert({ user_id: fixture.owner.id, studio_id: fixture.studioId, role: "studio_owner", active: true }), "owner role");
    // Judges are accounts only: officials and panel assignment do not exist yet (stage 6 is a fixme).
    for (const [index, judge] of fixture.judges.entries()) await create(judge, `E2E Judge ${index + 1}`);
    for (const dancer of fixture.dancers) await create(dancer, `${dancer.firstName} ${dancer.lastName}`);
    return fixture;
  } catch (error) {
    await cleanupCompetitionFullEventFixture(config, fixture).catch((cleanupError) => {
      console.error(`Competition full-event fixture: cleanup after failed creation was incomplete: ${(cleanupError as Error).message}`);
    });
    throw error;
  }
}

/** Removes the seed and everything the UI created under the run's studio (events cascade to competition rows). */
export async function cleanupCompetitionFullEventFixture(config: E2EConfig, fixture: CompetitionFullEventFixture | undefined) {
  if (!fixture) return;
  const admin = e2eAdminClient(config);
  const failures: string[] = [];
  const step = async (what: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) failures.push(`${what}: ${error.message}`);
  };
  const { data: events, error: eventsError } = await admin.from("events").select("id").eq("studio_id", fixture.studioId);
  if (eventsError) failures.push(`events lookup: ${eventsError.message}`);
  const eventIds = (events ?? []).map((row) => row.id as string);
  if (eventIds.length) {
    const { data: regs, error: regsError } = await admin.from("event_registrations").select("id").in("event_id", eventIds);
    if (regsError) failures.push(`registrations lookup: ${regsError.message}`);
    const regIds = (regs ?? []).map((row) => row.id as string);
    if (regIds.length) await step("event_payments", () => admin.from("event_payments").delete().in("registration_id", regIds));
    await step("registration client links", () => admin.from("event_registrations").update({ client_id: null }).in("event_id", eventIds));
    // The event goes first: its cascade removes the competition rows together, and the published-running-order and
    // entry/order-item guards allow that only once the event itself is gone. Orders are then a safety net.
    await step("events", () => admin.from("events").delete().in("id", eventIds));
    await step("event_orders", () => admin.from("event_orders").delete().in("event_id", eventIds));
  }
  await step("clients", () => admin.from("clients").delete().eq("studio_id", fixture.studioId));
  await step("notifications", () => admin.from("notifications").delete().eq("studio_id", fixture.studioId));
  await step("payment exceptions", () => admin.from("event_order_settlement_exceptions").delete().eq("studio_id", fixture.studioId));
  await step("outbound_deliveries", () => admin.from("outbound_deliveries").delete().eq("studio_id", fixture.studioId));
  await step("usage_addon_entitlements", () => admin.from("usage_addon_entitlements").delete().eq("studio_id", fixture.studioId));
  await step("studio_subscriptions", () => admin.from("studio_subscriptions").delete().eq("studio_id", fixture.studioId));
  await step("user_studio_roles", () => admin.from("user_studio_roles").delete().eq("studio_id", fixture.studioId));
  await step("studios", () => admin.from("studios").delete().eq("id", fixture.studioId));
  if (fixture.createdPlan) {
    const { count } = await admin.from("studio_subscriptions").select("id", { count: "exact", head: true }).eq("subscription_plan_id", fixture.planId);
    if (!count) await step("subscription_plans", () => admin.from("subscription_plans").delete().eq("id", fixture.planId));
  }
  for (const account of [fixture.owner, ...fixture.judges, ...fixture.dancers]) {
    if (!account.id) continue;
    await step(`profile ${account.email}`, () => admin.from("profiles").delete().eq("id", account.id));
    const { error } = await admin.auth.admin.deleteUser(account.id);
    if (error) failures.push(`auth user ${account.email}: ${error.message}`);
  }
  const { data: studioLeft } = await admin.from("studios").select("id").eq("id", fixture.studioId).maybeSingle();
  if (studioLeft) failures.push("studio row still present");
  if (failures.length) throw new Error(`Competition full-event fixture cleanup incomplete: ${failures.join("; ")}`);
}
