/**
 * D7 test helper: an in-memory Supabase-like client for usage_addon_entitlements and studios that
 * also emulates the PostgREST upsert conflict-target check. A target must match a declared unique
 * index (PROD has one on stripe_subscription_item_id, partial WHERE NOT NULL, and none on
 * (studio_id, feature_key)), otherwise the call fails exactly as PostgreSQL does (42P10).
 */

export type Row = Record<string, unknown>;
export type Write = { table: string; op: "insert" | "update" | "upsert"; ids: string[]; values: Row };

type Filter = (row: Row) => boolean;

export function createEntitlementFakeDb(
  seed: Record<string, Row[]> = {},
  options: { uniqueTargets?: string[]; failSelectOn?: string[] } = {},
) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const writes: Write[] = [];
  const reads: string[] = [];
  const uniqueTargets = new Set(options.uniqueTargets ?? ["stripe_subscription_item_id"]);
  let seq = 0;

  function from(table: string) {
    tables[table] ??= [];
    let op: "select" | "update" | "insert" = "select";
    let payload: Row | null = null;
    let limitN: number | null = null;
    const filters: Filter[] = [];

    const run = (mode: "many" | "maybeSingle") => {
      const rows = tables[table];
      if (op === "select") {
        reads.push(table);
        if (options.failSelectOn?.includes(table)) {
          return Promise.resolve({ data: null, error: { message: `select on ${table} failed` } });
        }
      }
      if (op === "insert") {
        seq += 1;
        const row = { id: `${table}-${seq}`, ...(payload ?? {}) };
        rows.push(row);
        writes.push({ table, op: "insert", ids: [String(row.id)], values: { ...(payload ?? {}) } });
        return Promise.resolve({ data: [{ ...row }], error: null });
      }
      let matched = rows.filter((row) => filters.every((filter) => filter(row)));
      if (limitN != null) matched = matched.slice(0, limitN);
      if (op === "update") {
        for (const row of matched) Object.assign(row, payload);
        writes.push({ table, op: "update", ids: matched.map((row) => String(row.id)), values: { ...(payload ?? {}) } });
      }
      const data = matched.map((row) => ({ ...row }));
      if (mode === "maybeSingle") return Promise.resolve({ data: data[0] ?? null, error: null });
      return Promise.resolve({ data, error: null });
    };

    const builder = {
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
      upsert: (value: Row, opts: { onConflict?: string } = {}) => {
        const target = (opts.onConflict ?? "id").replace(/\s+/g, "");
        if (target !== "id" && !uniqueTargets.has(target)) {
          return Promise.resolve({
            data: null,
            error: { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" },
          });
        }
        const columns = target.split(",");
        const rows = tables[table];
        const existing = rows.find((row) => columns.every((column) => value[column] != null && row[column] === value[column]));
        if (existing) {
          Object.assign(existing, value);
          writes.push({ table, op: "upsert", ids: [String(existing.id)], values: { ...value } });
        } else {
          seq += 1;
          const row = { id: `${table}-${seq}`, ...value };
          rows.push(row);
          writes.push({ table, op: "upsert", ids: [String(row.id)], values: { ...value } });
        }
        return Promise.resolve({ data: null, error: null });
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      in: (column: string, list: unknown[]) => {
        filters.push((row) => list.includes(row[column]));
        return builder;
      },
      limit: (count: number) => {
        limitN = count;
        return builder;
      },
      maybeSingle: () => run("maybeSingle"),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => run("many").then(resolve, reject),
    };
    return builder;
  }

  return {
    client: { from } as never,
    tables,
    writes,
    reads,
    rows: (table: string) => tables[table] ?? [],
  };
}
