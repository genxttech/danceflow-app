import { MONITOR_RPCS, type EvidenceRow, type MonitorRpc, type PriceMonitorDb } from "./types";

type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

/**
 * The monitor's whole database surface: five allow-listed RPCs through a service-role client. There is no `.from()` here, no price write, no call to any price
 * mutation function: `rpc()` refuses every name outside MONITOR_RPCS before the request is made. Errors carry the function name only (never a message, row or parameter).
 * Hardening option (docs/twilio/TW-4F_Price_Monitoring_Runbook.md): replace this adapter with a direct Postgres login role that holds EXECUTE on these five functions only.
 */
export function createPriceMonitorDb(client: RpcClient): PriceMonitorDb {
  async function rpc(fn: MonitorRpc, args: Record<string, unknown>): Promise<unknown> {
    if (!(MONITOR_RPCS as readonly string[]).includes(fn)) throw new Error("rpc_not_allowed");
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc_failed:${fn}`);
    return data;
  }
  return {
    verify: (since) => rpc("tw4_price_verify", { p_since: since }),
    digest: () => rpc("tw4_price_monitor_digest", {}),
    events: (afterSeq) => rpc("tw4_price_monitor_events", { p_after_seq: afterSeq }),
    evidenceList: (limit, beforeSeq = null) => rpc("tw4_price_monitor_evidence_list", { p_limit: limit, p_before_seq: beforeSeq }),
    evidenceAppend: (r: EvidenceRow) => rpc("tw4_price_monitor_evidence_append", {
      p_seq: r.seq, p_prev_hash: r.prev_hash, p_entry_hash: r.entry_hash, p_run_id: r.run_id, p_kind: r.kind, p_recorded_at: r.recorded_at, p_payload: r.payload,
    }),
  };
}
