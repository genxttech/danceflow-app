import { randomBytes, randomUUID } from "node:crypto";
import type { E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient, type CompetitionAccount } from "./competitionFixture";

/**
 * CI-A Stripe TEST-MODE checkout fixtures (isolated local QA Supabase only). Run-scoped studio with an existing Stripe
 * TEST connected account, an organizer listing (so the DanceFlow application fee applies: Pro + Organizer Suite = 3%),
 * and one studio-hosted event (no application fee). Deleted in afterAll.
 */

export type StripeTestModeFixture = {
  runId: string;
  studioId: string;
  organizerId: string;
  planId: string;
  createdPlan: boolean;
  templateId: string;
  student: CompetitionAccount;
  events: Record<"orgEarly" | "orgExpired" | "studioRace" | "orgDocs" | "orgNative", { id: string; slug: string; name: string }>;
  tickets: { earlyBird: string; regular: string; expired: string; race: string; docs: string; native: string };
};

async function must<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`Stripe test-mode fixture: ${what}: ${error.message}`);
  return data as T;
}

export async function createStripeTestModeFixture(config: E2EConfig, options: { connectedAccountId: string }): Promise<StripeTestModeFixture> {
  if (!/^acct_[A-Za-z0-9]+$/.test(options.connectedAccountId)) throw new Error("Stripe test-mode fixture: invalid connected account id");
  const admin = e2eAdminClient(config);
  const runId = randomBytes(4).toString("hex");
  const studioId = randomUUID();

  const existingPlan = await must<{ id: string } | null>(admin.from("subscription_plans").select("id").eq("code", "pro").maybeSingle(), "plan lookup");
  let planId = existingPlan?.id ?? "";
  const createdPlan = !existingPlan;
  if (createdPlan) {
    planId = randomUUID();
    await must(admin.from("subscription_plans").insert({ id: planId, code: "pro", name: "Pro (E2E)", active: true }), "plan");
  }

  await must(admin.from("studios").insert({
    id: studioId, name: `E2E Stripe Studio ${runId}`, slug: `e2e-stripe-${runId}`, subscription_status: "active", billing_plan: "pro",
    stripe_connected_account_id: options.connectedAccountId, stripe_connect_charges_enabled: true,
    stripe_connect_payouts_enabled: true, stripe_connect_onboarding_complete: true,
  }), "studio");
  await must(admin.from("studio_subscriptions").insert({ studio_id: studioId, subscription_plan_id: planId, status: "active" }), "subscription");
  await must(admin.from("usage_addon_entitlements").insert({
    studio_id: studioId, workspace_type: "studio", feature_key: "organizer_suite", quantity_included: 1, source: "manual_grant",
    status: "active", notes: "CI-A Stripe test-mode E2E fixture",
  }), "organizer suite entitlement");
  const organizerId = randomUUID();
  await must(admin.from("organizers").insert({ id: organizerId, studio_id: studioId, name: `E2E Stripe Organizer ${runId}`, slug: `e2e-stripe-org-${runId}`, subscription_status: "active" }), "organizer");

  const templateId = randomUUID();
  await must(admin.from("document_templates").insert({
    id: templateId, studio_id: studioId, organizer_id: null, scope: "studio", document_type: "waiver",
    title: `E2E Stripe Waiver ${runId}`, description: "Synthetic waiver for the CI-A Stripe test-mode E2E only.",
    body: "Synthetic document used only by the CI-A Stripe test-mode E2E. No legal content.", applies_to: "manual",
    requires_signature: true, is_required: false, is_active: true, current_version: 1,
  }), "template");

  const base = {
    studio_id: studioId, event_type: "special_event", status: "published", visibility: "public", public_directory_enabled: true,
    start_date: "2027-06-05", end_date: "2027-06-05", start_time: "19:00", end_time: "22:00", timezone: "America/Chicago",
    venue_name: "E2E Hall", city: "Austin", state: "TX", registration_required: true, account_required_for_registration: false,
    registration_opens_at: null, registration_closes_at: null,
  };
  const event = (key: string, name: string, organizer: boolean) => ({ ...base, organizer_id: organizer ? organizerId : null, id: randomUUID(), slug: `e2e-stripe-${runId}-${key}`, name: `${name} ${runId}` });
  const events = {
    orgEarly: event("org-early", "E2E Stripe Early Bird", true),
    orgExpired: event("org-expired", "E2E Stripe Expired", true),
    studioRace: event("studio-race", "E2E Stripe Cutoff Race", false),
    orgDocs: event("org-docs", "E2E Stripe Waiver Event", true),
    orgNative: event("org-native", "E2E Stripe Native", true),
  };
  await must(admin.from("events").insert(Object.values(events)), "events");
  await must(admin.from("event_document_requirements").insert({
    id: randomUUID(), event_id: events.orgDocs.id, studio_id: studioId, organizer_id: null, template_id: templateId, template_version_id: null, is_required: true, active: true,
  }), "document requirement");

  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const ticket = (eventId: string, name: string, extra: Record<string, unknown>) => ({
    id: randomUUID(), event_id: eventId, name, description: null, ticket_kind: "general_admission", currency: "USD", capacity: null,
    active: true, sort_order: 0, sale_starts_at: null, sale_ends_at: null, attendees_per_ticket: 1, early_bird_enabled: false,
    early_bird_price: null, early_bird_ends_at: null, ...extra,
  });
  const earlyBird = { price: 40, early_bird_enabled: true, early_bird_price: 30, early_bird_ends_at: future };
  const rows = {
    earlyBird: ticket(events.orgEarly.id, "Early Bird Pass", { ...earlyBird, sort_order: 1 }),
    regular: ticket(events.orgEarly.id, "Regular Pass", { price: 25, sort_order: 2 }),
    expired: ticket(events.orgExpired.id, "Expired Early Bird Pass", { ...earlyBird, early_bird_ends_at: past }),
    race: ticket(events.studioRace.id, "Cutoff Race Pass", earlyBird),
    docs: ticket(events.orgDocs.id, "Waiver Early Bird Pass", earlyBird),
    native: ticket(events.orgNative.id, "Native Early Bird Pass", earlyBird),
  };
  await must(admin.from("event_ticket_types").insert(Object.values(rows)), "ticket types");

  const studentEmail = `e2e-stripe-${runId}-student@example.com`;
  const password = randomBytes(18).toString("base64url");
  const { data: created, error } = await admin.auth.admin.createUser({ email: studentEmail, password, email_confirm: true });
  if (error || !created.user) throw new Error(`Stripe test-mode fixture: student: ${error?.message}`);
  await must(admin.from("profiles").upsert({ id: created.user.id, email: studentEmail, full_name: "E2E Native Student" }), "student profile");

  return {
    runId, studioId, organizerId, planId, createdPlan, templateId,
    student: { id: created.user.id, email: studentEmail, password },
    events: Object.fromEntries(Object.entries(events).map(([k, e]) => [k, { id: e.id, slug: e.slug, name: e.name }])) as StripeTestModeFixture["events"],
    tickets: Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.id])) as StripeTestModeFixture["tickets"],
  };
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

