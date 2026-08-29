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
 * "0 required waivers" case. Slice 2 (below) adds the 1/2-required-document
 * variants, sharing the same studio.
 *
 * Slice 2 note on Stripe: `stripe_connected_account_id` here remains a fake
 * placeholder id, not a real Stripe Connect test-mode account -- creating a
 * real one is an explicit, separate, human-approved step (not done by this
 * fixture). Every event fixture is therefore reachable through the real
 * registration/signing/resume flow up to the point where the app attempts
 * the real Stripe call, which will fail with a genuine (if uninformative)
 * Stripe API rejection given the fake account id -- see e2e/README.md's
 * "Stripe boundary" section for exactly what this does and doesn't prove.
 */

import { createClient } from "@supabase/supabase-js";
import type { E2EConfig } from "@/lib/e2e/config";

export const E2E_STUDIO_ID = "e2e00000-0000-4000-8000-000000000001";
export const E2E_EVENT_ID = "e2e00000-0000-4000-8000-000000000002";
export const E2E_TICKET_TYPE_ID = "e2e00000-0000-4000-8000-000000000003";

export const E2E_STUDIO_SLUG = "e2e-harness-test-studio";
export const E2E_EVENT_SLUG = "e2e-harness-test-event";
export const E2E_EVENT_NAME = "E2E Harness Test Event (auto-generated)";

// -- Slice 2: 1-waiver and 2-waiver event fixtures, sharing the studio above.
export const E2E_EVENT_ONE_WAIVER_ID = "e2e00000-0000-4000-8000-000000000004";
export const E2E_TICKET_TYPE_ONE_WAIVER_ID = "e2e00000-0000-4000-8000-000000000005";
export const E2E_EVENT_TWO_WAIVER_ID = "e2e00000-0000-4000-8000-000000000006";
export const E2E_TICKET_TYPE_TWO_WAIVER_ID = "e2e00000-0000-4000-8000-000000000007";
export const E2E_DOCUMENT_TEMPLATE_A_ID = "e2e00000-0000-4000-8000-000000000008";
export const E2E_DOCUMENT_TEMPLATE_B_ID = "e2e00000-0000-4000-8000-000000000009";
export const E2E_DOCUMENT_REQUIREMENT_ONE_WAIVER_ID = "e2e00000-0000-4000-8000-00000000000a";
export const E2E_DOCUMENT_REQUIREMENT_TWO_WAIVER_A_ID = "e2e00000-0000-4000-8000-00000000000b";
export const E2E_DOCUMENT_REQUIREMENT_TWO_WAIVER_B_ID = "e2e00000-0000-4000-8000-00000000000c";

export const E2E_EVENT_ONE_WAIVER_SLUG = "e2e-harness-test-event-1-waiver";
export const E2E_EVENT_ONE_WAIVER_NAME = "E2E Harness Test Event -- 1 Waiver (auto-generated)";
export const E2E_EVENT_TWO_WAIVER_SLUG = "e2e-harness-test-event-2-waivers";
export const E2E_EVENT_TWO_WAIVER_NAME = "E2E Harness Test Event -- 2 Waivers (auto-generated)";

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

type AdminClient = ReturnType<typeof adminClient>;

/**
 * Shared by every fixture-establishing function below -- one studio, upserted
 * idempotently, backing all three event fixtures (0/1/2 waivers). Placeholder
 * Stripe Connect fields let the app's own readiness gate pass so the real
 * registration/signing/resume code paths run unmodified up to the actual
 * Stripe call -- `stripe_connected_account_id` here is a fake id, not a real
 * Stripe test-mode account, so it is NOT sufficient on its own to reach a
 * real Stripe Checkout session (see this file's top-of-file doc comment).
 */
