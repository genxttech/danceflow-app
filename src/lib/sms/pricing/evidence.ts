import { createHash, createHmac, randomUUID } from "node:crypto";
import type { EvidenceKind, EvidenceRow, PriceMonitorDb } from "./types";

/**
 * Append-only, hash-chained monitor evidence.
 *
 *   entry_hash = H(prev_hash | seq | run_id | kind | recorded_at_epoch_ms | payload)       H = SHA-256, or HMAC-SHA-256 when a chain key is configured
 *
 * The database enforces linkage (seq = head + 1, prev_hash = head hash), serialization and immutability. This module recomputes every hash. Every alert carries the head
 * (seq + hash) to a destination the database administrators do not control; comparing the database head with the last alert detects tail truncation, rewritten history
 * and forged appends. The optional chain key (a separate secret in the alert-config scope) additionally stops anyone with only database write access from forging a
 * VALID-looking row.
 */
export const GENESIS_HASH = "0".repeat(64);

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function entryHash(row: Omit<EvidenceRow, "entry_hash">, chainKey?: string | null): string {
  const material = [row.prev_hash, row.seq, row.run_id, row.kind, Date.parse(row.recorded_at), row.payload].join("|");
  return chainKey ? createHmac("sha256", chainKey).update(material).digest("hex") : createHash("sha256").update(material).digest("hex");
}

export type ChainCheck = { ok: boolean; status: "ok" | "broken" | "empty"; headSeq: number; headHash: string; brokenAtSeq: number | null; reason: string | null };

/**
 * Verifies a contiguous window of rows (ascending). `trustedFromSeq`: rows at or before this seq are not judged (a documented, temporary owner acknowledgement after an
 * investigation; the acknowledgement is itself part of every following alert). `expectHead`: the head the previous alert published; the window must contain it.
 */
export function verifyChain(rows: EvidenceRow[], opts: { chainKey?: string | null; trustedFromSeq?: number; expectHead?: { seq: number; hash: string } } = {}): ChainCheck {
  if (rows.length === 0) return { ok: true, status: "empty", headSeq: 0, headHash: GENESIS_HASH, brokenAtSeq: null, reason: null };
  const trusted = opts.trustedFromSeq ?? 0;
  const bad = (seq: number, reason: string): ChainCheck => ({ ok: false, status: "broken", headSeq: rows[rows.length - 1].seq, headHash: rows[rows.length - 1].entry_hash, brokenAtSeq: seq, reason });
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.seq <= trusted) continue;
    if (i > 0) {
      const p = rows[i - 1];
      if (r.seq !== p.seq + 1) return bad(r.seq, "gap");
      if (r.prev_hash !== p.entry_hash) return bad(r.seq, "link");
    } else if (r.seq === 1 && r.prev_hash !== GENESIS_HASH) return bad(r.seq, "genesis");
    const { entry_hash: _unused, inserted_at: _ins, ...rest } = r;
    void _unused; void _ins;
    if (entryHash(rest, opts.chainKey) !== r.entry_hash) return bad(r.seq, "hash");
  }
  const head = rows[rows.length - 1];
  if (opts.expectHead) {
    const hit = rows.find((r) => r.seq === opts.expectHead!.seq);
    // a published head older than the window is simply not checkable here; one inside the window must match; one beyond the current head means rows were removed
    if (hit && hit.entry_hash !== opts.expectHead.hash) return bad(opts.expectHead.seq, "head_mismatch");
    if (!hit && head.seq < opts.expectHead.seq) return bad(opts.expectHead.seq, "truncated");
  }
  return { ok: true, status: "ok", headSeq: head.seq, headHash: head.entry_hash, brokenAtSeq: null, reason: null };
}

export function parseEvidenceList(raw: unknown): { headSeq: number; rows: EvidenceRow[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { head_seq?: unknown; rows?: unknown };
  if (typeof o.head_seq !== "number" || !Array.isArray(o.rows)) return null;
  const rows: EvidenceRow[] = [];
  for (const r of o.rows) {
    const x = r as Partial<EvidenceRow> | null;
    if (!x || typeof x.seq !== "number" || typeof x.run_id !== "string" || typeof x.payload !== "string" || typeof x.prev_hash !== "string" || typeof x.entry_hash !== "string"
      || typeof x.recorded_at !== "string" || (x.kind !== "run" && x.kind !== "delivery" && x.kind !== "watchdog")) return null;
    rows.push({ ...(typeof x.inserted_at === "string" ? { inserted_at: x.inserted_at } : {}), seq: x.seq, run_id: x.run_id, kind: x.kind, recorded_at: x.recorded_at, payload: x.payload, prev_hash: x.prev_hash, entry_hash: x.entry_hash });
  }
  return { headSeq: o.head_seq, rows };
}

export type AppendResult = { appended: true; seq: number; hash: string } | { appended: false; reason: string };

/** Appends one entry to the head the caller read. A mismatch (concurrent run) or any error is returned, never thrown and never ignored by callers. */
export async function appendEvidence(db: PriceMonitorDb, head: { seq: number; hash: string }, entry: { runId?: string; kind: EvidenceKind; payload: unknown; now: Date }, chainKey?: string | null): Promise<AppendResult> {
  const payload = canonicalJson(entry.payload);
  if (payload.length > 30000) return { appended: false, reason: "payload_too_large" };
  const base = { seq: head.seq + 1, run_id: entry.runId ?? randomUUID(), kind: entry.kind, recorded_at: entry.now.toISOString(), payload, prev_hash: head.hash };
  const row: EvidenceRow = { ...base, entry_hash: entryHash(base, chainKey) };
  try {
    const res = (await db.evidenceAppend(row)) as { appended?: unknown; reason?: unknown } | null;
    if (res && res.appended === true) return { appended: true, seq: row.seq, hash: row.entry_hash };
    return { appended: false, reason: typeof res?.reason === "string" ? res.reason : "refused" };
  } catch {
    return { appended: false, reason: "append_failed" };
  }
}
