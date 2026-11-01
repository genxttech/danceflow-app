/**
 * D4-2 pricing-integrity monitor: shared types and the EVENT CONTRACT with the authorization workstream (D4-1).
 *
 * The monitor is DETECT-AND-ALERT ONLY. It never publishes, repairs, rolls back or overwrites a price. Its database surface is the allow-list below: reads, plus the
 * append-only evidence function. Nothing in this directory may call tw4_price_set / propose / approve / reject or write studio_sms_price_*.
 */

export type Severity = "critical" | "warning" | "info";

export type FindingCode =
  | "unauthorized_price_change" // a published price without a matching approved, applied request by two distinct registered administrators (verifier: price_unattested, several_active_prices)
  | "missing_approval" // a request whose approval record is absent or incoherent (verifier: request_anomaly)
  | "verification_failure" // the verifier failed, returned something unintelligible, was stale or contradicted itself
  | "credential_compromise" // security event: a credential compromise was reported
  | "credential_replaced" // security event: a credential / MFA factor / approver was replaced
  | "approver_registry_changed"
  | "pricing_suspended" // emergency suspension is in force (state, re-alerted on the repeat interval)
  | "pricing_resumed"
  | "unknown_security_event" // an event kind this monitor version does not know (fail closed: alert)
  | "price_changed" // the price-list digest moved since the previous run (info when the verifier is clean: an expected, approved change)
  | "digest_unavailable"
  | "evidence_chain_broken" // the hash chain is broken or has a gap
  | "evidence_unavailable" // evidence could not be read or written
  | "alert_delivery_failed" // an earlier alert could not be delivered (re-sent on every run until delivered)
  | "monitor_stale"; // watchdog: no monitor run recorded within the allowed age

export type Finding = { code: FindingCode; severity: Severity; message: string; refs: string[] };

/** Allow-listed database functions. Anything else is refused by the adapter (and by a unit test that scans this directory). */
export const MONITOR_RPCS = [
  "tw4_price_verify", // D4-1 (20270204090000), service_role, stable
  "tw4_price_monitor_digest", // D4-2 (20270205090000)
  "tw4_price_monitor_events",
  "tw4_price_monitor_evidence_list",
  "tw4_price_monitor_evidence_append",
] as const;
export type MonitorRpc = (typeof MONITOR_RPCS)[number];

export type EvidenceKind = "run" | "delivery" | "watchdog";
export type EvidenceRow = { seq: number; run_id: string; kind: EvidenceKind; recorded_at: string; payload: string; prev_hash: string; entry_hash: string };

export interface PriceMonitorDb {
  verify(since: string | null): Promise<unknown>;
  digest(): Promise<unknown>;
  events(afterSeq: number): Promise<unknown>;
  evidenceList(limit: number, beforeSeq?: number | null): Promise<unknown>;
  evidenceAppend(row: EvidenceRow): Promise<unknown>;
}

/**
 * SECURITY EVENT CONTRACT (table studio_sms_price_security_events, migration 20270205090000). The authorization workstream appends rows from its own SECURITY DEFINER
 * functions (owner-level; no API role can insert). `kind` is snake_case; `detail` is a small JSON object with NO secrets (ids, counts, reasons only).
 * The monitor consumes the feed generically: known kinds map below, unknown kinds alert as `unknown_security_event`.
 */
export const EVENT_KINDS: Record<string, { code: FindingCode; severity: Severity }> = {
  credential_compromise_reported: { code: "credential_compromise", severity: "critical" },
  credential_replaced: { code: "credential_replaced", severity: "warning" },
  mfa_factor_changed: { code: "credential_replaced", severity: "warning" },
  approver_credential_replaced: { code: "credential_replaced", severity: "warning" },
  approver_registry_changed: { code: "approver_registry_changed", severity: "warning" },
  approver_added: { code: "approver_registry_changed", severity: "warning" },
  approver_removed: { code: "approver_registry_changed", severity: "warning" },
  pricing_suspended: { code: "pricing_suspended", severity: "critical" },
  pricing_resumed: { code: "pricing_resumed", severity: "warning" },
};

export type SecurityEvent = { seq: number; kind: string; occurred_at: string; subject_user_id: string | null; detail: Record<string, unknown> };

export type AlertMessage = {
  runId: string;
  severity: Severity;
  subject: string;
  findings: Finding[];
  chainHeadHash: string;
  chainHeadSeq: number;
  chainStatus: "ok" | "broken" | "unavailable";
  /** Set when this is the re-delivery of an alert from an earlier run. */
  redeliveryOfSeq?: number;
  generatedAt: string;
};

export type HeartbeatMessage = { runId: string; chainHeadHash: string; chainHeadSeq: number; generatedAt: string };

/** A destination the app's admins and service_role cannot edit: configured from environment only (see transport.ts). */
export interface AlertTransport {
  readonly name: string;
  /** true when send() really delivers alerts; false for ping-only channels (a no-op send must never count as a delivery). */
  readonly canAlert: boolean;
  /** true when heartbeat() really pings a dead-man channel. */
  readonly canHeartbeat: boolean;
  send(message: AlertMessage): Promise<void>;
  heartbeat(message: HeartbeatMessage): Promise<void>;
}
