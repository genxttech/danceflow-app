/**
 * Minimal in-memory stand-in for the supabase-js query builder, for CI-B
 * concurrency tests. Each awaited query runs atomically (like one SQL
 * statement) but only after a macrotask, so two flows started together
 * interleave between their queries exactly like two concurrent server
 * actions hitting PostgREST: both reads can land before either write.
 */

export type Row = Record<string, unknown>;

type Filter = (row: Row) => boolean;

type UniqueIndex = {
  table: string;
  columns: string[];
  /** Partial-index predicate; the index applies only to rows where this is true. */
  where?: (row: Row) => boolean;
};

type Op = "select" | "update" | "insert";

let idCounter = 0;

function nextTick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function parseInList(value: string) {
  return value
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .split(",")
    .map((item) => item.trim().replace(/^"|"$/g, ""));
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  uniqueIndexes: UniqueIndex[] = [];
  log: { table: string; op: Op }[] = [];

  constructor(seed: Record<string, Row[]> = {}, uniqueIndexes: UniqueIndex[] = []) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((row) => ({ ...row }));
    }
    this.uniqueIndexes = uniqueIndexes;
  }

  rows(table: string) {
    this.tables[table] ??= [];
    return this.tables[table];
  }

  client(user: { id: string } | null = { id: "user-1" }) {
    return {
      auth: { getUser: async () => ({ data: { user } }) },
      from: (table: string) => new FakeQuery(this, table),
    };
  }

  violatesUnique(table: string, candidate: Row) {
    return this.uniqueIndexes
      .filter((index) => index.table === table)
      .some((index) => {
        if (index.where && !index.where(candidate)) return false;
        return this.rows(table).some(
          (row) =>
            (!index.where || index.where(row)) &&
            index.columns.every((column) => row[column] === candidate[column]),
        );
      });
  }
}

class FakeQuery {
  private op: Op = "select";
  private payload: Row | Row[] | null = null;
  private filters: Filter[] = [];
  private returning = false;
  private mode: "many" | "single" | "maybeSingle" = "many";

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(..._args: unknown[]) {
    void _args;
    if (this.op !== "select") this.returning = true;
    return this;
  }

  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  insert(payload: Row | Row[]) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown) {
    // Postgres: NULL <> x is not true.
    this.filters.push((row) => row[column] !== null && row[column] !== undefined && row[column] !== value);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  is(column: string, value: null) {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }

  not(column: string, operator: string, value: string) {
    if (operator !== "in") throw new Error(`FakeQuery.not: unsupported operator ${operator}`);
    const list = parseInList(value);
    this.filters.push((row) => row[column] !== null && row[column] !== undefined && !list.includes(String(row[column])));
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  single() {
    this.mode = "single";
    return this.execute();
  }

  maybeSingle() {
    this.mode = "maybeSingle";
    return this.execute();
  }

  then<T1, T2>(
    onFulfilled?: (value: { data: unknown; error: { message: string; code?: string } | null }) => T1,
    onRejected?: (reason: unknown) => T2,
  ) {
    return this.execute().then(onFulfilled, onRejected);
  }

  private async execute(): Promise<{ data: unknown; error: { message: string; code?: string } | null }> {
    await nextTick();
    this.db.log.push({ table: this.table, op: this.op });

    const rows = this.db.rows(this.table);
    const matches = () => rows.filter((row) => this.filters.every((filter) => filter(row)));

    let result: Row[] = [];

    if (this.op === "select") {
      result = matches().map((row) => ({ ...row }));
    } else if (this.op === "update") {
      const targets = matches();
      for (const row of targets) Object.assign(row, this.payload);
      result = targets.map((row) => ({ ...row }));
      if (!this.returning) return { data: null, error: null };
    } else {
      const inserts = (Array.isArray(this.payload) ? this.payload : [this.payload ?? {}]).map((row) => ({
        id: `gen-${++idCounter}`,
        ...row,
      }));
      for (const row of inserts) {
        if (this.db.violatesUnique(this.table, row)) {
          return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
        }
      }
      rows.push(...inserts);
      result = inserts.map((row) => ({ ...row }));
      if (!this.returning && this.mode === "many") return { data: null, error: null };
    }

    if (this.mode === "single") {
      return result.length === 1
        ? { data: result[0], error: null }
        : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
    }

    if (this.mode === "maybeSingle") {
      if (result.length > 1) return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
      return { data: result[0] ?? null, error: null };
    }

    return { data: result, error: null };
  }
}
