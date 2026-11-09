/**
 * In-memory stand-in for the database behind the staff API tests. It deliberately applies NO row-level security: a row comes back only if the route's own filters select it,
 * so these suites prove the application-layer tenant boundary rather than leaning on RLS. Real RLS is exercised separately by localStack.staffApi.test.ts.
 */

export const STUDIO_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const STUDIO_B = "bbbbbbbb-0000-4000-8000-000000000002";
export const STUDIO_PAUSED = "cccccccc-0000-4000-8000-000000000003";
export const STUDIO_ORGANIZER = "dddddddd-0000-4000-8000-000000000004";

export const APPT_OWN_LESSON = "a0000000-0000-4000-8000-000000000001";
export const APPT_OWN_CLASS = "a0000000-0000-4000-8000-000000000002";
export const APPT_COLLEAGUE_LESSON = "a0000000-0000-4000-8000-000000000003";
export const APPT_COLLEAGUE_CLASS = "a0000000-0000-4000-8000-000000000004";
export const APPT_NEXT_DAY = "a0000000-0000-4000-8000-000000000005";
export const APPT_OWN_CANCELLED = "a0000000-0000-4000-8000-000000000006";
export const APPT_RENTAL = "a0000000-0000-4000-8000-000000000007";
export const APPT_OTHER_STUDIO = "b0000000-0000-4000-8000-000000000001";

export const TOKENS = {
  instructorA: "user-instructor-a",
  colleagueA: "user-colleague-a",
  instructorB: "user-instructor-b",
  ownerA: "user-owner-a",
  frontDeskA: "user-frontdesk-a",
  independentA: "user-independent-a",
  organizerStaff: "user-organizer-staff",
  organizerOwner: "user-organizer-owner",
  unlinkedInstructorA: "user-unlinked-a",
  removedFromA: "user-removed-a",
  renterInstructorA: "user-renter-a",
  dualRole: "user-dual-role",
  roleRowAdmin: "user-role-row-admin",
  student: "user-student",
  deactivated: "user-deactivated",
  pendingDeletion: "user-pending-deletion",
  banned: "user-banned",
  platformAdmin: "user-platform-admin",
  noProfile: "user-no-profile",
} as const;

type Row = Record<string, unknown>;

const studios: Row[] = [
  { id: STUDIO_A, name: "Studio A", slug: "studio-a", public_name: "Studio A Public", subscription_status: "active", timezone: "America/New_York" },
  { id: STUDIO_B, name: "Studio B", slug: "studio-b", public_name: null, subscription_status: "trialing", timezone: "America/Chicago" },
  { id: STUDIO_PAUSED, name: "Studio Paused", slug: "studio-paused", public_name: null, subscription_status: "past_due", timezone: "America/New_York" },
  { id: STUDIO_ORGANIZER, name: "Harbor Organizer", slug: "harbor", public_name: null, subscription_status: "active", timezone: "America/New_York" },
];

const studioEmbed = (id: string) => {
  const { name, slug, public_name } = studios.find((row) => row.id === id) as Row;
  return { id, name, slug, public_name };
};

const roleRow = (user_id: string, studio_id: string, role: string, active = true): Row => ({
  user_id,
  studio_id,
  role,
  active,
  created_at: "2026-01-01T00:00:00Z",
  studios: studioEmbed(studio_id),
});

const user_studio_roles: Row[] = [
  roleRow(TOKENS.instructorA, STUDIO_A, "instructor"),
  roleRow(TOKENS.instructorA, STUDIO_PAUSED, "instructor"),
  roleRow(TOKENS.colleagueA, STUDIO_A, "instructor"),
  roleRow(TOKENS.instructorB, STUDIO_B, "instructor"),
  roleRow(TOKENS.ownerA, STUDIO_A, "studio_owner"),
  roleRow(TOKENS.frontDeskA, STUDIO_A, "front_desk"),
  roleRow(TOKENS.independentA, STUDIO_A, "independent_instructor"),
  roleRow(TOKENS.organizerOwner, STUDIO_ORGANIZER, "studio_owner"),
  roleRow(TOKENS.unlinkedInstructorA, STUDIO_A, "instructor"),
  roleRow(TOKENS.removedFromA, STUDIO_A, "instructor", false),
  roleRow(TOKENS.renterInstructorA, STUDIO_A, "instructor"),
  roleRow(TOKENS.dualRole, STUDIO_A, "instructor"),
  roleRow(TOKENS.roleRowAdmin, STUDIO_A, "platform_admin"),
  roleRow(TOKENS.platformAdmin, STUDIO_A, "studio_owner"),
];

