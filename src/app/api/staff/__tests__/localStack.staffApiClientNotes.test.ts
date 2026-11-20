/**
 * Staff API client notes (POST .../clients/{clientId}/notes) against REAL RLS: route handler -> real supabase-js -> Kong -> PostgREST -> Postgres, as the caller own JWT.
 * LOCAL / DISPOSABLE STACK ONLY; skipped unless the isolated QA harness provides a loopback stack:
 *   node scripts/qa/iso-qa.mjs run baseline -- src/app/api/staff/__tests__/localStack.staffApiClientNotes.test.ts
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
const USERS = { owner: id(), admin: id(), frontDesk: id(), instructor: id(), independent: id(), instructorB: id(), stranger: id() };
const ANA = id(); // studio A client
const BEA = id(); // studio B client

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
let post: Handler;

const note = (user: string, clientId: string, body: unknown, opts: { studioId?: string; key?: string | null } = {}) => {
  const studioId = opts.studioId ?? STUDIO_A;
  const key = opts.key === undefined ? `key-${randomUUID()}` : opts.key;
  return post(
    new Request(`https://app.test/api/staff/workspaces/${studioId}/clients/${clientId}/notes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(user)}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ studioId, clientId }) },
  );
};

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((await response.json()).code).toBe(code);
}

const notesFor = (clientId: string) =>
  psql(`select coalesce(string_agg(note_type || '|' || body || '|' || coalesce(created_by::text, '') || '|' || studio_id::text, E'\\n' order by created_at), '') from public.client_activity_notes where client_id = '${clientId}';`);
const noteCount = () => Number(psql(`select count(*) from public.client_activity_notes where studio_id in ('${STUDIO_A}', '${STUDIO_B}');`));

describe.skipIf(!enabled)("staff API client notes against real RLS", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = sign({ role: "anon", exp: exp() });
    process.env.SUPABASE_SERVICE_ROLE_KEY = sign({ role: "service_role", exp: exp() });

    const users = Object.values(USERS);
    const role = (user: string, studio: string, value: string) => `('${user}', '${studio}', '${value}', true)`;
    psql(`begin;
      set local session_replication_role = replica;
      ${users.map((u) => `insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id, full_name) values ('${u}', 'QA');`).join("\n")}
      insert into public.studios (id, name, slug, subscription_status, timezone) values
        ('${STUDIO_A}', 'Notes Studio A', 'na-${STUDIO_A.slice(0, 8)}', 'active', 'America/Chicago'),
        ('${STUDIO_B}', 'Notes Studio B', 'nb-${STUDIO_B.slice(0, 8)}', 'active', 'America/Chicago');
      insert into public.user_studio_roles (user_id, studio_id, role, active) values
        ${[role(USERS.owner, STUDIO_A, "studio_owner"), role(USERS.admin, STUDIO_A, "studio_admin"), role(USERS.frontDesk, STUDIO_A, "front_desk"),
          role(USERS.instructor, STUDIO_A, "instructor"), role(USERS.independent, STUDIO_A, "independent_instructor"), role(USERS.instructorB, STUDIO_B, "instructor")].join(",\n")};
      insert into public.clients (id, studio_id, first_name, last_name, status, email, phone) values
        ('${ANA}', '${STUDIO_A}', 'Ana', 'Alvarez', 'active', 'ana@example.test', '555-0100'),
        ('${BEA}', '${STUDIO_B}', 'Bea', 'Brook', 'active', 'bea@example.test', '555-0200');
      commit;`);

    post = (await import("../workspaces/[studioId]/clients/[clientId]/notes/route")).POST as unknown as Handler;
  });

  it("owner, admin and front desk each save a note: 201, the row carries studio, client, type, body and the author", async () => {
    for (const [user, type] of [[USERS.owner, "sales"], [USERS.admin, "billing"], [USERS.frontDesk, "follow_up"]] as const) {
      const response = await note(user, ANA, { noteType: type, body: `from ${type}`, occurredAt: "2026-11-20T15:30:00Z" });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const json = (await response.json()) as { note: { id: string; clientId: string; noteType: string; body: string; occurredAt: string; createdAt: string } };
      expect(json.note).toMatchObject({ clientId: ANA, noteType: type, body: `from ${type}`});
      expect(new Date(json.note.occurredAt).toISOString()).toBe("2026-11-20T15:30:00.000Z");
      expect(Object.keys(json.note).sort()).toEqual(["body", "clientId", "createdAt", "id", "noteType", "occurredAt"]);
      expect(notesFor(ANA)).toContain(`${type}|from ${type}|${user}|${STUDIO_A}`);
    }
  });

  it("defaults: general type and now when noteType and occurredAt are omitted", async () => {
    const before = Date.now();
    const response = await note(USERS.frontDesk, ANA, { body: "plain note" });
    expect(response.status).toBe(201);
    const { note: saved } = (await response.json()) as { note: { noteType: string; occurredAt: string } };
    expect(saved.noteType).toBe("general");
    expect(Math.abs(new Date(saved.occurredAt).getTime() - before)).toBeLessThan(60_000);
  });

  it("a retry of the same note (lost response) is 200 with the same id and writes nothing new; a different body is a new note", async () => {
    const first = await note(USERS.frontDesk, ANA, { body: "retry me" }, { key: "retry-key-0001" });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { note: { id: string } }).note.id;
    const count = noteCount();
    const again = await note(USERS.frontDesk, ANA, { body: "retry me" }, { key: "retry-key-0001" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { note: { id: string } }).note.id).toBe(firstId);
    expect(noteCount()).toBe(count);
    expect((await note(USERS.frontDesk, ANA, { body: "retry me too" })).status).toBe(201);
    expect(noteCount()).toBe(count + 1);
    // another author saying the same thing is not a retry
    expect((await note(USERS.owner, ANA, { body: "retry me" })).status).toBe(201);
  });

  it("instructors and independent instructors are refused and nothing is written", async () => {
    const count = noteCount();
    await expectCode(await note(USERS.instructor, ANA, { body: "nope" }), 403, "role_not_permitted");
    await expectCode(await note(USERS.independent, ANA, { body: "nope" }), 403, "role_not_permitted");
    expect(noteCount()).toBe(count);
  });

  it("tenancy: studio A staff cannot write a note on a studio B client, by either path", async () => {
    const count = noteCount();
    // B's client through A's workspace: the client is not in the studio, so it is not found
    await expectCode(await note(USERS.owner, BEA, { body: "cross" }), 404, "not_found");
    // B's workspace: not a member
    await expectCode(await note(USERS.owner, BEA, { body: "cross" }, { studioId: STUDIO_B }), 403, "not_a_member");
    // B's instructor into A
    await expectCode(await note(USERS.instructorB, ANA, { body: "cross" }), 403, "not_a_member");
    await expectCode(await note(USERS.stranger, ANA, { body: "cross" }), 403, "not_a_member");
    expect(noteCount()).toBe(count);
    expect(notesFor(BEA)).toBe("");
  });

  it("a client id that does not exist is the same 404", async () => {
    await expectCode(await note(USERS.frontDesk, randomUUID(), { body: "ghost" }), 404, "not_found");
  });

  it("the database refuses an author-less or cross-studio insert even if the route were bypassed (RLS check)", () => {
    // PostgREST as the front desk user's own JWT, straight into the table with A's user and B's studio: the insert policy requires membership of that studio.
    const result = psql(`begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USERS.frontDesk}","role":"authenticated"}', true);
      do $$ begin
        begin
          insert into public.client_activity_notes (studio_id, client_id, note_type, body) values ('${STUDIO_B}', '${BEA}', 'general', 'direct');
          raise exception 'INSERT_WAS_ALLOWED';
        exception when insufficient_privilege or check_violation then null;
        end;
      end $$;
      rollback;
      select 'ok';`);
    expect(result).toContain("ok");
  });
});
