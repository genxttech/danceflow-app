/*
  R-15: the application's only way to read and write eligibility clearance.

  Writing: set_competition_entry_eligibility (migration 20270301110000) records who, role, when, outcome, reason, criteria and a server fingerprint, then
  updates the entry. There is deliberately NO direct-table fallback: the write guard (20270301131000) refuses direct writes, and a missing function means
  the decision cannot be recorded, so the save fails.

  Reading: competition_entry_clearance_state is the database's own answer ('cleared' | 'provisional' | 'blocked'). If the function is not there yet the
  answer is 'unavailable', which no gate treats as cleared. Every other error is thrown.
*/

export type ClearanceState = "cleared" | "provisional" | "blocked" | "unavailable";

type RpcError = { code?: string | null; message?: string | null };
export type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError | null }> };

export const ELIGIBILITY_UNAVAILABLE_MESSAGE =
  "Eligibility decisions cannot be recorded yet: the competition database update has not been applied. Nothing was changed.";

/** True when the database does not have the function (not applied yet, or the API schema cache does not know it). */
export function isMissingFunction(error: RpcError | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/** A message safe to show an organizer. Never includes ids, dates of birth or raw database text beyond the function's own refusal sentence. */
export function eligibilityErrorMessage(error: RpcError): string {
  if (isMissingFunction(error)) return ELIGIBILITY_UNAVAILABLE_MESSAGE;
  const message = String(error.message ?? "");
  const refusal = /COMP_R15_DETERMINATION_INVALID:\s*(.+)$/m.exec(message);
  if (refusal) return refusal[1].trim();
  if (message.includes("COMP_R15_NOT_FOUND")) return "This entry was not found, or you do not have permission to decide its eligibility.";
  return "Could not record the eligibility decision. Nothing was changed.";
}

export async function recordEligibilityDecision(
  client: RpcClient,
  input: { entryId: string; outcome: string; reasonCode: string; criteria: readonly string[]; requestId: string },
): Promise<void> {
  const { error } = await client.rpc("set_competition_entry_eligibility", {
    p_entry_id: input.entryId,
    p_outcome: input.outcome,
    p_reason_code: input.reasonCode,
    p_criteria: [...input.criteria],
    p_request_id: input.requestId,
  });
  if (error) throw new Error(eligibilityErrorMessage(error));
}

const BATCH = 20;

export async function loadClearanceStates(client: RpcClient, entryIds: readonly string[]): Promise<Map<string, ClearanceState>> {
  const states = new Map<string, ClearanceState>();
  for (let start = 0; start < entryIds.length; start += BATCH) {
    const batch = entryIds.slice(start, start + BATCH);
    const answers = await Promise.all(batch.map((id) => client.rpc("competition_entry_clearance_state", { p_entry_id: id })));
    answers.forEach(({ data, error }, index) => {
      if (error) {
        if (!isMissingFunction(error)) throw new Error("Could not verify entry eligibility.");
        states.set(batch[index], "unavailable");
        return;
      }
      states.set(batch[index], data === "cleared" || data === "blocked" ? data : data === "provisional" ? "provisional" : "unavailable");
    });
  }
  return states;
}
