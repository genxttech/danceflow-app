import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { E2EConfig } from "@/lib/e2e/config";
import { E2ESafetyError } from "@/lib/e2e/guards";

/**
 * Phase 10C.5 Competition setup E2E fixtures. Everything is run-scoped (random ids, slugs and test accounts), so
 * runs never share or touch real studio records, and cleanup deletes exactly what this run created. Events cascade
 * to every competition row; the studio, roles, profiles and auth users are removed explicitly.
 *
 * The test accounts are created with the service-role key against the E2E Supabase target only, which
 * loadE2EConfig has already validated (loopback or an explicitly allowlisted non-production host; the production
 * project is hard-blocked). No real Stripe account is attached to the studio, and no test opens registration
 * unless it closes and deletes it again.
 */

export type CompetitionAccount = { id: string; email: string; password: string };
export type CompetitionEvent = { id: string; slug: string; name: string };

export type CompetitionFixture = {
  runId: string;
  studioId: string;
  owner: CompetitionAccount;
  instructor: CompetitionAccount;
  events: {
    ticketsOn: CompetitionEvent;
    ticketsOff: CompetitionEvent;
    multiDance: CompetitionEvent;
    legacyV2: CompetitionEvent;
    operations: CompetitionEvent;
    presentation: CompetitionEvent;
  };
  legacyV2ProgramId: string;
};

/** The event fields ordinary ticket registration depends on, plus updated_at (any write to the row changes it). */
export const EVENT_REGISTRATION_FIELDS =
  "registration_required, account_required_for_registration, registration_opens_at, registration_closes_at, updated_at";

export function e2eAdminClient(config: E2EConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function must<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`Competition E2E fixture: ${what}: ${error.message}`);
  return data as T;
}

