import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient, type CompetitionAccount } from "./competitionFixture";

/**
 * CI-A Stripe TEST-MODE checkout fixtures (isolated local QA Supabase only). Run-scoped studio with an existing Stripe
 * TEST connected account, an organizer listing (so the DanceFlow application fee applies: Pro + Organizer Suite = 3%),
 * and one studio-hosted event (no application fee).
 *
 * Every id is generated before anything is written, so cleanup can remove exactly this run's rows even when creation
 * fails part-way. Cleanup only ever deletes by this run's own ids, checks every delete, and throws listing anything it
 * could not remove.
 */

type EventKey = "orgEarly" | "orgExpired" | "studioRace" | "orgDocs" | "orgNative";

export type StripeTestModeFixture = {
  runId: string;
  studioId: string;
  organizerId: string;
  planId: string;
  createdPlan: boolean;
  templateId: string;
  student: CompetitionAccount;
  /** PAY-WH-1A: the studio owner (event manager) used for staff-side browser flows. */
  owner: CompetitionAccount;
  events: Record<EventKey, { id: string; slug: string; name: string }>;
  tickets: { earlyBird: string; regular: string; expired: string; race: string; docs: string; native: string };
};

const DOCUMENT_BUCKET = "document-files";

async function must<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`Stripe test-mode fixture: ${what}: ${error.message}`);
  return data as T;
}

