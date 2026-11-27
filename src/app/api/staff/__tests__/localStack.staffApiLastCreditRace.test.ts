/**
 * Owner decision P9: what happens when several lessons race for the last credit of a package, today and with the proposed (not applied) guard:
 * route handler -> real supabase-js -> Kong -> PostgREST -> Postgres, as the caller's own JWT. LOCAL / DISPOSABLE STACK ONLY; skipped unless the isolated QA harness
 * provides a loopback stack (never run it on a shared database):
 *   node scripts/qa/iso-qa.mjs run baseline -- src/app/api/staff/__tests__/localStack.staffApiLastCreditRace.test.ts
 * (apply migrations above the baseline cutoff first). auth.getUser is the one stand-in, exactly as in localStack.staffApiSlice2.test.ts.
 */
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
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
const STUDIO = id();
const USERS = { owner: id(), frontDesk: id(), instructor: id() };
const INS = id();
const ANA = id();
const day = (days: number, time: string) => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${time}:00Z`;
const GUARD_SQL = readFileSync(path.resolve(process.cwd(), "docs/mobile/proposals/p9_private_lesson_package_credit_guard.sql"), "utf8").replace(/\r\n/g, "\n");

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
let attendance: Handler;

const mark = (user: string, appointmentId: string) =>
  attendance(
    new Request(`https://app.test/api/staff/workspaces/${STUDIO}/appointments/${appointmentId}/attendance`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokenFor(user)}`,
        "x-danceflow-app": "business/0.2.0/3/android",
        "content-type": "application/json",
        "idempotency-key": `race-${randomUUID()}`,
      },
      body: JSON.stringify({ status: "attended" }),
    }),
    { params: Promise.resolve({ studioId: STUDIO, appointmentId }) },
  );

/** One package holding `credits` credits and `lessons` open lessons billed to it. */
function seed(lessons: number, credits: number) {
  const pkg = id();
  const ids = Array.from({ length: lessons }, () => id());
  psql(`insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, expiration_date, sold_price) values ('${pkg}', '${STUDIO}', '${ANA}', 'Race pack', true, '${day(60, "00:00").slice(0, 10)}', 500);
    insert into public.client_package_items (studio_id, client_package_id, usage_type, quantity_remaining, quantity_total, is_unlimited) values ('${STUDIO}', '${pkg}', 'private_lesson', ${credits}, 10, false);
    ${ids.map((lesson, i) => `insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, title, status, billing_type, client_package_id, price_amount)
      values ('${lesson}', '${STUDIO}', '${INS}', 'private_lesson', '${ANA}', '${day(1 + i, "15:00")}', '${day(1 + i, "15:45")}', 'Race', 'scheduled', 'package_credit', '${pkg}', 80);`).join("\n")}`);
  return { pkg, ids, list: ids.map((lesson) => `'${lesson}'`).join(",") };
}
const count = (sql: string) => Number(psql(sql));
function state({ pkg, list }: ReturnType<typeof seed>) {
  return {
    attended: count(`select count(*) from public.appointments where id in (${list}) and status = 'attended';`),
    deductions: count(`select count(*) from public.lesson_transactions where appointment_id in (${list}) and transaction_type::text in ('lesson_deduction','appointment_attendance');`),
    remaining: count(`select quantity_remaining from public.client_package_items where client_package_id = '${pkg}';`),
    earnings: count(`select count(*) from public.instructor_earnings where appointment_id in (${list});`),
  };
}
const refusal = (sql: string) => {
  try {
    psql(sql);
    return null;
  } catch (failure) {
    return String((failure as { stderr?: unknown }).stderr ?? failure);
  }
};

/** Every lesson marked attended at the same moment through the API, by different staff. */
async function race(lessons: number, credits: number) {
  const seeded = seed(lessons, credits);
  const users = [USERS.owner, USERS.frontDesk, USERS.instructor];
  const responses = await Promise.all(seeded.ids.map((lesson, i) => mark(users[i % users.length], lesson)));
  const answers = await Promise.all(responses.map(async (response) => `${response.status}:${(await response.json()).code ?? "ok"}`));
  return { answers, ...state(seeded) };
}

const TRIALS = [[2, 1], [2, 1], [5, 1], [5, 1], [5, 2], [10, 1]] as const;

