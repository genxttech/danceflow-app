/**
 * Staff API Phase 1A S1: one-to-one appointment attendance (PUT .../appointments/{id}/attendance) against REAL RLS and the real package-credit trigger and RPC:
 * route handler -> real supabase-js -> Kong -> PostgREST -> Postgres, as the caller's own JWT. LOCAL / DISPOSABLE STACK ONLY; skipped unless the isolated QA harness
 * provides a loopback stack (never run it on a shared database):
 *   node scripts/qa/iso-qa.mjs run baseline -- src/app/api/staff/__tests__/localStack.staffApiAppointmentAttendance.test.ts
 * (apply migrations above the baseline cutoff first). auth.getUser is the one stand-in, exactly as in localStack.staffApiSlice2.test.ts.
 */
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const isLoopback = (value: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
};
const enabled = Boolean(URL_ && SECRET && PG) && isLoopback(URL_);

function psql(sql: string) {
  return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const b64u = (value: string) => Buffer.from(value).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const tokenFor = (sub: string) => sign({ sub, role: "authenticated", aud: "authenticated", exp: exp() });

vi.mock("@supabase/supabase-js", async () => {
  const actual = await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
  return {
    ...actual,
    createClient: (url: string, key: string, options: never) => {
      const client = actual.createClient(url, key, options);
      (client.auth as unknown as { getUser: unknown }).getUser = async (jwt: string) => {
        const [head, body, signature] = jwt.split(".");
        const expected = createHmac("sha256", process.env.TW4A_LOCAL_JWT_SECRET ?? "").update(`${head}.${body}`).digest("base64url");
        if (signature !== expected) return { data: { user: null }, error: { message: "invalid JWT", status: 401, name: "AuthApiError" } };
        const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { sub: string; exp: number };
        if (claims.exp * 1000 < Date.now()) return { data: { user: null }, error: { message: "expired", status: 401, name: "AuthApiError" } };
        return { data: { user: { id: claims.sub, email: `${claims.sub}@example.test` } }, error: null };
      };
      return client;
    },
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("The staff API must never build a cookie client");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    throw new Error("The staff API must never read cookies");
  },
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`Unexpected redirect to ${url}`);
  },
}));

const id = () => randomUUID();
const STUDIO_A = id();
const STUDIO_B = id();
const USERS = { owner: id(), frontDesk: id(), instructor: id(), colleague: id(), independent: id(), ownerB: id() };
const INS = id();
const INS_COL = id();
const ANA = id();
const BEA = id();
const PLAN = id();
const BENEFIT = id();
const MEMBERSHIP = id();
const PERIOD = id();
const day = (days: number, time = "15:00") => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${time}:00Z`;

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
let attendance: Handler;

const authed = (path: string, user: string, init: RequestInit = {}) =>
  new Request(`https://app.test${path}`, { ...init, headers: { Authorization: `Bearer ${tokenFor(user)}`, "x-danceflow-app": "business/0.2.0/3/android", ...(init.headers ?? {}) } });

const mark = (user: string, appointmentId: string, body: unknown, key: string | null = `key-${randomUUID()}`, studioId = STUDIO_A) =>
  attendance(
    authed(`/api/staff/workspaces/${studioId}/appointments/${appointmentId}/attendance`, user, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ studioId, appointmentId }) },
  );

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((await response.json()).code).toBe(code);
}

type LessonOptions = {
  billing?: "package_credit" | "membership" | "pay_as_you_go" | "free_comped";
  packageId?: string | null;
  membershipId?: string | null;
  price?: number | null;
  paymentStatus?: string;
  instructor?: string;
  type?: string;
  status?: string;
  client?: string;
  studio?: string;
};
function lesson(options: LessonOptions = {}) {
  const lessonId = id();
  const {
    billing: requestedBilling = "package_credit",
    packageId = null,
    membershipId = null,
    price = null,
    paymentStatus = "unpaid",
    instructor = INS,
    type = "private_lesson",
    status = "scheduled",
    client: requestedClient = ANA,
    studio = STUDIO_A,
  } = options;
  // A shared group class carries no single client or billing (database rule); a floor rental has no instructor.
  const isClass = type === "group_class";
  const client = isClass ? null : requestedClient;
  const billing = requestedBilling;
  psql(`insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, title, status, billing_type, client_package_id, client_membership_id, price_amount, payment_status)
    values ('${lessonId}', '${studio}', '${instructor}', '${type}', ${client ? `'${client}'` : "null"}, '${day(1)}', '${day(1, "15:45")}', 'Lesson', '${status}', ${billing ? `'${billing}'` : "null"},
      ${packageId ? `'${packageId}'` : "null"}, ${membershipId ? `'${membershipId}'` : "null"}, ${price ?? "null"}, '${paymentStatus}');`);
  return lessonId;
}

