import { danceflowApiFetch } from "@/lib/danceflowApi";
import { supabase } from "@/lib/supabase";

/*
  LAUNCH-SEC-1C-A: verified-email proof on mobile.

  Proof is recorded only right after the app itself completed an email-link
  verifyOtp. The database decides whether this live session carries a fresh
  validated mailbox authentication; the app passes no user, email or session.
  Session restoration (setSession) and the PKCE code exchange never call this
  (PKCE stays fail-closed until its session evidence is captured).
*/

export type MobileEmailProofResult = "binding_required" | "bound" | "not_recorded";

export async function recordMobileEmailProof(): Promise<MobileEmailProofResult> {
  const { data, error } = await supabase.rpc("record_email_proof_mobile");

  if (error) return "not_recorded";
  return data === "binding_required" || data === "bound" ? data : "not_recorded";
}

export async function bindAccountPassword(password: string) {
  return danceflowApiFetch<{ bound: true }>("/api/student/account/email-binding", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}
