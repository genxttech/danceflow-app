import { execFileSync } from "node:child_process";
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
  /** A second manager of the same studio (studio_admin): the second desk in the duplicate/concurrent check-in scenarios. */
  deskAdmin: CompetitionAccount;
  /** Another studio and its owner: the tenant-isolation scenarios (refund and scratch pages must 404 for them). */
  otherStudioId: string;
  otherOwner: CompetitionAccount;
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
    deskAdmin: { id: "", email: `e2e-compfull-${runId}-desk@e2e.test`, password: password() },
    otherStudioId: randomUUID(),
    otherOwner: { id: "", email: `e2e-compfull-${runId}-other@e2e.test`, password: password() },
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
    await create(fixture.deskAdmin, "E2E Full Competition Desk Admin");
    await must(admin.from("user_studio_roles").insert({ user_id: fixture.deskAdmin.id, studio_id: fixture.studioId, role: "studio_admin", active: true }), "desk admin role");
    // A second, unrelated studio (plain Pro; no events) with its own owner.
    await must(admin.from("studios").insert({
      id: fixture.otherStudioId, name: `E2E Other Studio ${runId}`, slug: `e2e-compfull-${runId}-other`, subscription_status: "active", billing_plan: "pro",
    }), "other studio");
    await must(admin.from("studio_subscriptions").insert({ studio_id: fixture.otherStudioId, subscription_plan_id: fixture.planId, status: "active" }), "other subscription");
    await create(fixture.otherOwner, "E2E Other Studio Owner");
    await must(admin.from("user_studio_roles").insert({ user_id: fixture.otherOwner.id, studio_id: fixture.otherStudioId, role: "studio_owner", active: true }), "other owner role");
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

/**
 * R2 made the refund ledger append-only for every API role (COMP_REFUND_LEDGER_IMMUTABLE), so the service-role client cannot
 * remove a test run's refund rows or SC1 scratch audit rows -- both are append-only by design. On a throwaway LOCAL QA database a run clears its own rows through the
 * database container with replication triggers off (the documented pattern for this repo's other append-only test evidence).
 * Needs E2E_LOCAL_DB_CONTAINER=supabase_db_<project>; refuses anything else. Only this run's event ids (UUIDs) are touched.
 */