function newPackage(remaining: number | null, options: { expires?: string; unlimited?: boolean; client?: string } = {}) {
  const packageId = id();
  const { expires = day(60).slice(0, 10), unlimited = false, client = ANA } = options;
  psql(`insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, expiration_date, sold_price) values ('${packageId}', '${STUDIO_A}', '${client}', 'QA package', true, '${expires}', 500);
    insert into public.client_package_items (studio_id, client_package_id, usage_type, quantity_remaining, quantity_total, is_unlimited) values ('${STUDIO_A}', '${packageId}', 'private_lesson', ${remaining ?? "null"}, ${unlimited ? "null" : 10}, ${unlimited});`);
  return packageId;
}

const remaining = (packageId: string) => Number(psql(`select quantity_remaining from public.client_package_items where client_package_id = '${packageId}' and usage_type = 'private_lesson';`));
const deductions = (appointmentId: string) =>
  Number(psql(`select count(*) from public.lesson_transactions where appointment_id = '${appointmentId}' and transaction_type::text in ('lesson_deduction','appointment_attendance');`));
function newClient() {
  const clientId = id();
  psql(`insert into public.clients (id, studio_id, first_name, last_name, status) values ('${clientId}', '${STUDIO_A}', 'Fresh', 'Dancer', 'active');`);
  return clientId;
}
const noteBodies = (clientId: string) => psql(`select coalesce(string_agg(body, ' || ' order by created_at), '') from public.client_activity_notes where client_id = '${clientId}';`);
const noteCount = (clientId: string) => Number(psql(`select count(*) from public.client_activity_notes where client_id = '${clientId}';`));
const statusOf = (appointmentId: string) => psql(`select status from public.appointments where id = '${appointmentId}';`);
const notes = (clientId: string, needle: string) =>
  Number(psql(`select count(*) from public.client_activity_notes where client_id = '${clientId}' and body like '%${needle}%';`));

