/**
 * Staff API Phase 1A S2: group-class roster drop-in enroll and removal (POST/DELETE .../appointments/{id}/roster) against REAL RLS and the real enroll_class_attendee / cancel_class_attendee RPCs:
 * route handler -> real supabase-js -> Kong -> PostgREST -> Postgres, as the caller's own JWT. LOCAL / DISPOSABLE STACK ONLY; skipped unless the isolated QA harness
 * provides a loopback stack (never run it on a shared database):
 *   node scripts/qa/iso-qa.mjs run baseline -- src/app/api/staff/__tests__/localStack.staffApiClassRoster.test.ts
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
const CLIENTS = Array.from({ length: 10 }, () => id());
const [C1, C2, C3, C4, C5, C6, C7] = CLIENTS;
const OTHER_B = id();
const PLAN = id();
const BENEFIT = id();
const MEMBERSHIP = id();
const day = (days: number, time = "17:00") => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${time}:00Z`;
const APP_HEADER = "business/0.2.0/3/android";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
let enroll: Handler;
let remove: Handler;

const authed = (path: string, user: string, init: RequestInit = {}) =>
  new Request(`https://app.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tokenFor(user)}`, "x-danceflow-app": APP_HEADER, ...(init.headers ?? {}) },
  });

const add = (user: string, classId: string, body: unknown, key: string | null = `key-${randomUUID()}`, studioId = STUDIO_A) =>
  enroll(
    authed(`/api/staff/workspaces/${studioId}/appointments/${classId}/roster`, user, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ studioId, appointmentId: classId }) },
  );
const drop = (user: string, classId: string, clientId: string, key: string | null = `key-${randomUUID()}`, studioId = STUDIO_A) =>
  remove(
    authed(`/api/staff/workspaces/${studioId}/appointments/${classId}/roster/${clientId}`, user, {
      method: "DELETE",
      headers: key ? { "idempotency-key": key } : {},
    }),
    { params: Promise.resolve({ studioId, appointmentId: classId, clientId }) },
  );

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((await response.json()).code).toBe(code);
}

function newClass(options: { capacity?: number | null; instructor?: string; status?: string; studio?: string } = {}) {
  const classId = id();
  const { capacity = 12, instructor = INS, status = "scheduled", studio = STUDIO_A } = options;
  psql(`insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, title, status, billing_type, roster_capacity)
    values ('${classId}', '${studio}', '${instructor}', 'group_class', null, '${day(2)}', '${day(2, "18:00")}', 'Salsa', '${status}', 'package_credit', ${capacity ?? "null"});`);
  return classId;
}
const booked = (classId: string) => Number(psql(`select count(*) from public.appointment_attendees where appointment_id = '${classId}' and status = 'booked';`));
const rowsFor = (classId: string, clientId: string) => Number(psql(`select count(*) from public.appointment_attendees where appointment_id = '${classId}' and client_id = '${clientId}';`));
const attendeeOf = (classId: string, clientId: string) => psql(`select id from public.appointment_attendees where appointment_id = '${classId}' and client_id = '${clientId}' order by created_at desc limit 1;`);

describe.skipIf(!enabled)("staff API class roster against real RLS and the enroll / cancel RPCs", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = sign({ role: "anon", exp: exp() });
    process.env.SUPABASE_SERVICE_ROLE_KEY = sign({ role: "service_role", exp: exp() });
    process.env.STAFF_API_WRITE_POLICY = JSON.stringify({ enabled: ["classRoster"] });

    const role = (user: string, studio: string, value: string) => `('${user}', '${studio}', '${value}', true)`;
    psql(`begin;
      set local session_replication_role = replica;
      ${Object.values(USERS).map((u) => `insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id, full_name) values ('${u}', 'QA');`).join("\n")}
      insert into public.studios (id, name, slug, subscription_status, timezone) values
        ('${STUDIO_A}', 'Roster Studio A', 'ra-${STUDIO_A.slice(0, 8)}', 'active', 'America/Chicago'),
        ('${STUDIO_B}', 'Roster Studio B', 'rb-${STUDIO_B.slice(0, 8)}', 'active', 'America/Chicago');
      insert into public.studio_settings (studio_id) values ('${STUDIO_A}'), ('${STUDIO_B}');
      insert into public.user_studio_roles (user_id, studio_id, role, active) values
        ${[role(USERS.owner, STUDIO_A, "studio_owner"), role(USERS.frontDesk, STUDIO_A, "front_desk"), role(USERS.instructor, STUDIO_A, "instructor"),
          role(USERS.colleague, STUDIO_A, "instructor"), role(USERS.independent, STUDIO_A, "independent_instructor"), role(USERS.ownerB, STUDIO_B, "studio_owner")].join(",\n")};
      insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
        ('${INS}', '${STUDIO_A}', '${USERS.instructor}', 'Ida', 'Teacher', true, true),
        ('${INS_COL}', '${STUDIO_A}', '${USERS.colleague}', 'Cole', 'Teacher', true, true);
      insert into public.clients (id, studio_id, first_name, last_name, status) values
        ${CLIENTS.map((c, i) => `('${c}', '${STUDIO_A}', 'Dancer${i}', 'Roster', 'active')`).join(",\n")},
        ('${OTHER_B}', '${STUDIO_B}', 'Bea', 'Brook', 'active');
      insert into public.membership_plans (id, studio_id, name, active, billing_interval, price) values ('${PLAN}', '${STUDIO_A}', 'Gold', true, 'monthly', 100);
      insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, usage_period, applies_to) values ('${BENEFIT}', '${PLAN}', 'included_group_classes', 4, 'monthly', 'all');
      insert into public.client_memberships (id, studio_id, client_id, membership_plan_id, status, starts_on, current_period_start, current_period_end, name_snapshot, billing_interval_snapshot)
        values ('${MEMBERSHIP}', '${STUDIO_A}', '${C5}', '${PLAN}', 'active', current_date - 20, current_date - 20, current_date + 40, 'Gold', 'monthly');
      insert into public.client_membership_periods (studio_id, client_id, client_membership_id, period_start, period_end, payment_status)
        values ('${STUDIO_A}', '${C5}', '${MEMBERSHIP}', current_date - 20, current_date + 40, 'paid');
      commit;`);

    enroll = (await import("../workspaces/[studioId]/appointments/[appointmentId]/roster/route")).POST as unknown as Handler;
    remove = (await import("../workspaces/[studioId]/appointments/[appointmentId]/roster/[clientId]/route")).DELETE as unknown as Handler;
  });

  describe("enroll", () => {
    it("enrolls a dancer (201) and answers a replay with the same attendee (200), never a second row", async () => {
      const classId = newClass();
      const key = `enroll-${randomUUID()}`;
      const first = await add(USERS.frontDesk, classId, { clientId: C1, billingType: "free_comped" }, key);
      expect(first.status).toBe(201);
      const created = (await first.json()).attendee;
      expect(created).toMatchObject({ clientId: C1, alreadyEnrolled: false });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const replay = await add(USERS.frontDesk, classId, { clientId: C1, billingType: "free_comped" }, key);
        expect(replay.status).toBe(200);
        expect((await replay.json()).attendee).toEqual({ id: created.id, clientId: C1, alreadyEnrolled: true });
      }
      expect(rowsFor(classId, C1)).toBe(1);
    });

    it("keeps one row when the same enroll races", async () => {
      const classId = newClass();
      const responses = await Promise.all(Array.from({ length: 5 }, () => add(USERS.owner, classId, { clientId: C2, billingType: "free_comped" })));
      expect(responses.every((response) => response.status === 201 || response.status === 200)).toBe(true);
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(rowsFor(classId, C2)).toBe(1);
      expect(booked(classId)).toBe(1);
    });

    it("never goes over capacity: a full class refuses with class_full, and a race for the last seat has one winner", async () => {
      const full = newClass({ capacity: 2 });
      expect((await add(USERS.owner, full, { clientId: C1, billingType: "free_comped" })).status).toBe(201);
      expect((await add(USERS.owner, full, { clientId: C2, billingType: "free_comped" })).status).toBe(201);
      await expectCode(await add(USERS.owner, full, { clientId: C3, billingType: "free_comped" }), 409, "class_full");
      expect(booked(full)).toBe(2);

      const lastSeat = newClass({ capacity: 1 });
      const responses = await Promise.all([C3, C4, C5, C6, C7].map((client) => add(USERS.frontDesk, lastSeat, { clientId: client, billingType: "free_comped" })));
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(4);
      expect(booked(lastSeat)).toBe(1);
    });

    it("refuses a cancelled class", async () => {
      const cancelled = newClass({ status: "cancelled" });
      await expectCode(await add(USERS.owner, cancelled, { clientId: C1, billingType: "free_comped" }), 409, "class_cancelled");
      expect(booked(cancelled)).toBe(0);
    });

    it("membership funding: needs a membership id, then enrolls when the plan covers group classes", async () => {
      const classId = newClass();
      await expectCode(await add(USERS.owner, classId, { clientId: C5, billingType: "membership" }), 400, "invalid_request");
      expect((await add(USERS.owner, classId, { clientId: C5, billingType: "membership", clientMembershipId: MEMBERSHIP })).status).toBe(201);
      expect(Number(psql(`select count(*) from public.appointment_attendees where appointment_id = '${classId}' and client_id = '${C5}' and billing_type = 'membership';`))).toBe(1);
      // A dancer with no membership at all has nothing to bill.
      const other = newClass();
      await expectCode(await add(USERS.owner, other, { clientId: C6, billingType: "membership", clientMembershipId: MEMBERSHIP }), 409, "invalid_funding");
      expect(booked(other)).toBe(0);
    });

    it("package funding: another dancer's package is refused; the dancer's own package enrolls them and is not charged until attendance", async () => {
      const classId = newClass();
      const pkg = id();
      psql(`insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, expiration_date, sold_price) values ('${pkg}', '${STUDIO_A}', '${C6}', 'Class pack', true, '${day(60).slice(0, 10)}', 80);
        insert into public.client_package_items (studio_id, client_package_id, usage_type, quantity_remaining, quantity_total, is_unlimited) values ('${STUDIO_A}', '${pkg}', 'group_class', 3, 4, false);`);
      await expectCode(await add(USERS.owner, classId, { clientId: C1, billingType: "package_credit", clientPackageId: pkg }), 409, "invalid_funding");
      expect(booked(classId)).toBe(0);
      expect((await add(USERS.owner, classId, { clientId: C6, billingType: "package_credit", clientPackageId: pkg })).status).toBe(201);
      expect(booked(classId)).toBe(1);
      expect(Number(psql(`select quantity_remaining from public.client_package_items where client_package_id = '${pkg}' and usage_type = 'group_class';`))).toBe(3);
    });
  });

  describe("remove", () => {
    it("removes a booked dancer, answers a replay with alreadyApplied, and frees the seat", async () => {
      const classId = newClass({ capacity: 1 });
      expect((await add(USERS.owner, classId, { clientId: C1, billingType: "free_comped" })).status).toBe(201);
      const first = await drop(USERS.frontDesk, classId, C1);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ removed: true, alreadyApplied: false });
      const replay = await drop(USERS.frontDesk, classId, C1);
      expect(await replay.json()).toEqual({ removed: true, alreadyApplied: true });
      expect(booked(classId)).toBe(0);
      expect((await add(USERS.owner, classId, { clientId: C2, billingType: "free_comped" })).status).toBe(201);
    });

    it("refuses removing a dancer whose attendance is recorded, and a dancer who was never enrolled", async () => {
      const classId = newClass();
      expect((await add(USERS.owner, classId, { clientId: C3, billingType: "free_comped" })).status).toBe(201);
      psql(`insert into public.attendance_records (studio_id, appointment_id, client_id, status, marked_attended_at) values ('${STUDIO_A}', '${classId}', '${C3}', 'attended', now());`);
      await expectCode(await drop(USERS.owner, classId, C3), 409, "attendance_recorded");
      expect(booked(classId)).toBe(1);
      await expectCode(await drop(USERS.owner, classId, C4), 404, "not_found");
    });

    it("can re-enroll a dancer after removal", async () => {
      const classId = newClass();
      expect((await add(USERS.owner, classId, { clientId: C4, billingType: "free_comped" })).status).toBe(201);
      expect((await drop(USERS.owner, classId, C4)).status).toBe(200);
      expect((await add(USERS.owner, classId, { clientId: C4, billingType: "free_comped" })).status).toBe(201);
      expect(booked(classId)).toBe(1);
      expect(attendeeOf(classId, C4)).not.toBe("");
    });
  });

  describe("roles, tenancy, gate and request shape", () => {
    it("lets owner, front desk and the assigned instructor change the roster, and keeps a colleague out of it", async () => {
      for (const user of [USERS.owner, USERS.frontDesk]) {
        const classId = newClass();
        expect((await add(user, classId, { clientId: C1, billingType: "free_comped" })).status).toBe(201);
        expect((await drop(user, classId, C1)).status).toBe(200);
      }
      // An instructor's billing choice is ignored by the database: they can enroll only a dancer with exactly one eligible package or membership.
      const ownClass = newClass();
      await expectCode(await add(USERS.instructor, ownClass, { clientId: C1, billingType: "free_comped" }), 409, "ambiguous_funding_source");
      expect(booked(ownClass)).toBe(0);
      const onePackage = id();
      psql(`insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, expiration_date, sold_price) values ('${onePackage}', '${STUDIO_A}', '${C7}', 'Class pack', true, '${day(60).slice(0, 10)}', 80);
        insert into public.client_package_items (studio_id, client_package_id, usage_type, quantity_remaining, quantity_total, is_unlimited) values ('${STUDIO_A}', '${onePackage}', 'group_class', 3, 4, false);`);
      expect((await add(USERS.instructor, ownClass, { clientId: C7 })).status).toBe(201);
      expect((await drop(USERS.instructor, ownClass, C7)).status).toBe(200);
      const colleagueClass = newClass({ instructor: INS_COL });
      await expectCode(await add(USERS.instructor, colleagueClass, { clientId: C1, billingType: "free_comped" }), 404, "not_found");
      expect(booked(colleagueClass)).toBe(0);
      expect((await add(USERS.owner, colleagueClass, { clientId: C1, billingType: "free_comped" })).status).toBe(201);
      await expectCode(await drop(USERS.instructor, colleagueClass, C1), 404, "not_found");
      expect(booked(colleagueClass)).toBe(1);
    });

    it("refuses independent instructors and other studios, and never touches another studio's class", async () => {
      const classId = newClass();
      await expectCode(await add(USERS.independent, classId, { clientId: C1, billingType: "free_comped" }), 403, "role_not_permitted");
      await expectCode(await drop(USERS.independent, classId, C1), 403, "role_not_permitted");
      await expectCode(await add(USERS.ownerB, classId, { clientId: C1, billingType: "free_comped" }, undefined, STUDIO_A), 403, "not_a_member");
      await expectCode(await add(USERS.ownerB, classId, { clientId: OTHER_B, billingType: "free_comped" }, undefined, STUDIO_B), 404, "not_found");
      await expectCode(await add(USERS.owner, classId, { clientId: OTHER_B, billingType: "free_comped" }), 404, "not_found");
      expect(booked(classId)).toBe(0);
    });

    it("answers a private lesson, a missing class and a client of another studio as not_found", async () => {
      const lessonId = id();
      psql(`insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, title, status, billing_type)
        values ('${lessonId}', '${STUDIO_A}', '${INS}', 'private_lesson', '${C1}', '${day(1)}', '${day(1, "18:00")}', 'L', 'scheduled', 'free_comped');`);
      await expectCode(await add(USERS.owner, lessonId, { clientId: C2, billingType: "free_comped" }), 404, "not_found");
      await expectCode(await add(USERS.owner, id(), { clientId: C2, billingType: "free_comped" }), 404, "not_found");
      await expectCode(await drop(USERS.owner, lessonId, C1), 404, "not_found");
    });

    it("is behind the write gate: no app header is 426, a disabled capability is 403", async () => {
      const classId = newClass();
      const noHeader = await enroll(
        new Request(`https://app.test/api/staff/workspaces/${STUDIO_A}/appointments/${classId}/roster`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenFor(USERS.owner)}`, "content-type": "application/json", "idempotency-key": "key-12345678" },
          body: JSON.stringify({ clientId: C1, billingType: "free_comped" }),
        }),
        { params: Promise.resolve({ studioId: STUDIO_A, appointmentId: classId }) },
      );
      await expectCode(noHeader, 426, "upgrade_required");
      const policy = process.env.STAFF_API_WRITE_POLICY;
      process.env.STAFF_API_WRITE_POLICY = JSON.stringify({ enabled: [] });
      try {
        await expectCode(await add(USERS.owner, classId, { clientId: C1, billingType: "free_comped" }), 403, "writes_disabled");
        await expectCode(await drop(USERS.owner, classId, C1), 403, "writes_disabled");
      } finally {
        process.env.STAFF_API_WRITE_POLICY = policy;
      }
      expect(booked(classId)).toBe(0);
    });

    it("validates the request", async () => {
      const classId = newClass();
      await expectCode(await add(USERS.owner, classId, { clientId: C1 }, null), 400, "invalid_request");
      await expectCode(await add(USERS.owner, classId, "not json"), 400, "invalid_request");
      await expectCode(await add(USERS.owner, classId, {}), 400, "invalid_request");
      await expectCode(await add(USERS.owner, classId, { clientId: "nope" }), 400, "invalid_request");
      await expectCode(await add(USERS.owner, classId, { clientId: C1, billingType: "cash" }), 400, "invalid_request");
      await expectCode(await add(USERS.owner, classId, { clientId: C1, clientPackageId: "nope" }), 400, "invalid_request");
      await expectCode(await add(USERS.owner, "not-a-uuid", { clientId: C1 }), 400, "invalid_request");
      await expectCode(await drop(USERS.owner, classId, C1, null), 400, "invalid_request");
      await expectCode(await drop(USERS.owner, classId, "nope"), 400, "invalid_request");
      expect(booked(classId)).toBe(0);
    });
  });
});
