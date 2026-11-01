import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DbError = { code?: string; message?: string } | null;

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const tableReads: string[] = [];
let rpcImpl: (args: Record<string, unknown>) => { data: unknown; error: DbError } = () => ({ data: [], error: null });
let tables: Record<string, { data: unknown[]; error: DbError }> = {};
let adminThrows = false;

const STUDIO_NY = "d7000000-0000-0000-0000-0000000000a1";
const GRANT_ID = "e7000000-0000-0000-0000-0000000000b2";

function queryBuilder(table: string) {
  tableReads.push(table);
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "lte", "order", "in"]) builder[method] = () => builder;
  builder.range = async () => tables[table] ?? { data: [], error: null };
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(tables[table] ?? { data: [], error: null }).then(resolve, reject);
  // Any mutating call is a test failure.
  for (const method of ["insert", "update", "upsert", "delete"]) builder[method] = () => { throw new Error(`mutation ${method} on ${table}`); };
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminThrows) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return rpcImpl(args);
      },
      from: (table: string) => queryBuilder(table),
    };
  },
}));

import { GET, POST } from "../route";

const SECRET = "d7-test-secret";
const authed = (path = "") => new Request(`https://x.test/api/cron/organizer-suite-entitlement-expiry${path}`, { headers: { authorization: `Bearer ${SECRET}` } });
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const savedEnv = { ...process.env };

function allLogs() {
  return [...errorSpy.mock.calls, ...logSpy.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
}

beforeEach(() => {
  process.env.ORGANIZER_SUITE_EXPIRY_ENABLED = "true";
  process.env.CRON_SECRET = SECRET;
  delete process.env.ORGANIZER_SUITE_EXPIRY_DRY_RUN;
  rpcCalls.length = 0;
  tableReads.length = 0;
  adminThrows = false;
  tables = {};
  // Stateful fake of the RPC: the due grant expires once; later calls find nothing active.
  let active = true;
  rpcImpl = () => {
    if (!active) return { data: [], error: null };
    active = false;
    return { data: [{ id: GRANT_ID, studio_id: STUDIO_NY, notes: "DanceAbel complimentary", status: "expired" }], error: null };
  };
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

describe("Organizer Suite expiry cron: dark by default", () => {
  it.each([undefined, "", "on", "TRUE", "1", "true "])("switch %p -> 404, no auth check, no database call", async (value) => {
    if (value === undefined) delete process.env.ORGANIZER_SUITE_EXPIRY_ENABLED;
    else process.env.ORGANIZER_SUITE_EXPIRY_ENABLED = value;
    const response = await GET(authed());
    expect(response.status).toBe(404);
    expect(rpcCalls).toEqual([]);
    expect(tableReads).toEqual([]);
  });

  it("is NOT registered in vercel.json", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: Array<{ path: string }> };
    expect((vercel.crons ?? []).some((c) => c.path.includes("organizer-suite"))).toBe(false);
  });
});

describe("Organizer Suite expiry cron: secret", () => {
  it("missing secret -> 401, no RPC", async () => {
    const response = await POST(new Request("https://x.test/api/cron/organizer-suite-entitlement-expiry", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(rpcCalls).toEqual([]);
  });
  it("wrong secret -> 401, no RPC", async () => {
    const response = await GET(new Request("https://x.test/a", { headers: { authorization: "Bearer nope" } }));
    expect(response.status).toBe(401);
    expect(rpcCalls).toEqual([]);
  });
  it("CRON_SECRET not configured -> 503, no RPC", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(authed());
    expect(response.status).toBe(503);
    expect(rpcCalls).toEqual([]);
  });
  it("x-cron-secret header is accepted like the precedent", async () => {
    const response = await POST(new Request("https://x.test/a", { method: "POST", headers: { "x-cron-secret": SECRET } }));
    expect(response.status).toBe(200);
  });
});

describe("Organizer Suite expiry cron: run", () => {
  it("success: one RPC call with server now and the organizer_suite key; counts only", async () => {
    const before = Date.now();
    const response = await GET(authed());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["as_of", "dry_run", "expired_count", "ok"]);
    expect(body).toMatchObject({ ok: true, dry_run: false, expired_count: 1 });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("expire_due_usage_addon_entitlements");
    expect(rpcCalls[0].args.p_feature_key).toBe("organizer_suite");
    const asOf = Date.parse(String(rpcCalls[0].args.p_as_of));
    expect(asOf).toBeGreaterThanOrEqual(before);
    expect(asOf).toBeLessThanOrEqual(Date.now());
    expect(body.as_of).toBe(rpcCalls[0].args.p_as_of);
    const text = JSON.stringify(body);
    expect(text).not.toContain(GRANT_ID);
    expect(text).not.toContain(STUDIO_NY);
    expect(text).not.toContain("DanceAbel");
    expect(tableReads).toEqual([]);
  });

  it("caller cannot choose as_of (query parameter ignored)", async () => {
    await GET(authed("?as_of=2099-01-01T00:00:00Z&p_as_of=2099-01-01T00:00:00Z"));
    expect(Date.parse(String(rpcCalls[0].args.p_as_of))).toBeLessThan(Date.parse("2099-01-01T00:00:00Z"));
  });

  it("repeat call expires 0 and still succeeds", async () => {
    expect((await (await GET(authed())).json()).expired_count).toBe(1);
    const second = await GET(authed());
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, expired_count: 0 });
    expect(rpcCalls).toHaveLength(2);
  });

  it("concurrent calls: the total expired is 1, both succeed", async () => {
    const [a, b] = await Promise.all([GET(authed()), POST(new Request("https://x.test/a", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }))]);
    const counts = [(await a.json()).expired_count, (await b.json()).expired_count].sort();
    expect(counts).toEqual([0, 1]);
  });

  it("RPC error -> 500 expiry_failed, no count claimed, no detail leaked", async () => {
    rpcImpl = () => ({ data: null, error: { code: "40001", message: `could not serialize access for ${GRANT_ID}` } });
    const response = await GET(authed());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("expiry_failed");
    expect(body).not.toHaveProperty("expired_count");
    expect(JSON.stringify(body)).not.toContain(GRANT_ID);
    expect(allLogs()).not.toContain(GRANT_ID);
    expect(allLogs()).toContain("organizer_suite_expiry_expiry_failed");
  });

  it.each([
    { code: "PGRST202", message: "Could not find the function public.expire_due_usage_addon_entitlements(p_as_of, p_feature_key) in the schema cache" },
    { code: "42883", message: "function public.expire_due_usage_addon_entitlements(timestamp with time zone, text) does not exist" },
  ])("migration not applied ($code) -> 503 migration_not_applied", async (error) => {
    rpcImpl = () => ({ data: null, error });
    const response = await GET(authed());
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ ok: false, dry_run: false, error: "migration_not_applied" });
    expect(body).not.toHaveProperty("expired_count");
  });

  it("unexpected RPC payload shape is a failure, not a success", async () => {
    rpcImpl = () => ({ data: 3, error: null });
    const response = await GET(authed());
    expect(response.status).toBe(500);
    expect((await response.json()).ok).toBe(false);
  });

  it("admin client construction failure -> generic 500", async () => {
    adminThrows = true;
    const response = await GET(authed());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, dry_run: false, error: "expiry_failed" });
    expect(allLogs()).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});

