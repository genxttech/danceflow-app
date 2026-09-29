import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Row, RowGuard } from "./ownershipFakes";

/**
 * PAY-DC-2D test model of the identity write-lock migration, derived from the
 * migration source itself so tests cannot drift from the SQL:
 *   - guarded tables/columns come from each guard function's INSERT clause;
 *   - tables whose tenant write policies are dropped reject all tenant writes.
 */

export const PAYDC2D_MIGRATION_PATH = join(
  process.cwd(),
  "src",
  "lib",
  "supabase",
  "migrations",
  "20260929090000_paydc2d_payment_identity_write_lock.sql",
);

const GUARD_FUNCTIONS: Record<string, string> = {
  payments: "_guard_payments_stripe_identity",
  event_payments: "_guard_event_payments_stripe_identity",
  event_registrations: "_guard_event_registrations_stripe_identity",
  studios: "_guard_studios_connected_account",
};

export function readPaydc2dMigration() {
  return readFileSync(PAYDC2D_MIGRATION_PATH, "utf8");
}

export function guardFunctionBody(sql: string, functionName: string) {
  const start = sql.indexOf(`create or replace function public.${functionName}()`);
  if (start < 0) throw new Error(`missing guard function ${functionName}`);
  const bodyStart = sql.indexOf("$$", start);
  const bodyEnd = sql.indexOf("$$", bodyStart + 2);
  return sql.slice(bodyStart + 2, bodyEnd);
}

/** table -> columns protected on INSERT (and, per the source guard test, on UPDATE). */
export function protectedColumnsFromMigration(sql = readPaydc2dMigration()) {
  const result: Record<string, string[]> = {};
  for (const [table, fn] of Object.entries(GUARD_FUNCTIONS)) {
    const body = guardFunctionBody(sql, fn);
    const insertClause = body.slice(body.indexOf("if tg_op = 'INSERT'"), body.indexOf("elsif"));
    result[table] = [...insertClause.matchAll(/new\.(\w+) is not null/g)].map((m) => m[1]);
  }
  return result;
}

export const TENANT_WRITE_DENIED_TABLES = ["stripe_subscriptions", "stripe_customers"];

export function paydc2dRowGuard(sql = readPaydc2dMigration()): RowGuard {
  const protectedColumns = protectedColumnsFromMigration(sql);
  return (table: string, before: Row | null, after: Row) => {
    if (TENANT_WRITE_DENIED_TABLES.includes(table)) {
      return `${table} tenant writes are not permitted.`;
    }
    const columns = protectedColumns[table];
    if (!columns) return null;
    const changed = columns.some((column) =>
      before === null
        ? (after[column] ?? null) !== null
        : (after[column] ?? null) !== (before[column] ?? null),
    );
    return changed ? `${table} Stripe identity fields cannot be changed by this role.` : null;
  };
}