export async function cleanupStripeTestModeFixture(config: E2EConfig, fixture: StripeTestModeFixture | undefined) {
  if (!fixture) return;
  const admin = e2eAdminClient(config);
  const eventIds = Object.values(fixture.events).map((e) => e.id);
  const { data: regs } = await admin.from("event_registrations").select("id").in("event_id", eventIds);
  const regIds = (regs ?? []).map((row) => row.id as string);
  if (regIds.length) await admin.from("event_payments").delete().in("registration_id", regIds);
  await admin.from("organizer_contact_registrations").delete().eq("organizer_id", fixture.organizerId);
  await admin.from("organizer_contacts").delete().eq("organizer_id", fixture.organizerId);
  await admin.from("event_registrations").update({ client_id: null }).in("event_id", eventIds);
  await admin.from("event_orders").delete().in("event_id", eventIds);
  await admin.from("clients").delete().eq("studio_id", fixture.studioId);
  await admin.from("notifications").delete().eq("studio_id", fixture.studioId);
  await admin.from("events").delete().in("id", eventIds);
  await admin.from("document_templates").delete().eq("id", fixture.templateId);
  await admin.from("organizers").delete().eq("id", fixture.organizerId);
  await admin.from("usage_addon_entitlements").delete().eq("studio_id", fixture.studioId);
  await admin.from("studio_subscriptions").delete().eq("studio_id", fixture.studioId);
  await admin.from("studios").delete().eq("id", fixture.studioId);
  if (fixture.createdPlan) await admin.from("subscription_plans").delete().eq("id", fixture.planId);
  await admin.from("profiles").delete().eq("id", fixture.student.id);
  await admin.auth.admin.deleteUser(fixture.student.id);
}
