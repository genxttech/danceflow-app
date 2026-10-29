"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeReturnPath } from "@/lib/competition/ballots/messages";
import { friendlyNoShowError } from "@/lib/competition/noShow";

/* NS1: mark / void a heat no-show from the ballot desk, so the designated chair (who cannot open the manager-only floor console)
   can do it. One database call; the RPC decides who may (manager or chair), the window and idempotency (request id). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function back(returnTo: string, params: Record<string, string>): never {
  redirect(`${returnTo}?${new URLSearchParams(params).toString()}`);
}

export async function deskNoShowAction(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(text(formData, "returnTo"), "/app/judging");
  const heatEntryId = text(formData, "heatEntryId");
  const requestId = text(formData, "requestId");
  const kind = text(formData, "kind");
  const reason = text(formData, "reason");
  if (!UUID.test(heatEntryId) || !UUID.test(requestId) || (kind !== "mark" && kind !== "void")) {
    back(returnTo, { error: "That request was not valid. Refresh and try again." });
  }
  if (reason.length < 1 || reason.length > 500) back(returnTo, { error: "Give a reason (up to 500 characters)." });
  const supabase = await createClient();
  const { error } = await supabase.rpc(kind === "mark" ? "mark_competition_heat_no_show" : "void_competition_heat_no_show", {
    p_heat_entry_id: heatEntryId, p_reason: reason, p_request_id: requestId,
  });
  if (error) back(returnTo, { error: friendlyNoShowError(error) });
  back(returnTo, { saved: kind === "mark" ? "No-show recorded. Judges will rank the remaining entries." : "No-show undone. Judges must correct their ballots." });
}