const organizer_users: Row[] = [
  {
    user_id: TOKENS.organizerStaff,
    organizer_id: "org-1",
    role: "organizer_staff",
    active: true,
    created_at: "2026-01-01T00:00:00Z",
    organizers: { id: "org-1", name: "Harbor", studio_id: STUDIO_ORGANIZER, studios: studioEmbed(STUDIO_ORGANIZER) },
  },
  {
    user_id: TOKENS.dualRole,
    organizer_id: "org-a",
    role: "organizer_owner",
    active: true,
    created_at: "2026-01-01T00:00:00Z",
    organizers: { id: "org-a", name: "A Events", studio_id: STUDIO_A, studios: studioEmbed(STUDIO_A) },
  },
];

const profile = (id: string, platform_role: string | null = null): Row => ({ id, full_name: `Name of ${id}`, platform_role });

const profiles: Row[] = Object.values(TOKENS)
  .filter((token) => token !== TOKENS.noProfile)
  .map((token) => profile(token, token === TOKENS.platformAdmin ? "platform_admin" : null));

const instructors: Row[] = [
  { id: "ins-a1", studio_id: STUDIO_A, user_id: TOKENS.instructorA, active: true },
  { id: "ins-a2", studio_id: STUDIO_A, user_id: TOKENS.colleagueA, active: true },
  { id: "ins-b1", studio_id: STUDIO_B, user_id: TOKENS.instructorB, active: true },
  // The same person teaches at B under a separate row; it must never answer for studio A.
  { id: "ins-b-of-a", studio_id: STUDIO_B, user_id: TOKENS.instructorA, active: true },
  { id: "ins-a-retired", studio_id: STUDIO_A, user_id: TOKENS.removedFromA, active: false },
];

const clients: Row[] = [
  { id: "cli-a1", studio_id: STUDIO_A, first_name: "Ana", last_name: "Own", referral_source: "secret-referral", phone: "555-0100" },
  { id: "cli-a2", studio_id: STUDIO_A, first_name: "Colin", last_name: "Colleague", referral_source: "secret-referral", phone: "555-0101" },
  { id: "cli-a3", studio_id: STUDIO_A, first_name: "Pat", last_name: "Partner", referral_source: null, phone: "555-0102" },
  { id: "cli-b1", studio_id: STUDIO_B, first_name: "Bea", last_name: "Bstudio", referral_source: null, phone: "555-0200" },
  { id: "cli-rental", studio_id: STUDIO_A, first_name: "Rene", last_name: "Renter", referral_source: null, phone: "555-0103" },
];

const clientName = (id: string) => {
  const { first_name, last_name } = clients.find((row) => row.id === id) as Row;
  return { first_name, last_name };
};

const appointment = (overrides: Row): Row => ({
  title: null,
  appointment_type: "private_lesson",
  status: "scheduled",
  ends_at: null,
  client_id: null,
  partner_client_id: null,
  location_name: null,
  notes: "teaching note",
  roster_capacity: null,
  rooms: { id: "room-1", name: "Main Floor" },
  instructors: null,
  // Present on every row so a sloppy projection would leak them.
  price_amount: 125,
  payment_status: "unpaid",
  billing_type: "pay_as_you_go",
  ...overrides,
});

