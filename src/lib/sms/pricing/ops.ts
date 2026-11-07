import { randomUUID } from "node:crypto";
import { append, deliver, heldMessages, loadChain, type MonitorDeps } from "./monitor";
import type { AlertMessage } from "./types";

/**
 * Operator tools for undelivered alerts. Both are APPEND-ONLY with respect to evidence: nothing already recorded is altered; a re-delivery adds a new `delivery` row.
 * "Undelivered" = one alert MESSAGE (a distinct security-event identity, or the batch of everything else) of a run/watchdog evidence row that no destination accepted.
 */
export type UndeliveredAlert = { seq: number; msg: number; kind: string; codes: string[]; severity: string };

export async function listUndelivered(deps: Pick<MonitorDeps, "db" | "config">): Promise<{ chainOk: boolean; undelivered: UndeliveredAlert[] }> {
  const chain = await loadChain(deps.db, deps.config);
  const undelivered = heldMessages(chain.rows).map((h) => ({
    seq: h.runSeq, msg: h.msg, kind: h.kind, codes: [...new Set(h.findings.map((x) => x.code))], severity: h.findings.some((x) => x.severity === "critical") ? "critical" : "warning",
  }));
  return { chainOk: !chain.finding, undelivered };
}

/** Re-sends every undelivered message (not just the newest ones) and records each attempt. Never edits an earlier row. Explicit operator action: not capped. */
export async function redeliverUndelivered(deps: MonitorDeps): Promise<{ attempted: number; delivered: number; failed: number; recorded: boolean }> {
  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const chain = await loadChain(deps.db, deps.config);
  const held = heldMessages(chain.rows);
  let head = chain.head;
  let delivered = 0, failed = 0, recorded = true;
  const runId = (deps.newRunId ?? randomUUID)();
  for (const h of held) {
    const msg: AlertMessage = {
      runId, severity: h.findings.some((x) => x.severity === "critical") ? "critical" : "warning", generatedAt: now.toISOString(), findings: h.findings, chainHeadHash: head?.hash ?? "", chainHeadSeq: head?.seq ?? 0,
      chainStatus: chain.check?.ok ? "ok" : chain.check ? "broken" : "unavailable", redeliveryOfSeq: h.runSeq, subject: `Re-delivery: ${[...new Set(h.findings.map((x) => x.code))].join(", ")}`.slice(0, 180),
    };
    const d = await deliver(deps.config.transports, msg, sleep);
    if (d.ok) delivered += 1; else failed += 1;
    if (head) {
      const a = await append(deps.db, head, { runId, kind: "delivery", now, payload: { v: 1, source: "operator", run_seq: h.runSeq, msg: h.msg, alert_ok: d.ok, results: d.results, redelivery: true } }, deps.config);
      head = a.head; if (!a.ok) recorded = false;
    } else recorded = false;
  }
  return { attempted: held.length, delivered, failed, recorded };
}
