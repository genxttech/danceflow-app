import { createClient } from "@/lib/supabase/server";

// GC-1.3A/B: web/server-only shared-class roster/read helper. This module is
// never imported from mobile/student/** -- the mobile app implements its own
// equivalent read (see mobile/student/src/lib/studentSchedule.ts), since no
// cross-runtime shared package exists in this repo and creating one solely
// for this slice isn't justified.
//
// Role-specific field minimization is done here, at the query/data-access
// layer, not by fetching a broad shape and hiding fields in a page's JSX --
// callers select getClassRosterForStaff vs getClassRosterForInstructor based
// on the caller's already-resolved appointment relationship (typically
// requireAppointmentRelationshipAccess's `scope`), never on a raw role
// string.

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type ClassRosterSource = "roster" | "legacy_fallback";

// Owner / studio_admin / front_desk / platform_admin shape. Billing/package/
// membership identifiers are not a new exposure for this role -- staff
// already have unrestricted access to clients/client_packages/
// client_memberships elsewhere in the app.
export type ClassRosterEntryForStaff = {
  clientId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  billingType: string | null;
  paymentStatus: string | null;
  clientPackageId: string | null;
  clientMembershipId: string | null;
  source: ClassRosterSource;
};

// Assigned-instructor shape. Deliberately excludes billing/payment/package/
// membership identifiers (a front-desk/admin concern, not needed to run a
// class) AND contact info (email/phone) -- an instructor's operational need
// is "who is enrolled and have they checked in," not how to reach them
// outside the studio. This is a proactive minimization, not a fix to a prior
// leak (only staff-roled callers could reach this data before).
export type ClassRosterEntryForInstructor = {
  clientId: string;
  firstName: string;
  lastName: string;
  source: ClassRosterSource;
};

// Read model for a class enrollment appointment, shaped compatibly with the
// existing per-appointment "AppointmentRow" display already used by staff/
// portal pages that list a client's upcoming/recent appointments (title,
// appointment_type, status, starts_at, ends_at, billing_type, payment_status,
// price_amount, instructors, rooms). billing_type/payment_status here are
// this CLIENT's own enrollment billing state (from appointment_attendees, or
// the legacy fallback columns) -- never a different attendee's.
export type ClassEnrollmentAppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  billing_type: string | null;
  payment_status: string | null;
  price_amount: number | null;
  instructors:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  rooms: { name: string } | { name: string }[] | null;
  source: ClassRosterSource;
};

export type OwnClassEnrollment = {
  eligible: boolean;
  billingType: string | null;
  paymentStatus: string | null;
  clientPackageId: string | null;
  clientMembershipId: string | null;
  source: ClassRosterSource;
};

type ClientContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};

function relation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// ============================================================================
// GC-1.3B canonical lifecycle rules -- read directly from GC-1.2's own
// class_enrollment_covers_participation (20260908120000_gc1_2_class_
// attendance_integrity_billing_foundation.sql:43-73):
//
//   status = 'booked'
//   or (status = 'cancelled' and cancelled_at is not null and cancelled_at > a.starts_at)
//
// "Upcoming" is the strict booked-only half of that predicate. "Historical/
// recent" is the full predicate -- a post-start cancellation is GC-1.2's own
// definition of historically-eligible participation, and the read layer must
// not make that participation disappear. This is one shared boolean
// evaluated on already-fetched columns, not a second call to the DB
// function -- no list query needs to hit an RPC for this.
//
// attendance_records cannot independently preserve a case this rule misses:
// its own write path is gated by the same predicate via the
// attendance_records_enforce_class_eligibility trigger, and
// appointment_attendees has no DELETE policy (rows are only ever
// status-transitioned), so there is no scenario where an attendance_records
// row outlives the enrollment row backing it.
// ============================================================================
function isBookedEligible(status: string): boolean {
  return status === "booked";
}

