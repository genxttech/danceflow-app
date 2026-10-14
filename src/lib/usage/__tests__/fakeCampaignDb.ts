/**
 * ENT-1 test support: a tiny in-memory database that behaves like the pieces the campaign send path touches, including
 * the two reservation functions (same semantics as 20261013090000_ent1_usage_allowance_reservations.sql, which is
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
    this.filters.push((row) => row[col] != null && String(row[col]) > String(value));
    return this;
  }
  lte(col: string, value: unknown) {
    this.filters.push((row) => row[col] != null && String(row[col]) <= String(value));
    return this;
  }
  lt(col: string, value: unknown) {
    this.filters.push((row) => row[col] != null && String(row[col]) < String(value));
    return this;
  }
  in(col: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[col]));
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
      if (name === "settle_usage_reservation") return { data: settle(db, args), error: null };
      if (name === "marketing_claim_campaign_recipient") return { data: claimRecipient(db, args), error: null };
      if (name === "marketing_complete_campaign_recipient") return { data: completeRecipient(db, args), error: null };
      if (name === "marketing_sync_campaign_recipients") return { data: syncRecipients(db, args), error: null };
      if (name === "marketing_authorize_test_send") return { data: { allowed: true }, error: null };
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
  const staleMs = Number(args.p_stale_seconds ?? 900) * 1000;
  const inPeriod = (r: Row) => sameWorkspace(r, args.p_workspace_type, ws) && r.feature_key === args.p_feature_key && r.period_start === args.p_period_start;

  const used = Number(db.tables.usage_monthly_summaries.find((s) => sameWorkspace(s, args.p_workspace_type, ws) && s.feature_key === args.p_feature_key && s.period_start === args.p_period_start)?.quantity_used ?? 0);
  let committed = reservations.filter((r) => r.status === "reserved" && inPeriod(r)).reduce((sum, r) => sum + Number(r.quantity_reserved) - Number(r.quantity_consumed), 0);
  const existing = reservations.find((r) => r.status === "reserved" && inPeriod(r) && r.idempotency_key === args.p_idempotency_key);
  const batchIds = (args.p_batch_recipient_ids as string[] | undefined) ?? [];

  if (allowance <= 0) return { ok: false, reason: "no_allowance", allowance, used, committed, remaining: 0 };

  if (existing) {
    if (existing.batch_started_at) {
      const age = db.now().getTime() - new Date(String(existing.batch_started_at)).getTime();
      return { ok: false, reason: age < staleMs ? "in_progress" : "needs_reconcile", reservation_id: existing.id };
    }
    const remainingCommit = Number(existing.quantity_reserved) - Number(existing.quantity_consumed);
    if (quantity > remainingCommit) {
      const extra = quantity - remainingCommit;
      if (used + committed + extra > allowance) {
        return { ok: false, reason: "limit_reached", allowance, used, committed, remaining: Math.max(0, allowance - used - committed + remainingCommit) };
      }
      existing.quantity_reserved = Number(existing.quantity_reserved) + extra;
      committed += extra;
    }
    existing.batch_started_at = db.now().toISOString();
    existing.batch_recipient_ids = batchIds;
    return { ok: true, continued: true, reservation_id: existing.id, allowance, used, committed, remaining: allowance - used - committed };
  }

  if (used + committed + quantity > allowance) {
    return { ok: false, reason: "limit_reached", allowance, used, committed, remaining: Math.max(0, allowance - used - committed) };
  }
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
    batch_started_at: db.now().toISOString(),
    batch_recipient_ids: batchIds,
  };
  reservations.push(row);
  return { ok: true, continued: false, reservation_id: row.id, allowance, used, committed: committed + quantity, remaining: allowance - used - committed - quantity };
}

function settle(db: FakeDb, args: Record<string, unknown>) {
  const r = db.tables.usage_reservations.find((x) => x.id === args.p_reservation_id);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.status !== "reserved" || !r.batch_started_at) return { ok: true, idempotent: true, status: r.status, quantity_consumed: r.quantity_consumed };
  const sent = Number(args.p_batch_sent);
  const pending = args.p_pending_remaining === null || args.p_pending_remaining === undefined ? null : Number(args.p_pending_remaining);
  const batch = (r.batch_recipient_ids as string[]) ?? [];
  if (!(sent >= 0) || Number(r.quantity_consumed) + sent > Number(r.quantity_reserved)) throw new Error("invalid sent quantity");
  if (batch.length > 0 && sent > batch.length) throw new Error("sent exceeds the open batch");
  if (sent > 0) {
    db.tables.usage_events.push({ studio_id: r.studio_id, organizer_id: r.organizer_id, feature_key: r.feature_key, quantity: sent, source: r.source, related_id: r.related_id, created_by: r.created_by, metadata: args.p_metadata });
    const summary = db.tables.usage_monthly_summaries.find((s) => sameWorkspace(s, r.workspace_type, r.studio_id ?? r.organizer_id) && s.feature_key === r.feature_key && s.period_start === r.period_start);
    if (summary) summary.quantity_used = Number(summary.quantity_used) + sent;
    else db.tables.usage_monthly_summaries.push({ studio_id: r.studio_id, organizer_id: r.organizer_id, workspace_type: r.workspace_type, feature_key: r.feature_key, period_start: r.period_start, quantity_used: sent });
  }
  const consumed = Number(r.quantity_consumed) + sent;
  let status = "reserved";
  let reserved = Number(r.quantity_reserved);
  if (pending !== null) {
    if (pending === 0) status = consumed > 0 ? "finalized" : "released";
    else if (consumed === 0) status = "released";
    else reserved = Math.max(consumed, Math.min(reserved, consumed + pending));
  }
  r.quantity_consumed = consumed;
  r.quantity_reserved = reserved;
  r.status = status;
  r.batch_started_at = null;
  r.batch_recipient_ids = [];
  return { ok: true, idempotent: false, status, quantity_consumed: consumed, quantity_still_committed: status === "reserved" ? reserved - consumed : 0 };
}

export function usedThisMonth(db: FakeDb, column: "studio_id" | "organizer_id", id: string) {
  return Number(
    db.tables.usage_monthly_summaries.find((s) => s[column] === id && s.feature_key === "email_campaign_recipient" && s.period_start === monthStart(db.now()))?.quantity_used ?? 0,
  );
}

export { monthStart };

/* ------------------------------------------------------------------------------------------------------------------
 * Marketing M-0: the send-time claim / completion / generation functions (20261117090000), same semantics as the SQL
 * (which the M-0 SQL suite and concurrency harness verify against a real database). Synchronous, like the locked SQL.
 * ---------------------------------------------------------------------------------------------------------------- */

