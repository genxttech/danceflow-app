import { createClient } from "@/lib/supabase/server";

// GC-1.3A: web/server-only shared-class roster/read helper. This module is
// never imported from mobile/student/** -- the mobile app implements its own
// equivalent read (see mobile/student/src/lib/studentSchedule.ts for the
// GC-1.3B slice), since no cross-runtime shared package exists in this repo
// and creating one solely for this slice isn't justified.
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

// Read model for a client's own class enrollments, shaped compatibly with
// the existing per-appointment "AppointmentRow" display already used by
// staff pages that list a client's upcoming/recent appointments (title,
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
// client_id, client_package_id, billing_type, payment_status, status.
// `appointments` has NO client_membership_id column (that column only
// exists on appointment_attendees, added by GC-1.1) -- a legacy row billed
// with billing_type='membership' has no column to recover which specific
// membership was used, so a synthesized entry's clientMembershipId is
// always null. This is a genuine, documented gap in the legacy shape
// itself, not something this fallback can or should paper over.
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
      "client_id, billing_type, payment_status, client_package_id, appointment_type, clients ( id, first_name, last_name, email, phone )",
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
 * Staff client-profile class history read: every group_class appointment a
 * given client is (or, under the legacy fallback, appears to be) enrolled
 * in at this studio -- used so a client's own staff-facing profile timeline
 * shows their class history alongside their unchanged lesson history. This
 * is a GC-1.3A-only primitive, distinct from GC-1.3B's (not yet
 * implemented) student-facing "own upcoming classes" read -- this one is
 * staff-scoped (no per-viewer privacy constraint beyond ordinary studio
 * staff access) and answers a different question ("this client's history,
 * for staff") than GC-1.3B's ("my own upcoming classes, for the student").
 */
export async function getClassEnrollmentAppointmentsForClient(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  clientId: string;
}): Promise<ClassEnrollmentAppointmentRow[]> {
  const { supabase, studioId, clientId } = params;

  const { data: rosterRows, error: rosterError } = await supabase
    .from("appointment_attendees")
    .select(
      `
      appointment_id,
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
    .eq("client_id", clientId)
    .eq("status", "booked");

  if (rosterError) {
    throw new Error(`Failed to load class enrollment: ${rosterError.message}`);
  }

  const rosterAppointmentIds = new Set<string>();
  const results: ClassEnrollmentAppointmentRow[] = [];

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

  for (const row of rosterRows ?? []) {
    const appt = relation(
      row.appointments as JoinedAppointment | JoinedAppointment[] | null,
    );
    if (!appt) continue;

    rosterAppointmentIds.add(appt.id);
    results.push({
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
    });
  }

  // GC-1.4 REMOVE LEGACY FALLBACK: legacy-shaped group_class rows for this
  // client -- see fetchLegacyFallbackAttendee's header comment for the full
  // rule. Only a class with zero appointment_attendees rows qualifies.
  const { data: legacyCandidates, error: legacyError } = await supabase
    .from("appointments")
    .select(
      `
      id, title, appointment_type, status, starts_at, ends_at,
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

    results.push({
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
    });
  }

  return results;
}