function isHistoricallyEligible(input: {
  status: string;
  cancelledAt: string | null;
  startsAt: string;
}): boolean {
  if (input.status === "booked") return true;
  return (
    input.status === "cancelled" &&
    input.cancelledAt !== null &&
    input.cancelledAt > input.startsAt
  );
}

// Legacy-shape equivalent of the same rule, applied to appointments.status/
// cancelled_at instead of appointment_attendees.status/cancelled_at -- see
// fetchLegacyFallbackAttendee's header comment for exactly what this can and
// cannot reconstruct.
function isLegacyBookedEligible(status: string): boolean {
  return status !== "cancelled";
}

function isLegacyHistoricallyEligible(input: {
  status: string;
  cancelledAt: string | null;
  startsAt: string;
}): boolean {
  if (input.status !== "cancelled") return true;
  return input.cancelledAt !== null && input.cancelledAt > input.startsAt;
}

// ============================================================================
// Temporary legacy dual-read fallback.
//
// GC-1.4 REMOVE LEGACY FALLBACK: this entire section must be deleted once
// (a) booking writes appointment_attendees on creation instead of a bare
// appointments.client_id, and (b) a one-time audit/backfill against PROD
// confirms zero remaining group_class rows with client_id populated and
// zero appointment_attendees rows. Do not extend this fallback's scope --
// it exists only to bridge the gap until GC-1.4's write-path cutover.
//
// Rule: for a group_class appointment, prefer real appointment_attendees
// rows. Only when a class has ZERO appointment_attendees rows AND a
// non-null legacy appointments.client_id, synthesize a roster-of-one from
// the legacy columns that actually exist on `appointments` -- verified
// directly against the authoritative schema
// (backups/danceflow-production-pre-accounting-v1-2026-07-15.sql:5372-5410,
// cross-checked against 20260513000100_add_appointment_billing_type.sql):
// client_id, client_package_id, billing_type, payment_status, status,
// cancelled_at. `appointments` has NO client_membership_id column (that
// column only exists on appointment_attendees, added by GC-1.1) -- a legacy
// row billed with billing_type='membership' has no column to recover which
// specific membership was used, so a synthesized entry's clientMembershipId
// is always null. This is a genuine, documented gap in the legacy shape
// itself, not something this fallback can or should paper over.
//
// Lifecycle: under the legacy single-client-per-row model, the appointments
// row's OWN status/cancelled_at IS that one client's participation lifecycle
// (there is no separate per-attendee cancelled_at to consult, and none is
// invented) -- isLegacyBookedEligible/isLegacyHistoricallyEligible apply the
// identical booked/cancelled-before-or-after-start distinction to those
// columns instead of appointment_attendees'.
// ============================================================================
async function fetchLegacyFallbackAttendee(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  appointmentId: string;
}): Promise<{
  clientId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  billingType: string | null;
  paymentStatus: string | null;
  clientPackageId: string | null;
  status: string;
  cancelledAt: string | null;
  startsAt: string;
} | null> {
  const { supabase, studioId, appointmentId } = params;

  const { count: attendeeCount, error: countError } = await supabase
    .from("appointment_attendees")
    .select("id", { count: "exact", head: true })
    .eq("appointment_id", appointmentId);

  if (countError) {
    throw new Error(`Failed to check class roster: ${countError.message}`);
  }

  if ((attendeeCount ?? 0) > 0) {
    return null;
  }

  const { data: appointmentRow, error: appointmentError } = await supabase
    .from("appointments")
    .select(
      "client_id, billing_type, payment_status, client_package_id, appointment_type, status, cancelled_at, starts_at, clients ( id, first_name, last_name, email, phone )",
    )
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (appointmentError) {
    throw new Error(
      `Failed to load legacy class appointment: ${appointmentError.message}`,
    );
  }

  if (
    !appointmentRow ||
    appointmentRow.appointment_type !== "group_class" ||
    !appointmentRow.client_id
  ) {
    return null;
  }

  const client = relation(appointmentRow.clients as ClientContact | ClientContact[] | null);
  if (!client) return null;

  return {
    clientId: appointmentRow.client_id as string,
    firstName: client.first_name ?? "",
    lastName: client.last_name ?? "",
    email: client.email ?? "",
    phone: client.phone ?? "",
    billingType: appointmentRow.billing_type as string | null,
    paymentStatus: appointmentRow.payment_status as string | null,
    clientPackageId: appointmentRow.client_package_id as string | null,
    status: appointmentRow.status as string,
    cancelledAt: appointmentRow.cancelled_at as string | null,
    startsAt: appointmentRow.starts_at as string,
  };
}

