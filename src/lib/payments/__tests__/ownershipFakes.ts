/**
 * PAY-DC-2A test fakes: a minimal in-memory Supabase query builder (with `.is()` and
 * the stripe_account_id immutability trigger emulated) and a Stripe call recorder.
 */

export type Row = Record<string, unknown>;
export type Mutation = {
  table: string;
  op: "insert" | "update";
  values: Row;
  ids: string[];
  client: "user" | "admin";
};

/** Returns an error message to reject a tenant (user-client) row write, else null. */
export type RowGuard = (table: string, before: Row | null, after: Row) => string | null;

export function createOwnershipFakeSupabase(
  seed: Record<string, Row[]> = {},
  options: { rowGuard?: RowGuard } = {},
) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const mutations: Mutation[] = [];
  const fromCalls: string[] = [];

  function makeFrom(clientKind: "user" | "admin") {
    return (table: string) => from(table, clientKind);
  }

  function from(table: string, clientKind: "user" | "admin" = "user") {
    const guard = clientKind === "user" ? options.rowGuard : undefined;
    fromCalls.push(table);
    tables[table] ??= [];
    let op: "select" | "insert" | "update" = "select";
    let values: Row | Row[] | null = null;
    let limitCount: number | null = null;
    const filters: Array<(row: Row) => boolean> = [];

    const exec = (mode: "many" | "single" | "maybeSingle") => {
      const rows = tables[table];

      if (op === "insert") {
        const list = (Array.isArray(values) ? values : [values ?? {}]).map((row, index) => ({
          id: `${table}-new-${rows.length + index + 1}`,
          ...row,
        }));
        for (const row of list) {
          const rejection = guard?.(table, null, row);
          if (rejection) {
            return Promise.resolve({ data: null, error: { message: rejection, code: "42501" } });
          }
        }
        rows.push(...list);
        mutations.push({ table, op, values: { ...list[0] }, ids: list.map((row) => String(row.id)), client: clientKind });
        return result(list, mode);
      }

      const filtered = rows.filter((row) => filters.every((filter) => filter(row)));
      const matched = limitCount == null ? filtered : filtered.slice(0, limitCount);

      if (op === "update") {
        const patch = (values ?? {}) as Row;
        for (const row of matched) {
          const rejection = guard?.(table, row, { ...row, ...patch });
          if (rejection) {
            return Promise.resolve({ data: null, error: { message: rejection, code: "42501" } });
          }
        }
        if ("stripe_account_id" in patch) {
          const blocked = matched.some(
            (row) =>
              row.stripe_account_id != null && row.stripe_account_id !== patch.stripe_account_id,
          );
          if (blocked) {
            return Promise.resolve({
              data: null,
              error: { message: "stripe_account_id is immutable once set", code: "23514" },
            });
          }
        }
        for (const row of matched) Object.assign(row, patch);
        mutations.push({ table, op, values: patch, ids: matched.map((row) => String(row.id)), client: clientKind });
      }

      return result(matched, mode);
    };

    const result = (rows: Row[], mode: "many" | "single" | "maybeSingle") => {
      if (mode === "many") return Promise.resolve({ data: rows.map((row) => ({ ...row })), error: null });
      const first = rows[0] ? { ...rows[0] } : null;
      if (mode === "single" && !first) {
        return Promise.resolve({ data: null, error: { message: "not found", code: "PGRST116" } });
      }
      return Promise.resolve({ data: first, error: null });
    };

    const builder = {
      select: () => builder,
      insert: (value: Row | Row[]) => {
        op = "insert";
        values = value;
        return builder;
      },
      update: (value: Row) => {
        op = "update";
        values = value;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      in: (column: string, list: unknown[]) => {
        filters.push((row) => list.includes(row[column]));
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value);
        return builder;
      },
      lt: (column: string, value: unknown) => {
        filters.push((row) => Number(row[column] ?? 0) < Number(value));
        return builder;
      },
      order: () => builder,
      limit: (count: number) => {
        limitCount = count;
        return builder;
      },
      single: () => exec("single"),
      maybeSingle: () => exec("maybeSingle"),
      then: (
        resolve: (value: { data: unknown; error: { message: string; code?: string } | null }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => exec("many").then(resolve, reject),
    };

    return builder;
  }

  const rpcCalls: Array<{ name: string; params: Row }> = [];
  async function rpc(name: string, params: Row) {
    rpcCalls.push({ name, params });
    return { data: [{ applied: true }], error: null };
  }

  return {
    client: { from: makeFrom("user"), rpc },
    /** Service-role client: bypasses rowGuard (as service_role passes the DB guards). */
    adminClient: { from: makeFrom("admin"), rpc },
    tables,
    mutations,
    rpcCalls,
    fromCalls,
    rows: (table: string) => tables[table] ?? [],
  };
}

export type StripeCall = { method: string; args: unknown[] };

export function stripeError(fields: { code?: string; statusCode?: number; type?: string }) {
  return Object.assign(new Error("stripe error text that must never reach the UI acct_SECRET"), fields);
}

/**
 * Records every Stripe call. Objects are "found" only on the account listed in
 * `objectAccounts` (object id -> owning account); any other account gets a 404.
 */
export function createStripeRecorder(options: {
  objectAccounts?: Record<string, string>;
  refundError?: unknown;
  retrieveError?: unknown;
} = {}) {
  const calls: StripeCall[] = [];
  const objectAccounts = options.objectAccounts ?? {};

  const retrieve = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (options.retrieveError) throw options.retrieveError;
    const id = String(args[0]);
    const account = (args[2] as { stripeAccount?: string } | undefined)?.stripeAccount;
    if (!account || objectAccounts[id] !== account) {
      throw stripeError({ code: "resource_missing", statusCode: 404, type: "StripeInvalidRequestError" });
    }
    return { id };
  };

  const stripe = {
    paymentIntents: { retrieve: retrieve("paymentIntents.retrieve") },
    charges: { retrieve: retrieve("charges.retrieve") },
    refunds: {
      create: async (...args: unknown[]) => {
        calls.push({ method: "refunds.create", args });
        if (options.refundError) throw options.refundError;
        return { id: "re_test_1" };
      },
    },
  };

  return {
    stripe,
    calls,
    accountsUsed: () =>
      calls.map((call) => (call.args[call.args.length - 1] as { stripeAccount?: string } | undefined)?.stripeAccount),
  };
}
