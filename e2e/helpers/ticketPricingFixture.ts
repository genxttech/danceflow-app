import { randomBytes, randomUUID } from "node:crypto";
import type { E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient, type CompetitionAccount } from "./competitionFixture";

/**
 * CI-A early-bird pricing E2E fixtures. Run-scoped (random ids/slugs/accounts) and deleted in afterAll.
 * Every event requires one waiver, so a cart checkout stores the order and its price snapshots and then redirects to
 * document signing BEFORE any Stripe call: no Stripe request is ever made by these tests (no real or test charge).
 * The studio's Stripe Connect account id is a placeholder.
 */

export type TicketPricingFixture = {
  runId: string;
  studioId: string;
  owner: CompetitionAccount;
  templateId: string;
  events: Record<"early" | "expired" | "race" | "editor", { id: string; slug: string; name: string }>;
  tickets: { earlyBird: string; regular: string; expired: string; race: string; editor: string };
};

async function must<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`Ticket pricing E2E fixture: ${what}: ${error.message}`);
  return data as T;
}

export async function createTicketPricingFixture(config: E2EConfig, options: { raceCutoffIso: string }): Promise<TicketPricingFixture> {
  const admin = e2eAdminClient(config);
  const runId = randomBytes(4).toString("hex");
  const studioId = randomUUID();
  const email = `e2e-price-${runId}-owner@e2e.test`;
  const password = randomBytes(18).toString("base64url");
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !created.user) throw new Error(`Ticket pricing E2E fixture: owner: ${error?.message}`);
  const owner = { id: created.user.id, email, password };

  await must(admin.from("profiles").upsert({ id: owner.id, email, full_name: "E2E Pricing Owner" }), "profile");
  await must(admin.from("studios").insert({
    id: studioId, name: `E2E Pricing Studio ${runId}`, slug: `e2e-price-${runId}`, subscription_status: "active", billing_plan: "pro",
    stripe_connected_account_id: "acct_e2e_placeholder_not_real", stripe_connect_charges_enabled: true,
    stripe_connect_payouts_enabled: true, stripe_connect_onboarding_complete: true,
  }), "studio");
  await must(admin.from("user_studio_roles").insert({ user_id: owner.id, studio_id: studioId, role: "studio_owner", active: true }), "role");
  // Studio ticketing (the ticket editor) needs the Organizer Suite add-on on top of the pro plan.
  await must(admin.from("usage_addon_entitlements").insert({
    studio_id: studioId, workspace_type: "studio", feature_key: "organizer_suite", quantity_included: 1, source: "manual_grant",
    status: "active", notes: "CI-A pricing E2E fixture",
  }), "organizer suite entitlement");

  const templateId = randomUUID();
  await must(admin.from("document_templates").insert({
    id: templateId, studio_id: studioId, organizer_id: null, scope: "studio", document_type: "waiver",
    title: `E2E Pricing Waiver ${runId}`, description: "Synthetic waiver for the CI-A pricing E2E only.",
    body: "Synthetic document used only by the CI-A pricing E2E. No legal content.", applies_to: "manual",
    requires_signature: true, is_required: false, is_active: true, current_version: 1,
  }), "template");

  const base = {
    studio_id: studioId, organizer_id: null, event_type: "special_event", status: "published", visibility: "public",
    start_date: "2027-06-05", end_date: "2027-06-05", start_time: "19:00", end_time: "22:00", timezone: "America/Chicago",
    venue_name: "E2E Hall", city: "Austin", state: "TX", registration_required: true, account_required_for_registration: false,
    registration_opens_at: null, registration_closes_at: null,
  };
  const event = (key: string, name: string) => ({ ...base, id: randomUUID(), slug: `e2e-price-${runId}-${key}`, name: `${name} ${runId}` });
  const events = { early: event("early", "E2E Early Bird"), expired: event("expired", "E2E Expired Early Bird"), race: event("race", "E2E Cutoff Race"), editor: event("editor", "E2E Ticket Editor") };
  await must(admin.from("events").insert(Object.values(events)), "events");
  await must(admin.from("event_document_requirements").insert(Object.values(events).map((e) => ({
    id: randomUUID(), event_id: e.id, studio_id: studioId, organizer_id: null, template_id: templateId, template_version_id: null, is_required: true, active: true,
  }))), "document requirements");

  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const ticket = (eventId: string, name: string, extra: Record<string, unknown>) => ({
    id: randomUUID(), event_id: eventId, name, description: null, ticket_kind: "general_admission", currency: "USD", capacity: null,
    active: true, sort_order: 0, sale_starts_at: null, sale_ends_at: null, attendees_per_ticket: 1, early_bird_enabled: false,
    early_bird_price: null, early_bird_ends_at: null, ...extra,
  });
  const rows = {
    earlyBird: ticket(events.early.id, "Early Bird Pass", { price: 40, early_bird_enabled: true, early_bird_price: 30, early_bird_ends_at: future, sort_order: 1 }),
    regular: ticket(events.early.id, "Regular Pass", { price: 25, sort_order: 2 }),
    expired: ticket(events.expired.id, "Expired Early Bird Pass", { price: 40, early_bird_enabled: true, early_bird_price: 30, early_bird_ends_at: past }),
    race: ticket(events.race.id, "Cutoff Race Pass", { price: 40, early_bird_enabled: true, early_bird_price: 30, early_bird_ends_at: options.raceCutoffIso }),
    editor: ticket(events.editor.id, "Editor Pass", { price: 40 }),
  };
  await must(admin.from("event_ticket_types").insert(Object.values(rows)), "ticket types");

  return {
    runId, studioId, owner, templateId,
    events: Object.fromEntries(Object.entries(events).map(([k, e]) => [k, { id: e.id, slug: e.slug, name: e.name }])) as TicketPricingFixture["events"],
    tickets: Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.id])) as TicketPricingFixture["tickets"],
  };
}