/**
 * Staff-scoped class roster read (owner / studio_admin / front_desk /
 * platform_admin). Callers must already have resolved the caller's
 * authority to this appointment (e.g. via requireAppointmentRelationshipAccess
 * returning scope: "broad") before calling this -- this function does not
 * re-check role/relationship, only shapes and minimizes the query.
 */
export async function getClassRosterForStaff(params: {
  supabase: SupabaseServerClient;
  appointmentId: string;
  studioId: string;
}): Promise<ClassRosterEntryForStaff[]> {
  const { supabase, appointmentId, studioId } = params;

  const { data: attendeeRows, error } = await supabase
    .from("appointment_attendees")
    .select(
      `
      client_id,
      billing_type,
      payment_status,
      client_package_id,
      client_membership_id,
      clients ( id, first_name, last_name, email, phone )
    `,
    )
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId);

  if (error) {
    throw new Error(`Failed to load class roster: ${error.message}`);
  }

  const roster = (attendeeRows ?? [])
    .map((row): ClassRosterEntryForStaff | null => {
      const client = relation(
        row.clients as ClientContact | ClientContact[] | null,
      );
      if (!client) return null;

      return {
        clientId: row.client_id as string,
        firstName: client.first_name ?? "",
        lastName: client.last_name ?? "",
        email: client.email ?? "",
        phone: client.phone ?? "",
        billingType: row.billing_type as string | null,
        paymentStatus: row.payment_status as string | null,
        clientPackageId: row.client_package_id as string | null,
        clientMembershipId: row.client_membership_id as string | null,
        source: "roster",
      };
    })
    .filter((entry): entry is ClassRosterEntryForStaff => entry !== null);

  if (roster.length > 0) {
    return roster;
  }

  const legacy = await fetchLegacyFallbackAttendee({ supabase, studioId, appointmentId });
  if (!legacy) return [];

  return [
    {
      clientId: legacy.clientId,
      firstName: legacy.firstName,
      lastName: legacy.lastName,
      email: legacy.email,
      phone: legacy.phone,
      billingType: legacy.billingType,
      paymentStatus: legacy.paymentStatus,
      clientPackageId: legacy.clientPackageId,
      clientMembershipId: null,
      source: "legacy_fallback",
    },
  ];
}

/**
 * Assigned-instructor-scoped class roster read. Same caller contract as
 * getClassRosterForStaff -- the caller must already have resolved
 * scope: "own-instructor" before calling this. Minimized at the query layer:
 * billing/payment/package/membership fields and contact info are never
 * selected here, not fetched-then-discarded.
 */
export async function getClassRosterForInstructor(params: {
  supabase: SupabaseServerClient;
  appointmentId: string;
  studioId: string;
}): Promise<ClassRosterEntryForInstructor[]> {
  const { supabase, appointmentId, studioId } = params;

  const { data: attendeeRows, error } = await supabase
    .from("appointment_attendees")
    .select("client_id, clients ( id, first_name, last_name )")
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId);

  if (error) {
    throw new Error(`Failed to load class roster: ${error.message}`);
  }

  const roster = (attendeeRows ?? [])
    .map((row): ClassRosterEntryForInstructor | null => {
      const client = relation(
        row.clients as
          | { id: string; first_name: string | null; last_name: string | null }
          | { id: string; first_name: string | null; last_name: string | null }[]
          | null,
      );
      if (!client) return null;

      return {
        clientId: row.client_id as string,
        firstName: client.first_name ?? "",
        lastName: client.last_name ?? "",
        source: "roster",
      };
    })
    .filter((entry): entry is ClassRosterEntryForInstructor => entry !== null);

  if (roster.length > 0) {
    return roster;
  }

  const legacy = await fetchLegacyFallbackAttendee({ supabase, studioId, appointmentId });
  if (!legacy) return [];

  return [
    {
      clientId: legacy.clientId,
      firstName: legacy.firstName,
      lastName: legacy.lastName,
      source: "legacy_fallback",
    },
  ];
}