describe.skipIf(!enabled)("P9: lessons racing for a package's last credit (real database)", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = sign({ role: "anon", exp: exp() });
    process.env.SUPABASE_SERVICE_ROLE_KEY = sign({ role: "service_role", exp: exp() });
    process.env.STAFF_API_WRITE_POLICY = JSON.stringify({ enabled: ["appointmentAttendance"] });
    const role = (user: string, value: string) => `('${user}', '${STUDIO}', '${value}', true)`;
    psql(`begin;
      set local session_replication_role = replica;
      ${Object.values(USERS).map((u) => `insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id, full_name) values ('${u}', 'QA');`).join("\n")}
      insert into public.studios (id, name, slug, subscription_status, timezone) values ('${STUDIO}', 'Race Studio', 'race-${STUDIO.slice(0, 8)}', 'active', 'America/Chicago');
      insert into public.studio_settings (studio_id) values ('${STUDIO}');
      insert into public.user_studio_roles (user_id, studio_id, role, active) values ${[role(USERS.owner, "studio_owner"), role(USERS.frontDesk, "front_desk"), role(USERS.instructor, "instructor")].join(",")};
      insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values ('${INS}', '${STUDIO}', '${USERS.instructor}', 'Ida', 'Teacher', true, true);
      insert into public.clients (id, studio_id, first_name, last_name, status) values ('${ANA}', '${STUDIO}', 'Ana', 'Alvarez', 'active');
      insert into public.instructor_compensation_rules (studio_id, instructor_id, private_lesson_pay_mode, private_lesson_flat_amount, active) values ('${STUDIO}', '${INS}', 'flat', 40, true);
      insert into public.instructor_payroll_profiles (studio_id, instructor_id, worker_classification, payroll_active) values ('${STUDIO}', '${INS}', 'contractor', true);
      commit;`);
    attendance = (await import("../workspaces/[studioId]/appointments/[appointmentId]/attendance/route")).PUT as unknown as Handler;
  });

  it("TODAY, deterministic: one statement marking two lessons with one credit leaves two attended and one deduction", () => {
    const seeded = seed(2, 1);
    psql(`update public.appointments set status = 'attended' where id in (${seeded.list});`);
    const after = state(seeded);
    console.log("P9-TODAY-STATEMENT", JSON.stringify(after));
    expect(after).toMatchObject({ attended: 2, deductions: 1, remaining: 0 });
  });

  it("TODAY, concurrent requests: never more charges than credits; lessons beyond the credits can be recorded attended (numbers logged)", async () => {
    for (const [lessons, credits] of TRIALS) {
      const result = await race(lessons, credits);
      console.log("P9-TODAY", JSON.stringify({ lessons, credits, ...result }));
      // no overcharge, ever
      expect(result.deductions).toBeLessThanOrEqual(credits);
      expect(result.remaining).toBe(credits - result.deductions);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  describe("with the proposed guard", () => {
    beforeAll(() => {
      psql(GUARD_SQL);
    });
    afterAll(() => {
      psql(`drop trigger if exists appointments_require_package_deduction on public.appointments; drop function if exists public.require_package_deduction_for_private_lesson();`);
    });

    it("refuses a direct update of a lesson once the credit is gone, a two-lesson statement as a whole, and an insert as attended", () => {
      const one = seed(2, 1);
      psql(`update public.appointments set status = 'attended' where id = '${one.ids[0]}';`);
      expect(refusal(`update public.appointments set status = 'attended' where id = '${one.ids[1]}';`)).toContain("PKG_NO_CREDIT");
      expect(state(one)).toMatchObject({ attended: 1, deductions: 1, remaining: 0 });

      const both = seed(2, 1);
      expect(refusal(`update public.appointments set status = 'attended' where id in (${both.list});`)).toContain("PKG_NO_CREDIT");
      expect(state(both)).toMatchObject({ attended: 0, deductions: 0, remaining: 1 });

      const empty = seed(0, 0);
      expect(
        refusal(`insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, title, status, billing_type, client_package_id)
          values ('${id()}', '${STUDIO}', '${INS}', 'private_lesson', '${ANA}', '${day(1, "15:00")}', '${day(1, "15:45")}', 'Inserted', 'attended', 'package_credit', '${empty.pkg}');`),
      ).toContain("PKG_NO_CREDIT");
    });

    it("concurrent requests: exactly as many attended as credits, each with its deduction and earning; the rest are refused and stay scheduled", async () => {
      for (const [lessons, credits] of [...TRIALS, [3, 3] as const]) {
        const result = await race(lessons, credits);
        console.log("P9-GUARD", JSON.stringify({ lessons, credits, ...result }));
        const expected = Math.min(lessons, credits);
        expect(result.attended).toBe(expected);
        expect(result.deductions).toBe(expected);
        expect(result.remaining).toBe(credits - expected);
        expect(result.earnings).toBe(expected);
        expect(result.answers.filter((answer) => answer === "200:ok")).toHaveLength(expected);
        expect(result.answers.filter((answer) => answer !== "200:ok").every((answer) => answer === "409:payment_required")).toBe(true);
      }
    });
  });
});
