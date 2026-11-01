import { randomUUID } from "node:crypto";
import { alertState, append, deliver, loadChain, parse, type MonitorDeps } from "./monitor";
import type { AlertMessage, Finding } from "./types";

/**
 * Operator tools for undelivered alerts. Both are APPEND-ONLY with respect to evidence: nothing already recorded is altered; a re-delivery adds a new `delivery` row.
 * "Undelivered" = a run/watchdog evidence row that required an alert and has no later delivery row accepted by at least one alert destination.
 */
export type UndeliveredAlert = { seq: number; kind: string; recordedAt: string; codes: string[]; severity: string };

export async function listUndelivered(deps: Pick<MonitorDeps, "db" | "config">): Promise<{ chainOk: boolean; undelivered: UndeliveredAlert[] }> {
  const chain = await loadChain(deps.db, deps.config);
  // alertState caps at the newest five for the automatic path; the full list is derived here
  const okRuns = new Set<number>();
  for (const r of chain.rows) if (r.kind === "delivery") { const p = parse(r.payload); if (p.alert_ok === true && typeof p.run_seq === "number") okRuns.add(p.run_seq); }
  void alertState;
  const undelivered = chain.rows
    .filter((r) => (r.kind === "run" || r.kind === "watchdog") && parse(r.payload).alert_required === true && !okRuns.has(r.seq))
    .map((r) => {
      const f = (Array.isArray(parse(r.payload).findings) ? (parse(r.payload).findings as Finding[]) : []);
      return { seq: r.seq, kind: r.kind, recordedAt: r.recorded_at, codes: [...new Set(f.map((x) => x.code))], severity: f.some((x) => x.severity === "critical") ? "critical" : "warning" };
    });
  return { chainOk: !chain.finding, undelivered };
}

/** Re-sends every undelivered alert (not just the newest five) and records each attempt. Never edits an earlier row. */
export async function redeliverUndelivered(deps: MonitorDeps): Promise<{ attempted: number; delivered: number; failed: number; recorded: boolean }> {
  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const chain = await loadChain(deps.db, deps.config);
  const listed = await listUndelivered(deps);
  let head = chain.head;
  let delivered = 0, failed = 0, recorded = true;
  const runId = (deps.newRunId ?? randomUUID)();
  for (const u of listed.undelivered) {
    const row = chain.rows.find((r) => r.seq === u.seq)!;
    const findings = Array.isArray(parse(row.payload).findings) ? (parse(row.payload).findings as Finding[]) : [];
    const msg: AlertMessage = {
      runId, severity: u.severity === "critical" ? "critical" : "warning", generatedAt: now.toISOString(), findings, chainHeadHash: head?.hash ?? "", chainHeadSeq: head?.seq ?? 0,
      chainStatus: chain.check?.ok ? "ok" : chain.check ? "broken" : "unavailable", redeliveryOfSeq: u.seq, subject: `Re-delivery: ${u.codes.join(", ")}`.slice(0, 180),
    };
    const d = await deliver(deps.config.transports, msg, sleep);
    if (d.ok) delivered += 1; else failed += 1;
    if (head) {
      const a = await append(deps.db, head, { runId, kind: "delivery", now, payload: { v: 1, source: "operator", run_seq: u.seq, alert_ok: d.ok, results: d.results, redelivery: true } }, deps.config);
      head = a.head; if (!a.ok) recorded = false;
    } else recorded = false;
  }
  return { attempted: listed.undelivered.length, delivered, failed, recorded };
}