/**
 * Single-appointment, single-client enrollment lookup -- used for a
 * student's own class-detail access gate and "your enrollment" display
 * (GC-1.3B). `eligible` uses the full historical rule (booked, or cancelled
 * after the class started), not booked-only: a post-start-cancelled student
 * who legitimately participated must retain access to that class's own
 * historical detail, while a pre-start-cancelled (never-eligible) student
 * must not. For a future class this collapses to booked-only anyway, since
 * a post-start cancellation is structurally impossible before a class
 * starts -- one rule correctly serves both the upcoming- and
 * historical-detail cases without branching on time. Never returns another
 * client's row: the real-roster path is scoped by both appointment_id and
 * client_id in the query itself, and the legacy path is rejected unless the
 * fallback's one designated client matches the caller's own clientId.
 */
export async function getOwnClassEnrollmentForAppointment(params: {
  supabase: SupabaseServerClient;
  appointmentId: string;
  studioId: string;
  clientId: string;
}): Promise<OwnClassEnrollment | null> {
  const { supabase, appointmentId, studioId, clientId } = params;

  const { data: appointmentRow, error: appointmentError } = await supabase
    .from("appointments")
    .select("starts_at, appointment_type")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (appointmentError) {
    throw new Error(`Failed to load class appointment: ${appointmentError.message}`);
  }

  if (!appointmentRow || appointmentRow.appointment_type !== "group_class") {
    return null;
  }

  const { data: attendeeRow, error: attendeeError } = await supabase
    .from("appointment_attendees")
    .select(
      "status, cancelled_at, billing_type, payment_status, client_package_id, client_membership_id",
    )
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (attendeeError) {
    throw new Error(`Failed to load class enrollment: ${attendeeError.message}`);
  }

  if (attendeeRow) {
    const eligible = isHistoricallyEligible({
      status: attendeeRow.status as string,
      cancelledAt: attendeeRow.cancelled_at as string | null,
      startsAt: appointmentRow.starts_at as string,
    });

    return {
      eligible,
      billingType: attendeeRow.billing_type as string | null,
      paymentStatus: attendeeRow.payment_status as string | null,
      clientPackageId: attendeeRow.client_package_id as string | null,
      clientMembershipId: attendeeRow.client_membership_id as string | null,
      source: "roster",
    };
  }

  // GC-1.4 REMOVE LEGACY FALLBACK
  const legacy = await fetchLegacyFallbackAttendee({ supabase, studioId, appointmentId });
  if (!legacy || legacy.clientId !== clientId) return null;

  const eligible = isLegacyHistoricallyEligible({
    status: legacy.status,
    cancelledAt: legacy.cancelledAt,
    startsAt: legacy.startsAt,
  });

  return {
    eligible,
    billingType: legacy.billingType,
    paymentStatus: legacy.paymentStatus,
    clientPackageId: legacy.clientPackageId,
    clientMembershipId: null,
    source: "legacy_fallback",
  };
}