const appointments: Row[] = [
  appointment({ id: APPT_OWN_LESSON, studio_id: STUDIO_A, instructor_id: "ins-a1", client_id: "cli-a1", partner_client_id: "cli-a3", starts_at: "2026-11-09T15:00:00.000Z", ends_at: "2026-11-09T15:45:00.000Z", instructors: { id: "ins-a1", first_name: "Ida", last_name: "Instructor" } }),
  // 23:59 local on Nov 9 in New York: still that day, though Nov 10 in UTC.
  appointment({ id: APPT_OWN_CLASS, studio_id: STUDIO_A, instructor_id: "ins-a1", appointment_type: "group_class", title: "Late Salsa", roster_capacity: 10, starts_at: "2026-11-10T04:59:00.000Z", instructors: { id: "ins-a1", first_name: "Ida", last_name: "Instructor" } }),
  appointment({ id: APPT_OWN_CANCELLED, studio_id: STUDIO_A, instructor_id: "ins-a1", client_id: "cli-a2", status: "cancelled", starts_at: "2026-11-09T12:00:00.000Z" }),
  appointment({ id: APPT_NEXT_DAY, studio_id: STUDIO_A, instructor_id: "ins-a1", client_id: "cli-a1", starts_at: "2026-11-10T05:00:00.000Z" }),
  appointment({ id: APPT_COLLEAGUE_LESSON, studio_id: STUDIO_A, instructor_id: "ins-a2", client_id: "cli-a2", starts_at: "2026-11-09T16:00:00.000Z" }),
  appointment({ id: APPT_COLLEAGUE_CLASS, studio_id: STUDIO_A, instructor_id: "ins-a2", appointment_type: "group_class", title: "Colleague Waltz", starts_at: "2026-11-09T17:00:00.000Z" }),
  appointment({ id: APPT_RENTAL, studio_id: STUDIO_A, instructor_id: null, client_id: "cli-rental", appointment_type: "floor_space_rental", starts_at: "2026-11-09T18:00:00.000Z" }),
  appointment({ id: APPT_OTHER_STUDIO, studio_id: STUDIO_B, instructor_id: "ins-b1", client_id: "cli-b1", starts_at: "2026-11-09T15:30:00.000Z" }),
  // Teaching row for instructorA at B: must never surface when A is requested.
  appointment({ id: "b0000000-0000-4000-8000-000000000002", studio_id: STUDIO_B, instructor_id: "ins-b-of-a", client_id: "cli-b1", starts_at: "2026-11-09T19:00:00.000Z" }),
  // Bad data: studio B's row pointing at studio A's instructor. The studio filter must still hold on its own.
  appointment({ id: "b0000000-0000-4000-8000-000000000003", studio_id: STUDIO_B, instructor_id: "ins-a1", client_id: "cli-b1", starts_at: "2026-11-09T20:00:00.000Z" }),
];

const client_account_links: Row[] = [
  { id: "link-1", studio_id: STUDIO_A, client_id: "cli-rental", user_id: TOKENS.renterInstructorA, status: "linked" },
];

const appointment_attendees: Row[] = [
  { id: "att-1", studio_id: STUDIO_A, appointment_id: APPT_OWN_CLASS, client_id: "cli-a1", status: "booked", billing_type: "package_credit", payment_status: "paid", clients: clientName("cli-a1") },
  { id: "att-2", studio_id: STUDIO_A, appointment_id: APPT_OWN_CLASS, client_id: "cli-a3", status: "cancelled", clients: clientName("cli-a3") },
  // Enrolled, with no lesson in the instructor's teaching relationship. Real clients RLS returns a null embed for an instructor here.
  { id: "att-3", studio_id: STUDIO_A, appointment_id: APPT_OWN_CLASS, client_id: "cli-rental", status: "booked", clients: null },
];

const attendance_records: Row[] = [
  { studio_id: STUDIO_A, appointment_id: APPT_OWN_CLASS, client_id: "cli-a1", status: "attended" },
];

const lesson_recaps: Row[] = [
  { studio_id: STUDIO_A, appointment_id: APPT_OWN_LESSON, summary: "Worked on frame", homework: "Practice box step", next_focus: "Timing", visible_to_client: true, updated_at: "2026-11-09T16:00:00.000Z", video_storage_path: "secret/path.mp4" },
];