export async function createStripeTestModeFixture(config: E2EConfig, options: { connectedAccountId: string }): Promise<StripeTestModeFixture> {
  if (!/^acct_[A-Za-z0-9]+$/.test(options.connectedAccountId)) throw new Error("Stripe test-mode fixture: invalid connected account id");
  const admin = e2eAdminClient(config);
  const runId = randomBytes(4).toString("hex");
  const eventDef = (key: string, name: string) => ({ id: randomUUID(), slug: `e2e-stripe-${runId}-${key}`, name: `${name} ${runId}` });
  const fixture: StripeTestModeFixture = {
    runId,
    studioId: randomUUID(),
    organizerId: randomUUID(),
    planId: randomUUID(),
    createdPlan: false,
    templateId: randomUUID(),
    student: { id: "", email: `e2e-stripe-${runId}-student@example.com`, password: randomBytes(18).toString("base64url") },
    owner: { id: "", email: `e2e-stripe-${runId}-owner@e2e.test`, password: randomBytes(18).toString("base64url") },
    events: {
      orgEarly: eventDef("org-early", "E2E Stripe Early Bird"),
      orgExpired: eventDef("org-expired", "E2E Stripe Expired"),
      studioRace: eventDef("studio-race", "E2E Stripe Cutoff Race"),
      orgDocs: eventDef("org-docs", "E2E Stripe Waiver Event"),
      orgNative: eventDef("org-native", "E2E Stripe Native"),
    },
    tickets: { earlyBird: randomUUID(), regular: randomUUID(), expired: randomUUID(), race: randomUUID(), docs: randomUUID(), native: randomUUID() },
  };

  try {
    const existingPlan = await must<{ id: string } | null>(admin.from("subscription_plans").select("id").eq("code", "pro").maybeSingle(), "plan lookup");
    if (existingPlan) {
      fixture.planId = existingPlan.id;
    } else {
      fixture.createdPlan = true;
      await must(admin.from("subscription_plans").insert({ id: fixture.planId, code: "pro", name: "Pro (E2E)", active: true }), "plan");
    }

    await must(admin.from("studios").insert({
      id: fixture.studioId, name: `E2E Stripe Studio ${runId}`, slug: `e2e-stripe-${runId}`, subscription_status: "active", billing_plan: "pro",
      stripe_connected_account_id: options.connectedAccountId, stripe_connect_charges_enabled: true,
      stripe_connect_payouts_enabled: true, stripe_connect_onboarding_complete: true,
    }), "studio");
    await must(admin.from("studio_subscriptions").insert({ studio_id: fixture.studioId, subscription_plan_id: fixture.planId, status: "active" }), "subscription");
    await must(admin.from("usage_addon_entitlements").insert({
      studio_id: fixture.studioId, workspace_type: "studio", feature_key: "organizer_suite", quantity_included: 1, source: "manual_grant",
      status: "active", notes: "CI-A Stripe test-mode E2E fixture",
    }), "organizer suite entitlement");
    await must(admin.from("organizers").insert({ id: fixture.organizerId, studio_id: fixture.studioId, name: `E2E Stripe Organizer ${runId}`, slug: `e2e-stripe-org-${runId}`, subscription_status: "active" }), "organizer");

    await must(admin.from("document_templates").insert({
      id: fixture.templateId, studio_id: fixture.studioId, organizer_id: null, scope: "studio", document_type: "waiver",
      title: `E2E Stripe Waiver ${runId}`, description: "Synthetic waiver for the CI-A Stripe test-mode E2E only.",
      body: "Synthetic document used only by the CI-A Stripe test-mode E2E. No legal content.", applies_to: "manual",
      requires_signature: true, is_required: false, is_active: true, current_version: 1,
    }), "template");

    const base = {
      studio_id: fixture.studioId, event_type: "special_event", status: "published", visibility: "public", public_directory_enabled: true,
      start_date: "2027-06-05", end_date: "2027-06-05", start_time: "19:00", end_time: "22:00", timezone: "America/Chicago",
      venue_name: "E2E Hall", city: "Austin", state: "TX", registration_required: true, account_required_for_registration: false,
      registration_opens_at: null, registration_closes_at: null,
    };
    const studioHosted = new Set<EventKey>(["studioRace"]);
    await must(admin.from("events").insert((Object.entries(fixture.events) as [EventKey, StripeTestModeFixture["events"][EventKey]][]).map(([key, e]) => ({
      ...base, ...e, organizer_id: studioHosted.has(key) ? null : fixture.organizerId,
    }))), "events");
    await must(admin.from("event_document_requirements").insert({
      id: randomUUID(), event_id: fixture.events.orgDocs.id, studio_id: fixture.studioId, organizer_id: null, template_id: fixture.templateId,
      template_version_id: null, is_required: true, active: true,
    }), "document requirement");

    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const ticket = (id: string, eventId: string, name: string, extra: Record<string, unknown>) => ({
      id, event_id: eventId, name, description: null, ticket_kind: "general_admission", currency: "USD", capacity: null,
      active: true, sort_order: 0, sale_starts_at: null, sale_ends_at: null, attendees_per_ticket: 1, early_bird_enabled: false,
      early_bird_price: null, early_bird_ends_at: null, ...extra,
    });
    const earlyBird = { price: 40, early_bird_enabled: true, early_bird_price: 30, early_bird_ends_at: future };
    const t = fixture.tickets;
    await must(admin.from("event_ticket_types").insert([
      ticket(t.earlyBird, fixture.events.orgEarly.id, "Early Bird Pass", { ...earlyBird, sort_order: 1 }),
      ticket(t.regular, fixture.events.orgEarly.id, "Regular Pass", { price: 25, sort_order: 2 }),
      ticket(t.expired, fixture.events.orgExpired.id, "Expired Early Bird Pass", { ...earlyBird, early_bird_ends_at: past }),
      ticket(t.race, fixture.events.studioRace.id, "Cutoff Race Pass", earlyBird),
      ticket(t.docs, fixture.events.orgDocs.id, "Waiver Early Bird Pass", earlyBird),
      ticket(t.native, fixture.events.orgNative.id, "Native Early Bird Pass", earlyBird),
    ]), "ticket types");

    const { data: created, error } = await admin.auth.admin.createUser({ email: fixture.student.email, password: fixture.student.password, email_confirm: true });
    if (error || !created.user) throw new Error(`Stripe test-mode fixture: student: ${error?.message}`);
    fixture.student.id = created.user.id;
    await must(admin.from("profiles").upsert({ id: fixture.student.id, email: fixture.student.email, full_name: "E2E Native Student" }), "student profile");

    const { data: createdOwner, error: ownerError } = await admin.auth.admin.createUser({ email: fixture.owner.email, password: fixture.owner.password, email_confirm: true });
    if (ownerError || !createdOwner.user) throw new Error(`Stripe test-mode fixture: owner: ${ownerError?.message}`);
    fixture.owner.id = createdOwner.user.id;
    await must(admin.from("profiles").upsert({ id: fixture.owner.id, email: fixture.owner.email, full_name: "E2E Studio Owner" }), "owner profile");
    await must(admin.from("user_studio_roles").insert({ user_id: fixture.owner.id, studio_id: fixture.studioId, role: "studio_owner", active: true }), "owner role");
    return fixture;
  } catch (error) {
    await cleanupStripeTestModeFixture(config, fixture).catch((cleanupError) => {
      console.error(`Stripe test-mode fixture: cleanup after failed creation was incomplete: ${(cleanupError as Error).message}`);
    });
    throw error;
  }
}