const RECIPIENTS: Record<string, { table: string; scope: string }> = {
  studio: { table: "marketing_campaign_recipients", scope: "studio_id" },
  organizer: { table: "organizer_marketing_campaign_recipients", scope: "organizer_id" },
};

let claimSeq = 0;

function suppressionStatus(db: FakeDb, kind: string, scopeId: unknown, email: string) {
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return "invalid";
  if ((db.tables.marketing_email_suppressions ?? []).some((r) => String(r.email).toLowerCase() === e && r.active !== false)) return "suppressed";
  if (kind === "studio") {
    if ((db.tables.marketing_unsubscribes ?? []).some((r) => r.studio_id === scopeId && String(r.email).toLowerCase() === e)) return "unsubscribed";
  } else {
    if ((db.tables.organizer_marketing_unsubscribes ?? []).some((r) => r.organizer_id === scopeId && String(r.email).toLowerCase() === e)) return "unsubscribed";
    if ((db.tables.organizer_contacts ?? []).some((r) => r.organizer_id === scopeId && String(r.email).toLowerCase() === e && r.status === "unsubscribed")) return "unsubscribed";
  }
  return "eligible";
}

function claimRecipient(db: FakeDb, args: Record<string, unknown>) {
  const meta = RECIPIENTS[String(args.p_scope_kind)];
  if (!meta) throw new Error("invalid scope");
  const row = (db.tables[meta.table] ?? []).find(
    (r) => r.id === args.p_recipient_id && r.campaign_id === args.p_campaign_id && r[meta.scope] === args.p_scope_id,
  );
  if (!row) return { outcome: "not_found" };
  const now = db.now();
  const wasSending = row.status === "sending";
  if (wasSending) {
    if (new Date(String(row.claim_expires_at)).getTime() > now.getTime()) return { outcome: "in_flight" };
    if (new Date(String(row.first_attempt_at)).getTime() < now.getTime() - 23 * 3600 * 1000) {
      Object.assign(row, { status: "delivery_unknown", claim_id: null, claim_expires_at: null });
      return { outcome: "delivery_unknown" };
    }
  } else if (row.status !== "pending") {
    return { outcome: "not_claimable", status: row.status };
  }
  const st = suppressionStatus(db, String(args.p_scope_kind), args.p_scope_id, String(row.email ?? ""));
  if (st !== "eligible") {
    row.status = wasSending ? "delivery_unknown" : st === "invalid" ? "skipped" : st;
    row.claim_id = null;
    return { outcome: wasSending ? "delivery_unknown" : st };
  }
  claimSeq += 1;
  const claimId = `claim-${claimSeq}`;
  Object.assign(row, {
    status: "sending",
    claim_id: claimId,
    claim_expires_at: new Date(now.getTime() + Number(args.p_lease_seconds ?? 600) * 1000).toISOString(),
    first_attempt_at: row.first_attempt_at ?? now.toISOString(),
    attempt_count: Number(row.attempt_count ?? 0) + 1,
  });
  return {
    outcome: "claimed",
    claim_id: claimId,
    retry: wasSending,
    email: String(row.email).trim().toLowerCase(),
    unsubscribe_token: row.unsubscribe_token,
    idempotency_key: `mkt-${args.p_scope_kind}-${row.id}`,
  };
}

