/**
 * Purpose-built in-memory fake of the Supabase query-builder surface needed
 * by Schedule Stabilization Slice 1's entitlement resolution layer
 * (`src/lib/packages/entitlement.ts`, `src/lib/booking/entitlementResolution.ts`)
 * and its write-path callers. Shared across the Slice 1 test files.
 *
 * The shared `src/lib/payments/__tests__/fakeSupabase.ts` fixture doesn't
 * support `.lte()`/`.lt()`/`.gt()`, which `validateMembershipEntitlement`
 * (reused unmodified from `src/lib/memberships/entitlements.ts`) requires
 * -- so this is a separate, purpose-built fake rather than an extension of
 * that one, following this codebase's existing precedent of hand-rolled
 * per-domain fakes (see `syncPackageUsage.test.ts`, `conflicts.test.ts`)
 * when the shared fixture's surface doesn't cover a needed method.
 *
 * Not a real Supabase emulation: no actual relational joins are performed.
 * Nested "relation" data (e.g. a `client_packages` row's
 * `client_package_items`) is expected to already be embedded directly on
 * the fixture row by the test, since this fake ignores the requested
 * `select()` column list entirely and simply returns matching rows as-is
 * -- exactly like every other fake in this codebase.
 */

export type Row = Record<string, unknown>;
export type FakeError = { message: string; code?: string };

type Filter =
  | { type: "eq" | "neq" | "gte" | "lte" | "lt" | "gt"; col: string; val: unknown }
  | { type: "in"; col: string; vals: unknown[] };

function compare(rowValue: unknown, filter: Filter): boolean {
  if (filter.type === "in") return filter.vals.includes(rowValue);
  if (rowValue === undefined || rowValue === null) return filter.type === "neq";

  switch (filter.type) {
    case "eq":
      return rowValue === filter.val;
    case "neq":
      return rowValue !== filter.val;
    case "gte":
      return String(rowValue) >= String(filter.val);
    case "lte":
      return String(rowValue) <= String(filter.val);
    case "lt":
      return String(rowValue) < String(filter.val);
    case "gt":
      return String(rowValue) > String(filter.val);
  }
}

export class FakeTable {
  rows: Row[] = [];
  /** When set, every query against this table resolves with this error. */
  forceError: FakeError | null = null;
  private seq = 0;

  insert(payload: Row) {
    if (this.forceError) return { data: null, error: this.forceError };
    this.seq += 1;
    const row: Row = { id: `row-${this.seq}`, ...payload };
    this.rows.push(row);
    return { data: [row], error: null };
  }
}

class FakeQuery {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAscending = true;
  private limitN: number | null = null;
  private countMode: "exact" | null = null;

  constructor(
    private table: FakeTable,
    private op: "select" | "insert" | "update",
    private payload?: Row,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.countMode = "exact";
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ type: "eq", col, val });
    return this;
  }

  neq(col: string, val: unknown) {
    this.filters.push({ type: "neq", col, val });
    return this;
  }

  gte(col: string, val: unknown) {
    this.filters.push({ type: "gte", col, val });
    return this;
  }

  lte(col: string, val: unknown) {
    this.filters.push({ type: "lte", col, val });
    return this;
  }

  lt(col: string, val: unknown) {
    this.filters.push({ type: "lt", col, val });
    return this;
  }

  gt(col: string, val: unknown) {
    this.filters.push({ type: "gt", col, val });
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters.push({ type: "in", col, vals });
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

  private matchRows(): Row[] {
    let matched = this.table.rows.filter((row) =>
      this.filters.every((filter) => compare(row[filter.col], filter)),
    );

    if (this.orderCol) {
      const col = this.orderCol;
      matched = [...matched].sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        return this.orderAscending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }

    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    return matched;
  }

  private execute(): { data: Row[] | null; count?: number; error: FakeError | null } {
    if (this.table.forceError) {
      return { data: null, count: 0, error: this.table.forceError };
    }

    if (this.op === "insert") {
      const result = this.table.insert(this.payload ?? {});
      return result as { data: Row[] | null; error: FakeError | null };
    }

    if (this.op === "update") {
      const matched = this.matchRows();
      matched.forEach((row) => Object.assign(row, this.payload));
      return { data: matched, error: null };
    }

    const matched = this.matchRows();
    if (this.countMode === "exact") {
      return { data: null, count: matched.length, error: null };
    }
    return { data: matched, error: null };
  }

  async maybeSingle() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    return { data: (data ?? [])[0] ?? null, error: null };
  }

  async single() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    const rows = data ?? [];
    if (!rows.length) return { data: null, error: { message: "Row not found" } };
    return { data: rows[0], error: null };
  }

  then<T>(
    onFulfilled: (value: { data: Row[] | null; count?: number; error: FakeError | null }) => T,
    onRejected?: (reason: unknown) => T,
  ) {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }
}

/**
 * Returns a plain object matching the subset of `SupabaseClient` these
 * modules actually call. Callers cast it at the call site (`as unknown as
 * SupabaseClient`), matching this codebase's existing fake-client
 * convention (see `src/lib/aria/__tests__/digest-observability.test.ts`).
 */
export function createFakeEntitlementClient(tables: Record<string, FakeTable>) {
  return {
    from(table: string) {
      const t = tables[table];
      if (!t) throw new Error(`Unexpected table in fake db: ${table}`);
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new FakeQuery(t, "select").select(cols, opts),
        insert: (payload: Row) => new FakeQuery(t, "insert", payload),
        update: (payload: Row) => new FakeQuery(t, "update", payload),
      };
    },
  };
}
