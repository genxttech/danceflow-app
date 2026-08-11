/**
 * Minimal in-memory fake of the Supabase query-builder surface used by the
 * terminal payment-creation paths (payments, terminal_payment_sessions,
 * studios, stripe_terminal_readers). Shared across the P0.1 idempotency
 * regression tests so each test file doesn't hand-roll its own chain mock.
 * Not a full Supabase emulation — only the method chains those routes
 * actually call: select/insert/update/delete, eq, order, limit, single,
 * maybeSingle, and direct awaiting (the count-query and bare-update shapes).
 */

export type Row = Record<string, unknown>;

export class FakeTable {
  rows: Row[] = [];
  private seq = 0;
  /** Test hook: lets a test simulate a genuine INSERT-INSERT race by having
   * the *next* insert attempt discover a competing row committed between
   * this call's pre-check SELECT and its own INSERT. */
  raceOnNextInsert: ((payload: Row) => void) | null = null;
  /** Column tuple enforced unique across rows when every column is non-null
   * on the inserted row (mirrors a Postgres partial unique index). */
  uniqueColumns: string[] | null = null;

  insert(payload: Row) {
    if (this.raceOnNextInsert) {
      const hook = this.raceOnNextInsert;
      this.raceOnNextInsert = null;
      hook(payload);
      return this.duplicateError();
    }

    if (this.uniqueColumns && this.uniqueColumns.every((c) => payload[c] != null)) {
      const dup = this.rows.find((r) => this.uniqueColumns!.every((c) => r[c] === payload[c]));
      if (dup) return this.duplicateError();
    }

    this.seq += 1;
    const row: Row = { id: `row-${this.seq}`, status: "pending", created_at: `t${this.seq}`, ...payload };
    this.rows.push(row);
    return { data: [row], error: null };
  }

  private duplicateError() {
    return {
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    };
  }
}

export class FakeQuery {
  private filters: [string, unknown][] = [];
  private opts: { count?: string } | undefined;
  private orderCol: string | null = null;
  private orderAscending = true;
  private limitN: number | null = null;

  constructor(
    private table: FakeTable,
    private op: "select" | "insert" | "update" | "delete",
    private payload?: Row,
  ) {}

  select(_cols: string, opts?: { count?: string }) {
    this.opts = opts;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters.push([col, vals as unknown]);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAscending = opts?.ascending ?? true;
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private matchRows() {
    return this.table.rows.filter((r) =>
      this.filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)),
    );
  }

  private execute(): { data: Row[] | null; count?: number; error: { code?: string; message: string } | null } {
    if (this.op === "insert") {
      const result = this.table.insert(this.payload ?? {});
      return result as { data: Row[] | null; error: { code?: string; message: string } | null };
    }

    if (this.op === "update") {
      const matched = this.matchRows();
      matched.forEach((r) => Object.assign(r, this.payload));
      return { data: matched, error: null };
    }

    if (this.op === "delete") {
      const matched = this.matchRows();
      const matchedIds = new Set(matched);
      this.table.rows = this.table.rows.filter((r) => !matchedIds.has(r));
      return { data: matched, error: null };
    }

    let matched = this.matchRows();
    if (this.orderCol) {
      const col = this.orderCol;
      matched = [...matched].sort((a, b) => {
        const av = String(a[col]);
        const bv = String(b[col]);
        return this.orderAscending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    if (this.opts?.count === "exact") {
      return { data: null, count: matched.length, error: null };
    }
    return { data: matched, error: null };
  }

  async maybeSingle() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    const rows = data ?? [];
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    const rows = data ?? [];
    if (!rows.length) return { data: null, error: { message: "Row not found" } };
    return { data: rows[0], error: null };
  }

  then<T>(onFulfilled: (value: { data: Row[] | null; count?: number; error: unknown }) => T) {
    return Promise.resolve(this.execute()).then(onFulfilled);
  }
}

export function createFakeAdminClient(tables: Record<string, FakeTable>) {
  return {
    from(table: string) {
      const t = tables[table];
      if (!t) throw new Error(`Unexpected table in fake db: ${table}`);
      return {
        select: (cols: string, opts?: { count?: string }) => new FakeQuery(t, "select").select(cols, opts),
        insert: (payload: Row) => new FakeQuery(t, "insert", payload),
        update: (payload: Row) => new FakeQuery(t, "update", payload),
        delete: () => new FakeQuery(t, "delete"),
      };
    },
  };
}