function completeRecipient(db: FakeDb, args: Record<string, unknown>) {
  const meta = RECIPIENTS[String(args.p_scope_kind)];
  const row = (db.tables[meta.table] ?? []).find((r) => r.id === args.p_recipient_id && r[meta.scope] === args.p_scope_id);
  if (!row || row.status !== "sending" || row.claim_id !== args.p_claim_id) return { outcome: "stale", status: row?.status ?? null };
  const outcome = String(args.p_outcome);
  if (outcome === "sent") {
    Object.assign(row, { status: "sent", provider_message_id: args.p_provider_message_id, sent_at: db.now().toISOString(), error_message: null, claim_id: null, claim_expires_at: null });
  } else if (outcome === "failed") {
    Object.assign(row, { status: "failed", error_message: args.p_error ?? "Send failed", claim_id: null, claim_expires_at: null });
  } else if (outcome === "released") {
    const attempts = Number(row.attempt_count ?? 1);
    Object.assign(row, { status: "pending", claim_id: null, claim_expires_at: null, attempt_count: Math.max(0, attempts - 1), first_attempt_at: attempts <= 1 ? null : row.first_attempt_at });
  } else if (outcome === "uncertain") {
    Object.assign(row, { claim_expires_at: db.now().toISOString(), last_attempt_error: args.p_error ?? null });
  } else {
    throw new Error("invalid completion");
  }
  return { outcome };
}

function syncRecipients(db: FakeDb, args: Record<string, unknown>) {
  const kind = String(args.p_scope_kind);
  const meta = RECIPIENTS[kind];
  const campaigns = db.tables[kind === "studio" ? "marketing_campaigns" : "organizer_marketing_campaigns"] ?? [];
  const campaign = campaigns.find((c) => c.id === args.p_campaign_id && c[meta.scope] === args.p_scope_id);
  if (!campaign) return { outcome: "not_found" };
  if (["sending", "sent", "cancelled"].includes(String(campaign.status))) return { outcome: "campaign_locked" };
  const rows = (db.tables[meta.table] ??= []);
  if (rows.some((r) => r.campaign_id === campaign.id && r.status === "sending")) return { outcome: "delivery_in_progress" };
  db.tables[meta.table] = rows.filter((r) => !(r.campaign_id === campaign.id && ["pending", "unsubscribed", "skipped", "suppressed"].includes(String(r.status))));
  const kept = new Set(db.tables[meta.table].filter((r) => r.campaign_id === campaign.id).map((r) => String(r.email).toLowerCase()));
  const seen = new Set<string>();
  for (const input of (args.p_recipients as Array<{ email: string; name?: string | null; ref_id?: string | null }>) ?? []) {
    const email = String(input.email ?? "").trim().toLowerCase();
    if (!email.includes("@") || seen.has(email) || kept.has(email)) continue;
    seen.add(email);
    const st = suppressionStatus(db, kind, args.p_scope_id, email);
    claimSeq += 1;
    db.tables[meta.table].push({
      id: `gen-${claimSeq}`,
      campaign_id: campaign.id,
      [meta.scope]: args.p_scope_id,
      email,
      name: input.name ?? null,
      status: st === "eligible" ? "pending" : st === "invalid" ? "skipped" : st,
      unsubscribe_token: seedToken(100000 + claimSeq),
    });
  }
  const mine = db.tables[meta.table].filter((r) => r.campaign_id === campaign.id);
  return { outcome: "synced", pending: mine.filter((r) => r.status === "pending").length, preserved: kept.size };
}

/** A deterministic, valid unsubscribe token for seeded recipients. */
export function seedToken(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