async function purgeRefundLedgerLocal(eventIds: string[]): Promise<{ error: { message: string } | null }> {
  const container = process.env.E2E_LOCAL_DB_CONTAINER ?? "";
  if (!/^supabase_db_[a-z0-9-]+$/.test(container)) {
    return { error: { message: "refund ledger rows are immutable through the API; set E2E_LOCAL_DB_CONTAINER=supabase_db_<local project> so the run can clear its own rows on the local QA database" } };
  }
  if (!eventIds.every((id) => /^[0-9a-f-]{36}$/.test(id))) return { error: { message: "refusing: malformed event id" } };
  const list = eventIds.map((id) => `'${id}'`).join(",");
  // CF1-C harness copy: (1) delete the events themselves as an ordinary session. CF1's history guards (ENABLE ALWAYS) refuse row-by-row
  // deletes of advancement evidence, and allow only the cascade of deleting the event; (2) the legacy per-table purge under replication
  // triggers off, tolerant of tables a chain does not have (R2's refund ledger is not in every composed chain). Limitation: R2 #292 absent.
  const cascade = `delete from public.events where id in (${list});`;
  const legacy = `begin; set local session_replication_role = replica; delete from public.events where id in (${list}); do $$ begin if to_regclass('public.event_order_refund_allocations') is not null then delete from public.event_order_refund_allocations where event_id in (${list}); end if; if to_regclass('public.event_order_refunds') is not null then delete from public.event_order_refunds where event_id in (${list}); end if; if to_regclass('public.event_competition_scratches') is not null then delete from public.event_competition_scratches where event_id in (${list}); end if; end $$; do $$ declare t text; begin for t in select c.table_name from information_schema.columns c where c.table_schema = 'public' and c.column_name = 'event_id' and c.table_name like 'event\\_competition\\_%' loop execute format('delete from public.%I where event_id = any(%L::uuid[])', t, '{${eventIds.join(",")}}'); end loop; end $$; commit;`;
  const run = (sql: string) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: "pipe" });
  try {
    try {
      run(cascade);
    } catch {
      run(legacy);
    }
    return { error: null };
  } catch (error) {
    const text = String((error as { stderr?: Buffer }).stderr ?? (error as Error).message);
    return { error: { message: `local ledger cleanup failed: ${text.split(String.fromCharCode(10)).slice(0, 3).join(" / ")}` } };
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
  let allRegistrationIds: string[] = [];
  if (eventIds.length) {
    const { data: regs, error: regsError } = await admin.from("event_registrations").select("id").in("event_id", eventIds);
    if (regsError) failures.push(`registrations lookup: ${regsError.message}`);
    const regIds = (regs ?? []).map((row) => row.id as string);
    allRegistrationIds = regIds;
    if (regIds.length) await step("event_payments", () => admin.from("event_payments").delete().in("registration_id", regIds));
    // R2 refund evidence is ON DELETE RESTRICT (financial history); the run's own rows go first, allocations before refunds.
    await step("refund ledger", async () => purgeRefundLedgerLocal(eventIds));
    await step("registration client links", () => admin.from("event_registrations").update({ client_id: null }).in("event_id", eventIds));
    // The event goes first: its cascade removes the competition rows together, and the published-running-order and
    // entry/order-item guards allow that only once the event itself is gone. Orders are then a safety net.
    await step("events", () => admin.from("events").delete().in("id", eventIds));
    await step("event_orders", () => admin.from("event_orders").delete().in("event_id", eventIds));
  }
  for (const studioId of [fixture.studioId, fixture.otherStudioId]) await step("clients", () => admin.from("clients").delete().eq("studio_id", studioId));
  await step("notifications", () => admin.from("notifications").delete().eq("studio_id", fixture.studioId));
  await step("payment exceptions", () => admin.from("event_order_settlement_exceptions").delete().eq("studio_id", fixture.studioId));
  await step("outbound_deliveries", () => admin.from("outbound_deliveries").delete().eq("studio_id", fixture.studioId));
  await step("usage_addon_entitlements", () => admin.from("usage_addon_entitlements").delete().eq("studio_id", fixture.studioId));
  for (const studioId of [fixture.studioId, fixture.otherStudioId]) {
    await step("studio_subscriptions", () => admin.from("studio_subscriptions").delete().eq("studio_id", studioId));
    await step("user_studio_roles", () => admin.from("user_studio_roles").delete().eq("studio_id", studioId));
    await step("studios", () => admin.from("studios").delete().eq("id", studioId));
  }
  if (fixture.createdPlan) {
    const { count } = await admin.from("studio_subscriptions").select("id", { count: "exact", head: true }).eq("subscription_plan_id", fixture.planId);
    if (!count) await step("subscription_plans", () => admin.from("subscription_plans").delete().eq("id", fixture.planId));
  }
  for (const account of [fixture.owner, fixture.deskAdmin, fixture.otherOwner, ...fixture.judges, ...fixture.dancers]) {
    if (!account.id) continue;
    await step(`profile ${account.email}`, () => admin.from("profiles").delete().eq("id", account.id));
    const { error } = await admin.auth.admin.deleteUser(account.id);
    if (error) failures.push(`auth user ${account.email}: ${error.message}`);
  }
  // Zero leftovers: every row the run could have created, looked up again by the run's ids.
  const left = async (what: string, run: () => PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count, error } = await run();
    if (error) failures.push(`leftover check ${what}: ${error.message}`);
    else if (count) failures.push(`${what}: ${count} row(s) left`);
  };
  const studioIds = [fixture.studioId, fixture.otherStudioId];
  await left("studios", () => admin.from("studios").select("id", { count: "exact", head: true }).in("id", studioIds));
  await left("events", () => admin.from("events").select("id", { count: "exact", head: true }).in("studio_id", studioIds));
  await left("event_orders", () => admin.from("event_orders").select("id", { count: "exact", head: true }).in("studio_id", studioIds));
  if (allRegistrationIds.length) await left("event_payments", () => admin.from("event_payments").select("id", { count: "exact", head: true }).in("registration_id", allRegistrationIds));
  await left("accounting_entries", () => admin.from("accounting_entries").select("id", { count: "exact", head: true }).in("studio_id", studioIds));
  await left("user_studio_roles", () => admin.from("user_studio_roles").select("user_id", { count: "exact", head: true }).in("studio_id", studioIds));
  if (eventIds.length) {
    for (const table of ["event_order_refunds", "event_order_refund_allocations", "event_competition_scratches", "event_competition_entries", "event_competition_checkin_sessions", "event_competition_fee_rules"]) {
      await left(table, () => admin.from(table).select("id", { count: "exact", head: true }).in("event_id", eventIds));
    }
  }
  const accountIds = [fixture.owner, fixture.deskAdmin, fixture.otherOwner, ...fixture.judges, ...fixture.dancers].map((a) => a.id).filter(Boolean);
  if (accountIds.length) await left("profiles", () => admin.from("profiles").select("id", { count: "exact", head: true }).in("id", accountIds));
  if (failures.length) throw new Error(`Competition full-event fixture cleanup incomplete: ${failures.join("; ")}`);
}
