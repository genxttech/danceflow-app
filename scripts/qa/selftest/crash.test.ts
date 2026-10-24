import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// Deliberately kills the backend of an UNMITIGATED stack (ISO_QA_UNMITIGATED=1: image 17.6.1.106 with supautils.hint_roles at its default) and then "passes":
// the harness must still classify the run as an infrastructure failure (exit 3), never as a pass.
it("provokes the known segfault and reports success regardless", () => {
  const container = String(process.env.TW4A_LOCAL_DB_CONTAINER);
  expect(container).toMatch(/^df-isoqa-/);
  const sql = "create or replace function public.iso_selftest_fn() returns int language sql as 'select 1'; revoke all on function public.iso_selftest_fn() from public, anon; set role anon; select public.iso_selftest_fn();";
  try {
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres"], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    /* the connection is lost when the backend dies: expected */
  }
  expect(true).toBe(true);
});
