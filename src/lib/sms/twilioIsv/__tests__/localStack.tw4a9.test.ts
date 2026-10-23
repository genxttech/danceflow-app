/**
 * TW-4F A9 (20261223090000) against a REAL schema: the shared reconciliation run lease accepts the 'inventory_reconcile' job, one run at a time; tw4_reconcile_run_alive
 * answers only for the live holder of that job; the other jobs are unchanged; privileges; and the rollback round trip (executed in a transaction that is rolled back).
 * LOCAL QA ONLY: a DEDICATED Postgres with 20261205090000 .. 20261223090000 applied:
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4A9_DB=postgres
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.tw4a9.test.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4A9_DB ?? "";
const enabled = Boolean(PG && DB);
const MIG = join(__dirname, "../../../supabase/migrations");

const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", sqlArgs, { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const psqlAsync = (sql: string): Promise<{ out: string; err: string }> =>
  new Promise((resolve) => {
    const child = spawn("docker", sqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => resolve({ out: out.trim(), err: code === 0 ? "" : err || "failed" }));
    child.stdin.end(sql);
  });
const begin = (job: string, runner = "a9:test") => JSON.parse(psql(`select public.tw4_reconcile_run_begin('${job}', '${runner}', 60)::text`)) as { acquired: boolean; run_id?: string; reason?: string };
const alive = (run: string, job: string) => psql(`select public.tw4_reconcile_run_alive('${run}'::uuid, '${job}')::text`);
const finish = (run: string) => psql(`select public.tw4_reconcile_run_finish('${run}'::uuid, 'completed', '{}'::jsonb, null)::text`);
const clear = () => psql(`delete from public.studio_sms_reconcile_runs where runner like 'a9:%';`);

describe.skipIf(!enabled)("TW-4F A9 inventory reconciliation run lease (real schema)", () => {
  beforeAll(() => {
    expect(psql(`select to_regprocedure('public.tw4_reconcile_run_alive(uuid,text)') is not null`)).toBe("t");
    // no other runner of these jobs may be live on a dedicated QA database
    psql(`update public.studio_sms_reconcile_runs set status = 'failed', finished_at = clock_timestamp(), error = 'a9 test reset' where status = 'running';`);
    clear();
  });
  afterAll(() => {
    if (enabled) clear();
  });

  it("accepts the 'inventory_reconcile' job: one live run at a time; a second caller is busy; the holder is alive until it finishes", () => {
    const first = begin("inventory_reconcile");
    expect(first.acquired).toBe(true);
    expect(begin("inventory_reconcile", "a9:other")).toEqual({ acquired: false, reason: "busy" });
    expect(alive(first.run_id!, "inventory_reconcile")).toBe("true");
    expect(alive(first.run_id!, "sender_reverify")).toBe("false");   // a run is alive only for its own job
    expect(JSON.parse(finish(first.run_id!))).toMatchObject({ status: "completed" });
    expect(alive(first.run_id!, "inventory_reconcile")).toBe("false");
    const next = begin("inventory_reconcile");
    expect(next.acquired).toBe(true);
    finish(next.run_id!);
  });

  it("an expired lease is not alive, and the next begin closes it as failed", () => {
    const run = begin("inventory_reconcile");
    psql(`update public.studio_sms_reconcile_runs set lease_expires_at = clock_timestamp() - interval '1 second' where id = '${run.run_id}';`);
    expect(alive(run.run_id!, "inventory_reconcile")).toBe("false");
    const next = begin("inventory_reconcile");
    expect(next.acquired).toBe(true);
    expect(psql(`select status || ':' || error from public.studio_sms_reconcile_runs where id = '${run.run_id}'`)).toBe("failed:lease expired before the run finished");
    finish(next.run_id!);
    expect(alive("00000000-0000-4000-8000-000000000000", "inventory_reconcile")).toBe("false");
  });

  it("the existing jobs are unchanged and independent; an unknown job is still refused", () => {
    const usage = begin("usage_reconcile");
    const inv = begin("inventory_reconcile");
    expect(usage.acquired && inv.acquired).toBe(true);
    finish(usage.run_id!);
    finish(inv.run_id!);
    expect(psqlError(`select public.tw4_reconcile_run_begin('brand_reconcile', 'a9:test', 60);`)).toMatch(/22023/);
    expect(psqlError(`insert into public.studio_sms_reconcile_runs (job, runner, lease_expires_at) values ('nope', 'a9:bad', now());`)).toMatch(/studio_sms_reconcile_runs_job_check/);
  });

  it("privileges: run_alive is service-role only (checked without calling it as an API role)", () => {
    expect(psql(`select has_function_privilege('service_role', 'public.tw4_reconcile_run_alive(uuid,text)', 'execute')`)).toBe("t");
    for (const role of ["anon", "authenticated"]) {
      expect(psql(`select has_function_privilege('${role}', 'public.tw4_reconcile_run_alive(uuid,text)', 'execute')`)).toBe("f");
      expect(psql(`select has_function_privilege('${role}', 'public.tw4_reconcile_run_begin(text,text,integer)', 'execute')`)).toBe("f");
    }
  });

  it("the lease is PER JOB: an inventory run held open never blocks or delays a usage_reconcile run (concurrent sessions)", async () => {
    const holder = psqlAsync(`begin; select public.tw4_reconcile_run_begin('inventory_reconcile', 'a9:holder', 60)::text; select pg_sleep(3); commit;`);
    await new Promise((r) => setTimeout(r, 800));
    const started = Date.now();
    const usage = await psqlAsync(`select public.tw4_reconcile_run_begin('usage_reconcile', 'a9:usage', 60)::text;`);
    const waited = Date.now() - started;
    await holder;
    expect(usage.err).toBe("");
    expect(JSON.parse(usage.out.split("\n").pop() ?? "{}").acquired).toBe(true);
    expect(waited).toBeLessThan(2000);   // the holder still had ~2 s of its transaction left: no wait on it
    psql(`update public.studio_sms_reconcile_runs set status = 'completed', finished_at = clock_timestamp() where runner in ('a9:holder', 'a9:usage') and status = 'running';`);
  });

  it("the job check keeps the live jobs verbatim, in order, and adds inventory_reconcile", () => {
    expect(psql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_reconcile_runs_job_check'`))
      .toBe("CHECK ((job = ANY (ARRAY['usage_reconcile'::text, 'sender_reverify'::text, 'inventory_reconcile'::text])))");
  });

  it("rollback REFUSES while inventory_reconcile runs exist", () => {
    const rb = readFileSync(join(MIG, "rollback/20261223090000_twilio_inventory_reconcile_run_rollback.sql"), "utf8").replace(/^commit;/m, "rollback;");
    expect(psql(`select count(*) > 0 from public.studio_sms_reconcile_runs where job = 'inventory_reconcile'`)).toBe("t");
    expect(psqlError(rb)).toMatch(/55000: inventory-reconcile-run rollback refused/);
    expect(psql(`select to_regprocedure('public.tw4_reconcile_run_alive(uuid,text)') is not null`)).toBe("t");
  });

  it("without inventory runs, rollback restores main's body (fingerprint) and the exact 20261205 check (in a rolled-back transaction)", () => {
    const rb = readFileSync(join(MIG, "rollback/20261223090000_twilio_inventory_reconcile_run_rollback.sql"), "utf8").replace(/^begin;/m, "").replace(/^commit;/m, "");
    const out = psql(`begin;
      delete from public.studio_sms_reconcile_runs where job = 'inventory_reconcile';
      ${rb}
      select left(md5(replace(prosrc, chr(13), '')), 8) from pg_proc where oid = 'public.tw4_reconcile_run_begin(text,text,integer)'::regprocedure;
      select (to_regprocedure('public.tw4_reconcile_run_alive(uuid,text)') is null)::text;
      select pg_get_constraintdef(oid) from pg_constraint where conname = 'studio_sms_reconcile_runs_job_check';
      rollback;`);
    expect(out.split("\n").slice(-3)).toEqual(["447385b7", "true", "CHECK ((job = ANY (ARRAY['usage_reconcile'::text, 'sender_reverify'::text])))"]);
    expect(psql(`select to_regprocedure('public.tw4_reconcile_run_alive(uuid,text)') is not null`)).toBe("t");
  });
});
