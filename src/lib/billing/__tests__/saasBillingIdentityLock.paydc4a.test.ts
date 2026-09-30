import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** PAY-DC-4A: SaaS billing identity write-lock migration + rollback (source guards and a SQL-derived model). */

const MIGRATIONS = join(process.cwd(), "src", "lib", "supabase", "migrations");
const forward = readFileSync(
  join(MIGRATIONS, "20261001090000_paydc4a_saas_billing_identity_lock.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
const rollback = readFileSync(
  join(MIGRATIONS, "rollback", "20261001090000_paydc4a_saas_billing_identity_lock_rollback.sql"),
  "utf8",
).replace(/\r\n/g, "\n");

/** SQL without `--` comments, whitespace-collapsed, lowercased. */
function code(sql: string) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const fwd = code(forward);
const rb = code(rollback);

/** Protected columns, derived from the guard's INSERT clause. */
function protectedColumns() {
  const insertClause = fwd.slice(fwd.indexOf("if tg_op = 'insert'"), fwd.indexOf("elsif"));
  return [...insertClause.matchAll(/new\.(\w+) is not null/g)].map((match) => match[1]);
}

type Row = Record<string, string | null>;

/** Behavioural model of the guard, built from the protected columns parsed out of the SQL. */
function guard(role: string, op: "INSERT" | "UPDATE", before: Row | null, after: Row) {
  if (role !== "anon" && role !== "authenticated") return "ok";
  const columns = protectedColumns();
  if (op === "INSERT") {
    return columns.some((column) => after[column] != null) ? "42501" : "ok";
  }
  return columns.some((column) => (before?.[column] ?? null) !== (after[column] ?? null)) ? "42501" : "ok";
}

describe("forward migration", () => {
  it("protects exactly stripe_customer_id and stripe_subscription_id on INSERT and UPDATE", () => {
    expect(protectedColumns().sort()).toEqual(["stripe_customer_id", "stripe_subscription_id"]);
    for (const column of protectedColumns()) {
      expect(fwd).toContain(`new.${column} is distinct from old.${column}`);
    }
  });

  it("is a SECURITY INVOKER current_user deny-list guard with execute revoked", () => {
    expect(fwd).toContain("create or replace function public._guard_studios_saas_billing_identity()");
    expect(fwd).toContain("security invoker");
    expect(fwd).toContain("set search_path = 'public'");
    expect(fwd).toContain("if current_user in ('anon', 'authenticated') then");
    expect(fwd.match(/using errcode = '42501'/g)).toHaveLength(2);
    expect(fwd).toContain(
      "revoke all on function public._guard_studios_saas_billing_identity() from public, anon, authenticated, service_role;",
    );
    expect(fwd).not.toContain("security definer");
  });

  it("fires before insert or update of exactly the two columns on studios", () => {
    expect(fwd).toContain(
      "create trigger guard_studios_saas_billing_identity before insert or update of stripe_customer_id, stripe_subscription_id on public.studios for each row execute function public._guard_studios_saas_billing_identity();",
    );
  });

  it("drops only the two tenant write policies on studio_billing_customers and creates none", () => {
    const dropped = [...fwd.matchAll(/drop policy if exists (\w+) on public\.(\w+)/g)].map(
      (match) => `${match[2]}.${match[1]}`,
    );
    expect(dropped.sort()).toEqual([
      "studio_billing_customers.studio_billing_customers_staff_insert",
      "studio_billing_customers.studio_billing_customers_staff_update",
    ]);
    expect(fwd).not.toContain("create policy");
    expect(fwd).not.toContain("studio_billing_customers_staff_select");
  });

  it("has no DML, grants or changes to other guards", () => {
    expect(fwd).not.toMatch(/\b(insert into|update public\.|delete from|truncate)\b/);
    expect(fwd).not.toMatch(/\bgrant\b/);
    expect(fwd).not.toContain("_guard_studios_entitlement_columns");
    expect(fwd).not.toContain("_guard_studios_connected_account");
    expect(fwd.trim().startsWith("begin;")).toBe(true);
    expect(fwd.trim().endsWith("commit;")).toBe(true);
  });
});

describe("guard model (derived from the SQL)", () => {
  const empty: Row = { stripe_customer_id: null, stripe_subscription_id: null, name: "Harbor" };
  const set: Row = { stripe_customer_id: "cus_A", stripe_subscription_id: "sub_A", name: "Harbor" };

  it.each(["anon", "authenticated"])("rejects %s writes of the SaaS identity", (role) => {
    expect(guard(role, "INSERT", null, { ...empty, stripe_customer_id: "cus_X" })).toBe("42501");
    expect(guard(role, "INSERT", null, { ...empty, stripe_subscription_id: "sub_X" })).toBe("42501");
    expect(guard(role, "UPDATE", empty, { ...empty, stripe_subscription_id: "sub_X" })).toBe("42501");
    expect(guard(role, "UPDATE", set, { ...set, stripe_subscription_id: "sub_B" })).toBe("42501");
    expect(guard(role, "UPDATE", set, { ...set, stripe_customer_id: "cus_B" })).toBe("42501");
    expect(guard(role, "UPDATE", set, { ...set, stripe_customer_id: null })).toBe("42501");
  });

  it("allows tenant inserts without identity and unrelated updates", () => {
    expect(guard("authenticated", "INSERT", null, empty)).toBe("ok");
    expect(guard("authenticated", "UPDATE", set, { ...set, name: "Harbor Dance" })).toBe("ok");
  });

  it.each(["service_role", "postgres"])("allows %s (webhook / billing checkout / SQL)", (role) => {
    expect(guard(role, "INSERT", null, set)).toBe("ok");
    expect(guard(role, "UPDATE", empty, set)).toBe("ok");
    expect(guard(role, "UPDATE", set, { ...set, stripe_subscription_id: "sub_B" })).toBe("ok");
  });
});

describe("rollback", () => {
  it("drops exactly the new trigger and function", () => {
    expect(rb).toContain("drop trigger if exists guard_studios_saas_billing_identity on public.studios;");
    expect(rb).toContain("drop function if exists public._guard_studios_saas_billing_identity();");
    expect(rb.match(/drop trigger/g)).toHaveLength(1);
    expect(rb.match(/drop function/g)).toHaveLength(1);
  });

  it("recreates exactly the two dropped policies as live in DEV", () => {
    const scope =
      "exists ( select 1 from public.user_studio_roles usr where usr.user_id = auth.uid() and usr.studio_id = studio_billing_customers.studio_id and usr.active = true )";
    expect(rb).toContain(
      `create policy studio_billing_customers_staff_insert on public.studio_billing_customers for insert to authenticated with check ( ${scope} );`,
    );
    expect(rb).toContain(
      `create policy studio_billing_customers_staff_update on public.studio_billing_customers for update to authenticated using ( ${scope} ) with check ( ${scope} );`,
    );
    expect(rb.match(/create policy/g)).toHaveLength(2);
  });

  it("has no DML", () => {
    expect(rb).not.toMatch(/\b(insert into|update public\.|delete from|truncate)\b/);
  });
});
