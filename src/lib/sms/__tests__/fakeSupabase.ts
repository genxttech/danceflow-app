/**
 * A2P-1A test support: a tiny in-memory stand-in for the Supabase query builder,
 * covering only the calls the SMS routes and dispatcher make. Not a test file itself.
 */

export type FakeRow = Record<string, unknown>;

export type FakeMutation = {
  table: string;
  op: "insert" | "update" | "delete";
  values: unknown;
  ids: string[];
};

type Mode = "many" | "single" | "maybe";

export function createFakeSupabase(seed: Record<string, FakeRow[]> = {}) {
  const tables = new Map<string, FakeRow[]>(
    Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
  );
  const mutations: FakeMutation[] = [];
  let idSequence = 0;

  function table(name: string) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function from(name: string) {
    const filters: Array<(row: FakeRow) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let values: unknown = null;
    let returning = false;
    let limitCount: number | null = null;
    let orderSpec: { column: string; ascending: boolean } | null = null;

    async function execute(mode: Mode) {
      const rows = table(name);
      let result: FakeRow[] = [];

      if (op === "insert") {
        const list = (Array.isArray(values) ? values : [values]).map((value) => ({
          id: `${name}-${++idSequence}`,
          ...(value as FakeRow),
        }));
        rows.push(...list);
        mutations.push({ table: name, op, values, ids: list.map((row) => String(row.id)) });
        result = list;

        if (!returning && mode === "many") return { data: null, error: null };
      } else if (op === "update") {
        result = rows.filter((row) => filters.every((filter) => filter(row)));
        result.forEach((row) => Object.assign(row, values as FakeRow));
        mutations.push({ table: name, op, values, ids: result.map((row) => String(row.id)) });
      } else if (op === "delete") {
        result = rows.filter((row) => filters.every((filter) => filter(row)));
        tables.set(name, rows.filter((row) => !result.includes(row)));
        mutations.push({ table: name, op, values: null, ids: result.map((row) => String(row.id)) });
      } else {
        result = rows.filter((row) => filters.every((filter) => filter(row)));

        if (orderSpec) {
          const { column, ascending } = orderSpec;
          result = [...result].sort((a, b) => {
            const left = String(a[column] ?? "");
            const right = String(b[column] ?? "");
            return ascending ? left.localeCompare(right) : right.localeCompare(left);
          });
        }

        if (limitCount !== null) result = result.slice(0, limitCount);
        result = result.map((row) => ({ ...row }));
      }

      if (mode === "single") {
        return result.length > 0
          ? { data: result[0], error: null }
          : { data: null, error: { message: "No rows found" } };
      }

      if (mode === "maybe") return { data: result[0] ?? null, error: null };

      return { data: result, error: null };
    }

    const passthrough = () => builder;

    const builder = {
      select() {
        if (op !== "select") returning = true;
        return builder;
      },
      insert(value: unknown) {
        op = "insert";
        values = value;
        return builder;
      },
      update(value: unknown) {
        op = "update";
        values = value;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return builder;
      },
      neq(column: string, value: unknown) {
        filters.push((row) => row[column] !== value);
        return builder;
      },
      in(column: string, list: unknown[]) {
        filters.push((row) => list.includes(row[column]));
        return builder;
      },
      not: passthrough,
      is: passthrough,
      lt: passthrough,
      lte: passthrough,
      gt: passthrough,
      gte: passthrough,
      order(column: string, options: { ascending?: boolean } = {}) {
        orderSpec = { column, ascending: options.ascending ?? true };
        return builder;
      },
      limit(count: number) {
        limitCount = count;
        return builder;
      },
      single: () => execute("single"),
      maybeSingle: () => execute("maybe"),
      then<T>(
        resolve: (value: Awaited<ReturnType<typeof execute>>) => T,
        reject?: (reason: unknown) => T,
      ) {
        return execute("many").then(resolve, reject);
      },
    };

    return builder;
  }

  return {
    client: { from },
    tables,
    mutations,
    rows(name: string) {
      return table(name);
    },
  };
}