/**
 * A student session token, obtained in Node (never through the browser or Playwright's request context, so no key
 * ends up in a trace).
 */
export async function studentAccessToken(config: E2EConfig, fixture: StripeTestModeFixture) {
  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: fixture.student.email, password: fixture.student.password });
  if (error || !data.session) throw new Error(`Stripe test-mode fixture: student sign-in: ${error?.message}`);
  return data.session.access_token;
}

export async function readEventPurchase(config: E2EConfig, eventId: string) {
  const admin = e2eAdminClient(config);
  const orders = (await must<Record<string, unknown>[]>(admin.from("event_orders").select("id, buyer_email, status, payment_status, total_amount, subtotal_amount, stripe_checkout_session_id, stripe_payment_intent_id, paid_at").eq("event_id", eventId), "orders")) ?? [];
  const items = (await must<Record<string, unknown>[]>(admin.from("event_order_items").select("order_id, ticket_type_id, quantity, unit_price, total_price, metadata").eq("event_id", eventId), "items")) ?? [];
  const registrations = (await must<Record<string, unknown>[]>(admin.from("event_registrations").select("id, order_id, ticket_type_id, quantity, unit_price, total_price, status, payment_status").eq("event_id", eventId), "registrations")) ?? [];
  const registrationIds = registrations.map((row) => row.id as string);
  const payments = registrationIds.length
    ? ((await must<Record<string, unknown>[]>(admin.from("event_payments").select("registration_id, amount, status, stripe_payment_intent_id, stripe_application_fee_amount, platform_fee_amount, stripe_account_id").in("registration_id", registrationIds), "payments")) ?? [])
    : [];
  const attendees = registrationIds.length
    ? ((await must<Record<string, unknown>[]>(admin.from("event_registration_attendees").select("registration_id, ticket_code").in("registration_id", registrationIds), "attendees")) ?? [])
    : [];
  return { orders, items, registrations, payments, attendees };
}

/** Studio CRM leads and organizer contacts created for a buyer email (lead-capture policy evidence). */
export async function readCrmCapture(config: E2EConfig, fixture: StripeTestModeFixture, email: string) {
  const admin = e2eAdminClient(config);
  const clients = (await must<Record<string, unknown>[]>(admin.from("clients").select("id, status, referral_source").eq("studio_id", fixture.studioId).ilike("email", email), "clients")) ?? [];
  const contacts = (await must<Record<string, unknown>[]>(admin.from("organizer_contacts").select("id, source").eq("organizer_id", fixture.organizerId).ilike("email", email), "organizer contacts")) ?? [];
  const contactIds = contacts.map((row) => row.id as string);
  const links = contactIds.length
    ? ((await must<Record<string, unknown>[]>(admin.from("organizer_contact_registrations").select("registration_id, organizer_contact_id").in("organizer_contact_id", contactIds), "contact registrations")) ?? [])
    : [];
  return { clients, contacts, links };
}

/** Webhook idempotency ledger rows for Stripe event ids. */
export async function readProviderEvents(config: E2EConfig, eventIds: string[]) {
  return (await must<Record<string, unknown>[]>(e2eAdminClient(config).from("payment_provider_events").select("provider_event_id, event_type, status").eq("provider", "stripe").in("provider_event_id", eventIds), "provider events")) ?? [];
}

export async function setEarlyBirdCutoff(config: E2EConfig, ticketId: string, iso: string) {
  await must(e2eAdminClient(config).from("event_ticket_types").update({ early_bird_ends_at: iso }).eq("id", ticketId), "set cutoff");
}

/** Every object path under a storage prefix (the storage list API is one folder level at a time). */
async function listStoragePaths(admin: ReturnType<typeof e2eAdminClient>, prefix: string): Promise<string[]> {
  const { data, error } = await admin.storage.from(DOCUMENT_BUCKET).list(prefix, { limit: 1000 });
  if (error) throw new Error(`list ${prefix}: ${error.message}`);
  const paths: string[] = [];
  for (const entry of data ?? []) {
    const path = `${prefix}/${entry.name}`;
    if (entry.id) paths.push(path);
    else paths.push(...(await listStoragePaths(admin, path)));
  }
  return paths;
}

