/**
 * Staff API client quick add (POST .../clients) against REAL RLS: route handler -> real supabase-js -> Kong -> PostgREST -> Postgres, as the caller own JWT.
 * LOCAL / DISPOSABLE STACK ONLY; skipped unless the isolated QA harness provides a loopback stack:
 *   node scripts/qa/iso-qa.mjs run baseline -- src/app/api/staff/__tests__/localStack.staffApiClientCreate.test.ts
 * auth.getUser is the one stand-in (the stack has no GoTrue): it checks the HS256 signature and expiry.
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
const USERS = { owner: id(), admin: id(), frontDesk: id(), instructor: id(), independent: id(), instructorB: id(), ownerB: id(), stranger: id() };
const EXISTING = id(); // studio A client with email + phone (stored as the web stores it)
const OLD_FORMAT = id(); // studio A client whose phone predates normalization
const B_TWIN = id(); // studio B client sharing an email and phone with a studio A applicant

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
let post: Handler;

const create = (user: string, body: unknown, opts: { studioId?: string; key?: string | null } = {}) => {
  const studioId = opts.studioId ?? STUDIO_A;
  const key = opts.key === undefined ? `key-${randomUUID()}` : opts.key;
  return post(
    new Request(`https://app.test/api/staff/workspaces/${studioId}/clients`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(user)}`, "content-type": "application/json", "x-danceflow-app": "business/0.2.0/3/android", ...(key ? { "idempotency-key": key } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ studioId }) },
  );
};

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((await response.json()).code).toBe(code);
}

const count = (studio: string) => Number(psql(`select count(*) from public.clients where studio_id = '${studio}';`));
const row = (clientId: string) =>
  psql(`select concat_ws('|', studio_id, first_name, last_name, coalesce(email, '~'), coalesce(phone, '~'), coalesce(notes, '~'), status, coalesce(referral_source, '~'), is_independent_instructor, coalesce(partner_client_id::text, '~'), coalesce(photo_url, '~'), coalesce(source_system, '~'), coalesce(portal_user_id::text, '~')) from public.clients where id = '${clientId}';`);

describe.skipIf(!enabled)("staff API client quick add against real RLS", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = sign({ role: "anon", exp: exp() });
    process.env.SUPABASE_SERVICE_ROLE_KEY = sign({ role: "service_role", exp: exp() });
    process.env.STAFF_API_WRITE_POLICY = JSON.stringify({ enabled: ["clientCreate"] });

    const users = Object.values(USERS);
    const role = (user: string, studio: string, value: string) => `('${user}', '${studio}', '${value}', true)`;
    psql(`begin;
      set local session_replication_role = replica;
      ${users.map((u) => `insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id, full_name) values ('${u}', 'QA');`).join("\n")}
      insert into public.studios (id, name, slug, subscription_status, timezone) values
        ('${STUDIO_A}', 'Create Studio A', 'ca-${STUDIO_A.slice(0, 8)}', 'active', 'America/Chicago'),
        ('${STUDIO_B}', 'Create Studio B', 'cb-${STUDIO_B.slice(0, 8)}', 'active', 'America/Chicago');
      insert into public.user_studio_roles (user_id, studio_id, role, active) values
        ${[role(USERS.owner, STUDIO_A, "studio_owner"), role(USERS.admin, STUDIO_A, "studio_admin"), role(USERS.frontDesk, STUDIO_A, "front_desk"),
          role(USERS.instructor, STUDIO_A, "instructor"), role(USERS.independent, STUDIO_A, "independent_instructor"), role(USERS.instructorB, STUDIO_B, "instructor"),
          role(USERS.ownerB, STUDIO_B, "studio_owner")].join(",\n")};
      insert into public.clients (id, studio_id, first_name, last_name, status, email, phone) values
        ('${EXISTING}', '${STUDIO_A}', 'Eve', 'Existing', 'active', 'eve@example.test', '+15550101111'),
        ('${OLD_FORMAT}', '${STUDIO_A}', 'Olga', 'Oldformat', 'active', null, '5550102222'),
        ('${B_TWIN}', '${STUDIO_B}', 'Bea', 'Twin', 'active', 'shared@example.test', '+15550103333');
      commit;`);

    post = (await import("../workspaces/[studioId]/clients/route")).POST as unknown as Handler;
  });

  it("owner, admin and front desk create a lead: 201 and the stored row is exactly what the web path stores", async () => {
    for (const [user, first, phone] of [[USERS.owner, "Ora", "(555) 010-4001"], [USERS.admin, "Adam", "555.010.4002"], [USERS.frontDesk, "Fran", "1 555 010 4003"]] as const) {
      const response = await create(user, { firstName: first, lastName: "Newcomer", phone, email: `${first.toLowerCase()}@example.test`, note: "Met at the showcase.\nSecond line." });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const { client } = (await response.json()) as { client: { id: string; firstName: string; lastName: string; status: string } };
      expect(client).toMatchObject({ firstName: first, lastName: "Newcomer", status: "lead" });
      expect(Object.keys(client).sort()).toEqual(["firstName", "id", "lastName", "status"]);
      const digits = phone.replace(/\D/g, "").slice(-10);
      // studio | first | last | email | phone (+1 normalized) | notes | status | referral | independent | partner | photo | source_system | portal user
      expect(row(client.id)).toBe(`${STUDIO_A}|${first}|Newcomer|${first.toLowerCase()}@example.test|+1${digits}|Met at the showcase.\nSecond line.|lead|~|f|~|~|~|~`);
    }
  });

  it("phone-only and email-only creates both work; names are trimmed and whitespace collapsed", async () => {
    const a = await create(USERS.frontDesk, { firstName: "  Pia   Marie ", lastName: " Phone-Only ", phone: "+14155550123" });
    expect(a.status).toBe(201);
    const b = await create(USERS.frontDesk, { firstName: "Emil", lastName: "Email-Only", email: "EMIL.Only@Example.TEST" });
    expect(b.status).toBe(201);
    const idB = ((await b.json()) as { client: { id: string } }).client.id;
    expect(row(idB)).toContain("|emil.only@example.test|~|");
    const idA = ((await a.json()) as { client: { id: string } }).client.id;
    expect(row(idA)).toContain("|Pia Marie|Phone-Only|~|+14155550123|");
  });

  it("an email that already exists in the studio is a 409 with the existing id and nothing is created (web rule)", async () => {
    const before = count(STUDIO_A);
    const response = await create(USERS.frontDesk, { firstName: "Eve", lastName: "Again", email: "EVE@example.test", phone: "(555) 010-9999" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "duplicate_client", existingClientId: EXISTING, matchedOn: "email" });
    expect(count(STUDIO_A)).toBe(before);
  });

  it("a phone that already exists (stored normalized or in an older format) is a 409 unless the caller allows it; an email match is never skipped", async () => {
    const before = count(STUDIO_A);
    for (const [phone, existing] of [["555-010-1111", EXISTING], ["(555) 010-2222", OLD_FORMAT]] as const) {
      const response = await create(USERS.owner, { firstName: "Dup", lastName: "Phone", phone });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "duplicate_client", existingClientId: existing, matchedOn: "phone" });
    }
    expect(count(STUDIO_A)).toBe(before);

    const allowed = await create(USERS.owner, { firstName: "Housemate", lastName: "Phone", phone: "555-010-1111", allowDuplicatePhone: true });
    expect(allowed.status).toBe(201);
    expect(count(STUDIO_A)).toBe(before + 1);

    const stillEmail = await create(USERS.owner, { firstName: "Eve", lastName: "Third", email: "eve@example.test", phone: "555-010-1111", allowDuplicatePhone: true });
    expect(stillEmail.status).toBe(409);
    expect(await stillEmail.json()).toMatchObject({ matchedOn: "email", existingClientId: EXISTING });
  });

  it("a retry of a create whose answer was lost finds the first attempt's client instead of making a twin", async () => {
    const first = await create(USERS.frontDesk, { firstName: "Retry", lastName: "Person", phone: "555-010-5555" }, { key: "retry-create-0001" });
    expect(first.status).toBe(201);
    const id1 = ((await first.json()) as { client: { id: string } }).client.id;
    const before = count(STUDIO_A);
    const again = await create(USERS.frontDesk, { firstName: "Retry", lastName: "Person", phone: "555-010-5555" }, { key: "retry-create-0001" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ existingClientId: id1, matchedOn: "phone" });
    expect(count(STUDIO_A)).toBe(before);
  });

  it("tenancy: another studio's clients are invisible to duplicate detection, and studio B staff cannot create into A", async () => {
    // same email and phone as B's client: fine in studio A
    const r = await create(USERS.owner, { firstName: "Shared", lastName: "Details", email: "shared@example.test", phone: "555-010-3333" });
    expect(r.status).toBe(201);
    const created = ((await r.json()) as { client: { id: string } }).client.id;
    expect(row(created).startsWith(`${STUDIO_A}|`)).toBe(true);

    const beforeA = count(STUDIO_A);
    const beforeB = count(STUDIO_B);
    await expectCode(await create(USERS.ownerB, { firstName: "X", lastName: "Y", phone: "555-010-7777" }, { studioId: STUDIO_A }), 403, "not_a_member");
    await expectCode(await create(USERS.instructorB, { firstName: "X", lastName: "Y", phone: "555-010-7777" }, { studioId: STUDIO_A }), 403, "not_a_member");
    await expectCode(await create(USERS.stranger, { firstName: "X", lastName: "Y", phone: "555-010-7777" }), 403, "not_a_member");
    expect(count(STUDIO_A)).toBe(beforeA);
    expect(count(STUDIO_B)).toBe(beforeB);
    // and B's owner creates into B, never A
    const bCreate = await create(USERS.ownerB, { firstName: "Bo", lastName: "Own", phone: "555-010-8888" }, { studioId: STUDIO_B });
    expect(bCreate.status).toBe(201);
    expect(row(((await bCreate.json()) as { client: { id: string } }).client.id).startsWith(`${STUDIO_B}|`)).toBe(true);
  });

  it("instructors and independent instructors are refused and nothing is written", async () => {
    const before = count(STUDIO_A);
    await expectCode(await create(USERS.instructor, { firstName: "No", lastName: "Way", phone: "555-010-6666" }), 403, "role_not_permitted");
    await expectCode(await create(USERS.independent, { firstName: "No", lastName: "Way", phone: "555-010-6666" }), 403, "role_not_permitted");
    expect(count(STUDIO_A)).toBe(before);
  });

  it("the database refuses an insert by a non-staff member even if the route were bypassed (RLS check)", () => {
    const result = psql(`begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USERS.stranger}","role":"authenticated"}', true);
      do $$ begin
        begin
          insert into public.clients (id, studio_id, first_name, last_name) values (gen_random_uuid(), '${STUDIO_A}', 'Direct', 'Insert');
          raise exception 'INSERT_WAS_ALLOWED';
        exception when insufficient_privilege or check_violation then null;
        end;
      end $$;
      rollback;
      select 'ok';`);
    expect(result).toContain("ok");
  });
});
