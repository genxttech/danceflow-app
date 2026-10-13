/**
 * Marketing M-0: whether marketing sends are frozen (release / rollback transition; set by an operator with
 * marketing_set_send_freeze). Enforcement is in the database (claims, test sends, the dispatcher, client-role recipient
 * access); this read only lets campaign pages explain why nothing can be sent and why pending recipients are hidden.
 * Any error reads as "not known to be paused" -- it never enables anything.
 */
export async function isMarketingSendPaused(client: {
  rpc: (fn: string) => PromiseLike<{ data: unknown; error: unknown }>;
}): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("marketing_send_frozen");
    return !error && data === true;
  } catch {
    return false;
  }
}

export const MARKETING_PAUSED_NOTICE =
  "Marketing sends are paused for maintenance. Nothing can be sent right now and recipients waiting to be sent are hidden until sending resumes; unsubscribes keep working.";
