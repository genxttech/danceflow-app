/**
 * ENT-1 test support: a tiny in-memory database that behaves like the pieces the campaign send path touches, including
 * the three reservation functions (same semantics as 20261013090000_ent1_usage_allowance_reservations.sql, which is
 * verified against the real database by the SQL test and the DEV race harness).
 *
 * The reservation functions run synchronously inside one tick, like the real functions run inside one locked transaction,
 * so concurrent callers are serialized. Reads (`from(...)`) yield first, so two concurrent senders can both pass a
 * read-only preflight before either reserves: exactly the check-then-record race the reservation exists to close.
 */

export type Row = Record<string, unknown>;

export type FakeDb = {
  tables: Record<string, Row[]>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Names of rpc functions that should fail (simulating a database error). */
  failRpc: Set<string>;
  now: () => Date;
  from: (table: string) => Builder;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

class Builder implements PromiseLike<{ data: unknown; error: unknown; count?: number | null }> {
  private filters: Array<(row: Row) => boolean> = [];
  private limitN: number | null = null;
  private mode: "select" | "update" = "select";
  private patch: Row = {};
  private head = false;
  private wantCount = false;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode !== "update") this.mode = "select";
    this.wantCount = Boolean(opts?.count);
    this.head = Boolean(opts?.head);
    return this;
  }
  update(patch: Row) {
    this.mode = "update";
    this.patch = patch;
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push((row) => row[col] === value);
    return this;
  }
  gt(col: string, value: unknown) {
    this.filters.push((row) => String(row[col]) > String(value));
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  private run() {
    const rows = (this.db.tables[this.table] ?? []).filter((row) => this.filters.every((f) => f(row)));
    if (this.mode === "update") {
      for (const row of rows) Object.assign(row, this.patch);
      return { data: null, error: null };
    }
    const sliced = this.limitN === null ? rows : rows.slice(0, this.limitN);
    if (this.head) return { data: null, error: null, count: rows.length };
    return { data: sliced.map((r) => ({ ...r })), error: null, count: this.wantCount ? rows.length : null };
  }
  async maybeSingle() {
    await Promise.resolve();
    const result = this.run();
    const data = (result.data as Row[] | null) ?? [];
    return { data: data[0] ?? null, error: null };
  }
  then<T1, T2>(
    onFulfilled?: ((value: { data: unknown; error: unknown; count?: number | null }) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ) {
    return Promise.resolve()
      .then(() => this.run())
      .then(onFulfilled, onRejected);
  }
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const db: FakeDb = {
    tables: { usage_addon_entitlements: [], usage_monthly_summaries: [], usage_reservations: [], usage_events: [], ...seed },
    rpcCalls: [],
    failRpc: new Set(),
    now: () => new Date(),
    from: (table) => new Builder(db, table),
    rpc: async (name, args) => {
      db.rpcCalls.push({ name, args });
      if (db.failRpc.has(name)) return { data: null, error: { message: `${name} failed` } };
      // one tick, no awaits inside: serialized like the advisory lock
      if (name === "reserve_usage_allowance") return { data: reserve(db, args), error: null };
      if (name === "finalize_usage_reservation") return { data: finalize(db, args), error: null };
      if (name === "release_usage_reservation") return { data: release(db, args), error: null };
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
  };
  return db;
}

function wsOf(args: Record<string, unknown>) {
  return args.p_workspace_type === "studio" ? args.p_studio_id : args.p_organizer_id;
}

const sameWorkspace = (row: Row, workspaceType: unknown, id: unknown) =>
  workspaceType === "studio" ? row.studio_id === id : row.organizer_id === id;

function reserve(db: FakeDb, args: Record<string, unknown>) {
  const ws = wsOf(args);
  const quantity = Number(args.p_quantity);
  const allowance = Number(args.p_allowance);
  if (!(quantity > 0) || !(allowance >= 0)) throw new Error("invalid reserve arguments");
  const reservations = db.tables.usage_reservations;
  const now = db.now().getTime();
  for (const r of reservations) {
    if (r.status === "reserved" && new Date(String(r.expires_at)).getTime() <= now && sameWorkspace(r, args.p_workspace_type, ws) && r.feature_key === args.p_feature_key) r.status = "expired";
  }
  const existing = reservations.find(
    (r) => sameWorkspace(r, args.p_workspace_type, ws) && r.feature_key === args.p_feature_key && r.idempotency_key === args.p_idempotency_key && (r.status === "reserved" || r.status === "finalized"),
  );
  if (existing) {
    if (existing.status === "finalized") return { ok: false, reason: "already_finalized", reservation_id: existing.id };
    return { ok: true, idempotent: true, reservation_id: existing.id, quantity: existing.quantity_reserved };
  }
  const used = Number(
    db.tables.usage_monthly_summaries.find((s) => sameWorkspace(s, args.p_workspace_type, ws) && s.feature_key === args.p_feature_key && s.period_start === args.p_period_start)?.quantity_used ?? 0,
  );
  const reserved = reservations
    .filter((r) => r.status === "reserved" && sameWorkspace(r, args.p_workspace_type, ws) && r.feature_key === args.p_feature_key && r.period_start === args.p_period_start)
    .reduce((sum, r) => sum + Number(r.quantity_reserved), 0);
  if (allowance <= 0) return { ok: false, reason: "no_allowance", allowance, used, reserved, remaining: 0 };
  if (used + reserved + quantity > allowance) return { ok: false, reason: "limit_reached", allowance, used, reserved, remaining: Math.max(0, allowance - used - reserved) };
  const row: Row = {
    id: `res-${reservations.length + 1}`,
    workspace_type: args.p_workspace_type,
    studio_id: args.p_studio_id ?? null,
    organizer_id: args.p_organizer_id ?? null,
    feature_key: args.p_feature_key,
    period_start: args.p_period_start,
    period_end: args.p_period_end,
    quantity_reserved: quantity,
    quantity_consumed: 0,
    status: "reserved",
    idempotency_key: args.p_idempotency_key,
    source: args.p_source,
    related_table: args.p_related_table,
    related_id: args.p_related_id,
    created_by: args.p_created_by,
    expires_at: new Date(now + 900_000).toISOString(),
  };
  reservations.push(row);
  return { ok: true, idempotent: false, reservation_id: row.id, quantity, allowance, used, reserved: reserved + quantity, remaining: allowance - used - reserved - quantity };
}

function finalize(db: FakeDb, args: Record<string, unknown>) {
  const r = db.tables.usage_reservations.find((x) => x.id === args.p_reservation_id);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.status === "finalized") return { ok: true, idempotent: true, quantity_consumed: r.quantity_consumed };
  if (r.status === "released") return { ok: false, reason: "released" };
  const consumed = Number(args.p_quantity_consumed);
  if (!(consumed >= 0) || consumed > Number(r.quantity_reserved)) throw new Error("invalid consumed quantity");
  if (consumed > 0) {
    db.tables.usage_events.push({ studio_id: r.studio_id, organizer_id: r.organizer_id, feature_key: r.feature_key, quantity: consumed, source: r.source, related_id: r.related_id, created_by: r.created_by });
    const summary = db.tables.usage_monthly_summaries.find((s) => sameWorkspace(s, r.workspace_type, r.studio_id ?? r.organizer_id) && s.feature_key === r.feature_key && s.period_start === r.period_start);
    if (summary) summary.quantity_used = Number(summary.quantity_used) + consumed;
    else db.tables.usage_monthly_summaries.push({ studio_id: r.studio_id, organizer_id: r.organizer_id, workspace_type: r.workspace_type, feature_key: r.feature_key, period_start: r.period_start, quantity_used: consumed });
  }
  r.status = "finalized";
  r.quantity_consumed = consumed;
  return { ok: true, idempotent: false, quantity_consumed: consumed, quantity_released: Number(r.quantity_reserved) - consumed };
}

function release(db: FakeDb, args: Record<string, unknown>) {
  const r = db.tables.usage_reservations.find((x) => x.id === args.p_reservation_id);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.status === "finalized") return { ok: false, reason: "already_finalized" };
  if (r.status === "reserved") r.status = "released";
  return { ok: true };
}

export function usedThisMonth(db: FakeDb, column: "studio_id" | "organizer_id", id: string) {
  return Number(
    db.tables.usage_monthly_summaries.find((s) => s[column] === id && s.feature_key === "email_campaign_recipient" && s.period_start === monthStart(db.now()))?.quantity_used ?? 0,
  );
}

export { monthStart };
