/**
 * Minimal in-memory PostgREST-style client for ARIA lifecycle tests (Cleanup PR C). Supports the query-builder
 * subset the ARIA code paths use: select / insert / upsert / update / delete with eq, neq, in, is, not, gt(e), lt(e),
 * order, limit, single, maybeSingle. Embedded relation selects are ignored (rows are returned whole, so tests seed any
 * embedded data directly on the row). Unknown filter methods are accepted and ignored.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export type FakeOperation = {
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  eqs: Array<[string, unknown]>;
  payload?: unknown;
};

function compare(a: unknown, b: unknown) {
  if (a === null || a === undefined) return Number.NaN;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function parseInList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return String(value)
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""));
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  operations: FakeOperation[] = [];
  private nextId = 1;

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((row) => ({ ...row }));
    }
  }

  rows(table: string) {
    return (this.tables[table] ??= []);
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }

  newId(table: string) {
    return `${table}-${this.nextId++}`;
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private filters: Filter[] = [];
  private eqs: Array<[string, unknown]> = [];
  private orderBy: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private payload: unknown = null;
  private upsertConflict: string[] = [];
  private returning = false;
  private singleMode: "one" | "maybe" | null = null;
  private head = false;

  constructor(
    private db: FakeSupabase,
    private table: string,
  ) {}

  select(_columns?: string, options?: { head?: boolean }) {
    if (this.mode !== "select") this.returning = true;
    if (options?.head) this.head = true;
    return this;
  }
  insert(payload: unknown) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  upsert(payload: unknown, options?: { onConflict?: string }) {
    this.mode = "upsert";
    this.payload = payload;
    this.upsertConflict = (options?.onConflict ?? "id").split(",").map((part) => part.trim());
    return this;
  }
  update(payload: unknown) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }

  private add(filter: Filter) {
    this.filters.push(filter);
    return this;
  }
  eq(column: string, value: unknown) {
    this.eqs.push([column, value]);
    if (column.includes(".")) return this;
    return this.add((row) => row[column] === value);
  }
  neq(column: string, value: unknown) {
    return this.add((row) => row[column] !== value);
  }
  in(column: string, values: unknown) {
    const list = parseInList(values);
    return this.add((row) => list.includes(row[column]));
  }
  is(column: string, value: unknown) {
    return this.add((row) => (value === null ? row[column] === null || row[column] === undefined : row[column] === value));
  }
  not(column: string, operator: string, value: unknown) {
    if (operator === "is") return this.add((row) => !(value === null ? row[column] == null : row[column] === value));
    if (operator === "in") {
      const list = parseInList(value);
      return this.add((row) => !list.includes(row[column]));
    }
    if (operator === "eq") return this.add((row) => row[column] !== value);
    return this;
  }
  gt(column: string, value: unknown) {
    return this.add((row) => compare(row[column], value) > 0);
  }
  gte(column: string, value: unknown) {
    return this.add((row) => compare(row[column], value) >= 0);
  }
  lt(column: string, value: unknown) {
    return this.add((row) => compare(row[column], value) < 0);
  }
  lte(column: string, value: unknown) {
    return this.add((row) => compare(row[column], value) <= 0);
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy.push({ column, ascending: options?.ascending !== false });
    return this;
  }
  limit(count: number) {
    this.limitCount = count;
    return this;
  }
  // accepted and ignored
  or() {
    return this;
  }
  ilike() {
    return this;
  }
  contains() {
    return this;
  }
  range() {
    return this;
  }
  maybeSingle() {
    this.singleMode = "maybe";
    return this;
  }
  /** Behaves like maybeSingle (tests never rely on the no-rows error). */
  single() {
    this.singleMode = "one";
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private matching() {
    return this.db.rows(this.table).filter((row) => this.filters.every((filter) => filter(row)));
  }

  private execute(): { data: unknown; error: null; count?: number } {
    this.db.operations.push({ table: this.table, op: this.mode, eqs: this.eqs, payload: this.payload });
    const nowIso = new Date().toISOString();

    if (this.mode === "insert" || this.mode === "upsert") {
      const input = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const written: Row[] = [];
      for (const raw of input) {
        if (this.mode === "upsert") {
          const existing = this.db
            .rows(this.table)
            .find((row) => this.upsertConflict.every((column) => row[column] === raw[column]));
          if (existing) {
            Object.assign(existing, raw);
            written.push(existing);
            continue;
          }
        }
        const row = { id: this.db.newId(this.table), created_at: nowIso, ...raw };
        this.db.rows(this.table).push(row);
        written.push(row);
      }
      return this.finish(written.map((row) => ({ ...row })), this.returning);
    }

    if (this.mode === "update") {
      const updated = this.matching();
      for (const row of updated) Object.assign(row, this.payload as Row);
      return this.finish(updated.map((row) => ({ ...row })), this.returning);
    }

    if (this.mode === "delete") {
      const doomed = new Set(this.matching());
      this.db.tables[this.table] = this.db.rows(this.table).filter((row) => !doomed.has(row));
      return this.finish([...doomed], this.returning);
    }

    let rows = this.matching().map((row) => ({ ...row }));
    for (const { column, ascending } of [...this.orderBy].reverse()) {
      rows = rows.sort((a, b) => {
        const result = compare(a[column], b[column]);
        const safe = Number.isNaN(result) ? 0 : result;
        return ascending ? safe : -safe;
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    if (this.head) return { data: null, error: null, count: rows.length };
    return this.finish(rows, true);
  }

  private finish(rows: Row[], returnRows: boolean) {
    if (this.singleMode) {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: returnRows ? rows : null, error: null };
  }
}
