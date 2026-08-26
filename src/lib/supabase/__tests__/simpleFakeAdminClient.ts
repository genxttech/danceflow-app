/**
 * Public Event Document-Checkpoint Remediation: minimal, purpose-built
 * chainable fake of the subset of the Supabase query-builder surface needed
 * by src/lib/documents/event-signing.ts and
 * src/app/api/events/cart/checkout/route.ts.
 *
 * Unlike src/lib/packages/__tests__/fakeEntitlementSupabase.ts (built for
 * the package-refund domain, single-row inserts only), this fake supports
 * array inserts (document_sign_fields inserts three rows at once) and
 * .delete() (createEnvelopeForPosition's own cleanup on a downstream insert
 * failure). Kept as a separate, smaller fixture rather than extending the
 * shared one, so this remediation doesn't change behavior any other suite
 * already depends on.
 *
 * Not a real Supabase emulation: ignores requested select() column lists
 * and any embedded-relation joins entirely -- nested relation data (e.g. a
 * requirement row's `document_templates`) must already be embedded
 * directly on the fixture row by the test, exactly like every other fake
 * in this codebase.
 */

export type Row = Record<string, unknown>;
export type FakeError = { message: string };

type Filter =
  | { type: "eq"; col: string; val: unknown }
  | { type: "neq"; col: string; val: unknown }
  | { type: "in"; col: string; vals: unknown[] }
  | { type: "not_is"; col: string; val: unknown };

/**
 * Test-only, opt-in error injection for one table. Scoped by `op` so it
 * can target e.g. only `update()` calls on a table without also failing
 * an earlier `select()`/`insert()` against the same table. `matchesPayload`
 * narrows further to a specific write when a table receives more than one
 * distinct `update()` call with different shapes (e.g. a checkpoint's
 * position-advance update vs. its terminal-cleanup update) -- omit it to
 * match every call of that `op` against this table. Throws a real Error
 * (not a `{error}` result) so `await`-ing the chain genuinely rejects,
 * matching a real network/client-level failure rather than an ordinary
 * PostgREST query error surfaced via `.error` -- the distinction that
 * matters here, since production code that never inspects `.error` (e.g.
 * `markCheckpointCancelledAfterCreationFailure`'s `try/catch`) would not
 * observe an injected `{error}` result at all.
 */
export type ForceErrorRule = {
  op: "select" | "insert" | "update" | "delete";
  error: FakeError;
  matchesPayload?: (payload: Row | Row[] | undefined) => boolean;
};

export class FakeTable {
  rows: Row[] = [];
  private seq = 0;
  /** null (default) preserves normal fake behavior exactly -- set only by
   * tests that opt in to simulating a failure on this table. */
  forceErrorRule: ForceErrorRule | null = null;

  insert(payload: Row | Row[]) {
    const payloads = Array.isArray(payload) ? payload : [payload];
    const inserted = payloads.map((entry) => {
      this.seq += 1;
      const row: Row = { id: `row-${this.seq}`, ...entry };
      this.rows.push(row);
      return row;
    });
    return { data: inserted, error: null as FakeError | null };
  }
}

class FakeQuery {
  private filters: Filter[] = [];
  private limitN: number | null = null;

  constructor(
    private table: FakeTable,
    private op: "select" | "insert" | "update" | "delete",
    private payload?: Row | Row[],
  ) {}

  select() {
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

  in(col: string, vals: unknown[]) {
    this.filters.push({ type: "in", col, vals });
    return this;
  }

  not(col: string, _op: "eq" | "is", val: unknown) {
    this.filters.push({ type: "not_is", col, val });
    return this;
  }

  order() {
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private matched(): Row[] {
    let rows = this.table.rows.filter((row) =>
      this.filters.every((f) => {
        if (f.type === "eq") return row[f.col] === f.val;
        if (f.type === "neq") return row[f.col] !== f.val;
        if (f.type === "in") return f.vals.includes(row[f.col]);
        return row[f.col] !== f.val;
      }),
    );
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private execute(): { data: Row[] | null; error: FakeError | null } {
    const rule = this.table.forceErrorRule;
    if (
      rule &&
      rule.op === this.op &&
      (!rule.matchesPayload || rule.matchesPayload(this.payload))
    ) {
      throw new Error(rule.error.message);
    }

    if (this.op === "insert") {
      return this.table.insert(this.payload as Row | Row[]);
    }
    if (this.op === "update") {
      const rows = this.matched();
      rows.forEach((row) => Object.assign(row, this.payload));
      return { data: rows, error: null };
    }
    if (this.op === "delete") {
      const rows = this.matched();
      this.table.rows = this.table.rows.filter((row) => !rows.includes(row));
      return { data: rows, error: null };
    }
    return { data: this.matched(), error: null };
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
    return rows.length
      ? { data: rows[0], error: null }
      : { data: null, error: { message: "Row not found" } };
  }

  then<T>(
    onFulfilled: (value: { data: Row[] | null; error: FakeError | null }) => T,
    onRejected?: (reason: unknown) => T,
  ) {
    try {
      return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
    } catch (err) {
      return Promise.reject(err).then(onFulfilled, onRejected);
    }
  }
}

export function createFakeAdminClient(
  tables: Record<string, FakeTable>,
  storageOpts?: { uploadShouldFail?: () => boolean },
) {
  return {
    from(name: string) {
      const t = tables[name];
      if (!t) throw new Error(`Unexpected table in fake db: ${name}`);
      return {
        select: () => new FakeQuery(t, "select"),
        insert: (payload: Row | Row[]) => new FakeQuery(t, "insert", payload),
        update: (payload: Row) => new FakeQuery(t, "update", payload),
        delete: () => new FakeQuery(t, "delete"),
      };
    },
    storage: {
      from: () => ({
        upload: async () =>
          storageOpts?.uploadShouldFail?.()
            ? { error: { message: "upload failed" } }
            : { error: null },
        remove: async () => ({ error: null }),
      }),
    },
  };
}