export async function createCompetitionFixture(config: E2EConfig): Promise<CompetitionFixture> {
  const admin = e2eAdminClient(config);
  const runId = randomBytes(4).toString("hex");
  const studioId = randomUUID();

  // The rules profiles are reference data seeded by the migrations; a target without them is not migrated.
  const profiles = await must(admin.from("competition_rules_profiles").select("version, status").eq("profile_key", "studio_simple"), "profiles");
  if (!profiles?.some((row) => row.version === 3 && row.status === "active")) {
    throw new E2ESafetyError("The E2E Supabase target has no active studio_simple@3 profile (20261114090000 is not applied).");
  }

  async function account(role: string): Promise<CompetitionAccount> {
    const email = `e2e-comp-${runId}-${role}@e2e.test`;
    const password = randomBytes(18).toString("base64url");
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`Competition E2E fixture: account ${role}: ${error?.message}`);
    return { id: data.user.id, email, password };
  }
  const owner = await account("owner");
  const instructor = await account("instructor");

  await must(admin.from("profiles").upsert([
    { id: owner.id, email: owner.email, full_name: "E2E Competition Owner" },
    { id: instructor.id, email: instructor.email, full_name: "E2E Competition Instructor" },
  ]), "profiles");
  await must(admin.from("studios").insert({ id: studioId, name: `E2E Competition Studio ${runId}`, slug: `e2e-comp-${runId}`, subscription_status: "active" }), "studio");
  await must(admin.from("user_studio_roles").insert([
    { user_id: owner.id, studio_id: studioId, role: "studio_owner", active: true },
    { user_id: instructor.id, studio_id: studioId, role: "instructor", active: true },
  ]), "roles");

  const base = {
    studio_id: studioId, event_type: "competition", start_date: "2027-03-06", end_date: "2027-03-07", start_time: "18:00", end_time: "22:00",
    timezone: "America/Chicago", venue_name: "E2E Hall", city: "Austin", state: "TX", status: "published", visibility: "public",
  };
  const make = (key: string, name: string, registration: Record<string, unknown>) => ({
    row: { ...base, ...registration, id: randomUUID(), slug: `e2e-comp-${runId}-${key}`, name: `${name} ${runId}` },
  });
  const ticketsOff = { registration_required: false, account_required_for_registration: true, registration_opens_at: null, registration_closes_at: null };
  const defs = {
    ticketsOn: make("on", "E2E Tickets On", { registration_required: true, account_required_for_registration: false,
      registration_opens_at: "2026-01-01T06:00:00Z", registration_closes_at: "2031-01-01T06:00:00Z" }),
    ticketsOff: make("off", "E2E Tickets Off", ticketsOff),
    multiDance: make("multi", "E2E Multi-Dance", ticketsOff),
    legacyV2: make("v2", "E2E Legacy v2", { registration_required: true, account_required_for_registration: true, registration_opens_at: null, registration_closes_at: null }),
    operations: make("ops", "E2E Operations", ticketsOff),
    presentation: make("page", "E2E Presentation", { registration_required: true, account_required_for_registration: false,
      registration_opens_at: "2026-01-01T06:00:00Z", registration_closes_at: "2031-01-01T06:00:00Z" }),
  };
  await must(admin.from("events").insert(Object.values(defs).map((def) => def.row)), "events");
  await must(admin.from("event_ticket_types").insert([defs.ticketsOn, defs.ticketsOff, defs.presentation].map((def) => ({
    event_id: def.row.id, name: "Spectator", price: 25, capacity: 100, active: true,
  }))), "ticket types");

  // A studio_simple@2 program, standing in for drafts created before v3 (the DEV walkthrough draft). It is written
  // directly because create_competition_draft no longer accepts v2 for new setups.
  const legacyV2ProgramId = randomUUID();
  await must(admin.from("event_competition_programs").insert({
    id: legacyV2ProgramId, event_id: defs.legacyV2.row.id, studio_id: studioId, name: "Legacy v2 Program", discipline_family: "country",
    competition_mode: "relative", scoring_method: "ordinal_majority", rules_profile_key: "studio_simple", rules_profile_version: 2, status: "draft",
    configuration: { setup: { purpose: "competition", program_key: "country" } },
  }), "legacy v2 program");

  const events = Object.fromEntries(Object.entries(defs).map(([key, def]) => [key, { id: def.row.id, slug: def.row.slug, name: def.row.name }])) as CompetitionFixture["events"];
  return { runId, studioId, owner, instructor, events, legacyV2ProgramId };
}

export async function cleanupCompetitionFixture(config: E2EConfig, fixture: CompetitionFixture | undefined) {
  if (!fixture) return;
  const admin = e2eAdminClient(config);
  const eventIds = Object.values(fixture.events).map((event) => event.id);
  // Events cascade to tickets and every competition row (programs, categories, divisions, rules, locks).
  await admin.from("events").delete().in("id", eventIds);
  await admin.from("user_studio_roles").delete().eq("studio_id", fixture.studioId);
  await admin.from("studios").delete().eq("id", fixture.studioId);
  await admin.from("profiles").delete().in("id", [fixture.owner.id, fixture.instructor.id]);
  for (const account of [fixture.owner, fixture.instructor]) await admin.auth.admin.deleteUser(account.id);
}

export type EventRegistrationState = {
  registration_required: boolean;
  account_required_for_registration: boolean;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  updated_at: string;
};

export async function readEventRegistration(config: E2EConfig, eventId: string) {
  const admin = e2eAdminClient(config);
  const event = await must<EventRegistrationState>(admin.from("events").select(EVENT_REGISTRATION_FIELDS).eq("id", eventId).single(), "event");
  const tickets = await must(admin.from("event_ticket_types").select("id, name, price, capacity, active, sale_starts_at, sale_ends_at, updated_at").eq("event_id", eventId).order("id"), "tickets");
  return { event, tickets };
}

export async function readPrograms(config: E2EConfig, eventId: string) {
  const admin = e2eAdminClient(config);
  return must(admin.from("event_competition_programs").select("*").eq("event_id", eventId).order("created_at"), "programs");
}
