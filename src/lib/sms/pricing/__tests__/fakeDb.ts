import { GENESIS_HASH } from "../evidence";
import type { EvidenceRow, PriceMonitorDb } from "../types";

export class FakeDb implements PriceMonitorDb {
  rows: EvidenceRow[] = [];
  verifyResult: unknown = null;
  verifyThrows = false;
  digestValue = "a".repeat(64);
  guards: Record<string, string> = { studio_sms_price_monitor_evidence_immutable: "A" };
  eventRows: unknown[] = [];
  suspension: unknown = null;
  appendFails = false;
  calls: string[] = [];
  constructor(private clock: () => Date) { this.verifyResult = this.clean(); }
  clean() { return { ok: true, anomalies: [], checked_at: this.clock().toISOString() }; }
  anomalies(a: Record<string, unknown>[]) { this.verifyResult = { ok: a.length === 0, anomalies: a, checked_at: this.clock().toISOString() }; }
  async verify(_since?: string | null) { void _since; this.calls.push("verify"); if (this.verifyThrows) throw new Error("boom"); return this.verifyResult; }
  async digest() { this.calls.push("digest"); return { rows: 3, active_rows: 3, digest: this.digestValue, guards: this.guards, guards_bad: Object.entries(this.guards).filter(([, v]) => v !== "A").map(([k]) => k), checked_at: this.clock().toISOString() }; }
  async events(after: number) {
    this.calls.push("events");
    const list = (this.eventRows as { seq: number }[]).filter((e) => e.seq > after);
    return { head_seq: list.length ? list[list.length - 1].seq : after, events: list, last_suspension_event: this.suspension };
  }
  async evidenceList(limit: number, _before?: number | null) { void _before;
    this.calls.push("evidenceList");
    return { head_seq: this.rows.length ? this.rows[this.rows.length - 1].seq : 0, rows: this.rows.slice(-limit) };
  }
  async evidenceAppend(r: EvidenceRow) {
    this.calls.push("evidenceAppend");
    if (this.appendFails) throw new Error("down");
    const head = this.rows[this.rows.length - 1];
    if (r.seq !== (head ? head.seq + 1 : 1) || r.prev_hash !== (head ? head.entry_hash : GENESIS_HASH)) return { appended: false, reason: "chain_mismatch" };
    this.rows.push({ ...r });
    return { appended: true, seq: r.seq, head_hash: r.entry_hash };
  }
}
