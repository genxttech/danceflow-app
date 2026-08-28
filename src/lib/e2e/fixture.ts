/**
 * Public Event Registration E2E Harness -- Slice 1.
 *
 * Real-Supabase fixture helpers for the controlled studio/event/ticket-type
 * scenario the E2E tests drive a browser through. Fixed, obviously-synthetic
 * UUIDs (prefixed "e2e00000" for easy identification/cleanup) rather than
 * random ones, so runs are deterministic and idempotent -- every row is
 * upserted by its fixed id, so re-running never fails on a duplicate-key
 * error and never accumulates duplicate fixture rows. This mirrors the
 * "fixed synthetic ids, not random" convention already used by the local-
 * Docker-staging seed_synthetic.sql fixtures for this codebase's real-
 * Postgres regression suites, but is self-contained: it creates its own
 * studio/event/ticket-type from scratch rather than depending on any other
 * seed script having already run, so it works against a freshly-migrated,
 * otherwise-empty Supabase instance.
 *
 * Slice 1's fixture deliberately has zero required event documents -- the
 * "0 required waivers" case. A later slice adds 1/2-required-document
 * variants (and the real Stripe-Connect-onboarded test account needed to
 * actually submit a checkout) without needing to change this module's
 * studio/event identity.
 */

import { createClient } from "@supabase/supabase-js";
import type { E2EConfig } from "@/lib/e2e/config";

export const E2E_STUDIO_ID = "e2e00000-0000-4000-8000-000000000001";
export const E2E_EVENT_ID = "e2e00000-0000-4000-8000-000000000002";
export const E2E_TICKET_TYPE_ID = "e2e00000-0000-4000-8000-000000000003";

export const E2E_STUDIO_SLUG = "e2e-harness-test-studio";
export const E2E_EVENT_SLUG = "e2e-harness-test-event";
export const E2E_EVENT_NAME = "E2E Harness Test Event (auto-generated)";

export const E2E_ATTENDEE = {
  firstName: "E2E",
  lastName: "Harness",
  email: "e2e-harness-attendee@example.invalid",
} as const;

export type E2EPublicEventFixture = {
  studioId: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  ticketTypeId: string;
};

function adminClient(config: E2EConfig) {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Creates (or idempotently updates) the minimal studio/event/ticket-type
 * chain needed to reach the public registration form for an event with no
 * required documents. Placeholder Stripe Connect fields are set so a later
 * slice can extend this fixture to actually submit checkout without first
 * needing to revisit studio setup -- `stripe_connected_account_id` here is
 * a fake id, not a real Stripe test-mode account, so it is NOT sufficient
 * on its own to reach a real Stripe Checkout session.
 */
export async function establishE2EPublicEventFixture(
  config: E2EConfig,
): Promise<E2EPublicEventFixture> {
  const admin = adminClient(config);
  const now = Date.now();

  const { error: studioError } = await admin.from("studios").upsert(
    {
      id: E2E_STUDIO_ID,
      name: "E2E Harness Test Studio (auto-generated -- do not use for real bookings)",
      slug: E2E_STUDIO_SLUG,
      timezone: "America/New_York",
      billing_plan: "starter",
      subscription_status: "active",
      active: true,
      stripe_connected_account_id: "acct_e2e_harness_placeholder",
      stripe_connect_details_submitted: true,
      stripe_connect_charges_enabled: true,
      stripe_connect_payouts_enabled: true,
      stripe_connect_onboarding_complete: true,
    },
    { onConflict: "id" },
  );
  if (studioError) {
    throw new Error(`E2E fixture: failed to upsert studio -- ${studioError.message}`);
  }

  const { error: eventError } = await admin.from("events").upsert(
    {
      id: E2E_EVENT_ID,
      studio_id: E2E_STUDIO_ID,
      organizer_id: null,
      slug: E2E_EVENT_SLUG,
      name: E2E_EVENT_NAME,
      event_type: "workshop",
      status: "published",
      visibility: "public",
      public_directory_enabled: true,
      registration_required: true,
      account_required_for_registration: false,
      registration_opens_at: null,
      registration_closes_at: null,
      start_date: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(now + 7 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: "id" },
  );
  if (eventError) {
    throw new Error(`E2E fixture: failed to upsert event -- ${eventError.message}`);
  }

  const { error: ticketError } = await admin.from("event_ticket_types").upsert(
    {
      id: E2E_TICKET_TYPE_ID,
      event_id: E2E_EVENT_ID,
      name: "General Admission (E2E)",
      ticket_kind: "general_admission",
      price: 10,
      currency: "USD",
      active: true,
      capacity: null,
      sale_starts_at: null,
      sale_ends_at: null,
      attendees_per_ticket: 1,
    },
    { onConflict: "id" },
  );
  if (ticketError) {
    throw new Error(`E2E fixture: failed to upsert ticket type -- ${ticketError.message}`);
  }

  return {
    studioId: E2E_STUDIO_ID,
    eventId: E2E_EVENT_ID,
    eventSlug: E2E_EVENT_SLUG,
    eventName: E2E_EVENT_NAME,
    ticketTypeId: E2E_TICKET_TYPE_ID,
  };
}

/**
 * Deletes any event_registrations/event_orders created by a real form
 * submission against the fixture event -- not the studio/event/ticket-type
 * fixture rows themselves, which are reusable across runs. Safe to call
 * even if no such rows exist yet. Not needed by Slice 1's own test (which
 * never submits the form), but established now so a later slice that does
 * submit can keep reruns idempotent without first having to invent this.
 */
export async function resetE2ERegistrationData(config: E2EConfig): Promise<void> {
  const admin = adminClient(config);

  const { error: registrationsError } = await admin
    .from("event_registrations")
    .delete()
    .eq("event_id", E2E_EVENT_ID);
  if (registrationsError) {
    throw new Error(
      `E2E fixture: failed to reset registrations -- ${registrationsError.message}`,
    );
  }

  const { error: ordersError } = await admin
    .from("event_orders")
    .delete()
    .eq("event_id", E2E_EVENT_ID);
  if (ordersError) {
    throw new Error(`E2E fixture: failed to reset orders -- ${ordersError.message}`);
  }
}
