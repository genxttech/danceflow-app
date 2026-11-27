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

/*
  What an organizer may be told. A redirect carries only the CODE, so no database text, id or date ever reaches a URL or the page, and a crafted link can
  only select one of these sentences.
*/
export const ELIGIBILITY_ERRORS = {
  unavailable: ELIGIBILITY_UNAVAILABLE_MESSAGE,
  permission: "This entry was not found, or you do not have permission to decide its eligibility.",
  adult: "Not saved: every competitor needs a verified date of birth showing 18 or older. This cannot be waived.",
  criteria: "Not saved: confirm every applicable criterion (age division, status, level) before marking this entry eligible.",
  waiver: "Not saved: a waiver is not allowed here. The division has age, status or level requirements, or the event declares a sanction.",
  entry_state: "Not saved: a withdrawn, scratched, disqualified or complete entry cannot be given an eligibility decision.",
  invalid: "Not saved: choose a decision and a reason that go together.",
  failed: "Could not record the eligibility decision. Nothing was changed.",
} as const;
export type EligibilityErrorCode = keyof typeof ELIGIBILITY_ERRORS;

export function isEligibilityErrorCode(value: unknown): value is EligibilityErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ELIGIBILITY_ERRORS, value);
}

/** Classifies a refusal from the database function (or the application's own early validation sentence). */
export function eligibilityErrorCode(error: RpcError): EligibilityErrorCode {
  if (isMissingFunction(error)) return "unavailable";
  const message = String(error.message ?? "");
  if (message.includes("COMP_R15_NOT_FOUND")) return "permission";
  if (/established adult age|18 or older/.test(message)) return "adult";
  if (/requires verification of|every applicable criterion/.test(message)) return "criteria";
  if (/waiver cannot be used/i.test(message)) return "waiver";
  if (message.includes("cannot be given an eligibility decision")) return "entry_state";
  if (message.includes("COMP_R15_DETERMINATION_INVALID")) return "invalid";
  return "failed";
}

export class EligibilityDecisionError extends Error {
  constructor(readonly code: EligibilityErrorCode) {
    super(ELIGIBILITY_ERRORS[code]);
    this.name = "EligibilityDecisionError";
  }
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
  if (error) throw new EligibilityDecisionError(eligibilityErrorCode(error));
}

/** Refusals raised by the executable gates (20270301130000) when a running order, round, floor call or check-in holds an uncleared entry. */
export const NOT_CLEARED_MESSAGE =
  "Some entries are not cleared by the organizer. Record their eligibility on Competition Registrations, or withdraw or scratch them, then try again.";
export function isNotClearedRefusal(message: string): boolean {
  return /COMP_R15_(PROVISIONAL_ASSIGNMENT|ENTRY_NOT_CLEARED)/.test(message);
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