export async function cleanupStripeTestModeFixture(config: E2EConfig, fixture: StripeTestModeFixture | undefined) {
  if (!fixture) return;
  const admin = e2eAdminClient(config);
  const failures: string[] = [];
  const step = async (what: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) failures.push(`${what}: ${error.message}`);
  };
  const eventIds = Object.values(fixture.events).map((e) => e.id);

  const { data: regs, error: regsError } = await admin.from("event_registrations").select("id").in("event_id", eventIds);
  if (regsError) failures.push(`registrations lookup: ${regsError.message}`);
  const regIds = (regs ?? []).map((row) => row.id as string);
  if (regIds.length) await step("event_payments", () => admin.from("event_payments").delete().in("registration_id", regIds));
  // Signing artifacts (document_signatures.template_id is ON DELETE RESTRICT) and their stored files.
  await step("document_signed_files", () => admin.from("document_signed_files").delete().eq("studio_id", fixture.studioId));
  await step("document_signatures", () => admin.from("document_signatures").delete().eq("studio_id", fixture.studioId));
  try {
    const paths = await listStoragePaths(admin, `studios/${fixture.studioId}`);
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await admin.storage.from(DOCUMENT_BUCKET).remove(paths.slice(i, i + 100));
      if (error) failures.push(`storage remove: ${error.message}`);
    }
  } catch (error) {
    failures.push(`storage: ${(error as Error).message}`);
  }
  await step("organizer_contact_registrations", () => admin.from("organizer_contact_registrations").delete().eq("organizer_id", fixture.organizerId));
  await step("organizer_contacts", () => admin.from("organizer_contacts").delete().eq("organizer_id", fixture.organizerId));
  await step("registration client links", () => admin.from("event_registrations").update({ client_id: null }).in("event_id", eventIds));
  await step("event_orders", () => admin.from("event_orders").delete().in("event_id", eventIds));
  await step("clients", () => admin.from("clients").delete().eq("studio_id", fixture.studioId));
  await step("notifications", () => admin.from("notifications").delete().eq("studio_id", fixture.studioId));
  await step("events", () => admin.from("events").delete().in("id", eventIds));
  await step("document_templates", () => admin.from("document_templates").delete().eq("id", fixture.templateId));
  await step("organizers", () => admin.from("organizers").delete().eq("id", fixture.organizerId));
  await step("usage_addon_entitlements", () => admin.from("usage_addon_entitlements").delete().eq("studio_id", fixture.studioId));
  await step("studio_subscriptions", () => admin.from("studio_subscriptions").delete().eq("studio_id", fixture.studioId));
  await step("payment exceptions", () => admin.from("event_order_settlement_exceptions").delete().eq("studio_id", fixture.studioId));
  await step("outbound_deliveries", () => admin.from("outbound_deliveries").delete().eq("studio_id", fixture.studioId));
  await step("user_studio_roles", () => admin.from("user_studio_roles").delete().eq("studio_id", fixture.studioId));
  await step("studios", () => admin.from("studios").delete().eq("id", fixture.studioId));
  if (fixture.createdPlan) {
    // Shared row: remove it only if no other studio (e.g. an overlapping run) subscribes to it.
    const { count } = await admin.from("studio_subscriptions").select("id", { count: "exact", head: true }).eq("subscription_plan_id", fixture.planId);
    if (!count) await step("subscription_plans", () => admin.from("subscription_plans").delete().eq("id", fixture.planId));
  }
  if (fixture.owner?.id) {
    await step("owner profile", () => admin.from("profiles").delete().eq("id", fixture.owner.id));
    const { error } = await admin.auth.admin.deleteUser(fixture.owner.id);
    if (error) failures.push(`owner auth user: ${error.message}`);
  }
  if (fixture.student.id) {
    await step("profiles", () => admin.from("profiles").delete().eq("id", fixture.student.id));
    const { error } = await admin.auth.admin.deleteUser(fixture.student.id);
    if (error) failures.push(`auth user: ${error.message}`);
  }

  const { data: studioLeft } = await admin.from("studios").select("id").eq("id", fixture.studioId).maybeSingle();
  if (studioLeft) failures.push("studio row still present");
  if (failures.length) throw new Error(`Stripe test-mode fixture cleanup incomplete: ${failures.join("; ")}`);
}
