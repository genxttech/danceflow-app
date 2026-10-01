import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LAUNCH-SEC-1A: the payroll RPCs are SECURITY DEFINER and executable by
 * `authenticated`, so their role guard is the only authorization boundary.
 * current_studio_payroll_role() returns NULL for non-owner/admin callers, and
 * `NULL not in (...)` / `NULL <> x` are NULL in PL/pgSQL -- the raise never
 * fired. These source invariants pin the NULL-safe guards and prevent the
 * unsafe forms from coming back. Runtime behavior is proven against DEV by
 * sql-tests/test_T_launchsec1a_payroll_authorization.sql.
 */

const MIGRATIONS = join(process.cwd(), "src/lib/supabase/migrations");
const FORWARD = "20261004090000_launchsec1a_payroll_authorization_fail_closed.sql";
const ROLLBACK = "rollback/20261004090000_launchsec1a_payroll_authorization_fail_closed_rollback.sql";

const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8").replace(/\r\n/g, "\n");

const OWNER_ADMIN_RPCS: Array<[string, string]> = [
  ["create_payroll_pay_period", "uuid, date, date, date"],
  ["assign_earnings_to_pay_period", "uuid, uuid"],
  ["assign_single_earning_to_pay_period", "uuid, uuid, uuid"],
  ["remove_earning_from_pay_period", "uuid, uuid, uuid"],
  ["create_payroll_batch_from_period", "uuid, uuid, text"],
  ["approve_payroll_batch", "uuid, uuid"],
];
const OWNER_ONLY_RPCS: Array<[string, string]> = [
  ["mark_payroll_batch_paid", "uuid, uuid, text, text"],
  ["void_empty_payroll_pay_period", "uuid, uuid, text"],
];
const ALL_RPCS = [...OWNER_ADMIN_RPCS, ...OWNER_ONLY_RPCS];

function functionBody(sql: string, name: string) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is recreated`).toBeGreaterThanOrEqual(0);
  const bodyStart = sql.indexOf("$function$", start);
  const bodyEnd = sql.indexOf("$function$", bodyStart + 10);
  return sql.slice(start, bodyEnd + 10);
}

describe("LAUNCH-SEC-1A forward migration", () => {
  const sql = read(FORWARD);

  it("recreates exactly the eight payroll RPCs and nothing else", () => {
    const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(ALL_RPCS.map(([name]) => name).sort());
    // Outside the function bodies (and comments) only grants/revokes remain.
    const topLevel = sql
      .replace(/\$function\$[\s\S]*?\$function\$/g, "")
      .replace(/^--.*$/gm, "");
    expect(topLevel).not.toMatch(/\b(alter|drop|create)\s+(table|policy|trigger|index)\b/i);
    expect(topLevel).not.toMatch(/^\s*(insert|update|delete)\b/im);
  });

  it.each(OWNER_ADMIN_RPCS)("%s denies NULL/no-role callers (owner or admin only)", (name) => {
    const body = functionBody(sql, name);
    expect(body).toContain(
      "if coalesce(public.current_studio_payroll_role(p_studio_id), '') not in ('studio_owner','studio_admin') then",
    );
  });

  it("mark_payroll_batch_paid stays owner-only and NULL-safe", () => {
    expect(functionBody(sql, "mark_payroll_batch_paid")).toContain(
      "if public.current_studio_payroll_role(p_studio_id) is distinct from 'studio_owner' then",
    );
  });

  it("void_empty_payroll_pay_period stays owner-only and NULL-safe", () => {
    const body = functionBody(sql, "void_empty_payroll_pay_period");
    expect(body).toContain("v_role:=public.current_studio_payroll_role(p_studio_id);");
    expect(body).toContain("if v_role is distinct from 'studio_owner' then");
  });

  it.each(ALL_RPCS)("%s keeps no NULL-unsafe role comparison", (name) => {
    const body = functionBody(sql, name);
    expect(body).not.toMatch(/if public\.current_studio_payroll_role\([^)]*\)\s*not in/);
    expect(body).not.toMatch(/current_studio_payroll_role\([^)]*\)\s*<>/);
    expect(body).not.toMatch(/v_role\s*<>/);
  });

  it.each(ALL_RPCS)("%s keeps SECURITY DEFINER, search_path=public and its grants", (name, args) => {
    const body = functionBody(sql, name);
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path TO 'public'");
    expect(sql).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
    expect(sql).toContain(`grant execute on function public.${name}(${args}) to authenticated, service_role;`);
  });

  it("changes nothing but the guard relative to the pre-1A rollback bodies", () => {
    const rollback = read(ROLLBACK);
    for (const [name] of ALL_RPCS) {
      const normalize = (body: string) =>
        body
          .replace(
            "if coalesce(public.current_studio_payroll_role(p_studio_id), '') not in ('studio_owner','studio_admin') then",
            "<GUARD>",
          )
          .replace("if public.current_studio_payroll_role(p_studio_id) not in ('studio_owner','studio_admin') then", "<GUARD>")
          .replace("if public.current_studio_payroll_role(p_studio_id) is distinct from 'studio_owner' then", "<GUARD>")
          .replace("if public.current_studio_payroll_role(p_studio_id)<>'studio_owner' then", "<GUARD>")
          .replace("if v_role is distinct from 'studio_owner' then", "<GUARD>")
          .replace("if v_role<>'studio_owner' then", "<GUARD>");
      expect(normalize(functionBody(sql, name))).toBe(normalize(functionBody(rollback, name)));
    }
  });
});
