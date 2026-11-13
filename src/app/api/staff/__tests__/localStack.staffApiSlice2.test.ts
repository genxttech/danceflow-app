/**
 * Staff API slice 2 (client lookup, client summary, attendance PUT, studio timeZone) against REAL RLS: route handler -> real supabase-js -> Kong -> PostgREST ->
 * Postgres, as the caller's own JWT. LOCAL / DISPOSABLE STACK ONLY; skipped unless the isolated QA harness provides a loopback stack:
 *   node scripts/qa/iso-qa.mjs run baseline -- src/app/api/staff/__tests__/localStack.staffApiSlice2.test.ts
 * (apply migrations above the baseline cutoff, including 20270214120000, first). auth.getUser is the one stand-in: the stack has no GoTrue,
 * so it checks the HS256 signature and expiry. Real GoTrue tokens over HTTP are covered by scripts/qa/staff-api/http-qa.mjs.
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
const USERS = { owner: id(), frontDesk: id(), instructor: id(), colleague: id(), independent: id(), instructorB: id(), renter: id() };
const INS = id();
const INS_COL = id();
const INS_B = id();
const ANA = id(); // own private-lesson student of INS, also booked in INS's class
const COLIN = id(); // class-only student
const DEE = id(); // removed from the class
const LEE = id(); // a lead, not active
const PCT = id(); // a name with LIKE wildcards in it
const BEA = id(); // studio B
const PAGE_CLIENTS = Array.from({ length: 7 }, () => id());
const LESSON = id();
const COLLEAGUE_LESSON = id(); // Ana with the colleague, sooner than anything with INS
const RENTER_CLIENT = id();
const RENTAL = id();
const CLASS = id();
const CANCELLED_CLASS = id();
const COLLEAGUE_CLASS = id();
const PKG_ACTIVE = id();
const PKG_EXPIRED = id();
const PKG_ARCHIVED = id();
const DAY_OFFSET = (days: number, time: string) => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${time}:00Z`;

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
let routes: { me: (r: Request) => Promise<Response>; detail: Handler; clients: Handler; client: Handler; attendance: Handler };

const authed = (path: string, user: string, init: RequestInit = {}) =>
  new Request(`https://app.test${path}`, { ...init, headers: { Authorization: `Bearer ${tokenFor(user)}`, ...(init.headers ?? {}) } });

const search = (user: string, query = "", studioId = STUDIO_A) =>
  routes.clients(authed(`/api/staff/workspaces/${studioId}/clients${query}`, user), { params: Promise.resolve({ studioId }) });
const summary = (user: string, clientId: string, studioId = STUDIO_A) =>
  routes.client(authed(`/api/staff/workspaces/${studioId}/clients/${clientId}`, user), { params: Promise.resolve({ studioId, clientId }) });
const mark = (user: string, appointmentId: string, clientId: string, body: unknown, key: string | null = `key-${randomUUID()}`) =>
  routes.attendance(
    authed(`/api/staff/workspaces/${STUDIO_A}/appointments/${appointmentId}/attendance/${clientId}`, user, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ studioId: STUDIO_A, appointmentId, clientId }) },
  );

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((await response.json()).code).toBe(code);
}

const attendanceRow = (clientId: string, appointmentId = CLASS) =>
  psql(`select status || '|' || coalesce(created_by::text, '') || '|' || (marked_attended_at is not null)::text || '|' || updated_at from public.attendance_records where appointment_id = '${appointmentId}' and client_id = '${clientId}';`);

describe.skipIf(!enabled)("staff API slice 2 against real RLS", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = sign({ role: "anon", exp: exp() });
    process.env.SUPABASE_SERVICE_ROLE_KEY = sign({ role: "service_role", exp: exp() });

    const users = Object.values(USERS);
    const role = (user: string, studio: string, value: string) => `('${user}', '${studio}', '${value}', true)`;
    const client = (rowId: string, studio: string, first: string, last: string, status = "active") =>
      `('${rowId}', '${studio}', '${first.replace(/'/g, "''")}', '${last}', '${status}', '${first.toLowerCase().replace(/[^a-z]/g, "")}@example.test', '555-0199', 'secret-referral')`;

    psql(`begin;
      set local session_replication_role = replica;
      ${users.map((u) => `insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id, full_name) values ('${u}', 'QA');`).join("\n")}
      insert into public.studios (id, name, slug, subscription_status, timezone) values
        ('${STUDIO_A}', 'Slice2 Studio A', 's2a-${STUDIO_A.slice(0, 8)}', 'active', 'America/Chicago'),
        ('${STUDIO_B}', 'Slice2 Studio B', 's2b-${STUDIO_B.slice(0, 8)}', 'active', 'Not/AZone');
      insert into public.user_studio_roles (user_id, studio_id, role, active) values
        ${[role(USERS.owner, STUDIO_A, "studio_owner"), role(USERS.frontDesk, STUDIO_A, "front_desk"), role(USERS.instructor, STUDIO_A, "instructor"),
          role(USERS.colleague, STUDIO_A, "instructor"), role(USERS.independent, STUDIO_A, "independent_instructor"), role(USERS.instructorB, STUDIO_B, "instructor"),
          role(USERS.renter, STUDIO_A, "instructor")].join(",\n")};
      insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
        ('${INS}', '${STUDIO_A}', '${USERS.instructor}', 'Ida', 'Teacher', true, true),
        ('${INS_COL}', '${STUDIO_A}', '${USERS.colleague}', 'Cole', 'Teacher', true, true),
        ('${INS_B}', '${STUDIO_B}', '${USERS.instructorB}', 'Bo', 'Teacher', true, true);
      insert into public.clients (id, studio_id, first_name, last_name, status, email, phone, referral_source) values
        ${[client(ANA, STUDIO_A, "Ana", "Alvarez"), client(COLIN, STUDIO_A, "Colin", "Brook"), client(DEE, STUDIO_A, "Dee", "Carter"),
          client(LEE, STUDIO_A, "Lee", "Dunn", "lead"), client(PCT, STUDIO_A, "Pat_100%", "Evans"), client(BEA, STUDIO_A === STUDIO_B ? STUDIO_A : STUDIO_B, "Bea", "Alvarez"),
          ...PAGE_CLIENTS.map((c, i) => client(c, STUDIO_A, `Page${i}`, "Zed")), client(RENTER_CLIENT, STUDIO_A, "Rene", "Renter")].join(",\n")};
      insert into public.client_account_links (studio_id, client_id, user_id, status) values ('${STUDIO_A}', '${RENTER_CLIENT}', '${USERS.renter}', 'linked');
      insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, title, status, price_amount, payment_status, roster_capacity) values
        ('${LESSON}', '${STUDIO_A}', '${INS}', 'private_lesson', '${ANA}', '${DAY_OFFSET(3, "15:00")}', '${DAY_OFFSET(3, "15:45")}', 'Ana lesson', 'scheduled', 125, 'unpaid', null),
        ('${CLASS}', '${STUDIO_A}', '${INS}', 'group_class', null, '${DAY_OFFSET(2, "17:00")}', '${DAY_OFFSET(2, "18:00")}', 'Salsa', 'scheduled', null, 'unpaid', 12),
        ('${CANCELLED_CLASS}', '${STUDIO_A}', '${INS}', 'group_class', null, '${DAY_OFFSET(4, "17:00")}', '${DAY_OFFSET(4, "18:00")}', 'Cancelled', 'cancelled', null, 'unpaid', 12),
        ('${COLLEAGUE_CLASS}', '${STUDIO_A}', '${INS_COL}', 'group_class', null, '${DAY_OFFSET(2, "19:00")}', '${DAY_OFFSET(2, "20:00")}', 'Waltz', 'scheduled', null, 'unpaid', 12),
        ('${COLLEAGUE_LESSON}', '${STUDIO_A}', '${INS_COL}', 'private_lesson', '${ANA}', '${DAY_OFFSET(1, "15:00")}', '${DAY_OFFSET(1, "15:45")}', 'Colleague lesson', 'scheduled', 90, 'unpaid', null),
        ('${RENTAL}', '${STUDIO_A}', null, 'floor_space_rental', '${RENTER_CLIENT}', '${DAY_OFFSET(2, "10:00")}', '${DAY_OFFSET(2, "11:00")}', 'Rental', 'scheduled', 40, 'unpaid', null);
      insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status, cancelled_at) values
        ('${STUDIO_A}', '${CLASS}', '${ANA}', 'staff', 'booked', null),
        ('${STUDIO_A}', '${CLASS}', '${COLIN}', 'staff', 'booked', null),
        ('${STUDIO_A}', '${CLASS}', '${DEE}', 'staff', 'cancelled', now()),
        ('${STUDIO_A}', '${CANCELLED_CLASS}', '${ANA}', 'staff', 'booked', null),
        ('${STUDIO_A}', '${COLLEAGUE_CLASS}', '${COLIN}', 'staff', 'booked', null);
      insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, archived_at, expiration_date, sold_price) values
        ('${PKG_ACTIVE}', '${STUDIO_A}', '${ANA}', '10 Private Lessons', true, null, '${DAY_OFFSET(60, "00:00").slice(0, 10)}', 900),
        ('${PKG_EXPIRED}', '${STUDIO_A}', '${ANA}', 'Old Package', true, null, '2020-01-01', 500),
        ('${PKG_ARCHIVED}', '${STUDIO_A}', '${ANA}', 'Archived Package', true, now(), null, 400);
      insert into public.client_package_items (studio_id, client_package_id, usage_type, quantity_remaining, quantity_total, is_unlimited) values
        ('${STUDIO_A}', '${PKG_ACTIVE}', 'private_lesson', 4, 10, false), ('${STUDIO_A}', '${PKG_ACTIVE}', 'group_class', null, null, true);
      commit;`);

    routes = {
      me: (await import("../me/route")).GET,
      detail: (await import("../workspaces/[studioId]/appointments/[appointmentId]/route")).GET as unknown as Handler,
      clients: (await import("../workspaces/[studioId]/clients/route")).GET as unknown as Handler,
      client: (await import("../workspaces/[studioId]/clients/[clientId]/route")).GET as unknown as Handler,
      attendance: (await import("../workspaces/[studioId]/appointments/[appointmentId]/attendance/[clientId]/route")).PUT as unknown as Handler,
    };
  });

  describe("timeZone and timestamps", () => {
    it("reports the studio zone on /me and falls back for a studio without one", async () => {
      const own = await (await routes.me(authed("/api/staff/me", USERS.owner))).json();
      expect(own.workspaces[0].timeZone).toBe("America/Chicago");
      const b = await (await routes.me(authed("/api/staff/me", USERS.instructorB))).json();
      expect(b.workspaces[0].timeZone).toBe("America/New_York");
    });

    it("reports the zone on appointment detail and returns UTC Z timestamps", async () => {
      const body = await (
        await routes.detail(authed(`/api/staff/workspaces/${STUDIO_A}/appointments/${LESSON}`, USERS.instructor), {
          params: Promise.resolve({ studioId: STUDIO_A, appointmentId: LESSON }),
        })
      ).json();
      expect(body.timeZone).toBe("America/Chicago");
      expect(body.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(body.endsAt).toMatch(/\.000Z$/);
    });
  });

  describe("client search", () => {
    it("gives front desk the studio's active clients only, ordered, with no contact or money fields", async () => {
      const response = await search(USERS.frontDesk, "?limit=50");
      expect(response.status).toBe(200);
      const body = await response.json();
      const ids = body.clients.map((c: { id: string }) => c.id);
      expect(ids).toEqual(expect.arrayContaining([ANA, COLIN, DEE, PCT]));
      expect(ids).not.toContain(LEE); // a lead
      expect(ids).not.toContain(BEA); // studio B
      expect(body.clients.every((c: { status: string }) => c.status === "active")).toBe(true);
      expect(Object.keys(body.clients[0]).sort()).toEqual(["firstName", "id", "lastName", "status"]);
      expect(JSON.stringify(body)).not.toMatch(/example\.test|555-|referral|price/);
      const names = body.clients.map((c: { lastName: string }) => c.lastName);
      expect(names).toEqual([...names].sort());
    });

    it("matches q case-insensitively and treats wildcard characters literally", async () => {
      const alv = await (await search(USERS.frontDesk, "?q=alVAR")).json();
      expect(alv.clients.map((c: { id: string }) => c.id)).toEqual([ANA]);
      const pct = await (await search(USERS.frontDesk, `?q=${encodeURIComponent("_100%")}`)).json();
      expect(pct.clients.map((c: { id: string }) => c.id)).toEqual([PCT]);
      const percentOnly = await (await search(USERS.frontDesk, `?q=${encodeURIComponent("%")}`)).json();
      expect(percentOnly.clients.map((c: { id: string }) => c.id)).toEqual([PCT]);
      const odd = await search(USERS.frontDesk, `?q=${encodeURIComponent('a,b)"(\\')}`);
      expect(odd.status).toBe(200);
      expect((await odd.json()).clients).toEqual([]);
    });

    it("pages with an opaque cursor without gaps or repeats", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = `?q=Zed&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const body = (await (await search(USERS.frontDesk, query)).json()) as { clients: { id: string }[]; nextCursor: string | null };
        seen.push(...body.clients.map((c) => c.id));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(7);
      expect([...seen].sort()).toEqual([...PAGE_CLIENTS].sort());
    });

    it("gives an instructor only the clients they teach, with no status", async () => {
      const body = await (await search(USERS.instructor)).json();
      expect(body.clients).toEqual([{ id: ANA, firstName: "Ana", lastName: "Alvarez", status: null }]);
      // The colleague teaches Ana a lesson; Colin is only booked in the colleague's class, which the teaching rule does not cover.
      const colleague = await (await search(USERS.colleague)).json();
      expect(colleague.clients.map((c: { id: string }) => c.id)).toEqual([ANA]);
    });

    it("refuses other roles and bad parameters", async () => {
      await expectCode(await search(USERS.independent), 403, "role_not_permitted");
      await expectCode(await search(USERS.instructorB), 403, "not_a_member");
      await expectCode(await search(USERS.frontDesk, "?limit=0"), 400, "invalid_request");
      await expectCode(await search(USERS.frontDesk, "?limit=51"), 400, "invalid_request");
      await expectCode(await search(USERS.frontDesk, "?cursor=not-a-cursor"), 400, "invalid_request");
      await expectCode(await search(USERS.frontDesk, `?q=${"x".repeat(81)}`), 400, "invalid_request");
    });
  });

  describe("client summary", () => {
    it("gives front desk names, status, active packages with remaining counts, and the next appointment with the zone", async () => {
      const response = await summary(USERS.frontDesk, ANA);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.client).toEqual({ id: ANA, firstName: "Ana", lastName: "Alvarez", status: "active" });
      expect(body.timeZone).toBe("America/Chicago");
      expect(body.activePackages).toEqual([
        {
          id: PKG_ACTIVE,
          name: "10 Private Lessons",
          expiresOn: DAY_OFFSET(60, "00:00").slice(0, 10),
          items: expect.arrayContaining([
            { usageType: "private_lesson", remaining: 4, unlimited: false },
            { usageType: "group_class", remaining: null, unlimited: true },
          ]),
        },
      ]);
      // The colleague lesson (1 day out) beats the class (2 days) and the lesson (3 days); the cancelled class never counts.
      expect(body.nextAppointment).toMatchObject({ id: COLLEAGUE_LESSON, appointmentType: "private_lesson", title: "Colleague lesson" });
      expect(body.nextAppointment.startsAt).toMatch(/Z$/);
      expect(JSON.stringify(body)).not.toMatch(/example\.test|555-|referral|price|900|quantity_total/);
    });

    it("gives an instructor their own student's summary without status or packages", async () => {
      const body = await (await summary(USERS.instructor, ANA)).json();
      expect(body.client).toEqual({ id: ANA, firstName: "Ana", lastName: "Alvarez", status: null });
      expect(body.activePackages).toBeNull();
      // Only the instructor's own appointments with the student: the sooner colleague lesson is not theirs.
      expect(body.nextAppointment).toMatchObject({ id: CLASS });
    });

    it("answers 404 for a client the instructor does not teach, another studio's client, and a missing one", async () => {
      await expectCode(await summary(USERS.instructor, LEE), 404, "not_found");
      await expectCode(await summary(USERS.colleague, COLIN), 404, "not_found");
      await expectCode(await summary(USERS.frontDesk, BEA), 404, "not_found");
      await expectCode(await summary(USERS.frontDesk, id()), 404, "not_found");
    });

    it("lets front desk open a lead's summary, which is not limited to active clients", async () => {
      const body = await (await summary(USERS.frontDesk, LEE)).json();
      expect(body.client.status).toBe("lead");
      expect(body.nextAppointment).toBeNull();
      expect(body.activePackages).toEqual([]);
    });
  });

  describe("attendance PUT", () => {
    it("lets the assigned instructor mark a booked dancer present, with the web action's timestamps and creator", async () => {
      const response = await mark(USERS.instructor, CLASS, COLIN, { status: "attended" });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.attendee).toMatchObject({ clientId: COLIN, displayName: "Colin Brook", status: "attended" });
      expect(body.attendee.updatedAt).toMatch(/Z$/);
      const [status, createdBy, marked] = attendanceRow(COLIN).split("|");
      expect([status, createdBy, marked]).toEqual(["attended", USERS.instructor, "true"]);
    });

    it("writes nothing when the dancer already has the requested status", async () => {
      const before = attendanceRow(COLIN);
      const response = await mark(USERS.instructor, CLASS, COLIN, { status: "attended" });
      expect(response.status).toBe(200);
      expect(attendanceRow(COLIN)).toBe(before);
    });

    it("switches to no_show and clears the attended timestamp", async () => {
      const body = await (await mark(USERS.instructor, CLASS, COLIN, { status: "no_show" })).json();
      expect(body.attendee.status).toBe("no_show");
      expect(attendanceRow(COLIN).split("|").slice(0, 3)).toEqual(["no_show", USERS.instructor, "false"]);
    });

    it("lets front desk and the owner mark any class in the studio", async () => {
      expect((await mark(USERS.frontDesk, CLASS, ANA, { status: "attended" })).status).toBe(200);
      expect((await mark(USERS.owner, COLLEAGUE_CLASS, COLIN, { status: "attended" })).status).toBe(200);
    });

    it("refuses a colleague instructor, a dancer not booked on the class, and a missing class with the same 404", async () => {
      await expectCode(await mark(USERS.colleague, CLASS, ANA, { status: "attended" }), 404, "not_found");
      await expectCode(await mark(USERS.instructor, CLASS, DEE, { status: "attended" }), 404, "not_found");
      await expectCode(await mark(USERS.instructor, CLASS, LEE, { status: "attended" }), 404, "not_found");
      await expectCode(await mark(USERS.instructor, id(), ANA, { status: "attended" }), 404, "not_found");
      expect(attendanceRow(DEE)).toBe("");
    });

    it("never lets a floor-rental relationship authorize attendance, answering 404 rather than revealing the rental", async () => {
      await expectCode(await mark(USERS.renter, RENTAL, RENTER_CLIENT, { status: "attended" }), 404, "not_found");
    });

    it("answers 409 for a cancelled class and for a lesson", async () => {
      await expectCode(await mark(USERS.instructor, CANCELLED_CLASS, ANA, { status: "attended" }), 409, "not_markable");
      await expectCode(await mark(USERS.owner, LESSON, ANA, { status: "attended" }), 409, "not_markable");
      expect(attendanceRow(ANA, CANCELLED_CLASS)).toBe("");
    });

    it("refuses roles without attendance authority and malformed requests", async () => {
      const independent = await mark(USERS.independent, CLASS, ANA, { status: "attended" });
      await expectCode(independent, 403, "role_not_permitted");
      await expectCode(await mark(USERS.instructor, CLASS, ANA, { status: "attended" }, null), 400, "invalid_request");
      await expectCode(await mark(USERS.instructor, CLASS, ANA, { status: "attended" }, "short"), 400, "invalid_request");
      await expectCode(await mark(USERS.instructor, CLASS, ANA, { status: "checked_in" }), 400, "invalid_request");
      await expectCode(await mark(USERS.instructor, CLASS, ANA, "not json"), 400, "invalid_request");
      await expectCode(await mark(USERS.instructor, CLASS, "not-a-uuid", { status: "attended" }), 400, "invalid_request");
    });
  });
});
