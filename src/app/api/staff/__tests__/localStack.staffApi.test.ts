/**
 * The staff API routes against REAL RLS: route handler -> real supabase-js -> Kong -> PostgREST -> Postgres, as the caller's own JWT. This proves what the in-memory suite cannot:
 * that the select strings and embeds parse, that the RPC resolves auth.uid(), and what RLS actually lets each role read.
 *
 * LOCAL / DISPOSABLE STACK ONLY. Skipped unless the isolated QA harness provides a loopback stack:
 *   node scripts/qa/iso-qa.mjs run baseline -- src/app/api/staff/__tests__/localStack.staffApi.test.ts
 *
 * The stack has no GoTrue, so auth.getUser is the one stand-in: it checks the HS256 signature and expiry and returns the subject, with banned_until read from auth.users.
 */
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  try {
    return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], {
      input: sql,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    throw new Error(`${failure.stderr ?? ""}${failure.stdout ?? ""}`.trim());
  }
}

const b64u = (value: string) => Buffer.from(value).toString("base64url");
function sign(payload: Record<string, unknown>, secret = SECRET) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const userToken = (sub: string, secret = SECRET) => sign({ sub, role: "authenticated", aud: "authenticated", exp: exp() }, secret);

vi.mock("@supabase/supabase-js", async () => {
  const actual = await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
  return {
    ...actual,
    createClient: (url: string, key: string, options: never) => {
      const client = actual.createClient(url, key, options);
      (client.auth as unknown as { getUser: unknown }).getUser = async (jwt: string) => {
        const [head, body, signature] = jwt.split(".");
        const expected = createHmac("sha256", process.env.TW4A_LOCAL_JWT_SECRET ?? "").update(`${head}.${body}`).digest("base64url");
        if (signature !== expected) {
          return { data: { user: null }, error: { message: "invalid JWT", status: 401, name: "AuthApiError" } };
        }
        const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { sub: string; exp: number };
        if (claims.exp * 1000 < Date.now()) {
          return { data: { user: null }, error: { message: "expired", status: 401, name: "AuthApiError" } };
        }
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
const STUDIO_PAUSED = id();

const USERS = {
  instructorA: id(),
  colleagueA: id(),
  instructorB: id(),
  ownerA: id(),
  frontDeskA: id(),
  independentA: id(),
  unlinkedA: id(),
  deactivated: id(),
  platformAdmin: id(),
  student: id(),
};

const INSTRUCTOR_A = id();
const INSTRUCTOR_COLLEAGUE = id();
const INSTRUCTOR_B = id();
const CLIENT_OWN = id();
const CLIENT_COLLEAGUE = id();
const CLIENT_B = id();
const ROOM_A = id();
const APPT_LESSON = id();
const APPT_CLASS = id();
const APPT_COLLEAGUE_LESSON = id();
const APPT_COLLEAGUE_CLASS = id();
const APPT_OTHER_STUDIO = id();

// A future local day, so the teaching relationship window of the real RPC applies.
const DAY = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const at = (time: string) => `${DAY}T${time}:00Z`;

type Routes = {
  getMe: (request: Request) => Promise<Response>;
  getToday: (request: Request, context: { params: Promise<{ studioId: string }> }) => Promise<Response>;
  getAppointment: (request: Request, context: { params: Promise<{ studioId: string; appointmentId: string }> }) => Promise<Response>;
};
let routes: Routes;

const authed = (path: string, token: string) =>
  new Request(`https://app.test${path}`, { headers: { Authorization: `Bearer ${token}` } });

const me = (token: string) => routes.getMe(authed("/api/staff/me", token));
const today = (token: string, studioId: string) =>
  routes.getToday(authed(`/api/staff/workspaces/${studioId}/today?date=${DAY}`, token), {
    params: Promise.resolve({ studioId }),
  });
const detail = (token: string, studioId: string, appointmentId: string) =>
  routes.getAppointment(authed(`/api/staff/workspaces/${studioId}/appointments/${appointmentId}`, token), {
    params: Promise.resolve({ studioId, appointmentId }),
  });

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((await response.json()).code).toBe(code);
}

const nameOf = (label: string) => `'${label}'`;

describe.skipIf(!enabled)("staff API against real RLS", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = sign({ role: "anon", exp: exp() });
    process.env.SUPABASE_SERVICE_ROLE_KEY = sign({ role: "service_role", exp: exp() });

    const userRows = Object.values(USERS);
    const studio = (studioId: string, label: string, status: string) =>
      `insert into public.studios (id, name, slug, subscription_status, timezone) values ('${studioId}', ${nameOf(label)}, 'staffapi-${studioId}', '${status}', 'America/New_York');`;
    const role = (user: string, studioId: string, value: string) =>
      `insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${user}', '${studioId}', '${value}', true);`;
    const instructor = (rowId: string, studioId: string, user: string, first: string) =>
      `insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values ('${rowId}', '${studioId}', '${user}', ${nameOf(first)}, 'Teacher', true, true);`;
    const client = (rowId: string, studioId: string, first: string) =>
      `insert into public.clients (id, studio_id, first_name, last_name) values ('${rowId}', '${studioId}', ${nameOf(first)}, 'Dancer');`;
    const appointment = (rowId: string, studioId: string, instructorId: string, type: string, clientId: string | null, start: string, end: string, title: string) =>
      `insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, room_id, starts_at, ends_at, title, notes, status, price_amount, roster_capacity)
       values ('${rowId}', '${studioId}', '${instructorId}', '${type}', ${clientId ? `'${clientId}'` : "null"}, ${studioId === STUDIO_A ? `'${ROOM_A}'` : "null"}, '${at(start)}', '${at(end)}', ${nameOf(title)}, 'real teaching note', 'scheduled', 125, ${type === "group_class" ? 12 : "null"});`;

    // Plan seat limits and booking triggers are not under test and would need a whole billing fixture. RLS, which is under test, still applies to every API read.
    psql(`
      begin;
      set local session_replication_role = replica;
      ${userRows.map((user) => `insert into auth.users (id, email) values ('${user}', '${user}@example.test');`).join("\n")}
      ${userRows.map((user) => `insert into public.profiles (id, full_name, platform_role) values ('${user}', 'QA Person', ${user === USERS.platformAdmin ? "'platform_admin'" : "null"});`).join("\n")}
      insert into public.user_account_status (user_id, status, deactivated_at) values ('${USERS.deactivated}', 'deactivated', now());
      ${studio(STUDIO_A, "Staff API Studio A", "active")}
      ${studio(STUDIO_B, "Staff API Studio B", "active")}
      ${studio(STUDIO_PAUSED, "Staff API Studio Paused", "past_due")}
      ${role(USERS.instructorA, STUDIO_A, "instructor")}
      ${role(USERS.instructorA, STUDIO_PAUSED, "instructor")}
      ${role(USERS.colleagueA, STUDIO_A, "instructor")}
      ${role(USERS.instructorB, STUDIO_B, "instructor")}
      ${role(USERS.ownerA, STUDIO_A, "studio_owner")}
      ${role(USERS.frontDeskA, STUDIO_A, "front_desk")}
      ${role(USERS.independentA, STUDIO_A, "independent_instructor")}
      ${role(USERS.unlinkedA, STUDIO_A, "instructor")}
      ${role(USERS.deactivated, STUDIO_A, "instructor")}
      ${role(USERS.platformAdmin, STUDIO_A, "studio_owner")}
      ${instructor(INSTRUCTOR_A, STUDIO_A, USERS.instructorA, "Ida")}
      ${instructor(INSTRUCTOR_COLLEAGUE, STUDIO_A, USERS.colleagueA, "Cole")}
      ${instructor(INSTRUCTOR_B, STUDIO_B, USERS.instructorB, "Bo")}
      ${client(CLIENT_OWN, STUDIO_A, "Ana")}
      ${client(CLIENT_COLLEAGUE, STUDIO_A, "Colin")}
      ${client(CLIENT_B, STUDIO_B, "Bea")}
      insert into public.rooms (id, studio_id, name) values ('${ROOM_A}', '${STUDIO_A}', 'Main Floor');
      ${appointment(APPT_LESSON, STUDIO_A, INSTRUCTOR_A, "private_lesson", CLIENT_OWN, "15:00", "15:45", "Own lesson")}
      ${appointment(APPT_CLASS, STUDIO_A, INSTRUCTOR_A, "group_class", null, "17:00", "18:00", "Own class")}
      ${appointment(APPT_COLLEAGUE_LESSON, STUDIO_A, INSTRUCTOR_COLLEAGUE, "private_lesson", CLIENT_COLLEAGUE, "16:00", "16:45", "Colleague lesson")}
      ${appointment(APPT_COLLEAGUE_CLASS, STUDIO_A, INSTRUCTOR_COLLEAGUE, "group_class", null, "19:00", "20:00", "Colleague class")}
      ${appointment(APPT_OTHER_STUDIO, STUDIO_B, INSTRUCTOR_B, "private_lesson", CLIENT_B, "15:00", "15:45", "Other studio lesson")}
      insert into public.lesson_recaps (studio_id, appointment_id, client_id, summary, homework, next_focus, visible_to_client)
        values ('${STUDIO_A}', '${APPT_LESSON}', '${CLIENT_OWN}', 'Worked on frame', 'Box step', 'Timing', true);
      insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status)
        values ('${STUDIO_A}', '${APPT_CLASS}', '${CLIENT_OWN}', 'staff', 'booked'),
               ('${STUDIO_A}', '${APPT_CLASS}', '${CLIENT_COLLEAGUE}', 'staff', 'booked');
      commit;
    `);

    routes = {
      getMe: (await import("../me/route")).GET,
      getToday: (await import("../workspaces/[studioId]/today/route")).GET,
      getAppointment: (await import("../workspaces/[studioId]/appointments/[appointmentId]/route")).GET,
    };
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("control: a broad role's token can read a colleague's lesson directly, so the Today filter is what scopes an owner", async () => {
    const response = await fetch(`${URL_}/rest/v1/appointments?select=id&id=eq.${APPT_COLLEAGUE_LESSON}`, {
      headers: { apikey: "x", Authorization: `Bearer ${userToken(USERS.ownerA)}` },
    });
    expect(await response.json()).toEqual([{ id: APPT_COLLEAGUE_LESSON }]);
    const body = await (await today(userToken(USERS.ownerA), STUDIO_A)).json();
    expect(body).toMatchObject({ instructorId: null, appointments: [] });
  });

  it("control: clients RLS hides the roster's name embed from an instructor", async () => {
    const response = await fetch(`${URL_}/rest/v1/appointment_attendees?select=client_id,clients(first_name)&appointment_id=eq.${APPT_CLASS}&client_id=eq.${CLIENT_COLLEAGUE}`, {
      headers: { apikey: "x", Authorization: `Bearer ${userToken(USERS.instructorA)}` },
    });
    expect(await response.json()).toEqual([{ client_id: CLIENT_COLLEAGUE, clients: null }]);
  });

  it("today returns only the caller's own day, with names from the real teaching RPC", async () => {
    const response = await today(userToken(USERS.instructorA), STUDIO_A);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.instructorId).toBe(INSTRUCTOR_A);
    expect(body.appointments.map((row: { id: string }) => row.id)).toEqual([APPT_LESSON, APPT_CLASS]);
    expect(body.appointments[0]).toMatchObject({
      title: "Own lesson",
      appointmentType: "private_lesson",
      room: { id: ROOM_A, name: "Main Floor" },
      client: { id: CLIENT_OWN, firstName: "Ana", lastName: "Dancer" },
      partner: null,
    });
    expect(new Date(body.appointments[0].startsAt).toISOString()).toBe(new Date(at("15:00")).toISOString());
    expect(JSON.stringify(body)).not.toMatch(/price|payment|Colin|Bea/);
  });

  it("today is empty for an instructor with no instructor row", async () => {
    const body = await (await today(userToken(USERS.unlinkedA), STUDIO_A)).json();
    expect(body).toMatchObject({ instructorId: null, appointments: [] });
  });

  it("detail returns the caller's own lesson with notes and recap", async () => {
    const response = await detail(userToken(USERS.instructorA), STUDIO_A, APPT_LESSON);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accessScope: "own-instructor",
      notes: "real teaching note",
      instructor: { id: INSTRUCTOR_A, firstName: "Ida", lastName: "Teacher" },
      client: { firstName: "Ana" },
      recap: { summary: "Worked on frame", homework: "Box step", nextFocus: "Timing", visibleToClient: true },
      roster: null,
    });
  });

  it("detail returns a group class's roster and capacity to the assigned instructor", async () => {
    const body = await (await detail(userToken(USERS.instructorA), STUDIO_A, APPT_CLASS)).json();
    expect(body.roster).toMatchObject({ bookedCount: 2, capacity: 12 });
    expect(body.roster.attendees).toEqual(
      expect.arrayContaining([
        { clientId: CLIENT_OWN, name: "Ana Dancer", attendanceStatus: null },
        // No private-lesson relationship and clients RLS hides the row; the name comes from get_class_roster_names_for_instructor.
        { clientId: CLIENT_COLLEAGUE, name: "Colin Dancer", attendanceStatus: null },
      ]),
    );
  });

  describe("get_class_roster_names_for_instructor, called directly as each caller", () => {
    const rosterNames = async (token: string | null, appointmentId: string) => {
      const response = await fetch(`${URL_}/rest/v1/rpc/get_class_roster_names_for_instructor`, {
        method: "POST",
        headers: { apikey: "x", "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ target_appointment_id: appointmentId }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    };

    it("returns names, and only names and enrollment status, to the assigned instructor", async () => {
      const { status, body } = await rosterNames(userToken(USERS.instructorA), APPT_CLASS);
      expect(status).toBe(200);
      expect(body).toEqual([
        { client_id: CLIENT_OWN, first_name: "Ana", last_name: "Dancer", attendee_status: "booked" },
        { client_id: CLIENT_COLLEAGUE, first_name: "Colin", last_name: "Dancer", attendee_status: "booked" },
      ].sort((a, b) => (a.first_name < b.first_name ? -1 : 1)));
    });

    it.each([
      ["a colleague instructor at the same studio", () => USERS.colleagueA],
      ["an instructor at another studio", () => USERS.instructorB],
      ["the studio owner, who is not the assigned instructor", () => USERS.ownerA],
      ["front desk", () => USERS.frontDeskA],
      ["an independent instructor", () => USERS.independentA],
      ["an instructor with no instructor row", () => USERS.unlinkedA],
      ["a student", () => USERS.student],
      ["a platform admin", () => USERS.platformAdmin],
    ])("returns zero rows to %s", async (_label, user) => {
      expect(await rosterNames(userToken(user()), APPT_CLASS)).toEqual({ status: 200, body: [] });
    });

    it("returns zero rows for a lesson, even the assigned instructor's own", async () => {
      expect((await rosterNames(userToken(USERS.instructorA), APPT_LESSON)).body).toEqual([]);
    });

    it("answers a missing appointment exactly like an unauthorized one", async () => {
      expect(await rosterNames(userToken(USERS.instructorA), randomUUID())).toEqual({ status: 200, body: [] });
    });

    it("is not executable without a user token", async () => {
      const { status } = await rosterNames(null, APPT_CLASS);
      expect([401, 403]).toContain(status);
    });

    it("follows the live assignment, a deactivated instructor row and a deactivated membership", async () => {
      const token = userToken(USERS.instructorA);
      try {
        psql(`set session_replication_role = replica; update public.appointments set instructor_id = '${INSTRUCTOR_COLLEAGUE}' where id = '${APPT_CLASS}';`);
        expect((await rosterNames(token, APPT_CLASS)).body).toEqual([]);
        expect(((await rosterNames(userToken(USERS.colleagueA), APPT_CLASS)).body as unknown[]).length).toBe(2);
      } finally {
        psql(`set session_replication_role = replica; update public.appointments set instructor_id = '${INSTRUCTOR_A}' where id = '${APPT_CLASS}';`);
      }

      try {
        psql(`set session_replication_role = replica; update public.instructors set active = false where id = '${INSTRUCTOR_A}';`);
        expect((await rosterNames(token, APPT_CLASS)).body).toEqual([]);
      } finally {
        psql(`set session_replication_role = replica; update public.instructors set active = true where id = '${INSTRUCTOR_A}';`);
      }

      try {
        psql(`update public.user_studio_roles set active = false where user_id = '${USERS.instructorA}' and studio_id = '${STUDIO_A}';`);
        expect((await rosterNames(token, APPT_CLASS)).body).toEqual([]);
      } finally {
        psql(`update public.user_studio_roles set active = true where user_id = '${USERS.instructorA}' and studio_id = '${STUDIO_A}';`);
      }

      expect(((await rosterNames(token, APPT_CLASS)).body as unknown[]).length).toBe(2);
    }, 30_000);

    it("never returns an attendee row whose client belongs to another studio", async () => {
      try {
        psql(`set session_replication_role = replica;
          insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status) values ('${STUDIO_A}', '${APPT_CLASS}', '${CLIENT_B}', 'staff', 'booked');`);
        const names = (await rosterNames(userToken(USERS.instructorA), APPT_CLASS)).body as { client_id: string }[];
        expect(names.map((row) => row.client_id)).not.toContain(CLIENT_B);
      } finally {
        psql(`delete from public.appointment_attendees where appointment_id = '${APPT_CLASS}' and client_id = '${CLIENT_B}';`);
      }
    }, 30_000);
  });

  describe("web roster helpers as the assigned instructor (real RLS)", () => {
    it("the attendance page roster no longer drops attendees whose client rows RLS hides", async () => {
      const { createBearerScopedClient } = await import("@/lib/auth/studentApiAuth");
      const { getClassRosterForInstructor } = await import("@/lib/schedule/groupClassRoster");
      const roster = await getClassRosterForInstructor({
        supabase: createBearerScopedClient(userToken(USERS.instructorA)) as never,
        appointmentId: APPT_CLASS,
        studioId: STUDIO_A,
      });
      expect(roster.map((row) => `${row.firstName} ${row.lastName}`).sort()).toEqual(["Ana Dancer", "Colin Dancer"]);
      expect(roster.every((row) => row.source === "roster")).toBe(true);
    });

    it("the class detail roster panel shows names, not the placeholder", async () => {
      const { createBearerScopedClient } = await import("@/lib/auth/studentApiAuth");
      const { loadRosterPanel } = await import("@/lib/schedule/groupClassRosterPanel");
      const supabase = createBearerScopedClient(userToken(USERS.instructorA));
      const panel = (assignedInstructorView: boolean) =>
        loadRosterPanel({ supabase, studioId: STUDIO_A, appointmentId: APPT_CLASS, capacity: 12, includeFunding: false, canManage: true, assignedInstructorView });

      // Control: without the instructor view, the old embed-only read is what RLS allows.
      expect((await panel(false)).entries.map((entry) => entry.name)).toEqual(["Unnamed dancer", "Unnamed dancer"]);
      const fixed = await panel(true);
      expect(fixed.entries.map((entry) => entry.name)).toEqual(["Ana Dancer", "Colin Dancer"]);
      expect(fixed.entries.every((entry) => entry.nameKnown && entry.fundingLabel === null)).toBe(true);
    });
  });

  it("detail gives broad staff every name on a class roster", async () => {
    const body = await (await detail(userToken(USERS.ownerA), STUDIO_A, APPT_CLASS)).json();
    expect(body.roster.attendees).toEqual(
      expect.arrayContaining([
        { clientId: CLIENT_OWN, name: "Ana Dancer", attendanceStatus: null },
        { clientId: CLIENT_COLLEAGUE, name: "Colin Dancer", attendanceStatus: null },
      ]),
    );
  });

  it("detail refuses a colleague's lesson and class", async () => {
    const token = userToken(USERS.instructorA);
    await expectCode(await detail(token, STUDIO_A, APPT_COLLEAGUE_LESSON), 404, "not_found");
    await expectCode(await detail(token, STUDIO_A, APPT_COLLEAGUE_CLASS), 404, "not_found");
  });

  it("detail lets broad staff read any appointment in their studio, with names from clients", async () => {
    for (const user of [USERS.ownerA, USERS.frontDeskA]) {
      const response = await detail(userToken(user), STUDIO_A, APPT_COLLEAGUE_LESSON);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        accessScope: "broad",
        client: { id: CLIENT_COLLEAGUE, firstName: "Colin", lastName: "Dancer" },
      });
    }
  });

  it("no role can reach another studio's appointment through its own studio", async () => {
    for (const user of [USERS.instructorA, USERS.ownerA, USERS.frontDeskA]) {
      await expectCode(await detail(userToken(user), STUDIO_A, APPT_OTHER_STUDIO), 404, "not_found");
    }
  });

  it("refuses non-members, even though studios are publicly readable under RLS", async () => {
    await expectCode(await today(userToken(USERS.instructorB), STUDIO_A), 403, "not_a_member");
    await expectCode(await detail(userToken(USERS.instructorB), STUDIO_A, APPT_LESSON), 403, "not_a_member");
    await expectCode(await today(userToken(USERS.ownerA), STUDIO_B), 403, "not_a_member");
    await expectCode(await today(userToken(USERS.student), STUDIO_A), 403, "not_a_member");
  });

  it("refuses a paused workspace", async () => {
    await expectCode(await today(userToken(USERS.instructorA), STUDIO_PAUSED), 403, "workspace_paused");
  });

  it("refuses an independent instructor on schedule routes", async () => {
    await expectCode(await today(userToken(USERS.independentA), STUDIO_A), 403, "role_not_permitted");
  });

  it("refuses a deactivated account, read through the real account status row", async () => {
    await expectCode(await me(userToken(USERS.deactivated)), 403, "account_inactive");
    await expectCode(await today(userToken(USERS.deactivated), STUDIO_A), 403, "account_inactive");
  });

  it("refuses a platform admin, read through their own real profile row", async () => {
    await expectCode(await me(userToken(USERS.platformAdmin)), 403, "platform_admin_unsupported");
    await expectCode(await today(userToken(USERS.platformAdmin), STUDIO_A), 403, "platform_admin_unsupported");
  });

  it("refuses a token signed with the wrong secret", async () => {
    await expectCode(await me(userToken(USERS.instructorA, "not-the-secret")), 401, "unauthenticated");
  });

  it("me lists real memberships with access state, and nothing else", async () => {
    const response = await me(userToken(USERS.instructorA));
    expect(response.status).toBe(200);
    const body = await response.json();
    const byStudio = new Map(body.workspaces.map((row: { studioId: string }) => [row.studioId, row]));

    expect([...byStudio.keys()].sort()).toEqual([STUDIO_A, STUDIO_PAUSED].sort());
    expect(byStudio.get(STUDIO_A)).toMatchObject({ role: "instructor", accessAllowed: true, subscriptionStatus: "active", name: "Staff API Studio A" });
    expect(byStudio.get(STUDIO_PAUSED)).toMatchObject({ accessAllowed: false, subscriptionStatus: "past_due" });
  });

  it("me returns no workspaces for a signed-in person with no staff role", async () => {
    const response = await me(userToken(USERS.student));
    expect(response.status).toBe(200);
    expect((await response.json()).workspaces).toEqual([]);
  });
});