/**
 * Every class a given client is (or, under the legacy fallback, appears to
 * be) enrolled in at this studio, split into upcoming (booked-only) and
 * recent/historical (booked or post-start-cancelled) buckets -- mirroring
 * the {upcoming, recent} convention already established by
 * src/lib/schedule/independentInstructorSchedule.ts's
 * getOwnFloorRentalAppointments. Returning two separate arrays, rather than
 * one undifferentiated list plus a mode flag, makes it structurally
 * impossible for a caller to apply upcoming semantics to a historical read
 * or vice versa.
 *
 * Used by both GC-1.3A's staff client-profile history page and GC-1.3B's
 * student-facing portal home/schedule -- safe for both, since every row
 * returned is already scoped to this one client's own enrollment (never a
 * classmate's), regardless of who's asking.
 *
 * `nowIso` must be the same cutoff the caller uses to split its own lesson
 * query, so the lesson and class buckets can never drift apart within one
 * page render.
 *
 * Dedupes by appointment_id: a client can accumulate more than one
 * appointment_attendees row for the same class over time (rebook), so more
 * than one of their own rows could independently satisfy the historical
 * rule for the same class -- a 'booked' row is preferred over a 'cancelled'
 * one when both are eligible for the same appointment_id.
 */
export async function getClassEnrollmentAppointmentsForClient(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  clientId: string;
  nowIso: string;
}): Promise<{
  upcoming: ClassEnrollmentAppointmentRow[];
  recent: ClassEnrollmentAppointmentRow[];
}> {
  const { supabase, studioId, clientId, nowIso } = params;

  const { data: rosterRows, error: rosterError } = await supabase
    .from("appointment_attendees")
    .select(
      `
      appointment_id,
      status,
      cancelled_at,
      billing_type,
      payment_status,
      appointments:appointment_id (
        id, title, appointment_type, status, starts_at, ends_at, price_amount,
        instructors ( first_name, last_name ),
        rooms ( name )
      )
    `,
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId);

  if (rosterError) {
    throw new Error(`Failed to load class enrollment: ${rosterError.message}`);
  }

  type JoinedAppointment = {
    id: string;
    title: string | null;
    appointment_type: string;
    status: string;
    starts_at: string;
    ends_at: string;
    price_amount: number | null;
    instructors:
      | { first_name: string; last_name: string }
      | { first_name: string; last_name: string }[]
      | null;
    rooms: { name: string } | { name: string }[] | null;
  };

  const rosterAppointmentIds = new Set<string>();
  const upcomingByAppointmentId = new Map<
    string,
    { entry: ClassEnrollmentAppointmentRow; attendeeStatus: string }
  >();
  const recentByAppointmentId = new Map<
    string,
    { entry: ClassEnrollmentAppointmentRow; attendeeStatus: string }
  >();

  function upsertPreferBooked(
    map: Map<string, { entry: ClassEnrollmentAppointmentRow; attendeeStatus: string }>,
    id: string,
    entry: ClassEnrollmentAppointmentRow,
    attendeeStatus: string,
  ) {
    const existing = map.get(id);
    if (!existing || attendeeStatus === "booked") {
      map.set(id, { entry, attendeeStatus });
    }
  }

  for (const row of rosterRows ?? []) {
    const appt = relation(
      row.appointments as JoinedAppointment | JoinedAppointment[] | null,
    );
    if (!appt) continue;

    rosterAppointmentIds.add(appt.id);

    const attendeeStatus = row.status as string;
    const cancelledAt = row.cancelled_at as string | null;
    const isFuture = appt.starts_at >= nowIso;

    const entry: ClassEnrollmentAppointmentRow = {
      id: appt.id,
      title: appt.title,
      appointment_type: appt.appointment_type,
      status: appt.status,
      starts_at: appt.starts_at,
      ends_at: appt.ends_at,
      billing_type: row.billing_type as string | null,
      payment_status: row.payment_status as string | null,
      price_amount: appt.price_amount,
      instructors: appt.instructors,
      rooms: appt.rooms,
      source: "roster",
    };

    if (isFuture) {
      if (isBookedEligible(attendeeStatus)) {
        upsertPreferBooked(upcomingByAppointmentId, appt.id, entry, attendeeStatus);
      }
    } else if (isHistoricallyEligible({ status: attendeeStatus, cancelledAt, startsAt: appt.starts_at })) {
      upsertPreferBooked(recentByAppointmentId, appt.id, entry, attendeeStatus);
    }
  }

  // GC-1.4 REMOVE LEGACY FALLBACK: legacy-shaped group_class rows for this
  // client -- see fetchLegacyFallbackAttendee's header comment for the full
  // rule and what lifecycle information the legacy shape can and cannot
  // express. Only a class with zero appointment_attendees rows qualifies.
  const { data: legacyCandidates, error: legacyError } = await supabase
    .from("appointments")
    .select(
      `
      id, title, appointment_type, status, starts_at, ends_at, cancelled_at,
      billing_type, payment_status, price_amount,
      instructors ( first_name, last_name ),
      rooms ( name )
    `,
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("appointment_type", "group_class");

  if (legacyError) {
    throw new Error(`Failed to load legacy class history: ${legacyError.message}`);
  }

  for (const appt of legacyCandidates ?? []) {
    if (rosterAppointmentIds.has(appt.id)) continue;

    const { count: attendeeCount, error: countError } = await supabase
      .from("appointment_attendees")
      .select("id", { count: "exact", head: true })
      .eq("appointment_id", appt.id);

    if (countError) {
      throw new Error(`Failed to check class roster: ${countError.message}`);
    }

    if ((attendeeCount ?? 0) > 0) continue;

    const isFuture = appt.starts_at >= nowIso;
    const entry: ClassEnrollmentAppointmentRow = {
      id: appt.id,
      title: appt.title,
      appointment_type: appt.appointment_type,
      status: appt.status,
      starts_at: appt.starts_at,
      ends_at: appt.ends_at,
      billing_type: appt.billing_type,
      payment_status: appt.payment_status,
      price_amount: appt.price_amount,
      instructors: appt.instructors,
      rooms: appt.rooms,
      source: "legacy_fallback",
    };

    if (isFuture) {
      if (isLegacyBookedEligible(appt.status)) {
        upsertPreferBooked(upcomingByAppointmentId, appt.id, entry, "booked");
      }
    } else if (
      isLegacyHistoricallyEligible({
        status: appt.status,
        cancelledAt: appt.cancelled_at as string | null,
        startsAt: appt.starts_at,
      })
    ) {
      upsertPreferBooked(recentByAppointmentId, appt.id, entry, "booked");
    }
  }

  return {
    upcoming: Array.from(upcomingByAppointmentId.values()).map((v) => v.entry),
    recent: Array.from(recentByAppointmentId.values()).map((v) => v.entry),
  };
}

/**
 * Booked attendee client ids for a class notification event (GC-1.3B).
 * Deliberately booked-only, never the historical rule: a schedule
 * notification is about an active, upcoming event, and a student who is no
 * longer currently enrolled -- whether they cancelled before or after the
 * class started -- should not receive a future-facing push about it. This
 * is intentionally a different rule from getClassEnrollmentAppointmentsForClient's
 * `recent` bucket.
 */
export async function resolveClassAttendeesForNotification(params: {
  supabase: SupabaseServerClient;
  appointmentId: string;
  studioId: string;
}): Promise<string[]> {
  const { supabase, appointmentId, studioId } = params;

  const { data: attendeeRows, error } = await supabase
    .from("appointment_attendees")
    .select("client_id, status")
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId);

  if (error) {
    throw new Error(`Failed to resolve class notification recipients: ${error.message}`);
  }

  const bookedClientIds = Array.from(
    new Set(
      (attendeeRows ?? [])
        .filter((row) => isBookedEligible(row.status as string))
        .map((row) => row.client_id as string)
        .filter(Boolean),
    ),
  );

  if (bookedClientIds.length > 0) {
    return bookedClientIds;
  }

  // GC-1.4 REMOVE LEGACY FALLBACK
  const legacy = await fetchLegacyFallbackAttendee({ supabase, studioId, appointmentId });
  if (!legacy) return [];
  if (!isLegacyBookedEligible(legacy.status)) return [];

  return [legacy.clientId];
}
