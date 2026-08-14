import type { createAdminClient } from "@/lib/supabase/admin";
import { getPayableFloorRentalAppointments } from "@/lib/payments/portal-floor-rental-balance";
import {
  PaymentHarnessSafetyError,
  assertPaymentHarnessClient,
  assertPaymentHarnessEnvironmentAllowed,
  assertPaymentHarnessStudio,
} from "@/lib/payment-harness/guards";
import type {
  PaymentHarnessConfig,
  PaymentHarnessFixtureResult,
} from "@/lib/payment-harness/types";

/**
 * Fixture establish-or-create logic for the configured Payment Harness
 * QA studio/client (floor-rental scenario only).
 *
 * Dependency-injected on purpose, same as evidence.ts: the caller passes
 * an already-constructed admin Supabase client rather than this module
 * constructing one itself, so it can be unit tested against the shared
 * src/lib/payments/__tests__/fakeSupabase.ts fixture with no real database
 * connection.
 *
 * Reuses the canonical `getPayableFloorRentalAppointments` definition of
 * "which floor-rental appointments are collectible" for every read in this
 * module -- this file never reimplements that filter itself, so a fixture
 * this module considers payable is, by construction, the same set the
 * portal page and checkout route would themselves compute.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

const FIXTURE_APPOINTMENT_TYPE = "floor_space_rental";

// Deterministic so repeated QA runs against a reused fixture always expect
// the same balance; not tied to any real room rate.
const FIXTURE_PRICE_AMOUNT_DOLLARS = 25;

// A fixed future date would eventually become "past" as the harness ages,
// so "future" is expressed as an offset from the time of the call instead
// -- the constraint that must hold ("never backdated") is what's fixed,
// not the literal timestamp.
const FIXTURE_LEAD_TIME_MS = 30 * 24 * 60 * 60 * 1000;
const FIXTURE_DURATION_MS = 60 * 60 * 1000;

const FIXTURE_NOTE =
  "Created by the DanceFlow Payment Harness (dev/QA fixture). Safe to ignore; not a real booking.";

function toExpectedBalanceCents(payable: readonly { price_amount: number }[]): number {
  const totalDollars = payable.reduce((sum, rental) => sum + Number(rental.price_amount ?? 0), 0);
  return Math.round(totalDollars * 100);
}

function freezeResult(result: {
  reusedExisting: boolean;
  created: boolean;
  payableAppointmentIds: string[];
  expectedBalanceCents: number;
  createdRecordRefs: Record<string, string[]>;
}): PaymentHarnessFixtureResult {
  return Object.freeze({
    reusedExisting: result.reusedExisting,
    created: result.created,
    payableAppointmentIds: Object.freeze(result.payableAppointmentIds),
    expectedBalanceCents: result.expectedBalanceCents,
    createdRecordRefs: Object.freeze(
      Object.fromEntries(
        Object.entries(result.createdRecordRefs).map(([table, ids]) => [table, Object.freeze(ids)]),
      ),
    ),
  });
}

/**
 * Resolves the configured client's actual `studio_id` from the database
 * and checks it against `config` via the real Slice 1 guards -- not a
 * WHERE-clause filter standing in for the check. Fails closed, with a
 * distinguishable code, whether the configured client doesn't exist at all
 * (CLIENT_MISMATCH) or exists under a different studio than configured
 * (STUDIO_MISMATCH). Runs before any read or write this module performs.
 */
async function verifyConfiguredClientIdentity(
  adminSupabase: AdminClient,
  config: PaymentHarnessConfig,
  context: string,
): Promise<void> {
  const { data: client, error } = await adminSupabase
    .from("clients")
    .select("id, studio_id")
    .eq("id", config.clientId)
    .maybeSingle();

  if (error) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to resolve the configured Payment Harness client: ${error.message}.`,
      "FIXTURE_CLIENT_LOOKUP_FAILED",
    );
  }

  assertPaymentHarnessClient(config, (client?.id as string | undefined) ?? null, context);
  assertPaymentHarnessStudio(config, (client?.studio_id as string | undefined) ?? null, context);
}

/**
 * Establishes fixture state for the configured Payment Harness studio/
 * client: reuses an existing payable floor rental if one already exists,
 * otherwise creates exactly one deterministic QA floor-rental appointment
 * and re-verifies it through the canonical payable-set helper before
 * reporting success.
 *
 * Never creates a payment row, never touches an existing appointment, and
 * never targets any studio/client other than the one `config` resolves to
 * -- `config` is the only source of identity this function accepts.
 */
export async function establishPaymentHarnessFloorRentalFixture(
  adminSupabase: AdminClient,
  config: PaymentHarnessConfig,
): Promise<PaymentHarnessFixtureResult> {
  const context = "establishPaymentHarnessFloorRentalFixture";

  assertPaymentHarnessEnvironmentAllowed(config.environment, context);
  await verifyConfiguredClientIdentity(adminSupabase, config, context);

  const existingPayable = await getPayableFloorRentalAppointments({
    supabase: adminSupabase,
    studioId: config.studioId,
    clientId: config.clientId,
  });

  if (existingPayable.length > 0) {
    return freezeResult({
      reusedExisting: true,
      created: false,
      payableAppointmentIds: existingPayable.map((rental) => rental.id),
      expectedBalanceCents: toExpectedBalanceCents(existingPayable),
      createdRecordRefs: {},
    });
  }

  // Re-checked immediately before the write, not just once at the top of
  // this function -- guards are stateless and meant to be re-invoked right
  // before every write, the same convention evidence.ts follows.
  assertPaymentHarnessEnvironmentAllowed(config.environment, context);

  const startsAt = new Date(Date.now() + FIXTURE_LEAD_TIME_MS);
  const endsAt = new Date(startsAt.getTime() + FIXTURE_DURATION_MS);

  const { data: inserted, error: insertError } = await adminSupabase
    .from("appointments")
    .insert({
      studio_id: config.studioId,
      client_id: config.clientId,
      instructor_id: null,
      room_id: null,
      client_package_id: null,
      appointment_type: FIXTURE_APPOINTMENT_TYPE,
      title: "Floor Space Rental",
      notes: FIXTURE_NOTE,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: "scheduled",
      payment_status: "unpaid",
      price_amount: FIXTURE_PRICE_AMOUNT_DOLLARS,
      is_recurring: false,
      created_by: null,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to create the Payment Harness fixture appointment: ` +
        `${insertError?.message ?? "no row returned"}.`,
      "FIXTURE_INSERT_FAILED",
    );
  }

  const createdAppointmentId = inserted.id as string;

  const payableAfterInsert = await getPayableFloorRentalAppointments({
    supabase: adminSupabase,
    studioId: config.studioId,
    clientId: config.clientId,
  });

  const createdIsPayable = payableAfterInsert.some((rental) => rental.id === createdAppointmentId);
  if (!createdIsPayable) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the fixture appointment just created (${createdAppointmentId}) ` +
        `was not found in the canonical payable-rental set on re-read. Refusing to report success.`,
      "FIXTURE_VERIFICATION_FAILED",
    );
  }

  return freezeResult({
    reusedExisting: false,
    created: true,
    payableAppointmentIds: payableAfterInsert.map((rental) => rental.id),
    expectedBalanceCents: toExpectedBalanceCents(payableAfterInsert),
    createdRecordRefs: { appointments: [createdAppointmentId] },
  });
}