export async function readOrdersForEvent(config: E2EConfig, eventId: string) {
  const admin = e2eAdminClient(config);
  const orders = await must(admin.from("event_orders").select("id, total_amount, subtotal_amount, status").eq("event_id", eventId), "orders");
  const items = await must(admin.from("event_order_items").select("order_id, ticket_type_id, quantity, unit_price, total_price, metadata").eq("event_id", eventId), "items");
  const registrations = await must(admin.from("event_registrations").select("ticket_type_id, quantity, unit_price, total_price").eq("event_id", eventId), "registrations");
  return { orders: orders ?? [], items: items ?? [], registrations: registrations ?? [] };
}

export async function readTicket(config: E2EConfig, ticketId: string) {
  const admin = e2eAdminClient(config);
  type TicketRow = { price: number | string | null; early_bird_enabled: boolean | null; early_bird_price: number | string | null; early_bird_ends_at: string | null };
  const row = await must<TicketRow>(admin.from("event_ticket_types").select("price, early_bird_enabled, early_bird_price, early_bird_ends_at").eq("id", ticketId).single(), "ticket");
  if (!row) throw new Error(`Ticket pricing E2E fixture: ticket ${ticketId} not found`);
  return row;
}

export async function cleanupTicketPricingFixture(config: E2EConfig, fixture: TicketPricingFixture | undefined) {
  if (!fixture) return;
  const admin = e2eAdminClient(config);
  const eventIds = Object.values(fixture.events).map((e) => e.id);
  await admin.from("event_orders").delete().in("event_id", eventIds);
  await admin.from("events").delete().in("id", eventIds);
  await admin.from("document_templates").delete().eq("id", fixture.templateId);
  await admin.from("usage_addon_entitlements").delete().eq("studio_id", fixture.studioId);
  await admin.from("user_studio_roles").delete().eq("studio_id", fixture.studioId);
  await admin.from("studios").delete().eq("id", fixture.studioId);
  await admin.from("profiles").delete().eq("id", fixture.owner.id);
  await admin.auth.admin.deleteUser(fixture.owner.id);
}