describe("Organizer Suite expiry cron: dry-run", () => {
  function seedDryRunTables() {
    tables = {
      usage_addon_entitlements: {
        data: [
          { id: GRANT_ID, studio_id: STUDIO_NY, organizer_id: null, period_end: "2000-07-09" },
          { id: "e7000000-0000-0000-0000-0000000000c3", studio_id: STUDIO_NY, organizer_id: null, period_end: "2999-01-01" },
          { id: "e7000000-0000-0000-0000-0000000000d4", studio_id: null, organizer_id: "0a000000-0000-0000-0000-000000000001", period_end: "2000-01-01" },
        ],
        error: null,
      },
      organizers: { data: [{ id: "0a000000-0000-0000-0000-000000000001", studio_id: STUDIO_NY }], error: null },
      studios: { data: [{ id: STUDIO_NY, timezone: "America/New_York" }], error: null },
    };
  }

  it.each(["?dry_run=1", "?dry_run=true"])("%s reports would_expire_count and never calls the mutating RPC", async (query) => {
    seedDryRunTables();
    const response = await GET(authed(query));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["as_of", "dry_run", "ok", "would_expire_count"]);
    expect(body).toMatchObject({ ok: true, dry_run: true, would_expire_count: 2 });
    expect(rpcCalls).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(STUDIO_NY);
    expect(JSON.stringify(body)).not.toContain(GRANT_ID);
  });

  it("env-forced dry-run cannot be switched off by the caller", async () => {
    process.env.ORGANIZER_SUITE_EXPIRY_DRY_RUN = "true";
    seedDryRunTables();
    const body = await (await GET(authed("?dry_run=0"))).json();
    expect(body.dry_run).toBe(true);
    expect(rpcCalls).toEqual([]);
  });

  it("dry-run read error -> 500, no count, no RPC", async () => {
    tables = { usage_addon_entitlements: { data: [], error: { code: "42501", message: "permission denied" } } };
    const response = await GET(authed("?dry_run=1"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, dry_run: true, error: "expiry_failed" });
    expect(body).not.toHaveProperty("would_expire_count");
    expect(rpcCalls).toEqual([]);
  });

  it("dry-run with nothing due -> 0 and no further reads", async () => {
    const body = await (await GET(authed("?dry_run=1"))).json();
    expect(body).toMatchObject({ ok: true, would_expire_count: 0 });
    expect(tableReads).toEqual(["usage_addon_entitlements"]);
  });
});