export const TABLES: Record<string, Row[]> = {
  studios,
  user_studio_roles,
  organizer_users,
  profiles,
  instructors,
  clients,
  appointments,
  client_account_links,
  appointment_attendees,
  attendance_records,
  lesson_recaps,
};

export const ACCOUNT_STATUS: Row[] = [
  { user_id: TOKENS.deactivated, status: "deactivated", deactivated_at: "2026-10-01T00:00:00Z", reactivated_at: null },
  { user_id: TOKENS.pendingDeletion, status: "pending_deletion", deactivated_at: "2026-10-01T00:00:00Z", reactivated_at: null },
];

type Failures = { table?: string; rpc?: string };

class FakeQuery {
  private rows: Row[];
  private failure: { message: string } | null;

  constructor(rows: Row[], failure: { message: string } | null) {
    this.rows = rows;
    this.failure = failure;
  }

  select() {
    return this;
  }
  order() {
    return this;
  }
  eq(column: string, value: unknown) {
    this.rows = this.rows.filter((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.rows = this.rows.filter((row) => values.includes(row[column]));
    return this;
  }
  gte(column: string, value: string) {
    this.rows = this.rows.filter((row) => String(row[column]) >= value);
    return this;
  }
  lt(column: string, value: string) {
    this.rows = this.rows.filter((row) => String(row[column]) < value);
    return this;
  }
  async maybeSingle() {
    if (this.failure) return { data: null, error: this.failure };
    return { data: this.rows[0] ?? null, error: null };
  }
  async single() {
    if (this.failure) return { data: null, error: this.failure };
    return this.rows[0] ? { data: this.rows[0], error: null } : { data: null, error: { message: "no rows" } };
  }
  then<T>(resolve: (value: { data: Row[] | null; error: { message: string } | null }) => T) {
    return Promise.resolve(
      this.failure ? { data: null, error: this.failure } : { data: this.rows, error: null },
    ).then(resolve);
  }
}

export type AuthOutcome = { status: number; name?: string } | null;

export function createWorldClient(token: string, options: { failures?: Failures; authFailure?: AuthOutcome } = {}) {
  const known = (Object.values(TOKENS) as string[]).includes(token);
  return {
    auth: {
      getUser: async (jwt: string) => {
        if (options.authFailure) {
          return { data: { user: null }, error: { message: "auth failure", ...options.authFailure } };
        }
        if (jwt !== token || !known) {
          return { data: { user: null }, error: { message: "invalid JWT", status: 401, name: "AuthApiError" } };
        }
        return {
          data: {
            user: {
              id: token,
              email: `${token}@example.test`,
              banned_until: token === TOKENS.banned ? "2099-01-01T00:00:00Z" : undefined,
            },
          },
          error: null,
        };
      },
    },
    from(table: string) {
      const rows = TABLES[table];
      if (!rows) throw new Error(`Unexpected table read: ${table}`);
      return new FakeQuery(rows, options.failures?.table === table ? { message: `${table} down` } : null);
    },
    async rpc(name: string, args: { target_studio_id: string }) {
      if (name !== "get_teaching_clients_for_instructor") throw new Error(`Unexpected rpc: ${name}`);
      if (options.failures?.rpc === name) return { data: null, error: { message: "rpc down" } };
      // Mirrors the real RPC's shape: only the caller's own students at that studio, in a current state.
      const own = new Set(
        instructors
          .filter((row) => row.user_id === token && row.studio_id === args.target_studio_id && row.active)
          .map((row) => row.id),
      );
      const ids = new Set(
        appointments
          .filter(
            (row) =>
              row.studio_id === args.target_studio_id &&
              own.has(row.instructor_id) &&
              row.client_id &&
              row.status !== "cancelled",
          )
          .map((row) => row.client_id),
      );
      return { data: clients.filter((row) => ids.has(row.id)), error: null };
    },
  };
}

export function createAdminWorldClient() {
  return {
    from(table: string) {
      // The service role exists here for the account status lookup and nothing else.
      if (table !== "user_account_status") throw new Error(`Service role must not read ${table}`);
      return new FakeQuery(ACCOUNT_STATUS, null);
    },
  };
}
