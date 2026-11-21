/**
 * Staff API client notes read (GET .../clients/{clientId}/notes) against REAL RLS: route handler -> real supabase-js -> Kong -> PostgREST -> Postgres, as the caller own JWT.
 * LOCAL / DISPOSABLE STACK ONLY; skipped unless the isolated QA harness provides a loopback stack:
 *   node scripts/qa/iso-qa.mjs run baseline -- src/app/api/staff/__tests__/localStack.staffApiClientNotesRead.test.ts
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
const ANA = id(); // studio A client with notes
const CAL = id(); // studio A client whose notes must never appear under ANA
const BEA = id(); // studio B client
const NOTE = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
let route: Handler;

const read = (user: string, clientId: string, query = "", studioId = STUDIO_A) =>
  route(
    new Request(`https://app.test/api/staff/workspaces/${studioId}/clients/${clientId}/notes${query}`, { headers: { Authorization: `Bearer ${tokenFor(user)}` } }),
    { params: Promise.resolve({ studioId, clientId }) },
  );

type Page = { notes: { id: string; body: string; noteType: string; occurredAt: string; createdAt: string; authorName: string | null; isMine: boolean; clientId: string }[]; nextCursor: string | null };
const page = async (response: Response) => (await response.json()) as Page;

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((await response.json()).code).toBe(code);
}

describe.skipIf(!enabled)("staff API client notes read against real RLS", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = sign({ role: "anon", exp: exp() });
    process.env.SUPABASE_SERVICE_ROLE_KEY = sign({ role: "service_role", exp: exp() });
    // no STAFF_API_WRITE_POLICY and no app header on purpose: reads are not behind the write guard
    delete process.env.STAFF_API_WRITE_POLICY;

    const users = Object.values(USERS);
    const role = (user: string, studio: string, value: string) => `('${user}', '${studio}', '${value}', true)`;
    psql(`begin;
      set local session_replication_role = replica;
      ${users.map((u) => `insert into auth.users (id, email) values ('${u}', '${u}@secret-mail.example'); insert into public.profiles (id, full_name, email) values ('${u}', 'Name ${u.slice(0, 4)}', '${u}@secret-mail.example');`).join("\n")}
      insert into public.studios (id, name, slug, subscription_status, timezone) values
        ('${STUDIO_A}', 'Read Studio A', 'ra-${STUDIO_A.slice(0, 8)}', 'active', 'America/Chicago'),
        ('${STUDIO_B}', 'Read Studio B', 'rb-${STUDIO_B.slice(0, 8)}', 'active', 'America/Chicago');
      insert into public.user_studio_roles (user_id, studio_id, role, active) values
        ${[role(USERS.owner, STUDIO_A, "studio_owner"), role(USERS.admin, STUDIO_A, "studio_admin"), role(USERS.frontDesk, STUDIO_A, "front_desk"),
          role(USERS.instructor, STUDIO_A, "instructor"), role(USERS.independent, STUDIO_A, "independent_instructor"), role(USERS.instructorB, STUDIO_B, "instructor"),
          role(USERS.ownerB, STUDIO_B, "studio_owner")].join(",\n")};
      insert into public.clients (id, studio_id, first_name, last_name, status) values
        ('${ANA}', '${STUDIO_A}', 'Ana', 'Alvarez', 'active'),
        ('${CAL}', '${STUDIO_A}', 'Cal', 'Carter', 'active'),
        ('${BEA}', '${STUDIO_B}', 'Bea', 'Brook', 'active');
      insert into public.client_activity_notes (id, studio_id, client_id, note_type, body, occurred_at, created_at, created_by) values
        ('${NOTE(1)}', '${STUDIO_A}', '${ANA}', 'general',   'oldest',          '2026-11-01T10:00:00Z', '2026-11-01T10:00:01Z', '${USERS.frontDesk}'),
        ('${NOTE(2)}', '${STUDIO_A}', '${ANA}', 'sales',     'tie first made',  '2026-11-10T10:00:00Z', '2026-11-10T10:00:01Z', '${USERS.owner}'),
        ('${NOTE(3)}', '${STUDIO_A}', '${ANA}', 'follow_up', 'tie second made', '2026-11-10T10:00:00Z', '2026-11-10T10:00:02.123456Z', '${USERS.admin}'),
        ('${NOTE(4)}', '${STUDIO_A}', '${ANA}', 'billing',   'tie same stamps lower id', '2026-11-10T10:00:00Z', '2026-11-10T10:00:02.123456Z', null),
        ('${NOTE(5)}', '${STUDIO_A}', '${ANA}', 'concern',   'newest',          '2026-11-19T10:00:00Z', '2026-11-19T10:00:01Z', '${USERS.frontDesk}'),
        ('${NOTE(6)}', '${STUDIO_A}', '${CAL}', 'general',   'cal only',        '2026-11-19T11:00:00Z', '2026-11-19T11:00:01Z', '${USERS.owner}'),
        ('${NOTE(7)}', '${STUDIO_B}', '${BEA}', 'general',   'studio B secret', '2026-11-19T12:00:00Z', '2026-11-19T12:00:01Z', '${USERS.ownerB}');
      commit;`);

    route = (await import("../workspaces/[studioId]/clients/[clientId]/notes/route")).GET as unknown as Handler;
  });

  it("owner, admin and front desk read the client notes newest first with no email, the author name only where profiles allow it, and only that client's notes", async () => {
    for (const user of [USERS.owner, USERS.admin, USERS.frontDesk]) {
      const response = await read(user, ANA);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const text = await response.clone().text();
      expect(text).not.toContain("secret-mail");
      expect(text).not.toContain("studio B secret");
      expect(text).not.toContain("cal only");
      const json = await page(response);
      expect(json.notes.map((n) => n.body)).toEqual(["newest", "tie same stamps lower id", "tie second made", "tie first made", "oldest"]);
      expect(json.nextCursor).toBeNull();
      // profiles RLS: a staff user can read only their own profile, so the name shows on their own notes and is null on a colleague's (as on the web page)
      const mine = user === USERS.frontDesk;
      expect(json.notes[0]).toMatchObject({ id: NOTE(5), clientId: ANA, noteType: "concern", isMine: mine, authorName: mine ? `Name ${USERS.frontDesk.slice(0, 4)}` : null });
      expect(Object.keys(json.notes[0]).sort()).toEqual(["authorName", "body", "clientId", "createdAt", "id", "isMine", "noteType", "occurredAt"]);
      // a note whose author is gone is still listed, with no name and not mine
      expect(json.notes.find((n) => n.id === NOTE(4))).toMatchObject({ authorName: null, isMine: false });
    }
  });

  it("pages with a cursor: every note exactly once, in order, across ties on occurred_at and created_at", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await read(USERS.frontDesk, ANA, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(response.status).toBe(200);
      const json = await page(response);
      expect(json.notes.length).toBeLessThanOrEqual(2);
      seen.push(...json.notes.map((n) => n.id));
      cursor = json.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([NOTE(5), NOTE(4), NOTE(3), NOTE(2), NOTE(1)]);
    // NOTE(3) and NOTE(4) share both timestamps: id order, descending, with neither skipped nor repeated at the page boundary
  });

  it("a new note arriving between pages does not duplicate or skip anything on the pages already in flight", async () => {
    const first = await page(await read(USERS.owner, ANA, "?limit=2"));
    psql(`insert into public.client_activity_notes (id, studio_id, client_id, note_type, body, occurred_at, created_at, created_by) values ('${id()}', '${STUDIO_A}', '${ANA}', 'general', 'arrived late', '2026-11-25T10:00:00Z', now(), '${USERS.owner}');`);
    const rest = await page(await read(USERS.owner, ANA, `?limit=10&cursor=${encodeURIComponent(first.nextCursor!)}`));
    const ids = [...first.notes, ...rest.notes].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    psql(`delete from public.client_activity_notes where body = 'arrived late';`);
  });

  it("limit and cursor are validated; an empty history is an empty page", async () => {
    await expectCode(await read(USERS.owner, ANA, "?limit=0"), 400, "invalid_request");
    await expectCode(await read(USERS.owner, ANA, "?limit=51"), 400, "invalid_request");
    await expectCode(await read(USERS.owner, ANA, "?cursor=garbage"), 400, "invalid_request");
    const empty = psql(`insert into public.clients (id, studio_id, first_name, last_name, status) values ('${NOTE(9)}', '${STUDIO_A}', 'No', 'Notes', 'active') returning id;`);
    expect(empty).toBe(NOTE(9));
    expect(await page(await read(USERS.owner, NOTE(9)))).toEqual({ notes: [], nextCursor: null });
  });

  it("instructors and independent instructors are refused", async () => {
    await expectCode(await read(USERS.instructor, ANA), 403, "role_not_permitted");
    await expectCode(await read(USERS.independent, ANA), 403, "role_not_permitted");
  });

  it("tenancy: another studio's client is 404 through studio A, studio B staff are not members of A, and studio B notes never appear", async () => {
    await expectCode(await read(USERS.owner, BEA), 404, "not_found");
    await expectCode(await read(USERS.ownerB, ANA), 403, "not_a_member");
    await expectCode(await read(USERS.instructorB, ANA), 403, "not_a_member");
    await expectCode(await read(USERS.stranger, ANA), 403, "not_a_member");
    // B's own owner reads B's client in B
    const own = await page(await read(USERS.ownerB, BEA, "", STUDIO_B));
    expect(own.notes.map((n) => n.body)).toEqual(["studio B secret"]);
    // a client that does not exist is the same 404
    await expectCode(await read(USERS.owner, randomUUID()), 404, "not_found");
  });
});
