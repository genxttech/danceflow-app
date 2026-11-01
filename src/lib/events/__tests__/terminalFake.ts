/**
 * D7 test helper: a tiny in-memory Supabase-like client for the Terminal ticket-sale gate tests. Supports the chained
 * shapes those routes use (select/insert/update/delete + eq/in/order/limit + single/maybeSingle + direct await) and an
 * rpc registry. Embedded joins are modelled by storing the joined object on the row (e.g. `events`).
 */

export type Row = Record<string, unknown>;

export function createTerminalFakeDb(seed: Record<string, Row[]>, rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Row }> = [];
  let seq = 0;

  function from(table: string) {
    tables[table] ??= [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row = {};
    let limitN: number | null = null;
    const filters: Array<(row: Row) => boolean> = [];
    let inserted: Row | null = null;

    const matched = () => {
      let rows = tables[table].filter((row) => filters.every((filter) => filter(row)));
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    };

    const execute = () => {
      if (op === "insert") {
        if (!inserted) {
          seq += 1;
          inserted = { id: `${table}-${seq}`, ...payload };
          tables[table].push(inserted);
          inserts.push({ table, values: { ...payload } });
        }
        return [{ ...inserted }];
      }
      const rows = matched();
      if (op === "update") for (const row of rows) Object.assign(row, payload);
      if (op === "delete") tables[table] = tables[table].filter((row) => !rows.includes(row));
      return rows.map((row) => ({ ...row }));
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (value: Row) => {
        op = "insert";
        payload = value;
        return builder;
      },
      update: (value: Row) => {
        op = "update";
        payload = value;
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => row[column] !== value);
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (value === null ? row[column] == null : row[column] === value));
        return builder;
      },
      // Supports the PostgREST forms used by the mark-paid claim: "col.is.null,col.neq.value" (OR of the parts).
      or: (expression: string) => {
        const parts = expression.split(",").map((part) => part.split("."));
        filters.push((row) =>
          parts.some(([column, operator, ...rest]) => {
            const value = rest.join(".");
            if (operator === "is") return value === "null" ? row[column] == null : false;
            if (operator === "neq") return row[column] !== value;
            if (operator === "eq") return row[column] === value;
            throw new Error(`unsupported or() operator ${operator}`);
          }),
        );
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      maybeSingle: async () => ({ data: execute()[0] ?? null, error: null }),
      single: async () => {
        const row = execute()[0];
        return row ? { data: row, error: null } : { data: null, error: { message: "no rows" } };
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: execute(), error: null }).then(resolve, reject),
    };
    return builder;
  }

  return {
    client: {
      from,
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        rpcCalls.push({ name, args });
        const handler = rpcHandlers[name];
        if (!handler) throw new Error(`unexpected rpc ${name}`);
        return { data: handler(args), error: null };
      },
    },
    tables,
    rpcCalls,
    inserts,
  };
}