describe.skipIf(!enabled)("staff API appointment attendance against real RLS and the package-credit database logic", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = sign({ role: "anon", exp: exp() });
    process.env.SUPABASE_SERVICE_ROLE_KEY = sign({ role: "service_role", exp: exp() });
    process.env.STAFF_API_WRITE_POLICY = JSON.stringify({ enabled: ["appointmentAttendance"] });

    const role = (user: string, studio: string, value: string) => `('${user}', '${studio}', '${value}', true)`;
    psql(`begin;
      set local session_replication_role = replica;
      ${Object.values(USERS).map((u) => `insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id, full_name) values ('${u}', 'QA');`).join("\n")}
      insert into public.studios (id, name, slug, subscription_status, timezone) values
        ('${STUDIO_A}', 'Attendance Studio A', 'aa-${STUDIO_A.slice(0, 8)}', 'active', 'America/Chicago'),
        ('${STUDIO_B}', 'Attendance Studio B', 'ab-${STUDIO_B.slice(0, 8)}', 'active', 'America/Chicago');
      insert into public.studio_settings (studio_id) values ('${STUDIO_A}'), ('${STUDIO_B}');
      insert into public.user_studio_roles (user_id, studio_id, role, active) values
        ${[role(USERS.owner, STUDIO_A, "studio_owner"), role(USERS.frontDesk, STUDIO_A, "front_desk"), role(USERS.instructor, STUDIO_A, "instructor"),
          role(USERS.colleague, STUDIO_A, "instructor"), role(USERS.independent, STUDIO_A, "independent_instructor"), role(USERS.ownerB, STUDIO_B, "studio_owner")].join(",\n")};
      insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
        ('${INS}', '${STUDIO_A}', '${USERS.instructor}', 'Ida', 'Teacher', true, true),
        ('${INS_COL}', '${STUDIO_A}', '${USERS.colleague}', 'Cole', 'Teacher', true, true);
      insert into public.clients (id, studio_id, first_name, last_name, status) values
        ('${ANA}', '${STUDIO_A}', 'Ana', 'Alvarez', 'active'), ('${BEA}', '${STUDIO_B}', 'Bea', 'Brook', 'active');
      insert into public.membership_plans (id, studio_id, name, active, billing_interval, price) values ('${PLAN}', '${STUDIO_A}', 'Gold', true, 'monthly', 100);
      insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, usage_period, applies_to) values ('${BENEFIT}', '${PLAN}', 'included_private_lessons', 4, 'monthly', 'all');
      insert into public.client_memberships (id, studio_id, client_id, membership_plan_id, status, starts_on, current_period_start, current_period_end, name_snapshot, billing_interval_snapshot)
        values ('${MEMBERSHIP}', '${STUDIO_A}', '${ANA}', '${PLAN}', 'active', current_date - 20, current_date - 20, current_date + 40, 'Gold', 'monthly');
      insert into public.client_membership_periods (id, studio_id, client_id, client_membership_id, period_start, period_end, payment_status)
        values ('${PERIOD}', '${STUDIO_A}', '${ANA}', '${MEMBERSHIP}', current_date - 20, current_date + 40, 'paid');
      commit;
      -- The membership-usage trigger ships disabled in the baseline schema and is enabled on DEV and PROD (checked read-only 2026-11-20); this disposable database mirrors them.
      alter table public.appointments enable trigger appointments_sync_membership_usage_for_private_lesson;`);

    attendance = (await import("../workspaces/[studioId]/appointments/[appointmentId]/attendance/route")).PUT as unknown as Handler;
  });

  describe("package deduction is exactly once", () => {
    it("takes one credit on attended, and a replayed request with the same key takes no more", async () => {
      const pkg = newPackage(5);
      const appointment = lesson({ packageId: pkg });
      const key = `retry-${randomUUID()}`;
      const first = await mark(USERS.frontDesk, appointment, { status: "attended" }, key);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ appointment: { id: appointment, status: "attended", alreadyApplied: false } });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const retry = await mark(USERS.frontDesk, appointment, { status: "attended" }, key);
        expect(retry.status).toBe(200);
        expect((await retry.json()).appointment.alreadyApplied).toBe(true);
      }
      expect(remaining(pkg)).toBe(4);
      expect(deductions(appointment)).toBe(1);
    });

    it("takes one credit when six requests race, with the same key or different keys, from different staff", async () => {
      const pkg = newPackage(5);
      const appointment = lesson({ packageId: pkg });
      const shared = `race-${randomUUID()}`;
      const callers = [USERS.frontDesk, USERS.owner, USERS.instructor, USERS.frontDesk, USERS.owner, USERS.instructor];
      const responses = await Promise.all(callers.map((user, index) => mark(user, appointment, { status: "attended" }, index % 2 ? shared : `race-${randomUUID()}`)));
      expect(responses.map((response) => response.status).every((status) => status === 200 || status === 409)).toBe(true);
      expect(responses.some((response) => response.status === 200)).toBe(true);
      // A lost race may answer usage_sync_pending; repeating the request completes the work and still takes nothing extra.
      const settle = await mark(USERS.frontDesk, appointment, { status: "attended" });
      expect(settle.status).toBe(200);
      expect(statusOf(appointment)).toBe("attended");
      expect(remaining(pkg)).toBe(4);
      expect(deductions(appointment)).toBe(1);
    });

    it("takes the last credit, then refuses the next lesson on the spent package without touching it", async () => {
      const pkg = newPackage(1);
      const first = lesson({ packageId: pkg });
      expect((await mark(USERS.frontDesk, first, { status: "attended" })).status).toBe(200);
      expect(remaining(pkg)).toBe(0);
      const second = lesson({ packageId: pkg });
      await expectCode(await mark(USERS.frontDesk, second, { status: "attended" }), 409, "payment_required");
      expect(statusOf(second)).toBe("scheduled");
      expect(remaining(pkg)).toBe(0);
      expect(deductions(second)).toBe(0);
    });

    it("refuses a lesson whose package is already at zero, leaving it scheduled", async () => {
      const appointment = lesson({ packageId: newPackage(0) });
      await expectCode(await mark(USERS.owner, appointment, { status: "attended" }), 409, "payment_required");
      expect(statusOf(appointment)).toBe("scheduled");
    });

    it("refuses a package lesson with no package linked, and an unlimited package never runs out", async () => {
      await expectCode(await mark(USERS.owner, lesson({ packageId: null }), { status: "attended" }), 409, "payment_required");
      const pkg = newPackage(null, { unlimited: true });
      const appointment = lesson({ packageId: pkg });
      expect((await mark(USERS.owner, appointment, { status: "attended" })).status).toBe(200);
      expect(statusOf(appointment)).toBe("attended");
    });
  });

  describe("funding paths match the web action", () => {
    it("pay-as-you-go needs the lesson paid; free/comped needs nothing; neither takes a package credit", async () => {
      const unpaid = lesson({ billing: "pay_as_you_go", price: 90, paymentStatus: "unpaid" });
      await expectCode(await mark(USERS.frontDesk, unpaid, { status: "attended" }), 409, "payment_required");
      expect(statusOf(unpaid)).toBe("scheduled");
      const paid = lesson({ billing: "pay_as_you_go", price: 90, paymentStatus: "paid" });
      expect((await mark(USERS.frontDesk, paid, { status: "attended" })).status).toBe(200);
      const comped = lesson({ billing: "free_comped" });
      expect((await mark(USERS.frontDesk, comped, { status: "attended" })).status).toBe(200);
      expect(deductions(paid) + deductions(comped)).toBe(0);
    });

    it("membership: attended records one usage row, repeated requests record no more, and an uncovered membership is refused", async () => {
      const appointment = lesson({ billing: "membership", membershipId: MEMBERSHIP });
      const key = `mem-${randomUUID()}`;
      expect((await mark(USERS.frontDesk, appointment, { status: "attended" }, key)).status).toBe(200);
      expect((await mark(USERS.frontDesk, appointment, { status: "attended" }, key)).status).toBe(200);
      const usage = Number(psql(`select count(*) from public.client_membership_usage where reference_type = 'appointment' and reference_id = '${appointment}';`));
      expect(usage, psql(`select coalesce(string_agg(error_message, ' | '), 'no sync errors') from public.membership_usage_sync_errors where appointment_id = '${appointment}';`)).toBe(1);
      const noMembership = lesson({ billing: "membership", membershipId: null, client: ANA });
      psql(`update public.client_memberships set status = 'cancelled' where id = '${MEMBERSHIP}';`);
      try {
        await expectCode(await mark(USERS.frontDesk, noMembership, { status: "attended" }), 409, "payment_required");
      } finally {
        psql(`update public.client_memberships set status = 'active' where id = '${MEMBERSHIP}';`);
      }
    });
  });

  describe("no-show and the terminal outcome rules", () => {
    it("no-show with no charge takes nothing, writes one note, and a replay writes no second note", async () => {
      const pkg = newPackage(3);
      const appointment = lesson({ packageId: pkg });
      const first = await mark(USERS.frontDesk, appointment, { status: "no_show" });
      expect(await first.json()).toEqual({ appointment: { id: appointment, status: "no_show", alreadyApplied: false } });
      const replay = await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "none" });
      expect((await replay.json()).appointment.alreadyApplied).toBe(true);
      expect(remaining(pkg)).toBe(3);
      expect(notes(ANA, `Appointment marked no-show: Lesson`)).toBeGreaterThanOrEqual(1);
      expect(Number(psql(`select count(*) from public.client_activity_notes where client_id = '${ANA}' and occurred_at >= (select updated_at from public.appointments where id = '${appointment}') - interval '1 second' and body like '%Charge policy: No lesson deduction%'`))).toBe(1);
    });

    it("no-show charged to the package takes exactly one credit, even when requested again or raced", async () => {
      const pkg = newPackage(3);
      const appointment = lesson({ packageId: pkg });
      expect((await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" })).status).toBe(200);
      const raced = await Promise.all([1, 2, 3, 4].map(() => mark(USERS.owner, appointment, { status: "no_show", missedAppointmentCharge: "package" })));
      expect(raced.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      expect(remaining(pkg)).toBe(2);
      expect(deductions(appointment)).toBe(1);
    });

    it("no-show charged to a package that is not linked reports charge_failed and leaves the no-show recorded without a deduction", async () => {
      const appointment = lesson({ packageId: null });
      await expectCode(await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" }), 409, "charge_failed");
      expect(statusOf(appointment)).toBe("no_show");
      expect(deductions(appointment)).toBe(0);
    });

    it("attended and no_show are terminal both ways: no flip, no second deduction, no refund", async () => {
      const pkg = newPackage(5);
      const attended = lesson({ packageId: pkg });
      expect((await mark(USERS.frontDesk, attended, { status: "attended" })).status).toBe(200);
      await expectCode(await mark(USERS.frontDesk, attended, { status: "no_show" }), 409, "outcome_conflict");
      expect(statusOf(attended)).toBe("attended");
      expect(remaining(pkg)).toBe(4);

      const missed = lesson({ packageId: pkg });
      expect((await mark(USERS.frontDesk, missed, { status: "no_show" })).status).toBe(200);
      await expectCode(await mark(USERS.frontDesk, missed, { status: "attended" }), 409, "outcome_conflict");
      expect(statusOf(missed)).toBe("no_show");
      expect(remaining(pkg)).toBe(4);
    });
  });

  describe("follow-up review findings", () => {
    it("refuses a no-show replay that asks for a charge that was not applied, and takes nothing", async () => {
      const client = newClient();
      const pkg = newPackage(3, { client });
      const appointment = lesson({ packageId: pkg, client });
      expect((await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "none" })).status).toBe(200);
      const changed = await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" });
      expect(changed.status).toBe(409);
      const body = await changed.json();
      expect(body).toMatchObject({ code: "outcome_conflict", current: { status: "no_show" } });
      expect(remaining(pkg)).toBe(3);
      expect(deductions(appointment)).toBe(0);
      expect(noteCount(client)).toBe(1);
      expect(noteBodies(client)).toContain("Charge policy: No lesson deduction");
    });

    it("repeats an applied charge as a no-op (200, one deduction, one note)", async () => {
      const client = newClient();
      const pkg = newPackage(3, { client });
      const appointment = lesson({ packageId: pkg, client });
      expect((await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" })).status).toBe(200);
      const replay = await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" });
      expect(replay.status).toBe(200);
      expect((await replay.json()).appointment.alreadyApplied).toBe(true);
      expect(remaining(pkg)).toBe(2);
      expect(deductions(appointment)).toBe(1);
      expect(noteCount(client)).toBe(1);
      expect(noteBodies(client)).toContain("Charge policy: Package credit deducted");
    });

    it("a failed charge is retryable: one note, then the same request succeeds with exactly one deduction and the note corrected", async () => {
      const client = newClient();
      const appointment = lesson({ packageId: null, client });
      const failed = await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" });
      expect(failed.status).toBe(409);
      expect(await failed.json()).toMatchObject({ code: "charge_failed", error: "No package is linked to this appointment." });
      expect(noteCount(client)).toBe(1);
      expect(noteBodies(client)).toContain("Package credit requested, not applied");
      // same request again while still unlinked: fails again, still one note
      await expectCode(await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" }), 409, "charge_failed");
      expect(noteCount(client)).toBe(1);
      // the package gets linked (on the web); the same request now succeeds
      const pkg = newPackage(3, { client });
      psql(`update public.appointments set client_package_id = '${pkg}' where id = '${appointment}';`);
      const retry = await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" });
      expect(retry.status).toBe(200);
      expect(remaining(pkg)).toBe(2);
      expect(deductions(appointment)).toBe(1);
      expect(noteCount(client)).toBe(1);
      expect(noteBodies(client)).toContain("Package credit deducted");
      // and repeating it is a no-op
      expect((await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" })).status).toBe(200);
      expect(remaining(pkg)).toBe(2);
    });

    it("after a failed charge, a different decision (none) is allowed; away from an applied charge is not", async () => {
      const client = newClient();
      const unlinked = lesson({ packageId: null, client });
      await expectCode(await mark(USERS.frontDesk, unlinked, { status: "no_show", missedAppointmentCharge: "package" }), 409, "charge_failed");
      expect((await mark(USERS.frontDesk, unlinked, { status: "no_show", missedAppointmentCharge: "none" })).status).toBe(200);
      expect(noteCount(client)).toBe(1);

      const pkg = newPackage(3, { client });
      const charged = lesson({ packageId: pkg, client });
      expect((await mark(USERS.frontDesk, charged, { status: "no_show", missedAppointmentCharge: "package" })).status).toBe(200);
      await expectCode(await mark(USERS.frontDesk, charged, { status: "no_show", missedAppointmentCharge: "none" }), 409, "outcome_conflict");
      await expectCode(await mark(USERS.frontDesk, charged, { status: "no_show", missedAppointmentCharge: "membership" }), 409, "outcome_conflict");
      expect(remaining(pkg)).toBe(2);
      expect(deductions(charged)).toBe(1);
    });

    it("package_exhausted is deterministic: an attended lesson on a spent package answers package_exhausted on every retry, never a deduction", async () => {
      // The state a lost race for the last credit leaves behind, built directly (the deduction trigger is paused only while the row is inserted).
      const pkg = newPackage(0);
      const loser = id();
      psql(`alter table public.appointments disable trigger appointments_deduct_package_credit_attended;
        insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, title, status, billing_type, client_package_id)
          values ('${loser}', '${STUDIO_A}', '${INS}', 'private_lesson', '${ANA}', '${day(1)}', '${day(1, "15:45")}', 'Loser', 'attended', 'package_credit', '${pkg}');
        alter table public.appointments enable trigger appointments_deduct_package_credit_attended;`);
      await expectCode(await mark(USERS.owner, loser, { status: "attended" }), 409, "package_exhausted");
      await expectCode(await mark(USERS.owner, loser, { status: "attended" }), 409, "package_exhausted");
      expect(remaining(pkg)).toBe(0);
      expect(deductions(loser)).toBe(0);
    });

    it("a no-show with no recorded decision is never charged: historical, or interrupted after the status write", async () => {
      const client = newClient();
      const pkg = newPackage(3, { client });
      const appointment = lesson({ packageId: pkg, client });
      psql(`update public.appointments set status = 'no_show' where id = '${appointment}';`); // a historical no-show, or a crash right after the status UPDATE
      for (const charge of ["package", "membership"]) {
        await expectCode(await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: charge }), 409, "outcome_conflict");
      }
      // an older note without the appointment ref line does not count as a decision either
      psql(`insert into public.client_activity_notes (studio_id, client_id, note_type, body, occurred_at)
        values ('${STUDIO_A}', '${client}', 'general', E'Appointment marked no-show: Lesson\\nCharge policy: Package credit requested, not applied', now());`);
      await expectCode(await mark(USERS.owner, appointment, { status: "no_show", missedAppointmentCharge: "package" }), 409, "outcome_conflict");
      // "none" is accepted as a no-op and writes nothing
      const none = await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "none" });
      expect(none.status).toBe(200);
      expect((await none.json()).appointment.alreadyApplied).toBe(true);
      expect(noteCount(client)).toBe(1);
      expect(remaining(pkg)).toBe(3);
      expect(deductions(appointment)).toBe(0);
    });

    it("a charge that fails with database text returns the fixed sentence, never the text", async () => {
      const client = newClient();
      const spent = newPackage(0, { client });
      const appointment = lesson({ packageId: spent, client });
      const failed = await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" });
      expect(failed.status).toBe(409);
      expect(await failed.json()).toMatchObject({ code: "charge_failed", error: "The missed-lesson charge could not be applied." });
      expect(statusOf(appointment)).toBe("no_show");
      expect(deductions(appointment)).toBe(0);
    });

    it("an instructor repeats an applied package charge on their own lesson (the replay gates read under their own RLS), and cannot change it", async () => {
      const client = newClient();
      const pkg = newPackage(3, { client });
      const appointment = lesson({ packageId: pkg, client, instructor: INS });
      expect((await mark(USERS.instructor, appointment, { status: "no_show", missedAppointmentCharge: "package" })).status).toBe(200);
      const replay = await mark(USERS.instructor, appointment, { status: "no_show", missedAppointmentCharge: "package" });
      expect(replay.status).toBe(200);
      expect((await replay.json()).appointment.alreadyApplied).toBe(true);
      await expectCode(await mark(USERS.instructor, appointment, { status: "no_show", missedAppointmentCharge: "none" }), 409, "outcome_conflict");
      expect(remaining(pkg)).toBe(2);
      expect(deductions(appointment)).toBe(1);
      // An instructor's RLS hides client rows, so the note insert is denied (also on DEV): no note, and the replay gates fall back to the deduction marker.
      expect(noteCount(client)).toBe(0);
      // With the note unreadable, a charge that was never applied is refused rather than guessed.
      const unapplied = lesson({ packageId: pkg, client, instructor: INS });
      expect((await mark(USERS.instructor, unapplied, { status: "no_show", missedAppointmentCharge: "none" })).status).toBe(200);
      await expectCode(await mark(USERS.instructor, unapplied, { status: "no_show", missedAppointmentCharge: "package" }), 409, "outcome_conflict");
      expect(deductions(unapplied)).toBe(0);
    });

    it("membership no-show replay: an applied membership charge repeats as 200, one never applied is outcome_conflict", async () => {
      const client = ANA; // the seeded membership belongs to Ana
      const unapplied = lesson({ billing: "membership", membershipId: MEMBERSHIP, client });
      expect((await mark(USERS.frontDesk, unapplied, { status: "no_show", missedAppointmentCharge: "none" })).status).toBe(200);
      await expectCode(await mark(USERS.frontDesk, unapplied, { status: "no_show", missedAppointmentCharge: "membership" }), 409, "outcome_conflict");

      const applied = lesson({ billing: "membership", membershipId: MEMBERSHIP, client });
      psql(`update public.appointments set status = 'no_show' where id = '${applied}';
        insert into public.client_membership_usage (client_membership_id, client_membership_period_id, membership_plan_benefit_id, usage_date, quantity_used, reference_type, reference_id)
          values ('${MEMBERSHIP}', '${PERIOD}', '${BENEFIT}', current_date, 1, 'appointment', '${applied}');`);
      expect((await mark(USERS.frontDesk, applied, { status: "no_show", missedAppointmentCharge: "membership" })).status).toBe(200);
      await expectCode(await mark(USERS.frontDesk, applied, { status: "no_show", missedAppointmentCharge: "none" }), 409, "outcome_conflict");
    });

    it("refuses a replay after the lesson's package link was changed, and takes nothing from the new package", async () => {
      const original = newPackage(3);
      const other = newPackage(3);
      const appointment = lesson({ packageId: original });
      expect((await mark(USERS.frontDesk, appointment, { status: "attended" })).status).toBe(200);
      psql(`update public.appointments set client_package_id = '${other}' where id = '${appointment}';`);
      const replay = await mark(USERS.frontDesk, appointment, { status: "attended" });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({ code: "outcome_conflict", current: { status: "attended" } });
      expect(remaining(original)).toBe(2);
      expect(remaining(other)).toBe(3);
    });

    it("a no-show charged to package X, then relinked to package Y, refuses the replay and takes nothing from Y", async () => {
      const client = newClient();
      const x = newPackage(3, { client });
      const y = newPackage(3, { client });
      const appointment = lesson({ packageId: x, client });
      expect((await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" })).status).toBe(200);
      psql(`update public.appointments set client_package_id = '${y}' where id = '${appointment}';`);
      const replay = await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({ code: "outcome_conflict", current: { status: "no_show" } });
      expect(remaining(x)).toBe(2);
      expect(remaining(y)).toBe(3);
      expect(deductions(appointment)).toBe(1);
    });

    it("a forged or quoting note cannot flip the decision: only the oldest system-shaped note counts", async () => {
      const client = newClient();
      const pkg = newPackage(3, { client });
      const appointment = lesson({ packageId: pkg, client });
      expect((await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "none" })).status).toBe(200);
      // a newer note with the right ref line but another first line, and one that merely quotes the id mid-text, plus a newer full copy claiming 'requested, not applied'
      psql(`insert into public.client_activity_notes (studio_id, client_id, note_type, body, occurred_at, created_at) values
        ('${STUDIO_A}', '${client}', 'general', E'Customer asked about Appointment ref: ${appointment} yesterday', now(), now() + interval '1 second'),
        ('${STUDIO_A}', '${client}', 'general', E'Something else\nCharge policy: Package credit requested, not applied\nAppointment ref: ${appointment}', now(), now() + interval '2 seconds'),
        ('${STUDIO_A}', '${client}', 'general', E'Appointment marked no-show: Lesson\nCharge policy: Package credit requested, not applied\nAppointment ref: ${appointment}', now(), now() + interval '3 seconds');`);
      await expectCode(await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" }), 409, "outcome_conflict");
      expect(remaining(pkg)).toBe(3);
      expect(deductions(appointment)).toBe(0);
    });

    it("a no-charge replay after a failed charge records the decision, so a later charge request is a conflict", async () => {
      const client = newClient();
      const appointment = lesson({ packageId: null, client });
      await expectCode(await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" }), 409, "charge_failed");
      expect((await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "none" })).status).toBe(200);
      expect(noteBodies(client)).toContain("Charge policy: No lesson deduction");
      expect(noteBodies(client)).not.toContain("not applied");
      expect(noteCount(client)).toBe(1);
      const pkg = newPackage(3, { client });
      psql(`update public.appointments set client_package_id = '${pkg}' where id = '${appointment}';`);
      await expectCode(await mark(USERS.frontDesk, appointment, { status: "no_show", missedAppointmentCharge: "package" }), 409, "outcome_conflict");
      expect(remaining(pkg)).toBe(3);
    });

    it("can mark a future-dated lesson, as the web can (the web has no date guard)", async () => {
      const appointment = lesson({ billing: "free_comped" });
      expect(psql(`select (starts_at > now())::text from public.appointments where id = '${appointment}';`)).toBe("true");
      expect((await mark(USERS.frontDesk, appointment, { status: "attended" })).status).toBe(200);
    });
  });

  describe("roles, tenancy and request shape", () => {
    it("lets owner, front desk and the assigned instructor mark; refuses a colleague's lesson as not_found", async () => {
      for (const user of [USERS.owner, USERS.frontDesk, USERS.instructor]) {
        // A package lesson, so the database deduction is exercised under each role's own session (the instructor's RLS and RPC authorization included).
        const pkg = newPackage(2);
        const appointment = lesson({ packageId: pkg });
        expect((await mark(user, appointment, { status: "attended" })).status).toBe(200);
        expect(remaining(pkg)).toBe(1);
        expect(deductions(appointment)).toBe(1);
      }
      const colleagueLesson = lesson({ billing: "free_comped", instructor: INS_COL });
      await expectCode(await mark(USERS.instructor, colleagueLesson, { status: "attended" }), 404, "not_found");
      expect(statusOf(colleagueLesson)).toBe("scheduled");
      expect((await mark(USERS.colleague, colleagueLesson, { status: "attended" })).status).toBe(200);
    });

    it("refuses independent instructors and other studios' staff, and never leaks the other studio's appointment", async () => {
      const appointment = lesson({ billing: "free_comped" });
      await expectCode(await mark(USERS.independent, appointment, { status: "attended" }), 403, "role_not_permitted");
      await expectCode(await mark(USERS.ownerB, appointment, { status: "attended" }, undefined, STUDIO_A), 403, "not_a_member");
      await expectCode(await mark(USERS.ownerB, appointment, { status: "attended" }, undefined, STUDIO_B), 404, "not_found");
      await expectCode(await mark(USERS.owner, appointment, { status: "attended" }, undefined, STUDIO_B), 403, "not_a_member");
      expect(statusOf(appointment)).toBe("scheduled");
    });

    it("refuses group classes, floor rentals and cancelled lessons as not_markable", async () => {
      await expectCode(await mark(USERS.owner, lesson({ type: "group_class", billing: "free_comped" }), { status: "attended" }), 409, "not_markable");
      await expectCode(await mark(USERS.owner, lesson({ type: "floor_space_rental", billing: "free_comped" }), { status: "attended" }), 409, "not_markable");
      await expectCode(await mark(USERS.owner, lesson({ status: "cancelled", billing: "free_comped" }), { status: "attended" }), 409, "not_markable");
    });

    it("is behind the write gate: no app header is 426, a disabled capability is 403", async () => {
      const appointment = lesson({ billing: "free_comped" });
      const noHeader = await attendance(
        new Request(`https://app.test/api/staff/workspaces/${STUDIO_A}/appointments/${appointment}/attendance`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${tokenFor(USERS.owner)}`, "content-type": "application/json", "idempotency-key": "key-12345678" },
          body: JSON.stringify({ status: "attended" }),
        }),
        { params: Promise.resolve({ studioId: STUDIO_A, appointmentId: appointment }) },
      );
      await expectCode(noHeader, 426, "upgrade_required");
      const policy = process.env.STAFF_API_WRITE_POLICY;
      process.env.STAFF_API_WRITE_POLICY = JSON.stringify({ enabled: [] });
      try {
        await expectCode(await mark(USERS.owner, appointment, { status: "attended" }), 403, "writes_disabled");
      } finally {
        process.env.STAFF_API_WRITE_POLICY = policy;
      }
      expect(statusOf(appointment)).toBe("scheduled");
    });

    it("validates the request", async () => {
      const appointment = lesson({ billing: "free_comped" });
      await expectCode(await mark(USERS.owner, appointment, { status: "attended" }, null), 400, "invalid_request");
      await expectCode(await mark(USERS.owner, appointment, { status: "attended" }, "short"), 400, "invalid_request");
      await expectCode(await mark(USERS.owner, appointment, { status: "checked_in" }), 400, "invalid_request");
      await expectCode(await mark(USERS.owner, appointment, { status: "no_show", missedAppointmentCharge: "cash" }), 400, "invalid_request");
      await expectCode(await mark(USERS.owner, appointment, "not json"), 400, "invalid_request");
      await expectCode(await mark(USERS.owner, "not-a-uuid", { status: "attended" }), 400, "invalid_request");
      expect(statusOf(appointment)).toBe("scheduled");
    });
  });
});