async function upsertE2EStudio(admin: AdminClient): Promise<void> {
  const { error } = await admin.from("studios").upsert(
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
  if (error) {
    throw new Error(`E2E fixture: failed to upsert studio -- ${error.message}`);
  }
}

/**
 * Creates (or idempotently updates) the minimal studio/event/ticket-type
 * chain needed to reach the public registration form for an event with no
 * required documents.
 */
export async function establishE2EPublicEventFixture(
  config: E2EConfig,
): Promise<E2EPublicEventFixture> {
  const admin = adminClient(config);
  const now = Date.now();

  await upsertE2EStudio(admin);

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

async function upsertE2EEvent(
  admin: AdminClient,
  params: { id: string; slug: string; name: string },
): Promise<void> {
  const now = Date.now();
  const { error } = await admin.from("events").upsert(
    {
      id: params.id,
      studio_id: E2E_STUDIO_ID,
      organizer_id: null,
      slug: params.slug,
      name: params.name,
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
  if (error) {
    throw new Error(`E2E fixture: failed to upsert event "${params.slug}" -- ${error.message}`);
  }
}

async function upsertE2ETicketType(
  admin: AdminClient,
  params: { id: string; eventId: string; name: string },
): Promise<void> {
  const { error } = await admin.from("event_ticket_types").upsert(
    {
      id: params.id,
      event_id: params.eventId,
      name: params.name,
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
  if (error) {
    throw new Error(`E2E fixture: failed to upsert ticket type "${params.name}" -- ${error.message}`);
  }
}

async function upsertE2EDocumentTemplate(
  admin: AdminClient,
  params: { id: string; title: string },
): Promise<void> {
  const { error } = await admin.from("document_templates").upsert(
    {
      id: params.id,
      studio_id: E2E_STUDIO_ID,
      organizer_id: null,
      scope: "studio",
      document_type: "waiver",
      title: params.title,
      description: "Synthetic template used only by the Public Event Registration E2E harness.",
      body:
        "This is a synthetic document used only by the Public Event Registration E2E harness. " +
        "It has no real legal content and must never be presented to a real attendee.",
      applies_to: "manual",
      requires_signature: true,
      is_required: false,
      is_active: true,
      current_version: 1,
    },
    { onConflict: "id" },
  );
  if (error) {
    throw new Error(
      `E2E fixture: failed to upsert document template "${params.title}" -- ${error.message}`,
    );
  }
}

async function upsertE2EDocumentRequirement(
  admin: AdminClient,
  params: { id: string; eventId: string; templateId: string },
): Promise<void> {
  const { error } = await admin.from("event_document_requirements").upsert(
    {
      id: params.id,
      event_id: params.eventId,
      template_id: params.templateId,
      template_version_id: null,
      studio_id: E2E_STUDIO_ID,
      organizer_id: null,
      is_required: true,
      active: true,
    },
    { onConflict: "id" },
  );
  if (error) {
    throw new Error(`E2E fixture: failed to upsert document requirement -- ${error.message}`);
  }
}

export type E2EWaiverEventFixture = {
  studioId: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  ticketTypeId: string;
  /** In insertion order -- not necessarily the order the app itself returns
   * them in (event_document_requirements has no defined query ordering in
   * the checkout route), so tests must treat multi-waiver sequences as
   * order-agnostic, not assume this array's order matches the signing
   * sequence a real run will present. */
  documentRequirementIds: string[];
};

/**
 * Creates (or idempotently updates) one public paid event with exactly one
 * required document, and one with exactly two -- both sharing the same
 * studio and (for the two-waiver event) two distinct document templates,
 * so the two required signatures are genuinely different documents, not
 * the same template required twice.
 */
export async function establishE2EWaiverEventFixtures(
  config: E2EConfig,
): Promise<{ oneWaiver: E2EWaiverEventFixture; twoWaiver: E2EWaiverEventFixture }> {
  const admin = adminClient(config);

  await upsertE2EStudio(admin);
  await Promise.all([
    upsertE2EDocumentTemplate(admin, {
      id: E2E_DOCUMENT_TEMPLATE_A_ID,
      title: "E2E Liability Waiver (auto-generated)",
    }),
    upsertE2EDocumentTemplate(admin, {
      id: E2E_DOCUMENT_TEMPLATE_B_ID,
      title: "E2E Photo Release (auto-generated)",
    }),
  ]);

  await upsertE2EEvent(admin, {
    id: E2E_EVENT_ONE_WAIVER_ID,
    slug: E2E_EVENT_ONE_WAIVER_SLUG,
    name: E2E_EVENT_ONE_WAIVER_NAME,
  });
  await upsertE2ETicketType(admin, {
    id: E2E_TICKET_TYPE_ONE_WAIVER_ID,
    eventId: E2E_EVENT_ONE_WAIVER_ID,
    name: "General Admission (E2E, 1 waiver)",
  });
  await upsertE2EDocumentRequirement(admin, {
    id: E2E_DOCUMENT_REQUIREMENT_ONE_WAIVER_ID,
    eventId: E2E_EVENT_ONE_WAIVER_ID,
    templateId: E2E_DOCUMENT_TEMPLATE_A_ID,
  });

  await upsertE2EEvent(admin, {
    id: E2E_EVENT_TWO_WAIVER_ID,
    slug: E2E_EVENT_TWO_WAIVER_SLUG,
    name: E2E_EVENT_TWO_WAIVER_NAME,
  });
  await upsertE2ETicketType(admin, {
    id: E2E_TICKET_TYPE_TWO_WAIVER_ID,
    eventId: E2E_EVENT_TWO_WAIVER_ID,
    name: "General Admission (E2E, 2 waivers)",
  });
  await upsertE2EDocumentRequirement(admin, {
    id: E2E_DOCUMENT_REQUIREMENT_TWO_WAIVER_A_ID,
    eventId: E2E_EVENT_TWO_WAIVER_ID,
    templateId: E2E_DOCUMENT_TEMPLATE_A_ID,
  });
  await upsertE2EDocumentRequirement(admin, {
    id: E2E_DOCUMENT_REQUIREMENT_TWO_WAIVER_B_ID,
    eventId: E2E_EVENT_TWO_WAIVER_ID,
    templateId: E2E_DOCUMENT_TEMPLATE_B_ID,
  });

  return {
    oneWaiver: {
      studioId: E2E_STUDIO_ID,
      eventId: E2E_EVENT_ONE_WAIVER_ID,
      eventSlug: E2E_EVENT_ONE_WAIVER_SLUG,
      eventName: E2E_EVENT_ONE_WAIVER_NAME,
      ticketTypeId: E2E_TICKET_TYPE_ONE_WAIVER_ID,
      documentRequirementIds: [E2E_DOCUMENT_REQUIREMENT_ONE_WAIVER_ID],
    },
    twoWaiver: {
      studioId: E2E_STUDIO_ID,
      eventId: E2E_EVENT_TWO_WAIVER_ID,
      eventSlug: E2E_EVENT_TWO_WAIVER_SLUG,
      eventName: E2E_EVENT_TWO_WAIVER_NAME,
      ticketTypeId: E2E_TICKET_TYPE_TWO_WAIVER_ID,
      documentRequirementIds: [
        E2E_DOCUMENT_REQUIREMENT_TWO_WAIVER_A_ID,
        E2E_DOCUMENT_REQUIREMENT_TWO_WAIVER_B_ID,
      ],
    },
  };
}

/**
 * Deletes any event_registrations/event_orders/event_signing_checkpoints
 * created by a real form submission against the given fixture event --
 * never the studio/event/ticket-type/document fixture rows themselves,
 * which are reusable across runs. Scoped tightly to one event_id at a
 * time, so resetting one event's run data can never touch another
 * fixture event's rows, let alone anything outside this fixture's own ids.
 * Safe to call even if no such rows exist yet. Defaults to the 0-waiver
 * event for backward compatibility with Slice 1 callers.
 */
export async function resetE2ERegistrationData(
  config: E2EConfig,
  eventId: string = E2E_EVENT_ID,
): Promise<void> {
  const admin = adminClient(config);

  const { error: checkpointsError } = await admin
    .from("event_signing_checkpoints")
    .delete()
    .eq("event_id", eventId);
  if (checkpointsError) {
    throw new Error(
      `E2E fixture: failed to reset signing checkpoints -- ${checkpointsError.message}`,
    );
  }

  const { error: registrationsError } = await admin
    .from("event_registrations")
    .delete()
    .eq("event_id", eventId);
  if (registrationsError) {
    throw new Error(
      `E2E fixture: failed to reset registrations -- ${registrationsError.message}`,
    );
  }

  const { error: ordersError } = await admin
    .from("event_orders")
    .delete()
    .eq("event_id", eventId);
  if (ordersError) {
    throw new Error(`E2E fixture: failed to reset orders -- ${ordersError.message}`);
  }
}
