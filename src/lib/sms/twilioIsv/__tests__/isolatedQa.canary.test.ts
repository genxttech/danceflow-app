/**
 * Isolated-QA canary. Runs ONLY inside a stack started by scripts/qa/iso-qa.mjs (TW4_ISO_QA=1, loopback). It pins the infrastructure facts the TW-4F
 * local-stack suites rely on, so a stack that cannot be trusted fails here first, loudly, instead of failing 40 application tests mysteriously:
 *
 *  1. KNOWN INFRASTRUCTURE DEFECT. Supabase image 17.6.1.106 (supautils' "hint_roles" feature) segfaults the Postgres backend on ANY "permission denied for
 *     function" error raised for anon / authenticated / service_role (reproduced with a three-line SQL case that involves no application object; see
 *     docs/twilio/TW-4F_Isolated_QA.md). The shared QA stack has it; the isolated stack starts Postgres with `supautils.hint_roles=` so a denied call is an
 *     ordinary error. This test calls a function an API role may not execute, through PostgREST and through SQL, and requires the database to survive.
 *  2. The stack is isolated (its own container, labelled df.isoqa=1) and API roles reach functions only through PostgREST.
 */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const enabled = process.env.TW4_ISO_QA === "1" && Boolean(URL_ && SECRET && PG) && ["127.0.0.1", "localhost"].includes(new URL(URL_ || "http://x").hostname) && PG.startsWith("df-isoqa-");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (payload: Record<string, unknown>) => {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
};
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlStderr = (sql: string) => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const crashes = () => (execFileSync("docker", ["logs", PG], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) + "").match(/terminated by signal/g)?.length ?? 0;
const logsOf = () => {
  try {
    return execFileSync("docker", ["logs", PG], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
  } catch (error) {
    return String((error as { stdout?: string; stderr?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? "");
  }
};
void crashes;

describe.skipIf(!enabled)("isolated QA stack canary", () => {
  const before = () => (logsOf().match(/terminated by signal/g) ?? []).length;
  let start = 0;
  beforeAll(() => {
    start = before();
    psql(`create or replace function public.iso_canary_fn() returns int language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$ begin return 1; end $$;
          revoke all on function public.iso_canary_fn() from public, anon, authenticated, service_role`);
  });
  afterAll(() => {
    if (enabled) psql("drop function if exists public.iso_canary_fn()");
  });

  it("the stack is a disposable one: a df-isoqa container, never the shared QA stack", () => {
    expect(PG.startsWith("df-isoqa-")).toBe(true);
    expect(execFileSync("docker", ["inspect", "--format", '{{ index .Config.Labels "df.isoqa" }}', PG], { encoding: "utf8" }).trim()).toBe("1");
  });

  it("a SQL call to a function the API role may not execute is an ordinary permission error (the unmitigated image segfaults here)", () => {
    for (const role of ["anon", "authenticated"]) {
      const err = psqlStderr(`set role ${role}; select public.iso_canary_fn();`);
      expect(err, role).toMatch(/permission denied for function iso_canary_fn/);
    }
    expect(psql("select 1")).toBe("1");
    expect(before() - start).toBe(0);
  });

  it("the same call through PostgREST with each API role returns 42501 and leaves the database running", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const key = sign({ iss: "supabase-demo", role, exp: Math.floor(Date.now() / 1000) + 3600, ...(role === "authenticated" ? { sub: "00000000-0000-4000-8000-000000000001", aud: "authenticated" } : {}) });
      const client = createClient(URL_, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await client.rpc("iso_canary_fn");
      expect(error?.code, role).toBe("42501");
    }
    expect(psql("select 1")).toBe("1");
    expect(before() - start).toBe(0);
  });

  it("the mitigation is in force (and visible): supautils' hint feature is switched off in this stack", () => {
    expect(psql("show supautils.hint_roles")).toBe("");
  });
});
