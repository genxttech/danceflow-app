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

/** N lessons on one package that holds `credits` credits, all marked attended at the same moment by different staff. */
async function race(lessons: number, credits: number) {
  const pkg = id();
  const ids = Array.from({ length: lessons }, () => id());
  psql(`insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, expiration_date, sold_price) values ('${pkg}', '${STUDIO}', '${ANA}', 'Race pack', true, '${day(60, "00:00").slice(0, 10)}', 500);
    insert into public.client_package_items (studio_id, client_package_id, usage_type, quantity_remaining, quantity_total, is_unlimited) values ('${STUDIO}', '${pkg}', 'private_lesson', ${credits}, 10, false);
    ${ids.map((lesson, i) => `insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, title, status, billing_type, client_package_id, price_amount)
      values ('${lesson}', '${STUDIO}', '${INS}', 'private_lesson', '${ANA}', '${day(1 + i, "15:00")}', '${day(1 + i, "15:45")}', 'Race', 'scheduled', 'package_credit', '${pkg}', 80);`).join("\n")}`);
  const users = [USERS.owner, USERS.frontDesk, USERS.instructor];
  const responses = await Promise.all(ids.map((lesson, i) => mark(users[i % users.length], lesson)));
  const list = ids.map((lesson) => `'${lesson}'`).join(",");
  const count = (sql: string) => Number(psql(sql));
  return {
    answers: await Promise.all(responses.map(async (response) => `${response.status}:${(await response.json()).code ?? "ok"}`)),
    attended: count(`select count(*) from public.appointments where id in (${list}) and status = 'attended';`),
    deductions: count(`select count(*) from public.lesson_transactions where appointment_id in (${list}) and transaction_type::text in ('lesson_deduction','appointment_attendance');`),
    remaining: count(`select quantity_remaining from public.client_package_items where client_package_id = '${pkg}';`),
    earnings: count(`select count(*) from public.instructor_earnings where appointment_id in (${list});`),
  };
}

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

  it("TODAY: never charges more credits than exist, but can record more lessons attended than were paid for", async () => {
    const trials: Awaited<ReturnType<typeof race>>[] = [];
    for (const [lessons, credits] of [[2, 1], [2, 1], [5, 1], [5, 1], [5, 2], [10, 1]] as const) {
      const result = await race(lessons, credits);
      trials.push(result);
      console.log("P9-TODAY", JSON.stringify({ lessons, credits, ...result }));
      // no overcharge, ever
      expect(result.deductions).toBeLessThanOrEqual(credits);
      expect(result.remaining).toBe(credits - result.deductions);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    }
    // the defect: at least one trial delivered a lesson beyond the credits (attended with no deduction)
    expect(trials.some((trial) => trial.attended > trial.deductions)).toBe(true);
  });

  it("WITH THE PROPOSED GUARD: every attended lesson has its deduction; the rest stay scheduled", async () => {
    psql(GUARD_SQL);
    for (const [lessons, credits] of [[2, 1], [2, 1], [5, 1], [5, 1], [5, 2], [10, 1], [3, 3]] as const) {
      const result = await race(lessons, credits);
      console.log("P9-GUARD", JSON.stringify({ lessons, credits, ...result }));
      expect(result.attended).toBe(Math.min(lessons, credits));
      expect(result.deductions).toBe(Math.min(lessons, credits));
      expect(result.remaining).toBe(credits - Math.min(lessons, credits));
      expect(result.earnings).toBe(result.attended);
    }
    psql(`drop trigger appointments_require_package_credit on public.appointments; drop function public.require_package_credit_for_private_lesson();`);
  });
});
